// Enforces the core naming convention: every table a core migration creates is `core_*`, and every
// view is `core_*` or a `rec_*` read view (ADR 0015 amendment). SQLite and D1 internals are the
// only exceptions.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyMigrations, CORE_TABLE_PREFIX, RECORD_VIEW_PREFIX } from "../src/index.ts";

const INTERNAL = /^(sqlite_|_cf_|d1_)/;

it("every table created by core migrations starts with core_ (views may be rec_)", async () => {
  await applyMigrations(env.DB, env.TEST_MIGRATIONS);
  const { results } = await env.DB.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')",
  ).all<{ name: string; type: string }>();

  const offenders = results
    .filter(
      (row) =>
        !INTERNAL.test(row.name) &&
        !row.name.startsWith(CORE_TABLE_PREFIX) &&
        !(row.type === "view" && row.name.startsWith(RECORD_VIEW_PREFIX)),
    )
    .map((row) => row.name);
  expect(offenders, `core tables must be prefixed ${CORE_TABLE_PREFIX}`).toEqual([]);
});

it("core migrations never mention extension (x_) tables", () => {
  for (const migration of env.TEST_MIGRATIONS) {
    for (const query of migration.queries) {
      expect(query, migration.name).not.toMatch(/\bx_[a-z0-9_]+/i);
    }
  }
});

it("after migrations every read view is rec_<object>, and none keeps the old prefix (stage 20)", async () => {
  await applyMigrations(env.DB, env.TEST_MIGRATIONS);
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
  ).all<{ name: string }>();
  const views = results
    .map((row) => row.name)
    .filter((name) => !name.startsWith(CORE_TABLE_PREFIX));
  expect(views).toEqual([
    "rec_activity",
    "rec_activity_link",
    "rec_affiliation",
    // Stage 32b (migration 0533): allowances, their periods and uses.
    "rec_allowance",
    "rec_allowance_period",
    "rec_allowance_use",
    "rec_capacity",
    "rec_capacity_claim",
    // Stage 64 (migration 1390): the locations.
    "rec_location",
    // Stage 28 (migration 0461): the media library.
    "rec_media",
    "rec_order",
    // Stage 34 (migration 0950): money off orders, for reports.
    "rec_order_adjustment",
    "rec_order_line",
    // Stage 34 (migration 0952): payments by method, for reports.
    "rec_order_payment",
    "rec_order_refund",
    "rec_organisation",
    "rec_person",
    "rec_publish_version",
    "rec_record_tag",
    "rec_stage_history",
    "rec_state_history",
    // Stage 37 (migration 0930): the stock ledger.
    "rec_stock_movement",
    "rec_subscription",
    // Stage 32b (migration 0630): plan changes and pauses asked of the provider.
    "rec_subscription_change",
    "rec_task",
    "rec_task_link",
    "rec_user",
  ]);
  // Every one of them reads: a view over a dropped or renamed table would fail here.
  for (const view of views) {
    await env.DB.prepare(`SELECT * FROM ${view} LIMIT 1`).all();
  }
});
