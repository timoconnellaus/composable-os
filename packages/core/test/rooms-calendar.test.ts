// Stage 57 step 1 (ADR 0844): the room calendar over core_thing_time. `occupies.provisional` and
// `occupies.title` change only what the calendar shows; `rooms.week` and `rooms.check` are
// tool-only reads that list every kind of claim (a class, a session, an event in several rooms, a
// room use held or confirmed) with provisional marked and no names, an appointment-like session by
// its service, and to a fixed role's account only that a room is taken, and when. Set-up counts in
// the claim; a series' date on a room a confirmed room use takes is made without its room, and the
// use is untouched. The reads cost a bounded number of statements however many claims there are.
//
// The triggers read the database's clock (a claim that has ended is history), so the records here
// are years ahead of any real clock.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  invokeByName,
  objectTableOf,
  runRecurringDue,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const STATES = (...values: string[]) => values.map((value) => ({ value, label: value }));

const fixture = (id: string) =>
  manifest(id, {
    objects: {
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          exclusive: { type: "boolean", label: "One booking at a time", default: false },
        },
      },
      service: {
        label: "Service",
        plural: "Services",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
      },
      series: {
        label: "Series",
        plural: "Series",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          weekdays: { type: "multiSelect", label: "Weekdays", options: STATES("mon", "tue") },
          time: { type: "text", label: "Time" },
          length: { type: "number", label: "Length" },
          firstDate: { type: "date", label: "First date" },
          lastDate: { type: "date", label: "Last date" },
          timezone: { type: "timezone", label: "Time zone" },
          room: { type: "relation", label: "Room", to: `${id}.room` },
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
          copy: { name: "name", room: "room" },
          cancel: "cancelled",
          horizonDays: 21,
        },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          series: { type: "relation", label: "Series", to: `${id}.series`, readOnly: true },
          room: { type: "relation", label: "Room", to: `${id}.room` },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          timezone: { type: "timezone", label: "Time zone" },
          changed: { type: "boolean", label: "Changed", readOnly: true },
          state: { type: "select", label: "State", options: STATES("scheduled", "cancelled") },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [{ from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true }],
        },
        occupies: {
          thing: "room",
          starts: "startsAt",
          ends: "endsAt",
          live: ["scheduled"],
          only: "exclusive",
          title: "name",
        },
      },
      session: {
        label: "Session",
        plural: "Sessions",
        titleField: "client",
        fields: {
          // The client: the calendar must never show it.
          client: { type: "text", label: "Client" },
          service: { type: "relation", label: "Service", to: `${id}.service` },
          room: { type: "relation", label: "Room", to: `${id}.room` },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          state: { type: "select", label: "State", options: STATES("booked", "cancelled") },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
        },
        occupies: {
          thing: "room",
          starts: "startsAt",
          ends: "endsAt",
          live: ["booked"],
          only: "exclusive",
          title: "service.name",
        },
      },
      event: {
        label: "Event",
        plural: "Events",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          rooms: { type: "relation", label: "Rooms", to: `${id}.room`, many: true },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          state: { type: "select", label: "State", options: STATES("on", "off") },
        },
        states: {
          field: "state",
          initial: "on",
          moves: [{ from: "on", to: "off", by: ["staff"] }],
        },
        occupies: { thing: "rooms", starts: "startsAt", ends: "endsAt", live: ["on"] },
      },
      // A hire's room use: claimed provisionally while held, firmly once confirmed, with set-up
      // and pack-down. No title: the calendar shows its label, never the hirer.
      use: {
        label: "Room use",
        plural: "Room uses",
        titleField: "hirer",
        fields: {
          hirer: { type: "text", label: "Hirer" },
          price: { type: "number", label: "Price" },
          room: { type: "relation", label: "Room", to: `${id}.room` },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          setUp: { type: "number", label: "Set-up", min: 0 },
          packDown: { type: "number", label: "Pack-down", min: 0 },
          state: {
            type: "select",
            label: "State",
            options: STATES("requested", "held", "confirmed", "released"),
          },
        },
        states: {
          field: "state",
          initial: "requested",
          moves: [
            { from: "requested", to: "held", by: ["staff"] },
            { from: "held", to: "confirmed", by: ["staff"] },
            { from: ["held", "confirmed"], to: "released", by: ["staff"], final: true },
          ],
        },
        occupies: {
          thing: "room",
          starts: "startsAt",
          ends: "endsAt",
          live: ["held", "confirmed"],
          provisional: ["held"],
          before: { field: "setUp" },
          after: { field: "packDown" },
        },
      },
    },
  });

const ext = extId("rmc");
const ROOM = `${ext}.room`;
const SERVICE = `${ext}.service`;
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
const SESSION = `${ext}.session`;
const EVENT = `${ext}.event`;
const USE = `${ext}.use`;

const NOW = "2031-05-31T00:00:00.000Z";
const at = (day: string, time: string) => `2031-06-${day}T${time}:00.000Z`;

let admin: ActingUser;
let extUser: ActingUser;
let staff: ActingUser;
let door: ActingUser;
const as = () => context(admin, { clock: () => new Date(NOW) });
const ROOMS = ["rooms.week", "rooms.check"];
/** A shipped pack's tool run called by `user` (ADR 0625). */
const tool = (user: ActingUser, overrides: { db?: typeof db } = {}) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(NOW),
    ...overrides,
    extension: {
      id: ext,
      permissions: { operations: ROOMS, objects: {} } as never,
      tool: {
        name: "calendar",
        humanOnly: false,
        permission: "rmc:calendar",
        calledBy: { account: user.id, actor: "human" },
      },
    },
  });

beforeAll(async () => {
  admin = await createUser("admin");
  staff = await createUser("member");
  door = await createUser("member");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  // A fixed role's account (a pack role: the door, a coach).
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
    .bind(`${ext}.door`, door.id)
    .run();
  await reconcile(fixture(ext), NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
}, 60_000);

async function create(object: string, values: Record<string, unknown>) {
  return (await invoke("record.create", { object, values }, as())) as {
    id: string;
    values: Record<string, unknown>;
  };
}
async function room(name: string, exclusive = true) {
  return (await create(ROOM, { name, exclusive })).id;
}
async function move(object: string, id: string, to: string) {
  const field = "state";
  return invoke("record.update", { object, id, values: { [field]: to } }, as());
}
async function week(user: ActingUser, input: Record<string, unknown>) {
  return (await invokeByName("rooms.week", input, tool(user))) as {
    claims: Record<string, unknown>[];
    zone: string;
    truncated: boolean;
  };
}

const taken = { code: "conflict", details: { rule: "room_taken" } };

describe("the declaration", () => {
  it("takes provisional states among the live ones and a title that names no person", () => {
    expect(validateManifest(fixture("okrmc")).issues).toEqual([]);
    const broken = fixture("badrmc");
    const objects = broken.objects as Record<string, { occupies?: Record<string, unknown> }>;
    (objects.use as { occupies: Record<string, unknown> }).occupies = {
      ...(objects.use?.occupies ?? {}),
      provisional: ["requested", "held", "held"],
      title: "price",
    };
    (objects.session as { occupies: Record<string, unknown> }).occupies = {
      ...(objects.session?.occupies ?? {}),
      title: "service.nothing",
    };
    (objects.klass as { occupies: Record<string, unknown> }).occupies = {
      ...(objects.klass?.occupies ?? {}),
      title: "series.name.more",
    };
    const issues = validateManifest(broken).issues.map((i) => [i.path, i.message]);
    expect(issues).toEqual(
      expect.arrayContaining([
        [
          "objects.use.occupies.provisional",
          expect.stringContaining('"requested" is not one of live'),
        ],
        ["objects.use.occupies.provisional", "List each state once"],
        ["objects.use.occupies.title", expect.stringContaining('"price" must be a text or select')],
        ["objects.session.occupies.title", expect.stringContaining('"service.nothing"')],
        ["objects.klass.occupies.title", expect.stringContaining('"series.name.more"')],
      ]),
    );
  });
});

describe("rooms.week", () => {
  it("lists every kind of claim with provisional marked, its title, its margins, and no names or money", async () => {
    const studio = await room("Week studio");
    const hall = await room("Week hall");
    const floor = await room("Week floor", false);
    const massage = (await create(SERVICE, { name: "Massage" })).id;
    const klass = await create(KLASS, {
      name: "Morning flow",
      room: studio,
      startsAt: at("02", "06:00"),
      endsAt: at("02", "07:00"),
    });
    const session = await create(SESSION, {
      client: "Avery Client",
      service: massage,
      room: studio,
      startsAt: at("02", "09:00"),
      endsAt: at("02", "10:00"),
    });
    const event = await create(EVENT, {
      name: "Open day",
      rooms: [hall, floor],
      startsAt: at("03", "10:00"),
      endsAt: at("03", "16:00"),
    });
    const held = await create(USE, {
      hirer: "Blake Hirer",
      price: 45000,
      room: studio,
      startsAt: at("04", "18:00"),
      endsAt: at("04", "22:00"),
      setUp: 30,
      packDown: 15,
    });
    await move(USE, held.id, "held");
    const confirmed = await create(USE, {
      hirer: "Casey Hirer",
      price: 90000,
      room: hall,
      startsAt: at("05", "18:00"),
      endsAt: at("05", "20:00"),
    });
    await move(USE, confirmed.id, "held");
    await move(USE, confirmed.id, "confirmed");
    // Requested claims nothing, and a class on a shared floor is never claimed.
    await create(USE, {
      hirer: "Dana",
      room: studio,
      startsAt: at("06", "10:00"),
      endsAt: at("06", "11:00"),
    });
    await create(KLASS, {
      name: "Floor",
      room: floor,
      startsAt: at("02", "06:00"),
      endsAt: at("02", "07:00"),
    });

    const out = await week(staff, {
      from: "2031-06-01",
      to: "2031-06-07",
      roomIds: [studio, hall, floor],
    });
    expect(out.truncated).toBe(false);
    expect(typeof out.zone).toBe("string");
    expect(out.claims).toEqual([
      {
        thing: { object: ROOM, id: studio, name: "Week studio" },
        object: KLASS,
        label: "Class",
        id: klass.id,
        title: "Morning flow",
        startsAt: at("02", "06:00"),
        endsAt: at("02", "07:00"),
        takenFrom: at("02", "06:00"),
        takenTo: at("02", "07:00"),
        provisional: false,
      },
      {
        thing: { object: ROOM, id: studio, name: "Week studio" },
        object: SESSION,
        label: "Session",
        id: session.id,
        // Its service, never its client.
        title: "Massage",
        startsAt: at("02", "09:00"),
        endsAt: at("02", "10:00"),
        takenFrom: at("02", "09:00"),
        takenTo: at("02", "10:00"),
        provisional: false,
      },
      ...[floor, hall].sort().map((id) => ({
        thing: { object: ROOM, id, name: id === hall ? "Week hall" : "Week floor" },
        object: EVENT,
        label: "Event",
        id: event.id,
        // No title declared: the object's label.
        title: "Event",
        startsAt: at("03", "10:00"),
        endsAt: at("03", "16:00"),
        takenFrom: at("03", "10:00"),
        takenTo: at("03", "16:00"),
        provisional: false,
      })),
      {
        thing: { object: ROOM, id: studio, name: "Week studio" },
        object: USE,
        label: "Room use",
        id: held.id,
        title: "Room use",
        startsAt: at("04", "18:00"),
        endsAt: at("04", "22:00"),
        takenFrom: at("04", "17:30"),
        takenTo: at("04", "22:15"),
        provisional: true,
      },
      {
        thing: { object: ROOM, id: hall, name: "Week hall" },
        object: USE,
        label: "Room use",
        id: confirmed.id,
        title: "Room use",
        startsAt: at("05", "18:00"),
        endsAt: at("05", "20:00"),
        takenFrom: at("05", "18:00"),
        takenTo: at("05", "20:00"),
        provisional: false,
      },
    ]);
    const json = JSON.stringify(out);
    for (const secret of ["Avery", "Blake", "Casey", "45000", "90000"]) {
      expect(json).not.toContain(secret);
    }

    // One room only; and a range of dates outside the claims reads nothing.
    const one = await week(staff, { from: "2031-06-04", to: "2031-06-04", roomIds: [studio] });
    expect(one.claims.map((c) => c.id)).toEqual([held.id]);
    expect(
      (await week(staff, { from: "2031-07-01", to: "2031-07-02", roomIds: [studio] })).claims,
    ).toEqual([]);

    // A fixed role's account: only that the room is taken, and when.
    const fixed = await week(door, { from: "2031-06-04", to: "2031-06-04", roomIds: [studio] });
    expect(fixed.claims).toEqual([
      {
        thing: { object: ROOM, id: studio, name: "Week studio" },
        object: null,
        label: null,
        id: null,
        title: null,
        startsAt: null,
        endsAt: null,
        takenFrom: at("04", "17:30"),
        takenTo: at("04", "22:15"),
        provisional: null,
      },
    ]);
  });

  it("is a tool's only, and refuses more than 62 days", async () => {
    await expect(
      invokeByName("rooms.week", { from: "2031-06-01", to: "2031-06-02" }, as()),
    ).rejects.toMatchObject({
      code: "unknown_operation",
    });
    await expect(week(staff, { from: "2031-06-01", to: "2031-08-02" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("rooms.check", () => {
  it("says whether a room is free, half-open, and what takes it", async () => {
    const studio = await room("Check studio");
    const klass = await create(KLASS, {
      name: "Noon class",
      room: studio,
      startsAt: at("10", "12:00"),
      endsAt: at("10", "13:00"),
    });
    const check = async (user: ActingUser, starts: string, ends: string) =>
      (await invokeByName("rooms.check", { roomId: studio, starts, ends }, tool(user))) as {
        free: boolean;
        claims: Record<string, unknown>[];
      };
    expect(await check(staff, at("10", "13:00"), at("10", "14:00"))).toEqual({
      free: true,
      claims: [],
    });
    expect(await check(staff, at("10", "11:00"), at("10", "12:00"))).toEqual({
      free: true,
      claims: [],
    });
    const busy = await check(staff, at("10", "12:30"), at("10", "14:00"));
    expect(busy.free).toBe(false);
    expect(busy.claims.map((c) => [c.id, c.title])).toEqual([[klass.id, "Noon class"]]);
    const fixed = await check(door, at("10", "12:30"), at("10", "14:00"));
    expect(fixed.free).toBe(false);
    expect(fixed.claims.map((c) => [c.id, c.title, c.takenFrom])).toEqual([
      [null, null, at("10", "12:00")],
    ]);
    await expect(check(staff, at("10", "14:00"), at("10", "13:00"))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("the claim behind the calendar", () => {
  it("counts set-up: a use 18:00 to 22:00 with 30 minutes' set-up clashes with a class to 17:45, not one to 17:30", async () => {
    const studio = await room("Set-up studio");
    await create(KLASS, {
      name: "Early",
      room: studio,
      startsAt: at("12", "17:00"),
      endsAt: at("12", "17:45"),
    });
    const use = await create(USE, {
      room: studio,
      startsAt: at("12", "18:00"),
      endsAt: at("12", "22:00"),
      setUp: 30,
    });
    await expect(move(USE, use.id, "held")).rejects.toMatchObject(taken);
    const other = await room("Set-up studio 2");
    await create(KLASS, {
      name: "Early",
      room: other,
      startsAt: at("12", "17:00"),
      endsAt: at("12", "17:30"),
    });
    const fits = await create(USE, {
      room: other,
      startsAt: at("12", "18:00"),
      endsAt: at("12", "22:00"),
      setUp: 30,
    });
    await move(USE, fits.id, "held");
    // Held is provisional, and refuses a class all the same.
    await expect(
      create(KLASS, {
        name: "Late",
        room: other,
        startsAt: at("12", "21:00"),
        endsAt: at("12", "22:00"),
      }),
    ).rejects.toMatchObject(taken);
  });

  it("generation makes a series' date on a room a confirmed use takes without its room; the use is untouched", async () => {
    const studio = await room("Hired studio");
    const use = await create(USE, {
      room: studio,
      startsAt: at("09", "05:00"),
      endsAt: at("09", "09:00"),
    });
    await move(USE, use.id, "held");
    await move(USE, use.id, "confirmed");
    const series = await create(SERIES, {
      name: "Monday hired",
      weekdays: ["mon"],
      time: "06:00",
      length: 60,
      firstDate: "2031-06-02",
      lastDate: "2031-06-16",
      timezone: "UTC",
      room: studio,
    });
    for (let i = 0; i < 20; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(NOW) });
      if (result.series === 0) break;
    }
    const page = await invoke(
      "record.list",
      { object: KLASS, filter: { field: "series", op: "eq", value: series.id }, limit: 100 },
      as(),
    );
    expect(
      page.items
        .map((r) => [String(r.values.startsAt).slice(0, 10), r.values.room])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["2031-06-02", studio],
      ["2031-06-09", null],
      ["2031-06-16", studio],
    ]);
    const after = await invoke("record.get", { object: USE, id: use.id }, as());
    expect(after.values.state).toBe("confirmed");
    expect(after.values.room).toBe(studio);
    const out = await week(staff, { from: "2031-06-09", to: "2031-06-09", roomIds: [studio] });
    expect(out.claims.map((c) => c.id)).toEqual([use.id]);
  });
});

describe("what the calendar costs", () => {
  it("a week of 600 claims over 30 rooms is a handful of statements, whatever the count", async () => {
    // 30 rooms, 20 confirmed uses each, written straight to the table (the triggers claim them).
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push(await room(`Cost room ${i}`));
    const object = getObject(USE);
    const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
    const table = objectTableOf(USE) as string;
    const statements: D1PreparedStatement[] = [];
    ids.forEach((roomId, r) => {
      for (let n = 0; n < 20; n += 1) {
        const starts = new Date(
          Date.parse("2031-08-01T00:00:00.000Z") + n * 7_200_000,
        ).toISOString();
        const ends = new Date(Date.parse(starts) + 3_600_000).toISOString();
        statements.push(
          env.DB.prepare(
            `INSERT INTO ${table} (id, created_at, updated_at, ${col("hirer")}, ${col("startsAt")}, ${col("endsAt")}, ${col("room")}, ${col("state")}) VALUES (?, ?, ?, 'Someone', ?, ?, ?, 'confirmed')`,
          ).bind(`cost${r}x${n}`, NOW, NOW, starts, ends, roomId),
        );
      }
    });
    for (let i = 0; i < statements.length; i += 200)
      await env.DB.batch(statements.slice(i, i + 200));

    let queries = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(s, p) {
                  if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                  if (p === "all" || p === "run" || p === "first" || p === "raw") queries += 1;
                  const value = Reflect.get(s, p);
                  return typeof value === "function" ? value.bind(s) : value;
                },
              });
            return wrap(target.prepare(query));
          };
        }
        if (prop === "batch") {
          return (list: D1PreparedStatement[]) => {
            queries += list.length;
            return target.batch(list);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const out = (await invokeByName(
      "rooms.week",
      { from: "2031-08-01", to: "2031-08-02", roomIds: ids },
      tool(staff, { db: createCrmDb(metered) }),
    )) as { claims: { title: string }[]; truncated: boolean };
    expect(out.claims).toHaveLength(600);
    expect(out.truncated).toBe(false);
    expect(new Set(out.claims.map((c) => c.title))).toEqual(new Set(["Room use"]));
    // The pipeline's own reads, the shipped check, the caller's rights, the settings, the claims,
    // one per occupying object with claims and one for the rooms' names.
    expect(queries).toBeLessThan(20);
  });
});
