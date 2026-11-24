// Stage 62 step 1 (ADRs 0890 and 0891): a customer's private calendar feed, against the real host.
// A fixture pack declares `calendarEntry` on its bookings (the class's times, the class type's
// name, the room's name, through the class). What the feed shows, read as the customer through the
// visibility seam: their own live bookings and a live dependant's (with the child's first name), in
// the window, nothing of anyone else and no field the customer could not read; ending the family
// link drops the child's on the next fetch. The me.calendarFeed.* operations (made by the customer
// only, the address once, only a hash kept), staff revoking one, and the feed revoked by disabling,
// deleting and erasing the account. `calendarEntry` refused on a runtime extension and on a path
// into another pack's field the customer cannot read. And what one fetch runs on D1.
// The route (headers, the one 404, limits, the staff and customer tokens apart) is tested in
// apps/app/test/customer-feed.test.ts. All names are fixture names.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import type { ExtensionManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  customerFeedEvents,
  readCustomerFeed,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";
import { type Buyer, createBuyer, outside, refusal, run } from "./order-fixtures.ts";

const ext = extId("cal");
const BOOKING = `${ext}.booking`;
const KLASS = `${ext}.klass`;
const KIND = `${ext}.kind`;
const ROOM = `${ext}.room`;
const DAY = 86_400_000;
const NOW = new Date();
const at = (days: number, hour = 9) => {
  const d = new Date(NOW.getTime() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const plus = (iso: string, minutes = 60) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const BOOKING_STATES = [
  { value: "booked", label: "Booked" },
  { value: "attended", label: "Attended" },
  { value: "cancelled", label: "Cancelled" },
];

function fixture(id: string, entry: Record<string, unknown> = {}): ExtensionManifest {
  return manifest(id, {
    objects: {
      kind: {
        label: "Class type",
        plural: "Class types",
        titleField: "name",
        fields: { name: { type: "text", label: "Name", required: true } },
        public: { read: ["name"] },
      },
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          code: { type: "text", label: "Door code" },
        },
        public: { read: ["name"] },
      },
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "title",
        fields: {
          // A business may type a member's name here: never in the feed.
          title: { type: "text", label: "Title" },
          kind: { type: "relation", label: "Class type", to: `${id}.kind` },
          room: { type: "relation", label: "Room", to: `${id}.room` },
          startsAt: { type: "datetime", label: "Starts at", required: true },
          endsAt: { type: "datetime", label: "Ends at", required: true },
          notes: { type: "longText", label: "Notes" },
        },
        public: { read: ["kind", "room", "startsAt", "endsAt"] },
        customerVia: {
          from: `${id}.booking`,
          field: "klass",
          read: ["title", "kind", "room", "startsAt", "endsAt"],
        },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          klass: { type: "relation", label: "Class", to: `${id}.klass`, required: true },
          person: { type: "relation", label: "Person", to: "person" },
          kind: { type: "relation", label: "Class type", to: `${id}.kind` },
          state: { type: "select", label: "State", options: BOOKING_STATES },
          note: { type: "longText", label: "Staff note" },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [
            { from: "booked", to: "cancelled", by: ["staff"] },
            { from: "booked", to: "attended", by: ["staff"] },
          ],
        },
        customer: {
          field: "person",
          read: ["person", "klass", "state", "kind"],
          write: [],
          guardians: {},
        },
        calendarEntry: {
          starts: "klass.startsAt",
          ends: "klass.endsAt",
          title: "kind.name",
          place: "klass.room.name",
          live: ["booked", "attended"],
          ...entry,
        },
      },
    },
  });
}

let admin: ActingUser;
let member: Buyer;
let other: Buyer;
let childId: string;
let linkId: string;
const ids: Record<string, string> = {};
const k: Record<string, string> = {};
const kinds: Record<string, string> = {};

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
const feedOf = (buyer: Buyer, now = NOW) =>
  customerFeedEvents({ db: db.query, principal: buyer.principal }, now);

const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const tokenOf = (path: string) => /\/api\/v1\/me\/feed\/([A-Za-z0-9_-]{43})\.ics$/.exec(path)?.[1];

async function rotate(buyer: Buyer): Promise<string> {
  const out = await run<{ path: string }>("me.calendarFeed.rotate", {}, outside(buyer.principal));
  const token = tokenOf(out.path);
  if (!token) throw new Error(`not a feed path: ${out.path}`);
  return token;
}

async function klass(values: Record<string, unknown>): Promise<string> {
  return create(KLASS, values);
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture(ext));
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify({ id: ext, version: "1.0.0", tools: {} }), admin.id, at(0), at(0))
    .run();
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_name', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify("Fixture Gym"), at(0))
    .run();
  member = await createBuyer(admin, "calm");
  other = await createBuyer(admin, "calo");
  const child = await run<{ id: string }>(
    "person.create",
    { givenName: "Ava", familyName: "Fixture", displayName: "Ava Fixture" },
    context(admin),
  );
  childId = child.id;
  linkId = (
    await run<{ id: string }>(
      "person.link.add",
      { guardianId: member.principal.personId, dependantId: childId },
      context(admin),
    )
  ).id;

  const strength = await create(KIND, { name: "Strength" });
  const swim = await create(KIND, { name: "Junior swim" });
  kinds.strength = strength;
  kinds.swim = swim;
  const studio = await create(ROOM, { name: "Studio A", code: "4321" });
  const pool = await create(ROOM, { name: "Pool", code: "9876" });
  Object.assign(k, {
    soon: await klass({
      title: "Strength with Zed Member",
      kind: strength,
      room: studio,
      startsAt: at(2),
      endsAt: plus(at(2)),
      notes: "Zed's knee",
    }),
    yesterday: await klass({ kind: strength, startsAt: at(-1), endsAt: plus(at(-1)) }),
    yesterdayLater: await klass({ kind: swim, startsAt: at(-1, 11), endsAt: plus(at(-1, 11)) }),
    tooOld: await klass({ kind: strength, startsAt: at(-20), endsAt: plus(at(-20)) }),
    tooFar: await klass({ kind: strength, startsAt: at(130), endsAt: plus(at(130)) }),
    swim: await klass({ kind: swim, room: pool, startsAt: at(3, 7), endsAt: plus(at(3, 7), 45) }),
    untyped: await klass({ startsAt: at(4), endsAt: plus(at(4)) }),
    cancelled: await klass({ kind: strength, startsAt: at(5), endsAt: plus(at(5)) }),
  });
  const book = (klassId: string | undefined, person: string, kind?: string) =>
    create(BOOKING, {
      klass: klassId as string,
      person,
      ...(kind ? { kind } : {}),
      note: "Staff only",
    });
  const me = member.principal.personId;
  ids.soon = await book(k.soon, me, strength);
  ids.yesterday = await book(k.yesterday, me, strength);
  ids.tooOld = await book(k.tooOld, me, strength);
  ids.tooFar = await book(k.tooFar, me, strength);
  ids.untyped = await book(k.untyped, me);
  ids.cancelled = await book(k.cancelled, me, strength);
  await run(
    "record.update",
    { object: BOOKING, id: ids.cancelled, values: { state: "cancelled" } },
    context(admin),
  );
  ids.attended = await book(k.yesterdayLater as string, me, swim);
  await run(
    "record.update",
    { object: BOOKING, id: ids.attended, values: { state: "attended" } },
    context(admin),
  );
  ids.child = await book(k.swim, childId, swim);
  ids.others = await book(k.soon, other.principal.personId, strength);
});

describe("what the feed shows (criteria 1 and 3)", () => {
  it("the customer's own live bookings in the window, soonest first, public names only", async () => {
    const events = await feedOf(member);
    expect(events.map((e) => e.id)).toEqual([
      ids.yesterday,
      ids.attended,
      ids.soon,
      ids.child,
      ids.untyped,
    ]);
    const soon = events.find((e) => e.id === ids.soon);
    expect(soon).toEqual({
      object: BOOKING,
      id: ids.soon,
      title: "Strength",
      place: "Studio A",
      startsAt: at(2),
      endsAt: plus(at(2)),
    });
    // Nothing a business typed about a member, nothing of the room but its name, no note.
    const text = JSON.stringify(events);
    for (const absent of ["Zed", "4321", "9876", "Staff only", other.principal.personId]) {
      expect(text).not.toContain(absent);
    }
  });

  it("a live dependant's, with the child's first name; ending the link drops them at once", async () => {
    const child = (await feedOf(member)).find((e) => e.id === ids.child);
    expect(child).toMatchObject({ title: "Ava: Junior swim", place: "Pool" });
    await run("person.link.end", { id: linkId }, context(admin));
    try {
      expect((await feedOf(member)).map((e) => e.id)).not.toContain(ids.child);
    } finally {
      linkId = (
        await run<{ id: string }>(
          "person.link.add",
          { guardianId: member.principal.personId, dependantId: childId },
          context(admin),
        )
      ).id;
    }
    expect((await feedOf(member)).map((e) => e.id)).toContain(ids.child);
  });

  it("an event with no public name is a booking at the business", async () => {
    const untyped = (await feedOf(member)).find((e) => e.id === ids.untyped);
    expect(untyped?.title).toBe("Booking at Fixture Gym");
    expect(untyped?.place).toBe(null);
  });

  it("never another customer's: theirs is theirs alone", async () => {
    expect((await feedOf(other)).map((e) => e.id)).toEqual([ids.others]);
  });

  it("leaving the live states drops a booking on the next fetch", async () => {
    await run(
      "record.update",
      { object: BOOKING, id: ids.soon, values: { state: "cancelled" } },
      context(admin),
    );
    expect((await feedOf(member)).map((e) => e.id)).not.toContain(ids.soon);
    // Booked again: a new record, a new UID, so a calendar app shows it once.
    ids.soon = await create(BOOKING, {
      klass: k.soon,
      person: member.principal.personId,
      kind: kinds.strength,
    });
    expect((await feedOf(member)).map((e) => e.id)).toContain(ids.soon);
  });

  it("shows nothing from a pack that is not a shipped, active one", async () => {
    await env.DB.prepare("UPDATE core_extensions SET status = 'disabled' WHERE id = ?")
      .bind(ext)
      .run();
    try {
      expect(await feedOf(member)).toEqual([]);
    } finally {
      await env.DB.prepare("UPDATE core_extensions SET status = 'active' WHERE id = ?")
        .bind(ext)
        .run();
    }
  });
});

describe("me.calendarFeed.* (criteria 1 and 4)", () => {
  it("made by the customer, shown once, kept as its hash only; rotating replaces it", async () => {
    expect(await run("me.calendarFeed.status", {}, outside(member.principal))).toEqual({
      active: false,
      createdAt: null,
    });
    const first = await rotate(member);
    const row = await env.DB.prepare("SELECT * FROM core_customer_feed WHERE customer_id = ?")
      .bind(member.principal.customerId)
      .first<Record<string, unknown>>();
    expect(row?.token_hash).toBe(await sha256(first));
    expect(JSON.stringify(row)).not.toContain(first);
    const feed = await readCustomerFeed(db.query, first, NOW);
    expect(feed?.customerId).toBe(member.principal.customerId);
    expect(feed?.events.length).toBeGreaterThan(0);
    const second = await rotate(member);
    expect(await readCustomerFeed(db.query, first, NOW)).toBe(null);
    expect(await readCustomerFeed(db.query, second, NOW)).not.toBe(null);
    const status = await run<{ active: boolean }>(
      "me.calendarFeed.status",
      {},
      outside(member.principal),
    );
    expect(status.active).toBe(true);
    expect(JSON.stringify(status)).not.toContain(second);
  });

  it("the address is never in the audit log", async () => {
    const token = await rotate(member);
    const { results: rows } = await env.DB.prepare("SELECT * FROM core_audit WHERE operation = ?")
      .bind("me.calendarFeed.rotate")
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("revoked by the customer: the address then opens nothing", async () => {
    const token = await rotate(other);
    expect(await run("me.calendarFeed.revoke", {}, outside(other.principal))).toEqual({
      revoked: true,
    });
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    expect(await run("me.calendarFeed.revoke", {}, outside(other.principal))).toEqual({
      revoked: false,
    });
  });

  it("never made by a pack's tool run for the customer, nor by staff", async () => {
    await expect(
      run("me.calendarFeed.rotate", {}, outside(member.principal, { tool: toolCaller() })),
    ).rejects.toThrow();
    await expect(run("me.calendarFeed.rotate", {}, context(admin))).rejects.toThrow();
  });

  it("staff revoke a customer's (never make one); a made-up account is not found", async () => {
    const token = await rotate(other);
    const out = await run<{ revoked: boolean }>(
      "customer.revokeCalendarFeed",
      { id: other.principal.customerId },
      context(admin),
    );
    expect(out.revoked).toBe(true);
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    const missing = await refusal(
      run("customer.revokeCalendarFeed", { id: "cus_nobody" }, context(admin)),
    );
    expect(missing.code).toBe("not_found");
    const member2 = await createUser("member");
    const forbidden = await refusal(
      run("customer.revokeCalendarFeed", { id: other.principal.customerId }, context(member2)),
    );
    expect(forbidden.code).toBe("forbidden");
  });

  it("malformed and made-up tokens open nothing", async () => {
    for (const token of ["short", `${"A".repeat(43)}`, `${"A".repeat(42)}!`]) {
      expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    }
  });

  it("a staff feed's token is never looked up here", async () => {
    const token = "B".repeat(43);
    const staff = await createUser("member");
    await env.DB.prepare(
      "INSERT INTO core_staff_feed (account_id, token_hash, tool, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(staff.id, await sha256(token), `x.${ext}.feedRotate`, at(0))
      .run();
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
  });
});

// A tool run's caller, as the runner hands it to a customer's call from a pack's tool.
function toolCaller() {
  return { extension: ext, tool: "anything" };
}

// The review of PR #433, finding 1: a pack whose title is the class's own title (which the
// customer reads through their booking, and a business may type a member's name into) is refused
// by the check, and, were it installed anyway, the feed shows none of that object's events.
describe("a title is a public name, never a field only the customer's through their booking", () => {
  it("is refused by the check", async () => {
    const id = extId("caltitle");
    const result = await checkManifest(db.query, id, fixture(id, { title: "klass.title" }), at(0));
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "objects.booking.calendarEntry.title",
        message: expect.stringContaining("not a public field"),
      }),
    ]);
  });

  it("installed anyway, the feed shows nothing of it: the read holds the rule too", async () => {
    const id = extId("caltitlerun");
    await reconcile(fixture(id, { title: "klass.title" }));
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
    )
      .bind(id, JSON.stringify({ id, version: "1.0.0", tools: {} }), admin.id, at(0), at(0))
      .run();
    const buyer = await createBuyer(admin, "caltt");
    const klassId = await create(`${id}.klass`, {
      title: "Strength with Zed Member",
      startsAt: at(2),
      endsAt: plus(at(2)),
    });
    const booking = await create(`${id}.booking`, {
      klass: klassId,
      person: buyer.principal.personId,
    });
    const events = await feedOf(buyer);
    expect(events.map((e) => e.id)).not.toContain(booking);
    expect(JSON.stringify(events)).not.toContain("Zed");
  });
});

// The review of PR #433, finding 3: a child is named by their given name, and a child with no
// usable name is still shown, as "Child".
describe("a dependant's prefix", () => {
  it("is their given name, never the display name's first word; a blank name still shows", async () => {
    const parent = await createBuyer(admin, "calp");
    const named = await run<{ id: string }>(
      "person.create",
      { givenName: "Bea", familyName: "Fixture", displayName: "Fixture, Bea" },
      context(admin),
    );
    const blank = await run<{ id: string }>(
      "person.create",
      { displayName: "Someone" },
      context(admin),
    );
    for (const dependantId of [named.id, blank.id]) {
      await run(
        "person.link.add",
        { guardianId: parent.principal.personId, dependantId },
        context(admin),
      );
    }
    await env.DB.prepare(
      "UPDATE core_person SET display_name = ' ', given_name = NULL WHERE id = ?",
    )
      .bind(blank.id)
      .run();
    const beas = await create(BOOKING, {
      klass: k.swim as string,
      person: named.id,
      kind: kinds.swim,
    });
    const blanks = await create(BOOKING, {
      klass: k.swim as string,
      person: blank.id,
      kind: kinds.swim,
    });
    const events = await feedOf(parent);
    expect(events.find((e) => e.id === beas)?.title).toBe("Bea: Junior swim");
    expect(events.find((e) => e.id === blanks)?.title).toBe("Child: Junior swim");
  });
});

describe("revoked with the account (criterion 4)", () => {
  // The review of PR #433, finding 4: no address that would open nothing.
  it("a rotate on an account no longer active is refused, and writes nothing", async () => {
    const buyer = await createBuyer(admin, "calr");
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE id = ?")
      .bind(buyer.principal.customerId)
      .run();
    const refused = await refusal(run("me.calendarFeed.rotate", {}, outside(buyer.principal)));
    expect(refused.code).toBe("not_found");
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_feed WHERE customer_id = ?",
    )
      .bind(buyer.principal.customerId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("disabling deletes it in the disable's batch; enabling brings nothing back", async () => {
    const buyer = await createBuyer(admin, "cald");
    const token = await rotate(buyer);
    await run("customer.disable", { id: buyer.principal.customerId }, context(admin));
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    await run("customer.enable", { id: buyer.principal.customerId }, context(admin));
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_feed WHERE customer_id = ?",
    )
      .bind(buyer.principal.customerId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("a disabled account's token opens nothing even with its row", async () => {
    const buyer = await createBuyer(admin, "calx");
    const token = await rotate(buyer);
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE id = ?")
      .bind(buyer.principal.customerId)
      .run();
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
  });

  it("deleting the account deletes it", async () => {
    const buyer = await createBuyer(admin, "caldel");
    const token = await rotate(buyer);
    const preview = await run<{ expect: string }>("me.deleteAccount", {}, outside(buyer.principal));
    await run(
      "me.deleteAccount",
      { confirm: true, expect: preview.expect },
      outside(buyer.principal),
    );
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_feed WHERE customer_id = ?",
    )
      .bind(buyer.principal.customerId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("erasing the Person deletes it with the account", async () => {
    const buyer = await createBuyer(admin, "caler");
    const token = await rotate(buyer);
    await run("person.erase", { id: buyer.principal.personId }, context(admin));
    expect(await readCustomerFeed(db.query, token, NOW)).toBe(null);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_customer_feed WHERE customer_id = ?",
    )
      .bind(buyer.principal.customerId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("calendarEntry at the host's check (criterion 6)", () => {
  it("is refused to a runtime extension", async () => {
    const id = extId("calrun");
    const result = await checkManifest(db.query, id, fixture(id), at(0), { source: "runtime" });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "outside_audience",
          path: "objects.booking.calendarEntry",
        }),
      ]),
    );
  });

  it("a path into another pack's object holds to what the customer reads of it", async () => {
    const id = extId("caltix");
    const tickets = (title: string) =>
      manifest(id, {
        objects: {
          ticket: {
            label: "Ticket",
            plural: "Tickets",
            titleField: "title",
            fields: {
              title: { type: "text", label: "Title" },
              klass: { type: "relation", label: "Class", to: KLASS },
              person: { type: "relation", label: "Person", to: "person" },
              state: {
                type: "select",
                label: "State",
                options: [{ value: "valid", label: "Valid" }],
              },
            },
            states: { field: "state", initial: "valid", moves: [] },
            customer: { field: "person", read: ["person", "klass", "state"], write: [] },
            calendarEntry: {
              starts: "klass.startsAt",
              ends: "klass.endsAt",
              title,
              live: ["valid"],
            },
          },
        },
      });
    const good = await checkManifest(db.query, id, tickets("klass.kind"), at(0));
    // klass.kind is a relation, not a text field: a type error, found by the host.
    expect(good.issues.map((i) => i.path)).toEqual(["objects.ticket.calendarEntry.title"]);
    // The class's notes are not public, and the customerVia is the booking's, not the ticket's.
    const notes = await checkManifest(db.query, id, tickets("klass.notes"), at(0));
    expect(notes.issues).toEqual([
      expect.objectContaining({
        path: "objects.ticket.calendarEntry.title",
        message: expect.stringContaining("not a public field"),
      }),
    ]);
    const title = await checkManifest(db.query, id, tickets("klass.title"), at(0));
    expect(title.issues.map((i) => i.path)).toEqual(["objects.ticket.calendarEntry.title"]);
    const ok = await checkManifest(db.query, id, tickets("klass.kind.name"), at(0));
    expect(ok.issues).toEqual([]);
  });
});

describe("one fetch is bounded (D1's limits)", () => {
  /** What one fetch ran on D1: each statement's bound variables. */
  let ran: number[] = [];
  const counted = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  ran.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              if (typeof value === "function") {
                if (name === "all" || name === "first" || name === "run" || name === "raw") {
                  ran.push(0);
                }
                return value.bind(inner);
              }
              return value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const countedDb = createCrmDb(counted);

  async function measure(token: string): Promise<number[]> {
    // Warm the schema cache first: a cold call's scan of sqlite_master is the schema's, not the
    // feed's (CONTRIBUTING.md, Working in parallel).
    await readCustomerFeed(db.query, token, NOW);
    ran = [];
    expect(await readCustomerFeed(countedDb.query, token, NOW)).not.toBe(null);
    return ran;
  }

  it("the same statements, each well under 100 bound variables, for a long history and many children", async () => {
    const buyer = await createBuyer(admin, "calb");
    const token = await rotate(buyer);
    const small = await measure(token);
    expect(small.length).toBeLessThan(30);
    const kind = kinds.strength;
    const old = await klass({ kind, startsAt: at(-60), endsAt: plus(at(-60)) });
    for (let n = 0; n < 40; n += 1) {
      await create(BOOKING, { klass: old, person: buyer.principal.personId, kind });
    }
    for (let n = 0; n < 12; n += 1) {
      const kid = await run<{ id: string }>(
        "person.create",
        { givenName: `Kid${n}`, displayName: `Kid${n} Fixture` },
        context(admin),
      );
      await run(
        "person.link.add",
        { guardianId: buyer.principal.personId, dependantId: kid.id },
        context(admin),
      );
      await create(BOOKING, { klass: old, person: kid.id, kind });
    }
    const large = await measure(token);
    expect(large.length).toBe(small.length);
    expect(Math.max(...large)).toBeLessThan(100);
  });
});
