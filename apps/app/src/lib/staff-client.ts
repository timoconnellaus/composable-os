// The client a pack's block is given in the admin (stage 47, ADR 0660) and on the development
// page (`/blocks`): a typed client's shape over the host's HTTP surface (`/api/v1/op/<name>`) on
// the page's own origin, with the browser's session (a staff session in the admin). The host
// decides every call: this holds every operation a pack's hooks name (its `*_HOOKS_CALL`), and a
// call the account may not make is refused by the host, never hidden here.
//
// Its `baseUrl` is the app's own origin, never a prop or a URL parameter: a screen that shows an
// address on the host (a calendar feed's) builds it from this.
//
// A write carries an idempotency key, the same one across TanStack Query's retries of one call.
// Query and mutation keys start `["screen", scope]`, so the admin forgets a screen's data when it
// closes (`forgetScreen`).
import type { QueryClient } from "@tanstack/react-query";

/** An error as the HTTP surface sends it, with the host's details. */
export class SurfaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The host could not be reached (what the pack's refusal helpers call a network error). */
class NetworkError extends Error {
  override name = "NetworkError";
}

async function call(name: string, input: unknown, key: string | null): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/op/${encodeURIComponent(name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(input ?? {}),
    });
  } catch {
    throw new NetworkError(`Could not reach the host for ${name}`);
  }
  let body: { data?: unknown; error?: { code?: string; message?: string; details?: unknown } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new SurfaceError("internal", `The host answered ${response.status}`);
  }
  if (!response.ok || body.error) {
    // A tool's refusal carries the host's own words inside it.
    const inner = (body.error?.details as { details?: unknown } | undefined)?.details;
    throw new SurfaceError(
      body.error?.code ?? "internal",
      body.error?.message ?? "Refused",
      inner ?? body.error?.details,
    );
  }
  return body.data;
}

/** The query and mutation key prefix of one screen's client. */
export const screenKey = (scope: string) => ["screen", scope] as const;

/**
 * A client holding every operation `calls` names (a pack's `*_HOOKS_CALL`), for the pack's hooks.
 * `scope` keys its queries and mutations (`<pack>/<screen>`, or `blocks` on the development page).
 */
export function staffClient<C>(
  calls: Record<string, readonly string[]>,
  scope: string,
  /** Told of a call the host refused as forbidden (a right taken away while the screen is open). */
  onForbidden?: () => void,
): C {
  const send = (name: string, input: unknown, key: string | null) =>
    call(name, input, key).catch((error: unknown) => {
      if (error instanceof SurfaceError && error.code === "forbidden") onForbidden?.();
      throw error;
    });
  const operations = Object.fromEntries(
    Object.values(calls)
      .flat()
      .map((name) => [name, { kind: "query", invalidates: [] }]),
  );
  // One key per call: TanStack Query passes the same variables object to each retry.
  const keys = new WeakMap<object, string>();
  return {
    operations,
    // The host this client calls: the app's own origin (the calls are same-origin). Read when
    // asked, in the browser.
    get baseUrl() {
      return window.location.origin;
    },
    query: (name: string, input: unknown) => ({
      queryKey: [...screenKey(scope), name, input],
      queryFn: () => send(name, input, null),
    }),
    mutation: (name: string) => ({
      mutationKey: [...screenKey(scope), name],
      mutationFn: (input: unknown) => {
        const holder = input !== null && typeof input === "object" ? input : null;
        let key = holder ? keys.get(holder) : undefined;
        if (!key) {
          key = crypto.randomUUID();
          if (holder) keys.set(holder, key);
        }
        return send(name, input, key);
      },
    }),
  } as C;
}

/**
 * Forgets everything one screen's client read or sent (stage 47: a screen's data is held no longer
 * than the screen is open): its queries are removed from the cache, and its mutations (with what
 * was sent) from the mutation cache.
 */
export function forgetScreen(queryClient: QueryClient, scope: string): void {
  const queryKey = screenKey(scope);
  void queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
  const mutations = queryClient.getMutationCache();
  for (const mutation of mutations.findAll({ mutationKey: queryKey })) mutations.remove(mutation);
}
