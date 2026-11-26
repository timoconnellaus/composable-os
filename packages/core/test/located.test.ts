// Stage 64 step 2 (ADR 0911): `located`, `agree`, the reconciler's fill and the located zone
// default, on a fixture of rooms, series and classes at locations. The contract refuses a located
// field that is not a relation to a location, a path that does not end at one, two declarations on
// one object and an agree side that does not reach a location. With one open location a new record
// is at it, and records that existed before the field are filled with the main location, again
// without change. A located record's empty zone is its location's: a series at a second location
// in another zone makes its classes at 06:00 there on both sides of each clock change in both
// zones. A class whose room is at another location is refused for a person, the assistant once
// approved, MCP, an import and a series' generation, and by the database for a path that does not
// read first; a used room's location cannot change. A closed location takes nothing new. Against
// real D1, in one file whose locations build up test by test (the order matters).
import { env } from "cloudflare:workers";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  MAIN_LOCATION_ID,
  objectTableOf,
  PendingApprovalError,
  runRecurringDue,
} from "../src/index.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { auditChanges, context, createUser, db, setPreset, unique } from "./helpers.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));
const STATES = [
  { value: "scheduled", label: "Scheduled" },
  { value: "cancelled", label: "Cancelled" },
];

const where = { type: "relation", label: "Location", to: "location", required: true } as const;

/** A series object generating classes (`agree` when `agrees`), linked by `link`. */
const seriesObject = (
  id: string,
  link: string,
  agrees: boolean,
): ExtensionManifest["objects"][string] => ({
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
    location: where,
  },
  located: { field: "location" },
  ...(agrees ? { agree: [{ a: "location", b: "room.location" }] } : {}),
  recurring: {
    generates: "klass",
    link,
    rule: {
      weekdays: "weekdays",
      time: "time",
      length: "length",
      from: "firstDate",
      until: "lastDate",
      zone: "timezone",
    },
    into: { starts: "startsAt", ends: "endsAt", zone: "timezone", changed: "changed" },
    copy: { name: "name", room: "room", location: "location" },
    cancel: "cancelled",
    horizonDays: 40,
  },
});

const fixture = (id: string) =>
  manifest(id, {
    objects: {
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true }, location: where },
        located: { field: "location" },
      },
      series: seriesObject(id, "series", true),
      // A schedule that does not itself agree: its classes do, so its generation is refused.
      run: seriesObject(id, "run", false),
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          series: { type: "relation", label: "Series", to: `${id}.series`, readOnly: true },
          run: { type: "relation", label: "Run", to: `${id}.run`, readOnly: true },
          room: { type: "relation", label: "Room", to: `${id}.room` },
          location: where,
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          timezone: { type: "timezone", label: "Time zone" },
          changed: { type: "boolean", label: "Changed", readOnly: true },
          state: { type: "select", label: "State", options: STATES },
        },
        states: {
          field: "state",
          initial: "scheduled",
          moves: [{ from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true }],
        },
        located: { field: "location" },
        agree: [{ a: "location", b: "room.location" }],
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          klass: { type: "relation", label: "Class", to: `${id}.klass`, required: true },
          timezone: { type: "timezone", label: "Time zone" },
        },
        located: { path: "klass.location" },
      },
    },
  });

const ext = extId("loc");
const ROOM = `${ext}.room`;
const SERIES = `${ext}.series`;
const RUN = `${ext}.run`;
const KLASS = `${ext}.klass`;
const BOOKING = `${ext}.booking`;

const SYDNEY = "Australia/Sydney";
const LONDON = "Europe/London";
const NOW = "2031-03-01T00:00:00.000Z";
let admin: ActingUser;
const as = (now = NOW) => context(admin, { clock: () => new Date(now) });

async function create(object: string, values: Record<string, unknown>, now = NOW) {
  return (await invoke("record.create", { object, values }, as(now))) as {
    id: string;
    values: Record<string, unknown>;
  };
}
async function update(object: string, id: string, values: Record<string, unknown>) {
  return invoke("record.update", { object, id, values }, as());
}
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}
const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
const table = (object: string) => objectTableOf(object) as string;
const mismatch = { code: "invalid_input", details: { rule: "location_mismatch" } };

/** 06:00 in `zone` on `date`, as the wall clock there reads it. */
function wallClock(iso: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** Runs every series due at `now` until none is; returns how many runs failed. */
async function tick(now: string) {
  let failed = 0;
  for (let i = 0; i < 20; i += 1) {
    const result = await runRecurringDue(db, { clock: () => new Date(now) });
    failed += result.failed;
    if (result.series === 0) break;
  }
  return failed;
}

async function classesOf(link: "series" | "run", id: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, ${column(KLASS, "startsAt")} AS starts, ${column(KLASS, "timezone")} AS zone, ${column(KLASS, "location")} AS location FROM ${table(KLASS)} WHERE ${column(KLASS, link)} = ? AND deleted_at IS NULL ORDER BY 2`,
  )
    .bind(id)
    .all<{ id: string; starts: string; zone: string; location: string }>();
  return results;
}

let harbour: string;

beforeAll(async () => {
  admin = await createUser("admin");
  // The organisation, and so its main location, in Sydney.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).bind(JSON.stringify(SYDNEY), NOW),
    env.DB.prepare("UPDATE core_location SET timezone = ? WHERE main = 1").bind(SYDNEY),
  ]);
  await reconcile(fixture(ext));
}, 60_000);

describe("the declaration", () => {
  it("passes the contract, and each mistake is named", () => {
    expect(validateManifest(fixture("okloc")).issues).toEqual([]);
    const broken = fixture("badloc");
    const objects = broken.objects as Record<string, Record<string, unknown>>;
    const fields = (name: string) =>
      objects[name]?.fields as Record<string, Record<string, unknown>>;
    // Not a relation to a location.
    (objects.room as Record<string, unknown>).located = { field: "name" };
    // A path that does not end at one.
    (objects.booking as Record<string, unknown>).located = { path: "klass.name" };
    // Two declarations on one object.
    (objects.klass as Record<string, unknown>).located = {
      field: "location",
      path: "room.location",
    };
    // An agree side that does not reach a location.
    (objects.series as Record<string, unknown>).agree = [{ a: "location", b: "room.name" }];
    // Not required: a located record is always somewhere.
    (fields("run").location as Record<string, unknown>).required = false;
    const issues = validateManifest(broken).issues;
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.room.located.field",
        "objects.booking.located.path",
        "objects.klass.located",
        "objects.series.agree.0.b",
        "objects.run.located.field",
      ]),
    );
    // Many locations is not one.
    const many = fixture("manyloc");
    const manyFields = (many.objects as Record<string, { fields: Record<string, unknown> }>).room
      ?.fields as Record<string, Record<string, unknown>>;
    (manyFields.location as Record<string, unknown>).many = true;
    expect(validateManifest(many).issues.map((i) => i.path)).toContain(
      "objects.room.located.field",
    );
    // Neither a field nor a path.
    const empty = fixture("emptyloc");
    (
      (empty.objects as Record<string, Record<string, unknown>>).room as Record<string, unknown>
    ).located = {};
    expect(validateManifest(empty).issues.map((i) => i.path)).toContain("objects.room.located");
  });
});

describe("one location", () => {
  it("fills a new record's location, and its empty zone is the location's", async () => {
    const room = await create(ROOM, { name: "Studio" });
    expect(room.values.location).toBe(MAIN_LOCATION_ID);
    const series = await create(SERIES, { name: "Early", room: room.id });
    expect(series.values).toMatchObject({ location: MAIN_LOCATION_ID, timezone: SYDNEY });
    // A booking is at its class's location, so its empty zone is that location's.
    const klass = await create(KLASS, {
      name: "One-off",
      room: room.id,
      startsAt: "2031-05-01T08:00:00.000Z",
      endsAt: "2031-05-01T09:00:00.000Z",
    });
    expect(klass.values).toMatchObject({ location: MAIN_LOCATION_ID, timezone: SYDNEY });
    const booking = await create(BOOKING, { name: "Ann", klass: klass.id });
    expect(booking.values.timezone).toBe(SYDNEY);
  });

  it("fills records that existed before the field with the main location, again without change", async () => {
    const id = extId("fill");
    const before = manifest(id, {
      objects: {
        hall: {
          label: "Hall",
          plural: "Halls",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
        },
      },
    });
    await reconcile(before);
    const a = await create(`${id}.hall`, { name: "North" });
    const b = await create(`${id}.hall`, { name: "South" });
    const after = manifest(id, {
      objects: {
        hall: {
          label: "Hall",
          plural: "Halls",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            location: where,
            timezone: { type: "timezone", label: "Time zone" },
          },
          located: { field: "location" },
        },
      },
    });
    const applied = await reconcile(after);
    expect(applied.issues).toEqual([]);
    const read = async () => {
      const { results } = await env.DB.prepare(
        `SELECT id, ${column(`${id}.hall`, "location")} AS location, ${column(`${id}.hall`, "timezone")} AS zone, updated_at FROM ${table(`${id}.hall`)} ORDER BY id`,
      ).all<{ id: string; location: string; zone: string; updated_at: string }>();
      return results;
    };
    const filled = await read();
    expect(filled.map((r) => [r.id, r.location, r.zone])).toEqual(
      [a.id, b.id].sort().map((rid) => [rid, MAIN_LOCATION_ID, SYDNEY]),
    );
    // Run again: nothing changes.
    await reconcile(after);
    expect(await read()).toEqual(filled);
  });
});

describe("two locations", () => {
  it("a second open location: a new record names its location", async () => {
    harbour = (
      (await invoke(
        "location.create",
        { name: unique("Harbour "), timezone: LONDON },
        context(admin),
      )) as { id: string }
    ).id;
    const refused = await refusal(create(ROOM, { name: "Nowhere" }));
    expect(refused).toMatchObject({ code: "invalid_input", details: { field: "location" } });
  });

  it("a series at the second location makes classes at 06:00 there, either side of each clock change", async () => {
    const room = await create(ROOM, { name: "Harbour hall", location: harbour });
    // London's clocks go forward on 30 March and Sydney's back on 6 April; London's back on
    // 26 October and Sydney's forward on 5 October.
    const spring = await create(SERIES, {
      name: "Spring dawn",
      room: room.id,
      location: harbour,
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "06:00",
      length: 60,
      firstDate: "2031-03-27",
      lastDate: "2031-04-09",
    });
    expect(spring.values.timezone).toBe(LONDON);
    await tick("2031-03-20T00:00:00.000Z");
    const autumn = await create(
      SERIES,
      {
        name: "Autumn dawn",
        room: room.id,
        location: harbour,
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        time: "06:00",
        length: 60,
        firstDate: "2031-10-02",
        lastDate: "2031-10-29",
      },
      "2031-09-25T00:00:00.000Z",
    );
    await tick("2031-09-25T00:00:00.000Z");
    for (const [series, first, last, days] of [
      [spring.id, "2031-03-27", "2031-04-09", 14],
      [autumn.id, "2031-10-02", "2031-10-29", 28],
    ] as const) {
      const made = await classesOf("series", series);
      expect(made).toHaveLength(days);
      for (const row of made) {
        expect(row.zone).toBe(LONDON);
        expect(row.location).toBe(harbour);
        expect(wallClock(row.starts, LONDON).time).toBe("06:00");
      }
      expect(wallClock(made[0]?.starts as string, LONDON).date).toBe(first);
      expect(wallClock(made.at(-1)?.starts as string, LONDON).date).toBe(last);
    }
    // The instants move with London's clocks, not Sydney's.
    const spring1 = (await classesOf("series", spring.id)).map((r) => r.starts);
    expect(spring1).toContain("2031-03-29T06:00:00.000Z");
    expect(spring1).toContain("2031-03-30T05:00:00.000Z");
    expect(spring1).toContain("2031-04-07T05:00:00.000Z");
    const autumn1 = (await classesOf("series", autumn.id)).map((r) => r.starts);
    expect(autumn1).toContain("2031-10-04T05:00:00.000Z");
    expect(autumn1).toContain("2031-10-06T05:00:00.000Z");
    expect(autumn1).toContain("2031-10-26T06:00:00.000Z");
    // A series whose zone is cleared runs in its location's zone too, not the organisation's.
    const cleared = await create(SERIES, {
      name: "Cleared",
      room: room.id,
      location: harbour,
      weekdays: ["wed"],
      time: "06:00",
      length: 60,
      firstDate: "2031-04-02",
      lastDate: "2031-04-09",
    });
    await update(SERIES, cleared.id, { timezone: null });
    await tick("2031-03-20T00:00:00.000Z");
    expect((await classesOf("series", cleared.id)).map((r) => [r.starts, r.zone])).toEqual([
      ["2031-04-02T05:00:00.000Z", LONDON],
      ["2031-04-09T05:00:00.000Z", LONDON],
    ]);
    // A booking at one of them is in London.
    const booking = await create(BOOKING, {
      name: "Bo",
      klass: (await classesOf("series", spring.id))[0]?.id,
    });
    expect(booking.values.timezone).toBe(LONDON);
  });

  it("refuses a class whose room is at another location, for a person and a series of its own", async () => {
    const room = await create(ROOM, { name: "City room", location: MAIN_LOCATION_ID });
    const refused = await refusal(
      create(KLASS, {
        name: "Misplaced",
        room: room.id,
        location: harbour,
        startsAt: "2031-05-02T08:00:00.000Z",
        endsAt: "2031-05-02T09:00:00.000Z",
      }),
    );
    expect(refused).toMatchObject(mismatch);
    // A series that agrees is refused itself.
    expect(
      await refusal(create(SERIES, { name: "Misplaced", room: room.id, location: harbour })),
    ).toMatchObject(mismatch);
    // An update that moves a class away from its room's location.
    const klass = await create(KLASS, {
      name: "Placed",
      room: room.id,
      location: MAIN_LOCATION_ID,
      startsAt: "2031-05-03T08:00:00.000Z",
      endsAt: "2031-05-03T09:00:00.000Z",
    });
    expect(await refusal(update(KLASS, klass.id, { location: harbour }))).toMatchObject(mismatch);
    // With no room, anywhere.
    await update(KLASS, klass.id, { room: null, location: harbour });
  });

  it("refuses it for a series' generation", async () => {
    const room = await create(ROOM, { name: "Generation room", location: MAIN_LOCATION_ID });
    const run = await create(RUN, {
      name: "Misplaced run",
      room: room.id,
      location: harbour,
      weekdays: ["mon"],
      time: "07:00",
      length: 60,
      firstDate: "2031-05-05",
      lastDate: "2031-05-26",
    });
    expect(await tick("2031-05-01T00:00:00.000Z")).toBeGreaterThan(0);
    expect(await classesOf("run", run.id)).toEqual([]);
    // Tried again in an hour, not every minute (it is not a conflict).
    const due = await env.DB.prepare(
      "SELECT next_run_at FROM core_recurrence_series WHERE record_id = ?",
    )
      .bind(run.id)
      .first<{ next_run_at: string }>();
    expect(due?.next_run_at).toBe("2031-05-01T01:00:00.000Z");
  });

  it("refuses it for the assistant once approved, MCP and an import alike", async () => {
    const room = await create(ROOM, { name: unique("Asked "), location: MAIN_LOCATION_ID });
    const values = {
      name: "Asked for",
      room: room.id,
      location: MAIN_LOCATION_ID,
      startsAt: "2031-05-06T08:00:00.000Z",
      endsAt: "2031-05-06T09:00:00.000Z",
    };
    await setPreset("cautious");
    try {
      const assistant = context(admin, { actor: "assistant", clock: () => new Date(NOW) });
      const asked = await invoke("record.create", { object: KLASS, values }, assistant).catch(
        (e: unknown) => e,
      );
      expect(asked).toBeInstanceOf(PendingApprovalError);
      // Meanwhile a person moves the room, unused still, to the other location.
      await update(ROOM, room.id, { location: harbour });
      const decided = await invoke(
        "approval.approve",
        { actionIds: [(asked as PendingApprovalError).pending.actionId] },
        as(),
      ).catch((e: unknown) => e);
      expect(JSON.stringify(decided)).toContain("location_mismatch");
    } finally {
      await setPreset("balanced");
    }
    await setPreset("autonomous");
    try {
      const mcp = context(admin, { actor: "mcp", clock: () => new Date(NOW) });
      expect(await refusal(invoke("record.create", { object: KLASS, values }, mcp))).toMatchObject(
        mismatch,
      );
    } finally {
      await setPreset("balanced");
    }
    // An import reports the record it refused, and writes nothing.
    const imported = await invoke(
      "record.import",
      { object: KLASS, records: [{ key: "old-1", values }] },
      as(),
    );
    expect(JSON.stringify(imported)).toMatch(/"outcome":"invalid"/);
    expect(JSON.stringify(imported)).toContain("not at this class's location");
    const { results } = await env.DB.prepare(
      `SELECT id FROM ${table(KLASS)} WHERE ${column(KLASS, "room")} = ?`,
    )
      .bind(room.id)
      .all();
    expect(results).toEqual([]);
  });

  it("keeps a used room's location, and the database refuses both writes for a path that does not read first", async () => {
    const room = await create(ROOM, { name: unique("Used "), location: MAIN_LOCATION_ID });
    const klass = await create(KLASS, {
      name: "Uses it",
      room: room.id,
      startsAt: "2031-05-07T08:00:00.000Z",
      endsAt: "2031-05-07T09:00:00.000Z",
      location: MAIN_LOCATION_ID,
    });
    const moved = await refusal(update(ROOM, room.id, { location: harbour }));
    expect(moved).toMatchObject(mismatch);
    expect(moved.message).toContain("location.relocate");
    // Read before the batch (the dry run gets it too), naming what uses the room.
    expect(moved.details).toMatchObject({ field: "location", usedBy: KLASS });
    // Past the host's code: the room's trigger, and the class's.
    const R = table(ROOM);
    const K = table(KLASS);
    await expect(
      env.DB.prepare(`UPDATE ${R} SET ${column(ROOM, "location")} = ? WHERE id = ?`)
        .bind(harbour, room.id)
        .run(),
    ).rejects.toThrow(/core_location_in_use/);
    await expect(
      env.DB.prepare(`UPDATE ${K} SET ${column(KLASS, "location")} = ? WHERE id = ?`)
        .bind(harbour, klass.id)
        .run(),
    ).rejects.toThrow(/core_location_mismatch/);
    await expect(
      env.DB.prepare(
        `INSERT INTO ${K} (id, created_at, updated_at, ${column(KLASS, "room")}, ${column(KLASS, "location")}, ${column(KLASS, "startsAt")}, ${column(KLASS, "endsAt")}) VALUES ('raw_class', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(NOW, NOW, room.id, harbour, "2031-05-08T08:00:00.000Z", "2031-05-08T09:00:00.000Z")
        .run(),
    ).rejects.toThrow(/core_location_mismatch/);
    // In the Trash it uses nothing: the room may move, and the class cannot come back.
    await invoke("record.delete", { object: KLASS, id: klass.id }, as());
    await update(ROOM, room.id, { location: harbour });
    expect(
      await refusal(invoke("record.restore", { object: KLASS, id: klass.id }, as())),
    ).toMatchObject(mismatch);
  });

  it("fills a zone added to located records with their location's, and a newly located field with the main location", async () => {
    const id = extId("zone");
    const hall = (located: boolean) =>
      manifest(id, {
        objects: {
          hall: {
            label: "Hall",
            plural: "Halls",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", required: true },
              location: { ...where, required: located },
              ...(located ? { timezone: { type: "timezone", label: "Time zone" } } : {}),
            },
            ...(located ? { located: { field: "location" } } : {}),
          },
        },
      });
    await reconcile(hall(false));
    const there = await create(`${id}.hall`, { name: "Pier", location: harbour });
    const nowhere = await create(`${id}.hall`, { name: "Shed" });
    expect(nowhere.values.location ?? null).toBeNull();
    await reconcile(hall(true));
    const { results } = await env.DB.prepare(
      `SELECT id, ${column(`${id}.hall`, "location")} AS location, ${column(`${id}.hall`, "timezone")} AS zone FROM ${table(`${id}.hall`)}`,
    ).all<{ id: string; location: string; zone: string }>();
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(there.id)).toMatchObject({ location: harbour, zone: LONDON });
    expect(byId.get(nowhere.id)).toMatchObject({ location: MAIN_LOCATION_ID, zone: SYDNEY });
  });

  it("refuses installing over records that already name two locations", async () => {
    const id = extId("over");
    const objects = (agree: boolean): ExtensionManifest["objects"] => ({
      place: {
        label: "Place",
        plural: "Places",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true }, location: where },
        located: { field: "location" },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          place: { type: "relation", label: "Place", to: `${id}.place` },
          location: where,
        },
        located: { field: "location" },
        ...(agree ? { agree: [{ a: "location", b: "place.location" }] } : {}),
      },
    });
    await reconcile(manifest(id, { objects: objects(false) }));
    const place = await create(`${id}.place`, { name: "Pier", location: harbour });
    const visit = await create(`${id}.visit`, {
      name: "Elsewhere",
      place: place.id,
      location: MAIN_LOCATION_ID,
    });
    const planned = await plan(manifest(id, { objects: objects(true) }));
    expect(planned.issues).toMatchObject([
      {
        code: "agree_conflict",
        path: "objects.visit.agree",
        message: expect.stringContaining(visit.id),
      },
    ]);
    // Put right, it installs.
    await update(`${id}.visit`, visit.id, { location: harbour });
    expect((await reconcile(manifest(id, { objects: objects(true) }))).issues).toEqual([]);
  });
});

describe("moving a record to another location", () => {
  const MONDAYS = {
    weekdays: ["mon"],
    time: "06:00",
    length: 60,
    firstDate: "2031-07-07",
    lastDate: "2031-07-28",
  };

  it("takes the new location's zone for a series whose zone was its location's, and its future classes follow", async () => {
    const here = await create(ROOM, { name: unique("Here "), location: MAIN_LOCATION_ID });
    const there = await create(ROOM, { name: unique("There "), location: harbour });
    const series = await create(SERIES, {
      name: "Moving",
      room: here.id,
      location: MAIN_LOCATION_ID,
      ...MONDAYS,
    });
    expect(series.values.timezone).toBe(SYDNEY);
    await tick("2031-07-01T00:00:00.000Z");
    const before = await classesOf("series", series.id);
    expect(before.map((r) => wallClock(r.starts, SYDNEY).time)).toEqual([
      "06:00",
      "06:00",
      "06:00",
      "06:00",
    ]);
    await update(SERIES, series.id, { location: harbour, room: there.id });
    const moved = (await invoke("record.get", { object: SERIES, id: series.id }, as())) as {
      values: Record<string, unknown>;
    };
    expect(moved.values).toMatchObject({ location: harbour, timezone: LONDON });
    const after = await classesOf("series", series.id);
    expect(after).toHaveLength(4);
    for (const row of after) {
      expect(row).toMatchObject({ location: harbour, zone: LONDON });
      expect(wallClock(row.starts, LONDON).time).toBe("06:00");
    }
  });

  it("keeps a zone set by hand, and a zone the same write sets", async () => {
    const here = await create(ROOM, { name: unique("Here "), location: MAIN_LOCATION_ID });
    const there = await create(ROOM, { name: unique("There "), location: harbour });
    const byHand = await create(SERIES, {
      name: "Tokyo time",
      room: here.id,
      location: MAIN_LOCATION_ID,
      timezone: "Asia/Tokyo",
    });
    await update(SERIES, byHand.id, { location: harbour, room: there.id });
    const kept = (await invoke("record.get", { object: SERIES, id: byHand.id }, as())) as {
      values: Record<string, unknown>;
    };
    expect(kept.values).toMatchObject({ location: harbour, timezone: "Asia/Tokyo" });
    const given = await create(SERIES, {
      name: "Given",
      room: here.id,
      location: MAIN_LOCATION_ID,
    });
    await update(SERIES, given.id, {
      location: harbour,
      room: there.id,
      timezone: "Pacific/Auckland",
    });
    const set = (await invoke("record.get", { object: SERIES, id: given.id }, as())) as {
      values: Record<string, unknown>;
    };
    expect(set.values.timezone).toBe("Pacific/Auckland");
  });
});

describe("records filed under the main location", () => {
  it("says so when a field is filled on a host with more than one location", async () => {
    const id = extId("told");
    const hall = (located: boolean) =>
      manifest(id, {
        objects: {
          hall: {
            label: "Hall",
            plural: "Halls",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", required: true },
              ...(located ? { location: where } : {}),
            },
            ...(located ? { located: { field: "location" } } : {}),
          },
        },
      });
    await reconcile(hall(false));
    for (const name of ["A", "B", "C"]) await create(`${id}.hall`, { name });
    const planned = await plan(hall(true));
    expect(planned.issues).toEqual([]);
    expect(planned.changes).toContainEqual({
      kind: "fill_main_location",
      object: `${id}.hall`,
      field: "location",
      detail: expect.stringMatching(/^3 existing halls filed under the main location/),
    });
    // Installed again with nothing to fill, it says nothing.
    await reconcile(hall(true));
    expect((await plan(hall(true))).changes.filter((c) => c.kind === "fill_main_location")).toEqual(
      [],
    );
  });

  it("moves a room with every record that uses it, past and future and in the Trash, in one change", async () => {
    const room = await create(ROOM, { name: unique("Filed "), location: MAIN_LOCATION_ID });
    const series = await create(SERIES, {
      name: "Filed series",
      room: room.id,
      location: MAIN_LOCATION_ID,
    });
    const klass = (day: string) =>
      create(KLASS, {
        name: `Filed ${day}`,
        room: room.id,
        startsAt: `2031-0${day}T08:00:00.000Z`,
        endsAt: `2031-0${day}T09:00:00.000Z`,
        location: MAIN_LOCATION_ID,
      });
    const past = await klass("2-01");
    const future = await klass("8-01");
    const trashed = await klass("8-02");
    await invoke("record.delete", { object: KLASS, id: trashed.id }, as());
    // On its own, refused.
    expect(await refusal(update(ROOM, room.id, { location: harbour }))).toMatchObject(mismatch);
    // An AI only asks.
    await setPreset("autonomous");
    try {
      const mcp = context(admin, { actor: "mcp", clock: () => new Date(NOW) });
      const asked = await invoke(
        "location.relocate",
        { object: ROOM, id: room.id, location: harbour },
        mcp,
      ).catch((e: unknown) => e);
      expect(asked).toBeInstanceOf(PendingApprovalError);
    } finally {
      await setPreset("balanced");
    }
    const result = await invoke(
      "location.relocate",
      { object: ROOM, id: room.id, location: harbour },
      as(),
    );
    expect(result).toMatchObject({
      moved: expect.arrayContaining([
        { object: SERIES, count: 1 },
        { object: KLASS, count: 3 },
      ]),
    });
    const at = async (object: string, rid: string) => {
      const row = await env.DB.prepare(`SELECT * FROM ${table(object)} WHERE id = ?`)
        .bind(rid)
        .first<Record<string, unknown>>();
      return {
        location: row?.[column(object, "location")],
        ...(object === ROOM ? {} : { room: row?.[column(object, "room")] }),
      };
    };
    expect((await at(ROOM, room.id))?.location).toBe(harbour);
    for (const rid of [past.id, future.id, trashed.id]) {
      expect(await at(KLASS, rid)).toEqual({ location: harbour, room: room.id });
    }
    expect(await at(SERIES, series.id)).toEqual({ location: harbour, room: room.id });
    // Times and zones are kept: it files records, it does not move when they happen.
    const kept = (await invoke("record.get", { object: KLASS, id: future.id }, as())) as {
      values: Record<string, unknown>;
    };
    expect(kept.values).toMatchObject({ startsAt: "2031-08-01T08:00:00.000Z", timezone: SYDNEY });
    // The one in the Trash comes back where its room is now.
    await invoke("record.restore", { object: KLASS, id: trashed.id }, as());
    // Audited on the room, by the operation, with what moved with it.
    const changes = await auditChanges(room.id);
    expect(changes.at(-1)).toMatchObject({ operation: "location.relocate", action: "update" });
  });
});

describe("long names", () => {
  it("installs an extension whose names are as long as the contract allows", async () => {
    const id = `l${"o".repeat(26)}${Date.now().toString(36).slice(-3)}`;
    const long = "r".repeat(30);
    const other = "c".repeat(30);
    const m = manifest(id, {
      objects: {
        [long]: {
          label: "Room",
          plural: "Rooms",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true }, location: where },
          located: { field: "location" },
        },
        [other]: {
          label: "Class",
          plural: "Classes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            room: { type: "relation", label: "Room", to: `${id}.${long}` },
            location: where,
          },
          located: { field: "location" },
          agree: [{ a: "location", b: "room.location" }],
        },
      },
    });
    expect(validateManifest(m).issues).toEqual([]);
    expect((await reconcile(m)).issues).toEqual([]);
    const room = await create(`${id}.${long}`, { name: "Long", location: MAIN_LOCATION_ID });
    expect(
      await refusal(create(`${id}.${other}`, { name: "Far", room: room.id, location: harbour })),
    ).toMatchObject(mismatch);
    // Its room's trigger, with a fitted name, refuses a raw move too.
    await create(`${id}.${other}`, { name: "Near", room: room.id, location: MAIN_LOCATION_ID });
    await expect(
      env.DB.prepare(
        `UPDATE ${table(`${id}.${long}`)} SET ${column(`${id}.${long}`, "location")} = ? WHERE id = ?`,
      )
        .bind(harbour, room.id)
        .run(),
    ).rejects.toThrow(/core_location_in_use/);
  });
});

describe("a closed location", () => {
  it("takes no new series, class or room, and its series make nothing until it reopens", async () => {
    const room = await create(ROOM, { name: unique("Closing "), location: harbour });
    const series = await create(SERIES, {
      name: "Before closing",
      room: room.id,
      location: harbour,
      weekdays: ["tue"],
      time: "06:00",
      length: 60,
      firstDate: "2031-06-03",
      lastDate: "2031-06-24",
    });
    await invoke("location.close", { id: harbour }, context(admin));
    try {
      const closed = { code: "invalid_input", details: { rule: "location_closed" } };
      expect(await refusal(create(ROOM, { name: "Late", location: harbour }))).toMatchObject(
        closed,
      );
      expect(
        await refusal(create(SERIES, { name: "Late", room: room.id, location: harbour })),
      ).toMatchObject(closed);
      expect(
        await refusal(
          create(KLASS, {
            name: "Late",
            room: room.id,
            location: harbour,
            startsAt: "2031-06-10T05:00:00.000Z",
            endsAt: "2031-06-10T06:00:00.000Z",
          }),
        ),
      ).toMatchObject(closed);
      // What is already there stays, and can still be changed.
      await update(ROOM, room.id, { name: "Closing room" });
      // It makes nothing, without failing.
      expect(await tick("2031-06-01T00:00:00.000Z")).toBe(0);
      expect(await classesOf("series", series.id)).toEqual([]);
    } finally {
      await invoke("location.reopen", { id: harbour }, context(admin));
    }
    await update(SERIES, series.id, { name: "After reopening" });
    await tick("2031-06-01T00:00:00.000Z");
    expect(await classesOf("series", series.id)).toHaveLength(4);
  });
});
