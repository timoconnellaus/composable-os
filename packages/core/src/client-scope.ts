// Which client the code now runs for, and what core keeps at module level per client (stage 66
// step 5, ADR 0617).
//
// A Worker isolate serves many requests, one after another and side by side; on a host that serves
// many clients those requests are different clients'. Anything core keeps between requests (the
// extension schema it loaded, the entitlements it read, an answer it memoised, a notice it sent)
// would otherwise be there for the next request whoever's it is. So every such value is kept per
// client (`clientState`), found from the client scope the code runs in.
//
// The scope is the database the client's requests reach: one object per client and isolate (the
// client's environment's `DB`, or the D1 binding of a single-client deployment). It is held by an
// AsyncLocalStorage the host Worker gives once at load (`provideClientScope`), set at each entry
// once it has decided the client (`runInClientScope`) and by `invoke` for every operation, and it
// follows the code through every await and anything it starts. This module never imports
// `node:async_hooks` itself (core is also bundled into the browser), nor anything else: errors.ts,
// which imports nothing, keeps its state here.
//
// - A single-client deployment gives no store: each value is one module-level value, exactly as
//   before.
// - A many-client host gives one and refuses code that runs outside any scope (`unscoped:
//   "refuse"`): it has no client to answer for, so it gets nothing rather than another's.
// - The two-client test mode (`COS_TEST_DB=two-clients`) gives one whose unscoped code is the
//   suite's own client (`unscoped: <its database>`), while a second client takes turns in scope.
/** One client's scope: the database its requests reach, and its id on a many-client host. */
export interface ClientScope {
  readonly database: object;
  /** The client's id (the registry's), or null where it is not known (a single client). */
  readonly client: string | null;
}

/** The part of `AsyncLocalStorage` this uses (workerd's, under nodejs_compat). */
export interface ClientScopeStore {
  run<T>(scope: ClientScope, run: () => T): T;
  getStore(): ClientScope | undefined;
}

/** Code outside every client's scope on a host that serves many: refused, never shared. */
export class NoClientScopeError extends Error {
  override name = "NoClientScopeError";
  constructor() {
    super(
      "No client for this code: on a host that serves many clients it runs only in the scope of " +
        "the client an entry decided (runInClientScope)",
    );
  }
}

// Set once per isolate by the host Worker's entry module: the deployment's, never a client's.
let store: ClientScopeStore | null = null;
let unscopedScope: ClientScope | "refuse" = "refuse";

/**
 * Gives core the store client scopes are held in: once, by a host Worker that serves many clients
 * (`unscoped: "refuse"`), or by the two-client test mode (`unscoped`: the scope its tests' own
 * client runs in). Null takes it away (tests).
 */
export function provideClientScope(
  given: ClientScopeStore | null,
  options: { unscoped: "refuse" | ClientScope } = { unscoped: "refuse" },
): void {
  store = given;
  unscopedScope = options.unscoped;
}

/** Whether a store was given: a many-client host, or the two-client test mode. */
export function clientScopesHeld(): boolean {
  return store !== null;
}

/** Runs `run` in `scope`. Without a store (a single client), just runs it. */
export function runInClientScope<T>(scope: ClientScope, run: () => T): T {
  return store ? store.run(scope, run) : run();
}

/**
 * Runs `run` in the scope of `database` (`databaseOf` a handle) when no scope is held yet: an
 * operation invoked where no entry set one (a Durable Object's own call, a test). Inside a scope,
 * or without a store, just runs it.
 */
export function inDatabaseScope<T>(database: object, run: () => T): T {
  if (!store || store.getStore()) return run();
  // In the two-client tests, code outside every scope is the suite's own client, whatever handle
  // it holds (a test's metering proxy of its database included): its scope, id and all.
  if (unscopedScope !== "refuse") return store.run(unscopedScope, run);
  return store.run({ database, client: null }, run);
}

/**
 * The scope the code runs in: the store's, else the unscoped one (the two-client tests' own
 * client). Null without a store. On a many-client host, code outside every scope is refused.
 */
export function currentClientScope(): ClientScope | null {
  if (!store) return null;
  const held = store.getStore();
  if (held) return held;
  if (unscopedScope === "refuse") throw new NoClientScopeError();
  return unscopedScope;
}

/**
 * The client's id the code runs for, or null (a single client; a scope an entry did not name).
 * A shared cache outside the isolate (the Workers Cache API) puts it in its key.
 */
export function currentClientId(): string | null {
  return currentClientScope()?.client ?? null;
}

/** One value per client: what a module keeps between requests (`clientState`). */
export interface ClientState<T> {
  /** The current client's value, made by `make` the first time. */
  get(): T;
  /** Forgets every client's value (tests, and after a change the isolate made itself). */
  reset(): void;
}

/**
 * A value kept at module level, one per client. Without a store (a single-client deployment)
 * there is one value, as a plain module-level variable would hold. With one, the value is the
 * current scope's database's, held weakly, so a client's environment that the registry replaced
 * takes its values with it.
 */
export function clientState<T>(make: () => T): ClientState<T> {
  let single: { value: T } | null = null;
  let byDatabase = new WeakMap<object, { value: T }>();
  return {
    get() {
      const scope = currentClientScope();
      if (!scope) {
        single ??= { value: make() };
        return single.value;
      }
      let held = byDatabase.get(scope.database);
      if (!held) {
        held = { value: make() };
        byDatabase.set(scope.database, held);
      }
      return held.value;
    },
    reset() {
      single = null;
      byDatabase = new WeakMap();
    },
  };
}
