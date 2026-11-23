// Stage 45 step 2 (ADR 0621), what the time claim costs for a coach with a long history: 2,000 past
// classes. A new class reads a handful of rows (the claims index is by account and end, so past
// shifts are never read); giving the profile another account is a few queries, not one per class
// (D1 allows 1,000 per invocation); a reconcile's clash check is one pass per account.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  type InvocationContext,
  invokeByName,
  objectTableOf,
} from "../src/index.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
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
const COACH = `${ext}.coach`;
const KLASS = `${ext}.klass`;
const NOW = "2026-06-01T00:00:00.000Z";
const HISTORY = 2000;
const fixture = manifest(ext, {
  objects: {
    coach: {
      label: "Coach",
      plural: "Coaches",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        user: { type: "user", label: "Staff account" },
      },
      unique: [{ fields: ["user"] }],
    },
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        coach: { type: "relation", label: "Coach", to: `${ext}.coach` },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "done", label: "Done" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "done", by: ["staff", "host"], final: true }],
      },
      staffed: {
        who: { field: "coach", account: "user" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled", "done"],
      },
    },
  },
});

let admin: ActingUser;
let coachUser: ActingUser;
let profile: string;
const ctx = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  clock: () => new Date(NOW),
});

beforeAll(async () => {
  admin = await createUser("admin");
  coachUser = await createUser("member");
  await reconcile(fixture, NOW);
  const made = await invokeByName(
    "record.create",
    { object: COACH, values: { name: "Long-serving", user: coachUser.id } },
    ctx(),
  );
  profile = (made as { id: string }).id;
  // 2,000 past classes, one a day back from the day before NOW, written straight to the table
  // (the trigger makes each claim).
  const object = getObject(KLASS);
  const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
  const table = objectTableOf(KLASS) as string;
  const statements: D1PreparedStatement[] = [];
  for (let i = 1; i <= HISTORY; i += 1) {
    const day = new Date(Date.parse(NOW) - i * 86_400_000);
    const starts = new Date(day.getTime() + 6 * 3_600_000).toISOString();
    const ends = new Date(day.getTime() + 7 * 3_600_000).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("startsAt")}, ${col("endsAt")}, ${col("coach")}, ${col("state")}) VALUES (?, ?, ?, 'Past', ?, ?, ?, 'done')`,
      ).bind(`past${i}`, NOW, NOW, starts, ends, profile),
    );
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  const held = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ?",
  )
    .bind(coachUser.id)
    .first<{ n: number }>();
  expect(held?.n).toBe(HISTORY);
}, 180_000);

describe("the time claim's cost with a long history", () => {
  it("a new class for an account with 2,000 past claims reads a handful of claims", async () => {
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ? AND ends > ? AND starts < ?",
    )
      .bind(coachUser.id, Date.parse(NOW) / 1000 + 3600, Date.parse(NOW) / 1000 + 7200)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    // The overlap check alone, as the trigger and the read before the write run it.
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM core_staff_time c WHERE c.account_id = ? AND c.ends > ? AND c.starts < ?",
    )
      .bind(coachUser.id, 1, 2)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("core_staff_time_account");
    rowsRead = 0;
    await invokeByName(
      "record.create",
      {
        object: KLASS,
        values: {
          name: "Tomorrow",
          coach: profile,
          startsAt: "2026-06-02T06:00:00.000Z",
          endsAt: "2026-06-02T07:00:00.000Z",
        },
      },
      ctx(),
    );
    // Without the index by end this read every past claim (2,004 rows for the claim alone).
    expect(rowsRead).toBeLessThan(400);
  });

  it("giving the profile another account is a few queries, not one per class", async () => {
    const next = await createUser("member");
    queries = 0;
    rowsRead = 0;
    await invokeByName(
      "record.update",
      { object: COACH, id: profile, values: { user: next.id } },
      ctx(),
    );
    expect(queries).toBeLessThan(60);
    // Re-deriving the 2,000 claims in order of start: a few rows each (2.0M rows before).
    expect(rowsRead).toBeLessThan(60_000);
    const held = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ?",
    )
      .bind(next.id)
      .first<{ n: number }>();
    expect(held?.n).toBe(HISTORY + 1);
  });

  it("the reconcile's clash check over the history is one pass", async () => {
    const started = Date.now();
    const planned = await plan(fixture, NOW);
    expect(planned.issues).toEqual([]);
    // A pair of every two shifts took 1.7 s for this one account.
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
