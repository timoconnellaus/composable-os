// The operator's Worker (stage 66 step 7, ADR 0617): the one way `cos` reaches clients' databases
// and their part of the shared stores. Driven here through its `fetch`, on a real `ClientDb` and
// the registry, files, exports and key-value bindings of the local runtime.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ClientDb } from "../src/client-db.ts";
import { CORE_SCHEMA_VERSION, type Migration } from "../src/migrate.ts";
import { type OperatorEnv, operatorFetch } from "../src/operator.ts";
import type { ClientId } from "../src/registry.ts";
import { newHostKeys } from "../src/registry-sealing.ts";
import { addClientRows, readClient } from "../src/registry-writes.ts";
import type { ExportPart } from "../src/sql-export.ts";
import { emptyRegistry, migrateRegistry } from "./registry-fixtures.ts";

const real = env as unknown as {
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  REGISTRY: D1Database;
  BLOBS: R2Bucket;
  EXPORTS: R2Bucket;
  OAUTH_KV: KVNamespace;
  TEST_MIGRATIONS: Migration[];
};
const TOKEN = "t".repeat(20) + crypto.randomUUID();

/** A search index that answers by namespace, as Vectorize does. */
function fakeIndex() {
  const vectors = new Map<string, string>([
    ["c:a1", "op-one"],
    ["c:a2", "op-one"],
    ["c:b1", "op-two"],
  ]);
  return {
    vectors,
    async describe() {
      return { dimensions: 4 };
    },
    async query(_v: number[], options: { namespace: string; topK: number }) {
      return {
        matches: [...vectors]
          .filter(([, ns]) => ns === options.namespace)
          .slice(0, options.topK)
          .map(([id]) => ({ id, score: 1 })),
      };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" };
    },
  };
}

let keys: Awaited<ReturnType<typeof newHostKeys>>;
let index: ReturnType<typeof fakeIndex>;
const operatorEnv = (over: Partial<OperatorEnv> = {}): OperatorEnv => ({
  CLIENT_DB: real.CLIENT_DB,
  REGISTRY: real.REGISTRY,
  BLOBS: real.BLOBS,
  EXPORTS: real.EXPORTS,
  OAUTH_KV: real.OAUTH_KV,
  VECTORIZE: index as unknown as Vectorize,
  COS_HOST_ENVIRONMENT: "live",
  COS_OPERATOR_TOKEN: TOKEN,
  COS_ROOT_KEY: keys.rootKey,
  COS_SECRETS_PRIVATE_KEY: keys.secretsPrivateKey,
  ...over,
});
const call = async (
  body: Record<string, unknown>,
  over: Partial<OperatorEnv> = {},
  token = TOKEN,
) => {
  const response = await operatorFetch(
    new Request("https://operator.example/op", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    operatorEnv(over),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const raw = (path: string, init: RequestInit = {}) =>
  operatorFetch(
    new Request(`https://operator.example${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    }),
    operatorEnv(),
  );

const newClient = (id: string, environment: "live" | "staging" = "live") =>
  addClientRows(real.REGISTRY, {
    id,
    environment,
    tier: "standard",
    hostnames: [{ hostname: `${id}-admin.fleet.example`, surface: "staff" }],
  });

beforeAll(async () => {
  keys = await newHostKeys();
  index = fakeIndex();
  await migrateRegistry();
  await emptyRegistry();
  await newClient("op-one");
  await newClient("op-two");
  await newClient("op-stage", "staging");
});

describe("who may call the operator's Worker", () => {
  it("only the bearer of the token cos set; none set, or a short one, refuses everything", async () => {
    expect((await call({ action: "health" }, {}, "wrong")).status).toBe(401);
    expect((await call({ action: "health" }, { COS_OPERATOR_TOKEN: undefined })).status).toBe(401);
    expect(
      (await call({ action: "health" }, { COS_OPERATOR_TOKEN: "short" }, "short")).status,
    ).toBe(401);
    expect(await call({ action: "health" })).toEqual({
      status: 200,
      body: { ok: true, environment: "live" },
    });
  });

  it("touches only a client of this deployment's environment, by a checked id", async () => {
    expect((await call({ action: "level", client: "nobody-here" })).status).toBe(404);
    expect((await call({ action: "level", client: "op-stage" })).status).toBe(404);
    expect((await call({ action: "level", client: "../x" })).status).toBe(400);
    expect(
      (await call({ action: "level", client: "op-stage" }, { COS_HOST_ENVIRONMENT: "staging" }))
        .status,
    ).toBe(200);
  });
});

describe("a client's database through the operator", () => {
  it("is migrated with a report, read only by a statement that provably reads", async () => {
    const report = await call({
      action: "migrate",
      client: "op-one",
      migrations: real.TEST_MIGRATIONS,
    });
    expect(report.status).toBe(200);
    expect((report.body as { failed: unknown }).failed).toBeNull();
    const level = await call({ action: "level", client: "op-one" });
    expect(level.body.schemaVersion).toBe(CORE_SCHEMA_VERSION);
    expect(
      (await call({ action: "query", client: "op-one", sql: "DELETE FROM core_settings" })).status,
    ).toBe(400);
    const read = await call({
      action: "query",
      client: "op-one",
      sql: "SELECT count(*) AS n FROM core_migrations",
    });
    expect((read.body.results as { n: number }[])[0]?.n).toBe(real.TEST_MIGRATIONS.length);
    expect((await call({ action: "bookmark", client: "op-one" })).status).toBe(200);
  });
});

describe("export, import and remove through the operator", () => {
  it("exports a client's database and files into the exports bucket, and imports them into another client", async () => {
    // Something of op-one's own: a setting row, two files, a key, two vectors.
    await call({ action: "migrate", client: "op-one", migrations: real.TEST_MIGRATIONS });
    const write = await real.CLIENT_DB.get(real.CLIENT_DB.idFromName("op-one")).query(
      [
        {
          sql: "INSERT INTO core_settings (key, value, updated_at) VALUES ('op_probe', '\"one\"', '2026-11-27')",
          params: [],
        },
      ],
      crypto.randomUUID(),
    );
    expect(write).toBeTruthy();
    expect((await raw("/files/op-one/media/a.txt", { method: "PUT", body: "file a" })).status).toBe(
      200,
    );
    expect((await raw("/files/op-one/media/b.txt", { method: "PUT", body: "file b" })).status).toBe(
      200,
    );
    expect(
      (await raw("/files/op-two/media/b.txt", { method: "PUT", body: "two's b" })).status,
    ).toBe(200);
    expect(
      (await raw("/files/op-one/media%2F..%2F..%2Fop-two%2Fmedia%2Fb.txt", { method: "GET" }))
        .status,
    ).toBe(400);
    expect(await real.BLOBS.get("clients/op-one/media/a.txt")).not.toBeNull();

    const record = await readClient(real.REGISTRY, "op-one" as ClientId);
    const exportKey = `op-one/${record?.secretGeneration}/20261127T010203Z`;
    // Another client's key is refused.
    expect(
      (await call({ action: "export-db-part", client: "op-two", exportKey, cursor: null })).status,
    ).toBe(400);
    let cursor: unknown = null;
    const paths: string[] = [];
    let counts: Record<string, number> | undefined;
    do {
      const step = await call({ action: "export-db-part", client: "op-one", exportKey, cursor });
      expect(step.status).toBe(200);
      paths.push(step.body.path as string);
      counts = (step.body.counts as Record<string, number> | undefined) ?? counts;
      cursor = step.body.next;
    } while (cursor);
    expect(counts?.core_settings).toBeGreaterThan(0);
    const files = await call({ action: "export-files-page", client: "op-one", exportKey });
    expect((files.body.files as { key: string }[]).map((f) => f.key).sort()).toEqual([
      "media/a.txt",
      "media/b.txt",
    ]);
    const listed = await call({ action: "export-list", client: "op-one", exportKey });
    expect((listed.body.keys as { path: string }[]).length).toBe(paths.length + 2);
    const downloaded = await raw(`/exports/${exportKey}/files/media/a.txt`);
    expect(await downloaded.text()).toBe("file a");

    // Into a new, empty client's database: every part, then verified.
    let done = false;
    for (const path of paths) {
      const part = JSON.parse(
        await ((await real.EXPORTS.get(path)) as R2ObjectBody).text(),
      ) as ExportPart;
      const step = await call({
        action: "import-db-part",
        client: "op-two",
        part,
        migrations: real.TEST_MIGRATIONS,
      });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      done = Boolean(step.body.done);
    }
    expect(done).toBe(true);
    const probe = await call({
      action: "query",
      client: "op-two",
      sql: "SELECT value FROM core_settings WHERE key = 'op_probe'",
    });
    expect(probe.body.results).toEqual([{ value: '"one"' }]);
  });

  it("opens a leaving client's secrets for it alone", async () => {
    const secrets = await call({ action: "secrets-export", client: "op-one" });
    expect(Object.keys(secrets.body.derived as object)).toContain("BETTER_AUTH_SECRET");
    const other = await call({ action: "secrets-export", client: "op-two" });
    expect((other.body.derived as Record<string, string>).BETTER_AUTH_SECRET).not.toBe(
      (secrets.body.derived as Record<string, string>).BETTER_AUTH_SECRET,
    );
  });

  it("deletes one client's database, files, keys and vectors, and nothing of another's", async () => {
    await real.OAUTH_KV.put("clients/op-one/grant:1", "g");
    await real.OAUTH_KV.put("clients/op-two/grant:1", "g");
    expect((await call({ action: "erase-db", client: "op-one" })).body).toEqual({ ok: true });
    expect((await call({ action: "level", client: "op-one" })).body.applied).toBe(0);
    expect((await call({ action: "level", client: "op-two" })).body.schemaVersion).toBe(
      CORE_SCHEMA_VERSION,
    );
    expect((await call({ action: "files-delete-page", client: "op-one" })).body).toEqual({
      deleted: 2,
      more: false,
    });
    expect(await real.BLOBS.get("clients/op-two/media/b.txt")).not.toBeNull();
    expect((await call({ action: "kv-delete-page", client: "op-one" })).body.deleted).toBe(1);
    expect(await real.OAUTH_KV.get("clients/op-two/grant:1")).toBe("g");
    expect((await call({ action: "vectors-delete-page", client: "op-one" })).body).toEqual({
      deleted: 2,
      more: true,
    });
    expect((await call({ action: "vectors-delete-page", client: "op-one" })).body).toEqual({
      deleted: 0,
      more: false,
    });
    expect([...index.vectors.keys()]).toEqual(["c:b1"]);
  });
});
