// A database's views made again from the host's own definitions (stage 66 step 7, review of #526
// N3): what an import runs, since no view's text is taken from an export; and the imported
// extension state checked before any view is built from it (review of #530, R3).
import { env } from "cloudflare:workers";
import { applyMigrations } from "@composable-os/db";
import { beforeEach, describe, expect, it } from "vitest";
import { ImportedStateRefused, rebuildRecordViews } from "../src/extensions/record-views.ts";

const db = env.DB;
const views = async () =>
  (
    await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all<{
      name: string;
      sql: string;
    }>()
  ).results;
const tableCount = async () =>
  Number(
    (
      await db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .first<{ n: number }>()
    )?.n ?? 0,
  );

const now = "2026-11-28T00:00:00Z";
const object = (name: string, extension: string, local: string, table: string, definition = {}) =>
  db
    .prepare(
      "INSERT INTO core_extension_objects (name, extension_id, local_name, table_name, status, definition, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    )
    .bind(name, extension, local, table, JSON.stringify(definition), now, now);
const field = (
  extension: string,
  on: string,
  local: string,
  table: string,
  column: string | null,
  definition: Record<string, unknown> = {},
) =>
  db
    .prepare(
      "INSERT INTO core_extension_fields (extension_id, object, local_name, name, table_name, column_name, type, definition, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'text', ?, 'active', ?, ?)",
    )
    .bind(
      extension,
      on,
      local,
      local,
      table,
      column,
      JSON.stringify({ type: "text", ...definition }),
      now,
      now,
    );

// Each refusal empties the database: every test starts from the host's migrations again.
beforeEach(async () => {
  if ((await tableCount()) < 5) await applyMigrations(db, env.TEST_MIGRATIONS);
});

describe("rebuildRecordViews", () => {
  it("drops every view, makes the core ones given, then every record view from the extensions' state", async () => {
    const before = await views();
    expect(before.find((v) => v.name === "rec_person")).toBeTruthy();
    // The host's own definitions, as an import takes them from its migrations.
    const coreViews = before;
    // An imported database's own views: a replaced record view, and two of its own.
    await db.batch([
      db.prepare("DROP VIEW rec_person"),
      db.prepare("CREATE VIEW rec_person AS SELECT 'replaced' AS id"),
      db.prepare("CREATE VIEW rec_other AS SELECT * FROM core_settings"),
      db.prepare("CREATE VIEW x_v AS SELECT * FROM core_settings"),
    ]);
    const made = await rebuildRecordViews(db, coreViews);
    const after = await views();
    expect(after.map((v) => v.name)).not.toContain("rec_other");
    expect(after.map((v) => v.name)).not.toContain("x_v");
    expect(after.find((v) => v.name === "rec_person")?.sql).not.toContain("replaced");
    expect(after.map((v) => v.name)).toEqual(before.map((v) => v.name));
    expect(made.views).toBe(before.length);
  });

  it("builds record views from imported state that is the reconciler's shape", async () => {
    const coreViews = await views();
    await db.batch([
      db.prepare(
        "CREATE TABLE x_shop_item (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, deleted_at TEXT, deleted_by TEXT, title TEXT)",
      ),
      object("shop.item", "shop", "item", "x_shop_item"),
      field("shop", "shop.item", "title", "x_shop_item", "title"),
    ]);
    await rebuildRecordViews(db, coreViews);
    expect((await views()).map((v) => v.name)).toContain("rec_x_shop_item");
    await db.batch([
      db.prepare("DELETE FROM core_extension_fields"),
      db.prepare("DELETE FROM core_extension_objects"),
      db.prepare("DROP VIEW IF EXISTS rec_x_shop_item"),
      db.prepare("DROP TABLE x_shop_item"),
    ]);
  });

  // The reviewer's three probes (review of #530, R3): imported rows aiming a view at core tables.
  const probes: [string, (() => D1PreparedStatement)[]][] = [
    [
      "an object over core_person with a field on display_name",
      [
        () => object("evil.thing", "evil", "thing", "core_person"),
        () => field("evil", "evil.thing", "name", "core_person", "display_name"),
      ],
    ],
    [
      "an object over core_session with a field on token",
      [
        () => object("evil.sess", "evil", "sess", "core_session"),
        () => field("evil", "evil.sess", "token", "core_session", "token"),
      ],
    ],
    [
      "a publishable object over core_session",
      [
        () => object("evil.sess", "evil", "sess", "core_session", { publishable: true }),
        () => field("evil", "evil.sess", "token", "core_session", "token"),
      ],
    ],
    [
      "a legitimate object with a field read from a core table",
      [
        () => db.prepare("CREATE TABLE x_ok_thing (id TEXT PRIMARY KEY NOT NULL, deleted_at TEXT)"),
        () => object("ok.thing", "ok", "thing", "x_ok_thing"),
        () => field("ok", "ok.thing", "token", "core_session", "token"),
      ],
    ],
    [
      "a field on a column its table does not have",
      [
        () => db.prepare("CREATE TABLE x_ok_thing (id TEXT PRIMARY KEY NOT NULL, deleted_at TEXT)"),
        () => object("ok.thing", "ok", "thing", "x_ok_thing"),
        () => field("ok", "ok.thing", "token", "x_ok_thing", "token"),
      ],
    ],
    [
      "a relation to an object the import does not have",
      [
        () =>
          db.prepare(
            "CREATE TABLE x_ok_thing (id TEXT PRIMARY KEY NOT NULL, deleted_at TEXT, other TEXT)",
          ),
        () => object("ok.thing", "ok", "thing", "x_ok_thing"),
        () => field("ok", "ok.thing", "other", "x_ok_thing", "other", { to: "evil.sess" }),
      ],
    ],
  ];
  for (const [what, rows] of probes) {
    it(`refuses, and empties the database, imported state with ${what}`, async () => {
      const coreViews = await views();
      await db.batch(rows.map((row) => row()));
      const error = await rebuildRecordViews(db, coreViews).catch((e) => e);
      expect(error).toBeInstanceOf(ImportedStateRefused);
      expect(String(error)).toMatch(/refused and the database emptied/);
      const left = await db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'core\\_%' ESCAPE '\\' OR name LIKE 'x\\_%' ESCAPE '\\'",
        )
        .first<{ n: number }>();
      expect(Number(left?.n)).toBe(0);
    });
  }
});
