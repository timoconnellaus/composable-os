// Stage 52 step 1, the review of PR #337 (ADR 0790's amendment): an earlier first month set while
// the first close is in flight never opens months behind a closed one. Every clock injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, periodBook } from "../src/finance/close.ts";
import { rangeOf } from "../src/finance/periods.ts";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";

const call = <T>(name: string, input: unknown, user: ActingUser, now: string) =>
  invokeByName(name, input, context(user, { clock: () => new Date(now) })) as Promise<T>;

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

describe("the first month and the first close at once", () => {
  let admin: ActingUser;
  const april = "2030-04-02T00:00:00.000Z";

  beforeAll(async () => {
    admin = await createUser("admin");
    await setSetting("org_timezone", "UTC");
    await setSetting("finance_installed_at", "2030-03-10T00:00:00.000Z");
  });

  it("a first close committed after the settings changed still fixes its own month as the first", async () => {
    const range = await rangeOf(db.query, "2030-03", "UTC");
    const ctx = { db: db.query, now: april } as never;
    const plan = await closePlan(ctx, {
      id: newId("financePeriod"),
      month: "2030-03",
      range,
      version: 1,
      by: admin.id,
      book: await periodBook(ctx, range),
      guardValues: [],
    });
    await call("finance.settings.update", { firstPeriod: "2030-01" }, admin, april);
    await db.batch(plan.statements);
    const out = await call<{ firstMonth: string; periods: { month: string; closable: boolean }[] }>(
      "finance.periods",
      {},
      admin,
      april,
    );
    expect(out.firstMonth).toBe("2030-03");
    expect(out.periods.some((p) => p.month < "2030-03")).toBe(false);
    const jan = await env.DB.prepare(
      "INSERT INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES ('fip_jan', '2030-01', '2030-01-01', '2030-01-31', 'UTC', 1, 2, 1, 'closing', 'x', 'x', 0, 0, 0)",
    )
      .run()
      .catch((e: unknown) => String(e));
    expect(String(jan)).toMatch(/core_finance_period_order/);
  });
});
