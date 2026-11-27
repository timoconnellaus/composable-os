// The operator's Worker (stage 66 step 7, ADR 0618): the one way `cos` reaches clients' databases
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
import { type ExportPart, importedExtensionObjects, namesIn } from "../src/sql-export.ts";
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
    { rebuildRecordViews: coreViewsOnly },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/**
 * packages/core's `rebuildRecordViews` stands in here as its first half (the core views the
 * host's migrations make): packages/db cannot import packages/core; the record views themselves
 * are tested there (core `record-views.test.ts`).
 */
async function coreViewsOnly(db: D1Database, coreViews: { name: string; sql: string }[]) {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
    .all<{ name: string }>();
  const statements = [
    ...results.map((r) => `DROP VIEW IF EXISTS "${r.name}"`),
    ...coreViews.map((v) => v.sql),
  ];
  if (statements.length) await db.batch(statements.map((sql) => db.prepare(sql)));
  return { views: coreViews.length, formulaErrors: 0 };
}
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

describe("what an import accepts beside the core schema (review of #526, S4)", () => {
  const row = (type: string, name: string, tbl_name: string) => ({
    type,
    name,
    tbl_name,
    sql: `-- ${type} ${name}`,
  });
  it("takes an extension's tables and indexes, its triggers only when they name nothing but its tables, and no view", () => {
    const core = [
      row("table", "core_settings", "core_settings"),
      row("view", "rec_person", "rec_person"),
    ];
    const trigger = (name: string, body: string) => ({
      type: "trigger",
      name,
      tbl_name: "x_shop_item",
      sql: `CREATE TRIGGER ${name} AFTER INSERT ON x_shop_item BEGIN ${body}; END`,
    });
    const actual = [
      ...core,
      row("table", "x_shop_item", "x_shop_item"),
      row("table", "x_shop_line", "x_shop_line"),
      row("index", "x_shop_item_name", "x_shop_item"),
      trigger("x_shop_item_ai", "UPDATE x_shop_line SET n = n + 1 WHERE item = NEW.id"),
      // Each of these reaches a core table, however it is written (review of #526, N3).
      trigger("x_t1", "UPDATE core_user SET role = 'admin'"),
      trigger("x_t2", "UPDATE \"Core_User\" SET role = 'admin'"),
      trigger("x_t3", "UPDATE/*c*/[core_user] SET role = 'admin'"),
      trigger("x_t4", "INSERT INTO `CORE_SETTINGS` VALUES ('k', 'v', 'now', NULL)"),
      trigger("x_t5", "DELETE FROM rec_person"),
      // A string naming a core table is not a reference.
      trigger("x_t6", "UPDATE x_shop_line SET note = 'core_user'"),
      row("view", "rec_shop_item", "rec_shop_item"),
      row("view", "x_v", "x_v"),
      row("trigger", "x_hook", "core_settings"),
      row("index", "x_idx", "core_settings"),
      row("table", "core_settings", "core_settings"),
      row("table", "other", "other"),
    ];
    expect(importedExtensionObjects(actual, core).map((r) => `${r.type} ${r.name}`)).toEqual([
      "table x_shop_item",
      "table x_shop_line",
      "index x_shop_item_name",
      "trigger x_shop_item_ai",
      "trigger x_t6",
    ]);
    expect([
      ...namesIn('SELECT "A""b", [C d], `e` FROM t -- core_x\n /* core_y */ WHERE s = \'core_z\''),
    ]).toEqual(["select", 'a"b', "c d", "e", "from", "t", "where", "s"]);
  });

  /** An export of a client whose database also holds `extra`, imported into a new client. */
  async function importWith(src: string, dst: string, extra: string[]) {
    await newClient(src);
    await newClient(dst);
    await call({ action: "migrate", client: src, migrations: real.TEST_MIGRATIONS });
    await real.CLIENT_DB.get(real.CLIENT_DB.idFromName(src)).query(
      extra.map((sql) => ({ sql, params: [] })),
      crypto.randomUUID(),
    );
    const record = await readClient(real.REGISTRY, src as ClientId);
    const exportKey = `${src}/${record?.secretGeneration}/20261128T010203Z`;
    let cursor: unknown = null;
    const paths: string[] = [];
    do {
      const step = await call({ action: "export-db-part", client: src, exportKey, cursor });
      paths.push(step.body.path as string);
      cursor = step.body.next;
    } while (cursor);
    let refused = "";
    for (const path of paths) {
      const part = JSON.parse(await ((await real.EXPORTS.get(path)) as R2ObjectBody).text());
      const step = await call({
        action: "import-db-part",
        client: dst,
        part,
        migrations: real.TEST_MIGRATIONS,
      });
      if (step.status !== 200) refused = String(step.body.error);
    }
    return refused;
  }
  const views = async (client: string) =>
    (
      await call({
        action: "query",
        client,
        sql: "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name",
      })
    ).body.results as { name: string; sql: string }[];

  it("refuses an extension's trigger that writes a core table, and an INSTEAD OF trigger (the reviewer's probes 1 and 2)", async () => {
    const one = await importWith("op-n3-a", "op-n3-a2", [
      "CREATE TABLE x_t (id TEXT PRIMARY KEY)",
      "CREATE TRIGGER evil AFTER INSERT ON x_t BEGIN UPDATE core_settings SET value = 'x'; END",
    ]);
    expect(one).toMatch(/refused and the database emptied/);
    const two = await importWith("op-n3-b", "op-n3-b2", [
      "CREATE TABLE x_t (id TEXT PRIMARY KEY)",
      "CREATE VIEW x_v AS SELECT id FROM x_t",
      "CREATE TRIGGER x_io INSTEAD OF INSERT ON x_v BEGIN UPDATE core_settings SET value = 'x'; END",
    ]);
    expect(two).toMatch(/INSTEAD OF/);
    expect((await call({ action: "level", client: "op-n3-b2" })).body.applied).toBe(0);
  });

  it("takes no view from an export: a view over a core table, a new rec_ view and a replaced core one are made again from the host's own (probes 3 to 5)", async () => {
    const refused = await importWith("op-n3-c", "op-n3-c2", [
      "CREATE TABLE x_t (id TEXT PRIMARY KEY)",
      "CREATE VIEW x_v AS SELECT * FROM core_settings",
      "CREATE VIEW rec_other AS SELECT * FROM core_settings",
      "DROP VIEW rec_person",
      "CREATE VIEW rec_person AS SELECT 'replaced' AS id",
    ]);
    expect(refused).toBe("");
    // Before the views are made again, the import holds none of the export's.
    expect((await views("op-n3-c2")).map((v) => v.name)).toEqual([]);
    const made = await call({
      action: "rebuild-views",
      client: "op-n3-c2",
      migrations: real.TEST_MIGRATIONS,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const after = await views("op-n3-c2");
    const names = after.map((v) => v.name);
    expect(names).not.toContain("x_v");
    expect(names).not.toContain("rec_other");
    // rec_person is the host's migrations' text, not the export's.
    const reference = (await views("op-n3-c")).find((v) => v.name === "rec_person");
    expect(reference?.sql).toContain("replaced");
    expect(after.find((v) => v.name === "rec_person")?.sql).not.toContain("replaced");
    // An x_ table the export brought is in.
    const tables = await call({
      action: "query",
      client: "op-n3-c2",
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x_t'",
    });
    expect(tables.body.results).toEqual([{ name: "x_t" }]);
  });

  it("refuses, and empties the database, an export that hooks a core table with a trigger", async () => {
    await newClient("op-hook-src");
    await newClient("op-hook-dst");
    await call({ action: "migrate", client: "op-hook-src", migrations: real.TEST_MIGRATIONS });
    await real.CLIENT_DB.get(real.CLIENT_DB.idFromName("op-hook-src")).query(
      [
        {
          sql: "CREATE TRIGGER x_hook AFTER INSERT ON core_settings BEGIN SELECT 1; END",
          params: [],
        },
      ],
      crypto.randomUUID(),
    );
    const record = await readClient(real.REGISTRY, "op-hook-src" as ClientId);
    const exportKey = `op-hook-src/${record?.secretGeneration}/20261128T010203Z`;
    let cursor: unknown = null;
    const paths: string[] = [];
    do {
      const step = await call({
        action: "export-db-part",
        client: "op-hook-src",
        exportKey,
        cursor,
      });
      paths.push(step.body.path as string);
      cursor = step.body.next;
    } while (cursor);
    let refused = "";
    for (const path of paths) {
      const part = JSON.parse(await ((await real.EXPORTS.get(path)) as R2ObjectBody).text());
      const step = await call({
        action: "import-db-part",
        client: "op-hook-dst",
        part,
        migrations: real.TEST_MIGRATIONS,
      });
      if (step.status !== 200) refused = String(step.body.error);
    }
    expect(refused).toMatch(/refused and the database emptied/);
    expect((await call({ action: "level", client: "op-hook-dst" })).body.applied).toBe(0);
  });
});
