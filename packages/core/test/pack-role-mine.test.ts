// Stage 39 step 3 (ADR 0755): a pack role's "mine" reach. A crew-role account reaches a fixture
// pack's jobs, visits and crew places only through its own live crew places, from a week before
// the visit to a week after: a list holds only those (whatever its filter, page or projection), a
// get of any other is not found, and it follows the records on the next call (a place cancelled,
// a visit in the Trash). A call carrying the limit (as a tool run the account started does) finds
// no other record to change, creates no limited or naming record, changes no field deciding the
// reach, and runs no other operation. The declaration's checks refuse what the host cannot hold.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coreRegistry,
  invokeByName,
  loadStaffRights,
  type MineLimit,
  mineWhere,
  roleMineFor,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const ext = extId("mine");
const JOB = `${ext}.job`;
const VISIT = `${ext}.visit`;
const PLACE = `${ext}.place`;
const NOTE = `${ext}.note`;
const ROLE = `${ext}.crew`;
const DAY = 86_400_000;
const WINDOW = { from: "starts", to: "ends", days: 7 };

const m = manifest(ext, {
  objects: {
    job: {
      label: "Job",
      plural: "Jobs",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        job: { type: "relation", label: "Job", to: JOB, personApproves: true },
        starts: { type: "datetime", label: "Starts" },
      },
    },
    place: {
      label: "Crew place",
      plural: "Crew places",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        visit: { type: "relation", label: "Visit", to: VISIT, personApproves: true },
        staff: { type: "user", label: "Staff", personApproves: true },
        starts: { type: "datetime", label: "Starts" },
        ends: { type: "datetime", label: "Ends" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "booked", label: "Booked" },
            { value: "done", label: "Done" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "booked",
        moves: [
          { from: "booked", to: "done", by: ["staff"] },
          { from: "booked", to: "cancelled", by: ["staff"] },
          { from: "cancelled", to: "booked", by: ["staff"] },
        ],
      },
    },
    note: {
      label: "Note",
      plural: "Notes",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
  },
  roles: {
    crew: {
      label: "Crew",
      description: "Fixture: reaches the jobs it has a crew place on.",
      permissions: [],
      read: [JOB, VISIT, PLACE],
      mine: {
        [JOB]: {
          through: PLACE,
          who: "staff",
          path: "visit.job",
          live: ["booked"],
          within: WINDOW,
        },
        [VISIT]: { through: PLACE, who: "staff", path: "visit", live: ["booked"], within: WINDOW },
        [PLACE]: { through: PLACE, who: "staff", live: ["booked"], within: WINDOW },
      },
    },
  },
} as never);

interface Rec {
  id: string;
  values: Record<string, unknown>;
}
interface Page {
  items: Rec[];
  nextCursor: string | null;
}

let admin: ActingUser;
let crew: ActingUser; // holds the crew role
let other: ActingUser; // another crew-role account
let member: ActingUser; // no pack role
type Key = "tomorrow" | "lastWeek" | "nextWeek" | "later" | "past" | "theirs" | "empty" | "none";
const jobs = {} as Record<Key, string>;
const visits = {} as Record<Key, string>;
const places = {} as Record<Key, string>;

const as = (user: ActingUser) => context(user);
const create = async (object: string, values: Record<string, unknown>) =>
  ((await invokeByName("record.create", { object, values }, as(admin))) as Rec).id;
const list = async (user: ActingUser, object: string, extra: Record<string, unknown> = {}) =>
  (await invokeByName("record.list", { object, ...extra }, as(user))) as Page;
const ids = async (user: ActingUser, object: string, extra: Record<string, unknown> = {}) =>
  (await list(user, object, extra)).items.map((r) => r.id).sort();
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** A job with one visit `days` from now and a crew place on it for `who`. */
async function jobWithVisit(key: Key, days: number, who: ActingUser) {
  jobs[key] = await create(JOB, { name: unique(key) });
  visits[key] = await create(VISIT, { name: unique(key), job: jobs[key], starts: at(days) });
  places[key] = await create(PLACE, {
    name: unique(key),
    visit: visits[key],
    staff: who.id,
    starts: at(days),
    ends: new Date(Date.parse(at(days)) + 3_600_000).toISOString(),
  });
}

/** The crew account's limit, as the pipeline gives it to a call the role allows. */
async function limitOf(user: ActingUser): Promise<MineLimit> {
  const op = coreRegistry.get("record.get");
  if (!op) throw new Error("record.get");
  const limit = roleMineFor(await loadStaffRights(db.query, user.id), op, user.id);
  if (!limit) throw new Error("no limit");
  return limit;
}
/** A member's call carrying the crew account's limit, as a tool run the account started does. */
const carrying = async (user: ActingUser) => context(member, { roleMine: await limitOf(user) });

beforeAll(async () => {
  expect(validateManifest(m).issues).toEqual([]);
  admin = await createUser("admin");
  crew = await createUser("member");
  other = await createUser("member");
  member = await createUser("member");
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(m), admin.id, now, now)
    .run();
  for (const user of [crew, other]) {
    await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?")
      .bind(ROLE, user.id)
      .run();
  }
  await jobWithVisit("tomorrow", 1, crew); // reached
  await jobWithVisit("lastWeek", -6, crew); // reached: within a week after
  await jobWithVisit("nextWeek", 6, crew); // reached: within a week before
  await jobWithVisit("later", 20, crew); // too far ahead
  await jobWithVisit("past", -10, crew); // too long ago
  await jobWithVisit("theirs", 1, other); // another account's
  // A visit on a reached job with nobody on it, and a job with no visit.
  visits.empty = await create(VISIT, { name: unique("empty"), job: jobs.tomorrow, starts: at(1) });
  jobs.none = await create(JOB, { name: unique("none") });
});

const reached = () => [jobs.tomorrow, jobs.lastWeek, jobs.nextWeek].sort();

describe("the crew account's reads", () => {
  it("lists only the jobs, visits and places of its own live places within the window", async () => {
    expect(await ids(crew, JOB)).toEqual(reached());
    expect(await ids(crew, VISIT)).toEqual(
      [visits.tomorrow, visits.lastWeek, visits.nextWeek].sort(),
    );
    expect(await ids(crew, PLACE)).toEqual(
      [places.tomorrow, places.lastWeek, places.nextWeek].sort(),
    );
    expect(await ids(other, JOB)).toEqual([jobs.theirs]);
    // Nobody else is limited.
    const all = await ids(member, JOB);
    for (const id of Object.values(jobs)) expect(all).toContain(id);
  });

  it("a filter, a page or a projection cannot reach past it", async () => {
    const theirs = { field: "id", op: "eq", value: jobs.theirs };
    expect(await ids(crew, JOB, { filter: theirs })).toEqual([]);
    expect(
      await ids(crew, JOB, {
        filter: { or: [theirs, { field: "name", op: "contains", value: "later" }] },
      }),
    ).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await list(crew, JOB, { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(reached());
    expect(await ids(crew, JOB, { fields: ["name"] })).toEqual(reached());
  });

  it("a get of anything else is not found", async () => {
    const got = (await invokeByName(
      "record.get",
      { object: JOB, id: jobs.tomorrow },
      as(crew),
    )) as Rec;
    expect(got.id).toBe(jobs.tomorrow);
    for (const key of ["later", "past", "theirs", "none"] as const) {
      await expect(
        invokeByName("record.get", { object: JOB, id: jobs[key] }, as(crew)),
        key,
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(
      invokeByName("record.get", { object: VISIT, id: visits.empty }, as(crew)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      invokeByName("record.get", { object: PLACE, id: places.theirs }, as(crew)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("follows the records on the next call: a place cancelled, a visit in the Trash", async () => {
    const update = (id: string, values: Record<string, unknown>) =>
      invokeByName("record.update", { object: PLACE, id, values }, as(admin));
    await update(places.nextWeek, { state: "cancelled" });
    expect(await ids(crew, JOB)).toEqual([jobs.tomorrow, jobs.lastWeek].sort());
    await update(places.nextWeek, { state: "booked" });
    expect(await ids(crew, JOB)).toEqual(reached());
    await invokeByName("record.delete", { object: VISIT, id: visits.lastWeek }, as(admin));
    expect(await ids(crew, JOB)).toEqual([jobs.tomorrow, jobs.nextWeek].sort());
    await invokeByName("record.restore", { object: VISIT, id: visits.lastWeek }, as(admin));
    expect(await ids(crew, JOB)).toEqual(reached());
    // Moved to someone else: no longer the crew account's.
    await update(places.lastWeek, { staff: other.id });
    expect(await ids(crew, JOB)).toEqual([jobs.tomorrow, jobs.nextWeek].sort());
    expect(await ids(other, JOB)).toEqual([jobs.theirs, jobs.lastWeek].sort());
    await update(places.lastWeek, { staff: crew.id });
    expect(await ids(crew, JOB)).toEqual(reached());
  });

  it("its own role refuses every other operation (the pack role, ADR 0436)", async () => {
    for (const [name, input] of [
      ["record.count", { object: JOB }],
      ["record.update", { object: JOB, id: jobs.tomorrow, values: { name: "x" } }],
      ["task.list", { linkedRecordId: jobs.theirs }],
    ] as const) {
      await expect(invokeByName(name, input, as(crew)), name).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  });
});

describe("a call carrying the limit (a tool run the account started)", () => {
  it("changes only what it reaches, and never what decides the reach", async () => {
    const ctx = await carrying(crew);
    const update = (object: string, id: string, values: Record<string, unknown>) =>
      invokeByName("record.update", { object, id, values }, ctx);
    await update(JOB, jobs.tomorrow, { name: unique("renamed") });
    await expect(update(JOB, jobs.theirs, { name: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    // Each field deciding the reach, on any object, even on a record it reaches.
    for (const [object, id, values] of [
      [PLACE, places.tomorrow, { staff: other.id }],
      [PLACE, places.tomorrow, { starts: at(20) }],
      [PLACE, places.tomorrow, { visit: visits.theirs }],
      [PLACE, places.tomorrow, { state: "done" }],
      [VISIT, visits.tomorrow, { job: jobs.theirs }],
    ] as const) {
      await expect(update(object, id, values), JSON.stringify(values)).rejects.toMatchObject({
        code: "forbidden",
        details: { rule: "role_mine" },
      });
    }
    // A note is no part of the reach: the limit leaves it to the operation.
    const note = await create(NOTE, { name: unique("note") });
    await update(NOTE, note, { name: unique("note") });
    // Nothing changed meanwhile.
    expect(await ids(crew, JOB)).toEqual(reached());
  });

  it("creates no limited record and no record naming someone, but others", async () => {
    const ctx = await carrying(crew);
    for (const [object, values] of [
      [JOB, { name: "x" }],
      [VISIT, { name: "x", job: jobs.theirs }],
      [PLACE, { name: "x", visit: visits.theirs, staff: crew.id, starts: at(1), ends: at(1) }],
    ] as const) {
      await expect(
        invokeByName("record.create", { object, values }, ctx),
        object,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    const note = (await invokeByName(
      "record.create",
      { object: NOTE, values: { name: unique("note") } },
      ctx,
    )) as Rec;
    expect(note.id).toBeTruthy();
    expect(await ids(crew, JOB)).toEqual(reached());
  });

  it("refuses every other operation, whatever it names records by", async () => {
    const ctx = await carrying(crew);
    for (const [name, input] of [
      ["record.count", { object: JOB }],
      ["task.list", { linkedRecordId: jobs.theirs }],
      ["person.list", {}],
      ["record.createMany", { object: NOTE, records: [{ name: "x" }] }],
    ] as const) {
      await expect(invokeByName(name, input, ctx), name).rejects.toMatchObject({
        code: "forbidden",
        details: { rule: "role_mine" },
      });
    }
  });

  it("a member's call without it is not limited", async () => {
    const got = (await invokeByName(
      "record.get",
      { object: JOB, id: jobs.theirs },
      as(member),
    )) as Rec;
    expect(got.id).toBe(jobs.theirs);
  });
});

describe("the list's predicate", () => {
  it("binds the account, the live states and the window's two ends, however many places", async () => {
    const limit = await limitOf(crew);
    const where = mineWhere(limit, JOB, "r", Date.now());
    if (!where) throw new Error("no predicate");
    const compiled = sql`SELECT 1 FROM x AS r WHERE ${where}`.compile(db.query);
    expect(compiled.parameters).toHaveLength(4);
    expect(compiled.parameters[0]).toBe(crew.id);
    expect(mineWhere(limit, NOTE, "r", Date.now())).toBeUndefined();
    expect(mineWhere(undefined, JOB, "r", Date.now())).toBeUndefined();
  });

  it("a reach the registry cannot read reaches nothing (fail closed)", () => {
    const where = mineWhere(
      { userId: crew.id, reach: { [JOB]: { through: `${ext}.gone`, who: "staff", path: [] } } },
      JOB,
      "r",
      Date.now(),
    );
    expect(where?.compile(db.query).sql).toBe("1 = 0");
  });
});

type Fixture = { objects: { [o in "place" | "visit"]: { fields: Record<string, object> } } };

describe("the declaration", () => {
  const issues = (change: (crew: Record<string, Record<string, unknown>>, m: never) => void) => {
    const copy = structuredClone(m) as unknown as {
      roles: { crew: { mine: Record<string, Record<string, unknown>> } };
      objects: Record<string, { fields: Record<string, Record<string, unknown>> }>;
    };
    change(copy.roles.crew.mine, copy as never);
    return validateManifest(copy as never).issues.map((i) => `${i.path}: ${i.message}`);
  };

  it("refuses what the host cannot hold", () => {
    const cases: [(mine: Record<string, Record<string, unknown>>, m: never) => void, RegExp][] = [
      [
        (mine) => Object.assign(mine, { "other.job": mine[JOB] }),
        /is not an object of this extension/,
      ],
      [(mine) => Object.assign(mine[JOB] as object, { through: "other.place" }), /through/],
      [(mine) => Object.assign(mine[JOB] as object, { who: "name" }), /must be a user field/],
      [(mine) => Object.assign(mine[JOB] as object, { path: "visit" }), /leads to .*visit, not/],
      [
        (mine) => Object.assign(mine[JOB] as object, { path: "visit.nope" }),
        /must be a relation field/,
      ],
      [(mine) => Object.assign(mine[JOB] as object, { path: undefined }), /Without a path/],
      [(mine) => Object.assign(mine[JOB] as object, { path: "visit.job.a.b" }), /at most 3/],
      [(mine) => Object.assign(mine[JOB] as object, { live: ["gone"] }), /is not a state/],
      [
        (mine) => Object.assign(mine[JOB] as object, { within: { from: "name", days: 7 } }),
        /must be a datetime field/,
      ],
      [
        (_mine, copy) => {
          (copy as Fixture).objects.place.fields.staff = { type: "user", label: "Staff" };
        },
        /personApproves/,
      ],
      [
        (_mine, copy) => {
          (copy as Fixture).objects.visit.fields.job = { type: "relation", label: "Job", to: JOB };
        },
        /personApproves/,
      ],
      [
        (_mine, copy) => {
          (copy as { roles: { crew: Record<string, unknown> } }).roles.crew.today = { [JOB]: "x" };
        },
        /one limit an object/,
      ],
    ];
    for (const [change, expected] of cases) {
      const found = issues(change);
      expect(found.join("\n"), String(expected)).toMatch(expected);
      expect(found.some((i) => i.startsWith("roles.crew"))).toBe(true);
    }
  });
});
