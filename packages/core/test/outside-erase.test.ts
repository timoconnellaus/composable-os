// Stage 65 step 10 (ADR 0926): erase, merge, purge and removal reaching the booking system's copy.
// A Person with a full outside copy (linked by address and by staff, a coach with their address,
// an outside person on their address waiting in To match, a candidate in someone else's match,
// memberships, passes, bookings) is erased, and then nothing of theirs is readable anywhere, in D1
// or blob storage, while a bystander's copy is untouched; no later load, link by address or link by
// hand brings them back, by ref or by address. Merge moves links without losing, doubling or
// misattaching one; removal is a person's with bookingSystem:manage, never an AI's. Against real D1.
import { env } from "cloudflare:workers";
import {
  directSession,
  FakeBookingSystem,
  fakeBookingSystemState,
} from "@composable-os/gatekeeper-booking-system";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  type BlobStore,
  type InvocationContext,
  invokeByName,
} from "../src/index.ts";
import {
  type ListMeta,
  planMembers,
  planTimetable,
  readMembers,
  readTimetable,
} from "../src/outside/ingest.ts";
import { outsideAddressHash, outsideRefHash } from "../src/outside/match.ts";
import { context, createUser, db, setPreset, timeline, unique } from "./helpers.ts";

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

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

/** R2 in memory. */
function memoryBlobs(): BlobStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (keys) => {
      for (const k of keys) map.delete(k);
    },
    list: async (prefix) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)) }),
  };
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

/** Every row of every table, as text, that contains one of `needles` (case-insensitive). */
async function findAnywhere(needles: readonly string[]) {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'core_search%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  const hits: { table: string; needle: string; row: string }[] = [];
  const lower = needles.map((n) => n.toLowerCase());
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all<
      Record<string, unknown>
    >();
    for (const raw of results) {
      // The audit columns ADR 0019 keeps (which record a row was about) and the erase's own row.
      let row: Record<string, unknown> | null = raw;
      if (name === "core_audit_changes" || name === "core_audit_redactions") {
        const { record_id: _kept, ...rest } = raw;
        row = rest;
      }
      if (name === "core_audit" && String(raw.operation).endsWith(".erase")) row = null;
      if (!row) continue;
      const text = JSON.stringify(row).toLowerCase();
      for (const needle of lower) {
        if (text.includes(needle)) hits.push({ table: name, needle, row: text.slice(0, 300) });
      }
    }
  }
  return hits;
}

/**
 * The three tables an outside person's data is in, scanned row by row (every column, any case)
 * for any of `needles`: what is left of them in the copy, without waiting for a load.
 */
async function scanCopy(needles: readonly string[]) {
  const hits: { table: string; needle: string }[] = [];
  for (const table of ["core_outside_person", "core_outside_membership", "core_outside_match"]) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all<
      Record<string, unknown>
    >();
    for (const row of results) {
      const text = JSON.stringify(row).toLowerCase();
      for (const needle of needles) {
        if (text.includes(needle.toLowerCase())) hits.push({ table, needle });
      }
    }
  }
  return hits;
}

async function personExists(id: string) {
  return (await count("SELECT count(*) AS n FROM core_person WHERE id = ?", id)) === 1;
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

describe("erase reaches the booking system's copy", () => {
  const f = freshFake();
  let erased: string;
  let bystander: string;
  let other: string;
  let otherToo: string;
  const own = f.person(1).email as string;
  const listed = f.person(3).email as string;
  const theirs = {
    // Linked by address: their own address.
    own: () => own,
    // Linked by staff: an address the booking system has for them that no Person here holds.
    listed: () => listed,
    // A third address of theirs, the only one the booking system lists for Lane (011).
    third: `third.${unique("x")}@${f.tag}.example.com`,
  };

  it("leaves nothing of theirs anywhere, and a bystander's copy untouched", async () => {
    const blobs = memoryBlobs();
    const [local4, domain4] = (f.person(4).email as string).split("@") as [string, string];
    const [local3, domain3] = theirs.third.split("@") as [string, string];
    // Lane (011) is listed with their third address, which someone else also holds folded: Lane
    // waits in To match, linked to nobody, and may be the other Person's: Lane stays (rule A.2).
    f.fake.change("person", f.ref(11), { email: theirs.third });
    // A coach in the timetable has their own address.
    f.fake.change("staff", `${f.tag}-fake-staff-1`, { email: theirs.own() });
    erased = await createPerson(
      admin,
      [theirs.own(), `${local4}+them@${domain4}`, theirs.third],
      `Erased ${f.tag}`,
    );
    bystander = await createPerson(admin, [f.person(2).email as string], `Bystander ${f.tag}`);
    // Devon (004) waits for staff between the erased Person and another (one folded address).
    other = await createPerson(admin, [f.person(4).email as string]);
    otherToo = await createPerson(admin, [`${local3}+other@${domain3}`]);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    await call(
      "outside.link",
      { kind: "person", ref: f.ref(3), personId: erased, why: "the same person, another address" },
      admin,
    );
    // A task that names the booking system's address for them, about the bystander. (An outside
    // ref typed into free text is not scrubbed: a booking system's ids collide with ordinary text.)
    await call(
      "task.create",
      {
        title: "Booking system follow up",
        notes: `Check ${theirs.listed()} against the list`,
        links: [{ object: "person", id: bystander }],
      },
      admin,
    );

    // The copy before: theirs and the bystander's.
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: erased, link_how: "address" });
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: erased, link_how: "staff" });
    expect(await outsidePerson(f.ref(11))).toMatchObject({ person_id: null });
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
    const devon = await env.DB.prepare(
      "SELECT candidates FROM core_outside_match WHERE kind = 'person' AND ref = ?",
    )
      .bind(f.ref(4))
      .first<{ candidates: string }>();
    expect(JSON.parse(devon?.candidates ?? "[]").sort()).toEqual([erased, other].sort());
    const bookingsOf = (ref: string) =>
      count("SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?", ref);
    expect(await bookingsOf(f.ref(1))).toBeGreaterThan(0);
    const bystanderBookings = await bookingsOf(f.ref(2));
    expect(bystanderBookings).toBeGreaterThan(0);
    const bystanderMemberships = await count(
      "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?",
      f.ref(2),
    );
    expect(bystanderMemberships).toBe(1);

    const result = await call<Record<string, unknown>>(
      "person.erase",
      { id: erased },
      admin,
      "human",
      {
        blobs,
      },
    );
    expect(result.bookingSystem).toEqual({
      deletedLinked: 2,
      deletedUnlinked: 0,
      coaches: 1,
      keptLinkedToOthers: 0,
      // Lane and Devon: another Person holds their address (folded).
      keptWaiting: 2,
      keptNamedElsewhere: 0,
      // Their plus-tag and third addresses, which others hold folded.
      sharedAddresses: 2,
      textScrubbed: 0,
      copyRemains: true,
      note: expect.stringContaining("A copy remains in the booking system"),
    });

    // Nothing of theirs, anywhere: ids, addresses, outside refs, names as listed.
    const needles = [
      erased,
      theirs.own(),
      theirs.listed(),
      `${local4}+them@${domain4}`,
      f.ref(1),
      f.ref(3),
      `${f.tag}-fake-staff-1`,
      f.person(1).givenName as string,
      f.person(3).givenName as string,
      `Riley Coach${f.tag}`,
    ];
    expect(await findAnywhere(needles)).toEqual([]);
    // Nor in blob storage: the erase log holds only hashes.
    for (const [, text] of blobs.map) {
      for (const needle of needles) expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
    }

    // The bystander's copy is untouched; Devon waits for the other Person alone.
    expect(await outsidePerson(f.ref(2))).toMatchObject({
      person_id: bystander,
      link_how: "address",
      address: f.person(2).email,
    });
    expect(await bookingsOf(f.ref(2))).toBe(bystanderBookings);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?",
        f.ref(2),
      ),
    ).toBe(bystanderMemberships);
    const devonAfter = await env.DB.prepare(
      "SELECT candidates FROM core_outside_match WHERE kind = 'person' AND ref = ?",
    )
      .bind(f.ref(4))
      .first<{ candidates: string }>();
    expect(JSON.parse(devonAfter?.candidates ?? "[]")).toEqual([other]);
    // Lane may be the other Person's: kept, waiting, with their address and name as listed.
    expect(await outsidePerson(f.ref(11))).toMatchObject({
      person_id: null,
      address: theirs.third,
    });
    // Their coach's classes name no coach; the other coach's still do.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE staff_ref = ?",
        `${f.tag}-fake-staff-2`,
      ),
    ).toBeGreaterThan(0);
    // What is kept is hashes only, keyed (not a plain digest of the ref or the address).
    const kept = (
      await env.DB.prepare("SELECT hash, kind FROM core_outside_suppressed").all<{
        hash: string;
        kind: string;
      }>()
    ).results;
    for (const [kind, hash] of [
      ["ref", await outsideRefHash(db.query, "person", f.ref(1))],
      ["ref", await outsideRefHash(db.query, "person", f.ref(3))],
      ["address", await outsideAddressHash(db.query, theirs.listed())],
      ["address", await outsideAddressHash(db.query, theirs.own())],
    ] as const) {
      expect(kept).toContainEqual({ hash, kind });
    }
    const plain = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.ref(1)));
    const plainHex = [...new Uint8Array(plain)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(kept.map((k) => k.hash).join(" ")).not.toContain(plainHex);
  });

  it("brings none of them back: not by a load, a link by address or a link by hand", async () => {
    const members = await loadMembers(f, admin.id);
    expect(members.counts.dropped).toBe(3);
    await loadTimetable(f, admin.id);
    for (const ref of [f.ref(1), f.ref(3), f.ref(11)]) expect(await outsidePerson(ref)).toBeNull();
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_booking WHERE person_ref IN (?, ?)",
        f.ref(1),
        f.ref(3),
      ),
    ).toBe(0);
    // Lane's bookings name only Lane's ref, which may be the other Person's: kept (rule A.2).
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_staff WHERE ref = ?",
        `${f.tag}-fake-staff-1`,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE staff_ref = ?",
        `${f.tag}-fake-staff-1`,
      ),
    ).toBe(0);
    // Devon now has one Person with the address: linked to them.
    expect(await outsidePerson(f.ref(4))).toMatchObject({ person_id: other, link_how: "address" });
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });

    // Someone signs up with the address the booking system listed for them: nothing links.
    const newcomer = await createPerson(admin, [theirs.listed()]);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE person_id = ?", newcomer),
    ).toBe(0);

    // A person links by hand: a row of theirs, however it came to be there, is never linked.
    const list = await env.DB.prepare(
      "SELECT id FROM core_outside_list WHERE kind = 'members' AND state = 'current'",
    ).first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO core_outside_person (ref, list_id, address, address_folded, member_status, active, why_kept) VALUES (?, ?, NULL, NULL, 'member', 1, 'member'), (?, ?, ?, ?, 'member', 1, 'member')",
    )
      .bind(f.ref(1), list?.id, `${f.tag}-hand`, list?.id, theirs.listed(), theirs.listed())
      .run();
    for (const ref of [f.ref(1), `${f.tag}-hand`]) {
      const out = await refusal(
        call(
          "outside.link",
          { kind: "person", ref, personId: newcomer, why: "looks like them" },
          admin,
        ),
      );
      expect(out, ref).toMatchObject({ code: "invalid_input" });
      expect(out.details?.rule, ref).toBe("outside_erased");
    }
    await env.DB.prepare("DELETE FROM core_outside_person WHERE ref IN (?, ?)")
      .bind(f.ref(1), `${f.tag}-hand`)
      .run();
  });

  it("holds at its limits: a changed address under the same ref, the same address under a new ref", async () => {
    // The booking system changes their address, same ref: dropped by the ref.
    f.fake.change("person", f.ref(1), { email: `moved.${unique("m")}@${f.tag}.example.com` });
    // The same address the booking system listed for them, under a new ref: dropped by the address
    // (it is on no erased-address list; only the copy's suppression knows it).
    const live = (ref: string, type: string) => ({
      ref: `${ref}-m`,
      person: ref,
      type,
      name: "Unlimited monthly",
      kind: "membership" as const,
      status: "live" as const,
      from: "2026-01-01",
      until: null,
      usesTotal: null,
      usesLeft: null,
      renews: true,
    });
    for (const [ref, email] of [
      [`${f.tag}-new-a`, theirs.listed()],
      [`${f.tag}-new-b`, theirs.own().toUpperCase()],
    ] as const) {
      f.state.people.push({
        ref,
        email,
        givenName: "New",
        familyName: "Ref",
        memberStatus: "member",
        active: true,
        modifiedAt: NOW,
      });
      f.state.memberships.push(live(ref, "fake-type-unlimited"));
    }
    const plan = await loadMembers(f, admin.id);
    expect(plan.counts.dropped).toBe(5);
    for (const ref of [f.ref(1), `${f.tag}-new-a`, `${f.tag}-new-b`]) {
      expect(await outsidePerson(ref), ref).toBeNull();
    }
    // Staff are told how many were dropped by a ref an erase suppressed (Lane by the address).
    expect(plan.counts.previouslyErased).toBe(2);
    // Someone else entirely is kept as before.
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
    expect(otherToo).toBeTruthy();
  });

  it("lets a person lift a ref suppression by hand (the booking system gave the ref to someone new), never an AI", async () => {
    const input = { kind: "person", ref: f.ref(1), why: "the booking system reused the id" };
    for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
      expect((await refusal(call("outside.suppression.lift", input, admin, actor))).code).toBe(
        "forbidden",
      );
    }
    const member = await createUser("member");
    expect((await refusal(call("outside.suppression.lift", input, member))).code).toBe("forbidden");
    // bookingSystem:manage alone is not enough: it undoes an erase's protection (records:erase).
    const manager = await createUser("member");
    await call(
      "user.setPermissions",
      { id: manager.id, permissions: ["bookingSystem:manage"] },
      admin,
    );
    expect(await refusal(call("outside.suppression.lift", input, manager))).toMatchObject({
      code: "forbidden",
      details: { permission: "records:erase" },
    });
    expect(await call("outside.suppression.lift", input, admin)).toEqual({ lifted: true });
    const plan = await loadMembers(f, admin.id);
    expect(plan.counts.previouslyErased).toBe(1);
    // Ref 1 now lists an address of nobody erased: kept, as anyone.
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: null });
    expect(await call("outside.suppression.lift", input, admin)).toEqual({ lifted: false });
  });
});

describe("a family on the erased Person's own address", () => {
  /** A parent (ref 3) and a child (ref 4) the booking system lists on the parent's address. */
  async function family(link: { parent: boolean; child: boolean }) {
    const f = freshFake();
    f.fake.shareAddress(f.ref(3), f.ref(4));
    const shared = f.person(3).email as string;
    const kidAddress = `kid.${f.tag}@else.example.com`;
    const parent = await createPerson(admin, [shared], `Parent ${f.tag}`);
    const child = await createPerson(admin, [kidAddress], `Child ${f.tag}`);
    await loadMembers(f, admin.id);
    if (link.parent) {
      await call(
        "outside.link",
        { kind: "person", ref: f.ref(3), personId: parent, why: "the parent" },
        admin,
      );
    }
    if (link.child) {
      await call(
        "outside.link",
        { kind: "person", ref: f.ref(4), personId: child, why: "the child" },
        admin,
      );
    }
    // A booking named by the shared address, as a list with no ids names a person.
    const list = await env.DB.prepare(
      "SELECT id FROM core_outside_list WHERE kind = 'members' AND state = 'current'",
    ).first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO core_outside_booking (ref, list_id, class_ref, person_ref, state) VALUES (?, ?, 'c', ?, 'booked')",
    )
      .bind(`${f.tag}-shared-booking`, list?.id, `email:${shared}`)
      .run();
    const task = await call<{ id: string }>(
      "task.create",
      {
        title: `About ${f.person(4).givenName} ${f.ref(4)}`,
        links: [{ object: "person", id: child }],
      },
      admin,
    );
    return { f, shared, kidAddress, parent, child, task: task.id };
  }
  const suppressedRef = async (ref: string) =>
    count(
      "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
      await outsideRefHash(db.query, "person", ref),
    );
  const taskTitle = async (id: string) =>
    (
      await env.DB.prepare("SELECT title FROM core_task WHERE id = ?").bind(id).first<{
        title: string;
      }>()
    )?.title;

  it("erasing the parent leaves the child's row, memberships, ref and bookings alone", async () => {
    const { f, shared, kidAddress, parent, child, task } = await family({
      parent: true,
      child: true,
    });
    const memberships = await count(
      "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?",
      f.ref(4),
    );
    const before = await taskTitle(task);
    const out = await call<Record<string, unknown>>("person.erase", { id: parent }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1 });
    expect(await outsidePerson(f.ref(3))).toBeNull();
    expect(await suppressedRef(f.ref(3))).toBe(1);
    // The child's: untouched, not suppressed, not blanked anywhere.
    expect(await outsidePerson(f.ref(4))).toMatchObject({ person_id: child, link_how: "staff" });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?",
        f.ref(4),
      ),
    ).toBe(memberships);
    expect(await suppressedRef(f.ref(4))).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
        await outsideAddressHash(db.query, shared),
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_booking WHERE ref = ?",
        `${f.tag}-shared-booking`,
      ),
    ).toBe(1);
    expect(await taskTitle(task)).toBe(before);
    // SF2: the child's staff link to their own Person wins over the parent's address on the
    // erased-address list, at the next load and the one after (keptByLink, the erase's rule too).
    for (const load of [1, 2]) {
      await loadMembers(f, admin.id);
      expect(await outsidePerson(f.ref(4)), `load ${load}`).toMatchObject({
        person_id: child,
        link_how: "staff",
      });
    }
    // Once the booking system gives the child their own address, the staff link still holds.
    f.fake.change("person", f.ref(4), { email: kidAddress });
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(4))).toMatchObject({ person_id: child, link_how: "staff" });
  });

  it("erasing the child leaves the parent's row, and the shared address unsuppressed", async () => {
    const { f, shared, parent, child, task } = await family({ parent: true, child: true });
    const out = await call<Record<string, unknown>>("person.erase", { id: child }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1 });
    expect(await outsidePerson(f.ref(4))).toBeNull();
    expect(await suppressedRef(f.ref(4))).toBe(1);
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: parent });
    expect(await suppressedRef(f.ref(3))).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
        await outsideAddressHash(db.query, shared),
      ),
    ).toBe(0);
    expect(await taskTitle(task)).toBeUndefined();
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: parent });
    expect(await outsidePerson(f.ref(4))).toBeNull();
  });

  it("deletes a row on their own address linked to nobody, and suppresses no ref of it", async () => {
    const { f, shared, parent, child } = await family({ parent: true, child: false });
    const out = await call<Record<string, unknown>>("person.erase", { id: parent }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, deletedUnlinked: 1 });
    expect(await outsidePerson(f.ref(4))).toBeNull();
    expect(await suppressedRef(f.ref(4))).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?",
        f.ref(4),
      ),
    ).toBe(0);
    expect(await scanCopy([shared, f.ref(3), f.ref(4)])).toEqual([]);
    expect(await personExists(child)).toBe(true);
    // The parent's own row (ref 3, linked to them by staff) goes.
    expect(await outsidePerson(f.ref(3))).toBeNull();
  });
});

describe("consent to come back", () => {
  it("erasure.allowAddress lifts the address's suppression and that erase's refs: the same address is matched again", async () => {
    const f = freshFake();
    const addr = f.person(1).email as string;
    const gone = await createPerson(admin, [addr]);
    await loadMembers(f, admin.id);
    await call("person.erase", { id: gone }, admin);
    expect(await call("erasure.allowAddress", { email: addr }, admin)).toEqual({
      removed: true,
      bookingSystem: { addresses: 1, refs: 1, refsLeft: 0 },
    });
    const back = await createPerson(admin, [addr]);
    // Their old ref, and the same address under a new ref, both come back.
    f.state.people.push({ ...structuredClone(f.person(1)), ref: `${f.tag}-newref` });
    f.state.memberships.push({
      ...structuredClone(f.state.memberships[0] as (typeof f.state.memberships)[number]),
      ref: `${f.tag}-newref-m`,
      person: `${f.tag}-newref`,
    });
    const plan = await loadMembers(f, admin.id);
    expect(plan.counts.previouslyErased).toBe(0);
    // Two outside people on the one address: they wait for staff, as anyone's would.
    for (const ref of [f.ref(1), `${f.tag}-newref`]) {
      expect(await outsidePerson(ref), ref).toMatchObject({ address: addr });
    }
    const { matches } = await call<{ matches: { ref: string; candidates: { id: string }[] }[] }>(
      "outside.matches",
      { kind: "person" },
      admin,
    );
    expect(matches.find((m) => m.ref === f.ref(1))?.candidates.map((c) => c.id)).toEqual([back]);
  });
});

describe("what is not theirs", () => {
  it("a row on their own address that staff linked to another Person stays that Person's", async () => {
    const f = freshFake();
    const addr = f.person(1).email as string;
    const gone = await createPerson(admin, [addr]);
    const someoneElse = await createPerson(admin, [`else.${f.tag}@else.example.com`]);
    await loadMembers(f, admin.id);
    await call(
      "outside.link",
      { kind: "person", ref: f.ref(1), personId: someoneElse, why: "a parent's address" },
      admin,
    );
    const out = await call<Record<string, unknown>>("person.erase", { id: gone }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 0, keptLinkedToOthers: 1 });
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: someoneElse });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash IN (?, ?)",
        await outsideRefHash(db.query, "person", f.ref(1)),
        await outsideAddressHash(db.query, addr),
      ),
    ).toBe(0);
  });

  it("an outside ref is never a free-text term: an unrelated record with the same number stays", async () => {
    const f = freshFake();
    const num = String(100000 + Math.floor(Math.random() * 800000));
    const old = f.ref(1);
    (f.state.people[0] as (typeof f.state.people)[number]).ref = num;
    for (const m of f.state.memberships) if (m.person === old) m.person = num;
    for (const b of f.state.bookings) if (b.person === old) b.person = num;
    const gone = await createPerson(admin, [f.person(1).email as string]);
    const other = await createPerson(admin, [`o.${f.tag}@else.example.com`]);
    await loadMembers(f, admin.id);
    expect(await outsidePerson(num)).toMatchObject({ person_id: gone });
    const task = await call<{ id: string }>(
      "task.create",
      { title: `Order ${num} for supplier`, links: [{ object: "person", id: other }] },
      admin,
    );
    await call("person.erase", { id: gone }, admin);
    expect(await outsidePerson(num)).toBeNull();
    expect(
      (await env.DB.prepare("SELECT title FROM core_task WHERE id = ?").bind(task.id).first())
        ?.title,
    ).toBe(`Order ${num} for supplier`);
  });

  it("a coach linked to a staff account stays that account's when the Person with its address is erased", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    f.fake.change("staff", `${f.tag}-fake-staff-1`, { email: coachAddr });
    const staff = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?")
      .bind(coachAddr, staff.id)
      .run();
    const member = await createPerson(admin, [coachAddr]);
    await loadTimetable(f, admin.id);
    expect(
      await env.DB.prepare("SELECT user_id FROM core_outside_staff WHERE ref = ?")
        .bind(`${f.tag}-fake-staff-1`)
        .first(),
    ).toEqual({ user_id: staff.id });
    const out = await call<Record<string, unknown>>("person.erase", { id: member }, admin);
    expect(out.bookingSystem).toMatchObject({ coaches: 0, keptLinkedToOthers: 1 });
    expect(
      await env.DB.prepare("SELECT user_id FROM core_outside_staff WHERE ref = ?")
        .bind(`${f.tag}-fake-staff-1`)
        .first(),
    ).toEqual({ user_id: staff.id });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
        await outsideRefHash(db.query, "staff", `${f.tag}-fake-staff-1`),
      ),
    ).toBe(0);
  });

  it("a coach's name leaves the booking system's own text (class titles, class types)", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    const name = `Riley Coach${f.tag}`;
    f.fake.change("staff", `${f.tag}-fake-staff-1`, { email: coachAddr });
    const otherName = `Summer${f.tag}`;
    f.fake.change("staff", `${f.tag}-fake-staff-2`, { displayName: otherName });
    for (const c of f.state.classes) {
      c.title =
        c.staff === `${f.tag}-fake-staff-1`
          ? `Strength with ${name.toUpperCase()}`
          : `${otherName} Bootcamp, not ${name}s`;
    }
    const type = f.state.classTypes[0] as (typeof f.state.classTypes)[number];
    type.description = `Coached by ${name}`;
    const coach = await createPerson(admin, [coachAddr]);
    await loadTimetable(f, admin.id);
    const out = await call<{ bookingSystem: { coaches: number; textScrubbed: number } }>(
      "person.erase",
      { id: coach },
      admin,
    );
    expect(out.bookingSystem.coaches).toBe(1);
    expect(out.bookingSystem.textScrubbed).toBeGreaterThan(1);
    // Any case, whole words only: another coach's class that has the name inside a longer word
    // keeps its title, and a one-word name is never scrubbed.
    expect(await findAnywhere([`with ${name}`, `by ${name}`, coachAddr])).toEqual([]);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE title = 'Strength with [erased]'",
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE title = ?",
        `${otherName} Bootcamp, not ${name}s`,
      ),
    ).toBeGreaterThan(0);
  });

  it("never scrubs a one-word name from the copy's text", async () => {
    const f = freshFake();
    const coachAddr = `coach.${f.tag}@else.example.com`;
    const word = `Summer${f.tag}`;
    f.fake.change("staff", `${f.tag}-fake-staff-1`, { email: coachAddr, displayName: word });
    for (const c of f.state.classes) c.title = `${word} Bootcamp`;
    const coach = await createPerson(admin, [coachAddr]);
    await loadTimetable(f, admin.id);
    const out = await call<{ bookingSystem: { coaches: number; textScrubbed: number } }>(
      "person.erase",
      { id: coach },
      admin,
    );
    expect(out.bookingSystem).toMatchObject({ coaches: 1, textScrubbed: 0 });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE title = ?",
        `${word} Bootcamp`,
      ),
    ).toBeGreaterThan(0);
  });
});

describe("a lost salt", () => {
  it("refuses a load, a link and a re-apply rather than let suppressions match nothing", async () => {
    const f = freshFake();
    const blobs = memoryBlobs();
    const gone = await createPerson(admin, [f.person(1).email as string]);
    await loadMembers(f, admin.id);
    await call("person.erase", { id: gone }, admin, "human", { blobs });
    // The rows and the log were keyed with a salt the deployment no longer has.
    await env.DB.prepare("UPDATE core_outside_suppressed SET fingerprint = 'another-salt'").run();
    for (const attempt of [
      () => loadMembers(f, admin.id),
      () =>
        call("outside.link", { kind: "person", ref: f.ref(2), personId: gone, why: "x" }, admin),
    ]) {
      await expect(attempt()).rejects.toThrow(/salt/);
    }
    // An erase refuses too, before writing anything: rows keyed with this salt would match nothing
    // once the old one is restored.
    const next = await createPerson(admin, [f.person(2).email as string]);
    const suppressedBefore = await count("SELECT count(*) AS n FROM core_outside_suppressed");
    await expect(call("person.erase", { id: next }, admin)).rejects.toThrow(/salt/);
    expect(await personExists(next)).toBe(true);
    expect(await count("SELECT count(*) AS n FROM core_outside_suppressed")).toBe(suppressedBefore);
    await env.DB.prepare("UPDATE core_outside_suppressed SET fingerprint = NULL").run();
    for (const [key, text] of blobs.map) {
      if (key.startsWith("erase-log/")) {
        blobs.map.set(key, JSON.stringify({ ...JSON.parse(text), fingerprint: "another-salt" }));
      }
    }
    await expect(call("erasure.reapply", {}, admin, "human", { blobs })).rejects.toThrow(/salt/);
  });
});

describe("a family on one mailbox", () => {
  it("keeps the others on an erased Person's outside address", async () => {
    const f = freshFake();
    f.fake.shareAddress(f.ref(3), f.ref(4));
    const parent = await createPerson(admin, [`${unique("p")}@${f.tag}.example.com`]);
    const child = await createPerson(admin, [`${unique("c")}@${f.tag}.example.com`]);
    await loadMembers(f, admin.id);
    for (const [ref, personId] of [
      [f.ref(3), parent],
      [f.ref(4), child],
    ] as const) {
      await call("outside.link", { kind: "person", ref, personId, why: "the family" }, admin);
    }
    await call("person.erase", { id: parent }, admin);
    expect(await outsidePerson(f.ref(3))).toBeNull();
    // The shared address is not suppressed: the other on it stays, at this load and the next.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
        await outsideAddressHash(db.query, f.person(4).email as string),
      ),
    ).toBe(0);
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(4))).toMatchObject({ person_id: child, link_how: "staff" });
    expect(await outsidePerson(f.ref(3))).toBeNull();
  });
});

describe("merge", () => {
  it("moves links to the survivor, reconciles To match, and a merge then an erase leaves nothing", async () => {
    const f = freshFake();
    const [local4, domain4] = (f.person(4).email as string).split("@") as [string, string];
    const survivor = await createPerson(admin, [
      f.person(1).email as string,
      f.person(4).email as string,
    ]);
    const duplicate = await createPerson(admin, [`${local4}+dup@${domain4}`]);
    const someoneElse = await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    await call(
      "outside.link",
      { kind: "person", ref: f.ref(3), personId: duplicate, why: "the duplicate's" },
      admin,
    );
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: survivor });
    expect(await outsidePerson(f.ref(4))).toMatchObject({ person_id: null });

    await call("person.merge", { survivorId: survivor, mergedId: duplicate }, admin);
    // Both links are the survivor's, each one row: none lost, none doubled.
    expect(await outsidePerson(f.ref(1))).toMatchObject({
      person_id: survivor,
      link_how: "address",
    });
    expect(await outsidePerson(f.ref(3))).toMatchObject({
      person_id: survivor,
      link_how: "staff",
      link_why: "the duplicate's",
    });
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE ref = ?", f.ref(3)),
    ).toBe(1);
    // Devon waited only because the two were two Persons: linked to the survivor now.
    expect(await outsidePerson(f.ref(4))).toMatchObject({
      person_id: survivor,
      link_how: "address",
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_match WHERE kind = 'person' AND ref = ?",
        f.ref(4),
      ),
    ).toBe(0);
    expect(
      (await timeline("person", survivor)).filter(
        (a) => a.subject === "Linked to the booking system's list",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    // Nobody else's outside record moved.
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: someoneElse });
    expect(
      await count("SELECT count(*) AS n FROM core_outside_person WHERE person_id = ?", duplicate),
    ).toBe(0);

    // An erase of the merged-away Person (in the Trash) is a no-op here, and does not fail.
    const away = await call<Record<string, unknown>>("person.erase", { id: duplicate }, admin);
    expect(away.bookingSystem).toMatchObject({ deletedLinked: 0, deletedUnlinked: 0 });
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: survivor });

    // Erasing the survivor removes every outside row either of them had.
    const out = await call<Record<string, unknown>>("person.erase", { id: survivor }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 3 });
    expect(
      await findAnywhere([
        survivor,
        duplicate,
        f.ref(1),
        f.ref(3),
        f.ref(4),
        f.person(1).email as string,
        f.person(3).email as string,
        f.person(4).email as string,
      ]),
    ).toEqual([]);
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: someoneElse });
  });
});

describe("purge", () => {
  it("drops a purged Person's links and leaves the outside person, unlinked", async () => {
    const f = freshFake();
    const gone = await createPerson(admin, [f.person(1).email as string]);
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: gone });
    await call("person.delete", { id: gone }, admin);
    await env.DB.prepare(
      "UPDATE core_person SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(gone)
      .run();
    await call("trash.purge", { limit: 100 }, admin, "automation");
    expect(await outsidePerson(f.ref(1))).toMatchObject({
      person_id: null,
      link_how: null,
      linked_at: null,
    });
    expect(
      await findAnywhere([gone]).then((h) => h.filter((x) => x.table.startsWith("core_outside"))),
    ).toEqual([]);
  });
});

describe("after a restore", () => {
  it("erasure.reapply puts the copy's suppressions back from the erase log", async () => {
    const f = freshFake();
    const blobs = memoryBlobs();
    const gone = await createPerson(admin, [f.person(1).email as string]);
    await loadMembers(f, admin.id);
    await call("person.erase", { id: gone }, admin, "human", { blobs });
    const hash = await outsideRefHash(db.query, "person", f.ref(1));
    // A restore from before the erase's suppressions (the erased Person had already gone).
    await env.DB.prepare("DELETE FROM core_outside_suppressed WHERE hash = ?").bind(hash).run();
    const out = await call<{ outsideSuppressed: number }>("erasure.reapply", {}, admin, "human", {
      blobs,
    });
    expect(out.outsideSuppressed).toBeGreaterThan(0);
    expect(
      await count("SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?", hash),
    ).toBe(1);
  });
});

describe("removing the copy", () => {
  it("is a person's with bookingSystem:manage, never an AI's, an MCP client's, an extension's or an automation's", async () => {
    const member = await createUser("member");
    expect((await refusal(call("outside.lists.remove", { kind: "members" }, member))).code).toBe(
      "forbidden",
    );
    for (const preset of ["balanced", "autonomous"] as const) {
      await setPreset(preset);
      try {
        for (const actor of ["assistant", "mcp", "automation", "extension"] as const) {
          expect(
            (await refusal(call("outside.lists.remove", { kind: "all" }, admin, actor))).code,
            `${preset} ${actor}`,
          ).toBe("forbidden");
        }
        // Code Mode calls as the connected user's own actor (mcp), whatever its grants.
        const code = await refusal(
          invokeByName(
            "outside.lists.remove",
            { kind: "all" },
            context(admin, {
              actor: "mcp",
              origin: { surface: "mcp", clientId: "c", clientName: "Code", sessionId: "cap_code" },
              grantedPermissions: ["bookingSystem:manage"],
            }),
          ),
        );
        expect(code.code, `${preset} code mode`).toBe("forbidden");
      } finally {
        await setPreset("balanced");
      }
    }
    const granted = await createUser("member");
    await call(
      "user.setPermissions",
      { id: granted.id, permissions: ["bookingSystem:manage"] },
      admin,
    );
    await call("outside.lists.remove", { kind: "timetable" }, granted);
  });

  it("removes a list's rows and keeps the settings, the log, suppressions, unlink decisions and the timeline", async () => {
    const f = freshFake();
    const avery = await createPerson(admin, [f.person(1).email as string]);
    const erasedOne = await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    await call("person.erase", { id: erasedOne }, admin);
    await call("outside.unlink", { kind: "person", ref: f.ref(7), why: "not ours" }, admin);
    await call("outside.settings.update", { largestAgeDays: 20 }, admin);
    const suppressed = await count("SELECT count(*) AS n FROM core_outside_suppressed");
    const unlinked = await count("SELECT count(*) AS n FROM core_outside_unlinked");

    const out = await call<{ removed: string[]; rows: number; remaining: number; done: boolean }>(
      "outside.lists.remove",
      { kind: "members" },
      admin,
    );
    expect(out).toMatchObject({ removed: ["members"], remaining: 0, done: true });
    expect(out.rows).toBeGreaterThan(0);
    for (const table of [
      "core_outside_person",
      "core_outside_membership",
      "core_outside_membership_type",
    ]) {
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(await count("SELECT count(*) AS n FROM core_outside_match WHERE kind = 'person'")).toBe(
      0,
    );
    // The timetable is another list: untouched.
    expect(await count("SELECT count(*) AS n FROM core_outside_class")).toBeGreaterThan(0);
    const status = await call<{ lists: { kind: string }[]; counts: Record<string, number> }>(
      "outside.status",
      {},
      admin,
    );
    expect(status.lists.map((l) => l.kind)).toEqual(["timetable"]);
    expect(status.counts.people).toBe(0);
    // Kept: the log row (counts only), the suppressions, the unlink decisions, the settings and
    // the timeline activity.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_list WHERE kind = 'members' AND state = 'removed'",
      ),
    ).toBeGreaterThan(0);
    expect(await count("SELECT count(*) AS n FROM core_outside_suppressed")).toBe(suppressed);
    expect(await count("SELECT count(*) AS n FROM core_outside_unlinked")).toBe(unlinked);
    expect(await call("outside.settings.get", {}, admin)).toMatchObject({ largestAgeDays: 20 });
    expect(
      (await timeline("person", avery)).filter(
        (a) => a.subject === "Linked to the booking system's list",
      ),
    ).toHaveLength(1);
    // Removing again finds nothing to remove, and does not fail.
    expect(await call("outside.lists.remove", { kind: "members" }, admin)).toMatchObject({
      removed: [],
      rows: 0,
      done: true,
    });
    // Disconnecting: all of it.
    const all = await call<{ removed: string[] }>("outside.lists.remove", { kind: "all" }, admin);
    expect(all.removed).toEqual(["timetable"]);
    for (const table of [
      "core_outside_class",
      "core_outside_class_type",
      "core_outside_booking",
      "core_outside_staff",
      "core_outside_match",
    ]) {
      expect(await count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect((await call<{ lists: unknown[] }>("outside.status", {}, admin)).lists).toEqual([]);
    // The audit keeps counts, never a name or an address.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'outside.lists.remove' ORDER BY at DESC LIMIT 1",
    ).first<{ input: string; result: string }>();
    expect(JSON.stringify(audit)).not.toContain(f.tag);
    await call("outside.settings.update", { largestAgeDays: 31 }, admin);
  });

  it("is not held by anything: no trigger or write guard sits on the copy's tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'core_outside%'",
    ).all<{ name: string }>();
    expect(results).toEqual([]);
  });
});

// The rule (ADR 0926, `outside/erase.ts`): A, what is deleted; B, what is suppressed and becomes a
// term; C, what the result tells staff. Each case scans the copy's three tables for the erased
// Person's name, addresses and ref right after the erase (no later load), and checks the other
// person is intact.
describe("the rule: which outside rows are the erased Person's", () => {
  const membershipsOf = (ref: string) =>
    count("SELECT count(*) AS n FROM core_outside_membership WHERE person_ref = ?", ref);
  const suppressed = async (kind: "ref" | "address", value: string) =>
    count(
      "SELECT count(*) AS n FROM core_outside_suppressed WHERE hash = ?",
      kind === "ref"
        ? await outsideRefHash(db.query, "person", value)
        : await outsideAddressHash(db.query, value),
    );

  it("A.2: a family in To match on the parent's address, linked to nobody: erase the parent, then the child", async () => {
    const f = freshFake();
    f.fake.shareAddress(f.ref(3), f.ref(4));
    const shared = f.person(3).email as string;
    const parent = await createPerson(admin, [shared], `Parent ${f.tag}`);
    const child = await createPerson(admin, [`kid.${f.tag}@else.example.com`], `Child ${f.tag}`);
    const bystander = await createPerson(admin, [f.person(2).email as string]);
    // A class the booking system titled with the child's name: not theirs to scrub.
    const childName = `${f.person(4).givenName} ${f.person(4).familyName}`;
    const parentName = `${f.person(3).givenName} ${f.person(3).familyName}`;
    for (const c of f.state.classes) c.title = `PT with ${childName} and ${parentName}`;
    await loadMembers(f, admin.id);
    await loadTimetable(f, admin.id);
    const { matches } = await call<{ matches: { ref: string; why: string }[] }>(
      "outside.matches",
      { kind: "person" },
      admin,
    );
    expect(matches.filter((m) => [f.ref(3), f.ref(4)].includes(m.ref)).map((m) => m.why)).toEqual([
      "shared_address",
      "shared_address",
    ]);
    const bystanderMemberships = await membershipsOf(f.ref(2));

    const out = await call<Record<string, unknown>>("person.erase", { id: parent }, admin);
    // C: staff are told, with the note, though no row was linked to them.
    expect(out.bookingSystem).toMatchObject({
      deletedLinked: 0,
      deletedUnlinked: 2,
      keptLinkedToOthers: 0,
      copyRemains: true,
    });
    // A.2: both rows go now, with their memberships and To match; nothing waits for a load.
    expect(
      await scanCopy([
        shared,
        f.ref(3),
        f.ref(4),
        f.person(3).givenName as string,
        f.person(3).familyName as string,
      ]),
    ).toEqual([]);
    // B: the address is suppressed; no ref of a row linked to nobody is.
    expect(await suppressed("address", shared)).toBe(1);
    expect(await suppressed("ref", f.ref(3))).toBe(0);
    expect(await suppressed("ref", f.ref(4))).toBe(0);
    // B: no name of a row linked to nobody is scrubbed: it may be the child's.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_class WHERE title = ?",
        `PT with ${childName} and ${parentName}`,
      ),
    ).toBeGreaterThan(0);
    // The others are intact.
    expect(await personExists(child)).toBe(true);
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
    expect(await membershipsOf(f.ref(2))).toBe(bystanderMemberships);

    // Then the child: the copy still exists, so the result says so; nothing else of anyone goes.
    const second = await call<Record<string, unknown>>("person.erase", { id: child }, admin);
    expect(second.bookingSystem).toMatchObject({
      deletedLinked: 0,
      deletedUnlinked: 0,
      copyRemains: true,
    });
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
  });

  it("B: a husband staff-linked under his wife's address: her address is neither suppressed nor redacted, and she is matched at the next load", async () => {
    const f = freshFake();
    const b = f.person(3).email as string;
    const wife = await createPerson(admin, [b], `Wife ${f.tag}`);
    const husband = await createPerson(admin, [`h.${f.tag}@else.example.com`], `Husband ${f.tag}`);
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: wife });
    await call(
      "outside.link",
      { kind: "person", ref: f.ref(3), personId: husband, why: "it is him" },
      admin,
    );
    const task = await call<{ id: string }>(
      "task.create",
      { title: `Email the wife at ${b}`, links: [{ object: "person", id: wife }] },
      admin,
    );
    const out = await call<Record<string, unknown>>("person.erase", { id: husband }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedLinked: 1, sharedAddresses: 1 });
    // A.1: his row goes; B: his ref is suppressed, her address is not, nor redacted anywhere.
    expect(
      await scanCopy([f.ref(3), f.person(3).givenName as string, `h.${f.tag}@else.example.com`]),
    ).toEqual([]);
    expect(await suppressed("ref", f.ref(3))).toBe(1);
    expect(await suppressed("address", b)).toBe(0);
    expect(
      (await env.DB.prepare("SELECT title FROM core_task WHERE id = ?").bind(task.id).first())
        ?.title,
    ).toBe(`Email the wife at ${b}`);
    expect(await personExists(wife)).toBe(true);
    // The booking system lists her under her own ref with the address: matched, not dropped.
    f.fake.change("person", f.ref(7), { email: b });
    await loadMembers(f, admin.id);
    expect(await outsidePerson(f.ref(7))).toMatchObject({ person_id: wife, link_how: "address" });
    expect(await outsidePerson(f.ref(3))).toBeNull();
  });

  it("A.2: three people on one address only they held all go", async () => {
    const f = freshFake();
    f.fake.shareAddress(f.ref(1), f.ref(3));
    f.fake.shareAddress(f.ref(1), f.ref(4));
    const x = f.person(1).email as string;
    const p = await createPerson(admin, [x], `Three ${f.tag}`);
    const bystander = await createPerson(admin, [f.person(2).email as string]);
    await loadMembers(f, admin.id);
    const out = await call<Record<string, unknown>>("person.erase", { id: p }, admin);
    expect(out.bookingSystem).toMatchObject({ deletedUnlinked: 3 });
    expect(await scanCopy([x, f.ref(1), f.ref(3), f.ref(4)])).toEqual([]);
    for (const ref of [f.ref(1), f.ref(3), f.ref(4)]) expect(await suppressed("ref", ref)).toBe(0);
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
  });

  it("A.2, C: a row waiting as several_people (another Person holds the address) stays, and staff are told", async () => {
    const f = freshFake();
    const x = f.person(1).email as string;
    const [local, domain] = x.split("@") as [string, string];
    const p = await createPerson(admin, [x], `P ${f.tag}`);
    const q = await createPerson(admin, [`${local}+q@${domain}`], `Q ${f.tag}`);
    await loadMembers(f, admin.id);
    const before = await env.DB.prepare(
      "SELECT why, candidates FROM core_outside_match WHERE kind = 'person' AND ref = ?",
    )
      .bind(f.ref(1))
      .first<{ why: string; candidates: string }>();
    expect(before?.why).toBe("several_people");
    const out = await call<Record<string, unknown>>("person.erase", { id: p }, admin);
    expect(out.bookingSystem).toMatchObject({
      deletedLinked: 0,
      deletedUnlinked: 0,
      keptWaiting: 1,
      sharedAddresses: 1,
    });
    // It may be Q's: kept, with Q its only candidate; P's id is gone from it.
    expect(await outsidePerson(f.ref(1))).toMatchObject({ person_id: null, address: x });
    const after = await env.DB.prepare(
      "SELECT candidates FROM core_outside_match WHERE kind = 'person' AND ref = ?",
    )
      .bind(f.ref(1))
      .first<{ candidates: string }>();
    expect(JSON.parse(after?.candidates ?? "[]")).toEqual([q]);
    expect(await scanCopy([p])).toEqual([]);
    expect(await suppressed("address", x)).toBe(0);
    expect(await personExists(q)).toBe(true);
  });

  it("C: the block is there when nothing of theirs was in the copy", async () => {
    const f = freshFake();
    await loadMembers(f, admin.id);
    const nobody = await createPerson(admin, [`nobody.${f.tag}@else.example.com`]);
    const out = await call<Record<string, unknown>>("person.erase", { id: nobody }, admin);
    expect(out.bookingSystem).toEqual({
      deletedLinked: 0,
      deletedUnlinked: 0,
      coaches: 0,
      keptLinkedToOthers: 0,
      keptWaiting: 0,
      keptNamedElsewhere: 0,
      sharedAddresses: 0,
      textScrubbed: 0,
      copyRemains: true,
      note: expect.stringContaining("A copy remains in the booking system"),
    });
  });

  it("S3: consent to come back lifts one erase's refs, never another erased Person's", async () => {
    const f = freshFake();
    const x = f.person(1).email as string;
    const first = await createPerson(admin, [x]);
    await loadMembers(f, admin.id);
    await call("person.erase", { id: first }, admin);
    // Someone later signs up with the same address and is erased too: two erases suppressed it.
    const second = await createPerson(admin, [x]);
    await call("person.erase", { id: second }, admin);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_outside_suppressed_erase WHERE hash = ?",
        await outsideAddressHash(db.query, x),
      ),
    ).toBe(2);
    // Whose consent this is cannot be told: the address is allowed for mail, nothing of either
    // erase is lifted in the copy, and the first erase's ref is counted as left.
    expect(await call("erasure.allowAddress", { email: x }, admin)).toEqual({
      removed: true,
      bookingSystem: { addresses: 0, refs: 0, refsLeft: 1 },
    });
    expect(await suppressed("ref", f.ref(1))).toBe(1);
  });
});
