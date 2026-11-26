// Durable Objects on a host that may serve many clients (stage 66 step 4, ADR 0615; hardening,
// #515, S2): the client an object is for, decided from its own name; the base class every object
// class of the app and the runner extends, which holds only the client's environment; and the
// check of the client's admission before each call. Apart from client-entries.ts because it holds
// an AsyncLocalStorage (`refreshOnEachCall`): only the Workers' object classes import it.
//
// Exported as `@composable-os/db/client-objects`.
import { AsyncLocalStorage } from "node:async_hooks";
import { isObjectName, OBJECT_NAME_SEPARATOR, objectNameParts } from "./client-bindings.ts";
import { admissionOf, NoClientError, servesManyClients, waitsForClient } from "./client-entries.ts";
import { type HostBindings, REGISTRY_REFRESH_MS } from "./client-environment.ts";
import {
  generationPart,
  hostBindingKey,
  hostPropsKey,
  PROOF,
  PROPS_KEY,
  propsProof,
} from "./client-proofs.ts";
import type { ClientId } from "./registry.ts";

// --- Durable Objects -------------------------------------------------------------------------

/**
 * A Durable Object on a host that may serve many clients: which client it is for (its name, as a
 * namespace wrapper gave it: `<client>:<proof>:<name>`), the caller's name without the client, and
 * that client's environment. Made before the object's base class is (`ClientDurableObject`); on a
 * many-client host it holds every event (`blockConcurrencyWhile`) until the client is read from
 * the registry and the name's proof checked against the client's generation, and an object whose
 * name carries no proof of a client the registry serves refuses every event. Single-client: the
 * real `env` and the object's own name, nothing read.
 *
 * The real `env` is a `#private` field here and nothing hands it out: what the object's code
 * reads is the client's environment (`env`) and a proof bound to its own client (`proof`).
 */
export class ClientObject<E extends HostBindings> {
  #env: E | null = null;
  readonly #host: E;
  readonly #parts: { client: ClientId; proof: string; name: string } | null;
  #generation: string | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly client: ClientId | null;
  /** The object's name as its caller gave it (without the client), or undefined. */
  readonly name: string | undefined;

  constructor(ctx: DurableObjectState, env: E) {
    this.#host = env;
    const stored = ctx.id.name;
    if (!servesManyClients(env)) {
      this.client = null;
      this.name = stored;
      this.#parts = null;
      this.#env = env;
      return;
    }
    const parts = objectNameParts(stored);
    this.#parts = parts;
    this.client = parts?.client ?? null;
    this.name = parts?.name;
    // A throw here resets the object and fails the event that woke it: the refusal. The promise
    // itself is not awaited by anyone, so its rejection is caught here (the runtime has already
    // refused the event) rather than reported as unhandled.
    ctx
      .blockConcurrencyWhile(async () => {
        if (!parts) {
          throw new NoClientError(
            `A Durable Object on a many-client host is named <client>${OBJECT_NAME_SEPARATOR}<name>: refused`,
          );
        }
        await this.refresh();
      })
      .catch(() => {});
  }

  /**
   * Reads the client's admission again (each call of the object does, `refreshOnEachCall`): the
   * registry's latest, so settings changed and a client removed reach an object that outlives a
   * version stamp. A client the registry no longer serves (removed, paused, moving, behind), or
   * whose generation the name's proof is not for (a later client under the id), is refused: this
   * throws and the message, alarm or call fails. Single-client: the real `env`.
   */
  async refresh(): Promise<E> {
    if (!this.#parts) {
      if (this.#env && !servesManyClients(this.#host)) return this.#env;
      throw new NoClientError("This object's name carries no client: refused");
    }
    const client = this.#parts.client;
    const admission = await admissionOf(this.#host, client);
    // A refusal takes the environment away at once: until the next admission, nothing of the
    // object's code reads the client's environment again.
    if (!admission.served) {
      this.#env = null;
      throw new NoClientError(
        `This object's client is not served now (${admission.refused})`,
        waitsForClient(admission) ? "updating" : "unknown",
      );
    }
    if (!isObjectName(this.#parts, admission.client.secretGeneration, hostBindingKey(this.#host))) {
      this.#env = null;
      throw new NoClientError("This object's name is not the host's for its client: refused");
    }
    this.#generation = admission.client.secretGeneration;
    this.#env = admission.env;
    this.#checkedAt = Date.now();
    return admission.env;
  }

  /** Whether the client was admitted within the directory's refresh interval (sync check). */
  get fresh(): boolean {
    return this.#env !== null && Date.now() - this.#checkedAt < REGISTRY_REFRESH_MS;
  }

  /** The environment the object runs with: the client's, or the real one on a single client. */
  get env(): E {
    if (!this.#env) throw new NoClientError("This object's client is not decided: refused");
    return this.#env;
  }

  /**
   * The host's proof of this object's client, its generation and `parts` for `purpose`, for
   * props this object mints (an entrypoint it hands a gatekeeper): made with the props key in
   * the object's real `env`, which nothing else here hands out. It signs for this object's own
   * client only, so code in one client's object cannot make a proof for another (#515, S2), and
   * only for what an object mints (`MINTED_BY_OBJECTS`: a gatekeeper's callback), never a web
   * app's props or anything a later purpose adds (review of #520). Single-client: null, nothing
   * is checked.
   */
  proof(purpose: string, ...parts: string[]): string | null {
    if (this.client === null) return null;
    if (!MINTED_BY_OBJECTS.includes(purpose)) {
      throw new NoClientError(`An object mints no ${purpose} proof`);
    }
    if (!this.#env) throw new NoClientError("This object's client is not decided: refused");
    if (!hostPropsKey(this.#host)) {
      throw new NoClientError(`${PROPS_KEY} is not bound: nothing can be minted`);
    }
    return propsProof(this.#host, purpose, this.client, generationPart(this.#generation), ...parts);
  }
}

/** The purposes an object may mint a proof for: a gatekeeper's callback only. */
const MINTED_BY_OBJECTS: readonly string[] = [PROOF.callback];

/** Where an object class keeps its `ClientObject`, for `refreshOnEachCall`. */
export const CLIENT_OBJECT: unique symbol = Symbol.for("cos.client-object");

/**
 * The `env` a client's object's base class is constructed with on a many-client host: a view
 * that reads, at each access, the client's environment its `ClientObject` holds, so the object's
 * code, the Agents SDK under it, and anything they hand `this.env` to see the client's names and
 * never the host's (#515, S2). Before the client is decided, and after a refusal, every read
 * throws. Read-only: writes, deletes and new properties are refused.
 */
function clientEnvView<E extends HostBindings>(owner: ClientObject<E>): E {
  const current = () => owner.env as unknown as Record<string | symbol, unknown>;
  return new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, name) => current()[name],
    has: (_target, name) => name in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), name);
      // Reported configurable: the view's own target has none of them (a proxy's invariant).
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    getPrototypeOf: () => Object.prototype,
  }) as unknown as E;
}

/** A Durable Object base class: constructed with `(ctx, env)`, keeping both. */
// biome-ignore lint/suspicious/noExplicitAny: a mixin's base takes any constructor arguments
type ObjectBase = abstract new (...args: any[]) => object;

/**
 * A Durable Object class's base on a host that may serve many clients (#515, S2): `Base`
 * (`DurableObject`, the Agents SDK's `Agent`, a mixin of them) constructed with the client's
 * environment instead of the real one. On a many-client host, `this.env` (and everything `Base`
 * keeps of it) is `clientEnvView`: the client's environment once decided, never the host's; the
 * real `env` stays in the `ClientObject`'s private field. Single-client: `Base` as it is, with
 * the real `env`. The class's `ClientObject` is at `this[CLIENT_OBJECT]` (for `refreshOnEachCall`
 * and for `proof`), and every object class of the app and the runner extends one of these (the
 * lint, scripts/check-module-env.mjs).
 */
export function ClientDurableObject<B extends ObjectBase>(Base: B) {
  abstract class Client extends Base {
    readonly [CLIENT_OBJECT]: ClientObject<HostBindings>;
    // biome-ignore lint/suspicious/noExplicitAny: a mixin's constructor takes its base's arguments
    constructor(...args: any[]) {
      const [ctx, env, ...rest] = args as [DurableObjectState, HostBindings, ...unknown[]];
      const owner = new ClientObject(ctx, env);
      super(
        ctx,
        owner.client === null && !servesManyClients(env) ? env : clientEnvView(owner),
        ...rest,
      );
      this[CLIENT_OBJECT] = owner;
    }
  }
  return Client;
}

/** The methods `refreshOnEachCall` leaves as they are: the runtime's and the language's own. */
const NOT_WRAPPED = new Set<string | symbol>(["constructor"]);

/** Whether a call is already inside a checked one (its own code calling its methods). */
const insideCall = new AsyncLocalStorage<true>();

/**
 * The entry points the runtime calls on a Durable Object, checked even when the class inherits
 * them from a framework base (the Agents SDK's `fetch`, `alarm` and socket handlers).
 */
const RUNTIME_ENTRIES = ["fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError"];

/**
 * Makes every method of a Durable Object class read its client's admission again before it runs,
 * so a warm object of a client paused, moving, behind or removed stops serving at its next event,
 * as a request would (review of #512, M2; #515): its own methods, those it inherits from the
 * host's classes and mixins, and the runtime's entry points (`RUNTIME_ENTRIES`) wherever they are
 * defined. A framework base the class names in `frameworks` (the Agents SDK's `Agent`) is walked no
 * further than its entry points: its other methods are its own machinery, which it calls itself
 * and inspects (it refuses a subclass that seems to override two names of one hook).
 *
 * The check is made at the call that enters the object (an RPC, `fetch`, an alarm, a socket
 * message); a call the object's own code makes inside one is not checked again. A method's kind
 * is not guessed from how it was written: when the client was read within the directory's
 * refresh interval the method runs at once, as it is (a sync method stays sync), and otherwise the
 * admission is read first and the call answers with a promise. Wrappers are defined on the class
 * itself; the classes it inherits from are not changed. Single-client: the method runs as before,
 * with nothing read first.
 */
export function refreshOnEachCall(
  cls: { prototype: object },
  frameworks: ReadonlyArray<{ prototype: object }> = [],
): void {
  const prototype = cls.prototype as Record<string | symbol, unknown>;
  const stops = new Set<object>(frameworks.map((framework) => framework.prototype));
  const seen = new Set<string | symbol>();
  let framework = false;
  for (
    let level: object | null = prototype;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  ) {
    framework ||= stops.has(level);
    for (const name of Reflect.ownKeys(level)) {
      if (seen.has(name) || NOT_WRAPPED.has(name)) continue;
      if (framework && !RUNTIME_ENTRIES.includes(name as string)) continue;
      seen.add(name);
      const descriptor = Reflect.getOwnPropertyDescriptor(level, name);
      const original = descriptor?.value;
      if (typeof original !== "function") continue;
      const checked = function (this: Record<symbol, unknown>, ...args: unknown[]) {
        const owner = this?.[CLIENT_OBJECT] as ClientObject<HostBindings> | undefined;
        const run = () => original.apply(this, args);
        if (!owner || owner.client === null || insideCall.getStore()) return run();
        if (owner.fresh) return insideCall.run(true, run);
        return owner.refresh().then(() => insideCall.run(true, run));
      };
      Object.defineProperty(checked, "name", { value: original.name });
      Object.defineProperty(prototype, name, { ...descriptor, value: checked });
    }
  }
}
