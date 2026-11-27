// The operator's Worker (stage 66 step 7, ADR 0618): the one way `cos` on the operator's machine
// reaches what Cloudflare's REST API cannot, each client's database (a Durable Object of
// cos-client-db) and the client's part of the shared stores, for the operator's commands only:
// `cos client add`, the update, `export`, `import` and `remove`.
//
// apps/operator is this handler and nothing else, deployed on a fleet deployment only, beside
// cos-client-db. It binds the raw `CLIENT_DB` namespace (the operator's methods: migrations,
// bookmarks, restore, holds, erase), the registry, the files bucket, the exports bucket, OAuth's
// key-value and the search index, and holds the host's keys so that a leaving client's secrets
// can be opened for it (`exportClientSecrets`). No Worker of the host binds it, and it binds no
// Worker of the host.
//
// **Who may call it.** Only a request with `Authorization: Bearer <COS_OPERATOR_TOKEN>`, compared
// in constant time; with no token set (or one under 32 characters) every request is refused. The
// token is no standing credential: `cos` sets a fresh random one as the Worker's secret at the
// start of each command (with the account's token, which is the operator's authority, ADR 0613)
// and another, which it forgets, at the end. So the operator's commands are exactly as strong as
// the Cloudflare token that runs them, as every other write of the registry is.
//
// **What it touches.** Only a client the registry has in this deployment's environment, by its
// checked id, and only that client's part of each store (`clients/<client>/` in the files bucket
// and the key-value namespace, the client's namespace in the search index). Its answers carry
// counts, names, hashes and SQL parts of an export; a client's secrets only from `secrets-export`,
// for the leaving client's own install, never logged.
import { clientKey, clientKeyPrefix } from "./client-bindings.ts";
import {
  type ClientDb,
  clientDatabase,
  type MigrationReport,
  provablyReadOnly,
  restoreClientDb,
} from "./client-db.ts";
import type { Migration, MigrationLevel } from "./migrate.ts";
import { type ClientId, clientIdProblem } from "./registry.ts";
import { exportClientSecrets, type HostKeys } from "./registry-secrets.ts";
import { readClient } from "./registry-writes.ts";
import {
  clientDbHold,
  type ExportCursor,
  type ExportPart,
  exportPart,
  importedExtensionObjects,
  importPart,
  migrationsSchema,
  type SchemaRow,
  schemaRows,
} from "./sql-export.ts";

export interface OperatorEnv extends HostKeys {
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  REGISTRY: D1Database;
  BLOBS: R2Bucket;
  /** Where exports are kept (a removed client's for 90 days, by the bucket's lifecycle rule). */
  EXPORTS: R2Bucket;
  OAUTH_KV?: KVNamespace;
  VECTORIZE?: Vectorize;
  COS_HOST_ENVIRONMENT?: string;
  COS_OPERATOR_TOKEN?: string;
}

/** The shortest operator token accepted: `cos` makes 43 characters (32 random bytes). */
export const OPERATOR_TOKEN_MIN = 32;
/** The operator token's secret, set by `cos` on the operator's Worker at each command. */
export const OPERATOR_TOKEN_VAR = "COS_OPERATOR_TOKEN";

/** How many objects one call of a page action handles: inside one invocation's subrequests. */
export const OPERATOR_PAGE = 200;

/** An object name no client id can be (a client id never starts with `_`). */
const REFERENCE_PREFIX = "_reference-";

class OperatorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

function sameToken(given: string, own: string): boolean {
  const a = encoder.encode(given);
  const b = encoder.encode(own);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function authorised(request: Request, env: OperatorEnv): boolean {
  const own = env.COS_OPERATOR_TOKEN;
  if (typeof own !== "string" || own.length < OPERATOR_TOKEN_MIN) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? sameToken(match[1] as string, own) : false;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The client a call names, once the registry has it in this deployment's environment. */
async function clientOf(env: OperatorEnv, id: unknown) {
  const problem = clientIdProblem(id);
  if (problem) throw new OperatorError(`not a client id: ${problem}`);
  const record = await readClient(env.REGISTRY, id as ClientId);
  if (!record || record.environment !== env.COS_HOST_ENVIRONMENT) {
    throw new OperatorError(`no client ${id} in this deployment's registry`, 404);
  }
  return record;
}

function stubOf(env: OperatorEnv, client: string) {
  return env.CLIENT_DB.get(env.CLIENT_DB.idFromName(client));
}

/** An export's key in the exports bucket: `<client>/<generation>/<stamp>`, checked. */
function exportKeyOf(
  client: { id: string; secretGeneration: string | null },
  key: unknown,
): string {
  if (typeof key !== "string" || !/^[a-z0-9-]+\/[0-9a-f]{32}\/\d{8}T\d{6}Z$/.test(key)) {
    throw new OperatorError("an export's key is <client>/<generation>/<YYYYMMDDTHHMMSSZ>");
  }
  if (!key.startsWith(`${client.id}/${client.secretGeneration}/`)) {
    throw new OperatorError("that export is not this client's");
  }
  return key;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What an import into a client's database expects: the core schema the code's migrations make
 * (`migrationsSchema`, on a reference database of its own, erased after), and the extension
 * objects as the export declared them (ADR 0618: the reconciler's check of those is not built).
 */
async function importExpectation(env: OperatorEnv, migrations: Migration[]) {
  return async (db: D1Database, source: { migrations: string[] }): Promise<SchemaRow[]> => {
    const name = `${REFERENCE_PREFIX}${crypto.randomUUID()}`;
    try {
      const core = await migrationsSchema(
        clientDatabase(env.CLIENT_DB, name),
        migrations,
        source.migrations,
      );
      return [...core, ...importedExtensionObjects(await schemaRows(db), core)];
    } finally {
      await stubOf(env, name)
        .erase()
        .catch(() => {});
    }
  };
}

type Body = Record<string, unknown> & { action?: string; client?: string };

async function act(env: OperatorEnv, body: Body): Promise<unknown> {
  switch (body.action) {
    case "health":
      return { ok: true, environment: env.COS_HOST_ENVIRONMENT ?? null };
    case "level": {
      const client = await clientOf(env, body.client);
      return (await stubOf(env, client.id).level()) as MigrationLevel;
    }
    case "place": {
      const client = await clientOf(env, body.client);
      const hint = client.locationHint ?? undefined;
      const db = env.CLIENT_DB.get(
        env.CLIENT_DB.idFromName(client.id),
        hint ? { locationHint: hint } : undefined,
      );
      return db.place(hint);
    }
    case "migrate": {
      const client = await clientOf(env, body.client);
      const migrations = migrationsOf(body.migrations);
      return (await stubOf(env, client.id).migrateAndReport(migrations)) as MigrationReport;
    }
    case "bookmark": {
      const client = await clientOf(env, body.client);
      return { bookmark: await stubOf(env, client.id).bookmark() };
    }
    case "restore": {
      const client = await clientOf(env, body.client);
      if (typeof body.bookmark !== "string") throw new OperatorError("a bookmark is needed");
      return restoreClientDb(env.CLIENT_DB, client.id, body.bookmark);
    }
    case "query": {
      // Reads only: the update's checks of a client's own extensions, an export's counts.
      const client = await clientOf(env, body.client);
      if (typeof body.sql !== "string" || !provablyReadOnly([{ sql: body.sql }])) {
        throw new OperatorError("only a statement that provably reads is run here");
      }
      const params = Array.isArray(body.params) ? body.params : [];
      const { results } = await clientDatabase(env.CLIENT_DB, client.id)
        .prepare(body.sql)
        .bind(...params)
        .all();
      return { results };
    }
    case "export-db-part": {
      const client = await clientOf(env, body.client);
      const key = exportKeyOf(client, body.exportKey);
      const { part, next } = await exportPart(
        clientDatabase(env.CLIENT_DB, client.id),
        (body.cursor as ExportCursor | null) ?? null,
        { hold: clientDbHold(env.CLIENT_DB as unknown as DurableObjectNamespace, client.id) },
      );
      const text = JSON.stringify(part);
      const bytes = encoder.encode(text);
      const path = `${key}/database/${String(part.index).padStart(6, "0")}.json`;
      await env.EXPORTS.put(path, bytes);
      return {
        index: part.index,
        last: part.last,
        statements: part.statements.length,
        sha256: await sha256Hex(bytes.buffer as ArrayBuffer),
        path,
        next,
        ...(part.counts ? { counts: part.counts } : {}),
        ...(part.source ? { source: part.source } : {}),
      };
    }
    case "export-files-page": {
      const client = await clientOf(env, body.client);
      const key = exportKeyOf(client, body.exportKey);
      const prefix = clientKeyPrefix(client.id);
      const listed = await env.BLOBS.list({
        prefix,
        limit: OPERATOR_PAGE,
        ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}),
      });
      const files: { key: string; size: number; sha256: string }[] = [];
      for (const object of listed.objects) {
        const own = object.key.slice(prefix.length);
        const got = await env.BLOBS.get(object.key);
        if (!got) continue;
        const bytes = await got.arrayBuffer();
        await env.EXPORTS.put(`${key}/files/${own}`, bytes, {
          ...(got.httpMetadata ? { httpMetadata: got.httpMetadata } : {}),
        });
        files.push({ key: own, size: bytes.byteLength, sha256: await sha256Hex(bytes) });
      }
      return { files, next: listed.truncated ? listed.cursor : null };
    }
    case "export-manifest": {
      const client = await clientOf(env, body.client);
      const key = exportKeyOf(client, body.exportKey);
      if (!body.manifest || typeof body.manifest !== "object") {
        throw new OperatorError("a manifest is an object");
      }
      await env.EXPORTS.put(`${key}/manifest.json`, JSON.stringify(body.manifest, null, 2));
      return { path: `${key}/manifest.json` };
    }
    case "export-list": {
      const client = await clientOf(env, body.client);
      const key = exportKeyOf(client, body.exportKey);
      const listed = await env.EXPORTS.list({
        prefix: `${key}/`,
        limit: 1000,
        ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}),
      });
      return {
        keys: listed.objects.map((o) => ({ path: o.key, size: o.size })),
        next: listed.truncated ? listed.cursor : null,
      };
    }
    case "import-db-part": {
      const client = await clientOf(env, body.client);
      const migrations = migrationsOf(body.migrations);
      return importPart(clientDatabase(env.CLIENT_DB, client.id), body.part as ExportPart, {
        expectedSchema: await importExpectation(env, migrations),
      });
    }
    case "requeue-embeddings": {
      // After an import: the search index is the client's namespace, empty here, so every record
      // the export had embedded is queued again and the host's embeddings tick rebuilds it.
      const client = await clientOf(env, body.client);
      const db = clientDatabase(env.CLIENT_DB, client.id);
      const [queued] = await db.batch(requeueEmbeddings(db, new Date().toISOString()));
      return { queued: Number(queued?.meta.changes ?? 0) };
    }
    case "secrets-export": {
      const client = await clientOf(env, body.client);
      return exportClientSecrets(env, client);
    }
    case "erase-db": {
      const client = await clientOf(env, body.client);
      return stubOf(env, client.id).erase();
    }
    case "files-delete-page": {
      const client = await clientOf(env, body.client);
      const listed = await env.BLOBS.list({ prefix: clientKeyPrefix(client.id), limit: 1000 });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length) await env.BLOBS.delete(keys);
      return { deleted: keys.length, more: listed.truncated };
    }
    case "kv-delete-page": {
      const client = await clientOf(env, body.client);
      if (!env.OAUTH_KV) return { deleted: 0, more: false };
      const listed = await env.OAUTH_KV.list({
        prefix: clientKeyPrefix(client.id),
        limit: OPERATOR_PAGE,
      });
      for (const key of listed.keys) await env.OAUTH_KV.delete(key.name);
      return { deleted: listed.keys.length, more: !listed.list_complete };
    }
    case "vectors-delete-page": {
      const client = await clientOf(env, body.client);
      if (!env.VECTORIZE) return { deleted: 0, more: false };
      const { dimensions } = await env.VECTORIZE.describe();
      const found = await env.VECTORIZE.query(new Array(dimensions).fill(1), {
        namespace: client.id,
        topK: 100,
        returnValues: false,
        returnMetadata: "none",
      });
      const ids = found.matches.map((m) => m.id);
      if (ids.length) await env.VECTORIZE.deleteByIds(ids);
      return { deleted: ids.length, more: ids.length > 0 };
    }
    default:
      throw new OperatorError("no such action", 404);
  }
}

/**
 * The statements that queue every embedded record again and forget the vectors it had (stage 66
 * step 7): what an imported database needs, whose search index is new and empty. The embeddings
 * tick (packages/core `drainEmbeddingQueue`) then embeds each one into the index it has now.
 */
export function requeueEmbeddings(db: D1Database, now: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO core_embedding_queue (object_type, record_id, queued_at) SELECT object_type, record_id, ? FROM core_embedding",
      )
      .bind(now),
    db.prepare("DELETE FROM core_embedding"),
  ];
}

function migrationsOf(value: unknown): Migration[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (m) =>
        m &&
        typeof m.name === "string" &&
        /^[\w.-]+$/.test(m.name) &&
        Array.isArray(m.queries) &&
        m.queries.every((q: unknown) => typeof q === "string"),
    )
  ) {
    throw new OperatorError("migrations are [{ name, queries }]");
  }
  return value as Migration[];
}

/** `/files/<client>/<key>`: a client's file, read for an export or written by an import. */
async function file(request: Request, env: OperatorEnv, rest: string): Promise<Response> {
  const slash = rest.indexOf("/");
  if (slash < 1) throw new OperatorError("/files/<client>/<key>");
  const client = await clientOf(env, rest.slice(0, slash));
  let stored: string;
  try {
    stored = clientKey(client.id, decodeURIComponent(rest.slice(slash + 1)));
  } catch (error) {
    throw new OperatorError(`not a key of the client's: ${(error as Error).message}`);
  }
  if (request.method === "PUT") {
    const bytes = await request.arrayBuffer();
    const type = request.headers.get("content-type");
    await env.BLOBS.put(stored, bytes, type ? { httpMetadata: { contentType: type } } : undefined);
    return json({ key: stored.slice(clientKeyPrefix(client.id).length), size: bytes.byteLength });
  }
  if (request.method === "GET") {
    const got = await env.BLOBS.get(stored);
    if (!got) return json({ error: "no such file" }, 404);
    return new Response(got.body, {
      headers: { "content-type": got.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  }
  return json({ error: "GET or PUT" }, 405);
}

/** `/exports/<client>/<generation>/<stamp>/<path>`: a kept export's file, read for `--out`. */
async function exported(request: Request, env: OperatorEnv, rest: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET" }, 405);
  const parts = rest.split("/");
  const client = await clientOf(env, parts[0]);
  exportKeyOf(client, parts.slice(0, 3).join("/"));
  if (parts.length < 4 || parts.slice(3).some((p) => p === "" || p === "." || p === "..")) {
    throw new OperatorError("/exports/<export key>/<path>");
  }
  const got = await env.EXPORTS.get(rest);
  if (!got) return json({ error: "no such file" }, 404);
  return new Response(got.body);
}

/** The operator's Worker's `fetch`. */
export async function operatorFetch(request: Request, env: OperatorEnv): Promise<Response> {
  if (!authorised(request, env)) return json({ error: "not the operator" }, 401);
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/files/")) {
      return await file(request, env, url.pathname.slice("/files/".length));
    }
    if (url.pathname.startsWith("/exports/")) {
      return await exported(request, env, url.pathname.slice("/exports/".length));
    }
    if (url.pathname !== "/op" || request.method !== "POST") return json({ error: "no" }, 404);
    if (env.COS_HOST_ENVIRONMENT !== "live" && env.COS_HOST_ENVIRONMENT !== "staging") {
      return json({ error: "COS_HOST_ENVIRONMENT is not set" }, 503);
    }
    const body = (await request.json()) as Body;
    return json(await act(env, body));
  } catch (error) {
    const status = error instanceof OperatorError ? error.status : 500;
    // The message of a failure: names and counts, never a value of a secret (none passes here
    // but in `secrets-export`'s answer).
    return json({ error: error instanceof Error ? error.message : String(error) }, status);
  }
}
