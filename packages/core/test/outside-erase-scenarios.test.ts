// Stage 65 step 10 (ADR 0926): the third review's scenarios (S1 to S18), each a real test of
// what an erase does to the booking system's copy, then at the next loads, and on consent.
// Against real D1.
import { env } from "cloudflare:workers";
import {
  directSession,
  FakeBookingSystem,
  fakeBookingSystemState,
} from "@composable-os/gatekeeper-booking-system";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type Actor, type InvocationContext, invokeByName } from "../src/index.ts";
import {
  type ListMeta,
  planMembers,
  planTimetable,
  readMembers,
  readTimetable,
} from "../src/outside/ingest.ts";
import { outsideAddressHash, outsideRefHash } from "../src/outside/match.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const NOW = "2026-11-24T09:00:00.000Z";
const WINDOW = { from: "2026-11-17T00:00:00.000Z", until: "2026-12-22T00:00:00.000Z" };

async function call<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  actor: Actor = "human",
  extra: Partial<InvocationContext> = {},
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
      ...extra,
    }),
  )) as T;
}

/**
 * A fake site of this test's own: every ref, address and name carries a tag, so a scan of every
 * table finds only what this test wrote.
 */
function freshFake() {
  const tag = unique("e").toLowerCase();
  const state = fakeBookingSystemState({ now: NOW, pageSize: 50 });
  const refOf = new Map<string, string>();
  for (const p of state.people) {
    const ref = `${tag}-${p.ref}`;
    refOf.set(p.ref, ref);
    p.ref = ref;
    if (p.email) p.email = p.email.replace("@example.com", `@${tag}.example.com`);
    p.givenName = `${p.givenName}${tag}`;
    p.familyName = `${p.familyName}${tag}`;
  }
  state.memberships.forEach((m, i) => {
    m.person = refOf.get(m.person) ?? m.person;
    m.ref = `${tag}-ms-${i}-x`;
  });
  const staffOf = new Map<string, string>();
  for (const s of state.staff) {
    const ref = `${tag}-${s.ref}`;
    staffOf.set(s.ref, ref);
    s.ref = ref;
    if (s.email) s.email = s.email.replace("@example.com", `@${tag}.example.com`);
    s.displayName = `${s.displayName}${tag}`;
  }
  const classOf = new Map<string, string>();
  for (const c of state.classes) {
    const ref = `${tag}-${c.ref}`;
    classOf.set(c.ref, ref);
    c.ref = ref;
    c.staff = c.staff === null ? null : (staffOf.get(c.staff) ?? c.staff);
  }
  for (const b of state.bookings) {
    b.ref = `${tag}-${b.ref}`;
    b.person = refOf.get(b.person) ?? b.person;
    b.class = classOf.get(b.class) ?? b.class;
  }
  const fake = new FakeBookingSystem(state);
  const ref = (n: number) => `${tag}-fake-person-${String(n).padStart(3, "0")}`;
  const person = (n: number) => state.people[n - 1] as (typeof state.people)[number];
  return { tag, fake, state, session: directSession(fake), ref, person };
}

const meta = (by: string): ListMeta => ({
  exportedOn: "2026-11-23",
  by,
  now: NOW,
  rows: 12,
  refused: 0,
});

async function loadMembers(fake: ReturnType<typeof freshFake>, by: string) {
  const plan = await planMembers(db.query, await readMembers(fake.session), meta(by));
  await db.batch(plan.statements);
  return plan;
}

async function loadTimetable(fake: ReturnType<typeof freshFake>, by: string) {
  const plan = await planTimetable(db.query, await readTimetable(fake.session, WINDOW), meta(by));
  await db.batch(plan.statements);
  return plan;
}

async function outsidePerson(ref: string) {
  return env.DB.prepare("SELECT * FROM core_outside_person WHERE ref = ?")
    .bind(ref)
    .first<Record<string, unknown>>();
}

async function count(sqlText: string, ...params: unknown[]) {
  return (
    (await env.DB.prepare(sqlText)
      .bind(...params)
      .first<{ n: number }>()) ?? { n: 0 }
  ).n;
}

async function createPerson(admin: ActingUser, emails: string[], name = unique("Member")) {
  const person = await call<{ id: string }>(
    "person.create",
    { displayName: name, emails: emails.map((email) => ({ email })) },
    admin,
  );
  return person.id;
}

async function personExists(id: string) {
  return (await count("SELECT count(*) AS n FROM core_person WHERE id = ?", id)) === 1;
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

type Fake = ReturnType<typeof freshFake>;

/** Every core_outside_* table (suppressions hold hashes only), any column, any case. */
async function scanOutside(needles: readonly string[]) {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_outside_%'",
  ).all<{ name: string }>();
  const hits: string[] = [];
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all<
      Record<string, unknown>
    >();
    for (const row of results) {
      const text = JSON.stringify(row).toLowerCase();
      for (const n of needles) if (text.includes(n.toLowerCase())) hits.push(`${name}:${n}`);
    }
  }
  return [...new Set(hits)];
}
const sup = async (kind: "ref" | "address", value: string, k: "person" | "staff" = "person") =>
  count(
    "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
    kind === "ref"
      ? await outsideRefHash(db.query, k, value)
      : await outsideAddressHash(db.query, value),
  );
const ms = (ref: string) =>
  count("SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?", ref);
const bk = (ref: string) =>
  count("SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?", ref);
const row = async (ref: string) => {
  const r = await outsidePerson(ref);
  return r ? { person_id: r.person_id, link_how: r.link_how, address: r.address } : null;
};
const staffRow = (ref: string) =>
  env.DB.prepare("SELECT ref, user_id, display_name, address FROM core_outside_staff WHERE ref = ?")
    .bind(ref)
    .first<Record<string, unknown>>();
const who = (f: Fake, n: number) => {
  const p = f.person(n);
  return [f.ref(n), p.givenName as string, ...(p.email ? [p.email] : [])];
};
const erase = (id: string) =>
  call<{ bookingSystem?: Record<string, unknown> }>("person.erase", { id }, admin);
const link = (ref: string, personId: string) =>
  call("outside.link", { kind: "person", ref, personId, why: "r508c" }, admin);
const allow = (email: string) =>
  call<Record<string, unknown>>("erasure.allowAddress", { email }, admin);

const taskTitle = async (id: string) =>
  (
    await env.DB.prepare("SELECT title FROM core_task WHERE id = ?")
      .bind(id)
      .first<{ title: string }>()
  )?.title;

async function familyMailbox(opts: {
  parentLinked: boolean;
  childLinked: boolean;
  childName?: (f: Fake) => string;
}) {
  const f = freshFake();
  f.fake.shareAddress(f.ref(3), f.ref(4));
  const shared = f.person(3).email as string;
  const kid = `kid.${f.tag}@else.example.com`;
  const parent = await createPerson(admin, [shared], `Parent ${f.tag}`);
  const child = await createPerson(
    admin,
    [kid],
    opts.childName ? opts.childName(f) : `Child ${f.tag}`,
  );
  const bystander = await createPerson(admin, [f.person(2).email as string]);
  await loadMembers(f, admin.id);
  await loadTimetable(f, admin.id);
  if (opts.parentLinked) await link(f.ref(3), parent);
  if (opts.childLinked) await link(f.ref(4), child);
  const task = await call<{ id: string }>(
    "task.create",
    {
      title: `Call ${f.person(4).givenName} about the pass`,
      links: [{ object: "person", id: child }],
    },
    admin,
  );
  return { f, shared, kid, parent, child, bystander, task: task.id };
}

describe("the third review's scenarios (r508c)", () => {
  it("S1 a member alone on their address; then an address change, a reused address, consent", async () => {
    const f = freshFake();
    const a = f.person(1).email as string;
    const p = await createPerson(admin, [a]);
    await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    const bystander = { ms: await ms(f.ref(2)), bk: await bk(f.ref(2)) };
    const out = await erase(p);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1 });
    expect(await scanOutside(who(f, 1))).toEqual([]);
    expect(await sup("ref", f.ref(1))).toBe(1);
    expect(await sup("address", a)).toBe(1);
    expect({ ms: await ms(f.ref(2)), bk: await bk(f.ref(2)) }).toEqual(bystander);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    expect(await scanOutside(who(f, 1))).toEqual([]);
    // The booking system changes their address (same ref), and gives the old one to a new ref.
    const moved = `moved.${f.tag}@else.example.com`;
    f.fake.change("person", f.ref(1), { email: moved });
    f.fake.change("person", f.ref(7), { email: a });
    const plan = await loadMembers(f, admin.id);
    expect(plan.counts.previouslyErased).toBe(1);
    expect(await scanOutside([...who(f, 1), moved])).toEqual([]);
    expect(await row(f.ref(7))).toBeNull();
    // Consent lets both back.
    expect(await allow(a)).toMatchObject({ bookingSystem: { addresses: 1, refs: 1, refsLeft: 0 } });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(1))).not.toBeNull();
    expect(await row(f.ref(7))).not.toBeNull();
  });

  it("S2a a family in To match on the parent's address, all unlinked: erase the parent, then the child", async () => {
    const x = await familyMailbox({ parentLinked: false, childLinked: false });
    const { f } = x;
    const out = await erase(x.parent);
    expect(out.bookingSystem).toMatchObject({ deletedUnlinked: 2 });
    expect(await scanOutside(who(f, 3))).toEqual([]);
    expect(await scanOutside(who(f, 4).slice(0, 2))).toEqual([]);
    expect(await sup("address", x.shared)).toBe(1);
    expect(await sup("ref", f.ref(3))).toBe(0);
    expect(await sup("ref", f.ref(4))).toBe(0);
    expect(await taskTitle(x.task)).toBe(`Call ${f.person(4).givenName} about the pass`);
    await loadMembers(f, admin.id);
    expect(await row(f.ref(3))).toBeNull();
    expect(await row(f.ref(4))).toBeNull();
    const second = await erase(x.child);
    expect(second.bookingSystem).toMatchObject({ deletedLinked: 0, deletedUnlinked: 0 });
    expect(await row(f.ref(2))).toMatchObject({ person_id: x.bystander });
  });

  it("S2b the same family, the child erased first: their row cannot be told from a namesake, and staff are told", async () => {
    const x = await familyMailbox({
      parentLinked: false,
      childLinked: false,
      // The child's record carries the name the booking system lists for them.
      childName: (f) => `${f.person(4).givenName} ${f.person(4).familyName}`,
    });
    const { f } = x;
    const out = await erase(x.child);
    // The child's own row on the parent's address stays, and the block says so.
    expect(out.bookingSystem).toMatchObject({ deletedUnlinked: 0, keptNamedElsewhere: 1 });
    expect(await row(f.ref(4))).not.toBeNull();
    // Erasing the parent then removes both (rule A.2).
    await erase(x.parent);
    expect(await scanOutside([...who(f, 3), ...who(f, 4).slice(0, 2)])).toEqual([]);
  });

  it("S3 parent and child staff-linked, the child on the parent's address: erase the parent, two loads, then the parent's consent", async () => {
    const x = await familyMailbox({ parentLinked: true, childLinked: true });
    const { f } = x;
    const out = await erase(x.parent);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, keptLinkedToOthers: 1 });
    expect(await scanOutside(who(f, 3).slice(0, 2))).toEqual([]);
    expect(await sup("ref", f.ref(3))).toBe(1);
    expect(await sup("address", x.shared)).toBe(0);
    expect(await taskTitle(x.task)).toBe(`Call ${f.person(4).givenName} about the pass`);
    // SF2: the child's staff link wins over the erased-address list, load after load.
    for (const load of [1, 2]) {
      await loadMembers(f, admin.id);
      expect(await row(f.ref(4)), `load ${load}`).toMatchObject({
        person_id: x.child,
        link_how: "staff",
      });
    }
    // SF1: the parent's consent finds their erase although the address was shared, and lifts
    // their ref.
    expect(await allow(x.shared)).toMatchObject({
      bookingSystem: { addresses: 0, refs: 1, refsLeft: 0 },
    });
    expect(await sup("ref", f.ref(3))).toBe(0);
    await createPerson(admin, [x.shared], `Parent back ${f.tag}`);
    const plan = await loadMembers(f, admin.id);
    expect(plan.counts.previouslyErased).toBe(0);
    expect(await row(f.ref(3))).not.toBeNull();
    expect(await row(f.ref(4))).toMatchObject({ person_id: x.child, link_how: "staff" });
  });

  it("S4 the parent staff-linked, the child unlinked on the parent's address: erase the parent", async () => {
    const x = await familyMailbox({ parentLinked: true, childLinked: false });
    const { f } = x;
    const out = await erase(x.parent);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, deletedUnlinked: 1 });
    expect(await row(f.ref(4))).toBeNull();
    expect(await sup("ref", f.ref(4))).toBe(0);
    expect(await personExists(x.child)).toBe(true);
    await loadMembers(f, admin.id);
    expect(await row(f.ref(4))).toBeNull();
    f.fake.change("person", f.ref(4), { email: x.kid });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(4))).toMatchObject({ person_id: x.child, link_how: "address" });
  });

  it("S5 a husband staff-linked under his wife's address", async () => {
    const f = freshFake();
    const b = f.person(3).email as string;
    const wife = await createPerson(admin, [b], `Wife ${f.tag}`);
    const hAddr = `h.${f.tag}@else.example.com`;
    const husband = await createPerson(admin, [hAddr], `Husband ${f.tag}`);
    await loadMembers(f, admin.id);
    await link(f.ref(3), husband);
    const out = await erase(husband);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, sharedAddresses: 1 });
    expect(await scanOutside([f.ref(3), f.person(3).givenName as string, hAddr])).toEqual([]);
    expect(await sup("address", b)).toBe(0);
    f.fake.change("person", f.ref(7), { email: b });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(7))).toMatchObject({ person_id: wife, link_how: "address" });
  });

  it("S6 three people on one address only P holds", async () => {
    const f = freshFake();
    f.fake.shareAddress(f.ref(1), f.ref(3));
    f.fake.shareAddress(f.ref(1), f.ref(4));
    const p = await createPerson(admin, [f.person(1).email as string]);
    const by = await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    const out = await erase(p);
    expect(out.bookingSystem).toMatchObject({ deletedUnlinked: 3 });
    expect(
      await scanOutside([...who(f, 1), ...who(f, 3).slice(0, 2), ...who(f, 4).slice(0, 2)]),
    ).toEqual([]);
    expect(await row(f.ref(2))).toMatchObject({ person_id: by });
  });

  it("S7 a coach who is also a member: the next timetable load, then the coach's address changes", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    const sref = `${f.tag}-fake-staff-1`;
    f.fake.change("staff", sref, { email: coachAddr });
    f.fake.change("person", f.ref(1), { email: coachAddr });
    const name = f.state.staff[0]?.displayName as string;
    for (const c of f.state.classes) if (c.staff === sref) c.title = `Strength with ${name}`;
    const p = await createPerson(admin, [coachAddr]);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    const out = await erase(p);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, coaches: 1 });
    expect(await scanOutside([...who(f, 1), sref, name, coachAddr])).toEqual([]);
    // SF5: the coach's ref is suppressed (no one else holds the address).
    expect(await sup("ref", sref, "staff")).toBe(1);
    // SF3: the next timetable load scrubs their name from the titles it brings.
    await loadMembers(f, admin.id);
    const plan = await loadTimetable(f, admin.id);
    expect(plan.counts.items.textScrubbed).toBeGreaterThan(0);
    expect(await scanOutside([...who(f, 1), sref, name, coachAddr])).toEqual([]);
    // The booking system changes the coach's address: still dropped, by the ref.
    const coach2 = `coach2.${f.tag}@else.example.com`;
    f.fake.change("staff", sref, { email: coach2 });
    f.fake.change("person", f.ref(1), { email: coach2 });
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    expect(await scanOutside([...who(f, 1).slice(0, 2), sref, name, coach2])).toEqual([]);
    expect(await staffRow(sref)).toBeNull();
  });

  it("S8 a staff account sharing an address with a member: erase the member, two timetable loads", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    const sref = `${f.tag}-fake-staff-1`;
    f.fake.change("staff", sref, { email: coachAddr });
    const staff = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?")
      .bind(coachAddr, staff.id)
      .run();
    const member = await createPerson(admin, [coachAddr]);
    await loadTimetable(f, admin.id);
    const classesWithCoach = () =>
      count("SELECT count(*) AS n FROM core_outside_class WHERE staff_ref = ?", sref);
    const before = await classesWithCoach();
    expect(before).toBeGreaterThan(0);
    const out = await erase(member);
    expect(out.bookingSystem).toMatchObject({ keptLinkedToOthers: 1, coaches: 0 });
    // SF2: the coach linked to an active staff account stays, load after load, with its classes.
    for (const load of [1, 2]) {
      await loadTimetable(f, admin.id);
      expect(await staffRow(sref), `load ${load}`).toMatchObject({ user_id: staff.id });
      expect(await classesWithCoach(), `load ${load}`).toBe(before);
    }
  });

  it("S9 duplicates of one human under two refs on P's address; P's own name in a title; then a duplicate's address changes", async () => {
    const f = freshFake();
    f.fake.shareAddress(f.ref(3), f.ref(4));
    f.fake.change("person", f.ref(4), {
      givenName: f.person(3).givenName,
      familyName: f.person(3).familyName,
    });
    const a = f.person(3).email as string;
    const fullName = `${f.person(3).givenName} ${f.person(3).familyName}`;
    for (const c of f.state.classes) c.title = `PT with ${fullName}`;
    // P's own record carries the name the booking system lists.
    const p = await createPerson(admin, [a], fullName);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    const out = await erase(p);
    expect(out.bookingSystem).toMatchObject({ deletedUnlinked: 2 });
    expect((out.bookingSystem as { textScrubbed: number }).textScrubbed).toBeGreaterThan(0);
    expect(await scanOutside([...who(f, 3), f.ref(4), fullName])).toEqual([]);
    // A.2 rows' refs are not suppressed (either may be a family member's): if the booking system
    // gives one another address, it comes back, as ADR 0926 and the result's description say.
    expect(await sup("ref", f.ref(3))).toBe(0);
    expect(await sup("ref", f.ref(4))).toBe(0);
    f.fake.change("person", f.ref(4), { email: `dup.${f.tag}@else.example.com` });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(4))).not.toBeNull();
  });

  it("S10 a row waiting as several_people on P's address: kept at the erase, dropped by the next load", async () => {
    const f = freshFake();
    const x = f.person(1).email as string;
    const [local, domain] = x.split("@") as [string, string];
    const p = await createPerson(admin, [x]);
    const q = await createPerson(admin, [`${local}+q@${domain}`]);
    await loadMembers(f, admin.id);
    const out = await erase(p);
    expect(out.bookingSystem).toMatchObject({ keptWaiting: 1 });
    expect(await row(f.ref(1))).not.toBeNull();
    await loadMembers(f, admin.id);
    expect(await row(f.ref(1))).toBeNull();
    expect(await personExists(q)).toBe(true);
  });

  it("S11 an erase with no list current, then a first load", async () => {
    await call("outside.lists.remove", { kind: "all" }, admin);
    const f = freshFake();
    const a = f.person(1).email as string;
    const p = await createPerson(admin, [a]);
    const out = await erase(p);
    expect(out.bookingSystem).toBeUndefined();
    expect(await sup("address", a)).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed_erase WHERE hash = ?",
        await outsideAddressHash(db.query, a),
      ),
    ).toBe(1);
    await loadMembers(f, admin.id);
    expect(await row(f.ref(1))).toBeNull();
  });

  async function twoOnOneMailbox() {
    const f = freshFake();
    f.fake.shareAddress(f.ref(3), f.ref(4));
    const m = f.person(3).email as string;
    const pp = await createPerson(admin, [`p.${f.tag}@else.example.com`]);
    const qq = await createPerson(admin, [`q.${f.tag}@else.example.com`]);
    await loadMembers(f, admin.id);
    await link(f.ref(3), pp);
    await link(f.ref(4), qq);
    await erase(pp);
    // P's erase left the mailbox (Q's kept row lists it); Q's erase suppressed it.
    expect(await sup("address", m)).toBe(0);
    await erase(qq);
    expect(await sup("address", m)).toBe(1);
    return { f, m };
  }

  it("S15 two erased people on a mailbox only the copy held: P's consent lifts nothing of Q's", async () => {
    const { f, m } = await twoOnOneMailbox();
    expect(await allow(m)).toMatchObject({
      removed: false,
      bookingSystem: { addresses: 0, refs: 0, refsLeft: 2 },
    });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(4))).toBeNull();
    expect(await scanOutside(who(f, 4).slice(0, 2))).toEqual([]);
    expect(await row(f.ref(3))).toBeNull();
  });

  it("S15 mirror: Q's consent lifts nothing of P's", async () => {
    const { f, m } = await twoOnOneMailbox();
    expect(await allow(m)).toMatchObject({ bookingSystem: { refs: 0, refsLeft: 2 } });
    await loadMembers(f, admin.id);
    expect(await row(f.ref(3))).toBeNull();
    expect(await sup("ref", f.ref(3))).toBe(1);
    expect(await sup("ref", f.ref(4))).toBe(1);
  });

  it("S16 a merge before an erase, and an erase before a merge", async () => {
    const f = freshFake();
    const p1 = await createPerson(admin, [f.person(1).email as string]);
    const p2 = await createPerson(admin, [f.person(2).email as string]);
    const p3 = await createPerson(admin, [f.person(3).email as string]);
    const p4 = await createPerson(admin, [f.person(4).email as string]);
    await loadMembers(f, admin.id);
    await call("person.merge", { survivorId: p1, mergedId: p2 }, admin);
    const out = await erase(p1);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 2 });
    expect(await scanOutside([...who(f, 1), ...who(f, 2)])).toEqual([]);
    await erase(p3);
    await expect(call("person.merge", { survivorId: p4, mergedId: p3 }, admin)).rejects.toThrow();
    await loadMembers(f, admin.id);
    expect(await scanOutside([...who(f, 1), ...who(f, 2), ...who(f, 3)])).toEqual([]);
  });

  it("S17 a removal of the list before an erase, and after one", async () => {
    const f = freshFake();
    const p = await createPerson(admin, [f.person(1).email as string]);
    const q = await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    await call("outside.lists.remove", { kind: "all" }, admin);
    const out = await erase(p);
    expect(out.bookingSystem).toBeUndefined();
    expect(await sup("address", f.person(1).email as string)).toBe(1);
    await loadMembers(f, admin.id);
    expect(await row(f.ref(1))).toBeNull();
    await erase(q);
    await call("outside.lists.remove", { kind: "all" }, admin);
    await loadMembers(f, admin.id);
    expect(await row(f.ref(2))).toBeNull();
  });

  it("S18 the name scrub: accented capitals, upper case, NFD, a curly apostrophe; a hyphenated living name kept", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    const sref = `${f.tag}-fake-staff-1`;
    const name = `Émile Zolä${f.tag}`;
    f.fake.change("staff", sref, { email: coachAddr, displayName: name });
    const titles = [
      `Strength with ${name}`,
      `STRENGTH WITH ${name.toUpperCase()}`,
      `Yoga with ${name}-Jones`,
      `Run with ${name}’s crew`,
      `Swim with ${name.normalize("NFD")}`,
    ];
    let i = 0;
    for (const c of f.state.classes) c.title = titles[i++ % titles.length] as string;
    const p = await createPerson(admin, [coachAddr]);
    await loadTimetable(f, admin.id);
    const out = await erase(p);
    expect((out.bookingSystem as { textScrubbed: number }).textScrubbed).toBeGreaterThan(0);
    const titlesOf = async (tag: string) =>
      new Set(
        (
          await env.DB.prepare("SELECT DISTINCT title FROM core_outside_class WHERE ref LIKE ?")
            .bind(`${tag}-%`)
            .all<{ title: string }>()
        ).results.map((r) => r.title),
      );
    expect(await titlesOf(f.tag)).toEqual(
      new Set([
        "Strength with [erased]",
        "STRENGTH WITH [erased]",
        `Yoga with ${name}-Jones`,
        "Run with [erased]’s crew",
        "Swim with [erased]",
      ]),
    );
    // A plain ASCII name with a straight apostrophe; another person's surname alone and a
    // hyphenated living name are kept.
    const g = freshFake();
    const addr2 = `coach.${g.tag}@else.example.com`;
    const sref2 = `${g.tag}-fake-staff-1`;
    const ascii = `Oliver O'Brien${g.tag}`;
    g.fake.change("staff", sref2, { email: addr2, displayName: ascii });
    const surname = ascii.split(" ")[1] as string;
    const t2 = [
      `Box with ${ascii}`,
      `Box with Mary ${surname}`,
      `Box with ${ascii}-Smith`,
      // The booking system wrote the apostrophe curly.
      `Row with ${ascii.replace("'", "’")}`,
    ];
    i = 0;
    for (const c of g.state.classes) c.title = t2[i++ % t2.length] as string;
    const p2 = await createPerson(admin, [addr2]);
    await loadTimetable(g, admin.id);
    await erase(p2);
    expect(await titlesOf(g.tag)).toEqual(
      new Set([
        "Box with [erased]",
        `Box with Mary ${surname}`,
        `Box with ${ascii}-Smith`,
        "Row with [erased]",
      ]),
    );
  });
});
