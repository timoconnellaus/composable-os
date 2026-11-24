// Stage 49 step 2 (ADR 0765): the `occupies` behaviour on a fixture of classes and sessions in
// rooms (a room marked "one booking at a time" is claimed, a shared one never), sessions whose
// service keeps a gap before and after, and events taking several rooms at once. Two live records
// in one claimed room at once are refused by the database for every writer and every statement
// shape, across objects, with exactly one winner of twenty at once; back-to-back is allowed; the
// Trash and a cancel claim nothing; a restore into a taken time is refused; marking a room
// exclusive over a clash still to come is refused and over a past one is not; installing over
// records that already clash is refused, naming them; a series' generation makes a date whose
// room is taken with no room, kept as its own, and tells the rosterers.
//
// The triggers read the database's clock (a claim that has ended is history), so the records
// here are years ahead ("to come") or years back ("past") of any real clock.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  objectTableOf,
  runRecurringDue,
} from "../src/index.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));
const SCHEDULED = [
  { value: "scheduled", label: "Scheduled" },
  { value: "cancelled", label: "Cancelled" },
  { value: "done", label: "Done" },
];

const rooms = (id: string, options: { occupies?: boolean } = {}) =>
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
        fields: {
          name: { type: "text", label: "Name", required: true },
          bufferBefore: { type: "number", label: "Before", min: 0 },
          bufferAfter: { type: "number", label: "After", min: 0 },
        },
      },
      series: {
        label: "Series",
        plural: "Series",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAYS },
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
          state: { type: "select", label: "State", options: SCHEDULED },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [
            { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
            { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
          ],
        },
        ...(options.occupies === false
          ? {}
          : {
              occupies: {
                thing: "room",
                starts: "startsAt",
                ends: "endsAt",
                live: ["scheduled", "done"],
                only: "exclusive",
              },
            }),
      },
      session: {
        label: "Session",
        plural: "Sessions",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          service: { type: "relation", label: "Service", to: `${id}.service` },
          room: { type: "relation", label: "Room", to: `${id}.room` },
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
          moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
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
      event: {
        label: "Event",
        plural: "Events",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          rooms: { type: "relation", label: "Rooms", to: `${id}.room`, many: true },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "on",
          moves: [{ from: "on", to: "off", by: ["staff"] }],
        },
        // Every room it names, exclusive or not.
        occupies: { thing: "rooms", starts: "startsAt", ends: "endsAt", live: ["on"] },
      },
    },
  });

const ext = extId("occ");
const ROOM = `${ext}.room`;
const SERVICE = `${ext}.service`;
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
const SESSION = `${ext}.session`;
const EVENT = `${ext}.event`;

// The host's clock for writes and generation; the triggers' clock is the database's (see above).
const NOW = "2031-05-31T00:00:00.000Z";
let admin: ActingUser;
const as = (now = NOW) => context(admin, { clock: () => new Date(now) });

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(rooms(ext));
}, 60_000);

/** An instant in June 2031 (to come), or in June 2020 with `past`. */
const at = (day: string, time: string, past = false) =>
  `${past ? "2020" : "2031"}-06-${day}T${time}:00.000Z`;
const unix = (iso: string) => Date.parse(iso) / 1000;

async function create(object: string, values: Record<string, unknown>, now = NOW) {
  return invoke("record.create", { object, values }, as(now));
}
async function update(object: string, id: string, values: Record<string, unknown>, now = NOW) {
  return invoke("record.update", { object, id, values }, as(now));
}
async function room(name: string, exclusive = true) {
  return (await create(ROOM, { name, exclusive })).id as string;
}

async function claims(thing: string) {
  const { results } = await env.DB.prepare(
    "SELECT object_type, record_id, starts, ends FROM core_thing_time WHERE thing_record = ? ORDER BY starts",
  )
    .bind(thing)
    .all<{ object_type: string; record_id: string; starts: number; ends: number }>();
  return results;
}

const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
const table = (object: string) => objectTableOf(object) as string;

const taken = { code: "conflict", details: { rule: "room_taken" } };

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(rooms("okocc")).issues).toEqual([]);
    const broken = rooms("badocc");
    const objects = broken.objects as Record<string, { occupies?: Record<string, unknown> }>;
    (objects.klass as { occupies: Record<string, unknown> }).occupies = {
      thing: "name",
      starts: "name",
      ends: "endsAt",
      live: ["gone"],
    };
    (objects.session as { occupies: Record<string, unknown> }).occupies = {
      thing: "room",
      starts: "startsAt",
      ends: "endsAt",
      live: ["booked"],
      before: { field: "service.name" },
      after: { field: "room.nothing" },
      only: "name",
    };
    const paths = validateManifest(broken).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "objects.klass.occupies.thing",
        "objects.klass.occupies.starts",
        "objects.klass.occupies.live",
        "objects.session.occupies.before.field",
        "objects.session.occupies.after.field",
        "objects.session.occupies.only",
      ]),
    );
  });

  it("requires the start and the end (review of PR #336, finding 7)", () => {
    // A live record with no end would sit in an exclusive room claiming nothing.
    const optional = rooms("optocc");
    const klass = (
      optional.objects as Record<string, { fields: Record<string, { required?: boolean }> }>
    ).klass;
    if (klass?.fields.endsAt) klass.fields.endsAt.required = false;
    expect(validateManifest(optional).issues).toEqual([
      expect.objectContaining({
        path: "objects.klass.occupies.ends",
        message: expect.stringContaining("must be required"),
      }),
    ]);
  });

  it("builds the triggers on the object's, the thing's and the margins' tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
    )
      .bind(`%${table(SESSION)}%`)
      .all<{ name: string }>();
    const S = table(SESSION);
    const via = column(SESSION, "service");
    expect(results.map((r) => r.name)).toEqual(
      [
        `${table(ROOM)}__occupied_${S}_del`,
        `${table(ROOM)}__occupied_${S}_ins`,
        `${table(ROOM)}__occupied_${S}_upd`,
        `${table(SERVICE)}__margins_${S}_${via}_del`,
        `${table(SERVICE)}__margins_${S}_${via}_ins`,
        `${table(SERVICE)}__margins_${S}_${via}_upd`,
        `${S}__occupies_del`,
        `${S}__occupies_ins`,
        `${S}__occupies_upd`,
      ].sort(),
    );
  });
});

describe("a room taken once at a time", () => {
  it("two classes overlapping in an exclusive room: the second is refused; back-to-back is fine", async () => {
    const studio = await room("Studio");
    const first = await create(KLASS, {
      name: "Pilates",
      room: studio,
      startsAt: at("02", "09:00"),
      endsAt: at("02", "10:00"),
    });
    expect(await claims(studio)).toEqual([
      {
        object_type: KLASS,
        record_id: first.id,
        starts: unix(at("02", "09:00")),
        ends: unix(at("02", "10:00")),
      },
    ]);
    await expect(
      create(KLASS, {
        name: "Yoga",
        room: studio,
        startsAt: at("02", "09:30"),
        endsAt: at("02", "10:30"),
      }),
    ).rejects.toMatchObject(taken);
    // The refusal names no other record.
    await expect(
      create(KLASS, {
        name: "Yoga",
        room: studio,
        startsAt: at("02", "09:30"),
        endsAt: at("02", "10:30"),
      }),
    ).rejects.toMatchObject({ details: expect.not.objectContaining({ other: expect.anything() }) });
    const next = await create(KLASS, {
      name: "Yoga",
      room: studio,
      startsAt: at("02", "10:00"),
      endsAt: at("02", "11:00"),
    });
    // Moving it earlier, into the first: refused, and nothing changed.
    await expect(update(KLASS, next.id, { startsAt: at("02", "09:59") })).rejects.toMatchObject(
      taken,
    );
    expect((await claims(studio)).map((c) => c.record_id)).toEqual([first.id, next.id]);
  });

  it("never claims a room that is not exclusive", async () => {
    const floor = await room("Gym floor", false);
    await create(KLASS, {
      name: "Circuit",
      room: floor,
      startsAt: at("03", "09:00"),
      endsAt: at("03", "10:00"),
    });
    await create(KLASS, {
      name: "Boxing",
      room: floor,
      startsAt: at("03", "09:00"),
      endsAt: at("03", "10:00"),
    });
    expect(await claims(floor)).toEqual([]);
  });

  it("claims nothing for a cancelled or trashed class; a restore into a taken time is refused", async () => {
    const studio = await room("Studio B");
    const klass = await create(KLASS, {
      name: "Barre",
      room: studio,
      startsAt: at("04", "09:00"),
      endsAt: at("04", "10:00"),
    });
    await invoke("record.delete", { object: KLASS, id: klass.id }, as());
    expect(await claims(studio)).toEqual([]);
    const other = await create(KLASS, {
      name: "Spin",
      room: studio,
      startsAt: at("04", "09:30"),
      endsAt: at("04", "10:30"),
    });
    await expect(
      invoke("record.restore", { object: KLASS, id: klass.id }, as()),
    ).rejects.toMatchObject(taken);
    await update(KLASS, other.id, { state: "cancelled" });
    expect(await claims(studio)).toEqual([]);
    await invoke("record.restore", { object: KLASS, id: klass.id }, as());
    expect((await claims(studio)).map((c) => c.record_id)).toEqual([klass.id]);
  });

  it("a class over a session in the room is refused, and the reverse", async () => {
    const treatment = await room("Treatment room");
    const service = (await create(SERVICE, { name: "Massage" })).id as string;
    const session = await create(SESSION, {
      name: "Massage",
      service,
      room: treatment,
      startsAt: at("05", "09:00"),
      endsAt: at("05", "10:00"),
    });
    await expect(
      create(KLASS, {
        name: "Stretch",
        room: treatment,
        startsAt: at("05", "09:30"),
        endsAt: at("05", "10:30"),
      }),
    ).rejects.toMatchObject(taken);
    await create(KLASS, {
      name: "Stretch",
      room: treatment,
      startsAt: at("05", "11:00"),
      endsAt: at("05", "12:00"),
    });
    await expect(
      create(SESSION, {
        name: "Massage",
        service,
        room: treatment,
        startsAt: at("05", "11:30"),
        endsAt: at("05", "12:30"),
      }),
    ).rejects.toMatchObject(taken);
    expect((await claims(treatment)).map((c) => c.object_type)).toEqual([SESSION, KLASS]);
    expect(session.id).toBeTruthy();
  });

  it("refuses a live record in a room that ends at or before it starts", async () => {
    const studio = await room("Studio C");
    await expect(
      create(KLASS, {
        name: "Backwards",
        room: studio,
        startsAt: at("06", "10:00"),
        endsAt: at("06", "09:00"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "occupies_time" } });
  });

  it("twenty bookings of one room's time at once leave exactly one", async () => {
    const studio = await room("Rush room");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        create(KLASS, {
          name: `Rush ${i}`,
          room: studio,
          startsAt: at("07", `09:${String(i).padStart(2, "0")}`),
          endsAt: at("07", "11:00"),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject(taken);
    }
    expect(await claims(studio)).toHaveLength(1);
  });
});

describe("margins", () => {
  it("a service's gap after blocks the room's next minutes; its change is followed", async () => {
    const treatment = await room("Treatment 2");
    const service = (await create(SERVICE, { name: "Physio", bufferAfter: 15 })).id as string;
    const session = await create(SESSION, {
      name: "Physio",
      service,
      room: treatment,
      startsAt: at("09", "09:00"),
      endsAt: at("09", "10:00"),
    });
    expect((await claims(treatment))[0]).toMatchObject({
      starts: unix(at("09", "09:00")),
      ends: unix(at("09", "10:15")),
    });
    // A class at 10:00 is inside the gap; at 10:15 it is not.
    await expect(
      create(KLASS, {
        name: "Too soon",
        room: treatment,
        startsAt: at("09", "10:00"),
        endsAt: at("09", "11:00"),
      }),
    ).rejects.toMatchObject(taken);
    const later = await create(KLASS, {
      name: "In time",
      room: treatment,
      startsAt: at("09", "10:15"),
      endsAt: at("09", "11:00"),
    });
    // A longer gap on the service would reach the class: refused, whoever changes it.
    await expect(update(SERVICE, service, { bufferAfter: 30 })).rejects.toMatchObject(taken);
    // A gap before is read the same way; a shorter gap after frees the room sooner.
    await update(SERVICE, service, { bufferAfter: 5, bufferBefore: 10 });
    expect(await claims(treatment)).toEqual([
      {
        object_type: SESSION,
        record_id: session.id,
        starts: unix(at("09", "08:50")),
        ends: unix(at("09", "10:05")),
      },
      expect.objectContaining({ record_id: later.id }),
    ]);
  });
});

describe("several rooms at once", () => {
  it("an event takes each room it names; another in one of them at once is refused", async () => {
    const hall = await room("Hall", false);
    const annex = await room("Annex", false);
    const event = await create(EVENT, {
      name: "Open day",
      rooms: [hall, annex],
      startsAt: at("10", "09:00"),
      endsAt: at("10", "17:00"),
    });
    expect((await claims(hall)).map((c) => c.record_id)).toEqual([event.id]);
    expect((await claims(annex)).map((c) => c.record_id)).toEqual([event.id]);
    await expect(
      create(EVENT, {
        name: "Talk",
        rooms: [annex],
        startsAt: at("10", "12:00"),
        endsAt: at("10", "13:00"),
      }),
    ).rejects.toMatchObject(taken);
    // Taking one off frees it.
    await update(EVENT, event.id, { rooms: [hall] });
    expect(await claims(annex)).toEqual([]);
    await create(EVENT, {
      name: "Talk",
      rooms: [annex],
      startsAt: at("10", "12:00"),
      endsAt: at("10", "13:00"),
    });
  });
});

describe("marking a room exclusive", () => {
  it("is refused while two records still to come overlap in it; a past clash does not stop it", async () => {
    const shared = await room("Shared", false);
    // Two past classes that overlapped, before the room was claimed.
    const pastOne = await create(KLASS, {
      name: "Old one",
      room: shared,
      startsAt: at("11", "09:00", true),
      endsAt: at("11", "10:00", true),
    });
    await create(KLASS, {
      name: "Old two",
      room: shared,
      startsAt: at("11", "09:30", true),
      endsAt: at("11", "10:30", true),
    });
    const one = await create(KLASS, {
      name: "New one",
      room: shared,
      startsAt: at("11", "09:00"),
      endsAt: at("11", "10:00"),
    });
    const two = await create(KLASS, {
      name: "New two",
      room: shared,
      startsAt: at("11", "09:30"),
      endsAt: at("11", "10:30"),
    });
    await expect(update(ROOM, shared, { exclusive: true })).rejects.toMatchObject(taken);
    expect(await claims(shared)).toEqual([]);
    // Settle the clash to come: then it is marked, and the past one stays history.
    await update(KLASS, two.id, { startsAt: at("11", "10:00"), endsAt: at("11", "11:00") });
    await update(ROOM, shared, { exclusive: true });
    expect((await claims(shared)).map((c) => c.record_id)).toEqual([pastOne.id, one.id, two.id]);
    // Editing a past class that clashed is never refused for the room.
    const old = await create(KLASS, {
      name: "Old three",
      room: shared,
      startsAt: at("11", "09:15", true),
      endsAt: at("11", "09:45", true),
    });
    await update(KLASS, old.id, { state: "done" });
    // Turning it off releases every claim.
    await update(ROOM, shared, { exclusive: false });
    expect(await claims(shared)).toEqual([]);
  });
});

describe("every statement shape", () => {
  async function fixture() {
    const studio = await room("Shapes");
    const a = await create(KLASS, {
      name: "A",
      room: studio,
      startsAt: at("12", "09:00"),
      endsAt: at("12", "10:00"),
    });
    const b = await create(KLASS, {
      name: "B",
      room: studio,
      startsAt: at("12", "10:00"),
      endsAt: at("12", "11:00"),
    });
    return { studio, a: a.id as string, b: b.id as string };
  }
  const run = (sql: string, ...binds: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...binds)
      .run();
  const fails = (p: Promise<unknown>) => expect(p).rejects.toThrow(/core_thing_double_booked/);

  it("refuses an overlap written to the occupant's own table, whatever the statement", async () => {
    const { studio, a, b } = await fixture();
    const T = table(KLASS);
    const starts = column(KLASS, "startsAt");
    const ends = column(KLASS, "endsAt");
    const roomColumn = column(KLASS, "room");
    const state = column(KLASS, "state");
    const insert = (verb: string, id: string, from: string, to: string, tail = "") =>
      run(
        `${verb} INTO ${T} (id, created_at, updated_at, ${roomColumn}, ${starts}, ${ends}, ${state}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')${tail}`,
        id,
        NOW,
        NOW,
        studio,
        from,
        to,
      );
    // A plain update, and UPDATE OR REPLACE.
    await fails(run(`UPDATE ${T} SET ${starts} = ? WHERE id = ?`, at("12", "09:30"), b));
    await fails(run(`UPDATE OR REPLACE ${T} SET ${starts} = ? WHERE id = ?`, at("12", "09:30"), b));
    // INSERT OR REPLACE over an existing row, an upsert, and a new row.
    await fails(insert("INSERT OR REPLACE", b, at("12", "09:30"), at("12", "10:30")));
    await fails(
      insert(
        "INSERT",
        b,
        at("12", "09:30"),
        at("12", "11:00"),
        ` ON CONFLICT (id) DO UPDATE SET ${starts} = excluded.${starts}`,
      ),
    );
    await fails(insert("INSERT", "rawocc1", at("12", "09:10"), at("12", "09:20")));
    // Another room given to it: the room it moves into is checked too.
    const other = await room("Shapes 2");
    await run(`UPDATE ${T} SET ${roomColumn} = ? WHERE id = ?`, other, b);
    await run(`UPDATE ${T} SET ${starts} = ? WHERE id = ?`, at("12", "09:30"), b);
    await fails(run(`UPDATE ${T} SET ${roomColumn} = ? WHERE id = ?`, studio, b));
    // Back into a live state from cancelled, over the other: refused.
    await run(`UPDATE ${T} SET ${state} = 'cancelled', ${roomColumn} = ? WHERE id = ?`, studio, b);
    await fails(run(`UPDATE ${T} SET ${state} = 'scheduled' WHERE id = ?`, b));
    // An id update moves the claim with the row; nothing is left on the old id.
    await run(`UPDATE ${T} SET id = 'occmoved1' WHERE id = ?`, a);
    expect((await claims(studio)).map((c) => c.record_id)).toEqual(["occmoved1"]);
    // Out of the Trash, over the other: refused.
    await run(`UPDATE ${T} SET deleted_at = ? WHERE id = 'occmoved1'`, NOW);
    await run(`UPDATE ${T} SET ${state} = 'scheduled' WHERE id = ?`, b);
    await fails(run(`UPDATE ${T} SET deleted_at = NULL WHERE id = 'occmoved1'`));
    // A hard delete releases the claim.
    await run(`DELETE FROM ${T} WHERE id = ?`, b);
    expect(await claims(studio)).toEqual([]);
  });

  it("refuses an overlap written to the claims themselves, whatever the statement", async () => {
    const { studio, a, b } = await fixture();
    const s = unix(at("12", "09:30"));
    const e = unix(at("12", "10:30"));
    const cols = "(object_type, record_id, thing_object, thing_record, starts, ends)";
    await fails(
      run(
        `INSERT INTO core_thing_time ${cols} VALUES ('other.object', 'x1', ?, ?, ?, ?)`,
        ROOM,
        studio,
        s,
        e,
      ),
    );
    await fails(
      run(
        `INSERT OR REPLACE INTO core_thing_time ${cols} VALUES (?, ?, ?, ?, ?, ?)`,
        KLASS,
        b,
        ROOM,
        studio,
        s,
        e,
      ),
    );
    await fails(
      run(
        `INSERT INTO core_thing_time ${cols} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET starts = excluded.starts`,
        KLASS,
        b,
        ROOM,
        studio,
        s,
        e,
      ),
    );
    await fails(
      run(
        "UPDATE core_thing_time SET starts = ? WHERE object_type = ? AND record_id = ?",
        s,
        KLASS,
        b,
      ),
    );
    await fails(
      run(
        "UPDATE OR REPLACE core_thing_time SET record_id = 'y1', starts = ? WHERE object_type = ? AND record_id = ?",
        s,
        KLASS,
        b,
      ),
    );
    // Its own row, rewritten in place, is never its own clash; another thing is free.
    await run(
      "UPDATE core_thing_time SET ends = ends WHERE object_type = ? AND record_id = ?",
      KLASS,
      a,
    );
    await run(
      `INSERT INTO core_thing_time ${cols} VALUES ('other.object', 'x2', ?, 'another', ?, ?)`,
      ROOM,
      s,
      e,
    );
  });

  it("follows the room's flag, id and deletion, whatever the statement", async () => {
    const { studio, a, b } = await fixture();
    const R = table(ROOM);
    const flag = column(ROOM, "exclusive");
    await run(`UPDATE ${R} SET ${flag} = 0 WHERE id = ?`, studio);
    expect(await claims(studio)).toEqual([]);
    await run(`UPDATE ${R} SET ${flag} = 1 WHERE id = ?`, studio);
    expect((await claims(studio)).map((c) => c.record_id)).toEqual([a, b]);
    // A REPLACE of the room row (an insert) derives its claims again.
    await run(
      `INSERT OR REPLACE INTO ${R} (id, created_at, updated_at, ${column(ROOM, "name")}, ${flag}) VALUES (?, ?, ?, 'Shapes', 1)`,
      studio,
      NOW,
      NOW,
    );
    expect((await claims(studio)).map((c) => c.record_id)).toEqual([a, b]);
    // Deleted for good: its classes claim nothing.
    await run(`DELETE FROM ${R} WHERE id = ?`, studio);
    expect(await claims(studio)).toEqual([]);
  });
});

describe("series", () => {
  async function tick(now: string) {
    for (let i = 0; i < 20; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(now) });
      if (result.series === 0) break;
    }
  }

  it("generation makes a date whose room is taken with no room, kept as its own, and tells the rosterers", async () => {
    const studio = await room("Series studio");
    // A one-off on the second Monday at the series' time.
    await create(KLASS, {
      name: "Private hire",
      room: studio,
      startsAt: at("09", "06:30"),
      endsAt: at("09", "07:30"),
    });
    const series = await create(SERIES, {
      name: "Monday flow",
      weekdays: ["mon"],
      time: "06:00",
      length: 60,
      firstDate: "2031-06-02",
      timezone: "UTC",
      room: studio,
    });
    await tick(NOW);
    const page = await invoke(
      "record.list",
      { object: KLASS, filter: { field: "series", op: "eq", value: series.id }, limit: 100 },
      as(),
    );
    const made = page.items
      .map((r) => ({ id: r.id, startsAt: String(r.values.startsAt), room: r.values.room }))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    expect(made.map((c) => [c.startsAt.slice(0, 10), c.room])).toEqual([
      ["2031-06-02", studio],
      ["2031-06-09", null],
      ["2031-06-16", studio],
    ]);
    const { results } = await env.DB.prepare(
      "SELECT field FROM core_recurrence_exception WHERE record_id = ?",
    )
      .bind(made[1]?.id)
      .all<{ field: string }>();
    expect(results).toEqual([{ field: "room" }]);
    const notices = await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE user_id = ? AND title LIKE 'Made with no room:%'",
    )
      .bind(admin.id)
      .all<{ title: string; body: string }>();
    expect(notices.results).toEqual([
      {
        title: "Made with no room: Monday flow on 2031-06-09",
        body: "Series studio is already taken at that time, so Monday flow on 2031-06-09 was made with no room. Give it another room or move it.",
      },
    ]);
  });
});

// The review of PR #336, finding 1: a time any two digits make (`T99:00`, `T09:75`) passed the
// datetime check, was stored as sent, claimed nothing and let a second class into the room.
describe("a time that is not a real time", () => {
  it("is refused at write, and by the trigger for a writer that checks nothing", async () => {
    const studio = await room("Clock room");
    await create(KLASS, {
      name: "Real",
      room: studio,
      startsAt: at("18", "09:00"),
      endsAt: at("18", "10:00"),
    });
    for (const endsAt of [
      "2031-06-18T99:00:00Z",
      "2031-06-18T09:75Z",
      "2031-06-18T10:00:61Z",
      "2031-02-31T10:00:00Z",
      "2031-06-18T10:00+25:00",
    ]) {
      await expect(
        create(KLASS, { name: "Bad", room: studio, startsAt: at("18", "09:10"), endsAt }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // Written past the record operations: refused by the trigger, not let in claiming nothing.
    const T = table(KLASS);
    const insert = (id: string, ends: string) =>
      env.DB.prepare(
        `INSERT INTO ${T} (id, created_at, updated_at, ${column(KLASS, "room")}, ${column(KLASS, "startsAt")}, ${column(KLASS, "endsAt")}, ${column(KLASS, "state")}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`,
      )
        .bind(id, NOW, NOW, studio, at("18", "09:10"), ends)
        .run();
    await expect(insert("unread1", "2031-06-18T99:00:00Z")).rejects.toThrow(
      /core_thing_time_unreadable/,
    );
    await expect(insert("unread2", "")).rejects.toThrow(/core_thing_time_unreadable/);
    expect(await claims(studio)).toHaveLength(1);
    // In a shared room nothing is claimed, so nothing is refused there.
    const floor = await room("Clock floor", false);
    await env.DB.prepare(
      `INSERT INTO ${T} (id, created_at, updated_at, ${column(KLASS, "room")}, ${column(KLASS, "startsAt")}, ${column(KLASS, "endsAt")}, ${column(KLASS, "state")}) VALUES ('unread3', ?, ?, ?, ?, '', 'scheduled')`,
    )
      .bind(NOW, NOW, floor, at("18", "09:10"))
      .run();
  });
});

// The review of PR #336, finding 2: marking a room exclusive over a record still to come that
// overlaps one that has ended was refused or let through by which of the two started first.
describe("a clash between history and what is still to come", () => {
  it("is refused when the room is marked, whichever started first", async () => {
    for (const historyFirst of [true, false]) {
      const shared = await room(`Mixed ${historyFirst}`, false);
      // The one still to come runs from a past date to years ahead of any real clock.
      const long = { startsAt: "2020-06-20T09:00:00.000Z", endsAt: "2039-06-20T09:00:00.000Z" };
      const ended = historyFirst
        ? { startsAt: "2020-06-20T08:00:00.000Z", endsAt: "2020-06-20T10:00:00.000Z" }
        : { startsAt: "2020-06-20T09:30:00.000Z", endsAt: "2020-06-20T10:00:00.000Z" };
      await create(KLASS, { name: "Ended", room: shared, ...ended });
      const running = await create(KLASS, { name: "Running", room: shared, ...long });
      await expect(update(ROOM, shared, { exclusive: true })).rejects.toMatchObject(taken);
      expect(await claims(shared)).toEqual([]);
      // Settled (the running one moved off the old one), it is marked.
      await update(KLASS, running.id, { startsAt: "2020-06-21T09:00:00.000Z" });
      await update(ROOM, shared, { exclusive: true });
      expect(await claims(shared)).toHaveLength(2);
    }
  });
});

// The review of PR #336, finding 6: a run's own dates cannot see each other in the database, so a
// daily class a day long overlapping the next date across a clock change failed the whole run.
describe("a series' own dates overlapping", () => {
  it("makes the later date without the room rather than fail the run", async () => {
    const studio = await room("Long days");
    const series = await create(SERIES, {
      name: "All day",
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "00:00",
      length: 1440,
      firstDate: "2031-10-04",
      lastDate: "2031-10-06",
      timezone: "Australia/Sydney",
      room: studio,
    });
    const clock = "2031-10-01T00:00:00.000Z";
    for (let i = 0; i < 5; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(clock) });
      expect(result.failed).toBe(0);
      if (result.series === 0) break;
    }
    const page = await invoke(
      "record.list",
      { object: KLASS, filter: { field: "series", op: "eq", value: series.id }, limit: 10 },
      as(clock),
    );
    const made = page.items
      .map((r) => [String(r.values.startsAt), r.values.room])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    // Sydney's clocks go forward on 5 October 2031: the 5th's day-long class runs an hour into
    // the 6th's.
    expect(made).toEqual([
      ["2031-10-03T14:00:00.000Z", studio],
      ["2031-10-04T14:00:00.000Z", studio],
      ["2031-10-05T13:00:00.000Z", null],
    ]);
  });
});

describe("a series change", () => {
  it("whose new room is taken on a date is refused whole", async () => {
    const free = await room("Free studio");
    const busy = await room("Busy studio");
    await create(KLASS, {
      name: "Hire",
      room: busy,
      startsAt: at("17", "18:30"),
      endsAt: at("17", "19:30"),
    });
    const series = await create(SERIES, {
      name: "Tuesday flow",
      weekdays: ["tue"],
      time: "18:00",
      length: 60,
      firstDate: "2031-06-03",
      timezone: "UTC",
      room: free,
    });
    for (let i = 0; i < 5; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(NOW) });
      if (result.series === 0) break;
    }
    expect(await claims(free)).toHaveLength(3);
    await expect(update(SERIES, series.id, { room: busy })).rejects.toMatchObject(taken);
    expect(await claims(free)).toHaveLength(3);
  });
});

describe("installing over records that already clash", () => {
  it("is refused for records not yet ended, naming them; past clashes are reported and skipped", async () => {
    const id = extId("occimp");
    const before = "2031-01-01T00:00:00.000Z";
    await reconcile(rooms(id, { occupies: false }), before);
    const studio = (await create(`${id}.room`, { name: "Imported", exclusive: true })).id;
    const one = await create(`${id}.klass`, {
      name: "One",
      room: studio,
      startsAt: at("15", "06:00"),
      endsAt: at("15", "07:00"),
    });
    await create(`${id}.klass`, {
      name: "Two",
      room: studio,
      startsAt: at("15", "06:30"),
      endsAt: at("15", "07:30"),
    });
    const planned = await plan(rooms(id), before);
    expect(planned.issues).toEqual([
      expect.objectContaining({ code: "occupies_conflict", path: "objects.klass.occupies" }),
    ]);
    expect(planned.issues[0]?.message).toContain("One (2031-06-15 06:00 UTC)");
    expect(planned.issues[0]?.message).toContain("Two (2031-06-15 06:30 UTC)");
    // Once both have ended (by the plan's clock): installed; the later one claims nothing.
    const after = "2031-07-01T00:00:00.000Z";
    const installed = await reconcile(rooms(id), after);
    expect(installed.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skip_claims",
          detail: expect.stringContaining("Two (2031-06-15 06:30 UTC)"),
        }),
      ]),
    );
    expect((await claims(studio as string)).map((c) => c.record_id)).toEqual([one.id]);
    // A claim a raw REPLACE left behind (its row gone) is healed by the next reconcile.
    await env.DB.prepare(
      "INSERT INTO core_thing_time (object_type, record_id, thing_object, thing_record, starts, ends) VALUES (?, 'gone', ?, ?, 1, 2)",
    )
      .bind(`${id}.klass`, `${id}.room`, studio)
      .run();
    await reconcile(rooms(id), after);
    expect((await claims(studio as string)).map((c) => c.record_id)).toEqual([one.id]);
    // Taking the declaration away drops its claims and its triggers.
    await reconcile(rooms(id, { occupies: false }), after);
    const { results } = await env.DB.prepare(
      "SELECT object_type FROM core_thing_time WHERE thing_record = ? AND object_type = ?",
    )
      .bind(studio, `${id}.klass`)
      .all();
    expect(results).toEqual([]);
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?",
    )
      .bind(`%x_${id}_klass__occupies%`)
      .all();
    expect(triggers.results).toEqual([]);
  });
});
