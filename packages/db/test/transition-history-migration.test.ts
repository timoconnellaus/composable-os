// Migration 0420 (stage 25, ADR 0425): `core_stage_history` becomes `core_transition_history`, the
// transition engine's one history table. Every row that was in it survives with its id and values
// (under the new column names `position_id` and `position_type`), and
// `rec_stage_history` returns what it returned before. Its own file: it starts from an empty
// database and stops before 0420 to put rows in the old table.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyMigrations, migrationNumber } from "../src/index.ts";

const COLUMNS =
  "id, object_type, record_id, stage_id, group_id, stage_type, entered_at, left_at, entered_by";

/** The same columns of the renamed table, under the names they had. */
const RENAMED = COLUMNS.replace("stage_id", "position_id AS stage_id").replace(
  "stage_type",
  "position_type AS stage_type",
);

async function all(sql: string) {
  return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
}

it("keeps every stage history row and what rec_stage_history returns for it", async () => {
  const before0420 = env.TEST_MIGRATIONS.filter((m) => (migrationNumber(m.name) ?? 0) < 420);
  // Everything before 0420 and nothing from it on (later stages add migrations after it).
  expect(env.TEST_MIGRATIONS.some((m) => migrationNumber(m.name) === 420)).toBe(true);
  expect(before0420.every((m) => (migrationNumber(m.name) ?? 0) < 420)).toBe(true);
  await applyMigrations(env.DB, before0420);

  // 300 rows over 100 records: closed and current, every stage type, with and without a group
  // and a user.
  const types = ["open", "won", "lost"] as const;
  const statements = [];
  for (let record = 0; record < 100; record++) {
    for (let step = 0; step < 3; step++) {
      const n = record * 3 + step;
      const entered = new Date(Date.UTC(2026, 0, 1 + record, step * 5, n % 60)).toISOString();
      const left =
        step < 2 ? new Date(Date.UTC(2026, 0, 2 + record, step * 7, n % 60)).toISOString() : null;
      statements.push(
        env.DB.prepare(
          `INSERT INTO core_stage_history (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `sth_${String(n).padStart(6, "0")}`,
          record % 2 ? "deals.deal" : "other.thing",
          `rec_${record}`,
          `stage_${n % 7}`,
          record % 3 ? `group_${record % 4}` : null,
          step < 2 ? "open" : types[record % 3],
          entered,
          left,
          record % 5 ? `usr_${record % 6}` : null,
        ),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));

  const tableBefore = await all(`SELECT ${COLUMNS} FROM core_stage_history ORDER BY id`);
  // Closed rows only for days_in_stage: a current row's runs to the time of the query.
  const viewSql =
    "SELECT id, object_type, record_id, stage_id, group_id, stage_type, entered_at, left_at, is_current, CASE WHEN left_at IS NULL THEN NULL ELSE days_in_stage END AS days_in_stage, entered_by FROM rec_stage_history ORDER BY id";
  const viewBefore = await all(viewSql);
  const viewColumns = await all("SELECT name FROM pragma_table_xinfo('rec_stage_history')");
  expect(tableBefore).toHaveLength(300);

  const through0420 = env.TEST_MIGRATIONS.filter((m) => (migrationNumber(m.name) ?? 0) <= 420);
  expect(await applyMigrations(env.DB, through0420)).toEqual(["0420_transition_history.sql"]);

  expect(await all(`SELECT ${RENAMED} FROM core_transition_history ORDER BY id`)).toEqual(
    tableBefore,
  );
  // The old table is gone, not left beside the new one.
  expect(await all("SELECT name FROM sqlite_master WHERE name = 'core_stage_history'")).toEqual([]);
  expect(await all(viewSql)).toEqual(viewBefore);
  expect(await all("SELECT name FROM pragma_table_xinfo('rec_stage_history')")).toEqual(
    viewColumns,
  );
  // Every old row is a stage row made by staff.
  expect(
    await all("SELECT form, entered_as, count(*) AS n FROM core_transition_history GROUP BY 1, 2"),
  ).toEqual([{ form: "stages", entered_as: "staff", n: 300 }]);
  expect(await all("SELECT count(*) AS n FROM rec_state_history")).toEqual([{ n: 0 }]);
  expect(
    (
      await all(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'core_transition_history' AND type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((row) => row.name),
  ).toEqual([
    "core_transition_history_current_idx",
    "core_transition_history_position_idx",
    "core_transition_history_record_idx",
  ]);
});

it("takes state rows beside stage rows, each in its own view", async () => {
  await applyMigrations(env.DB, env.TEST_MIGRATIONS);
  const insert = (id: string, form: string, type: string, as: string, left: string | null) =>
    env.DB.prepare(
      "INSERT INTO core_transition_history (id, object_type, record_id, form, position_id, position_type, entered_at, left_at, entered_as) VALUES (?, 'shop.order', 'rec_order', ?, ?, ?, '2026-11-01T00:00:00.000Z', ?, ?)",
    )
      .bind(id, form, id, type, left, as)
      .run();
  await insert("pending", "states", "open", "staff", "2026-11-02T00:00:00.000Z");
  await insert("paid", "states", "final", "host", null);
  expect(
    await all(
      "SELECT state, is_final, is_current, entered_as, CASE WHEN left_at IS NULL THEN NULL ELSE days_in_state END AS days_in_state FROM rec_state_history ORDER BY entered_at, is_current",
    ),
  ).toEqual([
    { state: "pending", is_final: 0, is_current: 0, entered_as: "staff", days_in_state: 1 },
    { state: "paid", is_final: 1, is_current: 1, entered_as: "host", days_in_state: null },
  ]);
  expect(
    await all("SELECT count(*) AS n FROM rec_stage_history WHERE object_type = 'shop.order'"),
  ).toEqual([{ n: 0 }]);
  // A stage row cannot be final, a state row cannot be won, and nobody else makes a move.
  await expect(
    insert("x1", "stages", "final", "staff", "2026-11-03T00:00:00.000Z"),
  ).rejects.toThrow();
  await expect(
    insert("x2", "states", "won", "staff", "2026-11-03T00:00:00.000Z"),
  ).rejects.toThrow();
  await expect(
    insert("x3", "states", "open", "extension", "2026-11-03T00:00:00.000Z"),
  ).rejects.toThrow();
  // One current row per record.
  await expect(insert("x4", "states", "open", "staff", null)).rejects.toThrow();
});
