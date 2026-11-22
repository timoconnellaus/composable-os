// Stage 31 (ADR 0500): the `recurring` behaviour on a fixture timetable. A series on Tuesdays and
// Thursdays at 06:00 makes exactly the classes inside its horizon, at 06:00 local on both sides of
// each clock change, in a whole-hour zone and in a half-hour one; a re-run, or two at once, makes
// nothing twice; a class changed or cancelled by hand is never overwritten or made again; a
// change to the series reaches only the future classes nobody edited; ending it removes them; a
// closure cancels the classes inside it and nothing is made on its dates; a time that does not
// exist on a change day moves forward by the gap. Every clock is injected: nothing here reads the
// wall clock.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, runRecurringDue } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("rec");
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
const CLOSURE = `${ext}.closure`;

const WEEKDAY_OPTIONS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));

export const timetable = (id: string) =>
  manifest(id, {
    objects: {
      series: {
        label: "Series",
        plural: "Series",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAY_OPTIONS },
          time: { type: "text", label: "Time" },
          length: { type: "number", label: "Length" },
          firstDate: { type: "date", label: "First date" },
          lastDate: { type: "date", label: "Last date" },
          timezone: { type: "timezone", label: "Time zone" },
          coach: { type: "text", label: "Coach" },
          places: { type: "number", label: "Places" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "active", label: "Active" },
              { value: "ended", label: "Ended" },
            ],
          },
        },
        recurring: {
          generates: "klass",
          link: "series",
          rule: {
            weekdays: "weekdays",
            time: "time",
            length: "length",
            from: "firstDate",
            until: "lastDate",
            zone: "timezone",
          },
          into: { starts: "startsAt", ends: "endsAt", zone: "timezone", changed: "changed" },
          copy: { coach: "coach", places: "places" },
          cancel: "cancelled",
          ended: { field: "state", in: ["ended"] },
          closures: { object: "closure", from: "from", until: "until" },
          horizonDays: 56,
        },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        titleDefault: { from: ["series"] },
        fields: {
          name: { type: "text", label: "Name" },
          series: { type: "relation", label: "Series", to: `${id}.series`, readOnly: true },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          timezone: { type: "timezone", label: "Time zone" },
          coach: { type: "text", label: "Coach" },
          places: { type: "number", label: "Places" },
          changed: { type: "boolean", label: "Changed", readOnly: true },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "scheduled", label: "Scheduled" },
              { value: "cancelled", label: "Cancelled" },
              { value: "done", label: "Done" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [
            { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
            { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
          ],
        },
        capacity: { places: "places" },
      },
      closure: {
        label: "Closure",
        plural: "Closures",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          from: { type: "date", label: "From" },
          until: { type: "date", label: "Until" },
        },
      },
    },
  });

let admin: ActingUser;
const as = (now: string) => context(admin, { clock: () => new Date(now) });

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(timetable(ext));
}, 60_000);

async function series(values: Record<string, unknown>, now: string) {
  const created = await invoke(
    "record.create",
    {
      object: SERIES,
      values: {
        name: "Early class",
        weekdays: ["tue", "thu"],
        time: "06:00",
        length: 60,
        timezone: "Australia/Sydney",
        coach: "Coach A",
        places: 12,
        state: "active",
        ...values,
      },
    },
    as(now),
  );
  return created.id as string;
}

/** The minute cron at `now`, until nothing more is due. */
async function tick(now: string) {
  return runRecurringDue(db, { clock: () => new Date(now) });
}

interface Made {
  date: string;
  id: string;
  edited: boolean;
  values: Record<string, unknown>;
}

async function made(seriesId: string): Promise<Made[]> {
  const { results } = await env.DB.prepare(
    "SELECT local_date, record_id, edited_at FROM core_recurrence_occurrence WHERE series_id = ? ORDER BY local_date",
  )
    .bind(seriesId)
    .all<{ local_date: string; record_id: string; edited_at: string | null }>();
  const out: Made[] = [];
  for (const row of results) {
    const record = await invoke("record.get", { object: KLASS, id: row.record_id }, as("2026-01-01T00:00:00.000Z")).catch(
      () => null,
    );
    out.push({
      date: row.local_date,
      id: row.record_id,
      edited: row.edited_at !== null,
      values: (record?.values as Record<string, unknown>) ?? {},
    });
  }
  return out;
}

/** The local wall clock of an instant in a zone, by Intl alone (not the helper under test). */
function wallClock(instant: unknown, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(String(instant)));
}

/** Tuesdays and Thursdays from `first` to `last`, by plain UTC calendar walking. */
function tuesdaysAndThursdays(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 2 || day === 4) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(timetable("okrec")).issues).toEqual([]);
    const broken = timetable("badrec");
    const objects = broken.objects as Record<string, Record<string, unknown>>;
    const seriesObject = objects.series as { recurring: Record<string, unknown> };
    seriesObject.recurring = { ...seriesObject.recurring, cancel: "gone", link: "name" };
    (objects.klass as { fields: Record<string, Record<string, unknown>> }).fields.changed = {
      type: "boolean",
      label: "Changed",
    };
    const paths = validateManifest(broken).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "objects.series.recurring.cancel",
        "objects.series.recurring.link",
        "objects.series.recurring.into.changed",
      ]),
    );
  });

  it("refuses a time that is not HH:MM", async () => {
    await expect(series({ time: "6am" }, "2026-03-20T00:00:00.000Z")).rejects.toMatchObject({
      code: "invalid_input",
      details: { rule: "recurring_rule", field: "time" },
    });
  });
});

describe("generation", () => {
  it("makes exactly the classes inside the horizon, at 06:00 local across the April change", async () => {
    const now = "2026-03-24T09:00:00.000Z"; // Tuesday 24 March, 20:00 in Sydney.
    const id = await series({ firstDate: "2026-03-01" }, now);
    expect(await made(id)).toEqual([]); // Made by the minute cron, not by the write.
    const result = await tick(now);
    expect(result).toMatchObject({ failed: 0 });
    const classes = await made(id);
    // Today's class (06:00 on the 24th) has passed; the horizon is 56 days from today, local.
    const expected = tuesdaysAndThursdays("2026-03-26", "2026-05-19");
    expect(classes.map((c) => c.date)).toEqual(expected);
    for (const c of classes) {
      expect(wallClock(c.values.startsAt, "Australia/Sydney")).toBe("06:00");
      expect(wallClock(c.values.endsAt, "Australia/Sydney")).toBe("07:00");
      expect(c.values).toMatchObject({
        series: id,
        coach: "Coach A",
        places: 12,
        timezone: "Australia/Sydney",
        state: "scheduled",
        changed: null,
        name: "Early class",
      });
    }
    // Either side of Sunday 5 April the instant moves an hour; the wall clock does not.
    const byDate = Object.fromEntries(classes.map((c) => [c.date, c.values.startsAt]));
    expect(byDate["2026-04-02"]).toBe("2026-04-01T19:00:00.000Z");
    expect(byDate["2026-04-07"]).toBe("2026-04-06T20:00:00.000Z");
    // Its places are a capacity of their own.
    const counter = await env.DB.prepare(
      "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
    )
      .bind(KLASS, classes[0]?.id)
      .first();
    expect(counter).toEqual({ places: 12, held: 0, taken: 0 });
    // It runs again after local midnight: 00:05 on Wednesday 25 March in Sydney.
    const row = await env.DB.prepare(
      "SELECT next_run_at, generated_until FROM core_recurrence_series WHERE record_id = ?",
    )
      .bind(id)
      .first();
    expect(row).toEqual({ next_run_at: "2026-03-24T13:05:00.000Z", generated_until: "2026-05-19" });
  });

  it("keeps 06:00 across the October change, in a half-hour zone too", async () => {
    const now = "2026-09-20T00:00:00.000Z";
    const sydney = await series({ firstDate: "2026-09-01" }, now);
    const adelaide = await series({ firstDate: "2026-09-01", timezone: "Australia/Adelaide" }, now);
    await tick(now);
    for (const [id, zone, before, after] of [
      [sydney, "Australia/Sydney", "2026-09-30T20:00:00.000Z", "2026-10-05T19:00:00.000Z"],
      [adelaide, "Australia/Adelaide", "2026-09-30T20:30:00.000Z", "2026-10-05T19:30:00.000Z"],
    ] as const) {
      const classes = await made(id);
      expect(classes.map((c) => c.date)).toEqual(tuesdaysAndThursdays("2026-09-22", "2026-11-15"));
      for (const c of classes) expect(wallClock(c.values.startsAt, zone)).toBe("06:00");
      const byDate = Object.fromEntries(classes.map((c) => [c.date, c.values.startsAt]));
      expect(byDate["2026-10-01"]).toBe(before);
      expect(byDate["2026-10-06"]).toBe(after);
    }
  });

  it("moves a time that does not exist on the change day forward by the gap", async () => {
    // Sunday 4 October, 02:30 in Sydney, does not exist: that class is at 03:30.
    const now = "2026-09-25T00:00:00.000Z";
    const id = await series({ weekdays: ["sun"], time: "02:30", firstDate: "2026-09-01" }, now);
    await tick(now);
    const classes = await made(id);
    const byDate = Object.fromEntries(classes.map((c) => [c.date, c.values.startsAt]));
    expect(wallClock(byDate["2026-09-27"], "Australia/Sydney")).toBe("02:30");
    expect(wallClock(byDate["2026-10-04"], "Australia/Sydney")).toBe("03:30");
    expect(byDate["2026-10-04"]).toBe("2026-10-03T16:30:00.000Z");
    expect(wallClock(byDate["2026-10-11"], "Australia/Sydney")).toBe("02:30");
    // And 02:30 on 5 April 2027, which happens twice, is the first (+11).
    const april = await series(
      { weekdays: ["sun"], time: "02:30", firstDate: "2027-04-04", lastDate: "2027-04-04" },
      "2027-03-20T00:00:00.000Z",
    );
    await tick("2027-03-20T00:00:00.000Z");
    expect((await made(april)).map((c) => c.values.startsAt)).toEqual(["2027-04-03T15:30:00.000Z"]);
  });

  it("makes nothing twice: a re-run, a later run, and two runs at once", async () => {
    const now = "2026-05-04T00:00:00.000Z";
    const id = await series({ firstDate: "2026-05-01" }, now);
    const [first, second] = await Promise.all([
      invoke("recurring.generate", { object: SERIES, id }, {
        ...as(now),
        actor: "automation",
      }).catch((e: unknown) => e),
      invoke("recurring.generate", { object: SERIES, id }, {
        ...as(now),
        actor: "automation",
      }).catch((e: unknown) => e),
    ]);
    const outcomes = [first, second].map((r) =>
      (r as { made?: number }).made !== undefined ? "made" : (r as { code?: string }).code,
    );
    // One run makes the dates; the other makes none, or is refused on their keys.
    expect(outcomes).toContain("made");
    const once = await made(id);
    expect(new Set(once.map((c) => c.date)).size).toBe(once.length);
    expect(once.map((c) => c.date)).toEqual(tuesdaysAndThursdays("2026-05-05", "2026-06-29"));
    await tick(now);
    await tick("2026-05-04T00:10:00.000Z");
    expect((await made(id)).map((c) => c.id)).toEqual(once.map((c) => c.id));
    // A week on, the horizon has moved a week: only the new dates are made.
    await tick("2026-05-11T00:00:00.000Z");
    const later = await made(id);
    expect(later.map((c) => c.date)).toEqual(tuesdaysAndThursdays("2026-05-05", "2026-07-06"));
    expect(later.slice(0, once.length).map((c) => c.id)).toEqual(once.map((c) => c.id));
  });
});

describe("exceptions and changes", () => {
  it("never overwrites or re-makes a class edited or cancelled by hand; a change reaches the rest", async () => {
    const now = "2026-06-01T00:00:00.000Z";
    const id = await series({ firstDate: "2026-06-01" }, now);
    await tick(now);
    const [first, second, third] = await made(id);
    if (!first || !second || !third) throw new Error("expected classes");
    await invoke(
      "record.update",
      { object: KLASS, id: first.id, values: { coach: "Coach B" } },
      as(now),
    );
    await invoke(
      "record.update",
      { object: KLASS, id: second.id, values: { state: "cancelled" } },
      as(now),
    );
    // A note-like field the series does not set leaves the class the series' own.
    await invoke("record.update", { object: KLASS, id: third.id, values: { name: "Renamed" } }, as(now));
    let classes = await made(id);
    expect(classes.slice(0, 3).map((c) => [c.edited, c.values.changed])).toEqual([
      [true, true],
      [true, true],
      [false, null],
    ]);

    // The series moves to 07:00 with another coach and 10 places: every class nobody edited
    // follows; the edited and the cancelled stay as they were.
    await invoke(
      "record.update",
      { object: SERIES, id, values: { time: "07:00", coach: "Coach C", places: 10 } },
      as(now),
    );
    classes = await made(id);
    expect(classes[0]?.values).toMatchObject({ coach: "Coach B", places: 12 });
    expect(wallClock(classes[0]?.values.startsAt, "Australia/Sydney")).toBe("06:00");
    expect(classes[1]?.values).toMatchObject({ state: "cancelled", coach: "Coach A" });
    for (const c of classes.slice(2)) {
      expect(c.values).toMatchObject({ coach: "Coach C", places: 10, changed: null });
      expect(wallClock(c.values.startsAt, "Australia/Sydney")).toBe("07:00");
    }
    // Re-runs make nothing again, the cancelled date included.
    await tick("2026-06-01T00:05:00.000Z");
    expect((await made(id)).map((c) => c.id)).toEqual(classes.map((c) => c.id));
  });

  it("drops a weekday: its future classes go, and come back only if the weekday does", async () => {
    const now = "2026-07-01T00:00:00.000Z";
    const id = await series({ firstDate: "2026-07-01" }, now);
    await tick(now);
    const before = await made(id);
    await invoke("record.update", { object: SERIES, id, values: { weekdays: ["tue"] } }, as(now));
    const after = await made(id);
    expect(after.map((c) => c.date)).toEqual(
      tuesdaysAndThursdays("2026-07-02", "2026-08-26").filter(
        (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 2,
      ),
    );
    const gone = before.find((c) => !after.some((a) => a.id === c.id));
    expect(
      await invoke("record.get", { object: KLASS, id: gone?.id as string }, as(now)).catch(
        (e: { code: string }) => e.code,
      ),
    ).toBe("not_found");
  });

  it("ends a series: its future classes go and nothing more is made", async () => {
    const now = "2026-08-03T00:00:00.000Z";
    const id = await series({ firstDate: "2026-08-01" }, now);
    await tick(now);
    expect((await made(id)).length).toBeGreaterThan(10);
    await invoke("record.update", { object: SERIES, id, values: { state: "ended" } }, as(now));
    expect(await made(id)).toEqual([]);
    await tick("2026-08-10T00:00:00.000Z");
    expect(await made(id)).toEqual([]);
  });

  it("a closure cancels the classes inside it, and nothing is made on its dates", async () => {
    const now = "2026-11-02T00:00:00.000Z";
    const id = await series({ firstDate: "2026-11-01" }, now);
    await tick(now);
    // 10 to 19 November inclusive, local dates.
    await invoke(
      "record.create",
      { object: CLOSURE, values: { name: "Holidays", from: "2026-11-10", until: "2026-11-19" } },
      as(now),
    );
    const classes = await made(id);
    const inside = (d: string) => d >= "2026-11-10" && d <= "2026-11-19";
    for (const c of classes) {
      expect([c.date, c.values.state]).toEqual([c.date, inside(c.date) ? "cancelled" : "scheduled"]);
    }
    expect(classes.filter((c) => inside(c.date)).map((c) => c.date)).toEqual([
      "2026-11-10",
      "2026-11-12",
      "2026-11-17",
      "2026-11-19",
    ]);
    // A later closure past the horizon: those dates are not made when the horizon reaches them.
    await invoke(
      "record.create",
      { object: CLOSURE, values: { name: "Summer", from: "2027-01-05", until: "2027-01-07" } },
      as(now),
    );
    await tick("2026-11-20T00:00:00.000Z");
    const later = await made(id);
    expect(later.map((c) => c.date)).not.toContain("2027-01-05");
    expect(later.map((c) => c.date)).not.toContain("2027-01-07");
    expect(later.map((c) => c.date)).toContain("2027-01-12");
  });
});
