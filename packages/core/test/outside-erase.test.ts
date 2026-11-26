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
    // waits in To match, linked to nobody, and is theirs by address.
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
    // A task that names the booking system's address and ref for them, about the bystander.
    await call(
      "task.create",
      {
        title: "Booking system follow up",
        notes: `Check ${theirs.listed()} (${f.ref(3)}) against the list`,
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
      people: 3,
      coaches: 1,
      copyRemains: true,
      note: expect.stringContaining("A copy remains in the booking system"),
    });

    // Nothing of theirs, anywhere: ids, addresses, outside refs, names as listed.
    const needles = [
      erased,
      theirs.own(),
      theirs.listed(),
      theirs.third,
      `${local4}+them@${domain4}`,
      f.ref(1),
      f.ref(3),
      f.ref(11),
      `${f.tag}-fake-staff-1`,
      f.person(1).givenName as string,
      f.person(3).givenName as string,
      f.person(11).givenName as string,
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
      ["ref", await outsideRefHash(db.query, "staff", `${f.tag}-fake-staff-1`)],
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
        "SELECT count(*) AS n FROM core_outside_booking WHERE person_ref IN (?, ?, ?)",
        f.ref(1),
        f.ref(3),
        f.ref(11),
      ),
    ).toBe(0);
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
    // Someone else entirely is kept as before.
    expect(await outsidePerson(f.ref(2))).toMatchObject({ person_id: bystander });
    expect(otherToo).toBeTruthy();
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
    expect(away.bookingSystem).toBeUndefined();
    expect(await outsidePerson(f.ref(3))).toMatchObject({ person_id: survivor });

    // Erasing the survivor removes every outside row either of them had.
    const out = await call<Record<string, unknown>>("person.erase", { id: survivor }, admin);
    expect(out.bookingSystem).toMatchObject({ people: 3 });
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
