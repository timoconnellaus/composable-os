// Stage 60 step 3 (ADR 0874): Today in the real host, with Programs, Bookings, Memberships,
// Ticketing, Rostering and the Shop installed. Bookings is installed with two Today items added to its
// manifest (classes today and who came; the pack declares its own in step 4), so the host runs a
// shipped pack's items, gated by its tools, beside the host's items that read the packs' records:
// shifts with nobody on them (a class with no coach, a duty shift with nobody) and checklists.
//
// - (a) an item's count equals its rows, for an admin and for the coach's narrower reach;
// - (b) a coach (`bookings.coach`) gets only the items its role's tools open over objects it
//   reads, today's and with no other day's figure: no money, approvals, roster, checklist or inbox,
//   no other pack's, no bookings or People; a door account, a cleaner and the stockroom get nothing;
// - (d) today.get's statement count is the same with few records and many.
//
// Clocks: the tools read the real clock, so today's class is placed a little after now (or before,
// late in the local day) and tomorrow's a day later.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  forgetSchemaNames,
  type InvocationContext,
  localDay,
  memoryWidgetCache,
  newId,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, queriesOf, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const ZONE = "Australia/Sydney";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLASS = "bookings.class";

// Bookings with two Today items, as step 4 will declare its own.
const IN_TODAY =
  "c.starts_at >= :today_from AND c.starts_at < :today_to AND c.state != 'cancelled'";
const TODAY_ITEMS = `  todayItems: {
    classesToday: {
      label: "Classes today",
      order: 10,
      format: "count",
      sql: "SELECT count(*) AS value FROM rec_x_bookings_class c WHERE ${IN_TODAY}",
      rows: {
        sql: "SELECT coalesce(c.title, 'Class') AS name, c.id AS class_id FROM rec_x_bookings_class c WHERE ${IN_TODAY} ORDER BY c.starts_at LIMIT 50",
        label: "name",
        record: { object: "bookings.class", id: "class_id" },
      },
      opens: ["day"],
    },
    cameToday: {
      label: "Came today",
      order: 20,
      format: "count",
      sql: "SELECT count(*) AS value FROM rec_x_bookings_booking b JOIN rec_x_bookings_class c ON c.id = b.class WHERE ${IN_TODAY} AND b.state = 'attended'",
      rows: {
        sql: "SELECT p.display_name AS who, p.id AS person_id FROM rec_x_bookings_booking b JOIN rec_x_bookings_class c ON c.id = b.class JOIN rec_person p ON p.id = b.person WHERE ${IN_TODAY} AND b.state = 'attended' ORDER BY p.display_name LIMIT 50",
        label: "who",
        record: { object: "person", id: "person_id" },
      },
      opens: ["roster"],
    },
  },
`;
const bookings = packFiles("bookings");
const index = bookings["index.ts"] as string;
if (!index.includes("  dashboards: bookingsDashboards,\n")) throw new Error("Bookings moved");
const PACKS: Record<string, Record<string, string>> = {
  bookings: {
    ...bookings,
    "index.ts": index.replace(
      "  dashboards: bookingsDashboards,\n",
      `  dashboards: bookingsDashboards,\n${TODAY_ITEMS}`,
    ),
  },
  memberships: packFiles("memberships"),
  ticketing: packFiles("ticketing"),
  rostering: packFiles("rostering"),
  shop: packFiles("shop"),
};

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !(s.id in PACKS)),
    ...Object.keys(PACKS).map((id) => ({ id, version: "0.1.0" })),
  ],
  commitShipped: (id) =>
    PACKS[id]
      ? host.commit({
          id,
          files: PACKS[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
let admin: ActingUser;
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  widgetCache: memoryWidgetCache(),
  ...extra,
});
const asUser = (user: ActingUser, extra: Partial<InvocationContext> = {}) =>
  staff({ user, ...extra });
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;

type Item = {
  key: string;
  value: number;
  state: string;
  compare: { against: string; value: number } | null;
  target: { kind: string };
};
type Answer = { day: string; zone: string; items: Item[] };
type Rows = {
  items: { label: string; detail: string | null; record: { object: string } | null }[];
};
const today = (ctx: InvocationContext) => run<Answer>("today.get", {}, ctx);
const rowsOf = (ctx: InvocationContext, key: string) => run<Rows>("today.rows", { key }, ctx);
const keys = (a: Answer) => a.items.map((i) => i.key).sort();

/** A staff account given a pack role by a human admin. */
async function fixedRole(name: string, role: string): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("staff")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, email, now, now)
    .run();
  await run("user.setPackRole", { id, role }, staff());
  return { id, email, name, role: "viewer" };
}

/** When today's class starts: a little after now, or before it late in the local day. */
function todayStart(): number {
  const w = localDay(Date.now(), ZONE);
  const now = Date.now();
  return Date.parse(w.to) - now > 3 * HOUR ? now + 5 * MINUTE : now - HOUR;
}

let type: string;
let duty: string;
async function klass(startsAt: number, coach: string | null = null): Promise<string> {
  return create(CLASS, {
    classType: type,
    title: unique("Strength "),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + HOUR).toISOString(),
    timezone: ZONE,
    places: 20,
    ...(coach ? { coach } : {}),
  });
}
/** A walk-in booked at the desk for a new Person, and ticked as came at the class's start. */
async function came(classId: string, name: string): Promise<void> {
  const person = await run<{ id: string }>("person.create", { displayName: name }, staff());
  const desk = await run<{ bookingId: string }>(
    "x.bookings.bookFor",
    { classId, personId: person.id, paidAtDesk: true },
    staff(),
  );
  const starts = String(
    (
      await run<{ values: { startsAt: string } }>(
        "record.get",
        { object: CLASS, id: classId },
        staff(),
      )
    ).values.startsAt,
  );
  const at = new Date(Math.max(Date.parse(starts) + MINUTE, Date.now()));
  await run("x.bookings.markAttended", { bookingId: desk.bookingId }, staff({ clock: () => at }));
}
async function booked(classId: string, name: string): Promise<void> {
  const person = await run<{ id: string }>("person.create", { displayName: name }, staff());
  await run("x.bookings.bookFor", { classId, personId: person.id, paidAtDesk: true }, staff());
}

let coach: ActingUser;
let todays: string;
const TOMORROW = "Tomorrow Person";

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of Object.keys(PACKS)) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  forgetSchemaNames();
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  type = await create("bookings.classtype", { name: unique("Strength") });
  duty = await create("rostering.duty", { name: unique("Cleaning"), place: "Main floor" });
  coach = await fixedRole("Coach Kim", "bookings.coach");
  // Today's class, with nobody coaching it (a shift with nobody on it), two who came, one booked.
  todays = await klass(todayStart());
  await came(todays, "Ana Came");
  await came(todays, "Ben Came");
  await booked(todays, "Cai Booked");
  // Tomorrow's: not today's, and its people are no one's today.
  const tomorrow = await klass(todayStart() + DAY + 2 * HOUR);
  await booked(tomorrow, TOMORROW);
  // A duty shift with nobody on it, in three hours.
  await create("rostering.shift", {
    duty,
    startsAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    endsAt: new Date(Date.now() + 4 * HOUR).toISOString(),
    timezone: ZONE,
  });
}, 240_000);

describe("an admin's Today with the gym's packs", () => {
  it("lists the pack's items and the host's, each count equal to its rows (proof a)", async () => {
    const answer = await today(staff());
    expect(keys(answer)).toEqual(
      expect.arrayContaining([
        "bookings.cameToday",
        "bookings.classesToday",
        "host.approvals",
        "host.checklists",
        "host.notices",
        "host.takings",
        "host.uncovered",
      ]),
    );
    expect(answer.zone).toBe(ZONE);
    for (const key of [
      "bookings.cameToday",
      "bookings.classesToday",
      "host.uncovered",
      "host.checklists",
    ]) {
      const item = answer.items.find((i) => i.key === key);
      const rows = await rowsOf(staff(), key);
      expect([key, rows.items.length]).toEqual([key, item?.value]);
    }
    const came = await rowsOf(staff(), "bookings.cameToday");
    expect(came.items.map((r) => r.label)).toEqual(["Ana Came", "Ben Came"]);
    // The class with no coach and the duty shift with nobody, both within 24 hours.
    const uncovered = answer.items.find((i) => i.key === "host.uncovered");
    expect(uncovered?.value).toBeGreaterThanOrEqual(2);
    expect(uncovered?.state).toBe("attention");
    const shifts = await rowsOf(staff(), "host.uncovered");
    expect(shifts.items.map((r) => r.record?.object)).toEqual(
      expect.arrayContaining([CLASS, "rostering.shift"]),
    );
  });

  it("counts a missed checklist and one still open past its end, as its rows", async () => {
    const checklist = (
      await run<{ id: string }>(
        "checklist.save",
        { name: unique("Close-down "), steps: [{ text: "Mop the floor" }] },
        staff(),
      )
    ).id;
    const w = localDay(Date.now(), ZONE);
    const opens = Math.floor(Date.parse(w.from) / 1000) + 60;
    const now = Math.floor(Date.now() / 1000);
    const run_ = async (state: "open" | "missed") => {
      const id = newId("checklistRun");
      const at = opens + (state === "open" ? 600 : 0);
      const shift = await create("rostering.shift", {
        duty,
        startsAt: new Date((at + 60) * 1000).toISOString(),
        endsAt: new Date((at + 120) * 1000).toISOString(),
        timezone: ZONE,
        staff: admin.id,
      });
      await env.DB.prepare(
        `INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps, account_id, opens, closes, state, made_at)
         VALUES (?, 'rostering.shift', ?, ?, 1, 'Close-down', '[{"text":"Mop the floor","required":true,"note":false}]', ?, ?, ?, 'open', ?)`,
      )
        .bind(
          id,
          shift,
          checklist,
          admin.id,
          opens,
          Math.min(opens + 120, now - 60),
          new Date().toISOString(),
        )
        .run();
      if (state === "missed") {
        await env.DB.prepare(
          "UPDATE core_checklist_run SET state = 'missed', closed_at = ?, closed_by = 'host', missed_steps = '[0]' WHERE id = ?",
        )
          .bind(new Date().toISOString(), id)
          .run();
      }
    };
    const before =
      (await today(staff())).items.find((i) => i.key === "host.checklists")?.value ?? 0;
    await run_("missed");
    await run_("open");
    const item = (await today(staff())).items.find((i) => i.key === "host.checklists");
    expect(item?.value).toBe(before + 2);
    expect(item?.state).toBe("attention");
    expect((await rowsOf(staff(), "host.checklists")).items.length).toBe(item?.value);
    // An assistant never reads a checklist (ADR 0650), nor the uncovered shifts or approvals.
    const ai = await today(staff({ actor: "assistant", origin: { surface: "assistant" } }));
    expect(keys(ai).filter((k) => k.startsWith("host."))).toEqual(["host.takings"]);
  });
});

describe("a coach's Today (proof b)", () => {
  it("holds only the items its role's tools open over what it reads, today's, with no other day", async () => {
    const answer = await today(asUser(coach));
    // Classes today: the role reads classes, on today only (ADR 0553), so it is shown in today's
    // window with no comparison. Came today reads bookings, which the role does not read (its
    // class list is a tool's answer, not a read of bookings): hidden.
    expect(keys(answer)).toEqual(["bookings.classesToday"]);
    expect(answer.items[0]).toMatchObject({ compare: null });
    for (const key of [
      "host.takings",
      "host.approvals",
      "host.uncovered",
      "host.checklists",
      "host.notices",
      "bookings.cameToday",
    ]) {
      expect((await refusal(rowsOf(asUser(coach), key))).code, key).toBe("not_found");
    }
    // (a) for the narrower reach: the count is its rows, today's classes, each a class it reads.
    const classes = (await rowsOf(asUser(coach), "bookings.classesToday")).items;
    expect(classes.length).toBe(answer.items[0]?.value);
    expect(classes.every((r) => r.record?.object === CLASS)).toBe(true);
    // An admin sees the comparison the coach does not.
    const admins = (await today(staff())).items.find((i) => i.key === "bookings.classesToday");
    expect(admins?.compare).toMatchObject({ against: "yesterday" });
  });

  it("a door account, a cleaner and the stockroom have no item at all", async () => {
    for (const role of ["ticketing.door", "rostering.team", "shop.stockroom"]) {
      const user = await fixedRole(unique("Staff "), role);
      expect(keys(await today(asUser(user))), role).toEqual([]);
    }
  });
});

describe("cost (proof d)", () => {
  it("today.get's statements are the same with few records and many", async () => {
    const measure = async () => {
      forgetSchemaNames();
      return queriesOf(() => today(staff({ widgetCache: memoryWidgetCache() })));
    };
    const few = await measure();
    for (let i = 0; i < 5; i++) {
      const k = await klass(todayStart() + i * MINUTE);
      await came(k, unique("Many "));
      await create("rostering.shift", {
        duty,
        startsAt: new Date(Date.now() + (5 + i) * HOUR).toISOString(),
        endsAt: new Date(Date.now() + (6 + i) * HOUR).toISOString(),
        timezone: ZONE,
      });
    }
    const many = await measure();
    expect(few.outcome).toBe("ok");
    expect(many.queries).toBe(few.queries);
    expect(many.queries).toBeLessThanOrEqual(30);
  }, 120_000);
});
