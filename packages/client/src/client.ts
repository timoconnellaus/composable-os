// The typed client (stage 23, ADR 0403, ADR 0418). A product's generated file supplies the
// operation types and their specs; this calls them over the HTTP surface and gives TanStack Query
// option objects for each. It imports no TanStack package: the objects are plain, shaped as
// `queryOptions` and `mutationOptions` take them, so any version of the library fits.
//
// - Query keys follow one rule: `[operation, input]`.
// - A mutation's key is `[operation]`, and its `meta.invalidates` lists the query key prefixes it
//   makes stale (`[operation]` for each), taken from the contract.
// - Every mutation sends an Idempotency-Key, made once per call and kept across its retries:
//   the client's own retries, and TanStack Query's (keyed by the variables object it passes back).
import { ApiError, isRetryable, NetworkError, UpgradeRequiredError } from "./errors.ts";
import type { FetchLike, Json } from "./types.ts";

/** What the generated file says about each operation at run time. */
export interface OperationSpec {
  readonly kind: "query" | "mutation";
  readonly invalidates: readonly string[];
}

/** What the generated file says about each operation's types. */
export type OperationTypes = Record<
  string,
  { kind: "query" | "mutation"; input: unknown; output: unknown }
>;

export type QueryName<T extends OperationTypes> = {
  [K in keyof T & string]: T[K]["kind"] extends "query" ? K : never;
}[keyof T & string];
export type MutationName<T extends OperationTypes> = {
  [K in keyof T & string]: T[K]["kind"] extends "mutation" ? K : never;
}[keyof T & string];

export interface ClientOptions {
  /** The host, e.g. `https://crm.example.com`. For a service binding, any origin will do. */
  baseUrl: string;
  /** `fetch`, or a Worker's service binding's `fetch`. Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Headers for every call: a bearer token, say. May be async (a token that refreshes). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Times a call is retried, with the same key, after a network failure or 429/503. Default 2. */
  retries?: number;
  /** Makes an idempotency key. Default: `crypto.randomUUID`, or 32 random hex digits. */
  randomKey?: () => string;
  /** Called before an UpgradeRequiredError is thrown, so an app can show its update screen. */
  onUpgradeRequired?: (error: UpgradeRequiredError) => void;
  /** Waits between retries. Default: a short backoff. Tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  /** The key to send with a mutation; default one made for this call. */
  idempotencyKey?: string;
}

/** The API version this runtime speaks. A host that no longer serves it says upgrade_required. */
export const CLIENT_API_VERSION = "v1";

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** A key with 128 random bits, from whatever the platform has. */
export function defaultRandomKey(): string {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto?.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error(
    "No secure random source: pass randomKey to the client (in React Native, from expo-crypto)",
  );
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    // Every platform this runs on has setTimeout; ECMAScript itself does not declare it.
    (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("No fetch: pass one to the client");
  return f.bind(globalThis) as FetchLike;
}

/** Reads one response as the surface's envelope: the data, or the error it describes. */
async function readEnvelope(response: {
  status: number;
  text(): Promise<string>;
}): Promise<unknown> {
  let body: { data?: unknown; error?: { code?: string; message?: string; details?: unknown } };
  try {
    body = JSON.parse(await response.text()) as typeof body;
  } catch {
    throw new ApiError(
      "internal",
      `The host answered ${response.status} without JSON`,
      response.status,
    );
  }
  if (response.status === 200 && body && "data" in body) return body.data;
  const error = body?.error ?? {};
  const message = error.message ?? `The host answered ${response.status}`;
  if (error.code === "upgrade_required") throw new UpgradeRequiredError(message, error.details);
  throw new ApiError(error.code ?? "internal", message, response.status, error.details);
}

export function createClient<T extends OperationTypes>(
  specs: { readonly [K in keyof T & string]: OperationSpec },
  options: ClientOptions,
) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalFetch();
  const retries = options.retries ?? 2;
  const randomKey = options.randomKey ?? defaultRandomKey;
  const sleep = options.sleep ?? defaultSleep;
  // TanStack Query passes the same variables object to each retry of one mutation.
  const keys = new WeakMap<object, string>();

  async function send(name: string, input: unknown, key: string | null): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(await options.headers?.()),
      ...(key ? { "idempotency-key": key } : {}),
    };
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetcher(`${base}/api/${CLIENT_API_VERSION}/op/${encodeURIComponent(name)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input ?? {}),
      });
    } catch (error) {
      throw new NetworkError(`Could not reach the host for ${name}`, error);
    }
    return readEnvelope(response);
  }

  async function call<N extends keyof T & string>(
    name: N,
    input: T[N]["input"],
    callOptions: CallOptions = {},
  ): Promise<T[N]["output"]> {
    const spec = specs[name];
    if (!spec) throw new ApiError("unknown_operation", `No operation named "${name}"`, 404);
    const key = spec.kind === "mutation" ? (callOptions.idempotencyKey ?? randomKey()) : null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await send(name, input, key)) as T[N]["output"];
      } catch (error) {
        if (error instanceof UpgradeRequiredError) options.onUpgradeRequired?.(error);
        if (attempt >= retries || !isRetryable(error)) throw error;
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  /** `queryOptions` for a read: key `[name, input]`. */
  function query<N extends QueryName<T>>(name: N, input: T[N]["input"]) {
    return {
      queryKey: [name, input] as readonly [N, T[N]["input"]],
      queryFn: (): Promise<T[N]["output"]> => call(name, input),
    };
  }

  /** `mutationOptions` for a write: one idempotency key per mutation, kept across its retries. */
  function mutation<N extends MutationName<T>>(name: N) {
    const spec = specs[name];
    return {
      mutationKey: [name] as readonly [N],
      mutationFn: (input: T[N]["input"]): Promise<T[N]["output"]> => {
        const holder = input !== null && typeof input === "object" ? (input as object) : null;
        let key = holder ? keys.get(holder) : undefined;
        if (!key) {
          key = randomKey();
          if (holder) keys.set(holder, key);
        }
        return call(name, input, { idempotencyKey: key });
      },
      meta: { invalidates: (spec?.invalidates ?? []).map((q) => [q] as const) },
    };
  }

  /** The query key prefixes a mutation makes stale, for `queryClient.invalidateQueries`. */
  function invalidates(name: MutationName<T>): (readonly [string])[] {
    return (specs[name]?.invalidates ?? []).map((q) => [q] as const);
  }

  // `operations`: which operations this client holds, so a pack's hooks can offer exactly the
  // ones it can back (ADR 0453).
  // `baseUrl`: the host this client talks to, for a screen that shows an address on it (a calendar
  // feed's, stage 45): taken from the client, never from the page's own address or query.
  return { call, query, mutation, invalidates, operations: specs, baseUrl: base };
}

export type Client<T extends OperationTypes> = ReturnType<typeof createClient<T>>;

/**
 * For a MutationCache's `onSuccess`: invalidates what a mutation made by this client lists in
 * `meta.invalidates`. `new MutationCache({ onSuccess: invalidateFromMeta(queryClient) })`.
 */
export function invalidateFromMeta(queryClient: {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}) {
  return (
    _data: unknown,
    _variables: unknown,
    _context: unknown,
    mutation: { meta?: Record<string, unknown> | undefined },
  ) => {
    const stale = (mutation.meta?.invalidates ?? []) as readonly (readonly unknown[])[];
    return Promise.all(stale.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}

export type { Json };
