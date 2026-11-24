// The minute cron reads "events not arriving" once an hour (docs/cloudflare-costs.md): no index
// holds that read. Run hourly, it pages through its whole one-day window, so a burst of periods
// ending together (imported subscriptions sharing a billing date, a webhook outage across a
// renewal run) still tells staff about every one, not just the first page's 50.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { MISSING_EVENTS_AFTER_DAYS, newId, sweepSubscriptions } from "../src/index.ts";
import { createUser } from "./helpers.ts";

const db = createCrmDb(env.DB);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The hour the periods end in: 100 of them, 36 seconds apart. */
const ENDS = Date.parse("2026-03-02T09:00:00.000Z");

describe("events not arriving, swept hourly", () => {
  let adminId = "";
  beforeAll(async () => {
    adminId = (await createUser("admin")).id;
    const now = new Date(ENDS).toISOString();
    const insert = env.DB.prepare(
      `INSERT INTO core_subscription (id, placed_as, plan_object, plan_id, plan_title, amount, currency,
         interval, provider, provider_ref, observed_at, created_at, updated_at, state, current_period_end)
       VALUES (?, 'public', 'x_plan', 'plan_1', 'Monthly', 100, 'AUD', 'month', 'stripe', ?, ?, ?, ?, 'active', ?)`,
    );
    await env.DB.batch(
      Array.from({ length: 100 }, (_, i) => {
        const id = newId("subscription");
        return insert.bind(
          id,
          `sub_burst_${i}`,
          now,
          now,
          now,
          new Date(ENDS + i * 36_000).toISOString(),
        );
      }),
    );
  });

  it("tells staff about all 100 when swept on each whole hour", async () => {
    const from = ENDS + MISSING_EVENTS_AFTER_DAYS * DAY;
    for (let t = from; t <= from + DAY + HOUR; t += HOUR) {
      await sweepSubscriptions(db, new Date(t).toISOString());
    }
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE 'subscription.events_missing:%'",
    )
      .bind(adminId)
      .first<{ n: number }>();
    expect(told?.n).toBe(100);
  });

  it("the minute's sweep leaves the unindexed reads out", async () => {
    const at = new Date(ENDS + MISSING_EVENTS_AFTER_DAYS * DAY + 30 * 60_000).toISOString();
    expect(await sweepSubscriptions(db, at, { unindexed: false })).toEqual({
      pastDueLapsed: 0,
      eventsMissing: 0,
      offerPlansGone: 0,
    });
  });
});
