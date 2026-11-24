// Stage 52 step 1, the review of PR #337 (ADR 0790's amendment): the first month is fixed once a
// month has a version, whatever the organisation's zone does since. A month reopened before a zone
// change closes again; a month before the first never becomes closable. Every clock injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { addMonths } from "../src/finance/day.ts";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

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

type Periods = { firstMonth: string; periods: { month: string; closable: boolean }[] };

describe("the first month, once anything is closed", () => {
  let admin: ActingUser;
  const april = "2030-04-02T00:00:00.000Z";

  beforeAll(async () => {
    admin = await createUser("admin");
    // Installed at 20:00 UTC on 31 March: March in UTC, already April in Tokyo.
    await setSetting("org_timezone", "UTC");
    await setSetting("finance_installed_at", "2030-03-31T20:00:00.000Z");
  });

  it("a month reopened before a change of zone closes again, and stays the first", async () => {
    await call("finance.close", { month: "2030-03" }, admin, april);
    await call("finance.reopen", { month: "2030-03", reason: "Recheck" }, admin, april);
    await setSetting("org_timezone", "Asia/Tokyo");
    const out = await call<Periods>("finance.periods", {}, admin, april);
    expect(out.firstMonth).toBe("2030-03");
    // April is not closable over the reopened March, nor closed by any writer.
    expect(
      (
        await refusal(
          call("finance.close", { month: "2030-04" }, admin, "2030-05-02T00:00:00.000Z"),
        )
      ).details?.rule,
    ).toBe("finance_previous_open");
    expect(await call("finance.close", { month: "2030-03" }, admin, april)).toMatchObject({
      version: 2,
    });
  });

  it("a change of zone never makes a month before a closed one closable", async () => {
    // In New York the install instant is still March, but February before it never opens; and
    // nothing the settings say once a month is closed moves the first month.
    await setSetting("org_timezone", "America/New_York");
    await setSetting("finance_installed_at", "2030-03-01T03:00:00.000Z");
    const out = await call<Periods>("finance.periods", {}, admin, april);
    expect(out.firstMonth).toBe("2030-03");
    expect(out.periods.find((p) => p.month === "2030-02")).toBeUndefined();
    expect(
      (await refusal(call("finance.close", { month: "2030-02" }, admin, april))).details?.rule,
    ).toBe("finance_before_start");
    await setSetting("finance_settings", { firstPeriod: "2030-01" });
    expect((await call<Periods>("finance.periods", {}, admin, april)).firstMonth).toBe("2030-03");
    // Any writer: a version of February is refused by the table.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES ('fip_feb', '2030-02', '2030-02-01', '2030-02-28', 'UTC', 1, 2, 1, 'closing', 'x', 'x', 0, 0, 0)",
      ).run(),
    ).rejects.toThrow(/core_finance_period_order/);
    await setSetting("finance_settings", {});
  });

  it("a first month before the year 2000 is refused, and months keep four-digit years", async () => {
    expect(addMonths("1000-01", -1)).toBe("0999-12");
    expect(
      (await refusal(call("finance.settings.update", { firstPeriod: "0999-01" }, admin, april)))
        .code,
    ).toBe("invalid_input");
  });
});
