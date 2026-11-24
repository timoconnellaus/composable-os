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
/** A later period: 10,000 shifts, the most one period totals. */
const BUSY = "2026-06-29";
let me: string;
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
  // A later period (29 June to 12 July, two after START) at the most a period totals: 10,000
  // shifts, 200 each for 50 people, every one an hour long and 100 minutes after the last. The
  // first three are the people with 1,000 days of history above.
  const crowd = [...staff];
  while (crowd.length < 50) {
    const user = await createUser("member");
    crowd.push(user.id);
    await env.DB.prepare(
      "INSERT INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2020-01-01', 'by_time', ?, ?)",
    )
      .bind(user.id, admin.id, NOW)
      .run();
  }
  me = crowd[0] as string;
  const busy: D1PreparedStatement[] = [];
  const from = Date.parse(`${BUSY}T00:00:00.000Z`);
  for (const [p, account] of crowd.entries()) {
    for (let i = 0; i < 200; i++) {
      const starts = new Date(from + (i * 100 + (p % 40)) * 60_000).toISOString();
      const ends = new Date(Date.parse(starts) + 3_600_000).toISOString();
      busy.push(
        env.DB.prepare(
          `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("kind")}, ${col("staff")}, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES (?, ?, ?, 'Busy', ?, ?, ?, ?, 'scheduled')`,
        ).bind(`b${p}_${i}`, NOW, NOW, made.id, account, starts, ends),
      );
    }
  }
  for (let i = 0; i < busy.length; i += 200) await env.DB.batch(busy.slice(i, i + 200));
}, 600_000);

/** A person's own read through the pay-period pack's tool (the owner's decision of 2026-11-24). */
const own = (): InvocationContext => {
  const ctx = tool();
  return {
    ...ctx,
    extension: {
      ...(ctx.extension as NonNullable<InvocationContext["extension"]>),
      permissions: {
        operations: ["staffing.myPay", "staffing.myPay.periods"],
        objects: {},
      } as never,
      tool: {
        name: "myPay",
        humanOnly: true,
        permission: `${ext}:team`,
        calledBy: { account: me, actor: "human" },
      },
    },
  };
};

describe("a person's own totals at the largest input (the owner's decision of 2026-11-24)", () => {
  it("a person with 1,000 days of history, in a period of 10,000 shifts, reads their own only", async () => {
    queries = 0;
    rowsRead = 0;
    const out = (await invokeByName("staffing.myPay", { start: BUSY }, own())) as {
      lines: unknown[];
      minutes: number;
    };
    expect(out.lines).toHaveLength(200);
    expect(out.minutes).toBe(200 * 60);
    // Far below D1's 1,000 a call (23 when written): their own shifts and a few small tables.
    expect(queries).toBeLessThan(40);
    // Their own shifts (1,655 rows read when written), never the period's other 9,800 shifts or
    // the 3,000 of history.
    expect(rowsRead).toBeLessThan(5_000);
  });

  it("the periods list is a handful of statements", async () => {
    queries = 0;
    const out = (await invokeByName("staffing.myPay.periods", {}, own())) as {
      periods: unknown[];
    };
    expect(out.periods).toHaveLength(13);
    expect(queries).toBeLessThan(20);
  });
});

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

  it("a shift's write reads a few periods however many are locked (the review of PR #287)", async () => {
    const object = getObject(DUTY);
    const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
    const table = objectTableOf(DUTY) as string;
    const move = async (hour: number) =>
      (
        await env.DB.prepare(
          `UPDATE ${table} SET ${col("startsAt")} = ?, ${col("endsAt")} = ? WHERE id = 'future1'`,
        )
          .bind(
            `2026-12-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
            `2026-12-01T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
          )
          .run()
      ).meta.rows_read;
    await env.DB.prepare(
      `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES ('future1', ?, ?, 'Later', '2026-12-01T00:00:00.000Z', '2026-12-01T01:00:00.000Z', 'scheduled')`,
    )
      .bind(NOW, NOW)
      .run();
    // 300 fortnights locked in 2000 to 2011, years of payroll.
    const base = Date.UTC(2000, 0, 3) / 1000;
    for (let i = 0; i < 300; i += 50) {
      const batch: D1PreparedStatement[] = [];
      for (let j = i; j < i + 50; j++) {
        const s = base + j * 14 * 86_400;
        const e = s + 14 * 86_400;
        const sd = new Date(s * 1000).toISOString().slice(0, 10);
        const ed = new Date((e - 86_400) * 1000).toISOString().slice(0, 10);
        batch.push(
          env.DB.prepare(
            "INSERT INTO core_pay_period (id, start_date, end_date, zone, starts, ends, version, state, locked_by, locked_at) VALUES (?, ?, ?, 'UTC', ?, ?, 1, 'locking', 'x', 'x')",
          ).bind(`ppcost${j}`, sd, ed, s, e),
          env.DB.prepare("UPDATE core_pay_period SET state = 'locked' WHERE id = ?").bind(
            `ppcost${j}`,
          ),
        );
      }
      await env.DB.batch(batch);
    }
    // A future shift moved: the lock's check reads the periods ending after it starts, none.
    const rows = await move(2);
    expect(rows).toBeLessThan(60);
  });

  it("a shift's write finds the locked periods through their index", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM core_pay_period pp WHERE pp.state IN ('locking', 'locked') AND pp.starts <= ? AND pp.ends > ?",
    )
      .bind(1, 1)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(
      /core_pay_period_state \(state=\? AND ends>\?\)/,
    );
  });
});
