// Stage 49 step 4 (ADRs 0762 and 0763): free times and the customer's check, on a fixture of
// one-to-one appointments (a service with a length, a step, a buffer, rooms and booking rules; a
// coach profile holding a staff account; the client a Person) beside classes in the same rooms.
// Free times are checked against fixtures worked out by hand: open hours less time off, claims
// with their buffers, taken rooms, closures and the client's own appointments, on the service's
// step, in the organisation's zone (Sydney) across both clock changes and overnight; only
// qualified coaches; a customer's or visitor's answer inside the booking window. A customer's
// create or move off a free time is refused by every door; staff are warned and the write is
// made, never over a clash. The database's own clock decides what has ended, so every time here
// is years ahead of it (2031); the host's clock is injected.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type CustomerPrincipal,
  createInvoker,
  createRegistry,
  defineOperation,
  getObject,
  invoke,
  objectTableOf,
} from "../src/index.ts";
import { assertCreateRules } from "../src/records/states.ts";
import { call, declareCustomers, fixtureRegistry, outside } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("free");
const ROOM = `${ext}.room`;
const CLOSURE = `${ext}.closure`;
const COACH = `${ext}.coach`;
const SERVICE = `${ext}.service`;
const KLASS = `${ext}.klass`;
const APPT = `${ext}.appointment`;

const fixture = manifest(ext, {
  objects: {
    room: {
      label: "Room",
      plural: "Rooms",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        exclusive: { type: "boolean", label: "One booking at a time", default: false },
      },
      public: { read: ["name"] },
    },
    closure: {
      label: "Closure",
      plural: "Closures",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        fromDate: { type: "date", label: "From" },
        untilDate: { type: "date", label: "Until" },
      },
    },
    coach: {
      label: "Coach",
      plural: "Coaches",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        user: { type: "user", label: "Staff account" },
      },
      unique: [{ fields: ["user"] }],
      public: { read: ["name"] },
    },
    classtype: {
      label: "Class type",
      plural: "Class types",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    service: {
      label: "Service",
      plural: "Services",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        length: { type: "number", label: "Length (minutes)" },
        step: { type: "number", label: "Start times every (minutes)" },
        bufferBefore: { type: "number", label: "Buffer before", min: 0 },
        bufferAfter: { type: "number", label: "Buffer after", min: 0 },
        rooms: { type: "relation", label: "Rooms", to: `${ext}.room`, many: true },
        staffOnly: { type: "boolean", label: "Booked by staff only" },
        opensDays: { type: "number", label: "Opens (days before)" },
        closesMinutes: { type: "number", label: "Closes (minutes before)" },
      },
      public: { read: ["name", "length"] },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Class type", to: `${ext}.classtype` },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        room: { type: "relation", label: "Room", to: `${ext}.room` },
        startsAt: { type: "datetime", label: "Starts at", required: true },
        endsAt: { type: "datetime", label: "Ends at", required: true },
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
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"], final: true }],
      },
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
      },
      occupies: {
        thing: "room",
        starts: "startsAt",
        ends: "endsAt",
        live: ["scheduled"],
        only: "exclusive",
      },
    },
    appointment: {
      label: "Appointment",
      plural: "Appointments",
      titleField: "title",
      fields: {
        title: { type: "text", label: "Title" },
        service: { type: "relation", label: "Service", to: `${ext}.service` },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        person: { type: "relation", label: "Client", to: "person" },
        room: { type: "relation", label: "Room", to: `${ext}.room` },
        startsAt: { type: "datetime", label: "Starts at", required: true },
        endsAt: { type: "datetime", label: "Ends at", required: true },
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
        create: {
          window: {
            from: { at: "startsAt", daysBefore: "service.opensDays" },
            until: { at: "startsAt", minutesBefore: "service.closesMinutes" },
          },
          staffOnly: "service.staffOnly",
        },
        moves: [{ from: "booked", to: "cancelled", by: ["staff", "customer"], final: true }],
      },
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "service",
        live: ["booked"],
        claimBefore: { field: "service.bufferBefore" },
        claimAfter: { field: "service.bufferAfter" },
        account: "required",
        private: true,
        open: {
          length: { field: "service.length" },
          step: { field: "service.step" },
          rooms: { field: "service.rooms" },
          client: "person",
          closedBy: { object: "closure", from: "fromDate", until: "untilDate" },
          customer: true,
        },
      },
      occupies: {
        thing: "room",
        starts: "startsAt",
        ends: "endsAt",
        live: ["booked"],
        before: { field: "service.bufferBefore" },
        after: { field: "service.bufferAfter" },
        only: "exclusive",
      },
    },
  },
});

// The host's clock for staff: weeks before anything here.
const NOW = "2031-05-20T00:00:00.000Z";
// Monday 2 June 2031 in Sydney (+10): 00:00 there, and Wednesday's.
const MON = "2031-06-01T14:00:00.000Z";
const WED = "2031-06-03T14:00:00.000Z";
// Monday's local times in Sydney, as UTC.
const T = {
  "09:00": "2031-06-01T23:00:00.000Z",
  "09:30": "2031-06-01T23:30:00.000Z",
  "10:00": "2031-06-02T00:00:00.000Z",
  "10:30": "2031-06-02T00:30:00.000Z",
  "11:00": "2031-06-02T01:00:00.000Z",
  "11:30": "2031-06-02T01:30:00.000Z",
  "12:00": "2031-06-02T02:00:00.000Z",
  "14:00": "2031-06-02T04:00:00.000Z",
  "14:30": "2031-06-02T04:30:00.000Z",
  "15:00": "2031-06-02T05:00:00.000Z",
  "16:00": "2031-06-02T06:00:00.000Z",
} as const;
const plus = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

let admin: ActingUser;
let extUser: ActingUser;
let customer: CustomerPrincipal;

const staff = (now = NOW) => context(admin, { clock: () => new Date(now) });

/** A shipped pack's tool run called for `user` (as staffing-hours.test.ts). */
const tool = (user: ActingUser, now = NOW) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(now),
    extension: {
      id: ext,
      permissions: { operations: ["staffing.free", "staffing.hours.set"], objects: {} } as never,
      tool: {
        name: "freeTimes",
        humanOnly: true,
        permission: "records:read",
        calledBy: { account: user.id, actor: "human" },
      },
    },
  });

/** The pack's tool called by a customer or the public (ADR 0414). */
const outsideTool = (principal: CustomerPrincipal | { kind: "public" }, now = NOW) =>
  outside(principal, { tool: { extension: ext, tool: "freeTimes" }, clock: () => new Date(now) });

async function create(object: string, values: Record<string, unknown>, now = NOW) {
  return (await invoke("record.create", { object, values }, staff(now))) as {
    id: string;
    warnings?: { code: string }[];
  };
}

async function person(label: string): Promise<string> {
  const tag = unique(label);
  const made = await invoke(
    "person.create",
    { givenName: tag, emails: [{ email: `${tag}@free.example` }] },
    staff(),
  );
  return made.id as string;
}

/** A coach profile with its own staff account. */
async function coach(label: string): Promise<{ id: string; user: ActingUser }> {
  const user = await createUser("member");
  const { id } = await create(COACH, { name: unique(label), user: user.id });
  return { id, user };
}

async function service(values: Record<string, unknown> = {}): Promise<string> {
  return (
    await create(SERVICE, {
      name: unique("Service"),
      length: 60,
      step: 30,
      bufferBefore: 0,
      bufferAfter: 0,
      opensDays: 28,
      closesMinutes: 720,
      staffOnly: false,
      ...values,
    })
  ).id;
}

async function qualify(account: string, serviceId: string) {
  await env.DB.prepare(
    "INSERT INTO core_staff_qualification (account_id, kind_object, kind_record, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(account, SERVICE, serviceId, admin.id, NOW)
    .run();
}

async function hours(user: ActingUser, input: Record<string, unknown>) {
  return invoke("staffing.hours.set", { zone: "Australia/Sydney", ...input } as never, tool(user));
}

async function away(account: string, starts: string, ends: string) {
  const id = `away_${unique("a")}`;
  await env.DB.prepare(
    "INSERT INTO core_staff_away (id, account_id, kind, starts_at, ends_at, zone, set_by, set_at) VALUES (?, ?, 'other', ?, ?, 'Australia/Sydney', ?, ?)",
  )
    .bind(id, account, starts, ends, admin.id, NOW)
    .run();
  return id;
}

interface Answer {
  times: { startsAt: string; endsAt: string; providers: string[]; room: string | null }[];
}
async function free(
  input: Record<string, unknown>,
  ctx: Parameters<typeof invoke>[2] = tool(admin),
): Promise<Answer> {
  return (await invoke(
    "staffing.free",
    { object: APPT, from: MON, to: WED, ...input } as never,
    ctx,
  )) as Answer;
}
const starts = (a: Answer) => a.times.map((t) => t.startsAt);

/** A staff-made appointment of `minutes` from `at`. */
async function appointment(values: Record<string, unknown>, at: string, minutes = 60) {
  return create(APPT, {
    title: "Fixture client",
    startsAt: at,
    endsAt: plus(at, minutes),
    ...values,
  });
}

beforeAll(async () => {
  expect(validateManifest(fixture).issues).toEqual([]);
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify("Australia/Sydney"))
    .run();
  await reconcile(fixture, NOW);
  // Installed as a shipped pack with a tool open to customers and the public.
  const installed = {
    id: ext,
    permissions: { operations: ["staffing.free"], objects: {} },
    tools: { freeTimes: { audiences: ["customer", "public"], risk: "read" } },
  };
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  await declareCustomers({
    [APPT]: {
      field: "person",
      read: ["service", "coach", "room", "startsAt", "endsAt", "state"],
      write: ["service", "coach", "room", "startsAt", "endsAt", "state"],
    },
  });
  customer = { kind: "customer", customerId: `cus_${unique("c")}`, personId: await person("me") };
}, 60_000);

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    const broken = structuredClone(fixture);
    const objects = broken.objects as Record<string, { staffed?: Record<string, unknown> }>;
    const appt = objects.appointment as { staffed: Record<string, unknown> };
    appt.staffed = {
      ...appt.staffed,
      open: {
        length: { field: "service.name" },
        step: { field: "coach.user" },
        rooms: { field: "service.length" },
        client: "coach",
        closedBy: { object: "room", from: "name", until: "exclusive" },
      },
    };
    const issues = validateManifest(broken).issues;
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.appointment.staffed.open.length.field",
        "objects.appointment.staffed.open.step.field",
        "objects.appointment.staffed.open.rooms.field",
        "objects.appointment.staffed.open.client",
        "objects.appointment.staffed.open.closedBy.from",
        "objects.appointment.staffed.open.closedBy.until",
      ]),
    );
    // Rooms need the object to occupy them.
    const roomless = structuredClone(fixture);
    delete (roomless.objects.appointment as { occupies?: unknown }).occupies;
    expect(validateManifest(roomless).issues.map((i) => i.path)).toContain(
      "objects.appointment.staffed.open.rooms",
    );
  });
});

describe("free times, worked out by hand", () => {
  it("are open hours less time off, other shifts and closures, on the service's step", async () => {
    // Weekly Monday and Tuesday 09:00 to 12:00, extra hours on Monday 14:00 to 15:00; a class
    // 10:30 to 11:00; away Monday 14:30 to 16:00; closed on Tuesday. A 60-minute session every
    // 30 minutes with 15 minutes after.
    const a = await coach("A");
    const s = await service({ bufferAfter: 15 });
    await qualify(a.user.id, s);
    await hours(a.user, {
      kind: "weekly",
      weekdays: ["mon", "tue"],
      startTime: "09:00",
      endTime: "12:00",
      fromDate: "2031-06-01",
    });
    await hours(a.user, {
      kind: "extra",
      startsAt: "2031-06-02T14:00",
      endsAt: "2031-06-02T15:00",
    });
    await create(KLASS, { name: "Class", coach: a.id, startsAt: T["10:30"], endsAt: T["11:00"] });
    const off = await away(a.user.id, T["14:30"], T["16:00"]);
    await create(CLOSURE, { name: "Closed", fromDate: "2031-06-03", untilDate: "2031-06-03" });
    // 09:00 ends 10:15 with its buffer, before the class; 09:30 to 10:30 run into it; 11:00 to
    // 12:00 starts as it ends; 14:00 is time off; Tuesday is closed.
    const answer = await free({ kind: s });
    expect(answer.times).toEqual([
      { startsAt: T["09:00"], endsAt: T["10:00"], providers: [a.id], room: null },
      { startsAt: T["11:00"], endsAt: T["12:00"], providers: [a.id], room: null },
    ]);
    await env.DB.prepare("DELETE FROM core_staff_away WHERE id = ?").bind(off).run();
    expect(starts(await free({ kind: s }))).toEqual([T["09:00"], T["11:00"], T["14:00"]]);
  });

  it("a buffer after blocks the coach's next 15 minutes, in free times and in the database", async () => {
    const b = await coach("B");
    const s = await service({ bufferAfter: 15 });
    await qualify(b.user.id, s);
    await hours(b.user, {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "09:00",
      endTime: "12:00",
      fromDate: "2031-06-01",
    });
    await appointment({ service: s, coach: b.id, person: await person("p") }, T["09:00"]);
    // Taken to 10:15: 10:00 overlaps it, 10:30 is free.
    expect(starts(await free({ kind: s }))).toEqual([T["10:30"], T["11:00"]]);
    await expect(
      appointment({ service: s, coach: b.id, person: await person("q") }, T["10:00"]),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "double_booked" } });
  });

  it("starts on the step from local midnight, and never in the past", async () => {
    const c = await coach("Step");
    const s = await service({ length: 60, step: 30 });
    await qualify(c.user.id, s);
    await hours(c.user, {
      kind: "extra",
      startsAt: "2031-06-02T09:15",
      endsAt: "2031-06-02T10:45",
    });
    // 09:30 fits; 10:00 would end at 11:00, after the hours.
    expect(starts(await free({ kind: s }))).toEqual([T["09:30"]]);
    // From a clock past 09:30, nothing.
    expect(starts(await free({ kind: s }, tool(admin, plus(T["09:30"], 1))))).toEqual([]);
  });

  it("rooms: the first free one in the service's order, a shared room never claimed", async () => {
    const x = (await create(ROOM, { name: unique("X"), exclusive: true })).id;
    const y = (await create(ROOM, { name: unique("Y"), exclusive: true })).id;
    const floor = (await create(ROOM, { name: unique("Floor"), exclusive: false })).id;
    const f = await coach("F");
    const s = await service({ step: 60, rooms: [x, y] });
    await qualify(f.user.id, s);
    await hours(f.user, {
      kind: "extra",
      startsAt: "2031-06-02T09:00",
      endsAt: "2031-06-02T11:00",
    });
    // A class with nobody on it takes room X at 09:00.
    await create(KLASS, { name: "In X", room: x, startsAt: T["09:00"], endsAt: T["10:00"] });
    expect((await free({ kind: s })).times.map((t) => [t.startsAt, t.room])).toEqual([
      [T["09:00"], y],
      [T["10:00"], x],
    ]);
    // Y taken too: no room at 09:00.
    await create(KLASS, { name: "In Y", room: y, startsAt: T["09:00"], endsAt: T["10:00"] });
    expect(starts(await free({ kind: s }))).toEqual([T["10:00"]]);
    // A shared floor is never claimed: a class on it leaves it free.
    await create(KLASS, {
      name: "On the floor",
      room: floor,
      startsAt: T["09:00"],
      endsAt: T["10:00"],
    });
    await invoke(
      "record.update",
      { object: SERVICE, id: s, values: { rooms: [x, y, floor] } },
      staff(),
    );
    expect((await free({ kind: s })).times.map((t) => [t.startsAt, t.room])).toEqual([
      [T["09:00"], floor],
      [T["10:00"], x],
    ]);
  });

  it("leave out the client's own appointments, and list only qualified coaches", async () => {
    const g = await coach("G");
    const h = await coach("H");
    const e = await coach("E");
    const s = await service({ step: 60 });
    await qualify(g.user.id, s);
    await qualify(h.user.id, s);
    for (const who of [g, h, e]) {
      await hours(who.user, {
        kind: "extra",
        startsAt: "2031-06-02T09:00",
        endsAt: "2031-06-02T11:00",
      });
    }
    const client = await person("client");
    await appointment({ service: s, coach: g.id, person: client }, T["09:00"]);
    const both = [g.id, h.id].sort();
    // "Anyone": every free qualified coach, never E.
    expect((await free({ kind: s })).times).toEqual([
      { startsAt: T["09:00"], endsAt: T["10:00"], providers: [h.id], room: null },
      { startsAt: T["10:00"], endsAt: T["11:00"], providers: both, room: null },
    ]);
    // For the client, 09:00 is their own appointment's time.
    expect(starts(await free({ kind: s, client }))).toEqual([T["10:00"]]);
    expect(starts(await free({ kind: s, providers: [e.id] }))).toEqual([]);
  });

  it("by wall clock across both clock changes and overnight", async () => {
    const c = await coach("Night");
    const s = await service({ step: 60 });
    await qualify(c.user.id, s);
    // Saturday 22:00 to 02:00 (overnight), and Sunday 09:00 to 11:00.
    await hours(c.user, {
      kind: "weekly",
      weekdays: ["sat"],
      startTime: "22:00",
      endTime: "02:00",
      fromDate: "2031-01-01",
    });
    await hours(c.user, {
      kind: "weekly",
      weekdays: ["sun"],
      startTime: "09:00",
      endTime: "11:00",
      fromDate: "2031-01-01",
    });
    const at = (from: string, to: string) =>
      free({ kind: s, from, to }, tool(admin, "2031-01-02T00:00:00.000Z")).then(starts);
    // The clocks go back at 03:00 on Sunday 6 April: Saturday 22:00 to 02:00 is 11:00 to 15:00
    // UTC (summer time, +11); Sunday 09:00 and 10:00 are in standard time (+10).
    expect(await at("2031-04-05T00:00:00.000Z", "2031-04-06T12:00:00.000Z")).toEqual([
      "2031-04-05T11:00:00.000Z",
      "2031-04-05T12:00:00.000Z",
      "2031-04-05T13:00:00.000Z",
      "2031-04-05T14:00:00.000Z",
      "2031-04-05T23:00:00.000Z",
      "2031-04-06T00:00:00.000Z",
    ]);
    // A week before, all in summer time.
    expect(await at("2031-03-29T00:00:00.000Z", "2031-03-30T12:00:00.000Z")).toEqual([
      "2031-03-29T11:00:00.000Z",
      "2031-03-29T12:00:00.000Z",
      "2031-03-29T13:00:00.000Z",
      "2031-03-29T14:00:00.000Z",
      "2031-03-29T22:00:00.000Z",
      "2031-03-29T23:00:00.000Z",
    ]);
    // The clocks go forward at 02:00 on Sunday 5 October: 02:00 does not happen, so Saturday's
    // hours run to 03:00 summer time (16:00 UTC); Sunday 09:00 is +11.
    expect(await at("2031-10-04T00:00:00.000Z", "2031-10-05T12:00:00.000Z")).toEqual([
      "2031-10-04T12:00:00.000Z",
      "2031-10-04T13:00:00.000Z",
      "2031-10-04T14:00:00.000Z",
      "2031-10-04T15:00:00.000Z",
      "2031-10-04T22:00:00.000Z",
      "2031-10-04T23:00:00.000Z",
    ]);
  });
});

describe("who is answered what", () => {
  it("a customer or visitor only inside the booking window; staff any time", async () => {
    const k = await coach("K");
    const s = await service({ step: 60 });
    const staffOnly = await service({ step: 60, staffOnly: true });
    for (const id of [s, staffOnly]) await qualify(k.user.id, id);
    await hours(k.user, {
      kind: "extra",
      startsAt: "2031-06-02T09:00",
      endsAt: "2031-06-02T11:00",
    });
    // 21:30 on Sunday in Sydney: 09:00 is 11 and a half hours away, inside the 12 hours' notice;
    // 10:00 is outside it.
    const sunday = "2031-06-01T11:30:00.000Z";
    expect(starts(await free({ kind: s }, tool(admin, sunday)))).toEqual([T["09:00"], T["10:00"]]);
    for (const who of [customer, { kind: "public" as const }]) {
      const got = await call(
        "staffing.free",
        { object: APPT, kind: s, from: MON, to: WED },
        outsideTool(who, sunday),
      );
      expect(got).toMatchObject({ ok: true });
      expect(starts((got as { value: Answer }).value)).toEqual([T["10:00"]]);
      // Booked by staff only: nothing for them.
      const none = await call(
        "staffing.free",
        { object: APPT, kind: staffOnly, from: MON, to: WED },
        outsideTool(who, sunday),
      );
      expect((none as { value: Answer }).value.times).toEqual([]);
    }
    // Nobody's bookings for the public, and only their own family's for a customer.
    for (const who of [customer, { kind: "public" as const }]) {
      expect(
        await call(
          "staffing.free",
          { object: APPT, kind: s, client: await person("other") },
          outsideTool(who, sunday),
        ),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
  });

  it("only from a pack's tool, at most 31 days and 20 coaches a call", async () => {
    const s = await service();
    await expect(
      invoke("staffing.free", { object: APPT, kind: s } as never, staff()),
    ).rejects.toMatchObject({ code: "unknown_operation" });
    expect(await call("staffing.free", { object: APPT, kind: s }, outside(customer))).toMatchObject(
      { ok: false, error: { code: "unknown_operation" } },
    );
    await expect(
      free({ kind: s, from: MON, to: "2031-07-03T14:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "free_range" } });
    await expect(
      free({ kind: s, providers: Array.from({ length: 21 }, (_, i) => `c${i}`) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // An object that is not booked at free times is not there.
    await expect(free({ object: KLASS, kind: s })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the customer's check", () => {
  let m: { id: string; user: ActingUser };
  let s: string;
  let room: string;
  let roomed: string;
  const book = (values: Record<string, unknown>, now = NOW) =>
    call(
      "fixture.myCreate",
      { object: APPT, values },
      outside(customer, { clock: () => new Date(now) }),
    );
  const move = (id: string, values: Record<string, unknown>) =>
    call(
      "fixture.myUpdate",
      { object: APPT, id, values },
      outside(customer, { clock: () => new Date(NOW) }),
    );

  beforeAll(async () => {
    m = await coach("M");
    s = await service({ bufferAfter: 15 });
    room = (await create(ROOM, { name: unique("Private"), exclusive: true })).id;
    roomed = await service({ step: 60, rooms: [room] });
    await qualify(m.user.id, s);
    await qualify(m.user.id, roomed);
    await hours(m.user, {
      kind: "weekly",
      weekdays: ["mon"],
      startTime: "09:00",
      endTime: "12:00",
      fromDate: "2031-06-01",
    });
  });

  it("a customer books on a free time; off one, or for another length, is refused", async () => {
    const made = await book({ service: s, coach: m.id, startsAt: T["09:00"], endsAt: T["10:00"] });
    expect(made, JSON.stringify(made)).toMatchObject({ ok: true });
    // 10:00 is inside the first one's buffer; 12:00 is after the hours; 30 minutes is not 60.
    for (const [at, minutes] of [
      [T["10:00"], 60],
      [T["12:00"], 60],
      [T["11:00"], 30],
    ] as const) {
      expect(
        await book({ service: s, coach: m.id, startsAt: at, endsAt: plus(at, minutes) }),
      ).toMatchObject({
        ok: false,
        error: { code: "conflict", details: { rule: "not_free_time" } },
      });
    }
    const id = (made as { value: { id: string } }).value.id;
    // Moving their own: later into its own old time is free; off the hours is not.
    expect(await move(id, { startsAt: T["09:30"], endsAt: T["10:30"] })).toMatchObject({
      ok: true,
    });
    expect(await move(id, { startsAt: T["11:30"], endsAt: plus(T["11:30"], 60) })).toMatchObject({
      ok: false,
      error: { details: { rule: "not_free_time" } },
    });
    // A cancel is not a booking: never refused for its time.
    expect(await move(id, { state: "cancelled" })).toMatchObject({ ok: true });
  });

  it("a service that needs a room: one of its rooms, free then", async () => {
    // Naming none, the host gives it the first of the service's rooms free then (stage 49 step
    // 5, ADR 0764), and the check holds it as if it were named.
    const chosen = await book({
      service: roomed,
      coach: m.id,
      startsAt: T["11:00"],
      endsAt: T["12:00"],
    });
    expect(chosen).toMatchObject({ ok: true });
    const chosenId = (chosen as { value: { id: string } }).value.id;
    const stored = (await invoke("record.get", { object: APPT, id: chosenId }, staff())) as {
      values: Record<string, unknown>;
    };
    expect(stored.values.room).toBe(room);
    expect(await move(chosenId, { state: "cancelled" })).toMatchObject({ ok: true });
    expect(
      await book({ service: roomed, coach: m.id, room, startsAt: T["11:00"], endsAt: T["12:00"] }),
    ).toMatchObject({ ok: true });
  });

  it("a room the service does not list is never a customer's to take (review of PR #430)", async () => {
    const n = await coach("NoRoom");
    const t = await service();
    await qualify(n.user.id, t);
    await hours(n.user, {
      kind: "extra",
      startsAt: "2031-06-02T09:00",
      endsAt: "2031-06-02T10:00",
    });
    const other = (await create(ROOM, { name: unique("Other"), exclusive: true })).id;
    // The service needs no room: naming one, exclusive or not, is refused, and the room stays
    // free for a class.
    expect(
      await book({
        service: t,
        coach: n.id,
        room: other,
        startsAt: T["09:00"],
        endsAt: T["10:00"],
      }),
    ).toMatchObject({ ok: false, error: { details: { rule: "not_free_time", field: "room" } } });
    await create(KLASS, {
      name: "In Other",
      room: other,
      startsAt: T["09:00"],
      endsAt: T["10:00"],
    });
    // A service with rooms: a room it does not list is refused too.
    expect(
      await book({
        service: roomed,
        coach: m.id,
        room: other,
        startsAt: T["10:00"],
        endsAt: T["11:00"],
      }),
    ).toMatchObject({ ok: false, error: { details: { rule: "not_free_time", field: "room" } } });
  });

  it("one client's bookings at once with different coaches: exactly one commits (review of PR #430)", async () => {
    const t = await service();
    const coaches = await Promise.all(Array.from({ length: 5 }, (_, i) => coach(`Many${i}`)));
    for (const c of coaches) {
      await qualify(c.user.id, t);
      await hours(c.user, {
        kind: "extra",
        startsAt: "2031-06-05T09:00",
        endsAt: "2031-06-05T10:00",
      });
    }
    const client: CustomerPrincipal = {
      kind: "customer",
      customerId: `cus_${unique("one")}`,
      personId: await person("one"),
    };
    // Thursday 5 June 09:00 in Sydney (Tuesday is closed).
    const at = "2031-06-04T23:00:00.000Z";
    const results = await Promise.all(
      coaches.map((c) =>
        call(
          "fixture.myCreate",
          { object: APPT, values: { service: t, coach: c.id, startsAt: at, endsAt: plus(at, 60) } },
          outside(client, { clock: () => new Date(NOW) }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    }
  });

  it("a record the host makes for a customer meets the same check (a held booking)", async () => {
    const registry = createRegistry([
      ...fixtureRegistry.list(),
      defineOperation({
        name: "fixture.createRules",
        description: "Fixture: judges a create as the host's held create does.",
        input: z.object({ values: z.record(z.string(), z.unknown()) }),
        output: z.object({ ok: z.boolean() }),
        permission: "records:read",
        risk: "read",
        async handler(input, ctx) {
          await assertCreateRules(ctx, getObject(APPT) as never, input.values, "customer");
          return { ok: true };
        },
      }),
    ]);
    const judge = (at: string) =>
      createInvoker(registry).invokeByName(
        "fixture.createRules",
        { values: { service: s, coach: m.id, startsAt: at, endsAt: plus(at, 60) } },
        staff(),
      );
    await expect(judge(T["12:00"])).rejects.toMatchObject({ details: { rule: "not_free_time" } });
    await expect(judge(T["09:00"])).resolves.toEqual({ ok: true });
  });

  it("staff book outside the hours or over the client's own with warnings, never over a clash", async () => {
    const client = await person("staffed");
    const outsideHours = await appointment({ service: s, coach: m.id, person: client }, T["14:00"]);
    expect(outsideHours.warnings?.map((w) => w.code)).toEqual(["outside_hours"]);
    const other = await coach("Other");
    await qualify(other.user.id, s);
    await hours(other.user, {
      kind: "extra",
      startsAt: "2031-06-02T14:00",
      endsAt: "2031-06-02T16:00",
    });
    const busy = await appointment({ service: s, coach: other.id, person: client }, T["14:30"]);
    expect(busy.warnings?.map((w) => w.code)).toEqual(["client_busy"]);
    await expect(
      appointment({ service: s, coach: m.id, person: await person("x") }, T["14:30"]),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "double_booked" } });
  });

  it("of twenty customers booking one coach's same time at once, exactly one commits", async () => {
    const n = await coach("N");
    const t = await service();
    await qualify(n.user.id, t);
    await hours(n.user, {
      kind: "extra",
      startsAt: "2031-06-02T09:00",
      endsAt: "2031-06-02T10:00",
    });
    const people = await Promise.all(Array.from({ length: 20 }, (_, i) => person(`race${i}`)));
    const results = await Promise.all(
      people.map((personId) =>
        call(
          "fixture.myCreate",
          {
            object: APPT,
            values: { service: t, coach: n.id, startsAt: T["09:00"], endsAt: T["10:00"] },
          },
          outside(
            { kind: "customer", customerId: `cus_${unique("r")}`, personId },
            { clock: () => new Date(NOW) },
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    }
  });
});

// --- What a call costs ---------------------------------------------------------------------------

let queries = 0;
/** env.DB, counting every statement Kysely runs (as staffed-cost.test.ts). */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(st, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(st.bind(...args));
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  queries += 1;
                  return (st[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                };
              }
              const value = Reflect.get(st, p);
              return typeof value === "function" ? value.bind(st) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        queries += statements.length;
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

describe("what a call costs", () => {
  it("31 days of 20 busy coaches is a fixed number of reads, as for one quiet coach", async () => {
    // Every 15 minutes, 06:00 to 22:00 every day, with a class a day each, regular time off, ten
    // extra hours each, two exclusive rooms each with a class a day, and a closure.
    const s = await service({ step: 15, bufferAfter: 10 });
    const rooms = [
      (await create(ROOM, { name: unique("R1"), exclusive: true })).id,
      (await create(ROOM, { name: unique("R2"), exclusive: true })).id,
    ];
    await invoke("record.update", { object: SERVICE, id: s, values: { rooms } }, staff());
    await create(CLOSURE, { name: "Holiday", fromDate: "2031-06-20", untilDate: "2031-06-21" });
    const klass = getObject(KLASS);
    const col = (f: string) => klass?.fields.find((x) => x.name === f)?.column as string;
    const table = objectTableOf(KLASS) as string;
    const coaches: { id: string; user: ActingUser }[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 20; i += 1) {
      const c = await coach(`Busy${i}`);
      coaches.push(c);
      await qualify(c.user.id, s);
      await hours(c.user, {
        kind: "weekly",
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        startTime: "06:00",
        endTime: "22:00",
        fromDate: "2031-06-01",
      });
      for (let d = 0; d < 10; d += 1) {
        const date = `2031-06-${String(10 + d).padStart(2, "0")}`;
        await hours(c.user, { kind: "extra", startsAt: `${date}T22:00`, endsAt: `${date}T23:00` });
      }
      await env.DB.prepare(
        "INSERT INTO core_staff_away (id, account_id, kind, weekdays, start_time, end_time, from_date, zone, set_by, set_at) VALUES (?, ?, 'regular', 'wed', '13:00', '14:00', '2031-01-01', 'Australia/Sydney', ?, ?)",
      )
        .bind(`away_${unique("r")}`, c.user.id, admin.id, NOW)
        .run();
      for (let d = 0; d < 31; d += 1) {
        const at = Date.parse(MON) + d * 86_400_000 + (8 + (i % 8)) * 3_600_000;
        statements.push(
          env.DB.prepare(
            `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("startsAt")}, ${col("endsAt")}, ${col("coach")}, ${col("state")}) VALUES (?, ?, ?, 'Busy', ?, ?, ?, 'scheduled')`,
          ).bind(
            `busy${i}_${d}_${unique("k")}`,
            NOW,
            NOW,
            new Date(at).toISOString(),
            new Date(at + 3_600_000).toISOString(),
            c.id,
          ),
        );
      }
    }
    for (const [r, room] of rooms.entries()) {
      for (let d = 0; d < 31; d += 1) {
        const at = Date.parse(MON) + d * 86_400_000 + (9 + r) * 3_600_000;
        statements.push(
          env.DB.prepare(
            `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("startsAt")}, ${col("endsAt")}, ${col("room")}, ${col("state")}) VALUES (?, ?, ?, 'In a room', ?, ?, ?, 'scheduled')`,
          ).bind(
            `room${r}_${d}_${unique("k")}`,
            NOW,
            NOW,
            new Date(at).toISOString(),
            new Date(at + 3_600_000).toISOString(),
            room,
          ),
        );
      }
    }
    for (let i = 0; i < statements.length; i += 100)
      await env.DB.batch(statements.slice(i, i + 100));
    const month = { kind: s, from: MON, to: "2031-07-02T14:00:00.000Z" };
    queries = 0;
    const busy = await free(month, { ...tool(admin), db: meteredDb });
    const busyQueries = queries;
    expect(busy.times.length).toBeGreaterThan(500);
    expect(busy.times[0]?.providers).toHaveLength(20);
    queries = 0;
    await free({ ...month, providers: [coaches[0]?.id] }, { ...tool(admin), db: meteredDb });
    expect(queries).toBe(busyQueries);
    // The handful of reads: the pipeline's own, the kind, the coaches, hours, time off, claims,
    // closures, the rooms and their claims, the settings.
    expect(busyQueries).toBeLessThanOrEqual(20);
  }, 180_000);
});
