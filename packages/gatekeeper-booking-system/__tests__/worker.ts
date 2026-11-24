// Test worker: the fake gatekeeper's entrypoints, plus a stand-in for the host's integration host.
//
// `TestHost` is a Durable Object because a gatekeeper facet is reachable only through
// `ctx.facets`. Its queue records each observation and each submitted action; the contract
// submits none.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ObservationDescription,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { BookingSystemSession } from "../src/types.js";

// Named one by one: the pool registers a main module's entrypoints in `ctx.exports` only when they
// are exported by name, not through `export *`.
export {
  default,
  FakeBookingSite,
  FakeBookingSystemAccount,
  FakeBookingSystemControl,
  FakeBookingSystemGatekeeper,
  FakeBookingSystemVerifier,
  GatekeeperVendor,
} from "../src/fake-worker.js";

class RecordingQueue extends RpcTarget {
  readonly submitted: { id: number; description: ActionDescription }[] = [];
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ id: action, description });
  }
}

type Facet = {
  describe(): Promise<ResourceDescription>;
  startSession(queue: RecordingQueue): Promise<BookingSystemSession & Partial<Disposable>>;
  applyAction(id: number): Promise<void>;
  rejectAction(id: number): Promise<void>;
  revertAction(id: number): Promise<void>;
  getAutoApprovableActions(): Promise<ActionKind[]>;
  getTypeScriptTypes(): Promise<string>;
};

type TestExports = {
  FakeBookingSystemAccount(options: object): {
    getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass }>;
  };
};

export class TestHost extends DurableObject<Cloudflare.Env> {
  #queue = new RecordingQueue();
  #facet: Facet | undefined;
  #session: (BookingSystemSession & Partial<Disposable>) | undefined;

  async open(site: string): Promise<ResourceDescription> {
    const account = (this.ctx.exports as unknown as TestExports).FakeBookingSystemAccount({});
    const { class: cls } = await account.getGatekeeperClassFor(
      `booking-system-fake://site/${site}`,
    );
    const facet = this.ctx.facets.get(`gatekeeper-${site}`, () => ({
      class: cls,
    })) as unknown as Facet;
    this.#facet = facet;
    this.#session = await facet.startSession(this.#queue);
    return facet.describe();
  }

  /** Calls a session method as the host would. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    return session[method]?.(...args);
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
    submitted: { id: number; description: ActionDescription }[];
    observations: ObservationDescription[];
  }> {
    return { submitted: this.#queue.submitted, observations: this.#queue.observations };
  }

  #requireFacet(): Facet {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): BookingSystemSession & Partial<Disposable> {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
