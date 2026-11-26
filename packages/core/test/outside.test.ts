// Stage 65 step 3 (ADR 0922): the booking system's copy in core. Lists read through the contract
// (the fake booking system, and the file source) and planned into one batch that replaces the copy
// of their kind; matching by address, never merged; links by hand kept across loads; erased
// addresses and refs keeping nothing; who may read and change any of it; and every read empty with
// no list at all. Against real D1.
import { env } from "cloudflare:workers";
import {
  directSession,
  FakeBookingSystem,
  FileBookingSystem,
  fakeBookingSystemState,
  loadFiles,
} from "@composable-os/gatekeeper-booking-system";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type Actor, invokeByName } from "../src/index.ts";
import {
  type ListMeta,
  planMembers,
  planTimetable,
  readMembers,
  readTimetable,
} from "../src/outside/ingest.ts";
import { outsideRefHash } from "../src/outside/match.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { context, createUser, db, timeline, unique } from "./helpers.ts";

const NOW = "2026-11-24T09:00:00.000Z";

async function call<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  actor: Actor = "human",
): Promise<T> {
  const surface =
    actor === "assistant"
      ? "assistant"
      : actor === "mcp"
        ? "mcp"
        : actor === "automation"
          ? "automation"
          : actor === "extension"
            ? "extension"
            : "ui";
  return (await invokeByName(
    name,
    input,
    context(user, {
      actor,
      origin: { surface, ...(actor === "extension" ? { extensionId: "someext" } : {}) },
      clock: () => new Date(NOW),
    }),
  )) as T;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

/** A fake site whose addresses are this run's own. */
function freshFake() {
  const tag = unique("bs");
  const state = fakeBookingSystemState({ now: NOW, pageSize: 4 });
  for (const p of state.people) {
    if (p.email) p.email = p.email.replace("@example.com", `@${tag}.example.com`);
  }
  for (const s of state.staff) {
    if (s.email) s.email = s.email.replace("@example.com", `@${tag}.example.com`);
  }
  const fake = new FakeBookingSystem(state);
  const address = (i: number) => state.people[i]?.email as string;
  return { fake, state, session: directSession(fake), address };
}

const meta = (by: string, over: Partial<ListMeta> = {}): ListMeta => ({
  exportedOn: "2026-11-23",
  by,
  now: NOW,
  rows: 12,
  refused: 0,
  ...over,
});

async function loadMembers(session: ReturnType<typeof directSession>, by: string) {
  const plan = await planMembers(db.query, await readMembers(session), meta(by));
  await db.batch(plan.statements);
  return plan;
}

async function outsidePerson(ref: string) {
  return env.DB.prepare("SELECT * FROM core_outside_person WHERE ref = ?")
    .bind(ref)
    .first<Record<string, unknown>>();
}

async function personRow(id: string) {
  return env.DB.prepare(
    "SELECT p.*, (SELECT group_concat(email) FROM core_person_emails WHERE person_id = p.id) AS emails FROM core_person p WHERE id = ?",
  )
    .bind(id)
    .first<Record<string, unknown>>();
}

async function createPerson(admin: ActingUser, emails: string[]) {
  const person = await call<{ id: string }>(
    "person.create",
    { displayName: unique("Member"), emails: emails.map((email) => ({ email })) },
    admin,
  );
  return person.id;
}

describe("the booking system's copy", () => {
  let admin: ActingUser;
  let member: ActingUser;
  let viewer: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
    member = await createUser("member");
    viewer = await createUser("viewer");
  });

  it("with no list at all, every read answers empty and the settings are the defaults", async () => {
    const status = await call<{
      lists: unknown[];
      counts: Record<string, number>;
      largestAgeDays: number;
      enabled: boolean;
    }>("outside.status", {}, admin);
    expect(status.lists).toEqual([]);
    expect(Object.values(status.counts).every((n) => n === 0)).toBe(true);
    expect(status.largestAgeDays).toBe(31);
    expect(status.enabled).toBe(true);
    expect(await call("outside.matches", {}, admin)).toEqual({ matches: [], next: null });
    expect(await call("outside.settings.get", {}, admin)).toMatchObject({
      source: "file",
      enabled: true,
      memberTypes: null,
      manageUrl: null,
      bookUrl: null,
      largestAgeDays: 31,
      types: [],
    });
  });

  it("is bookingSystem:manage to read, admins by default, grantable one by one; settings stay a human admin's", async () => {
    for (const who of [member, viewer]) {
      for (const [name, input] of [
        ["outside.status", {}],
        ["outside.matches", {}],
        ["outside.settings.get", {}],
        ["outside.settings.update", { largestAgeDays: 7 }],
        ["outside.unlink", { kind: "person", ref: "x", why: "y" }],
      ] as const) {
        expect((await refusal(call(name, input, who))).code, `${who.role} ${name}`).toBe(
          "forbidden",
        );
      }
    }
    const granted = await createUser("member");
    await call(
      "user.setPermissions",
      { id: granted.id, permissions: ["bookingSystem:manage"] },
      admin,
    );
    await call("outside.status", {}, granted);
    await call("outside.settings.get", {}, granted);
    expect(
      (await refusal(call("outside.settings.update", { largestAgeDays: 7 }, granted))).code,
    ).toBe("forbidden");
    const grantable = await call<{ items: { permission: string; forFixedRole: boolean }[] }>(
      "user.grantablePermissions",
      {},
      admin,
    );
    expect(grantable.items.find((g) => g.permission === "bookingSystem:manage")).toMatchObject({
      forFixedRole: false,
    });
  });

  it("an assistant or MCP client may read the lists' state, and never links, unlinks or changes settings", async () => {
    for (const actor of ["assistant", "mcp"] as const) {
      await call("outside.status", {}, admin, actor);
      await call("outside.matches", {}, admin, actor);
      for (const [name, input] of [
        ["outside.settings.update", { largestAgeDays: 7 }],
        ["outside.link", { kind: "person", ref: "x", personId: "per_x", why: "y" }],
        ["outside.unlink", { kind: "person", ref: "x", why: "y" }],
      ] as const) {
        expect((await refusal(call(name, input, admin, actor))).code, `${actor} ${name}`).toBe(
          "forbidden",
        );
      }
    }
    for (const actor of ["automation", "extension"] as const) {
      for (const [name, input] of [
        ["outside.link", { kind: "person", ref: "x", personId: "per_x", why: "y" }],
        ["outside.unlink", { kind: "person", ref: "x", why: "y" }],
        ["outside.settings.update", { largestAgeDays: 7 }],
      ] as const) {
        expect((await refusal(call(name, input, admin, actor))).code, `${actor} ${name}`).toBe(
          "forbidden",
        );
      }
    }
  });

  it("changes the settings for a human admin: member types, https links and the largest age", async () => {
    const out = await call(
      "outside.settings.update",
      {
        memberTypes: ["fake-type-unlimited"],
        manageUrl: "https://book.example.com/account",
        bookUrl: "https://book.example.com/classes",
        largestAgeDays: 14,
      },
      admin,
    );
    expect(out).toMatchObject({ memberTypes: ["fake-type-unlimited"], largestAgeDays: 14 });
    for (const bad of [
      { manageUrl: "http://book.example.com" },
      { largestAgeDays: 91 },
      { largestAgeDays: 0 },
    ]) {
      expect((await refusal(call("outside.settings.update", bad, admin))).code).toBe(
        "invalid_input",
      );
    }
    await call(
      "outside.settings.update",
      { memberTypes: null, manageUrl: null, bookUrl: null, largestAgeDays: 31 },
      admin,
    );
  });

  it("keeps only members, live passes and the staff-linked, and links one Person by address without changing them", async () => {
    const { session, state, address } = freshFake();
    const avery = await createPerson(admin, [address(0)]);
    const before = await personRow(avery);
    const plan = await loadMembers(session, admin.id);

    // Members (001-004, 011) and live passes (007, 008); the suspended, expired, ended, declined,
    // a member of nothing and the one with no address are dropped.
    const kept = (
      await env.DB.prepare("SELECT ref, why_kept FROM core_outside_person ORDER BY ref").all<{
        ref: string;
        why_kept: string;
      }>()
    ).results;
    expect(kept.map((r) => r.ref)).toEqual(
      [1, 2, 3, 4, 7, 8, 11].map((n) => `fake-person-${String(n).padStart(3, "0")}`),
    );
    expect(kept.find((r) => r.ref === "fake-person-007")?.why_kept).toBe("pass");
    expect(plan.counts).toMatchObject({ kept: 7, notKept: 5, linked: 1 });

    // Linked by address; nothing on the Person changed; one activity naming no address.
    expect(await outsidePerson("fake-person-001")).toMatchObject({
      person_id: avery,
      link_how: "address",
      address: address(0),
    });
    const after = await personRow(avery);
    expect(after).toEqual(before);
    const activities = (await timeline("person", avery)).filter(
      (a) => a.subject === "Linked to the booking system's list",
    );
    expect(activities).toHaveLength(1);
    expect(JSON.stringify(activities[0])).not.toContain(address(0));

    // Only the contract's fields of a kept person's memberships are kept, and none of others'.
    const memberships = (
      await env.DB.prepare("SELECT person_ref FROM core_outside_membership").all<{
        person_ref: string;
      }>()
    ).results.map((r) => r.person_ref);
    expect(memberships).not.toContain("fake-person-005");
    expect(memberships).toContain("fake-person-007");
    const columns = (
      await env.DB.prepare("SELECT name FROM pragma_table_info('core_outside_person')").all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
    expect(columns.some((c) => /phone|birth|card|note|postal/.test(c))).toBe(false);
    expect(state.people.length).toBe(12);
  });

  it("links nobody when two Persons or two outside people share an address, and they wait in To match", async () => {
    const { fake, session, address } = freshFake();
    // Two Persons with one address (one as a +tag: the same person for matching, ADR 0692).
    const [local, domain] = address(1).split("@") as [string, string];
    const p1 = await createPerson(admin, [address(1)]);
    const p2 = await createPerson(admin, [`${local}+gym@${domain}`]);
    // Two outside people on one mailbox: a family.
    fake.shareAddress("fake-person-003", "fake-person-004");
    const family = await createPerson(admin, [address(2)]);
    await loadMembers(session, admin.id);

    expect(await outsidePerson("fake-person-002")).toMatchObject({ person_id: null });
    expect(await outsidePerson("fake-person-003")).toMatchObject({ person_id: null });
    expect(await outsidePerson("fake-person-004")).toMatchObject({ person_id: null });
    const { matches } = await call<{
      matches: { ref: string; why: string; candidates: { id: string }[] }[];
    }>("outside.matches", { kind: "person" }, admin);
    const byRef = new Map(matches.map((m) => [m.ref, m]));
    expect(byRef.get("fake-person-002")?.why).toBe("several_people");
    expect(
      byRef
        .get("fake-person-002")
        ?.candidates.map((c) => c.id)
        .sort(),
    ).toEqual([p1, p2].sort());
    expect(byRef.get("fake-person-003")?.why).toBe("shared_address");
    expect(byRef.get("fake-person-004")?.candidates.map((c) => c.id)).toEqual([family]);
    const status = await call<{ counts: { waitingPeople: number } }>("outside.status", {}, admin);
    expect(status.counts.waitingPeople).toBe(2 + 1);
  });

  it("leaves someone with no Person unlinked, and links them when a Person with the address signs up", async () => {
    const { session, address } = freshFake();
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-011")).toMatchObject({
      person_id: null,
      link_how: null,
    });
    const status = await call<{ counts: { waitingPeople: number } }>("outside.status", {}, admin);
    expect(status.counts.waitingPeople).toBe(0);

    const lane = await createPerson(admin, [address(10).toUpperCase()]);
    expect(await outsidePerson("fake-person-011")).toMatchObject({
      person_id: lane,
      link_how: "address",
    });
    expect(
      (await timeline("person", lane)).filter(
        (a) => a.subject === "Linked to the booking system's list",
      ),
    ).toHaveLength(1);

    // The Person's address changes: the link by address goes, to be matched again at a load.
    await call(
      "person.update",
      { id: lane, emails: [{ email: `${unique("x")}@example.com` }] },
      admin,
    );
    expect(await outsidePerson("fake-person-011")).toMatchObject({
      person_id: null,
      link_how: null,
    });
  });

  it("keeps nothing of an erased address or a suppressed ref", async () => {
    const { session, address } = freshFake();
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(address(0)), NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_outside_suppressed (hash, kind, created_at) VALUES (?, 'ref', ?)",
    )
      .bind(await outsideRefHash(db.query, "person", "fake-person-002"), NOW)
      .run();
    const plan = await loadMembers(session, admin.id);
    expect(plan.counts.dropped).toBe(2);
    expect(await outsidePerson("fake-person-001")).toBeNull();
    expect(await outsidePerson("fake-person-002")).toBeNull();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref IN ('fake-person-001', 'fake-person-002')",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps a staff link across the next load, and an unlink stops a link by address", async () => {
    const { fake, session, address } = freshFake();
    fake.shareAddress("fake-person-003", "fake-person-004");
    const chosen = await createPerson(admin, [`${unique("own")}@example.com`]);
    const harper = await createPerson(admin, [address(6)]);
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-007")).toMatchObject({ person_id: harper });

    await call(
      "outside.link",
      {
        kind: "person",
        ref: "fake-person-003",
        personId: chosen,
        why: "the parent on the mailbox",
      },
      admin,
    );
    await call(
      "outside.unlink",
      { kind: "person", ref: "fake-person-007", why: "a different Harper" },
      admin,
    );
    // The next load: the staff link holds whatever the address; the unlink holds too.
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-003")).toMatchObject({
      person_id: chosen,
      link_how: "staff",
      link_by: admin.id,
      link_why: "the parent on the mailbox",
    });
    expect(await outsidePerson("fake-person-007")).toMatchObject({
      person_id: null,
      link_how: "staff",
    });
    const { matches } = await call<{ matches: { ref: string }[] }>("outside.matches", {}, admin);
    expect(matches.map((m) => m.ref)).not.toContain("fake-person-003");
    // The audit row names neither the ref nor an address.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'outside.link' ORDER BY at DESC LIMIT 1",
    ).first<{ input: string; result: string }>();
    expect(audit?.input ?? "").not.toContain("fake-person-003");
    expect(audit?.input ?? "").toContain("the parent on the mailbox");

    // A ref not in the current list is refused.
    expect(
      (
        await refusal(
          call(
            "outside.link",
            { kind: "person", ref: "nobody", personId: chosen, why: "x" },
            admin,
          ),
        )
      ).code,
    ).toBe("invalid_input");
  });

  it("replaces the copy of its kind: rows not in the new list go, with their links and matches", async () => {
    const { fake, session, address } = freshFake();
    const avery = await createPerson(admin, [address(0)]);
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-001")).toMatchObject({ person_id: avery });
    fake.change("person", "fake-person-001", { memberStatus: "ended" });
    fake.state.memberships = fake.state.memberships.filter((m) => m.person !== "fake-person-001");
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-001")).toBeNull();
    const lists = (
      await env.DB.prepare(
        "SELECT state FROM core_outside_list WHERE kind = 'members' ORDER BY loaded_at, id",
      ).all<{ state: string }>()
    ).results;
    expect(lists.filter((l) => l.state === "current")).toHaveLength(1);
    expect(lists.filter((l) => l.state === "replaced").length).toBeGreaterThan(0);
    const status = await call<{ lists: { kind: string; exportedOn: string; ageDays: number }[] }>(
      "outside.status",
      {},
      admin,
    );
    expect(status.lists.find((l) => l.kind === "members")).toMatchObject({
      exportedOn: "2026-11-23",
    });
  });

  it("marks a members list past the largest age too old to count, and keeps showing it", async () => {
    const { session } = freshFake();
    const plan = await planMembers(
      db.query,
      await readMembers(session),
      meta(admin.id, { exportedOn: "2026-10-01" }),
    );
    await db.batch(plan.statements);
    const status = await call<{ lists: { kind: string; tooOld: boolean; ageDays: number }[] }>(
      "outside.status",
      {},
      admin,
    );
    expect(status.lists.find((l) => l.kind === "members")).toMatchObject({
      tooOld: true,
      ageDays: 54,
    });
    await call("outside.settings.update", { largestAgeDays: 60 }, admin);
    const later = await call<{ lists: { kind: string; tooOld: boolean }[] }>(
      "outside.status",
      {},
      admin,
    );
    expect(later.lists.find((l) => l.kind === "members")?.tooOld).toBe(false);
    await call("outside.settings.update", { largestAgeDays: 31 }, admin);
    await expect(
      planMembers(
        db.query,
        await readMembers(session),
        meta(admin.id, { exportedOn: "2027-01-01" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("loads a timetable: classes, bookings and coaches matched to staff accounts, spending no allowance", async () => {
    const { state, session } = freshFake();
    const riley = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?")
      .bind(String(state.staff[0]?.email).toUpperCase(), riley.id)
      .run();
    const uses = await env.DB.prepare("SELECT count(*) AS n FROM core_allowance_use").first<{
      n: number;
    }>();
    const data = await readTimetable(session, {
      from: "2026-11-17T00:00:00.000Z",
      until: "2026-12-22T00:00:00.000Z",
    });
    const plan = await planTimetable(db.query, data, meta(admin.id));
    await db.batch(plan.statements);
    expect(plan.counts.items.classes).toBe(70);
    const coach = await env.DB.prepare(
      "SELECT * FROM core_outside_staff WHERE ref = 'fake-staff-1'",
    ).first<Record<string, unknown>>();
    expect(coach).toMatchObject({ user_id: riley.id, link_how: "address" });
    // The coach with no address waits for a rosterer.
    const { matches } = await call<{ matches: { ref: string; why: string }[] }>(
      "outside.matches",
      { kind: "staff" },
      admin,
    );
    expect(matches).toEqual([expect.objectContaining({ ref: "fake-staff-3", why: "no_address" })]);
    const cls = await env.DB.prepare(
      "SELECT location_name FROM core_outside_class WHERE staff_ref = 'fake-staff-1' LIMIT 1",
    ).first<{ location_name: string }>();
    expect(cls?.location_name).toBe("Main room");
    const bookings = await env.DB.prepare("SELECT count(*) AS n FROM core_outside_booking").first<{
      n: number;
    }>();
    // Every booking of the 70 classes, but none of the suppressed ref's (an erased Person, above).
    const suppressed = data.bookings.filter((b) => b.person === "fake-person-002").length;
    expect(suppressed).toBeGreaterThan(0);
    expect(bookings?.n).toBe(280 - suppressed);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM core_allowance_use").first<{ n: number }>())
        ?.n,
    ).toBe(uses?.n);

    // A members list loaded next keeps someone booked in the timetable with no live membership.
    const plan2 = await planMembers(db.query, await readMembers(session), meta(admin.id));
    await db.batch(plan2.statements);
    expect(await outsidePerson("fake-person-005")).toMatchObject({ why_kept: "booked" });
  });

  it("loads a members list read from the file source the same way", async () => {
    const tag = unique("file");
    const load = loadFiles({
      site: { name: "Studio", timeZone: "Australia/Sydney" },
      people: {
        text: `Email,First,Last,Plan,Status,Phone\nfile1@${tag}.example.com,Ari,Sample,Monthly,Active,0400\nfile2@${tag}.example.com,Bo,Example,,,0401\n`,
        mapping: {
          columns: {
            email: "Email",
            givenName: "First",
            familyName: "Last",
            membershipType: "Plan",
            membershipStatus: "Status",
          },
          values: { membershipStatus: { Active: "live" } },
        },
      },
      now: NOW,
    });
    const session = directSession(new FileBookingSystem(load));
    const person = await createPerson(admin, [`file1@${tag}.example.com`]);
    const plan = await planMembers(
      db.query,
      await readMembers(session),
      meta(admin.id, { rows: 2 }),
    );
    await db.batch(plan.statements);
    expect(plan.counts).toMatchObject({ kept: 1, notKept: 1, linked: 1 });
    const row = await outsidePerson(`email:file1@${tag}.example.com`);
    expect(row).toMatchObject({ person_id: person, given_name: "Ari" });
    // A column the contract does not use (the phone) is never stored.
    expect(JSON.stringify(row)).not.toContain("0400");
  });

  it("keeps the copy out of query.sql", async () => {
    expect(
      (await refusal(call("query.sql", { sql: "SELECT * FROM core_outside_person" }, admin))).code,
    ).toBe("invalid_input");
  });

  // --- The review of PR #428. ------------------------------------------------------------------

  it("links an unlinked outside person when an import or a restore gives a Person their address", async () => {
    const { session, address } = freshFake();
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-011")).toMatchObject({ person_id: null });
    await call(
      "import.csv.commit",
      { object: "person", csv: `Name,Email\nLane Imported,${address(10)}\n` },
      admin,
    );
    const imported = (await outsidePerson("fake-person-011"))?.person_id as string;
    expect(imported).toMatch(/^per_/);
    expect(
      (await timeline("person", imported)).filter(
        (a) => a.subject === "Linked to the booking system's list",
      ),
    ).toHaveLength(1);

    // In the Trash the link by address is matched again at the next load; restored, it links.
    await call("person.delete", { id: imported }, admin);
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-011")).toMatchObject({ person_id: null });
    await call("person.restore", { id: imported }, admin);
    expect(await outsidePerson("fake-person-011")).toMatchObject({
      person_id: imported,
      link_how: "address",
    });
  });

  it("links nobody from a Person write while the copy is off", async () => {
    const { session, address } = freshFake();
    await loadMembers(session, admin.id);
    await call("outside.settings.update", { enabled: false }, admin);
    try {
      await createPerson(admin, [address(10)]);
      expect(await outsidePerson("fake-person-011")).toMatchObject({ person_id: null });
    } finally {
      await call("outside.settings.update", { enabled: true }, admin);
    }
  });

  it("keeps an unlinked person only while they count, and never links them by address again", async () => {
    const { fake, session, address } = freshFake();
    const harper = await createPerson(admin, [address(6)]);
    // No timetable from the tests before: being booked would keep them for another reason.
    await env.DB.prepare("DELETE FROM core_outside_booking").run();
    await loadMembers(session, admin.id);
    await call(
      "outside.unlink",
      { kind: "person", ref: "fake-person-007", why: "not ours" },
      admin,
    );
    // They stop counting: no row, no name, no address is kept for them.
    const pass = fake.state.memberships.find((m) => m.person === "fake-person-007");
    if (pass) pass.status = "ended";
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-007")).toBeNull();
    // They count again: kept, and staff's "nobody here" still holds.
    if (pass) pass.status = "live";
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-007")).toMatchObject({
      person_id: null,
      link_how: "staff",
      why_kept: "pass",
    });
    // Linking by hand clears the decision: the next load keeps the hand link.
    await call(
      "outside.link",
      { kind: "person", ref: "fake-person-007", personId: harper, why: "it is them" },
      admin,
    );
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-007")).toMatchObject({
      person_id: harper,
      link_how: "staff",
    });
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_outside_unlinked WHERE hash = ?",
    )
      .bind(await outsideRefHash(db.query, "person", "fake-person-007"))
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("drops a staff link to a Person in the Trash at the next load, and counts no link to one", async () => {
    const { session } = freshFake();
    const chosen = await createPerson(admin, [`${unique("q")}@example.com`]);
    await loadMembers(session, admin.id);
    await call(
      "outside.link",
      { kind: "person", ref: "fake-person-003", personId: chosen, why: "the same person" },
      admin,
    );
    const linked = await call<{ counts: { linked: number } }>("outside.status", {}, admin);
    await call("person.delete", { id: chosen }, admin);
    const after = await call<{ counts: { linked: number } }>("outside.status", {}, admin);
    expect(after.counts.linked).toBe(linked.counts.linked - 1);
    await loadMembers(session, admin.id);
    expect(await outsidePerson("fake-person-003")).toMatchObject({ person_id: null });
  });

  it("pages To match by kind and ref, so a person and a coach with one ref both show", async () => {
    await env.DB.batch(["DELETE FROM core_outside_match"].map((q) => env.DB.prepare(q)));
    await env.DB.batch(
      [
        ["person", "r1"],
        ["staff", "r1"],
        ["person", "r2"],
      ].map(([kind, ref]) =>
        env.DB.prepare(
          "INSERT INTO core_outside_match (kind, ref, why, candidates, created_at) VALUES (?, ?, 'no_address', '[]', ?)",
        ).bind(kind, ref, NOW),
      ),
    );
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page: { matches: { kind: string; ref: string }[]; next: string | null } = await call(
        "outside.matches",
        { limit: 1, ...(after ? { after } : {}) },
        admin,
      );
      seen.push(...page.matches.map((m) => `${m.kind}:${m.ref}`));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual(["person:r1", "person:r2", "staff:r1"]);
    await env.DB.prepare("DELETE FROM core_outside_match").run();
  });

  it("keeps no booking of an erased address named by a list with no ids", async () => {
    const erased = `${unique("gone")}@example.com`;
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(erased), NOW)
      .run();
    const cls = {
      ref: unique("cls"),
      classType: "t",
      title: "Class",
      startsAt: "2026-11-25T08:00:00.000Z",
      endsAt: "2026-11-25T09:00:00.000Z",
      location: null,
      staff: null,
      places: null,
      booked: 2,
      waiting: 0,
      cancelled: false,
      modifiedAt: null,
    };
    const plan = await planTimetable(
      db.query,
      {
        locations: [],
        classTypes: [{ ref: "t", name: "Type", description: null, active: true }],
        classes: [cls],
        bookings: [
          {
            ref: "b1",
            class: cls.ref,
            person: `email:${erased}`,
            state: "booked",
            modifiedAt: null,
          },
          {
            ref: "b2",
            class: cls.ref,
            person: "email:kept@example.com",
            state: "booked",
            modifiedAt: null,
          },
        ],
        staff: [],
      },
      meta(admin.id),
    );
    await db.batch(plan.statements);
    const rows = (
      await env.DB.prepare("SELECT person_ref FROM core_outside_booking").all<{
        person_ref: string;
      }>()
    ).results.map((r) => r.person_ref);
    expect(rows).toEqual(["email:kept@example.com"]);
  });

  it("judges a membership live by the business's day, not UTC's", async () => {
    const { fake, session } = freshFake();
    // Only fake-person-003's membership makes them a member; it ends on 23 November.
    fake.change("person", "fake-person-003", { memberStatus: "not_member" });
    const m = fake.state.memberships.find((x) => x.person === "fake-person-003");
    if (m) m.until = "2026-11-23";
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify("Australia/Sydney"))
      .run();
    try {
      // 21:00 UTC on the 23rd is 08:00 on the 24th in Sydney: the membership has ended there.
      const plan = await planMembers(db.query, await readMembers(session), {
        ...meta(admin.id),
        now: "2026-11-23T21:00:00.000Z",
        exportedOn: "2026-11-23",
      });
      await db.batch(plan.statements);
      expect(await outsidePerson("fake-person-003")).toBeNull();
    } finally {
      await env.DB.prepare("DELETE FROM core_settings WHERE key = 'org_timezone'").run();
    }
  });

  it("refuses a list too big for one batch before anything is written", async () => {
    const memberships = Array.from({ length: 95_000 }, (_, i) => ({
      ref: `big-${i}`,
      person: "big-person",
      type: "t",
      name: "Pass",
      kind: "pass" as const,
      status: "live" as const,
      from: null,
      until: null,
      usesTotal: null,
      usesLeft: null,
      renews: false,
    }));
    await expect(
      planMembers(
        db.query,
        {
          people: [
            {
              ref: "big-person",
              email: null,
              givenName: null,
              familyName: null,
              memberStatus: "member",
              active: true,
              modifiedAt: null,
            },
          ],
          membershipTypes: [],
          memberships,
        },
        meta(admin.id),
      ),
    ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "outside_list_too_big" } });
  });
});
