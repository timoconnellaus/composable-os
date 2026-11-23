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
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getObject, invokeByName, objectTableOf } from "../src/index.ts";
import {
  csvText,
  fingerprintGuards,
  hoursOf,
  periodContaining,
  periodFingerprint,
  readFingerprint,
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
    expect(rows[1]).toBe(
      "period start,period end,name,staff email,basis,kind,shifts,hours,minutes",
    );
    const summary = rows.slice(2, 2 + EXPECTED_TOTALS.length);
    const email = (key: string) => people[key]?.email;
    expect(summary).toEqual([
      `2026-03-30,2026-04-12,Class Bo,${email("Bo")},by class,Yoga,1,1.50,90`,
      `2026-03-30,2026-04-12,Class Bo,${email("Bo")},by class,Strength,1,3.25,195`,
      `2026-03-30,2026-04-12,Cleaner Di,${email("Di")},by time,Cleaning,1,3.17,190`,
      `2026-03-30,2026-04-12,Hourly Ari,${email("Ari")},by time,Strength,1,1.25,75`,
      `2026-03-30,2026-04-12,Hourly Ari,${email("Ari")},by time,Yoga,1,1.00,60`,
    ]);
    expect(rows[2 + EXPECTED_TOTALS.length]).toBe("");
    const lines = rows.slice(4 + EXPECTED_TOTALS.length);
    expect(lines).toEqual([
      `Class Bo,${email("Bo")},2026-04-04,2026-04-04 09:00,2026-04-04 10:30,Yoga,K4,,90,,no,,`,
      `Class Bo,${email("Bo")},2026-04-05,2026-04-05 01:30,2026-04-05 03:30,Strength,K5,,195,,yes,Hourly Ari,yes`,
      `Cleaner Di,${email("Di")},2026-04-10,2026-04-10 22:00,2026-04-11 01:10,Cleaning,Close-down clean,"'=HYPERLINK(""x"")",190,,,,`,
      `Hourly Ari,${email("Ari")},2026-03-30,2026-03-30 06:00,2026-03-30 07:00,Strength,K1,,75,,yes,Hourly Ari,`,
      `Hourly Ari,${email("Ari")},2026-04-02,2026-04-02 07:00,2026-04-02 08:00,Yoga,K3,,0,Nobody ran it,no,,`,
      `Hourly Ari,${email("Ari")},2026-04-12,2026-04-12 23:30,2026-04-13 00:30,Yoga,K7,,60,,no,,`,
    ]);
    expect(csvText("+1")).toBe("'+1");
    expect(csvText("-2")).toBe("'-2");
    expect(csvText("@x")).toBe("'@x");
    expect(csvText("a,b")).toBe('"a,b"');
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
