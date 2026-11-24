// Stage 39 step 2 (ADR 0751), what moving a visit costs: the most crew places that may follow one
// visit, each a different person, moved by one record.update. The host reads each crew place before
// the move (its person's other shifts, warnings, notices), so the call must stay far inside D1's
// 1,000 queries per invocation; the copy itself is one statement (the visit's triggers).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type InvocationContext, invokeByName } from "../src/index.ts";
import { TIMES_FOLLOWERS_MAX } from "../src/staffing/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { createUser } from "./helpers.ts";

let rowsRead = 0;
let queries = 0;

/** env.DB, counting meta.rows_read and statements for everything Kysely runs. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  queries += 1;
                  const result = await (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  const meta = (result as { meta?: { rows_read?: number } } | null)?.meta;
                  rowsRead += meta?.rows_read ?? 0;
                  return result;
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
        const results = await target.batch(statements);
        for (const r of results) rowsRead += r.meta.rows_read;
        return results;
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

const ext = extId("stfcost");
const VISIT = `${ext}.visit`;
const PLACE = `${ext}.assignment`;
const NOW = "2031-05-31T00:00:00.000Z";
const STATES = [
  { value: "booked", label: "Booked" },
  { value: "cancelled", label: "Cancelled" },
];
const fixture = manifest(ext, {
  objects: {
    vtype: {
      label: "Visit type",
      plural: "Visit types",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    visit: {
      label: "Visit",
      plural: "Visits",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        visitType: { type: "relation", label: "Visit type", to: `${ext}.vtype` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        state: { type: "select", label: "State", options: STATES },
      },
      states: {
        field: "state",
        initial: "booked",
        moves: [{ from: "booked", to: "cancelled", by: ["staff", "host"] }],
      },
    },
    assignment: {
      label: "Crew place",
      plural: "Crew places",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        visit: { type: "relation", label: "Visit", to: `${ext}.visit`, required: true },
        staff: { type: "user", label: "Staff" },
        visitType: { type: "relation", label: "Visit type", to: `${ext}.vtype`, readOnly: true },
        startsAt: { type: "datetime", label: "Starts at", readOnly: true },
        endsAt: { type: "datetime", label: "Ends at", readOnly: true },
        state: { type: "select", label: "State", options: STATES },
      },
      states: {
        field: "state",
        initial: "booked",
        moves: [{ from: "booked", to: "cancelled", by: ["staff", "host"] }],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "visitType",
        live: ["booked"],
        timesFrom: "visit",
      },
    },
  },
});

let admin: ActingUser;
let visit: string;
const crew: string[] = [];
const ctx = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  clock: () => new Date(NOW),
});

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', '{}', ?, ?, ?)",
  )
    .bind(ext, admin.id, NOW, NOW)
    .run();
  const kind = (await invokeByName(
    "record.create",
    { object: `${ext}.vtype`, values: { name: "Electrical" } },
    ctx(),
  )) as { id: string };
  visit = (
    (await invokeByName(
      "record.create",
      {
        object: VISIT,
        values: {
          name: "Big job",
          visitType: kind.id,
          startsAt: "2031-06-02T09:00:00.000Z",
          endsAt: "2031-06-02T17:00:00.000Z",
        },
      },
      ctx(),
    )) as { id: string }
  ).id;
  for (let i = 0; i < TIMES_FOLLOWERS_MAX; i += 1) {
    const user = await createUser("member");
    crew.push(user.id);
    await invokeByName(
      "record.create",
      { object: PLACE, values: { name: `Crew ${i}`, visit, staff: user.id } },
      ctx(),
    );
  }
}, 180_000);

describe("moving a visit with its whole crew", () => {
  it(`moves ${TIMES_FOLLOWERS_MAX} crew places far inside D1's limits`, async () => {
    queries = 0;
    await invokeByName(
      "record.update",
      {
        object: VISIT,
        id: visit,
        values: { startsAt: "2031-06-03T09:00:00.000Z", endsAt: "2031-06-03T17:00:00.000Z" },
      },
      ctx(),
    );
    // Measured at about 14 a crew place (360 for 25); D1 allows 1,000 per invocation, and the
    // tool that moves a visit does more in the same call.
    expect(queries).toBeLessThan(450);
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT starts FROM core_staff_time WHERE account_id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(crew))
      .all<{ starts: number }>();
    expect(results).toEqual([{ starts: Date.parse("2031-06-03T09:00:00.000Z") / 1000 }]);
  });
});
