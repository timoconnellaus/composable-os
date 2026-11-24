// Stage 39 step 2 (ADR 0751): times that follow. On a fixture of visits and crew places (a crew
// member's place on a visit is a shift, `staffed.timesFrom: "visit"`) beside duties (shifts with
// times of their own). A crew place takes its visit's start, end, zone and kind when made and when
// pointed at another visit, and nobody writes them; a visit moved by record.update moves all its
// crew places in the same batch, or, when any would put its person on two overlapping shifts, the
// whole move is refused naming that person and nothing changes. The database copies the times for
// every statement shape on either table, and refuses a clash a raw write makes. Two people putting
// one person on two overlapping visits at once: exactly one succeeds.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getObject, invoke, objectTableOf } from "../src/index.ts";
import { TIMES_FOLLOWERS_MAX } from "../src/staffing/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

const VISIT_STATES = [
  { value: "booked", label: "Booked" },
  { value: "cancelled", label: "Cancelled" },
];

const fixture = (id: string, options: { follows?: boolean } = {}) =>
  manifest(id, {
    objects: {
      vtype: {
        label: "Visit type",
        plural: "Visit types",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          checklist: { type: "checklist", label: "Checklist" },
        },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          visitType: { type: "relation", label: "Visit type", to: `${id}.vtype` },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          zone: { type: "timezone", label: "Time zone" },
          state: { type: "select", label: "State", options: VISIT_STATES },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
        },
      },
      assignment: {
        label: "Crew place",
        plural: "Crew places",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          visit: { type: "relation", label: "Visit", to: `${id}.visit`, required: true },
          staff: { type: "user", label: "Staff" },
          visitType: {
            type: "relation",
            label: "Visit type",
            to: `${id}.vtype`,
            readOnly: options.follows !== false,
          },
          startsAt: { type: "datetime", label: "Starts at", readOnly: options.follows !== false },
          endsAt: { type: "datetime", label: "Ends at", readOnly: options.follows !== false },
          zone: { type: "timezone", label: "Time zone", readOnly: options.follows !== false },
          state: { type: "select", label: "State", options: VISIT_STATES },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff", "host"] }],
          follows: { relation: "visit", when: { cancelled: "cancelled" }, from: ["booked"] },
        },
        staffed: {
          who: { field: "staff" },
          starts: "startsAt",
          ends: "endsAt",
          zone: "zone",
          kind: "visitType",
          live: ["booked"],
          ...(options.follows === false ? {} : { timesFrom: "visit" }),
        },
        checklists: {
          template: "visitType.checklist",
          who: "staff",
          opens: "startsAt",
          closes: "endsAt",
          live: ["booked"],
        },
      },
      duty: {
        label: "Duty",
        plural: "Duties",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          staff: { type: "user", label: "Staff" },
          kind: { type: "relation", label: "Kind", to: `${id}.vtype` },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          state: { type: "select", label: "State", options: VISIT_STATES },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [{ from: "booked", to: "cancelled", by: ["staff"] }],
        },
        staffed: {
          who: { field: "staff" },
          starts: "startsAt",
          ends: "endsAt",
          kind: "kind",
          live: ["booked"],
        },
        checklists: {
          template: "kind.checklist",
          who: "staff",
          opens: "startsAt",
          closes: "endsAt",
          live: ["booked"],
        },
      },
    },
  });

const ext = extId("stf");
const VISIT_TYPE = `${ext}.vtype`;
const VISIT = `${ext}.visit`;
const PLACE = `${ext}.assignment`;
const DUTY = `${ext}.duty`;

const NOW = "2031-05-31T00:00:00.000Z";
const at = (day: string, time: string) => `2031-06-${day}T${time}:00.000Z`;
const s = (iso: string) => Date.parse(iso) / 1000;

let admin: ActingUser;
let member: ActingUser;
const as = (user: ActingUser) => context(user, { clock: () => new Date(NOW) });

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(fixture(ext), NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
}, 60_000);

/** A member with a name, as a refusal names them. */
async function named(name: string) {
  const user = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET name = ? WHERE id = ?").bind(name, user.id).run();
  return user;
}

type Values = Record<string, unknown>;
const create = (object: string, values: Values, user = admin) =>
  invoke("record.create", { object, values }, as(user)) as Promise<Values & { id: string }>;
const update = (object: string, id: string, values: Values, user = admin) =>
  invoke("record.update", { object, id, values }, as(user)) as Promise<
    Values & { id: string; warnings?: unknown[] }
  >;
const get = async (object: string, id: string) =>
  ((await invoke("record.get", { object, id }, as(admin))) as { values: Values }).values;

let kinds: { electrical: string; plumbing: string };
async function kindsOnce() {
  kinds ??= {
    electrical: (await create(VISIT_TYPE, { name: "Electrical" })).id,
    plumbing: (await create(VISIT_TYPE, { name: "Plumbing" })).id,
  };
  return kinds;
}
async function visit(starts: string, ends: string, name = "Visit") {
  const { electrical } = await kindsOnce();
  return (
    await create(VISIT, {
      name,
      visitType: electrical,
      startsAt: starts,
      endsAt: ends,
      zone: "Australia/Sydney",
    })
  ).id;
}
async function place(visitId: string, staff: string | null, user = admin) {
  return (await create(PLACE, { name: "Crew", visit: visitId, staff }, user)).id;
}
async function claims(account: string) {
  const { results } = await env.DB.prepare(
    "SELECT object_type, record_id, starts, ends FROM core_staff_time WHERE account_id = ? ORDER BY starts",
  )
    .bind(account)
    .all<{ object_type: string; record_id: string; starts: number; ends: number }>();
  return results;
}
const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
const table = (object: string) => objectTableOf(object) as string;
const refused = { code: "conflict", details: { rule: "double_booked" } };

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(fixture("okstf")).issues).toEqual([]);
    const broken = fixture("badstf");
    const objects = broken.objects as Record<
      string,
      { fields: Record<string, Record<string, unknown>>; staffed?: Record<string, unknown> }
    >;
    const crew = objects.assignment as (typeof objects)[string];
    crew.fields.visit = { ...crew.fields.visit, required: false };
    crew.fields.endsAt = { ...crew.fields.endsAt, readOnly: false };
    const visitObject = objects.visit as (typeof objects)[string];
    delete visitObject.fields.zone;
    const duty = objects.duty as (typeof objects)[string];
    duty.staffed = { ...duty.staffed, timesFrom: "name" };
    // A visit whose own times follow another record is not followed in turn (a chain).
    visitObject.fields.parent = { type: "relation", label: "Parent", to: "badstf.visit" };
    visitObject.staffed = {
      who: { field: "name" },
      starts: "startsAt",
      ends: "endsAt",
      kind: "visitType",
      live: ["booked"],
      timesFrom: "parent",
    };
    const issues = validateManifest(broken).issues;
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.assignment.staffed.timesFrom",
        "objects.assignment.fields.endsAt.readOnly",
        "objects.duty.staffed.timesFrom",
      ]),
    );
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/"visit" must be required/);
    expect(messages).toMatch(/must have "zone"/);
    expect(messages).toMatch(/"name" must be a relation field/);
    expect(messages).toMatch(/badstf\.visit's own times follow another record/);
  });

  it("builds the triggers on both tables and the crew places' index by visit", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE (type = 'trigger' AND tbl_name IN (?, ?)) OR (type = 'index' AND tbl_name = ?) ORDER BY name",
    )
      .bind(table(VISIT), table(PLACE), table(PLACE))
      .all<{ name: string }>();
    const names = results.map((r) => r.name);
    const pt = table(PLACE);
    expect(names).toEqual(
      expect.arrayContaining([
        `${pt}__times_ins`,
        `${pt}__times_upd`,
        `${table(VISIT)}__times_${pt}_ins`,
        `${table(VISIT)}__times_${pt}_upd`,
        `${pt}__times_${column(PLACE, "visit")}`,
      ]),
    );
    // Duties have times of their own: nothing copies them.
    expect(names.some((n) => n.includes(`__times_${table(DUTY)}`))).toBe(false);
  });
});

describe("a crew place takes its visit's times", () => {
  it("when made, whatever it is given, and nobody writes them", async () => {
    const v = await visit(at("02", "09:00"), at("02", "11:00"));
    const user = await createUser("member");
    const id = await place(v, user.id);
    expect(await get(PLACE, id)).toMatchObject({
      startsAt: at("02", "09:00"),
      endsAt: at("02", "11:00"),
      zone: "Australia/Sydney",
      visitType: (await kindsOnce()).electrical,
    });
    expect(await claims(user.id)).toEqual([
      {
        object_type: PLACE,
        record_id: id,
        starts: s(at("02", "09:00")),
        ends: s(at("02", "11:00")),
      },
    ]);
    for (const values of [
      { visit: v, startsAt: at("02", "12:00") },
      { visit: v, zone: "UTC" },
      { visit: v, visitType: (await kindsOnce()).plumbing },
    ]) {
      await expect(create(PLACE, values)).rejects.toMatchObject({
        code: "invalid_input",
        details: { rule: "times_follow" },
      });
    }
    await expect(update(PLACE, id, { endsAt: at("02", "12:00") })).rejects.toMatchObject({
      details: { rule: "times_follow" },
    });
    // The extension's own code is refused too (a read-only field it could otherwise write).
    const extUser = await createUser("member");
    const own = context(extUser, {
      actor: "extension",
      clock: () => new Date(NOW),
      extension: { id: ext, permissions: { operations: [], objects: {} } as never },
    });
    await expect(
      invoke("record.update", { object: PLACE, id, values: { endsAt: at("02", "12:00") } }, own),
    ).rejects.toMatchObject({ details: { rule: "times_follow" } });
  });

  it("when pointed at another visit", async () => {
    const first = await visit(at("03", "09:00"), at("03", "10:00"));
    const second = await visit(at("03", "13:00"), at("03", "15:00"));
    const user = await createUser("member");
    const id = await place(first, user.id);
    await update(PLACE, id, { visit: second });
    expect(await get(PLACE, id)).toMatchObject({
      startsAt: at("03", "13:00"),
      endsAt: at("03", "15:00"),
    });
    expect((await claims(user.id)).map((c) => c.starts)).toEqual([s(at("03", "13:00"))]);
    // Onto a visit that clashes with the person's duty: refused, naming the duty.
    await create(DUTY, {
      name: "Warehouse",
      staff: user.id,
      startsAt: at("03", "08:00"),
      endsAt: at("03", "09:30"),
    });
    await expect(update(PLACE, id, { visit: first })).rejects.toMatchObject({
      ...refused,
      details: { other: { title: "Warehouse" } },
    });
  });
});

describe("a visit moved by record.update (criterion 2)", () => {
  it("moves all three crew places in the same batch, and tells each", async () => {
    const v = await visit(at("05", "09:00"), at("05", "11:00"), "Rewire");
    const crew = [await named("Ada Crew"), await named("Bo Crew"), await named("Cy Crew")];
    const places = [];
    for (const user of crew) places.push(await place(v, user.id));
    await update(VISIT, v, { startsAt: at("05", "13:00"), endsAt: at("05", "16:00") });
    for (const id of places) {
      expect(await get(PLACE, id)).toMatchObject({
        startsAt: at("05", "13:00"),
        endsAt: at("05", "16:00"),
      });
    }
    for (const user of crew) {
      expect(await claims(user.id)).toEqual([
        expect.objectContaining({ starts: s(at("05", "13:00")), ends: s(at("05", "16:00")) }),
      ]);
      const note = await env.DB.prepare(
        "SELECT title FROM core_notifications WHERE user_id = ? AND title LIKE 'Your shift changed time%'",
      )
        .bind(user.id)
        .first<{ title: string }>();
      expect(note?.title).toBe("Your shift changed time: Crew");
    }
    // Its zone and its type follow too.
    await update(VISIT, v, { zone: "UTC", visitType: (await kindsOnce()).plumbing });
    expect(await get(PLACE, places[0] as string)).toMatchObject({
      zone: "UTC",
      visitType: (await kindsOnce()).plumbing,
    });
  });

  it("is refused whole, naming the person, when one would be on two shifts at once", async () => {
    const v = await visit(at("06", "09:00"), at("06", "11:00"), "Install");
    const free = await named("Free Crew");
    const busy = await named("Busy Crew");
    const other = await named("Other Crew");
    const places = [await place(v, free.id), await place(v, busy.id), await place(v, other.id)];
    const duty = await create(DUTY, {
      name: "Stocktake",
      staff: busy.id,
      startsAt: at("06", "13:00"),
      endsAt: at("06", "14:00"),
    });
    const error = await update(VISIT, v, {
      startsAt: at("06", "12:00"),
      endsAt: at("06", "15:00"),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      ...refused,
      details: {
        account: busy.id,
        shift: { object: PLACE, id: places[1] },
        other: { id: duty.id },
      },
    });
    expect((error as Error).message).toMatch(/^Busy Crew is already on another shift/);
    // Nothing changed: the visit, every crew place and every claim.
    expect(await get(VISIT, v)).toMatchObject({ startsAt: at("06", "09:00") });
    for (const id of places) {
      expect(await get(PLACE, id)).toMatchObject({ startsAt: at("06", "09:00") });
    }
    for (const user of [free, busy, other]) {
      expect((await claims(user.id)).map((c) => c.starts)).toContain(s(at("06", "09:00")));
    }
    expect((await claims(free.id)).map((c) => c.starts)).toEqual([s(at("06", "09:00"))]);
  });

  it("is refused by the database for a write that does not read first", async () => {
    const v = await visit(at("07", "09:00"), at("07", "11:00"));
    const busy = await createUser("member");
    const id = await place(v, busy.id);
    await create(DUTY, {
      name: "Busy",
      staff: busy.id,
      startsAt: at("07", "12:00"),
      endsAt: at("07", "13:00"),
    });
    const starts = column(VISIT, "startsAt");
    const ends = column(VISIT, "endsAt");
    await expect(
      env.DB.prepare(`UPDATE ${table(VISIT)} SET ${starts} = ?, ${ends} = ? WHERE id = ?`)
        .bind(at("07", "11:30"), at("07", "12:30"), v)
        .run(),
    ).rejects.toThrow(/core_staff_double_booked/);
    expect(await get(PLACE, id)).toMatchObject({ startsAt: at("07", "09:00") });
    // A raw move that is free is copied in that statement, claims and all.
    await env.DB.prepare(`UPDATE ${table(VISIT)} SET ${starts} = ?, ${ends} = ? WHERE id = ?`)
      .bind(at("07", "14:00"), at("07", "15:00"), v)
      .run();
    expect(await get(PLACE, id)).toMatchObject({
      startsAt: at("07", "14:00"),
      endsAt: at("07", "15:00"),
    });
    expect((await claims(busy.id)).map((c) => c.starts)).toEqual([
      s(at("07", "12:00")),
      s(at("07", "14:00")),
    ]);
  });
});

describe("every statement shape", () => {
  it("copies on a REPLACE of the visit, and puts back a crew place's own times", async () => {
    const v = await visit(at("08", "09:00"), at("08", "10:00"));
    const user = await createUser("member");
    const id = await place(v, user.id);
    const vt = table(VISIT);
    const pt = table(PLACE);
    const cols = ["startsAt", "endsAt"].map((f) => column(VISIT, f));
    // INSERT OR REPLACE of the visit's row with other times.
    const row = await env.DB.prepare(`SELECT * FROM ${vt} WHERE id = ?`)
      .bind(v)
      .first<Record<string, unknown>>();
    const names = Object.keys(row ?? {});
    const values = names.map((n) =>
      n === cols[0] ? at("08", "15:00") : n === cols[1] ? at("08", "16:00") : row?.[n],
    );
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ${vt} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    )
      .bind(...values)
      .run();
    expect(await get(PLACE, id)).toMatchObject({ startsAt: at("08", "15:00") });
    expect((await claims(user.id)).map((c) => c.starts)).toEqual([s(at("08", "15:00"))]);
    // A raw write of the crew place's own times is put back from its visit.
    await env.DB.prepare(`UPDATE ${pt} SET ${column(PLACE, "startsAt")} = ? WHERE id = ?`)
      .bind(at("08", "14:00"), id)
      .run();
    expect(await get(PLACE, id)).toMatchObject({ startsAt: at("08", "15:00") });
    expect((await claims(user.id)).map((c) => c.starts)).toEqual([s(at("08", "15:00"))]);
    // A raw insert of a crew place with no times takes its visit's.
    const other = await createUser("member");
    await env.DB.prepare(
      `INSERT INTO ${pt} (id, created_at, updated_at, ${column(PLACE, "visit")}, ${column(PLACE, "staff")}, ${column(PLACE, "state")}) VALUES ('raw-place', ?, ?, ?, ?, 'booked')`,
    )
      .bind(NOW, NOW, v, other.id)
      .run();
    expect(await get(PLACE, "raw-place")).toMatchObject({
      startsAt: at("08", "15:00"),
      endsAt: at("08", "16:00"),
    });
    expect((await claims(other.id)).map((c) => c.starts)).toEqual([s(at("08", "15:00"))]);
    // One naming no record, or one that does not exist, has no times to take: refused.
    for (const link of [null, "no-such-visit"]) {
      await expect(
        env.DB.prepare(
          `INSERT INTO ${pt} (id, created_at, updated_at, ${column(PLACE, "visit")}, ${column(PLACE, "staff")}, ${column(PLACE, "state")}, ${column(PLACE, "startsAt")}, ${column(PLACE, "endsAt")}) VALUES ('orphan', ?, ?, ?, ?, 'booked', ?, ?)`,
        )
          .bind(NOW, NOW, link, other.id, at("08", "18:00"), at("08", "19:00"))
          .run(),
      ).rejects.toThrow(/core_staff_times_no_record/);
    }
    await expect(
      env.DB.prepare(`UPDATE ${pt} SET ${column(PLACE, "visit")} = 'no-such-visit' WHERE id = ?`)
        .bind(id)
        .run(),
    ).rejects.toThrow(/core_staff_times_no_record/);
  });

  it("keeps a crew place in the Trash in step, so a restore claims the visit's time", async () => {
    const v = await visit(at("09", "09:00"), at("09", "10:00"));
    const user = await createUser("member");
    const id = await place(v, user.id);
    await invoke("record.delete", { object: PLACE, id }, as(admin));
    expect(await claims(user.id)).toEqual([]);
    await update(VISIT, v, { startsAt: at("09", "11:00"), endsAt: at("09", "12:00") });
    await invoke("record.restore", { object: PLACE, id }, as(admin));
    expect((await claims(user.id)).map((c) => c.starts)).toEqual([s(at("09", "11:00"))]);
  });

  it("cancels crew places with their visit (states.follows) and frees their time", async () => {
    const v = await visit(at("10", "09:00"), at("10", "10:00"));
    const user = await createUser("member");
    const id = await place(v, user.id);
    await update(VISIT, v, { state: "cancelled" });
    expect(await get(PLACE, id)).toMatchObject({ state: "cancelled" });
    expect(await claims(user.id)).toEqual([]);
  });

  it("cancels and moves in one write a visit whose new time its crew is busy at", async () => {
    const v = await visit(at("11", "09:00"), at("11", "10:00"));
    const user = await createUser("member");
    const id = await place(v, user.id);
    const duty = await create(DUTY, {
      name: "Busy",
      staff: user.id,
      startsAt: at("11", "13:00"),
      endsAt: at("11", "14:00"),
    });
    await update(VISIT, v, {
      state: "cancelled",
      startsAt: at("11", "13:00"),
      endsAt: at("11", "14:00"),
    });
    expect(await get(PLACE, id)).toMatchObject({ state: "cancelled", startsAt: at("11", "13:00") });
    expect((await claims(user.id)).map((c) => c.record_id)).toEqual([duty.id]);
  });
});

describe("two people assigning one person to overlapping visits at once (criterion 3)", () => {
  it("leaves exactly one", async () => {
    const a = await visit(at("12", "09:00"), at("12", "11:00"), "A");
    const b = await visit(at("12", "10:00"), at("12", "12:00"), "B");
    const user = await createUser("member");
    const results = await Promise.allSettled([place(a, user.id, admin), place(b, user.id, member)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject(refused);
    expect(await claims(user.id)).toHaveLength(1);
  });
});

describe("how many follow one visit", () => {
  it(`refuses a crew place beyond ${TIMES_FOLLOWERS_MAX}, so the visit can always move`, async () => {
    const v = await visit(at("14", "09:00"), at("14", "10:00"));
    for (let i = 0; i < TIMES_FOLLOWERS_MAX; i += 1) await place(v, null);
    const full = { code: "conflict", details: { rule: "times_follow_too_many", object: PLACE } };
    await expect(place(v, null)).rejects.toMatchObject(full);
    // Nor pointed at it from another visit.
    const other = await visit(at("14", "11:00"), at("14", "12:00"));
    const moving = await place(other, null);
    await expect(update(PLACE, moving, { visit: v })).rejects.toMatchObject(full);
    // A full visit still moves.
    await update(VISIT, v, { startsAt: at("14", "08:00") });
  });

  it("refuses moving a visit whose crew places passed the bound some other way", async () => {
    const v = await visit(at("15", "09:00"), at("15", "10:00"));
    const pt = table(PLACE);
    const rows = Array.from({ length: TIMES_FOLLOWERS_MAX + 1 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO ${pt} (id, created_at, updated_at, ${column(PLACE, "visit")}, ${column(PLACE, "state")}) VALUES (?, ?, ?, ?, 'booked')`,
      ).bind(`bulk-${i}`, NOW, NOW, v),
    );
    await env.DB.batch(rows);
    await expect(update(VISIT, v, { startsAt: at("15", "08:00") })).rejects.toMatchObject({
      code: "conflict",
      details: { rule: "times_follow_too_many", object: PLACE },
    });
    // A write that leaves its times alone is not one of theirs.
    await update(VISIT, v, { name: "Renamed" });
  });
});

describe("declared over crew places written before", () => {
  it("copies each visit's times onto its crew places at the reconcile", async () => {
    const id = extId("stfup");
    await reconcile(fixture(id, { follows: false }), NOW);
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
    )
      .bind(id, admin.id, NOW, NOW)
      .run();
    const v = (
      await create(`${id}.visit`, {
        name: "Old",
        startsAt: at("16", "09:00"),
        endsAt: at("16", "10:00"),
      })
    ).id;
    const user = await createUser("member");
    const p = (
      await create(`${id}.assignment`, {
        visit: v,
        staff: user.id,
        startsAt: at("16", "13:00"),
        endsAt: at("16", "14:00"),
      })
    ).id;
    await reconcile(fixture(id), NOW);
    expect(await get(`${id}.assignment`, p)).toMatchObject({
      startsAt: at("16", "09:00"),
      endsAt: at("16", "10:00"),
    });
    expect((await claims(user.id)).map((c) => c.starts)).toEqual([s(at("16", "09:00"))]);
  });
});

describe("where a pack declares who rosters", () => {
  it("a visit under way is moved only by a rosterer, and only a rosterer assigns crew", async () => {
    const roster = extId("stfroster");
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
    )
      .bind(roster, JSON.stringify({ staffing: { rosters: `${roster}:team` } }), admin.id, NOW, NOW)
      .run();
    try {
      const v = await visit("2031-05-30T23:00:00.000Z", "2031-05-31T02:00:00.000Z");
      const user = await createUser("member");
      await place(v, user.id);
      await expect(
        update(VISIT, v, { endsAt: "2031-05-31T03:00:00.000Z" }, member),
      ).rejects.toMatchObject({ code: "forbidden", details: { rule: "rostering" } });
      expect(await get(VISIT, v)).toMatchObject({ endsAt: "2031-05-31T02:00:00.000Z" });
      await update(VISIT, v, { endsAt: "2031-05-31T03:00:00.000Z" }, admin);
      // A visit not yet started is moved by whoever may write it; putting someone on it is not.
      const later = await visit(at("20", "09:00"), at("20", "10:00"));
      const other = await createUser("member");
      await expect(place(later, other.id, member)).rejects.toMatchObject({
        details: { rule: "rostering" },
      });
      await place(later, other.id, admin);
      await update(VISIT, later, { startsAt: at("20", "08:00") }, member);
      expect((await claims(other.id)).map((c) => c.starts)).toEqual([s(at("20", "08:00"))]);
      // Changing the type of a visit with crew changes which checklist they tick: a rosterer's,
      // as changing a shift's own kind is (ADR 0650, the review of PR #419).
      const checklist = "chk-safety";
      await env.DB.prepare(
        "INSERT INTO core_checklist (id, name, created_by, created_at, updated_by, updated_at) VALUES (?, 'Safety check', ?, ?, ?, ?)",
      )
        .bind(checklist, admin.id, NOW, admin.id, NOW)
        .run();
      const withList = (await create(VISIT_TYPE, { name: "Gas", checklist })).id;
      const plain = (await kindsOnce()).plumbing;
      const duty = await create(DUTY, { name: "Control", kind: withList });
      await expect(update(DUTY, duty.id, { kind: plain }, member)).rejects.toMatchObject({
        details: { rule: "rostering" },
      });
      const gas = (
        await create(VISIT, {
          name: "Gas",
          visitType: withList,
          startsAt: at("21", "09:00"),
          endsAt: at("21", "10:00"),
        })
      ).id;
      const crewPlace = await place(gas, (await createUser("member")).id, admin);
      await expect(update(VISIT, gas, { visitType: plain }, member)).rejects.toMatchObject({
        code: "forbidden",
        details: { rule: "rostering" },
      });
      expect(await get(PLACE, crewPlace)).toMatchObject({ visitType: withList });
      await update(VISIT, gas, { visitType: plain }, admin);
      expect(await get(PLACE, crewPlace)).toMatchObject({ visitType: plain });
    } finally {
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(roster).run();
    }
  });
});
