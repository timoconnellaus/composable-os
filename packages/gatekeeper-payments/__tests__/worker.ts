// Test worker: the production entrypoints, plus a stand-in for the CRM's integration host.
//
// `TestHost` has to be a Durable Object: a `DurableObjectClass` is only reachable through
// `ctx.facets`, which is how the host instantiates a gatekeeper, and a stub to a facet or to a
// session it mints cannot be handed to the test. So TestHost runs each step itself and returns
// plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ObservationDescription,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { PaymentsEvent, PaymentsProviderName, PaymentsSession } from "../src/types.js";

// Named one by one: the pool registers a main module's entrypoints in `ctx.exports` only when they
// are exported by name, not through `export *`.
export {
  default,
  FakePaymentsLedger,
  GatekeeperVendor,
  PaymentsAccount,
  PaymentsEvents,
  PaymentsGatekeeper,
  PaymentsHookController,
  PaymentsVerifier,
} from "../src/worker.js";

/** Every event a test hook received, in order, whatever key it was bound under. */
const received: PaymentsEvent[] = [];
/** Observations each hook firing's approval queue recorded. */
const firingObservations: ObservationDescription[] = [];
/** Actions the session queues submitted, as `[id, description]`. */
const submissions: [number, ActionDescription][] = [];
/** Observations the session queues recorded. */
const observations: ObservationDescription[] = [];

/** The callback a hook firing reaches: records each event. */
class RecordingHook extends RpcTarget {
  async receiveEvent(event: PaymentsEvent): Promise<void> {
    received.push(event);
  }
}

type Controller = {
  enable(initiator: unknown, target: unknown): Promise<void>;
  disable(): Promise<void>;
};

/** A fake ApprovalQueue: records observations, actions and the hooks bound through it. */
class RecordingQueue extends RpcTarget {
  readonly controllers: Controller[] = [];
  readonly hooks: { title: string; description: string }[] = [];
  readonly #firing: boolean;

  constructor(firing = false) {
    super();
    this.#firing = firing;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    (this.#firing ? firingObservations : observations).push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
  }

  async bindHook(
    controller: Controller,
    _callback: unknown,
    description: { title: string; description: string },
  ): Promise<void> {
    this.controllers.push(controller);
    this.hooks.push(description);
  }
}

/** The host's side of a hook firing: a fresh queue and the hook the agent bound. */
export class TestInitiator extends WorkerEntrypoint<Cloudflare.Env> {
  async startHook(): Promise<{ callback: RecordingHook; approvalQueue: RecordingQueue }> {
    return { callback: new RecordingHook(), approvalQueue: new RecordingQueue(true) };
  }
}

type Facet = {
  describe(): Promise<ResourceDescription>;
  startSession(queue: RecordingQueue): Promise<PaymentsSession & Partial<Disposable>>;
  applyAction(id: number): Promise<void>;
  rejectAction(id: number): Promise<void>;
  revertAction(id: number): Promise<void>;
  getAutoApprovableActions(): Promise<ActionKind[]>;
  getTypeScriptTypes(): Promise<string>;
};

type TestExports = {
  PaymentsAccount(options: object): {
    getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass }>;
  };
  TestInitiator(options: object): Fetcher;
};

export type SessionMethod =
  | "provider"
  | "createCheckout"
  | "getPayment"
  | "refund"
  | "createSubscriptionCheckout"
  | "getSubscription"
  | "cancelSubscription"
  | "resumeSubscription"
  | "openPortal";

export class TestHost extends DurableObject<Cloudflare.Env> {
  readonly #queue = new RecordingQueue();
  #facet: Facet | undefined;
  #session: (PaymentsSession & Partial<Disposable>) | undefined;

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /** Resolves the provider's URL through a fresh account, creates the facet and opens a session. */
  async open(provider: PaymentsProviderName): Promise<ResourceDescription> {
    const account = this.#exports.PaymentsAccount({});
    const { class: cls } = await account.getGatekeeperClassFor(`payments://merchant/${provider}`);
    const facet = this.ctx.facets.get(`gatekeeper-${provider}`, () => ({
      class: cls,
    })) as unknown as Facet;
    this.#facet = facet;
    this.#session = await facet.startSession(this.#queue);
    return facet.describe();
  }

  /** Calls a session method with arguments that may be anything, as extension code can. */
  async call(method: SessionMethod, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Record<
      SessionMethod,
      (...args: unknown[]) => Promise<unknown>
    >;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    return session[method](...args);
  }

  /**
   * The host's half of binding a hook: the session subscribes (bindHook records the controller),
   * then, as if a human approved, the host enables the controller with its own initiator.
   */
  async bindAndEnable(): Promise<{ title: string; description: string }> {
    await this.#requireSession().subscribe(new RecordingHook());
    const controller = this.#queue.controllers.at(-1);
    const hook = this.#queue.hooks.at(-1);
    if (!controller || !hook) throw new Error("subscribe() did not bind a hook");
    await controller.enable(this.#exports.TestInitiator({}), { workspaceId: "workspace-1" });
    return hook;
  }

  async disable(): Promise<void> {
    const controller = this.#queue.controllers.at(-1);
    if (!controller) throw new Error("no hook bound");
    await controller.disable();
  }

  async apply(id: number): Promise<void> {
    await this.#requireFacet().applyAction(id);
  }

  async reject(id: number): Promise<void> {
    await this.#requireFacet().rejectAction(id);
  }

  async revert(id: number): Promise<void> {
    await this.#requireFacet().revertAction(id);
  }

  async autoApprovable(): Promise<ActionKind[]> {
    return this.#requireFacet().getAutoApprovableActions();
  }

  async types(): Promise<string> {
    return this.#requireFacet().getTypeScriptTypes();
  }

  async recorded(): Promise<{
    received: PaymentsEvent[];
    firingObservations: ObservationDescription[];
    submissions: [number, ActionDescription][];
    observations: ObservationDescription[];
  }> {
    return { received, firingObservations, submissions, observations };
  }

  #requireFacet(): Facet {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): PaymentsSession & Partial<Disposable> {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
