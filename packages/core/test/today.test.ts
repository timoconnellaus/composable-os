// Stage 60 step 3 (ADR 0874): `today.get` and `today.rows` on real D1. The business's day in its
// own zone (ten hours ahead of UTC, and across a change of clocks); a pack item's count and its
// rows agreeing, for an admin and for a narrower reach; a pack role's Today holding nothing beyond
// what it could already call; the host's items gated by the operations they stand for (takings by
// finance:read, from Finance reports' Sales; changes waiting by the approver rules; the inbox);
// an AI actor's items; a pack not installed or disabled contributing nothing; the 60-second cache
// per viewer; and a statement count that grows with neither the records nor the declared items.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { defineExtension, defineTool, toManifest, z } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  addressHash,
  coreRegistry,
  forgetSchemaNames,
  type InvocationContext,
  invokeByName,
  loadPackRole,
  memoryWidgetCache,
  newId,
  suppress,
  type WidgetCache,
} from "../src/index.ts";
import {
  PACK_ROLE_CORE_READS,
  PACK_ROLE_OWN,
  PACK_ROLE_READS,
  PACK_ROLE_STAFF_READS,
  packRoleReaches,
} from "../src/pack-roles.ts";
import { APPROVALS_READ } from "../src/today/host.ts";
import { windowsOf } from "../src/today/items.ts";
import { chunksOf, forgetFailedItems, ITEM_COLUMNS } from "../src/today/pack.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const BRISBANE = "Australia/Brisbane";
// 07:30 on Sunday 15 June 2031 in Brisbane (UTC+10 all year): still 14 June in UTC.
const MORNING = "2031-06-14T21:30:00.000Z";

type Item = {
  key: string;
  label: string;
  format: string;
  value: number;
  currency: string | null;
  detail: string | null;
  compare: { against: string; value: number } | null;
  state: string;
  target: { kind: string };
};
type Answer = { day: string; zone: string; items: Item[] };
type Rows = { items: { label: string; detail: string | null; record: unknown }[] };

let cache: WidgetCache = memoryWidgetCache();

function ctxOf(
  user: ActingUser,
  now: string,
  extra: Partial<InvocationContext> & { actor?: Actor } = {},
): InvocationContext {
  const actor = extra.actor ?? "human";
  const surface = actor === "assistant" ? "assistant" : actor === "mcp" ? "mcp" : "ui";
  return context(user, {
    origin: { surface },
    clock: () => new Date(now),
    widgetCache: cache,
    ...extra,
  });
}
const today = (user: ActingUser, now = MORNING, extra = {}) =>
  invokeByName("today.get", {}, ctxOf(user, now, extra)) as Promise<Answer>;
const rowsOf = (user: ActingUser, key: string, now = MORNING, extra = {}) =>
  invokeByName("today.rows", { key }, ctxOf(user, now, extra)) as Promise<Rows>;
const keys = (a: Answer) => a.items.map((i) => i.key);
const itemOf = (a: Answer, key: string) => a.items.find((i) => i.key === key);

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

// --- A shipped fixture pack declaring items over the base views -----------------------------------

const PEOPLE_TODAY =
  "SELECT count(*) AS value FROM rec_person p WHERE p.created_at >= :today_from AND p.created_at < :today_to";
const PEOPLE_ROWS = {
  sql: "SELECT p.display_name AS who, p.id AS person_id FROM rec_person p WHERE p.created_at >= :today_from AND p.created_at < :today_to ORDER BY p.created_at LIMIT 50",
  label: "who",
  record: { object: "person", id: "person_id" },
};

// Who came so far: up to `:now`, so a week ago it counts up to the same local time.
const PEOPLE_SO_FAR = `${PEOPLE_TODAY} AND p.created_at < :now`;
const ROWS_SO_FAR = {
  ...PEOPLE_ROWS,
  sql: PEOPLE_ROWS.sql.replace(" ORDER BY", " AND p.created_at < :now ORDER BY"),
};

const tool = (permission?: string, anyStaff = false) =>
  defineTool({
    description: "Fixture: a read.",
    input: z.object({}),
    output: z.object({}),
    risk: "read",
    ...(permission ? { permission } : {}),
    ...(anyStaff ? { anyStaff: true, humanOnly: true } : {}),
    handler: () => ({}),
  });

function fixture(
  id: string,
  todayItems: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return toManifest(
    defineExtension({
      id,
      version: "1.0.0",
      contractVersion: 1,
      label: `Fixture ${id}`,
      objects: {},
      tools: { day: tool(`${id}:coach`), desk: tool(), all: tool(undefined, true) },
      roles: {
        coach: {
          label: "Coach",
          description: "Fixture: the coach.",
          permissions: [`${id}:coach`],
          read: [],
        },
      },
      todayItems: todayItems as never,
      ...extra,
    } as never),
  );
}

async function install(
  m: ReturnType<typeof fixture>,
  status: "active" | "disabled" = "active",
  source: "shipped" | "runtime" = "shipped",
) {
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(m.id).run();
  await env.DB.prepare(
    `INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?)`,
  )
    .bind(m.id, source, status, m.version, JSON.stringify(m), admin.id, now, now)
    .run();
}

const peopleItem = (opens: string[], extra: Record<string, unknown> = {}) => ({
  label: "New people",
  format: "count",
  sql: PEOPLE_TODAY,
  rows: PEOPLE_ROWS,
  opens,
  ...extra,
});

async function person(at: string, name = unique("Day")) {
  await invokeByName(
    "person.create",
    { displayName: name, ownerId: admin.id },
    context(admin, { clock: () => new Date(at) }),
  );
}

async function account(role: "admin" | "member" | "viewer", packRole?: string, grants?: string[]) {
  const user = await createUser(role);
  await env.DB.prepare("UPDATE core_user SET pack_role = ?, granted_permissions = ? WHERE id = ?")
    .bind(packRole ?? null, grants ? JSON.stringify(grants) : null, user.id)
    .run();
  return user;
}

let admin: ActingUser;
let member: ActingUser;
const FX = "todayfx";

// The fixture's own object, a visit at a moment, for its roles to read.
const VISIT = `${FX}.visit`;
const VISIT_OBJECTS = {
  visit: {
    label: "Visit",
    plural: "Visits",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name" },
      at: { type: "datetime", label: "At" },
      person: { type: "relation", label: "Person", to: "person" },
    },
  },
};
const IN_TODAY_VISITS = "v.at >= :today_from AND v.at < :today_to";
const visitsItem = (opens: string[], extra: Record<string, unknown> = {}) => ({
  label: "Visits today",
  format: "count",
  sql: `SELECT count(*) AS value FROM rec_x_${FX}_visit v WHERE ${IN_TODAY_VISITS}`,
  rows: {
    sql: `SELECT v.name AS what, v.id AS visit_id FROM rec_x_${FX}_visit v WHERE ${IN_TODAY_VISITS} ORDER BY v.at LIMIT 50`,
    label: "what",
    record: { object: VISIT, id: "visit_id" },
  },
  opens,
  ...extra,
});
/**
 * The fixture's roles: `coach` reads visits; `daycoach` reads them on today only (ADR 0553);
 * `carer` reaches them only for the People it looks after (ADR 0889); `probe`, the review's,
 * reads nothing and reaches People only on today.
 */
const FX_ROLES = {
  coach: { label: "Coach", description: "Fixture.", permissions: [`${FX}:coach`], read: [VISIT] },
  daycoach: {
    label: "Day coach",
    description: "Fixture.",
    permissions: [`${FX}:coach`],
    read: [VISIT],
    today: { [VISIT]: "at" },
  },
  carer: {
    label: "Carer",
    description: "Fixture.",
    permissions: [`${FX}:coach`],
    read: [VISIT],
    looksAfter: { [VISIT]: "person" },
  },
  probe: {
    label: "Probe",
    description: "Fixture.",
    permissions: [`${FX}:coach`],
    read: [],
    today: { person: "createdAt" },
  },
};

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await setSetting("org_timezone", BRISBANE);
  // Its views first (objects only), then the manifest as installed.
  await reconcile(fixture(FX, {}, { objects: VISIT_OBJECTS, roles: {} }));
  await install(
    fixture(
      FX,
      {
        people: peopleItem(["desk"], { order: 30 }),
        coachPeople: peopleItem(["day"], {
          label: "New people so far",
          sql: PEOPLE_SO_FAR,
          rows: ROWS_SO_FAR,
          compare: "lastWeek",
        }),
        anyone: peopleItem(["all"], { label: "Anyone's" }),
        hot: peopleItem(["desk"], { label: "Busy", attention: { above: 2 }, order: 200 }),
        visits: visitsItem(["day"], { order: 40 }),
        allVisits: visitsItem(["day"], {
          label: "Every visit",
          sql: `SELECT count(*) AS value FROM rec_x_${FX}_visit v`,
          compare: "none",
        }),
        visitPeople: visitsItem(["day"], {
          label: "Visitors",
          rows: {
            sql: `SELECT p.display_name AS who, p.id AS person_id FROM rec_x_${FX}_visit v JOIN rec_person p ON p.id = v.person WHERE ${IN_TODAY_VISITS} LIMIT 50`,
            label: "who",
            record: { object: "person", id: "person_id" },
          },
        }),
        probePeople: peopleItem(["day"], { label: "People (probe)", compare: "lastWeek" }),
        // Rows over visits only, each naming the visit's Person: records the coach does not read.
        visitWho: visitsItem(["day"], {
          label: "Who visits",
          rows: {
            sql: `SELECT v.name AS what, v.person AS person_id FROM rec_x_${FX}_visit v WHERE ${IN_TODAY_VISITS} LIMIT 50`,
            label: "what",
            record: { object: "person", id: "person_id" },
          },
        }),
      },
      { objects: VISIT_OBJECTS, roles: FX_ROLES },
    ),
  );
  forgetSchemaNames();
  for (const [when, name] of [
    ["2031-06-14T12:00:00.000Z", "Yesterday's visit"], // 22:00 on 14 June local
    ["2031-06-14T16:00:00.000Z", "Morning visit"], // 02:00 on 15 June local
    ["2031-06-14T20:00:00.000Z", "Early visit"], // 06:00 on 15 June local
  ] as const) {
    await invokeByName(
      "record.create",
      { object: VISIT, values: { name, at: when } },
      context(admin, { clock: () => new Date(MORNING) }),
    );
  }
  for (const when of [
    "2031-06-07T15:00:00.000Z", // 01:00 on 8 June local: a week ago, before 07:30
    "2031-06-07T22:00:00.000Z", // 08:00 on 8 June local: a week ago, after 07:30
    "2031-06-14T13:00:00.000Z", // 23:00 on 14 June local: yesterday, though today in UTC
    "2031-06-14T14:00:00.000Z", // local midnight exactly: today
    "2031-06-14T15:00:00.000Z", // 01:00 on 15 June local: today
    "2031-06-14T21:00:00.000Z", // 07:00 on 15 June local: today
  ]) {
    await person(when);
  }
});

beforeEach(() => {
  cache = memoryWidgetCache();
});

// --- (c) The business's day ---------------------------------------------------------------------

describe("the business's day (criterion 1, proof c)", () => {
  it("counts from local midnight, ten hours ahead of UTC, compared with yesterday", async () => {
    const answer = await today(admin);
    expect(answer.day).toBe("2031-06-15");
    expect(answer.zone).toBe(BRISBANE);
    const people = itemOf(answer, `${FX}.people`);
    // Midnight, 01:00 and 07:00 local today; 23:00 local yesterday is yesterday's.
    expect(people?.value).toBe(3);
    expect(people?.compare).toEqual({ against: "yesterday", value: 1 });
    // So far today (before 07:30 local), against a week ago at the same local time: only the
    // 01:00 one then, the 08:00 one being after 07:30.
    const soFar = itemOf(answer, `${FX}.coachPeople`);
    expect(soFar?.value).toBe(3);
    expect(soFar?.compare).toEqual({ against: "lastWeek", value: 1 });
  });

  it("agrees with a dashboard widget's today preset", async () => {
    const preview = (await invokeByName(
      "widget.preview",
      {
        widget: {
          id: "w",
          type: "kpi",
          title: "People",
          sql: "SELECT count(*) AS value FROM rec_person p WHERE p.created_at >= :d_from AND p.created_at < :d_to",
          mapping: { value: "value" },
          options: { compare: false },
          layout: { w: 3, h: 1 },
        },
        dashboardFilters: [{ type: "dateRange", id: "d", label: "Day", default: "today" }],
        filters: {},
      },
      ctxOf(admin, MORNING),
    )) as { rows: { value: number }[] };
    expect(preview.rows[0]?.value).toBe(itemOf(await today(admin), `${FX}.people`)?.value);
  });

  it("is not the server's UTC day: the same instant in UTC would be 14 June", async () => {
    await setSetting("org_timezone", "UTC");
    try {
      const answer = await today(admin);
      expect(answer.day).toBe("2031-06-14");
      // In UTC, 14 June holds the 13:00, 14:00, 15:00 and 21:00 ones.
      expect(itemOf(answer, `${FX}.people`)?.value).toBe(4);
    } finally {
      await setSetting("org_timezone", BRISBANE);
    }
  });

  it("is 23 or 25 hours across a change of clocks", () => {
    const hours = (w: { from: string; to: string }) =>
      (Date.parse(w.to) - Date.parse(w.from)) / 3_600_000;
    const forward = windowsOf("2026-10-04T02:00:00.000Z", "Australia/Sydney");
    expect(forward.today.day.date).toBe("2026-10-04");
    expect(hours(forward.today.day)).toBe(23);
    expect(hours(windowsOf("2026-04-05T02:00:00.000Z", "Australia/Sydney").today.day)).toBe(25);
    // Yesterday at the same local time, across the change: 23 hours earlier, not 24.
    const after = windowsOf("2026-10-04T14:00:00.000Z", "Australia/Sydney"); // 01:00 on 5 Oct
    expect(after.yesterday.now).toBe("2026-10-03T15:00:00.000Z"); // 01:00 AEST on 4 Oct
  });
});

// --- (a) An item's count and its rows -------------------------------------------------------------

describe("an item's count equals its rows (proof a)", () => {
  it("for an admin, and for a pack role's narrower reach", async () => {
    const coach = await account("member", `${FX}.coach`);
    for (const [user, key] of [
      [admin, `${FX}.people`],
      [admin, `${FX}.visits`],
      [coach, `${FX}.visits`],
    ] as const) {
      const value = itemOf(await today(user), key)?.value;
      const rows = await rowsOf(user, key);
      expect(rows.items.length, key).toBe(value);
    }
    // Today's two visits (02:00 and 06:00 local), and yesterday's at 22:00.
    expect(itemOf(await today(coach), `${FX}.visits`)).toMatchObject({
      value: 2,
      compare: { against: "yesterday", value: 1 },
    });
    // The coach's rows open the visits its role reads; an admin's open the Person.
    expect((await rowsOf(coach, `${FX}.visits`)).items.map((r) => r.record)).toEqual([
      expect.objectContaining({ object: VISIT }),
      expect.objectContaining({ object: VISIT }),
    ]);
    expect((await rowsOf(admin, `${FX}.people`)).items[0]?.record).toMatchObject({
      object: "person",
    });
  });

  it("for the changes waiting: an admin's and a member's own count, each equal to its rows", async () => {
    const set = newId("changeSet");
    const now = new Date(MORNING).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'assistant', '{}', ?, ?)",
    )
      .bind(set, member.id, now, now)
      .run();
    const action = async (operation: string, risk: string, input: unknown) =>
      env.DB.prepare(
        `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor,
           user_id, origin, preview, simulated, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'review', 'assistant', ?, '{}', '[]', '{}', ?, '2099-01-01T00:00:00.000Z')`,
      )
        .bind(newId("pendingAction"), set, operation, risk, JSON.stringify(input), member.id, now)
        .run();
    await action("person.update", "write", { id: "per_x", values: { displayName: "A" } });
    await action("order.adjust", "write", { orderId: "ord_x" }); // an admin's (ADR 0691)
    await action("extension.apply", "extension", { id: "deals" }); // an admin's (ADR 0041)
    const viewer = await createUser("viewer");
    const counted = async (user: ActingUser) => {
      const item = itemOf(await today(user), "host.approvals");
      return { value: item?.value, rows: item ? (await rowsOf(user, "host.approvals")).items : [] };
    };
    const a = await counted(admin);
    const m = await counted(member);
    expect(a.value).toBe(3);
    expect(a.rows.length).toBe(3);
    expect(m.value).toBe(1);
    expect(m.rows.length).toBe(1);
    // The setup change is listed for the admin, saying where to review it.
    expect(a.rows.map((r) => r.detail)).toContain("Review on a computer");
    // A viewer may approve nothing: no item, and its rows are not found.
    expect(itemOf(await today(viewer), "host.approvals")).toBeUndefined();
    await expect(rowsOf(viewer, "host.approvals")).rejects.toMatchObject({ code: "not_found" });
    expect(itemOf(await today(admin), "host.approvals")?.state).toBe("attention");
  });

  it("counts only what this person can approve and that would go out", async () => {
    const set = newId("changeSet");
    const now = new Date(MORNING).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'assistant', '{}', ?, ?)",
    )
      .bind(set, member.id, now, now)
      .run();
    const ids: Record<string, string> = {};
    const action = async (
      name: string,
      operation: string,
      input: unknown,
      connection: string | null = null,
    ) => {
      ids[name] = newId("pendingAction");
      await env.DB.prepare(
        `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor,
           user_id, origin, preview, simulated, created_at, expires_at, connection_id)
         VALUES (?, ?, ?, 'write', ?, 'review', 'assistant', ?, '{}', '[]', '{}', ?, '2099-01-01T00:00:00.000Z', ?)`,
      )
        .bind(ids[name], set, operation, JSON.stringify(input), member.id, now, connection)
        .run();
    };
    const before = {
      admin: itemOf(await today(admin), "host.approvals")?.value ?? 0,
      member: itemOf(await today(member), "host.approvals")?.value ?? 0,
    };
    // A runtime extension's restricted tool (ADR 0625): an admin's, never a member's.
    const rt = "todayrt";
    const runtime = fixture(
      rt,
      {},
      { tools: { assign: tool(`${rt}:assign`) }, restricted: [`${rt}:assign`], roles: {} },
    );
    await install(runtime, "active", "runtime");
    await action("restricted", `x.${rt}.assign`, {});
    // The member's own mailbox, and an AI's draft from it: only the member sends it (ADR 0678).
    const mailbox = newId("connection");
    await env.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, created_at, updated_at) VALUES (?, 'fake', 'personal', ?, 'Mailbox', ?, ?)",
    )
      .bind(mailbox, member.id, now, now)
      .run();
    const to = (email: string) => [{ label: "To", value: email }];
    await action(
      "draft",
      "integration.outbound",
      { vendor: "fake", fields: to(`${unique("ok")}@x.test`), contact: { personal: true } },
      mailbox,
    );
    // A message to a suppressed address (a stop): approving sends nothing, so it is not counted.
    const stopped = `${unique("stopped")}@x.test`;
    await suppress(
      db.query,
      "email",
      await addressHash(db.query, stopped),
      "provider_unsubscribed",
      now,
    );
    await action(
      "blocked",
      "integration.outbound",
      { vendor: "fake", fields: to(stopped), contact: { sender: "staff" } },
      mailbox,
    );
    try {
      const a = itemOf(await today(admin), "host.approvals")?.value ?? 0;
      const m = itemOf(await today(member), "host.approvals")?.value ?? 0;
      // The admin: the restricted tool only (not another person's draft, not the blocked one).
      expect(a - before.admin).toBe(1);
      // The member: their own draft only (not the restricted tool, not the blocked one).
      expect(m - before.member).toBe(1);
    } finally {
      await env.DB.prepare("DELETE FROM core_pending_action WHERE change_set_id = ?")
        .bind(set)
        .run();
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(rt).run();
    }
  });

  it("says when more are waiting than it counts (500+), never a silently smaller number", async () => {
    const set = newId("changeSet");
    const now = new Date(MORNING).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'assistant', '{}', ?, ?)",
    )
      .bind(set, member.id, now, now)
      .run();
    const values = Array.from(
      { length: 20 },
      () =>
        "(?, ?, 'person.update', 'write', '{}', 'review', 'assistant', ?, '{}', '[]', '{}', ?, '2099-01-01T00:00:00.000Z')",
    ).join(", ");
    for (let i = 0; i < 26; i++) {
      await env.DB.prepare(
        `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor, user_id, origin, preview, simulated, created_at, expires_at) VALUES ${values}`,
      )
        .bind(
          ...Array.from({ length: 20 }, () => [newId("pendingAction"), set, member.id, now]).flat(),
        )
        .run();
    }
    try {
      const item = itemOf(await today(admin), "host.approvals");
      expect(item?.value).toBe(APPROVALS_READ);
      expect(item?.detail).toBe(`${APPROVALS_READ}+ waiting: the oldest ${APPROVALS_READ} counted`);
    } finally {
      await env.DB.prepare("DELETE FROM core_pending_action WHERE change_set_id = ?")
        .bind(set)
        .run();
    }
  });
});

// --- (b) A pack role's Today ------------------------------------------------------------------------

describe("a pack role's Today (proof b)", () => {
  const notFound = async (user: ActingUser, key: string) =>
    expect(rowsOf(user, key), key).rejects.toMatchObject({ code: "not_found" });

  it("reaches today.get and today.rows beside what it reached, and no other core operation", async () => {
    const coach = await account("member", `${FX}.coach`);
    const role = await loadPackRole(db.query, coach.id);
    if (!role) throw new Error("no role");
    const core = coreRegistry
      .list()
      .filter((op) => packRoleReaches(role, op))
      .map((op) => op.name)
      .sort();
    expect(core).toEqual(
      [
        ...PACK_ROLE_READS,
        ...PACK_ROLE_CORE_READS,
        ...PACK_ROLE_OWN,
        ...PACK_ROLE_STAFF_READS,
        "today.get",
        "today.rows",
      ].sort(),
    );
  });

  it("an item its role opens reads only what the role reads: no money, approvals, inbox, People or other pack", async () => {
    const coach = await account("member", `${FX}.coach`);
    const answer = await today(coach);
    // Its role's tool opens the visits' items (the role reads visits); not those over People
    // (the role reads no Person), nor `desk`'s (a member's tool), nor an every-staff tool's.
    expect(keys(answer).sort()).toEqual(
      [`${FX}.allVisits`, `${FX}.visitPeople`, `${FX}.visits`, `${FX}.visitWho`].sort(),
    );
    for (const key of [
      "host.takings",
      "host.approvals",
      "host.notices",
      "host.uncovered",
      "host.checklists",
      `${FX}.people`,
      `${FX}.anyone`,
      `${FX}.coachPeople`,
      `${FX}.probePeople`,
    ]) {
      await notFound(coach, key);
    }
    // Rows naming People the role does not read: the count alone, no names.
    expect(itemOf(answer, `${FX}.visitPeople`)?.value).toBe(2);
    expect((await rowsOf(coach, `${FX}.visitPeople`)).items).toEqual([]);
    // Rows that name records of an object the role does not read: none either.
    expect((await rowsOf(coach, `${FX}.visitWho`)).items).toEqual([]);
    expect((await rowsOf(admin, `${FX}.visitWho`)).items.length).toBe(2);
    // A member holds the pack's tools as any staff read (the coach's too), and the inbox.
    const m = keys(await today(member));
    expect(m).toEqual(
      expect.arrayContaining([`${FX}.people`, `${FX}.anyone`, `${FX}.coachPeople`, "host.notices"]),
    );
  });

  it("a role limited to today gets today's window only, never another day's figure", async () => {
    const day = await account("member", `${FX}.daycoach`);
    const answer = await today(day);
    // Every visit is not bound to today's window: hidden. Today's are shown with no comparison.
    expect(keys(answer).sort()).toEqual(
      [`${FX}.visitPeople`, `${FX}.visits`, `${FX}.visitWho`].sort(),
    );
    expect(itemOf(answer, `${FX}.visits`)).toMatchObject({ value: 2, compare: null });
    expect((await rowsOf(day, `${FX}.visits`)).items.map((r) => r.label).sort()).toEqual([
      "Early visit",
      "Morning visit",
    ]);
    await notFound(day, `${FX}.allVisits`);
  });

  it("the review's probe: a role reading nothing, reaching People on today only, gets no value from another day and no names", async () => {
    const probe = await account("member", `${FX}.probe`);
    const role = await loadPackRole(db.query, probe.id);
    expect(role?.today).toEqual({ person: "createdAt" });
    expect(role?.read).toEqual([]);
    // Its own tool opens the item over People, compared with last week: nothing of it.
    const answer = await today(probe);
    expect(keys(answer)).toEqual([]);
    await notFound(probe, `${FX}.probePeople`);
  });

  it("a role reaching visits only for the People it looks after gets no item that reads them", async () => {
    const carer = await account("member", `${FX}.carer`);
    const role = await loadPackRole(db.query, carer.id);
    expect(role?.looksAfter?.reach).toEqual({ [VISIT]: "person" });
    expect(keys(await today(carer))).toEqual([]);
  });

  it("a limited role holding a grant is held to the limit too (a grant of another pack's tool)", async () => {
    const gr = "todaygr";
    await install(
      fixture(
        gr,
        {
          grVisits: visitsItem(["desk"], { label: "Visits (granted)" }),
          grPeople: peopleItem(["desk"], { label: "People (granted)" }),
        },
        { tools: { desk: tool(`${gr}:desk`) }, grantable: [`${gr}:desk`], roles: {} },
      ),
    );
    forgetSchemaNames();
    try {
      const carer = await account("member", `${FX}.carer`, [`${gr}:desk`]);
      const day = await account("member", `${FX}.daycoach`, [`${gr}:desk`]);
      // The grant opens its pack's items: over People (no limit of the role is about them), as a
      // count with no names (the role reads no Person); over visits, never for the carer, whose
      // role reaches visits only for the People it looks after, and for the day coach only as
      // today's, with no comparison.
      const c = await today(carer);
      expect(keys(c).sort()).toEqual([`${gr}.grPeople`]);
      expect((await rowsOf(carer, `${gr}.grPeople`)).items).toEqual([]);
      await notFound(carer, `${gr}.grVisits`);
      const d = await today(day);
      expect(itemOf(d, `${gr}.grVisits`)).toMatchObject({ value: 2, compare: null });
    } finally {
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(gr).run();
    }
  });
});

// --- Who sees which host item ---------------------------------------------------------------------

describe("the host's items", () => {
  it("money is finance:read's: a member granted it sees takings, and not once the grant is gone", async () => {
    const manager = await account("member", undefined, ["finance:read"]);
    const shared = memoryWidgetCache();
    expect(keys(await today(manager, MORNING, { widgetCache: shared }))).toContain("host.takings");
    expect(keys(await today(member, MORNING, { widgetCache: shared }))).not.toContain(
      "host.takings",
    );
    await env.DB.prepare("UPDATE core_user SET granted_permissions = NULL WHERE id = ?")
      .bind(manager.id)
      .run();
    // The same cache: the gate is the caller's, judged before anything is served.
    expect(keys(await today(manager, MORNING, { widgetCache: shared }))).not.toContain(
      "host.takings",
    );
  });

  it("an assistant gets the packs' items and the money, never approvals, checklists, shifts or the inbox", async () => {
    const answer = await today(admin, MORNING, { actor: "assistant" });
    const host = keys(answer).filter((k) => k.startsWith("host."));
    expect(host).toEqual(["host.takings"]);
    expect(keys(answer)).toContain(`${FX}.people`);
    await expect(
      rowsOf(admin, "host.approvals", MORNING, { actor: "assistant" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const mcp = await today(admin, MORNING, { actor: "mcp", grantedPermissions: ["records:read"] });
    // An MCP token without finance:read in its scopes gets no money.
    expect(keys(mcp).filter((k) => k.startsWith("host."))).toEqual([]);
  });

  it("lists attention first, then each item's place", async () => {
    for (let i = 0; i < 3; i++) await person("2031-06-14T20:00:00.000Z");
    const answer = await today(admin);
    const first = answer.items.findIndex((i) => i.state === "attention");
    const lastAttention = answer.items.map((i) => i.state).lastIndexOf("attention");
    expect(first).toBe(0);
    expect(answer.items.slice(lastAttention + 1).every((i) => i.state === "ok")).toBe(true);
    expect(itemOf(answer, `${FX}.hot`)?.state).toBe("attention");
  });

  it("an unread notice is counted, and its rows are the person's own", async () => {
    const before = itemOf(await today(member), "host.notices")?.value ?? 0;
    await env.DB.prepare(
      "INSERT INTO core_notifications (id, user_id, type, title, body, created_at) VALUES (?, ?, 'system.message', 'Hello', NULL, ?)",
    )
      .bind(newId("notification"), member.id, MORNING)
      .run();
    const after = itemOf(await today(member), "host.notices");
    expect(after?.value).toBe(before + 1);
    expect((await rowsOf(member, "host.notices")).items.length).toBe(after?.value);
    expect(after?.target).toEqual({ kind: "notices" });
  });
});

// --- Takings, from Finance reports ------------------------------------------------------------------

describe("takings (criterion 3)", () => {
  it("is Sales' net for the local day, a refund today of an older sale taken off", async () => {
    await setSetting("order_currency", "AUD");
    const order = async (total: number) => {
      const id = newId("order");
      await env.DB.prepare(
        `INSERT INTO core_order (id, currency, total, paid, refunded, state, placed_as, tax_amount, tax_refunded, discount, created_at, updated_at)
         VALUES (?, 'AUD', ?, ?, 0, 'paid', 'public', 0, 0, 0, ?, ?)`,
      )
        .bind(id, total, total, MORNING, MORNING)
        .run();
      await env.DB.prepare(
        `INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity, unit_price, line_total, line_discount, tax_amount, created_at)
         VALUES (?, ?, 1, 'person', 'per_x', 'Ten-class pass', 1, ?, ?, 0, 0, ?)`,
      )
        .bind(newId("orderLine"), id, total, total, MORNING)
        .run();
      return id;
    };
    let n = 0;
    const pay = async (orderId: string, amount: number, at: string) => {
      n += 1;
      await env.DB.prepare(
        `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome, payment_ref, received_at)
         VALUES ('fake', ?, ?, ?, 'AUD', 'applied', ?, ?)`,
      )
        .bind(`tday_${n}`, orderId, amount, `fpi_t${n}`, at)
        .run();
    };
    const old = await order(5000);
    await pay(old, 5000, "2031-06-01T00:00:00.000Z");
    const a = await order(2000);
    await pay(a, 2000, "2031-06-14T15:00:00.000Z"); // 01:00 local today
    const b = await order(3000);
    await pay(b, 3000, "2031-06-14T13:30:00.000Z"); // 23:30 local yesterday
    await env.DB.prepare(
      `INSERT INTO core_order_refund (id, order_id, provider, amount, currency, reason, status, requested_at, confirmed_at, created_at)
       VALUES (?, ?, 'fake', 1500, 'AUD', 'Moved away', 'confirmed', ?, ?, ?)`,
    )
      .bind(newId("refund"), old, MORNING, "2031-06-14T20:00:00.000Z", MORNING)
      .run();
    const takings = itemOf(await today(admin), "host.takings");
    const report = (await invokeByName(
      "finance.report",
      { report: "sales", start: "2031-06-15", end: "2031-06-15" },
      ctxOf(admin, MORNING),
    )) as { totals: { net: number } };
    expect(takings?.value).toBe(report.totals.net);
    expect(takings?.value).toBe(2000 - 1500);
    expect(takings).toMatchObject({ format: "money", currency: "AUD", detail: "1 payment" });
    const rows = await rowsOf(admin, "host.takings");
    expect(rows.items.map((r) => r.label)).toEqual(["Ten-class pass"]);
    // Who looked at the money's rows is audited, naming the item and never a figure.
    const audit = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'today.rows' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(admin.id)
      .first<{ result: string }>();
    expect(audit?.result).toContain("host.takings");
    expect(audit?.result).not.toContain("500");
  });
});

// --- Criterion 4: a pack not installed or disabled -------------------------------------------------

describe("a pack not installed, disabled or not shipped (criterion 4)", () => {
  it("contributes no item, by today.get or today.rows", async () => {
    const id = "todayoff";
    const m = fixture(id, { people: peopleItem(["desk"]) });
    await install(m);
    expect(keys(await today(admin))).toContain(`${id}.people`);
    for (const [status, source] of [
      ["disabled", "shipped"],
      ["active", "runtime"],
    ] as const) {
      await install(m, status, source);
      expect(keys(await today(admin)), status).not.toContain(`${id}.people`);
      await expect(rowsOf(admin, `${id}.people`)).rejects.toMatchObject({ code: "not_found" });
    }
    await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(id).run();
    expect(keys(await today(admin))).not.toContain(`${id}.people`);
  });
});

// --- (d) Cost, and the cache ------------------------------------------------------------------------

/** A database whose every statement is counted. */
function metered() {
  let statements = 0;
  const binding = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          statements += 1;
          return target.prepare(query);
        };
      }
      if (prop === "batch") {
        return (list: D1PreparedStatement[]) => {
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: createCrmDb(binding),
    get statements() {
      return statements;
    },
  };
}

async function statementsOf(user: ActingUser, widgetCache: WidgetCache = memoryWidgetCache()) {
  const m = metered();
  forgetSchemaNames();
  const answer = (await invokeByName(
    "today.get",
    {},
    ctxOf(user, MORNING, { db: m.db, widgetCache }),
  )) as Answer;
  return { statements: m.statements, answer };
}

describe("cost (criterion 13, proof d)", () => {
  it("does not grow with the records or the declared items", async () => {
    const few = await statementsOf(admin);
    // Six more packs of eight items each, and many more records of every kind it reads.
    const ids: string[] = [];
    for (let p = 0; p < 6; p++) {
      const id = `todaymany${p}`;
      ids.push(id);
      await install(
        fixture(
          id,
          Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              `n${i}`,
              peopleItem(["desk"], {
                label: `Item ${i}`,
                compare: i % 2 ? "lastWeek" : "yesterday",
              }),
            ]),
          ),
        ),
      );
    }
    for (let i = 0; i < 30; i++) await person("2031-06-14T16:00:00.000Z");
    const values = Array.from({ length: 30 }, () => "(?, ?, 'system.message', 'x', ?)").join(", ");
    await env.DB.prepare(
      `INSERT INTO core_notifications (id, user_id, type, title, created_at) VALUES ${values}`,
    )
      .bind(...Array.from({ length: 30 }, () => [newId("notification"), admin.id, MORNING]).flat())
      .run();
    const many = await statementsOf(admin);
    expect(many.answer.items.length).toBeGreaterThanOrEqual(few.answer.items.length + 48);
    expect(many.statements).toBe(few.statements);
    // Bounded: well within D1's thousand a call.
    expect(many.statements).toBeLessThanOrEqual(25);
    for (const id of ids) {
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(id).run();
    }
  });

  it("reads many items as columns of few statements, within D1's limits", () => {
    const item = (i: number) =>
      ({
        key: `p.i${i}`,
        today: PEOPLE_TODAY,
        compare: { against: "yesterday", sql: PEOPLE_TODAY },
        uses: 6,
      }) as never;
    const chunks = chunksOf(Array.from({ length: 200 }, (_, i) => item(i)));
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(200 / ITEM_COLUMNS) + 1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(ITEM_COLUMNS);
  });

  it("an item that fails when read costs one failed statement, is left out, and is shown to admins", async () => {
    const id = "todaybad";
    // Passes every check (it is SQL over no view), and fails when SQLite runs it.
    const BAD = "SELECT abs(-9223372036854775807 - 1) AS value";
    await install(
      fixture(id, {
        bad: { label: "Broken", format: "count", sql: BAD, opens: ["desk"] },
        good: peopleItem(["desk"], { label: "Still fine" }),
      }),
    );
    forgetFailedItems();
    try {
      const shared = memoryWidgetCache();
      const first = await statementsOf(admin, shared);
      const second = await statementsOf(admin, shared);
      const third = await statementsOf(admin, shared);
      // The first call finds it (the statement fails, each item is read alone once); after that
      // it is left out: one statement of the others, then the cache.
      expect(first.statements).toBeGreaterThan(second.statements + 2);
      expect(second.statements).toBe(third.statements + 1);
      expect(keys(third.answer)).toContain(`${id}.good`);
      expect(keys(third.answer)).not.toContain(`${id}.bad`);
      // Never silently gone: an admin sees it listed; a member does not.
      expect(itemOf(third.answer, "host.unreadable")).toMatchObject({
        value: 1,
        detail: "Broken",
        state: "attention",
      });
      expect((await rowsOf(admin, "host.unreadable")).items).toEqual([
        { label: "Broken", detail: `${id}.bad`, record: null },
      ]);
      expect(keys(await today(member))).not.toContain("host.unreadable");
    } finally {
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(id).run();
      forgetFailedItems();
    }
  });

  it("a second call within 60 seconds is served from the cache for the same viewer, not another", async () => {
    const shared = memoryWidgetCache();
    const first = await statementsOf(admin, shared);
    const again = await statementsOf(admin, shared);
    expect(again.statements).toBeLessThan(first.statements);
    expect(again.answer).toEqual(first.answer);
    // A member's gates differ (no money, another visibility scope): nothing of the admin's served.
    const theirs = await statementsOf(member, shared);
    const cold = await statementsOf(member);
    expect(theirs.statements).toBe(cold.statements);
  });
});
