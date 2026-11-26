// Stage 65 step 10 (ADR 0926), the bounds on D1: an erase reaching a large booking-system copy,
// and removing one. D1 allows 1,000 statements an invocation, 100 bound parameters a statement and
// 5 terms a compound SELECT; the local runtime enforces none of them, so this counts statements
// and parameters at two sizes of copy: an erase costs the same whatever the copy holds, and a
// removal stays within its bound, in passes that resume when a copy is bigger than one call's.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { finishOutsideRemoval, planRemoval, REMOVE_MAX_STATEMENTS } from "../src/outside/remove.ts";
import { context, createUser, unique } from "./helpers.ts";

let queries = 0;
let maxParams = 0;
let compound = 0;

/** env.DB, counting statements, the most parameters any one binds, and compound SELECT terms. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        // UNION / INTERSECT / EXCEPT terms in one statement (a recursive CTE's own is one).
        compound = Math.max(
          compound,
          (query.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length + 1,
        );
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  maxParams = Math.max(maxParams, args.length);
                  return wrap(s.bind(...args));
                };
              }
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  queries += 1;
                  return (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        queries += statements.length;
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);
const NOW = "2026-11-24T09:00:00.000Z";

function reset() {
  queries = 0;
  maxParams = 0;
  compound = 0;
}

const ctx = (user: ActingUser) => ({ ...context(user), db, clock: () => new Date(NOW) });

/**
 * A copy of `size` outside people (each a member with a membership), `size` / 10 classes with two
 * bookings a person, a coach, and `size` / 10 waiting in To match, written straight in (the cost
 * of a load is outside-ingest-cost.test.ts's). Person 0 is linked to `personId` by address.
 */
async function seed(size: number, tag: string, personId: string, address: string) {
  const members = `ol_${tag}_m`;
  const timetable = `ol_${tag}_t`;
  const run = (sqlText: string, ...params: unknown[]) =>
    env.DB.prepare(sqlText)
      .bind(...params)
      .run();
  await run(
    "UPDATE core_outside_list SET state = 'replaced', ended_at = ? WHERE state = 'current'",
    NOW,
  );
  for (const [id, kind] of [
    [members, "members"],
    [timetable, "timetable"],
  ]) {
    await run(
      "INSERT INTO core_outside_list (id, kind, source, exported_on, loaded_by, loaded_at, state) VALUES (?, ?, 'file', '2026-11-23', 'usr_x', ?, 'current')",
      id,
      kind,
      NOW,
    );
  }
  for (const table of [
    "core_outside_person",
    "core_outside_membership",
    "core_outside_membership_type",
    "core_outside_class",
    "core_outside_booking",
    "core_outside_staff",
    "core_outside_match",
  ]) {
    await run(`DELETE FROM ${table}`);
  }
  const series = (n: number) =>
    `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < ${n - 1})`;
  await run(
    `${series(size)} INSERT INTO core_outside_person (ref, list_id, address, address_folded, given_name, family_name, member_status, active, why_kept)
     SELECT ?1 || '-p' || i, ?2, 'big' || i || '@' || ?1 || '.example.com', 'big' || i || '@' || ?1 || '.example.com', 'Given' || i, 'Family' || i, 'member', 1, 'member' FROM s`,
    tag,
    members,
  );
  await run(
    "UPDATE core_outside_person SET address = ?, address_folded = ?, person_id = ?, link_how = 'address', linked_at = ? WHERE ref = ?",
    address,
    address,
    personId,
    NOW,
    `${tag}-p0`,
  );
  await run(
    "INSERT INTO core_outside_membership_type (ref, list_id, name, kind, active) VALUES ('t-unlimited', ?, 'Unlimited', 'membership', 1)",
    members,
  );
  await run(
    `${series(size)} INSERT INTO core_outside_membership (ref, list_id, person_ref, type_ref, name, kind, status, renews)
     SELECT ?1 || '-m' || i, ?2, ?1 || '-p' || i, 't-unlimited', 'Unlimited', 'membership', 'live', 1 FROM s`,
    tag,
    members,
  );
  await run(
    "INSERT INTO core_outside_staff (ref, list_id, display_name, active) VALUES (?, ?, 'Coach', 1)",
    `${tag}-coach`,
    timetable,
  );
  await run(
    `${series(Math.max(1, size / 10))} INSERT INTO core_outside_class (ref, list_id, class_type_ref, title, starts_at, ends_at, staff_ref, booked, waiting, cancelled)
     SELECT ?1 || '-c' || i, ?2, 'ct', 'Class', '2026-11-25T07:00:00.000Z', '2026-11-25T08:00:00.000Z', ?1 || '-coach', 20, 0, 0 FROM s`,
    tag,
    timetable,
  );
  await run(
    `${series(size * 2)} INSERT INTO core_outside_booking (ref, list_id, class_ref, person_ref, state)
     SELECT ?1 || '-b' || i, ?2, ?1 || '-c' || (i % ${Math.max(1, size / 10)}), ?1 || '-p' || (i % ${size}), 'booked' FROM s`,
    tag,
    timetable,
  );
  await run(
    `${series(Math.max(1, size / 10))} INSERT INTO core_outside_match (kind, ref, why, candidates, created_at)
     SELECT 'person', ?1 || '-p' || (i + 1), 'several_people', json_array(?2, 'per_other'), ?3 FROM s`,
    tag,
    personId,
    NOW,
  );
}

async function rows(table: string) {
  return (
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0
  );
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

async function personWith(address: string) {
  const out = (await invokeByName(
    "person.create",
    { displayName: unique("Big"), emails: [{ email: address }] },
    context(admin),
  )) as { id: string };
  return out.id;
}

describe("an erase over a large copy", () => {
  it("costs the same statements whatever the copy holds, none binding over 100", async () => {
    const cost: number[] = [];
    for (const size of [20, 6_000]) {
      const tag = unique("eb").toLowerCase();
      const address = `${tag}@big.example.com`;
      const person = await personWith(address);
      await seed(size, tag, person, address);
      reset();
      const out = (await invokeByName("person.erase", { id: person }, ctx(admin))) as {
        bookingSystem?: { people: number };
      };
      expect(out.bookingSystem?.people).toBe(1);
      cost.push(queries);
      expect(maxParams).toBeLessThanOrEqual(100);
      expect(compound).toBeLessThanOrEqual(5);
      // Theirs is gone; everyone else's stays.
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM core_outside_booking WHERE person_ref = ?")
          .bind(`${tag}-p0`)
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
      expect(await rows("core_outside_person")).toBe(size - 1);
      expect(await rows("core_outside_booking")).toBe(size * 2 - 2);
      const left = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_outside_match WHERE candidates LIKE ?",
      )
        .bind(`%${person}%`)
        .first<{ n: number }>();
      expect(left?.n).toBe(0);
    }
    // No more statements at 6,000 people than at 20 (the first erase may read the deployment's
    // salt once more), and far under D1's 1,000.
    expect(cost[1]).toBeLessThanOrEqual(cost[0] as number);
    expect(cost[1]).toBeLessThan(1_000);
  });
});

describe("removing a large copy", () => {
  it("stays within its bound at two sizes, done in one call each", async () => {
    const cost: number[] = [];
    for (const size of [20, 6_000]) {
      const tag = unique("rb").toLowerCase();
      const address = `${tag}@big.example.com`;
      await seed(size, tag, await personWith(address), address);
      reset();
      const out = (await invokeByName("outside.lists.remove", { kind: "all" }, ctx(admin))) as {
        done: boolean;
        rows: number;
      };
      expect(out.done).toBe(true);
      cost.push(queries);
      expect(maxParams).toBeLessThanOrEqual(100);
      expect(compound).toBeLessThanOrEqual(5);
      for (const table of [
        "core_outside_person",
        "core_outside_membership",
        "core_outside_booking",
        "core_outside_class",
        "core_outside_match",
      ]) {
        expect(await rows(table), table).toBe(0);
      }
    }
    // Its reads, the audit and at most REMOVE_MAX_STATEMENTS deletes: the bound, at both sizes.
    for (const n of cost) expect(n).toBeLessThanOrEqual(REMOVE_MAX_STATEMENTS + 20);
    expect(cost[1]).toBeLessThan(60);
  });

  it("removes a copy bigger than one call's passes in passes that resume, and nothing reads the rest", async () => {
    const passes = { passRows: 100, maxStatements: 5 };
    for (const [size, calls] of [
      [40, 1],
      [1_000, 5],
    ] as const) {
      const tag = unique("rp").toLowerCase();
      const address = `${tag}@big.example.com`;
      await seed(size, tag, await personWith(address), address);
      let made = 0;
      for (;;) {
        const plan = await planRemoval(db.query, ["members"], NOW, passes);
        const deletes = plan.statements.filter((s) => s.sql.startsWith("DELETE")).length;
        // Never past the bound, however big the copy.
        expect(deletes).toBeLessThanOrEqual(passes.maxStatements);
        reset();
        await db.batch(plan.statements);
        expect(queries).toBeLessThanOrEqual(passes.maxStatements + 1);
        made += 1;
        if (plan.remaining === 0) break;
        // Between passes the list is removed: what is left is no copy to any read.
        expect(await rows("core_outside_person")).toBeGreaterThan(0);
        const status = (await invokeByName("outside.status", {}, ctx(admin))) as {
          lists: { kind: string }[];
          counts: { people: number; memberships: number; waitingPeople: number };
        };
        expect(status.lists.map((l) => l.kind)).toEqual(["timetable"]);
        expect(status.counts).toMatchObject({ people: 0, memberships: 0 });
        // A Person who appears with a leftover row's address is not linked to it.
        if (made === 1) {
          await personWith(`big5@${tag}.example.com`);
          expect(
            await env.DB.prepare("SELECT person_id FROM core_outside_person WHERE ref = ?")
              .bind(`${tag}-p5`)
              .first<{ person_id: string | null }>(),
          ).toEqual({ person_id: null });
        }
        expect(made).toBeLessThan(50);
      }
      expect(made, `${size}`).toBeGreaterThanOrEqual(calls);
      for (const table of [
        "core_outside_person",
        "core_outside_membership",
        "core_outside_membership_type",
      ]) {
        expect(await rows(table), table).toBe(0);
      }
      expect(
        (
          await env.DB.prepare(
            "SELECT count(*) AS n FROM core_outside_match WHERE kind = 'person'",
          ).first<{
            n: number;
          }>()
        )?.n,
      ).toBe(0);
    }
  });

  it("finishes an unfinished removal without touching a list loaded since, by a call or the daily maintenance", async () => {
    const tag = unique("rf").toLowerCase();
    const address = `${tag}@big.example.com`;
    await seed(1_000, tag, await personWith(address), address);
    // One bounded call: the list is removed, most of its rows are left.
    const first = await planRemoval(db.query, ["members"], NOW, {
      passRows: 100,
      maxStatements: 5,
    });
    await db.batch(first.statements);
    expect(first.remaining).toBeGreaterThan(0);
    // A list is loaded meanwhile (here written straight in): it is current, and must stay.
    const fresh = `ol_${tag}_fresh`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_outside_list (id, kind, source, exported_on, loaded_by, loaded_at, state) VALUES (?, 'members', 'file', '2026-11-24', 'usr_x', ?, 'current')",
      ).bind(fresh, NOW),
      env.DB.prepare(
        "INSERT INTO core_outside_person (ref, list_id, member_status, active, why_kept) VALUES (?, ?, 'member', 1, 'member')",
      ).bind(`${tag}-fresh`, fresh),
    ]);
    // Finishing by a call removes no current list.
    const finish = (await invokeByName(
      "outside.lists.remove",
      { kind: "members", finish: true },
      ctx(admin),
    )) as { removed: string[]; done: boolean };
    expect(finish).toMatchObject({ removed: [], done: true });
    expect(await rows("core_outside_person")).toBe(1);
    expect(
      await env.DB.prepare("SELECT state FROM core_outside_list WHERE id = ?").bind(fresh).first(),
    ).toEqual({ state: "current" });

    // Left unfinished again: the daily maintenance finishes it, the current list untouched.
    await env.DB.prepare(
      "UPDATE core_outside_list SET state = 'removed', ended_at = ? WHERE id = ?",
    )
      .bind(NOW, fresh)
      .run();
    const tag2 = unique("rg").toLowerCase();
    await seed(500, tag2, await personWith(`${tag2}@big.example.com`), `${tag2}@big.example.com`);
    const second = await planRemoval(db.query, ["members"], NOW, {
      passRows: 100,
      maxStatements: 3,
    });
    await db.batch(second.statements);
    const fresher = `ol_${tag2}_fresher`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_outside_list (id, kind, source, exported_on, loaded_by, loaded_at, state) VALUES (?, 'members', 'file', '2026-11-24', 'usr_x', ?, 'current')",
      ).bind(fresher, NOW),
      env.DB.prepare(
        "INSERT INTO core_outside_person (ref, list_id, member_status, active, why_kept) VALUES (?, ?, 'member', 1, 'member')",
      ).bind(`${tag2}-fresher`, fresher),
    ]);
    expect(await finishOutsideRemoval(db, NOW)).toMatchObject({ remaining: 0 });
    expect(await rows("core_outside_membership")).toBe(0);
    expect((await env.DB.prepare("SELECT ref FROM core_outside_person").all()).results).toEqual([
      { ref: `${tag2}-fresher` },
    ]);
    // Nothing to do: two reads.
    reset();
    expect(await finishOutsideRemoval(db, NOW)).toEqual({ rows: 0, remaining: 0 });
    expect(queries).toBe(2);
  });
});
