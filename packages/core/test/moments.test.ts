// Date-relative triggers counted in minutes (ADR 0570): which records the minute scan finds due.
// A record is due once its moment (some minutes before or after a datetime field) has passed and
// for the look-back after it, never before and never later; the minutes are a number, or read per
// record from a field one relation away, else the extension's setting; a moment some minutes from
// an instant is a length of time, the same on both sides of a clock change. That each due record
// starts one run however many ticks see it (the key is the record and the field's value) is the
// runner's: apps/runner/test/bookings-messages.test.ts.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, MOMENT_LOOKBACK_MINUTES, recordsAtMoment } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const ext = extId("mom");
const KLASS = `${ext}.klass`;
const KIND = `${ext}.kind`;
const MINUTE = 60_000;

const fixture = manifest(ext, {
  objects: {
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        reminder: { type: "number", label: "Reminder", min: 0, max: 2880 },
      },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
      },
      indexes: [["startsAt"]],
    },
  },
  settings: {
    reminder: { type: "number", label: "Reminder", default: 180, min: 0, max: 2880 },
  },
});

let admin: ActingUser;
const ids = new Set<string>();

async function klass(values: Record<string, unknown>): Promise<string> {
  const created = await invoke(
    "record.create",
    { object: KLASS, values: { name: unique("Class"), ...values } },
    context(admin),
  );
  ids.add(created.id as string);
  return created.id as string;
}
const kind = async (reminder: number | null) =>
  (
    await invoke(
      "record.create",
      { object: KIND, values: { name: unique("Kind"), reminder } },
      context(admin),
    )
  ).id as string;

/** The ids due at `at` (ISO) among this file's classes. */
async function due(
  trigger: Parameters<typeof recordsAtMoment>[1],
  at: string,
): Promise<{ id: string; anchor: string; moment: string }[]> {
  return (await recordsAtMoment(db.query, trigger, new Date(at), 100)).filter((m) => ids.has(m.id));
}
const shift = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture);
});

describe("a number of minutes", () => {
  const START = "2027-02-10T08:00:00.000Z";
  const before = { object: KLASS, field: "startsAt", minutesBefore: 180 };

  it("is due from its moment for the look-back, and not before or after", async () => {
    const id = await klass({ startsAt: START });
    const moment = shift(START, -180);
    expect(await due(before, shift(moment, -1))).toEqual([]);
    expect(await due(before, moment)).toEqual([{ id, anchor: START, moment }]);
    expect(await due(before, shift(moment, MOMENT_LOOKBACK_MINUTES - 1))).toHaveLength(1);
    expect(await due(before, shift(moment, MOMENT_LOOKBACK_MINUTES))).toEqual([]);
    // After an end: an hour after it.
    const end = shift(START, 60);
    await invoke("record.update", { object: KLASS, id, values: { endsAt: end } }, context(admin));
    const after = { object: KLASS, field: "endsAt", minutesAfter: 60 };
    expect(await due(after, shift(end, 59))).toEqual([]);
    expect(await due(after, shift(end, 60))).toEqual([{ id, anchor: end, moment: shift(end, 60) }]);
  });

  it("is a length of time across a clock change, in a zone with a half-hour offset too", async () => {
    // Sydney goes from +10 to +11 at 02:00 on 4 October 2026: 06:00 local that day is 19:00 UTC
    // the day before, and three hours before it is 16:00 UTC (02:00 standard time, which became
    // 03:00 daylight time): three real hours, whatever the wall clock did.
    const sydney = "2026-10-03T19:00:00.000Z";
    // Adelaide (+9:30 to +10:30 the same night): 06:00 local is 19:30 UTC the day before.
    const adelaide = "2026-10-03T19:30:00.000Z";
    const a = await klass({ startsAt: sydney });
    const b = await klass({ startsAt: adelaide });
    expect((await due(before, "2026-10-03T16:00:00.000Z")).map((m) => m.id)).toEqual([a]);
    expect((await due(before, "2026-10-03T16:30:00.000Z")).map((m) => m.id)).toEqual([b]);
  });

  it("ignores a record in the Trash", async () => {
    const start = "2027-03-01T08:00:00.000Z";
    const id = await klass({ startsAt: start });
    await invoke("record.delete", { object: KLASS, id }, context(admin));
    expect(await due(before, shift(start, -180))).toEqual([]);
  });
});

describe("minutes read per record", () => {
  const trigger = {
    object: KLASS,
    field: "startsAt",
    minutesBefore: { field: "kind.reminder", setting: "reminder" },
  };

  it("reads the related record's number, else the setting; with neither, nothing is due", async () => {
    const start = "2027-04-01T09:00:00.000Z";
    const own = await klass({ startsAt: start, kind: await kind(60) });
    const fallback = await klass({ startsAt: start, kind: await kind(null) });
    const none = await klass({ startsAt: start });
    // No setting stored and no installed manifest to default from: only the own number counts.
    expect((await due(trigger, shift(start, -180))).map((m) => m.id)).toEqual([]);
    expect((await due(trigger, shift(start, -60))).map((m) => m.id)).toEqual([own]);
    await env.DB.prepare(
      "INSERT INTO core_extension_settings (extension_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (extension_id) DO UPDATE SET value = excluded.value",
    )
      .bind(ext, JSON.stringify({ reminder: 120 }), new Date().toISOString())
      .run();
    expect((await due(trigger, shift(start, -120))).map((m) => m.id).sort()).toEqual(
      [fallback, none].sort(),
    );
    expect((await due(trigger, shift(start, -60))).map((m) => m.id)).toEqual([own]);
  });
});

describe("the contract check", () => {
  const withAutomation = (trigger: Record<string, unknown>) =>
    validateManifest({
      ...fixture,
      permissions: { read: [], write: [], operations: [], modules: ["ops"] },
      automations: {
        remind: {
          label: "Remind",
          description: "A reminder.",
          trigger,
          steps: [{ name: "go" }],
        },
      },
    } as never);
  const messages = (trigger: Record<string, unknown>) =>
    withAutomation(trigger).issues.map((i) => `${i.path}: ${i.message}`);

  it("takes a number or a field and setting, before or after a datetime", () => {
    expect(
      messages({ type: "dateRelative", object: KLASS, field: "startsAt", minutesBefore: 180 }),
    ).toEqual([]);
    expect(
      messages({
        type: "dateRelative",
        object: KLASS,
        field: "startsAt",
        minutesBefore: { field: "kind.reminder", setting: "reminder" },
      }),
    ).toEqual([]);
  });

  it("names what is wrong", () => {
    const issues = [
      messages({ type: "dateRelative", object: KLASS, field: "startsAt" }),
      messages({
        type: "dateRelative",
        object: KLASS,
        field: "startsAt",
        offsetDays: -1,
        minutesBefore: 60,
      }),
      messages({ type: "dateRelative", object: KLASS, field: "name", minutesAfter: 60 }),
      messages({
        type: "dateRelative",
        object: KLASS,
        field: "startsAt",
        minutesBefore: { field: "kind.name" },
      }),
      messages({
        type: "dateRelative",
        object: KLASS,
        field: "startsAt",
        minutesBefore: { setting: "missing" },
      }),
      messages({
        type: "dateRelative",
        object: KLASS,
        field: "startsAt",
        minutesBefore: 60,
        zoneField: "name",
      }),
    ];
    expect(issues[0]?.join()).toMatch(/exactly one of offsetDays, minutesBefore and minutesAfter/);
    expect(issues[1]?.join()).toMatch(/exactly one/);
    expect(issues[2]?.join()).toMatch(/must be datetime/);
    expect(issues[3]?.join()).toMatch(/must be a number field/);
    expect(issues[4]?.join()).toMatch(/must be a number setting/);
    expect(issues[5]?.join()).toMatch(/zoneField counts days/);
  });
});
