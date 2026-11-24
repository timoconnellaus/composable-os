// Stage 58 step 1 (ADR 0850): what recording time costs, however long a person's history, and
// what one minute-cron tick costs with many entries whose finish is missing. A person with 3,000
// past entries (one a day) and another with none: starting the clock checks for an overlap by the
// entries that end after it starts (by account and end), never the history, so the two cost the
// same. Sixty people left open with no shift: one tick marks at most fifty and stays well under
// D1's 1,000 statements per invocation (the local runtime does not enforce it).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, runStaffingDue } from "../src/index.ts";
import { extId } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

let rowsRead = 0;
let statements = 0;

/** env.DB, counting every statement prepared (read or in a batch) and meta.rows_read. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        statements += 1;
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
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
      return (list: D1PreparedStatement[]) => target.batch(list);
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

const ext = extId("timecost");
const NOW = "2026-06-20T10:00:00.000Z";
const HISTORY_DAYS = 3000;
const LEFT_OPEN = 60;

const installed = {
  grantable: [`${ext}:manage`],
  restricted: [`${ext}:manage`],
  settings: { recordsTime: { type: "boolean", label: "Staff record their time", default: true } },
  staffing: { rosters: `${ext}:manage`, settings: { recordsTime: "recordsTime" } },
};

let extUser: ActingUser;
let history: ActingUser;
let fresh: ActingUser;
const tool = (user: ActingUser) =>
  context(extUser, {
    db,
    actor: "extension",
    clock: () => new Date(NOW),
    extension: {
      id: ext,
      permissions: { operations: ["staffing.time.clockIn"], objects: {} } as never,
      tool: {
        name: "time",
        humanOnly: true,
        permission: "records:write",
        calledBy: { account: user.id, actor: "human" },
      },
    },
  });

const entry = (id: string, account: string, starts: number, ends: number | null, date: string) =>
  env.DB.prepare(
    "INSERT INTO core_time_entry (id, account_id, starts, ends, zone, local_date, how, state, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'UTC', ?, 'clocked', ?, ?, ?, ?)",
  ).bind(id, account, starts, ends, date, ends === null ? "open" : "approved", account, NOW, NOW);

beforeAll(async () => {
  const admin = await createUser("admin");
  extUser = await createUser("member");
  history = await createUser("member");
  fresh = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  const now = Date.parse(NOW) / 1000;
  const list: D1PreparedStatement[] = [];
  for (let d = 1; d <= HISTORY_DAYS; d++) {
    const starts = now - d * 86_400;
    const date = new Date(starts * 1000).toISOString().slice(0, 10);
    list.push(entry(`tme_hist${d}`, history.id, starts, starts + 3600, date));
  }
  for (let i = 0; i < LEFT_OPEN; i++) {
    const who = await createUser("member");
    list.push(entry(`tme_left${i}`, who.id, now - 15 * 3600, null, "2026-06-19"));
  }
  for (let i = 0; i < list.length; i += 200) await env.DB.batch(list.slice(i, i + 200));
}, 240_000);

async function startCost(user: ActingUser) {
  statements = 0;
  rowsRead = 0;
  await invokeByName("staffing.time.clockIn", { against: null }, tool(user));
  return { statements, rowsRead };
}

describe("recording time with years of entries", () => {
  it("a start reads the entries that end after it, not the history: the same as a person with none", async () => {
    const without = await startCost(fresh);
    const withHistory = await startCost(history);
    expect(withHistory.statements).toBeLessThan(60);
    // Without the account-and-end index the overlap check read the 3,000 past entries.
    expect(withHistory.rowsRead - without.rowsRead).toBeLessThan(50);
  });

  it("one cron tick marks at most fifty missing finishes, well under D1's statement limit", async () => {
    statements = 0;
    const first = await runStaffingDue(db, { clock: () => new Date(NOW) });
    expect(first.finishMissing).toBe(50);
    // Fifty guarded updates and their notices are written: counted, and bounded.
    expect(statements).toBeGreaterThan(50);
    expect(statements).toBeLessThan(1000);
    const second = await runStaffingDue(db, { clock: () => new Date(NOW) });
    expect(second.finishMissing).toBe(LEFT_OPEN - 50);
    const open = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_time_entry WHERE id LIKE 'tme_left%' AND finish_missing = 1",
    ).first<{ n: number }>();
    expect(open?.n).toBe(LEFT_OPEN);
  });
});
