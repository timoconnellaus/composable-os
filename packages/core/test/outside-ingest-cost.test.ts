// Stage 65 step 3 (ADR 0922), what a load costs: a `members` list of 3,000 people of whom 800 are
// members, and a `timetable` list of 28 days of 15 classes with their bookings, each read and
// written within 250 D1 statements (acceptance criterion 11). D1 allows 1,000 statements an
// invocation and 100 bound parameters a statement; the local runtime enforces neither, so this
// counts them: every write is set based, 100 rows to a statement as one JSON parameter.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import {
  type BookingSystemBooking,
  type BookingSystemClass,
  type BookingSystemMembership,
  type BookingSystemPerson,
  directSession,
  FakeBookingSystem,
  fakeBookingSystemState,
} from "@composable-os/gatekeeper-booking-system";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActingUser } from "../src/index.ts";
import { planMembers, planTimetable, readMembers, readTimetable } from "../src/outside/ingest.ts";
import { createUser } from "./helpers.ts";

let queries = 0;
let maxParams = 0;

/** env.DB, counting statements and the most parameters any one binds. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
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
const DAY = 86_400_000;

/** The fixture's site: 3,000 people, 800 of them members; 28 days of 15 classes, 12 booked each. */
function fixture() {
  const state = fakeBookingSystemState({ now: NOW, pageSize: 200 });
  const people: BookingSystemPerson[] = [];
  const memberships: BookingSystemMembership[] = [];
  for (let i = 0; i < 3000; i++) {
    const ref = `cost-person-${i}`;
    const member = i < 800;
    people.push({
      ref,
      email: `cost${i}@cost.example.com`,
      givenName: `Given${i}`,
      familyName: `Family${i}`,
      memberStatus: member ? "member" : "not_member",
      active: true,
      modifiedAt: null,
    });
    if (member) {
      memberships.push({
        ref: `cost-membership-${i}`,
        person: ref,
        type: "fake-type-unlimited",
        name: "Unlimited monthly",
        kind: "membership",
        status: "live",
        from: "2026-01-01",
        until: null,
        usesTotal: null,
        usesLeft: null,
        renews: true,
      });
    } else if (i < 1000) {
      memberships.push({
        ref: `cost-ended-${i}`,
        person: ref,
        type: "fake-type-unlimited",
        name: "Unlimited monthly",
        kind: "membership",
        status: "ended",
        from: "2025-01-01",
        until: "2025-12-31",
        usesTotal: null,
        usesLeft: null,
        renews: false,
      });
    }
  }
  const classes: BookingSystemClass[] = [];
  const bookings: BookingSystemBooking[] = [];
  const start = Date.parse("2026-11-24T00:00:00.000Z");
  for (let d = 0; d < 28; d++) {
    for (let c = 0; c < 15; c++) {
      const startsAt = start + d * DAY + (6 + c) * 3_600_000;
      const ref = `cost-class-${d}-${c}`;
      classes.push({
        ref,
        classType: "fake-class-type-strength",
        title: "Strength",
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(startsAt + 3_600_000).toISOString(),
        location: "fake-location-main",
        staff: c % 2 ? "fake-staff-1" : "fake-staff-2",
        places: 12,
        booked: 12,
        waiting: 0,
        cancelled: false,
        modifiedAt: null,
      });
      for (let b = 0; b < 12; b++) {
        bookings.push({
          ref: `${ref}-b${b}`,
          class: ref,
          person: `cost-person-${(d * 15 + c + b * 61) % 800}`,
          state: "booked",
          modifiedAt: null,
        });
      }
    }
  }
  state.people = people;
  state.memberships = memberships;
  state.classes = classes;
  state.bookings = bookings;
  return directSession(new FakeBookingSystem(state));
}

describe("the cost of a load", () => {
  let admin: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
    // A Person for a few hundred of the members, so the links and their activities are written too.
    const persons = [];
    for (let i = 0; i < 300; i++) {
      persons.push(
        env.DB.prepare(
          "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind(`per_cost${i}`, `Cost ${i}`, NOW, NOW),
        env.DB.prepare(
          "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES (?, ?, ?, 1, 0, ?)",
        ).bind(`eml_cost${i}`, `per_cost${i}`, `cost${i}@cost.example.com`, NOW),
      );
    }
    await env.DB.batch(persons);
  });

  it("loads a members list of 3,000 rows with 800 members within 250 statements", async () => {
    const session = fixture();
    queries = 0;
    maxParams = 0;
    const plan = await planMembers(db.query, await readMembers(session), {
      exportedOn: "2026-11-23",
      by: admin.id,
      now: NOW,
      rows: 3000,
      refused: 0,
    });
    await db.batch(plan.statements);
    expect(plan.counts).toMatchObject({ kept: 800, notKept: 2200, linked: 300 });
    // About 34: six reads, and set-based writes of 100 rows each (measured 2026-11-24).
    expect(queries).toBeLessThanOrEqual(250);
    expect(queries).toBeLessThan(60);
    expect(maxParams).toBeLessThanOrEqual(100);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM core_outside_person").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(800);

    // Loading it again (every link held now) costs the same, not a statement per row.
    queries = 0;
    const again = await planMembers(db.query, await readMembers(session), {
      exportedOn: "2026-11-24",
      by: admin.id,
      now: NOW,
      rows: 3000,
      refused: 0,
    });
    await db.batch(again.statements);
    expect(again.counts).toMatchObject({ links: 300, linked: 0 });
    expect(queries).toBeLessThanOrEqual(250);
  }, 120_000);

  it("loads a timetable of 28 days of 15 classes with their bookings within 250 statements", async () => {
    const session = fixture();
    queries = 0;
    maxParams = 0;
    const data = await readTimetable(session, {
      from: "2026-11-24T00:00:00.000Z",
      until: "2026-12-22T00:00:00.000Z",
    });
    const plan = await planTimetable(db.query, data, {
      exportedOn: "2026-11-23",
      by: admin.id,
      now: NOW,
      rows: 5040,
      refused: 0,
    });
    await db.batch(plan.statements);
    expect(plan.counts.items).toMatchObject({ classes: 420, bookings: 5040 });
    // About 69, most of them the bookings' 51 inserts (measured 2026-11-24).
    expect(queries).toBeLessThanOrEqual(250);
    expect(queries).toBeLessThan(100);
    expect(maxParams).toBeLessThanOrEqual(100);
  }, 120_000);
});
