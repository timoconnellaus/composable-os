// Stage 52 step 1, the review of PR #337 (ADR 0790's amendment): months close and reopen in order
// for every writer, not only in the handlers' reads. A close and a reopen racing each other, either
// way round; two reopens at once; a reopen's reason erased with its person. Every clock injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, periodBook } from "../src/finance/close.ts";
import { rangeOf } from "../src/finance/periods.ts";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";

const call = <T>(name: string, input: unknown, user: ActingUser, now: string) =>
  invokeByName(name, input, context(user, { clock: () => new Date(now) })) as Promise<T>;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

const latest = async (month: string) =>
  (await env.DB.prepare(
    "SELECT state, version FROM core_finance_period WHERE month = ? ORDER BY version DESC LIMIT 1",
  )
    .bind(month)
    .first<{ state: string; version: number }>()) ?? null;

const JUNE = "2033-06-02T00:00:00.000Z";

describe("months close and reopen in order, for every writer", () => {
  let admin: ActingUser;

  beforeAll(async () => {
    admin = await createUser("admin");
    await setSetting("org_timezone", "UTC");
    await setSetting("finance_installed_at", "2033-04-10T00:00:00.000Z");
    await call("finance.close", { month: "2033-04" }, admin, "2033-05-02T00:00:00.000Z");
  });

  it("a close planned before the month before was reopened fails whole when it commits after", async () => {
    // May's close reads April closed and plans its batch; April is reopened; May's batch commits.
    const range = await rangeOf(db.query, "2033-05", "UTC");
    const ctx = { db: db.query, now: JUNE } as never;
    const plan = await closePlan(ctx, {
      id: newId("financePeriod"),
      month: "2033-05",
      range,
      version: 1,
      by: admin.id,
      book: await periodBook(ctx, range),
      guardValues: [],
    });
    await call("finance.reopen", { month: "2033-04", reason: "Recheck" }, admin, JUNE);
    await expect(db.batch(plan.statements)).rejects.toThrow(/core_finance_period_order/);
    expect(await latest("2033-05")).toBeNull();
    expect(await latest("2033-04")).toEqual({ state: "reopened", version: 1 });
    await call("finance.close", { month: "2033-04" }, admin, JUNE);
  });

  it("a reopen planned before a later month closed fails whole when it commits after", async () => {
    // The reopen read no later month closed; May is closed; the reopen's write arrives.
    await call("finance.close", { month: "2033-05" }, admin, JUNE);
    await expect(
      env.DB.prepare(
        "UPDATE core_finance_period SET state = 'reopened', reopened_by = ?, reopened_at = 'now', reopen_reason = 'x' WHERE month = '2033-04' AND state = 'closed'",
      )
        .bind(admin.id)
        .run(),
    ).rejects.toThrow(/core_finance_period_order/);
    // And a month is not closed while a later one is.
    await call("finance.reopen", { month: "2033-05", reason: "x" }, admin, JUNE);
    await call("finance.reopen", { month: "2033-04", reason: "x" }, admin, JUNE);
    await call("finance.close", { month: "2033-04" }, admin, JUNE);
    await call("finance.close", { month: "2033-05" }, admin, JUNE);
    await expect(
      env.DB.prepare(
        "INSERT INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES ('fip_z', '2033-04', '2033-04-01', '2033-04-30', 'UTC', 1, 2, 9, 'closing', 'x', 'x', 0, 0, 0)",
      ).run(),
    ).rejects.toThrow(/core_finance_period_(order|held)/);
  });

  it("a close and a reopen fired at once never leave a later month closed over a reopened one", async () => {
    await call("finance.reopen", { month: "2033-05", reason: "x" }, admin, JUNE);
    const july = "2033-07-02T00:00:00.000Z";
    await call("finance.close", { month: "2033-05" }, admin, july);
    const [closed, reopened] = await Promise.allSettled([
      call("finance.close", { month: "2033-06" }, admin, july),
      call("finance.reopen", { month: "2033-05", reason: "race" }, admin, july),
    ]);
    const may = await latest("2033-05");
    const june = await latest("2033-06");
    expect(may?.state === "reopened" && june?.state === "closed").toBe(false);
    expect([closed.status, reopened.status]).toContain("fulfilled");
  });

  it("two reopens at once: one reopens, the other is told the month is not closed", async () => {
    const aug = "2033-08-02T00:00:00.000Z";
    if ((await latest("2033-06"))?.state === "closed") {
      await call("finance.reopen", { month: "2033-06", reason: "x" }, admin, aug);
    }
    if ((await latest("2033-05"))?.state !== "closed") {
      await call("finance.close", { month: "2033-05" }, admin, aug);
    }
    const results = await Promise.allSettled([
      call("finance.reopen", { month: "2033-05", reason: "first" }, admin, aug),
      call("finance.reopen", { month: "2033-05", reason: "second" }, admin, aug),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as { details?: { rule?: string } }).details?.rule).toBe(
      "finance_period_not_closed",
    );
    // The fixed-order case: the second's batch arrives after the first's committed.
    await call("finance.close", { month: "2033-05" }, admin, aug);
    const plan = await refusal(
      Promise.all([call("finance.reopen", { month: "2033-05", reason: "a" }, admin, aug)]).then(
        () => call("finance.reopen", { month: "2033-05", reason: "b" }, admin, aug),
      ),
    );
    expect(plan.details?.rule).toBe("finance_period_not_closed");
  });

  it("a reopen's reason is erased with the person it names; nothing else of the version changes", async () => {
    const aug = "2033-08-03T00:00:00.000Z";
    const person = await call<{ id: string }>(
      "person.create",
      {
        givenName: "Quill",
        familyName: "Example",
        emails: [{ email: "quill.example@buyers.example" }],
      },
      admin,
      aug,
    );
    await call("finance.close", { month: "2033-05" }, admin, aug);
    await call(
      "finance.reopen",
      { month: "2033-05", reason: "Refund for quill.example@buyers.example" },
      admin,
      aug,
    );
    // Only the reason, and only to the erased mark.
    await expect(
      env.DB.prepare(
        "UPDATE core_finance_period SET reopen_reason = 'Something else' WHERE month = '2033-05' AND state = 'reopened'",
      ).run(),
    ).rejects.toThrow(/core_finance_period_fixed/);
    await expect(
      env.DB.prepare(
        "UPDATE core_finance_period SET reopen_reason = '[erased]', zone = 'Europe/London' WHERE month = '2033-05' AND state = 'reopened'",
      ).run(),
    ).rejects.toThrow(/core_finance_period_fixed/);
    await call("person.erase", { id: person.id }, admin, aug);
    const reasons = await env.DB.prepare(
      "SELECT reopen_reason FROM core_finance_period WHERE month = '2033-05' AND state = 'reopened' ORDER BY version",
    ).all<{ reopen_reason: string }>();
    expect(reasons.results.at(-1)?.reopen_reason).toBe("[erased]");
    for (const r of reasons.results) expect(r.reopen_reason).not.toContain("quill.example");
  });
});
