// Stage 52 step 1, the review of PR #337 (ADR 0790's amendment): a change of the first month that
// read "nothing closed" fails whole when the first close commits between its read and its batch.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, periodBook } from "../src/finance/close.ts";
import { rangeOf } from "../src/finance/periods.ts";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

describe("the first month's change and the first close, racing", () => {
  let admin: ActingUser;
  const april = "2030-04-02T00:00:00.000Z";

  beforeAll(async () => {
    admin = await createUser("admin");
    await setSetting("org_timezone", "UTC");
    await setSetting("finance_installed_at", "2030-03-10T00:00:00.000Z");
  });

  it("fails the settings change whole, and the first month stays the closed one", async () => {
    const range = await rangeOf(db.query, "2030-03", "UTC");
    const planCtx = { db: db.query, now: april } as never;
    const plan = await closePlan(planCtx, {
      id: newId("financePeriod"),
      month: "2030-03",
      range,
      version: 1,
      by: admin.id,
      book: await periodBook(planCtx, range),
      guardValues: [],
    });
    let fired = false;
    // The settings change reads that no month has a version; March's close commits right after.
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            if (!fired && query.includes("core_finance_period") && /limit/i.test(query)) {
              fired = true;
              return {
                bind: (...args: unknown[]) => ({
                  all: async () => {
                    const rows = await target
                      .prepare(query)
                      .bind(...args)
                      .all();
                    await db.batch(plan.statements);
                    return rows;
                  },
                }),
              };
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = {
      ...context(admin, { clock: () => new Date(april) }),
      db: createCrmDb(racing as D1Database),
    };
    let error: unknown;
    try {
      await invokeByName("finance.settings.update", { firstPeriod: "2030-01" }, ctx);
    } catch (e) {
      error = e;
    }
    expect(fired).toBe(true);
    expect((error as { details?: { rule?: string } }).details?.rule).toBe("finance_started");
    const stored = await env.DB.prepare(
      "SELECT value FROM core_settings WHERE key = 'finance_settings'",
    ).first<{ value: string }>();
    expect(stored?.value ?? "{}").not.toContain("2030-01");
    const out = (await invokeByName(
      "finance.periods",
      {},
      context(admin, { clock: () => new Date(april) }),
    )) as {
      firstMonth: string;
    };
    expect(out.firstMonth).toBe("2030-03");
  });
});
