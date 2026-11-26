// The widget result cache (ADR 0057): 60 seconds per query + params + visibility scope, in the
// Workers Cache API. It is free, needs no binding, and never writes to D1 or KV. Entries are
// keyed by a SHA-256 of the validated SQL, its bound params, the caller's visibility scope and the
// organisation's time zone, so a cached result is only served to someone who would see the same
// rows, and a change of zone is never answered from before it (ADR 0871). Each data centre
// keeps its own copy; a miss simply runs the query. Manual refresh skips the read and replaces
// the entry.
//
// The Cache API is a no-op on `*.workers.dev` hostnames and when no `caches` global exists
// (Node tests): every call is then a miss, which is correct, only slower.
//
// The Cache API is the zone's, shared by every client of a host that serves many (stage 66 step 5,
// ADR 0617): there the key also holds the client, and code whose scope names no client caches
// nothing.

import { clientScopesHeld, currentClientId } from "../client-scope.ts";
import { sha256Hex } from "../digest.ts";

export const WIDGET_CACHE_TTL_SECONDS = 60;
const CACHE_ORIGIN = "https://widget-cache.crm.internal/v1/";

export interface CachedResult<T> {
  value: T;
  cachedAt: string;
}

export interface WidgetCache {
  get<T>(key: string): Promise<CachedResult<T> | null>;
  put<T>(key: string, value: T, cachedAt: string): Promise<void>;
}

/**
 * The cache key for one query run: SQL, positional params, row limit, scope and zone, and on a
 * host that serves many clients the client's id (a single client's keys are as they were).
 */
export async function widgetCacheKey(parts: {
  sql: string;
  params: readonly unknown[];
  maxRows: number;
  scope: string;
  zone: string;
}): Promise<string> {
  const client = currentClientId();
  return sha256Hex(
    JSON.stringify([
      parts.sql,
      parts.params,
      parts.maxRows,
      parts.scope,
      parts.zone,
      ...(client === null ? [] : [client]),
    ]),
  );
}

/** Whether the shared cache may be used here: not where scopes are held and none names a client. */
function sharedCacheUsable(): boolean {
  return !clientScopesHeld() || currentClientId() !== null;
}

/**
 * Who may see which rows. Today every role that can read records reads all of them (record-level
 * permissions belong in the rec_* views, ADR 0010), so the scope is the role; when per-user
 * visibility lands this returns the user's scope and cached results stay separated by it.
 */
export function visibilityScope(user: { role: string }): string {
  return `role:${user.role}`;
}

/** The Cache API cache (`caches.default`), or null where there is none. */
function defaultCache(): Cache | null {
  const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return store?.default ?? null;
}

/** A WidgetCache over the Workers Cache API. */
export function cacheApiWidgetCache(cache: Cache | null = defaultCache()): WidgetCache {
  return {
    async get<T>(key: string) {
      if (!cache || !sharedCacheUsable()) return null;
      try {
        const response = await cache.match(`${CACHE_ORIGIN}${key}`);
        if (!response) return null;
        return (await response.json()) as CachedResult<T>;
      } catch {
        return null;
      }
    },
    async put<T>(key: string, value: T, cachedAt: string) {
      if (!cache || !sharedCacheUsable()) return;
      const body: CachedResult<T> = { value, cachedAt };
      try {
        await cache.put(
          `${CACHE_ORIGIN}${key}`,
          new Response(JSON.stringify(body), {
            headers: {
              "content-type": "application/json",
              "cache-control": `max-age=${WIDGET_CACHE_TTL_SECONDS}`,
            },
          }),
        );
      } catch {
        // A full or unavailable cache only costs a re-run.
      }
    },
  };
}

/** An in-memory WidgetCache with the same TTL (tests, and runtimes without the Cache API). */
export function memoryWidgetCache(clock: () => number = Date.now): WidgetCache & {
  size(): number;
} {
  const entries = new Map<string, { body: CachedResult<unknown>; expires: number }>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry || entry.expires <= clock()) return null;
      return entry.body as CachedResult<T>;
    },
    async put<T>(key: string, value: T, cachedAt: string) {
      entries.set(key, {
        body: { value, cachedAt },
        expires: clock() + WIDGET_CACHE_TTL_SECONDS * 1000,
      });
    },
    size: () => entries.size,
  };
}
