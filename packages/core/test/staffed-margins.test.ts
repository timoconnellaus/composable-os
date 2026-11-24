// Stage 49 step 1 (ADRs 0760 and 0761): claim margins, a required account, and a shift whose title
// may name a client. On a fixture of one-to-one sessions (each a service with a buffer before and
// after, a coach profile that must hold an account, the client's name as the title) beside classes
// (no margins, a profile with no account allowed). A buffer is in the claim, refused by the
// database for every writer, followed when the service's minutes change (every statement shape on
// the service's table), never in the shift's own times (the feed); two classes back to back stay
// allowed. A session naming a profile with no account is refused at write and by the trigger, and
// the profile keeps its account while such a session has not ended; history is never refused. The
// roster shows a session as its service to anyone but its coach and those who roster; a clash
// answer names it by its service; it is never offered. The database's own clock decides what has
// ended, so the dates here are years ahead of it (2031) or behind it (2020).
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  getObject,
  invoke,
  objectTableOf,
  runRecurringDue,
} from "../src/index.ts";
import { feedShifts } from "../src/staffing/feed.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
  value,
  label: value,
}));

const SESSION_STATES = [
  { value: "booked", label: "Booked" },
  { value: "cancelled", label: "Cancelled" },
  { value: "attended", label: "Attended" },
];

const fixture = (id: string, options: { margins?: boolean } = {}) =>
  manifest(id, {
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
          bufferBefore: { type: "number", label: "Buffer before" },
          bufferAfter: { type: "number", label: "Buffer after" },
        },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          kind: { type: "relation", label: "Class type", to: `${id}.kind` },
          coach: { type: "relation", label: "Coach", to: `${id}.coach` },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
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
          moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
        },
        staffed: {
          who: { field: "coach", account: "user" },
          starts: "startsAt",
          ends: "endsAt",
          kind: "kind",
          live: ["scheduled"],
        },
      },
      standing: {
        label: "Standing session",
        plural: "Standing sessions",
        titleField: "client",
        fields: {
          client: { type: "text", label: "Client", required: true },
          weekdays: { type: "multiSelect", label: "Weekdays", options: WEEKDAYS },
          time: { type: "text", label: "Time" },
          length: { type: "number", label: "Length" },
          firstDate: { type: "date", label: "First date" },
          timezone: { type: "timezone", label: "Time zone" },
          coach: { type: "relation", label: "Coach", to: `${id}.coach` },
          service: { type: "relation", label: "Service", to: `${id}.service` },
        },
        recurring: {
          generates: "session",
          link: "series",
          rule: {
            weekdays: "weekdays",
            time: "time",
            length: "length",
            from: "firstDate",
            zone: "timezone",
          },
          into: { starts: "startsAt", ends: "endsAt" },
          copy: { coach: "coach", service: "service", client: "client" },
          cancel: "cancelled",
          horizonDays: 14,
        },
      },
      session: {
        label: "Session",
        plural: "Sessions",
        titleField: "client",
        fields: {
          client: { type: "text", label: "Client" },
          series: { type: "relation", label: "Series", to: `${id}.standing`, readOnly: true },
          service: { type: "relation", label: "Service", to: `${id}.service` },
          coach: { type: "relation", label: "Coach", to: `${id}.coach` },
          startsAt: { type: "datetime", label: "Starts at" },
          endsAt: { type: "datetime", label: "Ends at" },
          state: { type: "select", label: "State", options: SESSION_STATES },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [
            { from: "booked", to: "cancelled", by: ["staff", "host"] },
            { from: "booked", to: "attended", by: ["staff"] },
          ],
        },
        staffed: {
          who: { field: "coach", account: "user" },
          starts: "startsAt",
          ends: "endsAt",
          kind: "service",
          live: ["booked", "attended"],
          ...(options.margins === false
            ? {}
            : {
                claimBefore: { field: "service.bufferBefore" },
                claimAfter: { field: "service.bufferAfter" },
                account: "required" as const,
                private: true,
              }),
        },
      },
    },
  });

const ext = extId("stm");
const COACH = `${ext}.coach`;
const SERVICE = `${ext}.service`;
const KLASS = `${ext}.klass`;
const SESSION = `${ext}.session`;

const NOW = "2031-05-31T00:00:00.000Z";
const at = (day: string, time: string) => `2031-06-${day}T${time}:00.000Z`;
const past = (day: string, time: string) => `2020-06-${day}T${time}:00.000Z`;
const s = (iso: string) => Date.parse(iso) / 1000;

let admin: ActingUser;
let extUser: ActingUser;
const as = (user: ActingUser, now = NOW) => context(user, { clock: () => new Date(now) });
const STAFFING = ["staffing.week", "staffing.offer", "staffing.candidates"];
/** A shipped pack's tool run for `user` (ADR 0625), as staffing-offers.test.ts makes it. */
const tool = (user: ActingUser) =>
  context(extUser, {
    actor: "extension",
    clock: () => new Date(NOW),
    extension: {
      id: ext,
      permissions: { operations: STAFFING, objects: {} } as never,
      tool: {
        name: "roster",
        humanOnly: true,
        permission: "rostering:team",
        calledBy: { account: user.id, actor: "human" },
      },
    },
  });

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await reconcile(fixture(ext), NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
}, 60_000);

async function create(object: string, values: Record<string, unknown>) {
  return invoke("record.create", { object, values }, as(admin));
}
async function update(object: string, id: string, values: Record<string, unknown>) {
  return invoke("record.update", { object, id, values }, as(admin));
}
/** A staff account and its coach profile. */
async function coach(name = "Coach") {
  const user = await createUser("member");
  const profile = await create(COACH, { name, user: user.id });
  return { user, profile: profile.id as string };
}
async function service(name: string, bufferBefore: number | null, bufferAfter: number | null) {
  return (await create(SERVICE, { name, bufferBefore, bufferAfter })).id as string;
}
async function session(
  coachId: string | null,
  serviceId: string,
  starts: string,
  ends: string,
  client = "A client",
) {
  return (await create(SESSION, {
    client,
    service: serviceId,
    coach: coachId,
    startsAt: starts,
    endsAt: ends,
  })) as { id: string };
}
async function klass(coachId: string | null, starts: string, ends: string, name = "Class") {
  return (await create(KLASS, { name, coach: coachId, startsAt: starts, endsAt: ends })) as {
    id: string;
  };
}

interface ClaimRow {
  object_type: string;
  record_id: string;
  starts: number;
  ends: number;
  margin_before: number;
  margin_after: number;
}
async function claims(account: string) {
  const { results } = await env.DB.prepare(
    "SELECT object_type, record_id, starts, ends, margin_before, margin_after FROM core_staff_time WHERE account_id = ? ORDER BY starts",
  )
    .bind(account)
    .all<ClaimRow>();
  return results;
}
async function claimOf(id: string) {
  return env.DB.prepare(
    "SELECT object_type, record_id, starts, ends, margin_before, margin_after FROM core_staff_time WHERE record_id = ?",
  )
    .bind(id)
    .first<ClaimRow>();
}

const column = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column as string;
const table = (object: string) => objectTableOf(object) as string;
const refused = { code: "conflict", details: { rule: "double_booked" } };

describe("the declaration", () => {
  it("passes the contract, and its mistakes are named", () => {
    expect(validateManifest(fixture("okstm")).issues).toEqual([]);
    const broken = fixture("badstm");
    const objects = broken.objects as Record<string, { staffed?: Record<string, unknown> }>;
    const session = objects.session as { staffed: Record<string, unknown> };
    session.staffed = {
      ...session.staffed,
      claimBefore: { field: "coach.name" },
      claimAfter: { field: "service.name" },
    };
    const duty = objects.klass as { staffed: Record<string, unknown> };
    duty.staffed = { ...duty.staffed, who: { field: "name" }, account: "required" };
    const issues = validateManifest(broken).issues;
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        "objects.session.staffed.claimBefore.field",
        "objects.session.staffed.claimAfter.field",
        "objects.klass.staffed.account",
      ]),
    );
    expect(issues.find((i) => i.path.endsWith("claimAfter.field"))?.message).toMatch(
      /number field/,
    );
  });

  it("builds the triggers on the service's table and the session's index by service", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE (type = 'trigger' AND (tbl_name = ? OR tbl_name = ?)) OR (type = 'index' AND tbl_name = ?) ORDER BY name",
    )
      .bind(table(SERVICE), table(COACH), table(SESSION))
      .all<{ name: string }>();
    const names = results.map((r) => r.name);
    const st = table(SESSION);
    expect(names).toEqual(
      expect.arrayContaining([
        `${table(SERVICE)}__margins_${st}_ins`,
        `${table(SERVICE)}__margins_${st}_upd`,
        `${table(SERVICE)}__margins_${st}_del`,
        `${table(COACH)}__requires_${st}_ins`,
        `${table(COACH)}__requires_${st}_upd`,
        `${table(COACH)}__requires_${st}_del`,
        `${st}__${column(SESSION, "service")}`,
      ]),
    );
    // Classes declare no margins and no required account: nothing of the kind on theirs.
    expect(names.some((n) => n.includes(`__requires_${table(KLASS)}`))).toBe(false);
  });
});

describe("claim margins (a service's buffer)", () => {
  it("claims the buffer, never the session's own time, and keeps how much", async () => {
    const { user, profile } = await coach();
    const pt = await service("Personal training", 10, 15);
    const made = await session(profile, pt, at("02", "10:00"), at("02", "11:00"));
    expect(await claimOf(made.id)).toMatchObject({
      starts: s(at("02", "09:50")),
      ends: s(at("02", "11:15")),
      margin_before: 600,
      margin_after: 900,
    });
    // The session's own times are as written.
    const stored = await invoke("record.get", { object: SESSION, id: made.id }, as(admin));
    expect(stored.values).toMatchObject({ startsAt: at("02", "10:00"), endsAt: at("02", "11:00") });
    // The feed shows the session's own time and its service, never the client.
    const feed = await feedShifts(db.query, user.id, new Date(NOW));
    expect(feed).toEqual([
      expect.objectContaining({
        id: made.id,
        title: "Personal training",
        startsAt: at("02", "10:00"),
        endsAt: at("02", "11:00"),
      }),
    ]);
  });

  it("refuses a class inside the buffer for every writer; just after it is allowed", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT buffered", null, 15);
    await session(profile, pt, at("03", "10:00"), at("03", "11:00"));
    // The read before the write names the session by its service, never its client.
    await expect(klass(profile, at("03", "11:00"), at("03", "12:00"))).rejects.toMatchObject({
      ...refused,
      details: { other: { title: "PT buffered", startsAt: at("03", "10:00") } },
    });
    // A raw insert: refused by the database.
    await expect(
      env.DB.prepare(
        `INSERT INTO ${table(KLASS)} (id, ${column(KLASS, "coach")}, ${column(KLASS, "startsAt")}, ${column(KLASS, "endsAt")}, ${column(KLASS, "state")}, created_at, updated_at) VALUES ('raw_stm_1', ?, ?, ?, 'scheduled', ?, ?)`,
      )
        .bind(profile, at("03", "11:10"), at("03", "12:00"), NOW, NOW)
        .run(),
    ).rejects.toThrow(/core_staff_double_booked/);
    // After the buffer: fine. And a session right after a class: a class keeps no margin, but
    // the session's own buffer before reaches back.
    await klass(profile, at("03", "11:15"), at("03", "12:15"));
    expect((await claims(user.id)).map((c) => c.ends - c.starts)).toEqual([75 * 60, 60 * 60]);
  });

  it("keeps two classes back to back allowed", async () => {
    const { user, profile } = await coach();
    await klass(profile, at("04", "06:00"), at("04", "07:00"));
    await klass(profile, at("04", "07:00"), at("04", "08:00"));
    expect(await claims(user.id)).toHaveLength(2);
  });

  it("a buffer before reaches back over a class that ends just before", async () => {
    const { profile } = await coach();
    const pt = await service("PT before", 15, null);
    await klass(profile, at("05", "09:00"), at("05", "10:00"));
    await expect(session(profile, pt, at("05", "10:00"), at("05", "11:00"))).rejects.toMatchObject(
      refused,
    );
    await session(profile, pt, at("05", "10:15"), at("05", "11:15"));
  });

  it("follows a change of the service's minutes, refused when it would reach a shift", async () => {
    const { profile } = await coach();
    const pt = await service("PT followed", 0, 0);
    const first = await session(profile, pt, at("06", "10:00"), at("06", "11:00"));
    await klass(profile, at("06", "11:30"), at("06", "12:30"));
    await update(SERVICE, pt, { bufferAfter: 20 });
    expect(await claimOf(first.id)).toMatchObject({
      ends: s(at("06", "11:20")),
      margin_after: 1200,
    });
    // 45 minutes would reach the class: refused, whole, by the database.
    await expect(update(SERVICE, pt, { bufferAfter: 45 })).rejects.toMatchObject(refused);
    expect(await claimOf(first.id)).toMatchObject({ margin_after: 1200 });
    // A session given another service takes that service's minutes.
    const short = await service("PT short", 0, 5);
    await update(SESSION, first.id, { service: short });
    expect(await claimOf(first.id)).toMatchObject({ margin_after: 300 });
  });

  it("leaves the claims of sessions that have ended as they were: history never refuses", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT history", 0, 0);
    // Back to back in the past, then a buffer that would make them overlap.
    const a = await session(profile, pt, past("01", "10:00"), past("01", "11:00"));
    const b = await session(profile, pt, past("01", "11:00"), past("01", "12:00"));
    const next = await session(profile, pt, at("07", "10:00"), at("07", "11:00"));
    await update(SERVICE, pt, { bufferAfter: 30 });
    expect(await claimOf(a.id)).toMatchObject({ margin_after: 0 });
    expect(await claimOf(b.id)).toMatchObject({ margin_after: 0 });
    expect(await claimOf(next.id)).toMatchObject({ margin_after: 1800 });
    expect(await claims(user.id)).toHaveLength(3);
  });

  it("follows every statement shape on the service's table", async () => {
    const { profile } = await coach();
    const pt = await service("PT shapes", 0, 10);
    const made = await session(profile, pt, at("08", "10:00"), at("08", "11:00"));
    const st = table(SERVICE);
    const after = column(SERVICE, "bufferAfter");
    const name = column(SERVICE, "name");
    const margin = async () => (await claimOf(made.id))?.margin_after;
    // A raw UPDATE.
    await env.DB.prepare(`UPDATE ${st} SET ${after} = 20 WHERE id = ?`).bind(pt).run();
    expect(await margin()).toBe(1200);
    // A REPLACE (an insert first): the replaced row's claims follow the new one.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ${st} (id, ${name}, ${after}, created_at, updated_at) VALUES (?, 'PT shapes', 25, ?, ?)`,
    )
      .bind(pt, NOW, NOW)
      .run();
    expect(await margin()).toBe(1500);
    // An upsert.
    await env.DB.prepare(
      `INSERT INTO ${st} (id, ${name}, ${after}, created_at, updated_at) VALUES (?, 'PT shapes', 5, ?, ?) ON CONFLICT (id) DO UPDATE SET ${after} = excluded.${after}`,
    )
      .bind(pt, NOW, NOW)
      .run();
    expect(await margin()).toBe(300);
    // Nonsense minutes count as none, and at most a day.
    await env.DB.prepare(`UPDATE ${st} SET ${after} = -30 WHERE id = ?`).bind(pt).run();
    expect(await margin()).toBe(0);
    await env.DB.prepare(`UPDATE ${st} SET ${after} = 99999 WHERE id = ?`).bind(pt).run();
    expect(await margin()).toBe(1440 * 60);
    await env.DB.prepare(`UPDATE ${st} SET ${after} = 10 WHERE id = ?`).bind(pt).run();
    // An id change: the session names a service that is gone, so it keeps no margin.
    await env.DB.prepare(`UPDATE ${st} SET id = ? WHERE id = ?`).bind(`${pt}_moved`, pt).run();
    expect(await margin()).toBe(0);
    await env.DB.prepare(`UPDATE ${st} SET id = ? WHERE id = ?`).bind(pt, `${pt}_moved`).run();
    expect(await margin()).toBe(600);
    // Deleted for good.
    await env.DB.prepare(`DELETE FROM ${st} WHERE id = ?`).bind(pt).run();
    expect(await margin()).toBe(0);
  });

  it("is derived again whole by a reconcile, margins included", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT resync", 5, 5);
    await session(profile, pt, at("09", "10:00"), at("09", "11:00"));
    const before = await claims(user.id);
    await reconcile(fixture(ext), NOW);
    expect(await claims(user.id)).toEqual(before);
  });

  it("is refused at install over sessions whose buffers would clash and have not ended", async () => {
    const id = extId("stmup");
    await reconcile(fixture(id, { margins: false }), NOW);
    const user = await createUser("member");
    const profile = (await create(`${id}.coach`, { name: "Coach", user: user.id })).id as string;
    const pt = (await create(`${id}.service`, { name: "PT", bufferAfter: 15 })).id as string;
    const values = { service: pt, coach: profile };
    await create(`${id}.session`, {
      ...values,
      startsAt: at("10", "10:00"),
      endsAt: at("10", "11:00"),
    });
    await create(`${id}.session`, {
      ...values,
      startsAt: at("10", "11:00"),
      endsAt: at("10", "12:00"),
    });
    const planned = await plan(fixture(id), NOW);
    expect(planned.issues).toEqual([
      expect.objectContaining({ code: "staffed_conflict", path: "objects.session.staffed" }),
    ]);
  });
});

describe("margins only while they lie ahead (the review of PR #360)", () => {
  it("a session that has ended is edited after its service's buffer grew", async () => {
    const { profile } = await coach();
    const pt = await service("PT ended edit", 0, 0);
    const a = await session(profile, pt, past("02", "10:00"), past("02", "11:00"));
    const b = await session(profile, pt, past("02", "11:00"), past("02", "12:00"));
    await update(SERVICE, pt, { bufferAfter: 30 });
    // Marking who came, through the record operations and by a raw statement.
    await update(SESSION, a.id, { state: "attended" });
    await env.DB.prepare(
      `UPDATE ${table(SESSION)} SET ${column(SESSION, "state")} = 'attended' WHERE id = ?`,
    )
      .bind(b.id)
      .run();
    expect(await claimOf(a.id)).toMatchObject({ margin_after: 0 });
    expect(await claimOf(b.id)).toMatchObject({ margin_after: 0 });
  });

  it("a reconcile keeps every past claim, without margins", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT ended resync", 0, 0);
    const a = await session(profile, pt, past("03", "10:00"), past("03", "11:00"));
    const b = await session(profile, pt, past("03", "11:00"), past("03", "12:00"));
    await update(SERVICE, pt, { bufferAfter: 30, bufferBefore: 30 });
    const planned = await reconcile(fixture(ext), NOW);
    expect(planned.changes.filter((c) => c.kind === "skip_claims")).toEqual([]);
    expect(await claimOf(a.id)).toMatchObject({ margin_before: 0, margin_after: 0 });
    expect(await claimOf(b.id)).toMatchObject({ margin_before: 0, margin_after: 0 });
    expect(await claims(user.id)).toHaveLength(2);
  });

  it("a buffer before grows while a session is under way just after one that ended", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT under way", 0, 0);
    // By the real clock: one ended an hour ago, the next started then and runs on.
    const hour = 3_600_000;
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const now = iso(base);
    await invoke(
      "record.create",
      {
        object: SESSION,
        values: {
          client: "A",
          service: pt,
          coach: profile,
          startsAt: iso(base - 2 * hour),
          endsAt: iso(base - hour),
        },
      },
      as(admin, now),
    );
    const running = await invoke(
      "record.create",
      {
        object: SESSION,
        values: {
          client: "B",
          service: pt,
          coach: profile,
          startsAt: iso(base - hour),
          endsAt: iso(base + hour),
        },
      },
      as(admin, now),
    );
    await env.DB.prepare(
      `UPDATE ${table(SERVICE)} SET ${column(SERVICE, "bufferBefore")} = 15, ${column(SERVICE, "bufferAfter")} = 15 WHERE id = ?`,
    )
      .bind(pt)
      .run();
    // Started: its buffer before is behind it; its buffer after still lies ahead.
    expect(await claimOf(running.id as string)).toMatchObject({
      margin_before: 0,
      margin_after: 900,
    });
    expect(await claims(user.id)).toHaveLength(2);
  });

  it("staffing.candidates gives the other shift's own times", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT candidates", 0, 15);
    await session(profile, pt, at("17", "10:00"), at("17", "11:00"));
    const other = await klass(null, at("17", "11:00"), at("17", "12:00"));
    const answer = (await invoke(
      "staffing.candidates",
      { object: KLASS, id: other.id },
      tool(admin),
    )) as { people: { account: string; clash: { startsAt: string; endsAt: string } | null }[] };
    expect(answer.people.find((p) => p.account === user.id)?.clash).toMatchObject({
      startsAt: at("17", "10:00"),
      endsAt: at("17", "11:00"),
    });
  });

  it("a weekly series naming a profile with no account makes its dates uncovered, failing nothing", async () => {
    const visiting = (await create(COACH, { name: "No account" })).id as string;
    const pt = await service("PT standing", 0, 0);
    const series = await create(`${ext}.standing`, {
      client: "A client",
      weekdays: ["mon"],
      time: "06:00",
      length: 60,
      firstDate: "2031-06-02",
      timezone: "UTC",
      coach: visiting,
      service: pt,
    });
    for (let i = 0; i < 20; i += 1) {
      const result = await runRecurringDue(db, { clock: () => new Date(NOW) });
      if (result.series === 0) break;
    }
    const page = await invoke(
      "record.list",
      { object: SESSION, filter: { field: "series", op: "eq", value: series.id }, limit: 10 },
      as(admin),
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((r) => r.values.coach)).toEqual(page.items.map(() => null));
  });
});

describe("races and cost", () => {
  it("of twenty sessions booked at once in one coach's buffered time exactly one commits", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT rush", 0, 30);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        session(profile, pt, at("13", `10:${String(i).padStart(2, "0")}`), at("13", "10:30")),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject(refused);
    expect(await claims(user.id)).toHaveLength(1);
  });

  it("a service with 2,000 past sessions changes its buffer in one statement, leaving them as they were", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT long history", 0, 0);
    const st = table(SESSION);
    const col = (f: string) => column(SESSION, f);
    const statements: D1PreparedStatement[] = [];
    for (let i = 1; i <= 2000; i += 1) {
      const day = Date.parse("2020-01-01T00:00:00.000Z") + i * 3_600_000 * 3;
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${st} (id, created_at, updated_at, ${col("coach")}, ${col("service")}, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES (?, ?, ?, ?, ?, ?, ?, 'attended')`,
        ).bind(
          `stm_past_${i}`,
          NOW,
          NOW,
          profile,
          pt,
          new Date(day).toISOString(),
          new Date(day + 3_600_000).toISOString(),
        ),
      );
    }
    for (let i = 0; i < statements.length; i += 200) {
      await env.DB.batch(statements.slice(i, i + 200));
    }
    const next = await session(profile, pt, at("16", "10:00"), at("16", "11:00"));
    const result = await env.DB.prepare(
      `UPDATE ${table(SERVICE)} SET ${column(SERVICE, "bufferAfter")} = 15 WHERE id = ?`,
    )
      .bind(pt)
      .run();
    // The trigger finds the service's sessions by the index on it and derives again only the one
    // not ended: one statement, a bounded read, whatever the history.
    expect(result.meta.rows_read).toBeLessThan(10_000);
    expect(await claimOf(next.id)).toMatchObject({ margin_after: 900 });
    const widened = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ? AND margin_after > 0",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(widened?.n).toBe(1);
    expect(await claims(user.id)).toHaveLength(2001);
  }, 120_000);
});

describe("an account required", () => {
  it("refuses a session with a profile holding no account, at write and by the trigger", async () => {
    const visiting = (await create(COACH, { name: "Visiting coach" })).id as string;
    const pt = await service("PT required", 0, 0);
    await expect(session(visiting, pt, at("11", "10:00"), at("11", "11:00"))).rejects.toMatchObject(
      {
        code: "invalid_input",
        details: { rule: "staffed_account", field: "coach" },
      },
    );
    await expect(
      env.DB.prepare(
        `INSERT INTO ${table(SESSION)} (id, ${column(SESSION, "coach")}, ${column(SESSION, "service")}, ${column(SESSION, "startsAt")}, ${column(SESSION, "endsAt")}, ${column(SESSION, "state")}, created_at, updated_at) VALUES ('raw_stm_2', ?, ?, ?, ?, 'booked', ?, ?)`,
      )
        .bind(visiting, pt, at("11", "10:00"), at("11", "11:00"), NOW, NOW)
        .run(),
    ).rejects.toThrow(/core_staff_time_no_account/);
    // Nobody on it (uncovered) is allowed, and a class may still have a visiting coach.
    await session(null, pt, at("11", "10:00"), at("11", "11:00"));
    await klass(visiting, at("11", "12:00"), at("11", "13:00"));
    // A session that has ended is history: not refused.
    await env.DB.prepare(
      `INSERT INTO ${table(SESSION)} (id, ${column(SESSION, "coach")}, ${column(SESSION, "service")}, ${column(SESSION, "startsAt")}, ${column(SESSION, "endsAt")}, ${column(SESSION, "state")}, created_at, updated_at) VALUES ('raw_stm_3', ?, ?, ?, ?, 'attended', ?, ?)`,
    )
      .bind(visiting, pt, past("11", "10:00"), past("11", "11:00"), NOW, NOW)
      .run();
  });

  it("keeps a profile's account while a session not ended names it, for every statement shape", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT keeps", 0, 0);
    const made = await session(profile, pt, at("12", "10:00"), at("12", "11:00"));
    await expect(update(COACH, profile, { user: null })).rejects.toMatchObject({
      code: "conflict",
      details: { rule: "staffed_account", count: 1 },
    });
    const ct = table(COACH);
    const userCol = column(COACH, "user");
    const nameCol = column(COACH, "name");
    const shapes = [
      env.DB.prepare(`UPDATE ${ct} SET ${userCol} = NULL WHERE id = ?`).bind(profile),
      env.DB.prepare(`UPDATE ${ct} SET ${userCol} = '' WHERE id = ?`).bind(profile),
      env.DB.prepare(
        `INSERT OR REPLACE INTO ${ct} (id, ${nameCol}, ${userCol}, created_at, updated_at) VALUES (?, 'Coach', NULL, ?, ?)`,
      ).bind(profile, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO ${ct} (id, ${nameCol}, created_at, updated_at) VALUES (?, 'Coach', ?, ?) ON CONFLICT (id) DO UPDATE SET ${userCol} = NULL`,
      ).bind(profile, NOW, NOW),
      env.DB.prepare(`UPDATE ${ct} SET id = ? WHERE id = ?`).bind(`${profile}_x`, profile),
      env.DB.prepare(`DELETE FROM ${ct} WHERE id = ?`).bind(profile),
    ];
    for (const statement of shapes) {
      await expect(statement.run()).rejects.toThrow(/core_staff_time_no_account/);
    }
    expect(await claimOf(made.id)).toMatchObject({ starts: s(at("12", "10:00")) });
    expect((await claims(user.id)).length).toBe(1);
    // Once the session is cancelled, the profile may let its account go.
    await update(SESSION, made.id, { state: "cancelled" });
    await update(COACH, profile, { user: null });
  });
});

describe("the client kept off the roster (staffed.private)", () => {
  it("shows a session as its service to other staff, as it is to its coach and a rosterer", async () => {
    const { user, profile } = await coach("Robin");
    const other = await createUser("member");
    const pt = await service("Assessment", 0, 0);
    const made = await session(profile, pt, at("14", "10:00"), at("14", "10:30"), "Client Name");
    const week = async (reader: ActingUser) =>
      (
        (await invoke("staffing.week", { from: "2031-06-14", to: "2031-06-14" }, tool(reader))) as {
          shifts: { id: string; title: string; kind: { name: string } | null }[];
        }
      ).shifts.find((x) => x.id === made.id);
    expect(await week(other)).toMatchObject({ title: "Assessment", kind: { name: "Assessment" } });
    expect(await week(user)).toMatchObject({ title: "Client Name" });
    expect(await week(admin)).toMatchObject({ title: "Client Name" });
    // A class's own title stays on the roster for everyone.
    const k = await klass(profile, at("14", "12:00"), at("14", "13:00"), "Open gym");
    const shifts = (
      (await invoke("staffing.week", { from: "2031-06-14", to: "2031-06-14" }, tool(other))) as {
        shifts: { id: string; title: string }[];
      }
    ).shifts;
    expect(shifts.find((x) => x.id === k.id)?.title).toBe("Open gym");
    // The feed never carries the client's name.
    const feed = await feedShifts(db.query, user.id, new Date(NOW));
    expect(JSON.stringify(feed)).not.toContain("Client Name");
  });

  it("is never offered to others", async () => {
    const { user, profile } = await coach();
    const pt = await service("PT not offered", 0, 0);
    const made = await session(profile, pt, at("15", "10:00"), at("15", "11:00"));
    await expect(
      invoke("staffing.offer", { object: SESSION, id: made.id }, tool(user)),
    ).rejects.toMatchObject({ code: "conflict", details: { rule: "offer_private" } });
  });
});

describe("the declaration is shipped-only, as staffed is", () => {
  it("is refused to a runtime extension", async () => {
    const id = extId("stmrun");
    const result = await checkManifest(db.query, id, fixture(id), NOW, { source: "runtime" });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "objects.session.staffed" }),
      ]),
    );
  });
});
