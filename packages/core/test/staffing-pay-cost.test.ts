// Stage 45 step 6 (ADR 0627), what a pay period costs for a business with years of shifts: 3,000
// past duty shifts (three a day for 1,000 days) and a fortnight of 42. A period's totals and its
// lock read the period's shifts through the start index (never the history) and a few small
// tables; the lines are written a hundred to a statement (D1 allows 1,000 queries an invocation).
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

const ext = extId("paycost");
const DUTY = `${ext}.duty`;
const KIND = `${ext}.kind`;
const NOW = "2026-06-20T00:00:00.000Z";
const START = "2026-06-01";
const HISTORY_DAYS = 1000;
const fixture = manifest(ext, {
  objects: {
    kind: {
      label: "Kind",
      plural: "Kinds",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    duty: {
      label: "Duty shift",
      plural: "Duty shifts",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        kind: { type: "relation", label: "Kind", to: `${ext}.kind` },
        staff: { type: "user", label: "Staff" },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [{ from: "scheduled", to: "cancelled", by: ["staff"] }],
      },
      staffed: {
        who: { field: "staff" },
        starts: "startsAt",
        ends: "endsAt",
        kind: "kind",
        live: ["scheduled"],
      },
      indexes: [["startsAt"]],
    },
  },
});

let admin: ActingUser;
let extUser: ActingUser;
const tool = (): InvocationContext => ({
  actor: "extension",
  user: extUser,
  origin: { surface: "ui" },
  db,
  clock: () => new Date(NOW),
  extension: {
    id: ext,
    permissions: {
      operations: ["staffing.payPeriod.totals", "staffing.payPeriod.lock"],
      objects: {},
    } as never,
    tool: {
      name: "pay",
      humanOnly: true,
      permission: `${ext}:pay`,
      calledBy: { account: admin.id, actor: "human" },
    },
  },
});

beforeAll(async () => {
  admin = await createUser("admin");
  extUser = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(
      ext,
      JSON.stringify({
        grantable: [`${ext}:manage`, `${ext}:pay`],
        settings: { payPeriod: { type: "select", label: "Pay period", default: "fortnightly" } },
        staffing: {
          rosters: `${ext}:manage`,
          pays: `${ext}:pay`,
          settings: {
            payPeriod: "payPeriod",
            payPeriodStart: "payPeriodStart",
            payPeriodDay: "payPeriodDay",
          },
        },
      }),
      admin.id,
      NOW,
      NOW,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO core_extension_settings (extension_id, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify({ payPeriodStart: START }), NOW, admin.id)
    .run();
  const staff: string[] = [];
  for (let i = 0; i < 3; i++) {
    const user = await createUser("member");
    staff.push(user.id);
    await env.DB.prepare(
      "INSERT INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2020-01-01', 'by_time', ?, ?)",
    )
      .bind(user.id, admin.id, NOW)
      .run();
  }
  const made = (await invokeByName(
    "record.create",
    { object: KIND, values: { name: "Cleaning" } },
    { actor: "human", user: admin, origin: { surface: "ui" }, db },
  )) as { id: string };
  const object = getObject(DUTY);
  const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
  const table = objectTableOf(DUTY) as string;
  const statements: D1PreparedStatement[] = [];
  // Three a day (one per person), from 1,000 days before the period to its last day.
  const first = Date.parse("2026-06-15T00:00:00.000Z") - HISTORY_DAYS * 86_400_000;
  for (let d = 0; d < HISTORY_DAYS; d++) {
    for (let p = 0; p < 3; p++) {
      const starts = new Date(first + d * 86_400_000 + (6 + p) * 3_600_000).toISOString();
      const ends = new Date(Date.parse(starts) + 3_600_000).toISOString();
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("kind")}, ${col("staff")}, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES (?, ?, ?, 'Clean', ?, ?, ?, ?, 'scheduled')`,
        ).bind(`s${d}_${p}`, NOW, NOW, made.id, staff[p], starts, ends),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
}, 240_000);

describe("a pay period's cost with years of shifts", () => {
  it("its totals read the period's shifts, not the history", async () => {
    queries = 0;
    rowsRead = 0;
    const out = (await invokeByName("staffing.payPeriod.totals", { start: START }, tool())) as {
      lines: unknown[];
    };
    // UTC is the organisation's zone here: 1 to 14 June, three shifts a day.
    expect(out.lines).toHaveLength(42);
    expect(queries).toBeLessThan(40);
    // Without the start index this read every one of the 3,000 shifts.
    expect(rowsRead).toBeLessThan(600);
  });

  it("its lock reads the same, and writes its lines in a few statements", async () => {
    queries = 0;
    rowsRead = 0;
    const out = (await invokeByName("staffing.payPeriod.lock", { start: START }, tool())) as {
      version: number;
    };
    expect(out.version).toBe(1);
    expect(queries).toBeLessThan(80);
    expect(rowsRead).toBeLessThan(2_000);
    const lines = await env.DB.prepare("SELECT count(*) AS n FROM core_pay_line").first<{
      n: number;
    }>();
    expect(lines?.n).toBe(42);
  });

  it("a shift's write finds the locked periods through their index", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM core_pay_period pp WHERE pp.state IN ('locking', 'locked') AND pp.starts <= ? AND pp.ends > ?",
    )
      .bind(1, 1)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("core_pay_period_state");
  });
});
