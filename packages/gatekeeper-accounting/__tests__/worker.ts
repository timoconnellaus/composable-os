// Test worker: the fake gatekeeper's entrypoints, plus a stand-in for the host's integration host.
//
// `TestHost` is a Durable Object because a gatekeeper facet is reachable only through
// `ctx.facets`. Its queue behaves as the host's own call does (`callAsHost`): an action the
// gatekeeper may approve automatically is applied right after the session call returns, and a
// failure is thrown back with the gatekeeper's message; any other waits for `approve`.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ObservationDescription,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { AccountingSession } from "../src/types.js";

// Named one by one: the pool registers a main module's entrypoints in `ctx.exports` only when they
// are exported by name, not through `export *`.
export {
  default,
  FakeAccountingBooks,
  FakeAccountingGatekeeper,
  FakeBooksAccount,
  FakeBooksControl,
  FakeBooksVerifier,
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
  startSession(queue: RecordingQueue): Promise<AccountingSession & Partial<Disposable>>;
  applyAction(id: number): Promise<void>;
  rejectAction(id: number): Promise<void>;
  revertAction(id: number): Promise<void>;
  getAutoApprovableActions(): Promise<ActionKind[]>;
  getTypeScriptTypes(): Promise<string>;
};

type TestExports = {
  FakeBooksAccount(options: object): {
    getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass }>;
  };
};

export class TestHost extends DurableObject<Cloudflare.Env> {
  #queue = new RecordingQueue();
  #facet: Facet | undefined;
  #session: (AccountingSession & Partial<Disposable>) | undefined;
  readonly #applied: number[] = [];

  async open(books: string): Promise<ResourceDescription> {
    const account = (this.ctx.exports as unknown as TestExports).FakeBooksAccount({});
    const { class: cls } = await account.getGatekeeperClassFor(`accounting-fake://books/${books}`);
    const facet = this.ctx.facets.get(`gatekeeper-${books}`, () => ({
      class: cls,
    })) as unknown as Facet;
    this.#facet = facet;
    this.#session = await facet.startSession(this.#queue);
    return facet.describe();
  }

  /** Calls a session method, then applies what may be applied at once, as the host's call does. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const before = this.#queue.submitted.length;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    const value = await session[method]?.(...args);
    for (const { id, description } of this.#queue.submitted.slice(before)) {
      if (description.autoApprovable !== true) continue;
      await this.#requireFacet().applyAction(id);
      this.#applied.push(id);
    }
    return value;
  }

  async approve(id: number): Promise<void> {
    await this.#requireFacet().applyAction(id);
    this.#applied.push(id);
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
    applied: number[];
  }> {
    return {
      submitted: this.#queue.submitted,
      observations: this.#queue.observations,
      applied: this.#applied,
    };
  }

  #requireFacet(): Facet {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): AccountingSession & Partial<Disposable> {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
