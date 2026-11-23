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
import { z } from "zod";
import {
  type ActingUser,
  armSeriesStatement,
  coreRegistry,
  createInvoker,
  createRecord,
  createRegistry,
  defineOperation,
  generateSeries,
  invoke,
  localDaysBefore,
  requireExtensionObject,
  runRecurringDue,
  updateRecord,
} from "../src/index.ts";
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

const timetable = (id: string) =>
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
          horizonAtLeast: { object: "rules", field: "opensDays" },
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
              { value: "paused", label: "Paused" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [
            { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
            { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
            // A state the host has no move into "cancelled" from.
            { from: "scheduled", to: "paused", by: ["staff"] },
            { from: "paused", to: "scheduled", by: ["staff"] },
          ],
        },
        capacity: { places: "places" },
      },
      // A booking: a claimant on its class, so a class can have places taken.
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: `${id}.klass` },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "booked", label: "Booked" },
              { value: "cancelled", label: "Cancelled" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"], final: true }],
        },
        claims: { on: "klass", confirmed: ["booked"] },
      },
      // A class type's booking window, standing in for step 3's: the horizon is never less.
      rules: {
        label: "Rules",
        plural: "Rules",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          opensDays: { type: "number", label: "Opens (days before)" },
        },
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
/** The minute cron at `now`, run until nothing is due (every series in this file shares it). */
async function tick(now: string) {
  let total = { series: 0, made: 0, failed: 0 };
  for (let i = 0; i < 30; i += 1) {
    const result = await runRecurringDue(db, { clock: () => new Date(now) });
    total = {
      series: total.series + result.series,
      made: total.made + result.made,
      failed: total.failed + result.failed,
    };
    if (result.series === 0) break;
  }
  return total;
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
    const record = await invoke(
      "record.get",
      { object: KLASS, id: row.record_id },
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

/** A record's field exceptions as stored: field, who, when. */
async function own(recordId: string): Promise<[string, string, string][]> {
  const { results } = await env.DB.prepare(
    "SELECT field, set_by, set_at FROM core_recurrence_exception WHERE record_id = ? ORDER BY field",
  )
    .bind(recordId)
    .all<{ field: string; set_by: string; set_at: string }>();
  return results.map((r) => [r.field, r.set_by, r.set_at]);
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
  for (
    let t = Date.parse(`${first}T00:00:00Z`);
    t <= Date.parse(`${last}T00:00:00Z`);
    t += 86_400_000
  ) {
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
      invoke(
        "recurring.generate",
        { object: SERIES, id },
        {
          ...as(now),
          actor: "automation",
        },
      ).catch((e: unknown) => e),
      invoke(
        "recurring.generate",
        { object: SERIES, id },
        {
          ...as(now),
          actor: "automation",
        },
      ).catch((e: unknown) => e),
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
    await invoke(
      "record.update",
      { object: KLASS, id: third.id, values: { name: "Renamed" } },
      as(now),
    );
    let classes = await made(id);
    // The coach swap keeps only the coach as the class's own; the cancel detaches it whole.
    expect(classes.slice(0, 3).map((c) => [c.edited, c.values.changed])).toEqual([
      [false, null],
      [true, true],
      [false, null],
    ]);
    expect(await own(first.id)).toEqual([["coach", admin.id, now]]);

    // The series moves to 07:00 with another coach and 10 places: every class follows, the
    // swapped one in all but its coach; the cancelled one stays as it was.
    await invoke(
      "record.update",
      { object: SERIES, id, values: { time: "07:00", coach: "Coach C", places: 10 } },
      as(now),
    );
    classes = await made(id);
    expect(classes[0]?.values).toMatchObject({ coach: "Coach B", places: 10, changed: null });
    expect(wallClock(classes[0]?.values.startsAt, "Australia/Sydney")).toBe("07:00");
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
      expect([c.date, c.values.state]).toEqual([
        c.date,
        inside(c.date) ? "cancelled" : "scheduled",
      ]);
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

describe("classes with places taken", () => {
  const BOOKING = `${ext}.booking`;
  const bookInto = async (klassId: string, now: string) =>
    invoke("record.create", { object: BOOKING, values: { klass: klassId } }, as(now));

  it("asks for the count before moving or cancelling them, and keeps places at what is taken", async () => {
    const now = "2027-02-01T00:00:00.000Z";
    const id = await series({ firstDate: "2027-02-01", places: 3 }, now);
    await tick(now);
    const [booked, , other] = await made(id);
    if (!booked || !other) throw new Error("expected classes");
    for (let i = 0; i < 2; i += 1) await bookInto(booked.id, now);

    // Fewer places than are taken: the booked class keeps two, the rest take the new number.
    await invoke("record.update", { object: SERIES, id, values: { places: 1 } }, as(now));
    let classes = await made(id);
    expect(classes[0]?.values.places).toBe(2);
    expect(classes[1]?.values.places).toBe(1);

    // A new time moves a class with bookings: refused, with the count, until it is confirmed.
    const change = { time: "18:00" };
    await expect(
      invoke("record.update", { object: SERIES, id, values: change }, as(now)),
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        rule: "recurring_confirm",
        count: 1,
        records: [{ id: booked.id, action: "update" }],
      },
    });
    expect(wallClock((await made(id))[0]?.values.startsAt, "Australia/Sydney")).toBe("06:00");
    await expect(
      invoke("recurring.change", { object: SERIES, id, values: change, confirm: 2 }, as(now)),
    ).rejects.toMatchObject({ details: { rule: "recurring_confirm", count: 1 } });
    await invoke("recurring.change", { object: SERIES, id, values: change, confirm: 1 }, as(now));
    classes = await made(id);
    for (const c of classes) expect(wallClock(c.values.startsAt, "Australia/Sydney")).toBe("18:00");

    // Ending it: the booked class is cancelled (its bookings stay), the others go.
    await expect(
      invoke("record.update", { object: SERIES, id, values: { state: "ended" } }, as(now)),
    ).rejects.toMatchObject({ details: { rule: "recurring_confirm", count: 1 } });
    await invoke(
      "recurring.change",
      { object: SERIES, id, values: { state: "ended" }, confirm: 1 },
      as(now),
    );
    classes = await made(id);
    expect(classes.map((c) => [c.id, c.values.state])).toEqual([[booked.id, "cancelled"]]);
  });

  it("is a destructive operation: an assistant asks a person", async () => {
    const now = "2027-03-01T00:00:00.000Z";
    const id = await series({ firstDate: "2027-03-01" }, now);
    await expect(
      invoke(
        "recurring.change",
        { object: SERIES, id, values: { time: "07:00" }, confirm: 1 },
        { ...as(now), actor: "assistant" },
      ),
    ).rejects.toMatchObject({ code: "pending_approval" });
  });
});

// --- Review fixes (2026-11-22) ---------------------------------------------------------------------

// Platform code racing itself, in one batch: what two writes a moment apart would do.
const bookThenChange = defineOperation({
  name: "fixture.bookThenChange",
  description: "Test fixture: books a class, then changes its series, planned from the same read.",
  input: z.object({
    klass: z.string(),
    series: z.string(),
    values: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await createRecord(ctx, requireExtensionObject(`${ext}.booking`), { klass: input.klass });
    await updateRecord(ctx, requireExtensionObject(SERIES), input.series, input.values);
    return { ok: true };
  },
});
const changeThenGenerate = defineOperation({
  name: "fixture.changeThenGenerate",
  description: "Test fixture: a series written, then a run planned from the version before.",
  input: z.object({ series: z.string() }),
  output: z.object({ made: z.number(), more: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    ctx.write(armSeriesStatement(SERIES, input.series, ctx.now, ctx.now));
    return generateSeries(ctx, requireExtensionObject(SERIES), input.series);
  },
});
const races = createInvoker(
  createRegistry([...coreRegistry.list(), bookThenChange, changeThenGenerate]),
);

describe("review fixes: guarded plans, the horizon, from a date, Trash, cost", () => {
  it("a class booked under a series change fails the change, which can be tried again", async () => {
    const now = "2027-05-03T00:00:00.000Z";
    const id = await series({ firstDate: "2027-05-03" }, now);
    await tick(now);
    const [first] = await made(id);
    if (!first) throw new Error("expected a class");
    // A new time, and the class's weekday dropped: each planned with no places taken.
    const drop = new Date(`${first.date}T00:00:00Z`).getUTCDay() === 2 ? ["thu"] : ["tue"];
    for (const values of [{ time: "08:00" }, { weekdays: drop }]) {
      await expect(
        races.invoke("fixture.bookThenChange", { klass: first.id, series: id, values }, as(now)),
      ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_stale" } });
    }
    const after = await made(id);
    expect(after[0]?.id).toBe(first.id);
    expect(wallClock(after[0]?.values.startsAt, "Australia/Sydney")).toBe("06:00");
  });

  it("a run planned before a change to its series fails, and the next tick makes it fresh", async () => {
    const now = "2027-06-01T00:00:00.000Z";
    const id = await series({ firstDate: "2027-06-01" }, now);
    await expect(
      races.invoke(
        "fixture.changeThenGenerate",
        { series: id },
        { ...as(now), actor: "automation" },
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_stale" } });
    expect(await made(id)).toEqual([]);
    await tick(now);
    expect((await made(id)).length).toBeGreaterThan(0);
  });

  it("applies a change from a date: earlier classes keep the series as it was", async () => {
    const now = "2027-07-01T00:00:00.000Z";
    const id = await series({ firstDate: "2027-07-01" }, now);
    await tick(now);
    await invoke(
      "recurring.change",
      { object: SERIES, id, values: { time: "09:00" }, confirm: 1, from: "2027-07-20" },
      as(now),
    );
    const classes = await made(id);
    expect(classes.some((c) => c.date < "2027-07-20")).toBe(true);
    for (const c of classes) {
      const expected = c.date >= "2027-07-20" ? "09:00" : "06:00";
      expect([c.date, wallClock(c.values.startsAt, "Australia/Sydney")]).toEqual([
        c.date,
        expected,
      ]);
    }
  });

  it("a series in Trash stops: its future classes go, booked ones refuse it, and restored it runs again", async () => {
    const now = "2027-08-02T00:00:00.000Z";
    const id = await series({ firstDate: "2027-08-02" }, now);
    await tick(now);
    expect((await made(id)).length).toBeGreaterThan(5);
    await invoke("record.delete", { object: SERIES, id }, as(now));
    expect(await made(id)).toEqual([]);
    await tick("2027-08-03T00:00:00.000Z");
    expect(await made(id)).toEqual([]);
    await invoke("record.restore", { object: SERIES, id }, as("2027-08-03T00:00:00.000Z"));
    await tick("2027-08-03T00:01:00.000Z");
    const back = await made(id);
    expect(back.length).toBeGreaterThan(5);
    // With a class booked, Trash is refused: end the series with the count first.
    await invoke(
      "record.create",
      { object: `${ext}.booking`, values: { klass: back[0]?.id } },
      as(now),
    );
    await expect(
      invoke("record.delete", { object: SERIES, id }, as("2027-08-03T00:02:00.000Z")),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_confirm", count: 1 } });
  });

  it("refuses up front, with the reason, a change that would cancel a class the host cannot cancel", async () => {
    const now = "2027-09-01T00:00:00.000Z";
    const id = await series({ firstDate: "2027-09-01" }, now);
    await tick(now);
    const [first] = await made(id);
    await invoke(
      "record.create",
      { object: `${ext}.booking`, values: { klass: first?.id } },
      as(now),
    );
    await invoke(
      "record.update",
      { object: KLASS, id: first?.id as string, values: { state: "paused" } },
      as(now),
    );
    await expect(
      invoke(
        "recurring.change",
        { object: SERIES, id, values: { state: "ended" }, confirm: 1 },
        as(now),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { rule: "recurring_cannot_cancel", records: [{ id: first?.id, state: "paused" }] },
    });
    expect((await made(id)).length).toBeGreaterThan(5);
  });

  it("a closure that cancels booked classes needs the count, from a person; renaming it cancels nothing", async () => {
    const now = "2027-10-04T00:00:00.000Z";
    const id = await series({ firstDate: "2027-10-04" }, now);
    await tick(now);
    const target = (await made(id)).find((c) => c.date === "2027-10-12");
    await invoke(
      "record.create",
      { object: `${ext}.booking`, values: { klass: target?.id } },
      as(now),
    );
    const values = { name: "Long weekend", from: "2027-10-12", until: "2027-10-14" };
    await expect(
      invoke("record.create", { object: CLOSURE, values }, as(now)),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_confirm", count: 1 } });
    await expect(
      invoke(
        "recurring.close",
        { object: CLOSURE, values, confirm: 1 },
        { ...as(now), actor: "assistant" },
      ),
    ).rejects.toMatchObject({ code: "pending_approval" });
    const closure = (await invoke(
      "recurring.close",
      { object: CLOSURE, values, confirm: 1 },
      as(now),
    )) as { id: string };
    expect(
      (await made(id)).filter((c) => c.values.state === "cancelled").map((c) => c.date),
    ).toEqual(["2027-10-12", "2027-10-14"]);
    // Staff put on a one-off class inside it; renaming the closure leaves it on.
    const oneOff = await invoke(
      "record.create",
      {
        object: KLASS,
        values: {
          name: "Open gym",
          startsAt: "2027-10-12T23:00:00.000Z",
          timezone: "Australia/Sydney",
        },
      },
      as(now),
    );
    await invoke(
      "record.update",
      { object: CLOSURE, id: closure.id, values: { name: "Holiday" } },
      as(now),
    );
    const kept = await invoke("record.get", { object: KLASS, id: oneOff.id }, as(now));
    expect((kept.values as Record<string, unknown>).state).toBe("scheduled");
  });

  it("a tick makes at most its budget across series, the oldest due first, and finishes later", async () => {
    const now = "2028-01-03T00:00:00.000Z";
    await tick(now); // Every other series in this file is made first.
    const every = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    // The small series was saved a moment before the big one: it is due first.
    const small = await series({ firstDate: "2028-01-03" }, "2028-01-02T23:59:59.000Z");
    const big = await series({ firstDate: "2028-01-03", weekdays: every }, now);
    const first = await runRecurringDue(db, { clock: () => new Date(now), maxRecords: 30 });
    expect(first.made).toBe(30);
    expect((await made(small)).length).toBe(16);
    expect((await made(big)).length).toBe(14);
    for (let i = 1; i <= 4; i += 1) {
      const at = new Date(Date.parse(now) + i * 60_000);
      const tickResult = await runRecurringDue(db, { clock: () => at, maxRecords: 30 });
      expect(tickResult.made).toBeLessThanOrEqual(30);
    }
    expect((await made(big)).length).toBe(56);
    expect((await made(small)).length).toBe(16);
  });

  it("never makes the horizon shorter than the longest booking window", async () => {
    const now = "2028-03-06T00:00:00.000Z";
    await invoke(
      "record.create",
      { object: `${ext}.rules`, values: { name: "Kids", opensDays: 90 } },
      as(now),
    );
    const id = await series({ firstDate: "2028-03-06" }, now);
    for (let i = 0; i < 3; i += 1) await tick(new Date(Date.parse(now) + i * 60_000).toISOString());
    // 90 days of window, plus the day it opens: up to 5 June 2028.
    expect((await made(id)).map((c) => c.date)).toEqual(
      tuesdaysAndThursdays("2028-03-07", "2028-06-05"),
    );
  });

  it("refuses copying into the state, and keeps milliseconds when counting local days", () => {
    const broken = timetable("cprec");
    const objects = broken.objects as Record<
      string,
      { recurring?: { copy?: Record<string, string> } }
    >;
    const recurring = objects.series?.recurring;
    if (recurring) recurring.copy = { ...recurring.copy, state: "state" };
    expect(validateManifest(broken).issues.map((i) => i.path)).toContain(
      "objects.series.recurring.copy.state",
    );
    const at = Date.parse("2026-10-07T19:00:12.345Z");
    expect(new Date(localDaysBefore(at, 7, "Australia/Sydney")).toISOString()).toBe(
      "2026-09-30T20:00:12.345Z",
    );
  });
});

// --- Field-level exceptions (stage 45 step 1, ADR 0620) --------------------------------------------

// A series change planned, then a hand edit to one of its classes committed before it: what two
// people a moment apart would do. And the other way round. And one batch editing several classes
// of one series beside the series itself (a bulk edit), which must not trip its own guards.
const raceInput = z.object({
  series: z.string(),
  klass: z.string(),
  seriesValues: z.record(z.string(), z.unknown()),
  klassValues: z.record(z.string(), z.unknown()),
  now: z.string(),
});
const changeThenEdit = defineOperation({
  name: "fixture.changeThenEdit",
  description: "Test fixture: plans a series change, then a class edit commits first.",
  input: raceInput,
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecord(ctx, requireExtensionObject(SERIES), input.series, input.seriesValues);
    await invoke(
      "record.update",
      { object: KLASS, id: input.klass, values: input.klassValues },
      as(input.now),
    );
    return { ok: true };
  },
});
const editThenChange = defineOperation({
  name: "fixture.editThenChange",
  description: "Test fixture: plans a class edit, then a series change commits first.",
  input: raceInput,
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecord(ctx, requireExtensionObject(KLASS), input.klass, input.klassValues);
    await invoke(
      "record.update",
      { object: SERIES, id: input.series, values: input.seriesValues },
      as(input.now),
    );
    return { ok: true };
  },
});
const bulkEdit = defineOperation({
  name: "fixture.bulkEdit",
  description: "Test fixture: several classes of one series and the series, in one batch.",
  input: z.object({
    series: z.string(),
    klasses: z.array(z.string()),
    coach: z.string(),
    places: z.number(),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    for (const k of input.klasses) {
      await updateRecord(ctx, requireExtensionObject(KLASS), k, { coach: input.coach });
    }
    await updateRecord(ctx, requireExtensionObject(SERIES), input.series, {
      places: input.places,
    });
    return { ok: true };
  },
});
// One batch: a class's field by hand and the series' same field, in either order.
const sameBatch = defineOperation({
  name: "fixture.sameBatch",
  description: "Test fixture: a class edit and a series edit of one field, in one batch.",
  input: z.object({
    series: z.string(),
    klass: z.string(),
    hand: z.string(),
    seriesCoach: z.string(),
    seriesFirst: z.boolean(),
  }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const editClass = () =>
      updateRecord(ctx, requireExtensionObject(KLASS), input.klass, { coach: input.hand });
    const editSeries = () =>
      updateRecord(ctx, requireExtensionObject(SERIES), input.series, {
        coach: input.seriesCoach,
      });
    if (input.seriesFirst) {
      await editSeries();
      await editClass();
    } else {
      await editClass();
      await editSeries();
    }
    return { ok: true };
  },
});
// A hand edit of one class planned, then another person's edit of another class of the series
// committed first.
const editThenEditOther = defineOperation({
  name: "fixture.editThenEditOther",
  description: "Test fixture: two hand edits of different classes of one series, racing.",
  input: z.object({ klass: z.string(), other: z.string(), now: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecord(ctx, requireExtensionObject(KLASS), input.klass, { coach: "Coach P" });
    await invoke(
      "record.update",
      { object: KLASS, id: input.other, values: { state: "cancelled" } },
      as(input.now),
    );
    return { ok: true };
  },
});
// A run of the series planned, then a hand edit of one of its classes committed first.
const runThenEdit = defineOperation({
  name: "fixture.runThenEdit",
  description: "Test fixture: a run of a series, with a hand edit committed under it.",
  input: z.object({ series: z.string(), klass: z.string(), now: z.string() }),
  output: z.object({ made: z.number(), more: z.boolean() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const result = await generateSeries(ctx, requireExtensionObject(SERIES), input.series, 2);
    await invoke(
      "record.update",
      { object: KLASS, id: input.klass, values: { coach: "Coach R" } },
      as(input.now),
    );
    return result;
  },
});
const fieldRaces = createInvoker(
  createRegistry([
    ...coreRegistry.list(),
    changeThenEdit,
    editThenChange,
    bulkEdit,
    sameBatch,
    editThenEditOther,
    runThenEdit,
  ]),
);

const setCoach = (id: string, coach: string, now: string) =>
  invoke("record.update", { object: KLASS, id, values: { coach } }, as(now));

describe("field-level exceptions (ADR 0620)", () => {
  it("a field set back by hand to the series' value follows it again; recurring.follow does it on purpose", async () => {
    const now = "2029-01-01T00:00:00.000Z";
    const id = await series({ firstDate: "2029-01-01" }, now);
    await tick(now);
    const [c0, c1] = await made(id);
    if (!c0 || !c1) throw new Error("expected classes");
    await setCoach(c0.id, "Coach B", now);
    expect((await own(c0.id)).map((r) => r[0])).toEqual(["coach"]);
    // Back to the series' own coach by hand: no longer an exception, and a later coach reaches it.
    await setCoach(c0.id, "Coach A", now);
    expect(await own(c0.id)).toEqual([]);
    await setCoach(c1.id, "Coach B", now);
    await invoke("record.update", { object: SERIES, id, values: { coach: "Coach D" } }, as(now));
    let classes = await made(id);
    expect(classes[0]?.values.coach).toBe("Coach D");
    expect(classes[1]?.values.coach).toBe("Coach B");
    expect(
      await invoke("recurring.exceptions", { object: KLASS, id: c1.id }, as(now)),
    ).toMatchObject({
      generated: true,
      series: { object: SERIES, id, date: c1.date },
      detached: false,
      fields: [{ field: "coach", setBy: admin.id, setAt: now }],
    });
    // "Follow the series": the field takes the series' value now, and follows from now on.
    expect(
      await invoke("recurring.follow", { object: KLASS, id: c1.id, fields: ["coach"] }, as(now)),
    ).toEqual({ followed: ["coach"], kept: [], reattached: false });
    classes = await made(id);
    expect(classes[1]?.values.coach).toBe("Coach D");
    expect(await own(c1.id)).toEqual([]);
    await expect(
      invoke("recurring.follow", { object: KLASS, id: c1.id, fields: ["name"] }, as(now)),
    ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "recurring_not_copied" } });
    // A one-off has nothing to follow.
    const oneOff = await invoke(
      "record.create",
      { object: KLASS, values: { name: "Open gym", startsAt: "2029-01-20T23:00:00.000Z" } },
      as(now),
    );
    expect(
      await invoke("recurring.exceptions", { object: KLASS, id: oneOff.id }, as(now)),
    ).toMatchObject({ generated: false, detached: false, fields: [] });
    await expect(
      invoke("recurring.follow", { object: KLASS, id: oneOff.id }, as(now)),
    ).rejects.toMatchObject({ details: { rule: "recurring_not_generated" } });
  });

  it("a class detached under the old rule stays detached on upgrade, and follows only when asked", async () => {
    const now = "2029-02-05T00:00:00.000Z";
    const id = await series({ firstDate: "2029-02-05" }, now);
    await tick(now);
    const [c0, c1, c2] = await made(id);
    if (!c0 || !c1 || !c2) throw new Error("expected classes");
    // c0's coach was swapped before ADR 0620: its whole occurrence marked edited, no exception.
    await setCoach(c0.id, "Coach B", now);
    await env.DB.prepare("UPDATE core_recurrence_occurrence SET edited_at = ? WHERE record_id = ?")
      .bind(now, c0.id)
      .run();
    await env.DB.prepare("DELETE FROM core_recurrence_exception WHERE record_id = ?")
      .bind(c0.id)
      .run();
    await invoke(
      "record.update",
      { object: SERIES, id, values: { places: 9, coach: "Coach C" } },
      as(now),
    );
    let classes = await made(id);
    // Nothing it had changes meaning: the series still leaves it alone.
    expect(classes[0]?.values).toMatchObject({ coach: "Coach B", places: 12 });
    expect(classes[2]?.values).toMatchObject({ coach: "Coach C", places: 9 });
    expect(
      await invoke("recurring.exceptions", { object: KLASS, id: c0.id }, as(now)),
    ).toMatchObject({ detached: true, fields: [] });
    // A person makes it follow the places again and keep its coach: the coach is its exception.
    expect(
      await invoke("recurring.follow", { object: KLASS, id: c0.id, fields: ["places"] }, as(now)),
    ).toEqual({ followed: ["places"], kept: ["coach"], reattached: true });
    classes = await made(id);
    expect(classes[0]).toMatchObject({ edited: false, values: { coach: "Coach B", places: 9 } });
    expect((await own(c0.id)).map((r) => r[0])).toEqual(["coach"]);
    await invoke(
      "record.update",
      { object: SERIES, id, values: { places: 7, coach: "Coach E" } },
      as(now),
    );
    classes = await made(id);
    expect(classes[0]?.values).toMatchObject({ coach: "Coach B", places: 7 });
    // A class moved by hand is still detached whole, and cannot follow without moving.
    const later = new Date(Date.parse(String(c1.values.startsAt)) + 3_600_000).toISOString();
    await invoke(
      "record.update",
      { object: KLASS, id: c1.id, values: { startsAt: later } },
      as(now),
    );
    classes = await made(id);
    expect(classes[1]).toMatchObject({ edited: true, values: { changed: true } });
    await expect(
      invoke("recurring.follow", { object: KLASS, id: c1.id }, as(now)),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_moved" } });
    // Cancelled (or past) classes are never changed by their series.
    await invoke(
      "record.update",
      { object: KLASS, id: c2.id, values: { state: "cancelled" } },
      as(now),
    );
    await expect(
      invoke("recurring.follow", { object: KLASS, id: c2.id }, as(now)),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_past" } });
    await invoke("record.update", { object: SERIES, id, values: { coach: "Coach F" } }, as(now));
    expect((await made(id))[2]?.values).toMatchObject({ state: "cancelled", coach: "Coach E" });
  });

  it("a date the series drops goes even with a coach swapped on it, and its exceptions with it", async () => {
    const now = "2029-03-05T00:00:00.000Z";
    const id = await series({ firstDate: "2029-03-05" }, now);
    await tick(now);
    const [first] = await made(id);
    if (!first) throw new Error("expected a class");
    await setCoach(first.id, "Coach B", now);
    const drop = new Date(`${first.date}T00:00:00Z`).getUTCDay() === 2 ? ["thu"] : ["tue"];
    await invoke("record.update", { object: SERIES, id, values: { weekdays: drop } }, as(now));
    expect((await made(id)).map((c) => c.id)).not.toContain(first.id);
    expect(await own(first.id)).toEqual([]);
  });

  it("a series change and a hand edit racing: exactly one commits, and neither is lost", async () => {
    const now = "2029-04-02T00:00:00.000Z";
    const id = await series({ firstDate: "2029-04-02" }, now);
    await tick(now);
    const [c0, c1] = await made(id);
    if (!c0 || !c1) throw new Error("expected classes");
    // The swap commits under a series change planned before it: the change fails, whole.
    await expect(
      fieldRaces.invoke(
        "fixture.changeThenEdit",
        {
          series: id,
          klass: c0.id,
          seriesValues: { coach: "Coach Z" },
          klassValues: { coach: "Coach B" },
          now,
        },
        as(now),
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_stale" } });
    let classes = await made(id);
    expect(classes[0]?.values.coach).toBe("Coach B");
    expect(classes[1]?.values.coach).toBe("Coach A");
    // Made again, it reads the swap: the swapped class keeps it, the rest follow.
    await invoke("record.update", { object: SERIES, id, values: { coach: "Coach Z" } }, as(now));
    classes = await made(id);
    expect(classes.slice(0, 3).map((c) => c.values.coach)).toEqual([
      "Coach B",
      "Coach Z",
      "Coach Z",
    ]);
    // A series change commits under a swap planned before it: the swap fails, whole.
    await expect(
      fieldRaces.invoke(
        "fixture.editThenChange",
        {
          series: id,
          klass: c1.id,
          seriesValues: { coach: "Coach W" },
          klassValues: { coach: "Coach W" },
          now,
        },
        as(now),
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_stale" } });
    classes = await made(id);
    expect(classes[1]?.values.coach).toBe("Coach W");
    expect(await own(c1.id)).toEqual([]);
  });

  it("one batch editing several classes of a series and the series itself commits", async () => {
    const now = "2029-05-07T00:00:00.000Z";
    const id = await series({ firstDate: "2029-05-07" }, now);
    await tick(now);
    const [c0, c1, c2] = await made(id);
    if (!c0 || !c1 || !c2) throw new Error("expected classes");
    await fieldRaces.invoke(
      "fixture.bulkEdit",
      { series: id, klasses: [c0.id, c1.id], coach: "Coach B", places: 5 },
      as(now),
    );
    const classes = await made(id);
    expect(classes.slice(0, 3).map((c) => [c.values.coach, c.values.places])).toEqual([
      ["Coach B", 5],
      ["Coach B", 5],
      ["Coach A", 5],
    ]);
  });

  // --- Review of PR #271 ---------------------------------------------------------------------------

  it("a hand edit and a series edit of the same field in one batch: the hand edit stands, in either order", async () => {
    const now = "2029-06-04T00:00:00.000Z";
    const id = await series({ firstDate: "2029-06-04" }, now);
    await tick(now);
    const [c0, c1] = await made(id);
    if (!c0 || !c1) throw new Error("expected classes");
    // The class first, then the series.
    await fieldRaces.invoke(
      "fixture.sameBatch",
      { series: id, klass: c0.id, hand: "HAND", seriesCoach: "NEW", seriesFirst: false },
      as(now),
    );
    let classes = await made(id);
    expect([classes[0]?.values.coach, classes[1]?.values.coach]).toEqual(["HAND", "NEW"]);
    expect((await own(c0.id)).map((r) => r[0])).toEqual(["coach"]);
    // The series first, then the class: still the hand's, and its exception.
    await fieldRaces.invoke(
      "fixture.sameBatch",
      { series: id, klass: c1.id, hand: "HAND2", seriesCoach: "NEWER", seriesFirst: true },
      as(now),
    );
    classes = await made(id);
    expect(classes.slice(0, 3).map((c) => c.values.coach)).toEqual(["HAND", "HAND2", "NEWER"]);
    expect((await own(c1.id)).map((r) => r[0])).toEqual(["coach"]);
    // A hand value equal to the series' new value in the same batch is no exception.
    const c2 = classes[2];
    if (!c2) throw new Error("expected a class");
    await fieldRaces.invoke(
      "fixture.sameBatch",
      { series: id, klass: c2.id, hand: "SAME", seriesCoach: "SAME", seriesFirst: true },
      as(now),
    );
    expect(await own(c2.id)).toEqual([]);
    // Neither class is pinned: a later change reaches the one that follows.
    await invoke("record.update", { object: SERIES, id, values: { coach: "LATER" } }, as(now));
    classes = await made(id);
    expect(classes.slice(0, 4).map((c) => c.values.coach)).toEqual([
      "HAND",
      "HAND2",
      "LATER",
      "LATER",
    ]);
  });

  it("two people editing different classes of one series at once both succeed", async () => {
    const now = "2029-07-02T00:00:00.000Z";
    const id = await series({ firstDate: "2029-07-02" }, now);
    await tick(now);
    const [c0, c1] = await made(id);
    if (!c0 || !c1) throw new Error("expected classes");
    await fieldRaces.invoke(
      "fixture.editThenEditOther",
      { klass: c0.id, other: c1.id, now },
      as(now),
    );
    const classes = await made(id);
    expect(classes[0]?.values.coach).toBe("Coach P");
    expect(classes[1]?.values.state).toBe("cancelled");
  });

  it("a run of the series and a hand edit at once both commit, and the next tick makes the rest once", async () => {
    const now = "2029-08-06T00:00:00.000Z";
    await tick(now); // Every other series in this file first.
    const id = await series({ firstDate: "2029-08-06" }, now);
    await runRecurringDue(db, { clock: () => new Date(now), maxRecords: 2 });
    const [c0] = await made(id);
    if (!c0) throw new Error("expected a class");
    const out = await fieldRaces.invoke(
      "fixture.runThenEdit",
      { series: id, klass: c0.id, now },
      { ...as(now), actor: "automation" },
    );
    expect(out).toMatchObject({ made: 2 });
    await tick(now);
    const classes = await made(id);
    expect(classes[0]?.values.coach).toBe("Coach R");
    expect(classes.map((c) => c.date)).toEqual(tuesdaysAndThursdays("2029-08-07", "2029-11-05"));
  });

  it("a series that comes to a class's own value clears its exception; an empty fields list is refused", async () => {
    const now = "2029-09-03T00:00:00.000Z";
    const id = await series({ firstDate: "2029-09-03" }, now);
    await tick(now);
    const [c0] = await made(id);
    if (!c0) throw new Error("expected a class");
    await setCoach(c0.id, "Coach B", now);
    await invoke("record.update", { object: SERIES, id, values: { coach: "Coach B" } }, as(now));
    expect(await own(c0.id)).toEqual([]);
    await invoke("record.update", { object: SERIES, id, values: { coach: "Coach C" } }, as(now));
    expect((await made(id))[0]?.values.coach).toBe("Coach C");
    await expect(
      invoke("recurring.follow", { object: KLASS, id: c0.id, fields: [] }, as(now)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reattaching leaves no exception on a field equal to the series', and refuses a state changed by hand", async () => {
    const now = "2029-10-01T00:00:00.000Z";
    const id = await series({ firstDate: "2029-10-01" }, now);
    await tick(now);
    const [c0, c1] = await made(id);
    if (!c0 || !c1) throw new Error("expected classes");
    // Detached whole before ADR 0620, with an exception row left on a field now equal to the series'.
    await env.DB.prepare("UPDATE core_recurrence_occurrence SET edited_at = ? WHERE record_id = ?")
      .bind(now, c0.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_recurrence_exception (object_type, record_id, field, set_by, set_at) VALUES (?, ?, 'places', ?, ?)",
    )
      .bind(KLASS, c0.id, admin.id, now)
      .run();
    expect(
      await invoke("recurring.follow", { object: KLASS, id: c0.id, fields: ["coach"] }, as(now)),
    ).toEqual({ followed: ["coach"], kept: [], reattached: true });
    expect(await own(c0.id)).toEqual([]);
    // Paused by hand: detached, and put back before it follows.
    await invoke(
      "record.update",
      { object: KLASS, id: c1.id, values: { state: "paused" } },
      as(now),
    );
    await expect(
      invoke("recurring.follow", { object: KLASS, id: c1.id }, as(now)),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "recurring_state" } });
  });

  it("an exception on a field the series no longer copies is cleaned up at reconcile", async () => {
    const now = "2029-11-05T00:00:00.000Z";
    const id = await series({ firstDate: "2029-11-05" }, now);
    await tick(now);
    const [c0] = await made(id);
    if (!c0) throw new Error("expected a class");
    await setCoach(c0.id, "Coach B", now);
    await env.DB.prepare(
      "INSERT INTO core_recurrence_exception (object_type, record_id, field, set_by, set_at) VALUES (?, ?, 'name', ?, ?)",
    )
      .bind(KLASS, c0.id, admin.id, now)
      .run();
    await reconcile(timetable(ext));
    expect((await own(c0.id)).map((r) => r[0])).toEqual(["coach"]);
  });
});
