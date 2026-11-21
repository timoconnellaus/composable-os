// The cache of public content reads (stage 28, ADR 0442). A public read of a publishable object
// (`content.get`, `content.list`) is the same for everyone who makes it, so its answer is kept in
// the Worker's cache, keyed by the object's generation: a number every committed change to a
// record of the object bumps, in the change's own batch (the pipeline calls
// `contentGenerationWrites`). A publish, an unpublish, a scheduled publish going live, a slug
// change or a delete therefore moves the key, and the next read is the new answer: nothing is
// purged, and nothing stale is served. Old keys age out.
//
// The key also holds the object's random `epoch`, so two deployments behind one cache never share
// an entry. Where no cache exists (a test without one, a runtime without the Cache API) reads go
// to the database every time.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { getObject } from "../fields/index.ts";
import type { RecordChange } from "../operation.ts";

/** How long a cached answer is kept, in seconds. A changed generation stops it being read first. */
export const CONTENT_CACHE_SECONDS = 3600;

/** Where answers are kept: the Workers Cache API's shape. */
export interface ContentCacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

let store: ContentCacheStore | null | undefined;

/** The cache public content reads use: the Worker's default cache, when there is one. */
export function contentCacheStore(): ContentCacheStore | null {
  if (store !== undefined) return store;
  const caches = (globalThis as { caches?: { default?: ContentCacheStore } }).caches;
  store = caches?.default ?? null;
  return store;
}

/** Tests: use `next` (null: no cache) until called again. */
export function setContentCacheStore(next: ContentCacheStore | null | undefined): void {
  store = next;
}

/** Whether a change to `object` changes what the public reads: a publishable object it reads. */
function isPublicContent(object: string): boolean {
  const definition = getObject(object);
  return Boolean(definition?.publishable && definition.public);
}

/** The generation bumps for the objects `changes` touch that the public reads as content. */
export function contentGenerationWrites(changes: readonly RecordChange[], now: string) {
  const objects = [...new Set(changes.map((c) => c.object))].filter(isPublicContent);
  return objects.map((object) =>
    CompiledQuery.raw(
      "INSERT INTO core_content_generation (object_type, generation, epoch, changed_at) VALUES (?, 1, lower(hex(randomblob(16))), ?) ON CONFLICT (object_type) DO UPDATE SET generation = core_content_generation.generation + 1, changed_at = excluded.changed_at",
      [object, now],
    ),
  );
}

/** SHA-256 of `text`, as hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The answer to a public read of `object` named by `key` (the operation and its input): from the
 * cache when this generation's answer is there, else `read()`, kept for the next reader. An
 * object that has never changed has no generation yet and is not cached.
 */
export async function cachedContent<T>(
  db: Kysely<CoreDatabase>,
  object: string,
  key: unknown,
  read: () => Promise<T>,
): Promise<T> {
  const cache = contentCacheStore();
  if (!cache) return read();
  const row = await db
    .selectFrom("core_content_generation")
    .select(["generation", "epoch"])
    .where("object_type", "=", object)
    .executeTakeFirst();
  if (!row) return read();
  const hash = await sha256Hex(JSON.stringify([object, key]));
  const request = new Request(
    `https://content-cache.invalid/${row.epoch}/${Number(row.generation)}/${hash}`,
  );
  try {
    const hit = await cache.match(request);
    if (hit) return (await hit.json()) as T;
  } catch {
    // A cache that cannot be read is no cache: the database answers.
  }
  const value = await read();
  try {
    await cache.put(
      request,
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CONTENT_CACHE_SECONDS}`,
        },
      }),
    );
  } catch {
    // Not kept: the next read asks the database again.
  }
  return value;
}
