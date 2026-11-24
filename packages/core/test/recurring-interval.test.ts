// Stage 59 step 1 (ADR 0860): the interval rule in `recurring`. A plan "every 3 months on the 1st
// at 09:00" makes its maintenance ahead to its horizon, each once; "every month on the 31st" lands
// on the last day of shorter months; "every year on 1 March" makes one a year; a window given in
// days ends at the same wall-clock time across a change of clocks; one done late leaves the next on
// its date; one moved by hand is never moved back; a run costs what a weekly run of as many dates
// costs. Weekly series are recurring.test.ts's, unchanged. Every clock is injected.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type InvocationContext,
  invoke,
  invokeByName,
  occurrencesBetween,
  type RecurringDefinition,
  ruleOf,
  runRecurringDue,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("recint");
const PLAN = `${ext}.plan`;
const WORK = `${ext}.work`;
const ZONE = "Australia/Sydney";

const WEEKDAY_OPTIONS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));
const UNIT_OPTIONS = ["week", "month", "year"].map((value) => ({ value, label: value }));

const fixture = (id: string) =>
  manifest(id, {
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          unit: { type: "select", label: "Unit", options: UNIT_OPTIONS },
          every: { type: "number", label: "Every" },
          weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAY_OPTIONS },
          day: { type: "number", label: "Day of the month" },
          month: { type: "number", label: "Month" },
          time: { type: "text", label: "Time" },
          windowDays: { type: "number", label: "Window (days)" },
          from: { type: "date", label: "From" },
          until: { type: "date", label: "Until" },
          zone: { type: "timezone", label: "Time zone" },
          assignee: { type: "text", label: "Assignee" },
          status: {
            type: "select",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "ended", label: "Ended" },
            ],
          },
        },
        recurring: {
          generates: "work",
          link: "plan",
          rule: {
            unit: "unit",
            every: "every",
            weekdays: "weekdays",
            day: "day",
            month: "month",
            time: "time",
            lengthDays: "windowDays",
            from: "from",
            until: "until",
            zone: "zone",
          },
          into: { starts: "startsAt", ends: "dueBy", zone: "zone", changed: "changed" },
          copy: { assignee: "assignee" },
          cancel: "cancelled",
          ended: { field: "status", in: ["ended"] },
          horizonDays: 366,
        },
      },
      work: {
        label: "Maintenance",
        plural: "Maintenance",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          plan: { type: "relation", label: "Plan", to: `${id}.plan`, readOnly: true },
          startsAt: { type: "datetime", label: "Starts at" },
          dueBy: { type: "datetime", label: "Due by" },
          zone: { type: "timezone", label: "Time zone" },
          assignee: { type: "text", label: "Assignee" },
          changed: { type: "boolean", label: "Changed", readOnly: true },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "due", label: "Due" },
              { value: "done", label: "Done" },
              { value: "cancelled", label: "Cancelled" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "due",
          moves: [
            { from: "due", to: "done", by: ["staff"], final: true },
            { from: "due", to: "cancelled", by: ["staff", "host"], final: true },
          ],
        },
      },
    },
  });

let admin: ActingUser;
const as = (now: string) => context(admin, { clock: () => new Date(now) });

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
}, 60_000);

async function plan(values: Record<string, unknown>, now: string) {
  const created = await invoke(
    "record.create",
    {
      object: PLAN,
      values: {
        title: "Quarterly service",
        time: "09:00",
        windowDays: 7,
        zone: ZONE,
        assignee: "Keeper A",
        status: "active",
        ...values,
      },
    },
    as(now),
  );
  return created.id as string;
}

/** The minute cron at `now`, run until nothing is due. */
async function tick(now: string) {
  let made = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = await runRecurringDue(db, { clock: () => new Date(now) });
    expect(result.failed).toBe(0);
    made += result.made;
    if (result.series === 0) break;
  }
  return made;
}

interface Made {
  date: string;
  id: string;
  edited: boolean;
  values: Record<string, unknown>;
}

async function made(planId: string): Promise<Made[]> {
  const { results } = await env.DB.prepare(
    "SELECT local_date, record_id, edited_at FROM core_recurrence_occurrence WHERE series_id = ? ORDER BY local_date",
  )
    .bind(planId)
    .all<{ local_date: string; record_id: string; edited_at: string | null }>();
  const out: Made[] = [];
  for (const row of results) {
    const record = await invoke(
      "record.get",
      { object: WORK, id: row.record_id },
      as("2026-01-01T00:00:00.000Z"),
    ).catch(() => null);
    out.push({
      date: row.local_date,
      id: row.record_id,
      edited: row.edited_at !== null,
      values: (record?.values as Record<string, unknown>) ?? {},
    });
  }
  return out;
}

/** The local date and wall clock of an instant in a zone, by Intl alone (not the helper under test). */
function local(instant: unknown, zone = ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(String(instant)));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** The host's definition, as the pure rule helpers read it. */
const DEF: RecurringDefinition = {
  generates: WORK,
  link: "plan",
  rule: {
    unit: "unit",
    every: "every",
    weekdays: "weekdays",
    day: "day",
    month: "month",
    time: "time",
    lengthDays: "windowDays",
    from: "from",
    until: "until",
    zone: "zone",
  },
  into: { starts: "startsAt" },
  copy: {},
  cancel: "cancelled",
  horizonDays: 366,
};
const dates = (values: Record<string, unknown>, first: string, last: string) => {
  const rule = ruleOf(DEF, { time: "09:00", ...values }, "UTC");
  return rule ? occurrencesBetween(rule, first, last).map((o) => o.date) : null;
};

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(fixture("okrecint")).issues).toEqual([]);
    const broken = fixture("badrecint");
    const objects = broken.objects as Record<string, Record<string, unknown>>;
    const planObject = objects.plan as {
      fields: Record<string, Record<string, unknown>>;
      recurring: { rule: Record<string, unknown> };
    };
    planObject.fields.unit = {
      type: "select",
      label: "Unit",
      options: [{ value: "fortnight", label: "Fortnight" }],
    };
    planObject.fields.day = { type: "text", label: "Day" };
    const { weekdays: _weekdays, ...rule } = planObject.recurring.rule;
    planObject.recurring.rule = { ...rule, length: "every" };
    const paths = validateManifest(broken).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "objects.plan.recurring.rule.unit",
        "objects.plan.recurring.rule.day",
        "objects.plan.recurring.rule.lengthDays",
      ]),
    );
    // Without a unit the rule is weekly: it needs weekdays, and has no every, day or month.
    const weekly = fixture("wkrecint");
    const weeklyPlan = (weekly.objects as Record<string, { recurring: { rule: object } }>).plan;
    if (!weeklyPlan) throw new Error("expected the plan");
    weeklyPlan.recurring.rule = { time: "time", from: "from", every: "every" };
    expect(validateManifest(weekly).issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.plan.recurring.rule.weekdays",
        "objects.plan.recurring.rule.every",
      ]),
    );
  });

  it("refuses every, day and month out of range", async () => {
    const now = "2026-11-24T00:00:00.000Z";
    for (const [field, value] of [
      ["every", 0],
      ["day", 32],
      ["month", 13],
      ["windowDays", 0.5],
    ] as const) {
      await expect(
        plan({ unit: "month", from: "2027-01-01", [field]: value }, now),
      ).rejects.toMatchObject({
        code: "invalid_input",
        details: { rule: "recurring_rule", field },
      });
    }
  });
});

describe("the rule", () => {
  it("every 2 weeks on Monday and Thursday counts weeks from the week holding the first date", () => {
    // 6 January 2027 is a Wednesday: its week's Thursday, then every other week.
    expect(
      dates(
        { unit: "week", every: 2, weekdays: ["mon", "thu"], from: "2027-01-06" },
        "2027-01-01",
        "2027-02-07",
      ),
    ).toEqual(["2027-01-07", "2027-01-18", "2027-01-21", "2027-02-01", "2027-02-04"]);
  });

  it("is weekly without a unit or an every", () => {
    expect(dates({ weekdays: ["mon"], from: "2027-01-01" }, "2027-01-01", "2027-01-31")).toEqual([
      "2027-01-04",
      "2027-01-11",
      "2027-01-18",
      "2027-01-25",
    ]);
  });

  it("a yearly date the year lacks is its last day of the month; a monthly day is the first date's when empty", () => {
    expect(dates({ unit: "year", from: "2028-02-29" }, "2028-01-01", "2032-12-31")).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
    expect(
      dates({ unit: "month", every: 2, from: "2027-01-15" }, "2027-01-01", "2027-07-31"),
    ).toEqual(["2027-01-15", "2027-03-15", "2027-05-15", "2027-07-15"]);
    // A first date after the rule's day in its month: that month's date is not made.
    expect(
      dates({ unit: "month", day: 1, from: "2027-01-20" }, "2027-01-01", "2027-03-31"),
    ).toEqual(["2027-02-01", "2027-03-01"]);
  });

  it("makes nothing while incomplete", () => {
    expect(dates({ unit: "week", from: "2027-01-01" }, "2027-01-01", "2027-12-31")).toBeNull();
    expect(dates({ unit: "month" }, "2027-01-01", "2027-12-31")).toBeNull();
  });
});

describe("generation", () => {
  it("every 3 months on the 1st at 09:00: each once to the horizon, a late one leaves the next on its date, a moved one is never moved back", async () => {
    const now = "2026-12-01T00:00:00.000Z"; // 11:00 on 1 December in Sydney.
    const id = await plan({ unit: "month", every: 3, day: 1, from: "2027-03-01" }, now);
    expect(await tick(now)).toBe(4);
    let work = await made(id);
    // The horizon is 366 days from today, local: 2 December 2027.
    expect(work.map((w) => w.date)).toEqual([
      "2027-03-01",
      "2027-06-01",
      "2027-09-01",
      "2027-12-01",
    ]);
    for (const w of work) {
      expect(local(w.values.startsAt)).toBe(`${w.date} 09:00`);
      expect(w.values).toMatchObject({ plan: id, assignee: "Keeper A", state: "due", zone: ZONE });
    }
    expect(local(work[0]?.values.dueBy)).toBe("2027-03-08 09:00");
    // Made once: the next run makes nothing.
    expect(await tick(now)).toBe(0);
    const ids = work.map((w) => w.id);
    expect((await made(id)).map((w) => w.id)).toEqual(ids);

    // March's is done late, on the 20th: June's stays on 1 June, and the horizon moves on.
    const late = "2027-03-20T00:00:00.000Z";
    await invoke(
      "record.update",
      { object: WORK, id: work[0]?.id ?? "", values: { state: "done" } },
      as(late),
    );
    await tick(late);
    work = await made(id);
    expect(work.map((w) => w.date)).toEqual([
      "2027-03-01",
      "2027-06-01",
      "2027-09-01",
      "2027-12-01",
      "2028-03-01",
    ]);
    expect(local(work[1]?.values.startsAt)).toBe("2027-06-01 09:00");

    // September's moved by hand to the 3rd; the plan moves to 10:00 and to every 6 months.
    await invoke(
      "record.update",
      {
        object: WORK,
        id: work[2]?.id ?? "",
        values: { startsAt: "2027-09-02T23:00:00.000Z" }, // 09:00 on 3 September in Sydney.
      },
      as(late),
    );
    await invoke("record.update", { object: PLAN, id, values: { time: "10:00" } }, as(late));
    work = await made(id);
    expect(work.map((w) => local(w.values.startsAt))).toEqual([
      "2027-03-01 09:00", // Done: past and finished, left as it was.
      "2027-06-01 10:00",
      "2027-09-03 09:00", // Moved by hand: never moved back.
      "2027-12-01 10:00",
      "2028-03-01 10:00",
    ]);
    expect(work[2]).toMatchObject({ edited: true, values: { changed: true } });
    await invoke("record.update", { object: PLAN, id, values: { every: 6 } }, as(late));
    await tick(late);
    work = await made(id);
    // June's and December's are no longer in the rule and go; the moved one stays its own.
    expect(work.map((w) => w.date)).toEqual(["2027-03-01", "2027-09-01", "2028-03-01"]);
    expect(local(work[1]?.values.startsAt)).toBe("2027-09-03 09:00");
  });

  it("every month on the 31st lands on the last day of shorter months, its window across the April change", async () => {
    const now = "2027-01-01T00:00:00.000Z";
    const id = await plan(
      { title: "Monthly check", unit: "month", day: 31, from: "2027-01-31", until: "2027-12-31" },
      now,
    );
    await tick(now);
    const work = await made(id);
    expect(work.map((w) => w.date)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
    ]);
    // 31 March's week-long window crosses 4 April, when Sydney's clocks go back an hour: it still
    // closes at 09:00, seven days and an hour later.
    const march = work[2]?.values;
    expect(local(march?.startsAt)).toBe("2027-03-31 09:00");
    expect(local(march?.dueBy)).toBe("2027-04-07 09:00");
    expect(Date.parse(String(march?.dueBy)) - Date.parse(String(march?.startsAt))).toBe(
      (7 * 24 + 1) * 3_600_000,
    );
  });

  it("every year on 1 March makes one a year", async () => {
    const now = "2026-11-24T00:00:00.000Z";
    const id = await plan(
      { title: "Yearly test", unit: "year", month: 3, day: 1, from: "2026-11-24" },
      now,
    );
    await tick(now);
    expect((await made(id)).map((w) => w.date)).toEqual(["2027-03-01"]);
    // Due once a day: by the end of November the horizon reaches the next 1 March.
    await tick("2027-11-30T00:00:00.000Z");
    expect((await made(id)).map((w) => w.date)).toEqual(["2027-03-01", "2028-03-01"]);
  });
});

describe("cost", () => {
  let queries = 0;
  let batched = 0;
  /** env.DB, counting every query (a batch's statements counted, then subtracted). */
  const metered = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (p === "all" || p === "run" || p === "first" || p === "raw") {
                  return async (...args: unknown[]) => {
                    queries += 1;
                    return (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  };
                }
                const value = Reflect.get(s, p);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          return wrap(target.prepare(query));
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          queries += statements.length;
          batched += statements.length;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const meteredDb = createCrmDb(metered);
  const NOW = "2027-06-01T00:00:00.000Z";
  const ctx = (): InvocationContext => ({
    actor: "human",
    user: admin,
    origin: { surface: "ui" },
    db: meteredDb,
    clock: () => new Date(NOW),
  });

  /** The queries read on their own by one run making 25 dates (the batch is one more). */
  async function reads(values: Record<string, unknown>) {
    const created = (await invokeByName(
      "record.create",
      {
        object: PLAN,
        values: {
          title: "Daily wipe-down",
          weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          time: "12:00",
          from: "2027-06-03",
          zone: "UTC",
          ...values,
        },
      },
      ctx(),
    )) as { id: string };
    queries = 0;
    batched = 0;
    const result = (await invokeByName(
      "recurring.generate",
      { object: PLAN, id: created.id, limit: 25 },
      { ...ctx(), actor: "automation", origin: { surface: "system" } },
    )) as { made: number; more: boolean };
    expect(result).toMatchObject({ made: 25, more: true });
    return queries - batched;
  }

  it("a run of the interval rule reads what a weekly run of as many dates reads", async () => {
    const weekly = await reads({});
    // Every other week on every day: the rule walks the horizon's 366 days without reading more.
    const fortnightly = await reads({ unit: "week", every: 2 });
    expect(fortnightly).toBeLessThanOrEqual(weekly);
    // Within ADR 0500's budget: about five reads a date.
    expect(fortnightly).toBeLessThanOrEqual(25 * 6);
  });
});
