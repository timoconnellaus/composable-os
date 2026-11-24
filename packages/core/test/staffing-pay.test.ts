// Stage 45 step 6 (ADR 0627): pay periods. Who is counted, a period's lines and totals from the
// roster, the not-worked mark, the lock (refused for every writer and statement shape), reopening
// and versions, the export, and pay kept from everyone but a person who handles pay. Acceptance
// criterion 10, and criterion 8's "an AI actor is refused pay tools whatever is granted".
//
// The fixture is worked out by hand: a fortnight (the default period) in Sydney from Monday 30
// March 2026, across the clock change of Sunday 5 April (03:00 daylight time becomes 02:00
// standard time), with an hourly coach, a per-class coach, a salaried coach and an hourly cleaner;
// a cancelled class, a class marked not worked, a class taken mid-period, a class type with
// set-up and pack-down minutes, a duty across midnight, a class across the clock change, and a
// class whose list someone else took. Every operation is called as a shipped pack's tool run
// would call it (the extension's account as `ctx.user`, the person as the verified caller).
// Every clock is injected.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getObject, invokeByName, objectTableOf } from "../src/index.ts";
import {
  csvText,
  fingerprintGuards,
  hoursOf,
  periodContaining,
  periodFingerprint,
  periodFor,
  readFingerprint,
  type StoredPeriod,
} from "../src/staffing/pay.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ext = extId("stpay");
const COACH = `${ext}.coach`;
const KIND = `${ext}.kind`;
const KLASS = `${ext}.klass`;
const DUTY = `${ext}.duty`;
const BOOKING = `${ext}.booking`;
const ZONE = "Australia/Sydney";

const fixture = manifest(ext, {
  objects: {
    coach: {
      label: "Coach",
      plural: "Coaches",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        user: { type: "user", label: "Staff account" },
      },
      unique: [{ fields: ["user"] }],
    },
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        before: { type: "number", label: "Set-up minutes" },
        after: { type: "number", label: "Pack-down minutes" },
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
        timezone: { type: "timezone", label: "Time zone" },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        notes: { type: "longText", label: "Notes" },
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
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        zone: "timezone",
        kind: "kind",
        live: ["scheduled", "done"],
        payBefore: { field: "kind.before" },
        payAfter: { field: "kind.after" },
        evidence: { object: "booking", link: "klass", by: "markedBy" },
      },
      indexes: [["startsAt"]],
    },
    booking: {
      label: "Booking",
      plural: "Bookings",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        klass: { type: "relation", label: "Class", to: `${ext}.klass` },
        markedBy: { type: "user", label: "Marked by" },
      },
      indexes: [["klass"]],
    },
    duty: {
      label: "Duty shift",
      plural: "Duty shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Duty", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        place: { type: "text", label: "Place" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          { from: "scheduled", to: "cancelled", by: ["staff"] },
          { from: "cancelled", to: "scheduled", by: ["staff"] },
        ],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
        place: "place",
      },
      indexes: [["startsAt"]],
    },
  },
});

/** The installed manifest's parts the host reads: who rosters and pays, and the pay settings. */
const installed = {
  grantable: [`${ext}:manage`, `${ext}:pay`],
  restricted: [`${ext}:manage`, `${ext}:pay`],
  settings: {
    payPeriod: { type: "select", label: "Pay period", default: "fortnightly" },
    payPeriodStart: { type: "text", label: "Starts" },
    payPeriodDay: { type: "number", label: "Day", default: 1 },
  },
  staffing: {
    rosters: `${ext}:manage`,
    pays: `${ext}:pay`,
    settings: {
      payPeriod: "payPeriod",
      payPeriodStart: "payPeriodStart",
      payPeriodDay: "payPeriodDay",
    },
  },
};

// Before every shift below; the period's end is 13 April 00:00 Sydney (12 April 14:00 UTC).
const BEFORE = "2026-03-01T00:00:00.000Z";
const AFTER = "2026-04-20T00:00:00.000Z";
const START = "2026-03-30";
const STAFFING = [
  "staffing.offer",
  "staffing.take",
  "staffing.qualify",
  "staffing.markNotWorked",
  "staffing.payBasis",
  "staffing.payBases",
  "staffing.payPeriod.list",
  "staffing.payPeriod.totals",
  "staffing.payPeriod.lock",
  "staffing.payPeriod.reopen",
  "staffing.payPeriod.export",
  "staffing.myPay",
  "staffing.myPay.periods",
];

let admin: ActingUser;
let extUser: ActingUser;
const as = (user: ActingUser, now = AFTER) => context(user, { clock: () => new Date(now) });
type ToolFlags = { humanOnly?: boolean; personApproves?: boolean; actor?: string };
const tool = (user: ActingUser, flags: ToolFlags = { humanOnly: true }, now = AFTER) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: STAFFING, objects: {} } as never,
      tool: {
        name: "pay",
        humanOnly: flags.humanOnly ?? false,
        ...(flags.personApproves ? { personApproves: true } : {}),
        permission: `${ext}:pay`,
        calledBy: { account: user.id, actor: flags.actor ?? "human" },
      },
    },
  });
const pay = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  user = admin,
  now = AFTER,
) => invokeByName(name, input, tool(user, { humanOnly: true }, now)) as Promise<T>;
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; message: string; details?: Record<string, unknown> };
}

/** A local Sydney wall-clock time as an ISO instant. */
const sydney = (local: string) => {
  // Daylight time (+11:00) until 03:00 on 5 April 2026, standard time (+10:00) after.
  const offset = local < "2026-04-05T03:00" ? "+11:00" : "+10:00";
  return new Date(`${local}:00${offset}`).toISOString();
};

async function create(object: string, values: Record<string, unknown>, now = BEFORE) {
  return (
    (await invokeByName("record.create", { object, values }, as(admin, now))) as { id: string }
  ).id;
}
async function update(object: string, id: string, values: Record<string, unknown>, now = AFTER) {
  return invokeByName("record.update", { object, id, values }, as(admin, now));
}
const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;

const people: Record<string, ActingUser> = {};
const profile: Record<string, string> = {};
const shifts: Record<string, string> = {};
let strength: string;
let yoga: string;
let cleaning: string;

async function klass(key: string, coach: string, kind: string, from: string, to: string) {
  shifts[key] = await create(KLASS, {
    name: key,
    kind,
    coach: profile[coach],
    startsAt: sydney(from),
    endsAt: sydney(to),
    timezone: ZONE,
  });
}

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE), BEFORE)
    .run();
  await reconcile(fixture, BEFORE);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, BEFORE, BEFORE)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_extension_settings (extension_id, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify({ payPeriodStart: START }), BEFORE, admin.id)
    .run();

  for (const name of ["Hourly Ari", "Class Bo", "Salaried Cy", "Cleaner Di"]) {
    const user = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET name = ? WHERE id = ?").bind(name, user.id).run();
    const key = name.split(" ")[1] as string;
    people[key] = { ...user, name };
    if (key !== "Di") profile[key] = await create(COACH, { name, user: user.id });
  }
  strength = await create(KIND, { name: "Strength", before: 10, after: 5 });
  yoga = await create(KIND, { name: "Yoga" });
  cleaning = await create(KIND, { name: "Cleaning" });

  // Who is counted: Ari by time, Bo by class, Cy not counted (salaried); Di not counted until 6
  // April, by time from then.
  await pay(
    "staffing.payBasis",
    { account: people.Ari?.id, basis: "by_time", from: "2026-01-01" },
    admin,
    BEFORE,
  );
  await pay(
    "staffing.payBasis",
    { account: people.Bo?.id, basis: "by_class", from: "2026-01-01" },
    admin,
    BEFORE,
  );
  await pay(
    "staffing.payBasis",
    { account: people.Cy?.id, basis: "not_counted", from: "2026-01-01" },
    admin,
    BEFORE,
  );
  await pay(
    "staffing.payBasis",
    { account: people.Di?.id, basis: "by_time", from: "2026-04-06" },
    admin,
    BEFORE,
  );

  await klass("K0", "Ari", yoga, "2026-03-29T23:00", "2026-03-30T00:00"); // the period before
  await klass("K1", "Ari", strength, "2026-03-30T06:00", "2026-03-30T07:00");
  await klass("K2", "Ari", strength, "2026-04-01T18:00", "2026-04-01T19:00"); // cancelled
  await klass("K3", "Ari", yoga, "2026-04-02T07:00", "2026-04-02T08:00"); // not worked
  await klass("K4", "Ari", yoga, "2026-04-04T09:00", "2026-04-04T10:30"); // taken by Bo
  await klass("K5", "Bo", strength, "2026-04-05T01:30", "2026-04-05T03:30"); // the clock change
  await klass("K6", "Cy", strength, "2026-03-30T08:00", "2026-03-30T09:00"); // not counted
  await klass("K7", "Ari", yoga, "2026-04-12T23:30", "2026-04-13T00:30"); // the last evening
  await klass("K8", "Ari", yoga, "2026-04-13T00:30", "2026-04-13T01:30"); // the next period
  shifts.D1 = await create(DUTY, {
    name: "Close-down clean",
    kind: cleaning,
    staff: people.Di?.id,
    startsAt: sydney("2026-04-10T22:00"),
    endsAt: sydney("2026-04-11T01:10"),
    place: '=HYPERLINK("x")',
  });
  shifts.D0 = await create(DUTY, {
    name: "Close-down clean",
    kind: cleaning,
    staff: people.Di?.id,
    startsAt: sydney("2026-04-01T22:00"),
    endsAt: sydney("2026-04-01T23:00"),
  });
  await update(KLASS, shifts.K2 as string, { state: "cancelled" }, BEFORE);
  // K4: offered by Ari, taken by Bo on 3 April (Bo qualified for Yoga).
  await invokeByName(
    "staffing.qualify",
    { account: people.Bo?.id, kind: { object: KIND, id: yoga } },
    tool(admin, { personApproves: true }, BEFORE),
  );
  const offered = (await invokeByName(
    "staffing.offer",
    { object: KLASS, id: shifts.K4 },
    tool(people.Ari as ActingUser, { humanOnly: true }, "2026-04-02T00:00:00.000Z"),
  )) as { offer: { id: string } };
  await invokeByName(
    "staffing.take",
    { offer: offered.offer.id },
    tool(people.Bo as ActingUser, { humanOnly: true }, "2026-04-03T00:00:00.000Z"),
  );
  // K3 nobody ran: marked not worked by a rosterer (the admin), after it started.
  await invokeByName(
    "staffing.markNotWorked",
    { object: KLASS, id: shifts.K3, reason: "Nobody ran it" },
    tool(admin, { personApproves: true }, "2026-04-03T00:00:00.000Z"),
  );
  // The lists: Ari took K1's (their own); Ari took K5's, which is Bo's (flagged).
  await create(BOOKING, { name: "b1", klass: shifts.K1, markedBy: people.Ari?.id });
  await create(BOOKING, { name: "b2", klass: shifts.K5, markedBy: people.Ari?.id });
}, 120_000);

type Line = {
  name: string;
  title: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  shiftMinutes: number;
  countedMinutes: number;
  counted: boolean;
  notWorkedReason: string | null;
  listTaken: boolean | null;
  flagged: boolean;
  basis: string;
};
type Total = {
  name: string;
  basis: string;
  kindName: string;
  shifts: number;
  minutes: number;
  hours: string;
  notWorked: number;
  flagged: number;
};
type Totals = {
  period: {
    start: string;
    end: string;
    locked: boolean;
    preview: boolean;
    version: { version: number } | null;
  };
  totals: Total[];
  lines: Line[];
  minutes: number;
  hours: string;
};

/** The fixture worked out by hand. */
const EXPECTED_TOTALS = [
  // Ari, by time: K1 (60 + 10 set-up + 5 pack-down); K3 not worked (nothing); K7 (60).
  {
    name: "Hourly Ari",
    basis: "by_time",
    kindName: "Strength",
    shifts: 1,
    minutes: 75,
    hours: "1.25",
    notWorked: 0,
    flagged: 0,
  },
  {
    name: "Hourly Ari",
    basis: "by_time",
    kindName: "Yoga",
    shifts: 1,
    minutes: 60,
    hours: "1.00",
    notWorked: 1,
    flagged: 0,
  },
  // Bo, by class: K4 taken (90); K5 across the clock change, 3 real hours (180 + 15), flagged.
  {
    name: "Class Bo",
    basis: "by_class",
    kindName: "Yoga",
    shifts: 1,
    minutes: 90,
    hours: "1.50",
    notWorked: 0,
    flagged: 0,
  },
  {
    name: "Class Bo",
    basis: "by_class",
    kindName: "Strength",
    shifts: 1,
    minutes: 195,
    hours: "3.25",
    notWorked: 0,
    flagged: 1,
  },
  // Di, by time from 6 April: D1 across midnight, 22:00 to 01:10 (190 minutes = 3.17 hours).
  {
    name: "Cleaner Di",
    basis: "by_time",
    kindName: "Cleaning",
    shifts: 1,
    minutes: 190,
    hours: "3.17",
    notWorked: 0,
    flagged: 0,
  },
];

describe("a pay period's totals (criterion 10)", () => {
  it("are worked out from the roster exactly as by hand", async () => {
    const out = await pay<Totals>("staffing.payPeriod.totals", { start: START });
    expect(out.period).toMatchObject({
      start: "2026-03-30",
      end: "2026-04-12",
      locked: false,
      preview: true,
    });
    expect(
      out.totals.map(({ name, basis, kindName, shifts, minutes, hours, notWorked, flagged }) => ({
        name,
        basis,
        kindName,
        shifts,
        minutes,
        hours,
        notWorked,
        flagged,
      })),
    ).toEqual(
      [...EXPECTED_TOTALS]
        .sort((a, b) => a.name.localeCompare(b.name) || 0)
        .filter(() => true)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(out.minutes).toBe(75 + 60 + 90 + 195 + 190);
    expect(out.hours).toBe(hoursOf(610));
    const byTitle = new Map(out.lines.map((l) => [l.title, l]));
    // Left out: the period before (K0), cancelled (K2), not counted (K6), the next period (K8),
    // Di before her basis began (D0).
    expect([...byTitle.keys()].sort()).toEqual(["Close-down clean", "K1", "K3", "K4", "K5", "K7"]);
    expect(byTitle.get("K5")).toMatchObject({
      localStart: "2026-04-05 01:30",
      localEnd: "2026-04-05 03:30",
      shiftMinutes: 180,
      countedMinutes: 195,
      listTaken: true,
      flagged: true,
      name: "Class Bo",
    });
    expect(byTitle.get("K3")).toMatchObject({
      counted: false,
      countedMinutes: 0,
      notWorkedReason: "Nobody ran it",
    });
    expect(byTitle.get("K1")).toMatchObject({ listTaken: true, flagged: false });
    expect(byTitle.get("K4")).toMatchObject({ name: "Class Bo", listTaken: false });
    expect(byTitle.get("K7")).toMatchObject({
      localDate: "2026-04-12",
      localEnd: "2026-04-13 00:30",
    });
    expect(byTitle.get("Close-down clean")).toMatchObject({
      listTaken: null,
      localDate: "2026-04-10",
      shiftMinutes: 190,
    });
  });

  it("the period follows the setting: fortnightly from its start date, weekly, monthly", () => {
    const base = { zone: ZONE, day: 1, start: START };
    expect(periodContaining({ ...base, period: "fortnightly" }, "2026-04-12")).toMatchObject({
      start: "2026-03-30",
      end: "2026-04-12",
    });
    expect(periodContaining({ ...base, period: "fortnightly" }, "2026-03-29")).toMatchObject({
      start: "2026-03-16",
      end: "2026-03-29",
    });
    expect(periodContaining({ ...base, period: "weekly" }, "2026-04-06")).toMatchObject({
      start: "2026-04-06",
      end: "2026-04-12",
    });
    expect(periodContaining({ ...base, period: "monthly", day: 15 }, "2026-01-10")).toMatchObject({
      start: "2025-12-15",
      end: "2026-01-14",
    });
    expect(
      periodContaining({ ...base, period: "fortnightly", start: null }, "2026-04-06"),
    ).toBeNull();
    // The fortnight across the clock change is 14 days and one hour of real time.
    const p = periodContaining({ ...base, period: "fortnightly" }, "2026-04-01");
    expect(p && p.ends - p.starts).toBe(14 * 86_400 + 3600);
  });

  it("hours are whole minutes ÷ 60, rounded half up to two places", () => {
    expect([0, 1, 7, 45, 59, 61, 190, 195, 1000].map(hoursOf)).toEqual([
      "0.00",
      "0.02",
      "0.12",
      "0.75",
      "0.98",
      "1.02",
      "3.17",
      "3.25",
      "16.67",
    ]);
  });

  it("the CSV matches the totals line by line, with formula-looking text neutralised", async () => {
    const out = await pay<{ csv: string; locked: boolean; filename: string }>(
      "staffing.payPeriod.export",
      { start: START },
    );
    expect(out.locked).toBe(false);
    expect(out.filename).toBe("pay-2026-03-30-to-2026-04-12-preview.csv");
    const rows = out.csv.trimEnd().split("\r\n");
    expect(rows[0]).toContain("PREVIEW");
    // Every text cell quoted; numbers as they are.
    const csv = (...cells: (string | number | { n: string })[]) =>
      cells
        .map((c) =>
          typeof c === "object"
            ? c.n
            : typeof c === "number"
              ? String(c)
              : `"${c.replaceAll('"', '""')}"`,
        )
        .join(",");
    expect(rows[1]).toBe(
      csv(
        "period start",
        "period end",
        "name",
        "staff email",
        "basis",
        "kind",
        "shifts",
        "hours",
        "minutes",
      ),
    );
    const summary = rows.slice(2, 2 + EXPECTED_TOTALS.length);
    const email = (key: string) => people[key]?.email as string;
    const P = ["2026-03-30", "2026-04-12"] as const;
    expect(summary).toEqual([
      csv(...P, "Class Bo", email("Bo"), "by class", "Yoga", 1, { n: "1.50" }, 90),
      csv(...P, "Class Bo", email("Bo"), "by class", "Strength", 1, { n: "3.25" }, 195),
      csv(...P, "Cleaner Di", email("Di"), "by time", "Cleaning", 1, { n: "3.17" }, 190),
      csv(...P, "Hourly Ari", email("Ari"), "by time", "Strength", 1, { n: "1.25" }, 75),
      csv(...P, "Hourly Ari", email("Ari"), "by time", "Yoga", 1, { n: "1.00" }, 60),
    ]);
    expect(rows[2 + EXPECTED_TOTALS.length]).toBe("");
    expect(rows[3 + EXPECTED_TOTALS.length]).toBe(
      csv(
        "name",
        "staff email",
        "date",
        "start",
        "end",
        "kind",
        "title",
        "place",
        "minutes counted",
        "not worked",
        "list taken",
        "taken by",
        "for review",
        "note",
      ),
    );
    const lines = rows.slice(4 + EXPECTED_TOTALS.length);
    expect(lines).toEqual([
      csv(
        "Class Bo",
        email("Bo"),
        "2026-04-04",
        "2026-04-04 09:00",
        "2026-04-04 10:30",
        "Yoga",
        "K4",
        "",
        90,
        "",
        "no",
        "",
        "",
        "",
      ),
      // Across the clock change: two hours on the clock, three worked, and the line says so.
      csv(
        "Class Bo",
        email("Bo"),
        "2026-04-05",
        "2026-04-05 01:30",
        "2026-04-05 03:30",
        "Strength",
        "K5",
        "",
        195,
        "",
        "yes",
        "Hourly Ari",
        "yes",
        "Crosses a clock change: 2026-04-05 01:30 to 2026-04-05 03:30 on the clock is 120 minutes, 180 minutes were worked.",
      ),
      csv(
        "Cleaner Di",
        email("Di"),
        "2026-04-10",
        "2026-04-10 22:00",
        "2026-04-11 01:10",
        "Cleaning",
        "Close-down clean",
        '\'=HYPERLINK("x")',
        190,
        "",
        "",
        "",
        "",
        "",
      ),
      csv(
        "Hourly Ari",
        email("Ari"),
        "2026-03-30",
        "2026-03-30 06:00",
        "2026-03-30 07:00",
        "Strength",
        "K1",
        "",
        75,
        "",
        "yes",
        "Hourly Ari",
        "",
        "",
      ),
      csv(
        "Hourly Ari",
        email("Ari"),
        "2026-04-02",
        "2026-04-02 07:00",
        "2026-04-02 08:00",
        "Yoga",
        "K3",
        "",
        0,
        "Nobody ran it",
        "no",
        "",
        "",
        "",
      ),
      csv(
        "Hourly Ari",
        email("Ari"),
        "2026-04-12",
        "2026-04-12 23:30",
        "2026-04-13 00:30",
        "Yoga",
        "K7",
        "",
        60,
        "",
        "no",
        "",
        "",
        "",
      ),
    ]);
  });

  it("a text cell a spreadsheet would run is neutralised, and every text cell is quoted", () => {
    const cases: [string, string][] = [
      ["+1", `"'+1"`],
      ["-2", `"'-2"`],
      ["@x", `"'@x"`],
      ["=1", `"'=1"`],
      [" =1", `"' =1"`],
      ["\uFF1D1+1", `"'\uFF1D1+1"`],
      ["a;=1+1", `"'a;=1+1"`],
      ["\t=1", `"'\t=1"`],
      ["\r=1", `"'\r=1"`],
      ["\tplain", `"'\tplain"`],
      ["x\r=1", `"'x\r=1"`],
      ["a,b", `"a,b"`],
      ['say "hi"', `"say ""hi"""`],
      ["plain", `"plain"`],
      ["", `""`],
    ];
    for (const [value, cell] of cases) expect(csvText(value), JSON.stringify(value)).toBe(cell);
  });
});

describe("only a person who handles pay (criterion 8)", () => {
  it("an AI actor is refused every pay operation, whatever is granted", async () => {
    const granted = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify([`${ext}:pay`]), granted.id)
      .run();
    for (const user of [admin, granted]) {
      for (const [name, input] of [
        ["staffing.payPeriod.totals", { start: START }],
        ["staffing.payPeriod.export", { start: START }],
        ["staffing.payPeriod.list", {}],
        ["staffing.payBases", {}],
        ["staffing.payBasis", { account: user.id, basis: "by_time" }],
        ["staffing.payPeriod.lock", { start: START }],
        ["staffing.payPeriod.reopen", { start: START, reason: "x" }],
      ] as const) {
        // An assistant (or MCP) acting for them, even through a tool that is a person's only.
        for (const actor of ["assistant", "mcp"]) {
          const e = await refusal(
            invokeByName(name, input, tool(user, { humanOnly: true, actor })),
          );
          expect(e.code, `${name} ${actor}`).toBe("forbidden");
          expect(e.details?.rule).toBe("human_only");
        }
        // A tool that lets an AI call it is refused too, even when a person calls it.
        const e = await refusal(invokeByName(name, input, tool(user, { personApproves: true })));
        expect(e.details?.rule, name).toBe("human_only");
      }
    }
  });

  it("a member is refused until granted the pay permission; an admin holds it", async () => {
    const member = await createUser("member");
    const e = await refusal(pay("staffing.payPeriod.totals", { start: START }, member));
    expect(e.code).toBe("forbidden");
    expect(e.details?.rule).toBe("pay");
    // Rostering alone is not pay.
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify([`${ext}:manage`]), member.id)
      .run();
    expect(
      (await refusal(pay("staffing.payPeriod.totals", { start: START }, member))).details?.rule,
    ).toBe("pay");
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify([`${ext}:pay`]), member.id)
      .run();
    const out = await pay<Totals>("staffing.payPeriod.totals", { start: START }, member);
    expect(out.totals.length).toBe(EXPECTED_TOTALS.length);
    // A person, MCP or the assistant calling the host directly: no such operation.
    for (const actor of ["human", "assistant", "mcp"] as const) {
      const direct = await refusal(
        invokeByName("staffing.payPeriod.totals", { start: START }, context(admin, { actor })),
      );
      expect(direct.code).toBe("unknown_operation");
    }
  });

  it("marking a shift not worked is a rosterer's, applied by a person, after it started", async () => {
    const member = await createUser("member");
    const e = await refusal(
      invokeByName(
        "staffing.markNotWorked",
        { object: KLASS, id: shifts.K1, reason: "x" },
        tool(member, { personApproves: true }, "2026-04-03T00:00:00.000Z"),
      ),
    );
    expect(e.details?.rule).toBe("rostering");
    const ai = await refusal(
      invokeByName(
        "staffing.markNotWorked",
        { object: KLASS, id: shifts.K1, reason: "x" },
        tool(admin, {}, "2026-04-03T00:00:00.000Z"),
      ),
    );
    expect(ai.details?.rule).toBe("person_applies");
    const early = await refusal(
      invokeByName(
        "staffing.markNotWorked",
        { object: KLASS, id: shifts.K7, reason: "x" },
        tool(admin, { personApproves: true }, "2026-04-03T00:00:00.000Z"),
      ),
    );
    expect(early.details?.rule).toBe("shift_not_started");
  });
});

// --- A person's own totals (the owner's decision of 2026-11-24, ADR 0627's amendment) ------------

type MyPay = {
  period: { start: string; end: string; locked: boolean; preview: boolean; version: number | null };
  counted: boolean;
  basis: string;
  totals: Record<string, unknown>[];
  lines: (Record<string, unknown> & { title: string; clockChange: string | null })[];
  minutes: number | null;
  hours: string | null;
};
type HolderLine = Line & {
  account: string;
  object: string;
  id: string;
  kindName: string;
  place: string | null;
  beforeMinutes: number;
  afterMinutes: number;
};
type HolderTotal = Total & { account: string; kind: unknown };

/** A person's own totals, as Rostering's `myPay` asks for them: their own act, at the screen. */
const myPay = (user: ActingUser, input: Record<string, unknown> = { start: START }, now = AFTER) =>
  invokeByName("staffing.myPay", input, tool(user, { humanOnly: true }, now)) as Promise<MyPay>;

/** The pay holder's figures for one person, in the shape a person's own read gives them. */
async function holderFor(user: ActingUser, start = START) {
  const all = await pay<
    Omit<Totals, "lines" | "totals"> & {
      lines: HolderLine[];
      totals: HolderTotal[];
    }
  >("staffing.payPeriod.totals", { start });
  const lines = all.lines.filter((l) => l.account === user.id);
  return {
    period: all.period,
    totals: all.totals
      .filter((t) => t.account === user.id)
      .map(({ basis, kind, kindName, shifts, minutes, hours, notWorked, flagged }) => ({
        basis,
        kind,
        kindName,
        shifts,
        minutes,
        hours,
        notWorked,
        flagged,
      })),
    lines: lines.map((l) => ({
      object: l.object,
      id: l.id,
      title: l.title,
      kindName: l.kindName,
      basis: l.basis,
      place: l.place,
      localDate: l.localDate,
      localStart: l.localStart,
      localEnd: l.localEnd,
      shiftMinutes: l.shiftMinutes,
      beforeMinutes: l.beforeMinutes,
      afterMinutes: l.afterMinutes,
      countedMinutes: l.countedMinutes,
      notWorked: !l.counted,
      listTaken: l.listTaken,
      flagged: l.flagged,
    })),
    minutes: lines.reduce((sum, l) => sum + l.countedMinutes, 0),
  };
}

/** A person's figures equal the pay holder's for them, line by line and in total. */
async function expectSameAsHolder(user: ActingUser) {
  const own = await myPay(user);
  const holder = await holderFor(user);
  expect(own.counted).toBe(true);
  expect(own.period).toMatchObject({
    start: holder.period.start,
    end: holder.period.end,
    locked: holder.period.locked,
    preview: holder.period.preview,
    version: holder.period.version?.version ?? null,
  });
  expect(own.totals).toEqual(holder.totals);
  expect(own.lines.map(({ clockChange: _c, ...rest }) => rest)).toEqual(holder.lines);
  expect(own.minutes).toBe(holder.minutes);
  expect(own.hours).toBe(hoursOf(holder.minutes));
  return own;
}

const myPayRefused = (name: string, ctx: Parameters<typeof invokeByName>[2]) =>
  refusal(invokeByName(name, name === "staffing.myPay" ? { start: START } : {}, ctx));

describe("a person's own totals, an open period (the owner's decision of 2026-11-24)", () => {
  it("equal the pay holder's figures for them, across the clock change, for each person", async () => {
    const ari = await expectSameAsHolder(people.Ari as ActingUser);
    expect(ari.period).toMatchObject({ locked: false, preview: true, version: null });
    expect(ari.basis).toBe("by_time");
    expect(ari.lines.map((l) => l.title).sort()).toEqual(["K1", "K3", "K7"]);
    const bo = await expectSameAsHolder(people.Bo as ActingUser);
    expect(bo.basis).toBe("by_class");
    const k5 = bo.lines.find((l) => l.title === "K5");
    // 01:30 to 03:30 on the night the clocks go back is three hours worked.
    expect(k5).toMatchObject({ shiftMinutes: 180, countedMinutes: 195, flagged: true });
    expect(k5?.clockChange).toMatch(/clock change/);
    // Di is counted from 6 April: the shift before it is no line, the one after is.
    const di = await expectSameAsHolder(people.Di as ActingUser);
    expect(di.lines.map((l) => l.localDate)).toEqual(["2026-04-10"]);
  });

  it("show that a shift was not worked, never why; and not who took a class's list", async () => {
    const ari = await myPay(people.Ari as ActingUser);
    const k3 = ari.lines.find((l) => l.title === "K3");
    expect(k3).toMatchObject({ notWorked: true, countedMinutes: 0 });
    const text = JSON.stringify(ari);
    expect(text).not.toContain("Nobody ran it");
    expect(text).not.toMatch(/notWorkedReason|markedBy|reason/);
    // Bo's K5 list was taken by Ari: Bo sees it flagged, not by whom.
    const bo = JSON.stringify(await myPay(people.Bo as ActingUser));
    expect(bo).not.toContain("Hourly Ari");
    expect(bo).not.toContain(people.Ari?.id as string);
  });

  it("are the caller's only: no input names anyone else, and nothing of anyone else is given", async () => {
    // An account in the input is not an input: the answer is still the caller's own.
    const asked = await myPay(people.Ari as ActingUser, { start: START, account: people.Bo?.id });
    expect(asked.lines.map((l) => l.title).sort()).toEqual(["K1", "K3", "K7"]);
    const text = JSON.stringify(asked);
    for (const other of [people.Bo, people.Cy, people.Di]) {
      expect(text).not.toContain(other?.id as string);
      expect(text).not.toContain(other?.name as string);
    }
    expect(text).not.toMatch(/"account"|"email"|"name"/);
  });

  it("someone not counted is told so, with no figures", async () => {
    const cy = await myPay(people.Cy as ActingUser);
    expect(cy).toMatchObject({ counted: false, basis: "not_counted", totals: [], lines: [] });
    expect(cy.minutes).toBeNull();
    expect(cy.hours).toBeNull();
    // Someone with no basis at all: the same.
    const nobody = await createUser("member");
    expect(await myPay(nobody)).toMatchObject({ counted: false, lines: [], minutes: null });
  });

  it("the current period when no start is given; a date that is not a period's start is refused", async () => {
    const now = await myPay(people.Ari as ActingUser, {}, "2026-04-05T00:00:00.000Z");
    expect(now.period.start).toBe(START);
    const wrong = await refusal(myPay(people.Ari as ActingUser, { start: "2026-04-01" }));
    expect(wrong.code).toBe("invalid_input");
  });

  it("the periods list is dates and state only, the current one and at most twelve before", async () => {
    const list = (await invokeByName(
      "staffing.myPay.periods",
      {},
      tool(people.Cy as ActingUser),
    )) as { set: boolean; periods: Record<string, unknown>[] };
    expect(list.set).toBe(true);
    expect(list.periods).toHaveLength(13);
    expect(list.periods[0]).toMatchObject({ start: "2026-04-13", state: "open", version: null });
    for (const p of list.periods) {
      expect(Object.keys(p).sort()).toEqual(["end", "ended", "start", "state", "version", "zone"]);
    }
    const e = await refusal(
      invokeByName("staffing.myPay.periods", { count: 13 }, tool(people.Cy as ActingUser)),
    );
    expect(e.code).toBe("invalid_input");
  });

  it("an assistant, MCP, an automation and a person calling the host directly are refused", async () => {
    for (const name of ["staffing.myPay", "staffing.myPay.periods"]) {
      for (const actor of ["assistant", "mcp"]) {
        const e = await myPayRefused(
          name,
          tool(people.Ari as ActingUser, { humanOnly: true, actor }),
        );
        expect(e.details?.rule, `${name} ${actor}`).toBe("human_only");
      }
      // A tool an AI may call is refused even when a person calls it.
      const ai = await myPayRefused(name, tool(people.Ari as ActingUser, { personApproves: true }));
      expect(ai.details?.rule, name).toBe("human_only");
      // An automation's run calls no tool for anyone.
      const automation = await myPayRefused(
        name,
        context(extUser, {
          actor: "extension",
          clock: () => new Date(AFTER),
          extension: {
            id: ext,
            permissions: { operations: STAFFING, objects: {} } as never,
            tool: { name: "pay", humanOnly: true, permission: `${ext}:team` },
          },
        }),
      );
      expect(automation.details?.rule, name).toBe("staff_caller");
      for (const actor of ["human", "assistant", "mcp"] as const) {
        const direct = await myPayRefused(name, context(admin, { actor }));
        expect(direct.code).toBe("unknown_operation");
      }
    }
  });

  it("another shipped pack's own tool, and a runtime extension's, are refused (the operation's own guard)", async () => {
    const relay = extId("stpayrelay");
    const runtime = extId("stpayrt");
    for (const [id, source] of [
      [relay, "shipped"],
      [runtime, "runtime"],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, ?, 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
      )
        .bind(id, source, admin.id, BEFORE, BEFORE)
        .run();
    }
    const from = (id: string) =>
      context(extUser, {
        actor: "extension",
        clock: () => new Date(AFTER),
        extension: {
          id,
          permissions: { operations: STAFFING, objects: {} } as never,
          tool: {
            name: "relay",
            humanOnly: true,
            permission: `${id}:team`,
            calledBy: { account: people.Ari?.id as string, actor: "human" },
          },
        },
      });
    for (const name of ["staffing.myPay", "staffing.myPay.periods"]) {
      // A person calling another pack's own `humanOnly` tool: still not that pack's to read.
      const other = await myPayRefused(name, from(relay));
      expect(other.code, name).toBe("forbidden");
      expect(other.details?.rule, name).toBe("pay_pack");
      const rt = await myPayRefused(name, from(runtime));
      expect(rt.code, name).toBe("unknown_operation");
    }
  });

  it("the read is audited as which period, never its figures, and no AI lists it", async () => {
    await myPay(people.Bo as ActingUser);
    const { results } = await env.DB.prepare(
      "SELECT input, result, outcome FROM core_audit WHERE operation = 'staffing.myPay'",
    ).all<{ input: string | null; result: string | null; outcome: string }>();
    expect(results.filter((r) => r.outcome === "ok").length).toBeGreaterThan(0);
    for (const r of results) {
      const text = `${r.input ?? ""} ${r.result ?? ""}`;
      if (r.outcome === "ok") expect(text).toContain("own pay");
      expect(text).not.toMatch(/minutes|hours|by_time|by_class|not_counted|counted|K5|Strength/);
    }
    const ai = (await invokeByName(
      "audit.list",
      { operation: "staffing.myPay" },
      context(admin, { actor: "assistant" }),
    )) as { items: unknown[] };
    expect(ai.items).toEqual([]);
    const person = (await invokeByName(
      "audit.list",
      { operation: "staffing.myPay" },
      context(admin),
    )) as { items: unknown[] };
    expect(person.items.length).toBeGreaterThan(0);
  });
});

describe("the lock (criterion 10)", () => {
  let periodId: string;

  it("is refused before the period ends, then locks its lines", async () => {
    const early = await refusal(
      pay("staffing.payPeriod.lock", { start: START }, admin, "2026-04-12T12:00:00.000Z"),
    );
    expect(early.details?.rule).toBe("pay_period_open");
    const wrong = await refusal(pay("staffing.payPeriod.lock", { start: "2026-03-31" }));
    expect(wrong.code).toBe("invalid_input");
    const locked = await pay<{ id: string; version: number }>("staffing.payPeriod.lock", {
      start: START,
    });
    periodId = locked.id;
    expect(locked.version).toBe(1);
    const out = await pay<Totals>("staffing.payPeriod.totals", { start: START });
    expect(out.period).toMatchObject({ locked: true, preview: false, version: { version: 1 } });
    expect(out.totals.length).toBe(EXPECTED_TOTALS.length);
    expect(out.minutes).toBe(610);
    expect((await refusal(pay("staffing.payPeriod.lock", { start: START }))).details?.rule).toBe(
      "pay_period_held",
    );
  });

  it("refuses every change of a shift inside it, for everyone, by every path", async () => {
    const k1 = shifts.K1 as string;
    const locked = async (p: Promise<unknown>) => {
      const e = await refusal(p);
      expect(e.details?.rule, e.message).toBe("pay_period_locked");
    };
    await locked(update(KLASS, k1, { startsAt: sydney("2026-03-30T06:30") }));
    await locked(update(KLASS, k1, { coach: profile.Cy }));
    await locked(update(KLASS, k1, { kind: yoga }));
    await locked(update(KLASS, k1, { state: "cancelled" }));
    await locked(invokeByName("record.delete", { object: KLASS, id: k1 }, as(admin)));
    await locked(update(DUTY, shifts.D1 as string, { staff: null }));
    // A coach profile on a locked class keeps its account.
    await locked(update(COACH, profile.Ari as string, { user: (await createUser("member")).id }));
    // The not-worked mark and who is counted, for a date in it.
    await locked(
      invokeByName(
        "staffing.markNotWorked",
        { object: KLASS, id: shifts.K3, notWorked: false },
        tool(admin, { personApproves: true }),
      ),
    );
    await locked(
      pay("staffing.payBasis", { account: people.Bo?.id, basis: "by_time", from: "2026-04-01" }),
    );
    // What does not change pay is still open: a note, a class done, the next period's class.
    await update(KLASS, k1, { notes: "Good turnout" });
    await update(KLASS, k1, { state: "done" });
    await update(KLASS, shifts.K8 as string, { startsAt: sydney("2026-04-13T00:45") });
    await pay("staffing.payBasis", {
      account: people.Bo?.id,
      basis: "by_class",
      from: "2026-04-13",
    });
  });

  it("holds against raw statements: REPLACE, upserts, UPDATE OR REPLACE, deletes", async () => {
    const table = objectTableOf(KLASS) as string;
    const starts = column(KLASS, "startsAt");
    const coach = column(KLASS, "coach");
    const k1 = shifts.K1 as string;
    const k8 = shifts.K8 as string;
    const raw = (q: string, ...binds: unknown[]) =>
      env.DB.prepare(q)
        .bind(...binds)
        .run();
    const blocked = async (q: string, ...binds: unknown[]) => {
      await expect(raw(q, ...binds)).rejects.toThrow(/core_pay_period_locked/);
    };
    await blocked(`UPDATE ${table} SET ${starts} = ? WHERE id = ?`, sydney("2026-03-30T05:00"), k1);
    await blocked(`DELETE FROM ${table} WHERE id = ?`, k1);
    await blocked(
      `INSERT OR REPLACE INTO ${table} (id, created_at, updated_at) VALUES (?, 'x', 'x')`,
      k1,
    );
    await blocked(
      `INSERT INTO ${table} (id, created_at, updated_at) VALUES (?, 'x', 'x') ON CONFLICT (id) DO UPDATE SET ${coach} = NULL`,
      k1,
    );
    // Another row given K1's id, replacing it.
    await blocked(`UPDATE OR REPLACE ${table} SET id = ? WHERE id = ?`, k1, k8);
    // A new live shift dated inside the locked period.
    await blocked(
      `INSERT INTO ${table} (id, created_at, updated_at, ${starts}, ${column(KLASS, "endsAt")}, ${column(KLASS, "state")}) VALUES ('kx', 'x', 'x', ?, ?, 'scheduled')`,
      sydney("2026-04-03T10:00"),
      sydney("2026-04-03T11:00"),
    );
    // The coach profile: its account, a REPLACE of it, deleting it.
    const holder = objectTableOf(COACH) as string;
    const user = column(COACH, "user");
    await blocked(`UPDATE ${holder} SET ${user} = NULL WHERE id = ?`, profile.Ari);
    await blocked(
      `INSERT OR REPLACE INTO ${holder} (id, created_at, updated_at, ${user}) VALUES (?, 'x', 'x', NULL)`,
      profile.Ari,
    );
    await blocked(`DELETE FROM ${holder} WHERE id = ?`, profile.Ari);
    // The marks and who is counted.
    await blocked("DELETE FROM core_staff_not_worked WHERE record_id = ?", shifts.K3);
    await blocked(
      "INSERT OR REPLACE INTO core_staff_not_worked (object_type, record_id, starts, reason, marked_by, marked_at) VALUES (?, ?, 0, 'x', 'x', 'x')",
      KLASS,
      shifts.K3,
    );
    await blocked(
      "INSERT OR REPLACE INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2026-01-01', 'by_time', 'x', 'x')",
      people.Bo?.id,
    );
    await blocked("DELETE FROM core_staff_pay_basis WHERE account_id = ?", people.Bo?.id);
    // The period and its lines never change.
    const fixed = /core_pay_period_fixed/;
    await expect(raw("DELETE FROM core_pay_line WHERE period_id = ?", periodId)).rejects.toThrow(
      fixed,
    );
    await expect(
      raw("UPDATE core_pay_line SET counted_minutes = 1 WHERE period_id = ?", periodId),
    ).rejects.toThrow(fixed);
    await expect(
      raw(
        "INSERT OR REPLACE INTO core_pay_line SELECT * FROM core_pay_line WHERE period_id = ? AND n = 1",
        periodId,
      ),
    ).rejects.toThrow(fixed);
    await expect(
      raw("UPDATE core_pay_period SET ends = ends + 1 WHERE id = ?", periodId),
    ).rejects.toThrow(fixed);
    await expect(raw("DELETE FROM core_pay_period WHERE id = ?", periodId)).rejects.toThrow(fixed);
    await expect(
      raw(
        "INSERT OR REPLACE INTO core_pay_period SELECT * FROM core_pay_period WHERE id = ?",
        periodId,
      ),
    ).rejects.toThrow(fixed);
    const totals = await pay<Totals>("staffing.payPeriod.totals", { start: START });
    expect(totals.minutes).toBe(610);
  });

  it("reopening is a person's, with why, audited without it; locking again keeps the old version", async () => {
    await pay("staffing.payPeriod.reopen", { start: START, reason: "Bo worked K4 longer" });
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'staffing.payPeriod.reopen' ORDER BY at DESC LIMIT 1",
    ).first<{ input: string; result: string }>();
    expect(audit?.input).not.toContain("longer");
    // Open again: a correction goes through, and the next lock is version 2.
    await update(KLASS, shifts.K4 as string, { endsAt: sydney("2026-04-04T10:45") });
    const second = await pay<{ version: number }>("staffing.payPeriod.lock", { start: START });
    expect(second.version).toBe(2);
    const v1 = await pay<Totals>("staffing.payPeriod.totals", { start: START, version: 1 });
    const v2 = await pay<Totals>("staffing.payPeriod.totals", { start: START });
    expect(v1.minutes).toBe(610);
    expect(v2.minutes).toBe(625);
    expect(v1.period.locked).toBe(false);
    const list = await pay<{
      periods: {
        start: string;
        state: string;
        versions: { version: number; state: string; reopenReason: string | null }[];
      }[];
    }>("staffing.payPeriod.list", { count: 2 });
    const period = list.periods.find((p) => p.start === START);
    expect(period?.state).toBe("locked");
    expect(period?.versions.map((v) => [v.version, v.state])).toEqual([
      [1, "reopened"],
      [2, "locked"],
    ]);
  });

  it("a write between the lock's read and its commit fails the lock whole", async () => {
    const range = periodContaining(
      { period: "fortnightly", start: START, day: 1, zone: ZONE },
      "2026-04-20",
    );
    if (!range) throw new Error("no period");
    const queries = periodFingerprint(range);
    const ctx = { db: db.query } as never;
    const values = await readFingerprint(ctx, queries);
    await update(KLASS, shifts.K8 as string, { notes: "moved" }, "2026-04-21T00:00:00.000Z");
    // K8 is in the period from 13 April: its change fails the guards.
    const guards = fingerprintGuards(queries, values);
    await expect(db.batch(guards)).rejects.toThrow(/core_staff_changed/);
    const fresh = await readFingerprint(ctx, queries);
    await db.batch(fingerprintGuards(queries, fresh));
  });
});

describe("a person's own totals, a locked period (the owner's decision of 2026-11-24)", () => {
  it("read the locked lines, which equal the pay holder's, version and all", async () => {
    for (const key of ["Ari", "Bo", "Di"]) {
      const own = await expectSameAsHolder(people[key] as ActingUser);
      expect(own.period).toMatchObject({ locked: true, preview: false, version: 2 });
    }
    // Bo's K4 was corrected before version 2 (15 minutes longer); K5 is still three real hours.
    const bo = await myPay(people.Bo as ActingUser);
    expect(bo.lines.find((l) => l.title === "K4")?.countedMinutes).toBe(105);
    expect(bo.lines.find((l) => l.title === "K5")?.shiftMinutes).toBe(180);
    const list = (await invokeByName(
      "staffing.myPay.periods",
      { count: 1 },
      tool(people.Bo as ActingUser),
    )) as { periods: { start: string; state: string; version: number | null }[] };
    expect(list.periods.find((p) => p.start === START)).toMatchObject({
      state: "locked",
      version: 2,
    });
    expect((await myPay(people.Cy as ActingUser)).counted).toBe(false);
  });
});

describe("nothing of pay reaches anyone else (criterion 10)", () => {
  it("is in no rec_* view and query.sql cannot read it; no rate or amount is held anywhere", async () => {
    const views = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'view'",
    ).all<{ name: string; sql: string }>();
    for (const v of views.results) {
      expect(v.sql, v.name).not.toMatch(/core_pay_|core_staff_pay_basis|core_staff_not_worked/);
    }
    for (const table of ["core_pay_line", "core_pay_period", "core_staff_pay_basis"]) {
      const e = await refusal(
        invokeByName("query.sql", { sql: `SELECT * FROM ${table}` }, as(admin)),
      );
      expect(e.code).not.toBe("ok");
      const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{
        name: string;
      }>();
      for (const c of cols.results) expect(c.name).not.toMatch(/rate|price|amount|cost|wage|pay_/);
    }
  });

  it("the audit log holds who read which period, never what it totals", async () => {
    const { results } = await env.DB.prepare(
      "SELECT operation, input, result FROM core_audit WHERE operation LIKE 'staffing.pay%' OR operation = 'staffing.markNotWorked'",
    ).all<{ operation: string; input: string | null; result: string | null }>();
    expect(results.some((r) => r.operation === "staffing.payPeriod.export")).toBe(true);
    expect(results.some((r) => r.operation === "staffing.payPeriod.totals")).toBe(true);
    for (const r of results) {
      const text = `${r.input ?? ""} ${r.result ?? ""}`;
      expect(text, r.operation).not.toMatch(/minutes|hours|by_time|by_class|Nobody ran it|"csv"/);
    }
  });
});

// --- The review of PR #287 ---------------------------------------------------------------------

const setPaySettings = (values: Record<string, unknown>) =>
  env.DB.prepare("UPDATE core_extension_settings SET value = ? WHERE extension_id = ?")
    .bind(JSON.stringify(values), ext)
    .run();
const setZone = (zone: string) =>
  env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'org_timezone'")
    .bind(JSON.stringify(zone))
    .run();

describe("two locks of one period at once (the review of PR #287)", () => {
  it("exactly one wins; the others are told it is held", async () => {
    // 13 to 26 April, on 28 April.
    const now = "2026-04-28T00:00:00.000Z";
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        pay("staffing.payPeriod.lock", { start: "2026-04-13" }, admin, now).then(
          () => "locked",
          (e: { details?: { rule?: string } }) => e.details?.rule ?? "error",
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "locked")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "locked")).toEqual(["pay_period_held", "pay_period_held"]);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pay_period WHERE start_date = '2026-04-13'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("a not-worked mark follows its shift (the review of PR #287)", () => {
  it("marked, moved to the next period, locked there: the mark is kept, by every path", async () => {
    // Marked in the period 27 April to 10 May, then moved into 11 to 24 May.
    shifts.S1 = await create(KLASS, {
      name: "S1",
      kind: yoga,
      coach: profile.Ari,
      startsAt: sydney("2026-04-28T06:00"),
      endsAt: sydney("2026-04-28T07:00"),
      timezone: ZONE,
    });
    await invokeByName(
      "staffing.markNotWorked",
      { object: KLASS, id: shifts.S1, reason: "Off sick" },
      tool(admin, { personApproves: true }, "2026-05-01T00:00:00.000Z"),
    );
    await update(
      KLASS,
      shifts.S1,
      { startsAt: sydney("2026-05-12T06:00"), endsAt: sydney("2026-05-12T07:00") },
      "2026-05-02T00:00:00.000Z",
    );
    const mark = await env.DB.prepare(
      "SELECT starts FROM core_staff_not_worked WHERE record_id = ?",
    )
      .bind(shifts.S1)
      .first<{ starts: number }>();
    expect(mark?.starts).toBe(Date.parse(sydney("2026-05-12T06:00")) / 1000);
    const now = "2026-05-26T00:00:00.000Z";
    await pay("staffing.payPeriod.lock", { start: "2026-05-11" }, admin, now);
    const locked = await pay<Totals>(
      "staffing.payPeriod.totals",
      { start: "2026-05-11" },
      admin,
      now,
    );
    expect(locked.lines.find((l) => l.title === "S1")).toMatchObject({
      counted: false,
      notWorkedReason: "Off sick",
    });
    const e = await refusal(
      invokeByName(
        "staffing.markNotWorked",
        { object: KLASS, id: shifts.S1, notWorked: false },
        tool(admin, { personApproves: true }, now),
      ),
    );
    expect(e.details?.rule).toBe("pay_period_locked");
    await expect(
      env.DB.prepare("DELETE FROM core_staff_not_worked WHERE record_id = ?").bind(shifts.S1).run(),
    ).rejects.toThrow(/core_pay_period_locked/);
  });
});

describe("the lock's guard, through the lock (the review of PR #287)", () => {
  it("a shift changed between the lock's read and its batch fails the lock whole", async () => {
    // 25 May to 7 June, locked on 10 June.
    shifts.T1 = await create(KLASS, {
      name: "T1",
      kind: strength,
      coach: profile.Ari,
      startsAt: sydney("2026-05-26T06:00"),
      endsAt: sydney("2026-05-26T07:00"),
      timezone: ZONE,
    });
    const table = objectTableOf(KLASS) as string;
    let fired = false;
    // The lock reads its fingerprint, then the period's lines; while it reads the lines' marks,
    // another writer changes the shift (a commit between the read and the batch).
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            if (!fired && query.includes("core_staff_not_worked") && query.includes("record_id")) {
              fired = true;
              return {
                bind: (...args: unknown[]) => ({
                  all: async () => {
                    await target
                      .prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`)
                      .bind("2026-06-10T00:00:01.000Z", shifts.T1)
                      .run();
                    return target
                      .prepare(query)
                      .bind(...args)
                      .all();
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
    const now = "2026-06-10T00:00:00.000Z";
    const ctx = { ...tool(admin, { humanOnly: true }, now), db: createCrmDb(racing as D1Database) };
    const e = await refusal(invokeByName("staffing.payPeriod.lock", { start: "2026-05-25" }, ctx));
    expect(fired).toBe(true);
    expect(e.details?.rule).toBe("roster_changed");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM core_pay_period WHERE start_date = '2026-05-25'",
      ).first(),
    ).toEqual({ n: 0 });
    // Read again, it locks.
    await pay("staffing.payPeriod.lock", { start: "2026-05-25" }, admin, now);
  });
});

describe("a change of the pay period after a lock (the review of PR #287)", () => {
  /** Every local date from `from` for `days` days, and the period each falls in. */
  function walk(
    config: Parameters<typeof periodFor>[0],
    stored: StoredPeriod[],
    from: string,
    days: number,
  ) {
    const seen = new Map<string, { start: string; end: string; starts: number; ends: number }>();
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const p = periodFor(config, stored, date);
      if (!p) throw new Error(`no period for ${date}`);
      expect(p.start <= date && date <= p.end, `${date} in ${p.start}..${p.end}`).toBe(true);
      seen.set(p.start, p);
    }
    const list = [...seen.values()].sort((a, b) => a.starts - b.starts);
    // No overlap and no gap, in dates and in instants: every shift is in exactly one period.
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1] as (typeof list)[number];
      const b = list[i] as (typeof list)[number];
      expect(b.starts, `${a.start}..${a.end} then ${b.start}`).toBe(a.ends);
      const next = new Date(Date.parse(`${a.end}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(b.start).toBe(next);
    }
    return list;
  }
  const lockedTwo = (zone: string): StoredPeriod[] => {
    const a = periodContaining({ period: "fortnightly", start: START, day: 1, zone }, START);
    const b = periodContaining({ period: "fortnightly", start: START, day: 1, zone }, "2026-04-13");
    return [a, b].map((p) => ({ ...(p as StoredPeriod) }));
  };

  it("fortnightly to monthly: the new rule starts the day after the last locked period", () => {
    const stored = lockedTwo(ZONE);
    const list = walk(
      { period: "monthly", start: START, day: 1, zone: ZONE },
      stored,
      "2026-03-01",
      150,
    );
    expect(list.map((p) => `${p.start}..${p.end}`)).toContain("2026-04-27..2026-04-30");
    expect(list.map((p) => `${p.start}..${p.end}`)).toContain("2026-05-01..2026-05-31");
    expect(list.map((p) => `${p.start}..${p.end}`)).toContain("2026-03-30..2026-04-12");
  });

  it("the start date moved a week: from the day after the last locked period, then the new grid", () => {
    const stored = lockedTwo(ZONE);
    const list = walk(
      { period: "fortnightly", start: "2026-05-04", day: 1, zone: ZONE },
      stored,
      "2026-03-20",
      120,
    );
    expect(list.map((p) => `${p.start}..${p.end}`)).toContain("2026-04-27..2026-05-03");
    expect(list.map((p) => `${p.start}..${p.end}`)).toContain("2026-05-04..2026-05-17");
  });

  it("the zone changed: the next period starts at the last locked one's very instant", () => {
    const stored = lockedTwo(ZONE);
    const list = walk(
      { period: "fortnightly", start: START, day: 1, zone: "UTC" },
      stored,
      "2026-03-25",
      90,
    );
    const after = list.find((p) => p.start === "2026-04-27");
    expect(after?.starts).toBe(stored[1]?.ends);
  });

  it("on the host: a gap left between locks and the periods after them, each shift in one", async () => {
    await setPaySettings({ payPeriodStart: START, payPeriod: "monthly", payPeriodDay: 1 });
    try {
      const now = "2026-07-05T00:00:00.000Z";
      // Locked: 30 Mar-12 Apr, 13-26 Apr, 11-24 May, 25 May-7 Jun. The gap 27 Apr-10 May splits at
      // the month; after 7 June the month runs from 8 June.
      shifts.G1 = await create(KLASS, {
        name: "G1",
        kind: yoga,
        coach: profile.Ari,
        startsAt: sydney("2026-04-28T09:00"),
        endsAt: sydney("2026-04-28T10:00"),
        timezone: ZONE,
      });
      const list = await pay<{ periods: { start: string; end: string; state: string }[] }>(
        "staffing.payPeriod.list",
        { count: 8 },
        admin,
        now,
      );
      expect(list.periods.map((p) => `${p.start}..${p.end}:${p.state}`)).toEqual([
        "2026-07-01..2026-07-31:open",
        "2026-06-08..2026-06-30:open",
        "2026-05-25..2026-06-07:locked",
        "2026-05-11..2026-05-24:locked",
        "2026-05-01..2026-05-10:open",
        "2026-04-27..2026-04-30:open",
        "2026-04-13..2026-04-26:locked",
        "2026-03-30..2026-04-12:locked",
        "2026-03-01..2026-03-29:open",
      ]);
      const gap = await pay<Totals>(
        "staffing.payPeriod.totals",
        { start: "2026-04-27" },
        admin,
        now,
      );
      expect(gap.lines.map((l) => l.title)).toEqual(["G1"]);
      const after = await pay<Totals>(
        "staffing.payPeriod.totals",
        { start: "2026-05-01" },
        admin,
        now,
      );
      expect(after.lines.map((l) => l.title)).not.toContain("G1");
      // Not a period's first day: refused, naming the period that holds it.
      const e = await refusal(
        pay("staffing.payPeriod.totals", { start: "2026-06-01" }, admin, now),
      );
      expect(e.details?.periodStart).toBe("2026-05-25");
      await pay("staffing.payPeriod.lock", { start: "2026-04-27" }, admin, now);
      // A zone changed after the locks: the period after them starts at their last instant.
      await setZone("UTC");
      const utc = await pay<Totals>(
        "staffing.payPeriod.totals",
        { start: "2026-06-08" },
        admin,
        now,
      );
      expect(utc.period.start).toBe("2026-06-08");
    } finally {
      await setZone(ZONE);
      await setPaySettings({ payPeriodStart: START });
    }
  });
});

describe("who is counted, read in full or said to be cut short (the review of PR #287)", () => {
  it("answers truncated past 2,000 rows", async () => {
    const statements = [];
    for (let i = 0; i < 2001; i++) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2030-01-01', 'by_time', 'x', 'x')",
        ).bind(`usr_bulk${String(i).padStart(5, "0")}`),
      );
    }
    for (let i = 0; i < statements.length; i += 200)
      await env.DB.batch(statements.slice(i, i + 200));
    try {
      const out = await pay<{ truncated: boolean; items: unknown[] }>("staffing.payBases", {});
      expect(out.truncated).toBe(true);
      expect(out.items.length).toBeLessThanOrEqual(2000);
      const one = await pay<{ truncated: boolean; items: unknown[] }>("staffing.payBases", {
        account: people.Ari?.id,
      });
      expect(one.truncated).toBe(false);
    } finally {
      await env.DB.prepare(
        "DELETE FROM core_staff_pay_basis WHERE account_id LIKE 'usr_bulk%'",
      ).run();
    }
  });
});
