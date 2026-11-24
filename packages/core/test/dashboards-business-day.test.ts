// Dashboards in the business's day (stage 60 step 1, ADR 0871, issue #306): date windows, `:today`
// and the result cache follow the organisation's time zone, across midnight and a change of
// clocks, on real D1.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  invoke,
  localDay,
  memoryWidgetCache,
  previousWindow,
  resolveDateWindow,
  resolveParams,
  type WidgetSpecInput,
  widgetCacheKey,
} from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

const HOUR = 3_600_000;
const hours = (w: { from: string; to: string }) => (Date.parse(w.to) - Date.parse(w.from)) / HOUR;

// 07:30 on Sunday 15 June 2031 in Brisbane (UTC+10 all year): still 14 June in UTC.
const MORNING = new Date("2031-06-14T21:30:00.000Z");
const BRISBANE = "Australia/Brisbane";

describe("localDay", () => {
  it("is the local date's midnight to the next, ten hours ahead of UTC", () => {
    expect(localDay(MORNING, BRISBANE)).toEqual({
      date: "2031-06-15",
      from: "2031-06-14T14:00:00.000Z",
      to: "2031-06-15T14:00:00.000Z",
    });
    expect(localDay(MORNING, BRISBANE, -1).date).toBe("2031-06-14");
    expect(localDay(MORNING, BRISBANE, -7).from).toBe("2031-06-07T14:00:00.000Z");
    expect(localDay(MORNING, "UTC").date).toBe("2031-06-14");
  });

  it("turns at local midnight, not UTC midnight", () => {
    expect(localDay(Date.parse("2031-06-14T13:59:59.999Z"), BRISBANE).date).toBe("2031-06-14");
    expect(localDay(Date.parse("2031-06-14T14:00:00.000Z"), BRISBANE).date).toBe("2031-06-15");
    // West of UTC: 20:00 on 14 June in New York is already 15 June in UTC.
    expect(localDay(Date.parse("2031-06-15T00:00:00.000Z"), "America/New_York").date).toBe(
      "2031-06-14",
    );
  });

  it("is 23 or 25 hours across a change of clocks", () => {
    // Sydney: clocks go forward on 4 October 2026 and back on 5 April 2026.
    const forward = localDay(Date.parse("2026-10-04T02:00:00.000Z"), "Australia/Sydney");
    expect(forward).toEqual({
      date: "2026-10-04",
      from: "2026-10-03T14:00:00.000Z",
      to: "2026-10-04T13:00:00.000Z",
    });
    expect(hours(forward)).toBe(23);
    const back = localDay(Date.parse("2026-04-05T02:00:00.000Z"), "Australia/Sydney");
    expect(hours(back)).toBe(25);
    // London: forward on 29 March 2026.
    expect(hours(localDay(Date.parse("2026-03-29T12:00:00.000Z"), "Europe/London"))).toBe(23);
    // Santiago skips midnight on 6 September 2026: the day starts at 01:00, its first instant.
    expect(localDay(Date.parse("2026-09-06T12:00:00.000Z"), "America/Santiago")).toEqual({
      date: "2026-09-06",
      from: "2026-09-06T04:00:00.000Z",
      to: "2026-09-07T03:00:00.000Z",
    });
  });
});

describe("date windows in the business's zone", () => {
  it("resolves every preset from local midnights", () => {
    const at = (preset: Parameters<typeof resolveDateWindow>[0]) =>
      resolveDateWindow(preset, MORNING, BRISBANE);
    expect(at("today")).toEqual({
      from: "2031-06-14T14:00:00.000Z",
      to: "2031-06-15T14:00:00.000Z",
    });
    expect(at("last_7_days")).toEqual({
      from: "2031-06-08T14:00:00.000Z",
      to: "2031-06-15T14:00:00.000Z",
    });
    expect(at("this_month")).toEqual({
      from: "2031-05-31T14:00:00.000Z",
      to: "2031-06-30T14:00:00.000Z",
    });
    expect(at("last_month")).toEqual({
      from: "2031-04-30T14:00:00.000Z",
      to: "2031-05-31T14:00:00.000Z",
    });
    expect(at("this_quarter")).toEqual({
      from: "2031-03-31T14:00:00.000Z",
      to: "2031-06-30T14:00:00.000Z",
    });
    expect(at("this_year")).toEqual({
      from: "2030-12-31T14:00:00.000Z",
      to: "2031-12-31T14:00:00.000Z",
    });
    expect(at({ from: "2031-06-01", to: "2031-06-02" })).toEqual({
      from: "2031-05-31T14:00:00.000Z",
      to: "2031-06-02T14:00:00.000Z",
    });
    // Without a zone the windows are UTC's, as before.
    expect(resolveDateWindow("today", MORNING)).toEqual({
      from: "2031-06-14T00:00:00.000Z",
      to: "2031-06-15T00:00:00.000Z",
    });
  });

  it("rolls a year over at the local new year", () => {
    const newYear = new Date("2031-12-31T15:00:00.000Z"); // 01:00 on 1 January 2032 in Brisbane
    expect(resolveDateWindow("this_year", newYear, BRISBANE)?.from).toBe(
      "2031-12-31T14:00:00.000Z",
    );
    expect(resolveDateWindow("last_month", newYear, BRISBANE)).toEqual({
      from: "2031-11-30T14:00:00.000Z",
      to: "2031-12-31T14:00:00.000Z",
    });
  });

  it("steps back whole local days and calendar units across a change of clocks", () => {
    const sydney = "Australia/Sydney";
    const monday = new Date("2026-10-04T23:00:00.000Z"); // 10:00 on 5 October, after the change
    const today = resolveDateWindow("today", monday, sydney);
    expect(today && hours(today)).toBe(24);
    const yesterday = today && previousWindow("today", today, sydney);
    expect(yesterday).toEqual({ from: "2026-10-03T14:00:00.000Z", to: "2026-10-04T13:00:00.000Z" });
    expect(yesterday && hours(yesterday)).toBe(23);
    const week = resolveDateWindow("last_7_days", monday, sydney);
    expect(week && hours(week)).toBe(7 * 24 - 1);
    expect(week?.from).toBe("2026-09-28T14:00:00.000Z"); // 29 September to 5 October
    expect(week && previousWindow("last_7_days", week, sydney)).toEqual({
      from: "2026-09-21T14:00:00.000Z",
      to: "2026-09-28T14:00:00.000Z",
    });
    const month = resolveDateWindow("this_month", monday, sydney);
    expect(month && previousWindow("this_month", month, sydney)).toEqual({
      from: "2026-08-31T14:00:00.000Z",
      to: "2026-09-30T14:00:00.000Z",
    });
  });

  it("binds :today and the windows in the zone", () => {
    const resolved = resolveParams({
      filters: [{ type: "dateRange", id: "date", label: "Date", default: "today" }],
      values: {},
      now: MORNING,
      userId: "usr_me",
      zone: BRISBANE,
    });
    expect(resolved.values).toMatchObject({
      now: "2031-06-14T21:30:00.000Z",
      today: "2031-06-15",
      date_from: "2031-06-14T14:00:00.000Z",
      date_to: "2031-06-15T14:00:00.000Z",
    });
    expect(resolved.previous).toMatchObject({
      date_from: "2031-06-13T14:00:00.000Z",
      date_to: "2031-06-14T14:00:00.000Z",
    });
  });
});

// --- On real D1: the organisation's zone setting ----------------------------------------------

async function setZone(zone: string | null) {
  if (zone === null) {
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'org_timezone'").run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(zone), new Date().toISOString())
    .run();
}

describe("a widget with the today preset, in a zone ten hours ahead of UTC", () => {
  let owner: ActingUser;
  let before: string | null;

  beforeAll(async () => {
    const row = await env.DB.prepare(
      "SELECT value FROM core_settings WHERE key = 'org_timezone'",
    ).first<{ value: string }>();
    before = row ? (JSON.parse(row.value) as string) : null;
    owner = await createUser("member");
    for (const when of [
      "2031-06-14T13:00:00.000Z", // 23:00 on 14 June local: yesterday, though today in UTC
      "2031-06-14T15:00:00.000Z", // 01:00 on 15 June local: today
      "2031-06-14T21:00:00.000Z", // 07:00 on 15 June local: today
      "2031-06-14T22:00:00.000Z", // 08:00 local: after now, still today
      "2031-06-14T14:00:00.000Z", // local midnight exactly: today
    ]) {
      await invoke(
        "person.create",
        { displayName: unique("Day"), ownerId: owner.id },
        context(owner, { clock: () => new Date(when) }),
      );
    }
  });
  afterAll(() => setZone(before));

  const widget: WidgetSpecInput = {
    id: "joined",
    type: "kpi",
    title: "Joined",
    sql: "SELECT COUNT(*) AS value FROM rec_person WHERE owner_id = :me AND created_at >= :date_from AND created_at < :date_to",
    mapping: { value: "value" },
  };
  const run = (cache = memoryWidgetCache()) =>
    invoke(
      "widget.preview",
      {
        widget,
        dashboardFilters: [{ type: "dateRange", id: "date", label: "Date", default: "today" }],
      },
      context(owner, { clock: () => MORNING, widgetCache: cache }),
    );

  it("counts from local midnight, and compares with the local yesterday", async () => {
    await setZone(BRISBANE);
    const result = await run();
    expect(result.params).toMatchObject({
      today: "2031-06-15",
      date_from: "2031-06-14T14:00:00.000Z",
      date_to: "2031-06-15T14:00:00.000Z",
    });
    expect(Number(result.rows[0]?.value)).toBe(4);
    expect(Number(result.previous?.rows[0]?.value)).toBe(1);
  });

  it("counted the UTC day before the fix (no zone set)", async () => {
    await setZone(null);
    const result = await run();
    expect(result.params.today).toBe("2031-06-14");
    expect(Number(result.rows[0]?.value)).toBe(5);
  });

  it("never serves a result cached under another zone", async () => {
    const cache = memoryWidgetCache();
    const plain: WidgetSpecInput = {
      ...widget,
      sql: "SELECT COUNT(*) AS value FROM rec_person WHERE owner_id = :me",
    };
    const preview = () =>
      invoke(
        "widget.preview",
        { widget: plain },
        context(owner, { clock: () => MORNING, widgetCache: cache }),
      );
    await setZone(BRISBANE);
    expect((await preview()).cached).toBe(false);
    expect((await preview()).cached).toBe(true);
    await setZone("Europe/London");
    expect((await preview()).cached).toBe(false);
    const parts = { sql: "SELECT 1", params: [], maxRows: 2, scope: "role:member" };
    expect(await widgetCacheKey({ ...parts, zone: BRISBANE })).not.toBe(
      await widgetCacheKey({ ...parts, zone: "UTC" }),
    );
  });
});
