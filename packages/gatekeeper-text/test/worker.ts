// The test Worker: the real gatekeeper Worker plus a host-like harness standing in for the CRM's
// integration host (the Workshop side).

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ObservationDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { TextEvent, TextSession } from "../src/types";
import type { TextGatekeeper } from "../src/worker";
import { observations, received, submissions } from "./fakes";

// Named one by one: the Workers pool derives ctx.exports from the main module's own export names.
export {
  default,
  FakeTextControl,
  FakeTextLedger,
  GatekeeperVendor,
  TextAccount,
  TextEvents,
  TextGatekeeper,
  TextHookController,
  TextVerifier,
} from "../src/worker";

class RecordingHook extends RpcTarget {
  async receiveEvent(event: TextEvent): Promise<void> {
    received.push(event);
  }
}

type Controller = {
  enable(initiator: unknown, target: unknown): Promise<void>;
  disable(): Promise<void>;
};

/**
 * Stands in for the integration host's approval queue: answers which of the host's purposes
 * opened it (or none, as a caller's), and whether a routine one was decided routine.
 */
class FakeQueue extends RpcTarget {
  readonly controllers: Controller[] = [];
  constructor(
    readonly purpose: string | null,
    readonly routine: { siteOrigin: string | null } | null,
  ) {
    super();
  }
  async hostPurpose(): Promise<string | null> {
    return this.purpose;
  }
  async hostRoutineMail(): Promise<{ siteOrigin: string | null } | null> {
    return this.routine;
  }
  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
  }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    observations.push(description);
  }
  async bindHook(controller: Controller): Promise<void> {
    this.controllers.push(controller);
  }
}

/** The host's side of a hook firing: a fresh queue and the hook. */
export class TestInitiator extends WorkerEntrypoint<Cloudflare.Env> {
  async startHook(): Promise<{ callback: RecordingHook; approvalQueue: FakeQueue }> {
    return { callback: new RecordingHook(), approvalQueue: new FakeQueue("text-events", null) };
  }
}

type SessionMethod = keyof TextSession;

export class TestHost extends DurableObject<Cloudflare.Env> {
  #facet: Fetcher<TextGatekeeper> | undefined;
  #session: TextSession | undefined;
  #queue: FakeQueue | undefined;

  /** Opens a session through a queue the host opened with `purpose` (null: a caller's). */
  async open(
    purpose: string | null,
    routine: { siteOrigin: string | null } | null = null,
  ): Promise<void> {
    const account = this.ctx.exports.TextAccount({});
    const { class: cls } = await account.getGatekeeperClassFor("text://sender");
    const facet = this.ctx.facets.get<TextGatekeeper>("gatekeeper", () => ({
      class: cls as unknown as DurableObjectClass<TextGatekeeper>,
    }));
    this.#facet = facet;
    this.#queue = new FakeQueue(purpose, routine);
    this.#session = (await facet.startSession(this.#queue as never)) as unknown as TextSession;
  }

  async call(method: SessionMethod, args: unknown[]): Promise<unknown> {
    const session = this.#session as unknown as Record<
      SessionMethod,
      (...args: unknown[]) => Promise<unknown>
    >;
    if (!session) throw new Error("open() first");
    return session[method](...args);
  }

  /** The host binding its hook: subscribe, then enable as a system hook is. */
  async bindAndEnable(): Promise<void> {
    await this.call("subscribe", [new RecordingHook()]);
    const controller = this.#queue?.controllers.at(-1);
    if (!controller) throw new Error("subscribe() did not bind a hook");
    const exports = this.ctx.exports as unknown as { TestInitiator(o: object): Fetcher };
    await controller.enable(exports.TestInitiator({}), { workspaceId: "w-1" });
  }

  async apply(id: number): Promise<void> {
    if (!this.#facet) throw new Error("open() first");
    await this.#facet.applyAction(id);
  }

  async reject(id: number): Promise<void> {
    if (!this.#facet) throw new Error("open() first");
    await this.#facet.rejectAction(id);
  }
}
