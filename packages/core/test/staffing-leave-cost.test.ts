// Stage 58 step 4 (ADR 0853), what approving leave costs at its largest: a cleaner with 1,000 days
// of past shifts on leave over 40 future shifts (the most one approval takes someone off), of four
// kinds in turn, each kind with 100 qualified colleagues (the most an offer reads, ELIGIBLE_MAX):
// 400 people offered something. The approval is one batch: each shift's record write
// and offer, the notices, the balance entry and the unavailability row; it reads the leave's
// shifts through the claims index (never the history), and stays well inside D1's 1,000 queries
// an invocation. A request's days are one statement with one bound value, however many.
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
import { ELIGIBLE_MAX } from "../src/staffing/eligibility.ts";
import { MAX_TAKEN_OFF } from "../src/staffing/leave.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { createUser } from "./helpers.ts";

let rowsRead = 0;
let queries = 0;
let mostBound = 0;

/** env.DB, counting meta.rows_read, statements and the most values bound to one. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  mostBound = Math.max(mostBound, args.length);
                  return wrap(s.bind(...args));
                };
              }
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

const ext = extId("lvcost");
const DUTY = `${ext}.duty`;
const KIND = `${ext}.kind`;
const NOW = "2026-06-01T00:00:00.000Z";
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
let cleaner: string;
let annual: string;
const LEAVE = [
  "staffing.leave.pending",
  "staffing.leave.saveType",
  "staffing.leave.request",
  "staffing.leave.approve",
  "staffing.leave.setBalance",
];
const tool = (account: string): InvocationContext => ({
  actor: "extension",
  user: extUser,
  origin: { surface: "ui" },
  db,
  clock: () => new Date(NOW),
  extension: {
    id: ext,
    permissions: { operations: LEAVE, objects: {} } as never,
    tool: {
      name: "leave",
      humanOnly: true,
      permission: `${ext}:manage`,
      calledBy: { account, actor: "human" },
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
        staffing: { rosters: `${ext}:manage`, pays: `${ext}:pay` },
      }),
      admin.id,
      NOW,
      NOW,
    )
    .run();
  cleaner = (await createUser("member")).id;
  const kinds: string[] = [];
  for (const name of ["Cleaning", "Front desk", "Opening", "Closing"]) {
    const made = (await invokeByName(
      "record.create",
      { object: KIND, values: { name } },
      { actor: "human", user: admin, origin: { surface: "ui" }, db },
    )) as { id: string };
    kinds.push(made.id);
  }
  const people: D1PreparedStatement[] = [];
  for (const [k, kindId] of kinds.entries()) {
    for (let i = 0; i < ELIGIBLE_MAX; i++) {
      const id = `usr_lvcost_${k}_${i}`;
      people.push(
        env.DB.prepare(
          "INSERT INTO core_user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 1, 'member', ?, ?)",
        ).bind(id, `Colleague ${k} ${i}`, `${id}@example.com`, NOW, NOW),
        env.DB.prepare(
          "INSERT INTO core_staff_qualification (account_id, kind_object, kind_record, set_by, set_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(id, KIND, kindId, admin.id, NOW),
      );
    }
  }
  for (let i = 0; i < people.length; i += 200) await env.DB.batch(people.slice(i, i + 200));
  const object = getObject(DUTY);
  const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
  const table = objectTableOf(DUTY) as string;
  const insert = (id: string, staff: string, starts: string, kindId = kinds[0] as string) =>
    env.DB.prepare(
      `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("kind")}, ${col("staff")}, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES (?, ?, ?, 'Clean', ?, ?, ?, ?, 'scheduled')`,
    ).bind(
      id,
      NOW,
      NOW,
      kindId,
      staff,
      starts,
      new Date(Date.parse(starts) + 3_600_000).toISOString(),
    );
  const statements: D1PreparedStatement[] = [];
  // A shift a day for 1,000 days before now.
  const first = Date.parse(NOW) - HISTORY_DAYS * 86_400_000;
  for (let d = 0; d < HISTORY_DAYS; d++) {
    statements.push(insert(`h${d}`, cleaner, new Date(first + d * 86_400_000).toISOString()));
  }
  // Two a day for 20 days from 8 June, the four kinds in turn: the leave's 40.
  const leave = Date.parse("2026-06-08T00:00:00.000Z");
  for (let d = 0; d < 20; d++) {
    for (const h of [1, 4]) {
      statements.push(
        insert(
          `f${d}_${h}`,
          cleaner,
          new Date(leave + d * 86_400_000 + h * 3_600_000).toISOString(),
          kinds[(d * 2 + (h === 1 ? 0 : 1)) % kinds.length],
        ),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  annual = (
    (await invokeByName(
      "staffing.leave.saveType",
      { name: "Annual", unit: "hours", keepsBalance: true, belowZero: "warn", paid: true },
      tool(admin.id),
    )) as { type: { id: string } }
  ).type.id;
}, 600_000);

describe("approving leave at its largest", () => {
  it(`a request of 62 days is one statement for its days`, async () => {
    queries = 0;
    mostBound = 0;
    const extra = await createUser("member");
    const out = (await invokeByName(
      "staffing.leave.request",
      { type: annual, startDate: "2026-09-01", endDate: "2026-11-01" },
      tool(extra.id),
    )) as { request: { days: unknown[] } };
    expect(out.request.days.length).toBe(62);
    expect(mostBound).toBeLessThan(100);
    expect(queries).toBeLessThan(40);
  });

  it(`taking someone off ${MAX_TAKEN_OFF} shifts of four kinds, each offered to 100 people, stays well inside D1's limits`, async () => {
    const asked = (await invokeByName(
      "staffing.leave.request",
      { type: annual, startDate: "2026-06-08", endDate: "2026-06-27" },
      tool(cleaner),
    )) as { request: { id: string }; shiftCount: number };
    expect(asked.shiftCount).toBe(MAX_TAKEN_OFF);
    queries = 0;
    rowsRead = 0;
    mostBound = 0;
    const done = (await invokeByName(
      "staffing.leave.approve",
      { id: asked.request.id },
      tool(admin.id),
    )) as { offered: { told: number }[] };
    expect(done.offered.length).toBe(MAX_TAKEN_OFF);
    expect(done.offered.every((o) => o.told === ELIGIBLE_MAX)).toBe(true);
    // Each of the 400 told once, with their ten shifts.
    const told = await env.DB.prepare(
      "SELECT count(*) AS n, count(DISTINCT user_id) AS people FROM core_notifications WHERE title = '10 shifts offered to you'",
    ).first<{ n: number; people: number }>();
    expect(told).toEqual({ n: 400, people: 400 });
    // Measured 2026-11-24; D1 allows 1,000 an invocation.
    expect(queries).toBeLessThan(800);
    expect(mostBound).toBeLessThan(100);
    // The 1,000 past shifts are never read.
    expect(rowsRead).toBeLessThan(40_000);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_staff_time WHERE account_id = ? AND starts > ?",
    )
      .bind(cleaner, Date.parse(NOW) / 1000)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    console.log(`leave approval: ${queries} queries, ${rowsRead} rows read`);
  });

  it(`more than ${MAX_TAKEN_OFF} covered shifts is refused whole, with what to do`, async () => {
    const other = await createUser("member");
    const object = getObject(DUTY);
    const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
    const table = objectTableOf(DUTY) as string;
    const kind = await env.DB.prepare(`SELECT id FROM ${objectTableOf(KIND)} LIMIT 1`).first<{
      id: string;
    }>();
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i <= MAX_TAKEN_OFF; i++) {
      const starts = new Date(Date.parse("2026-07-01T00:00:00.000Z") + i * 7_200_000).toISOString();
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("kind")}, ${col("staff")}, ${col("startsAt")}, ${col("endsAt")}, ${col("state")}) VALUES (?, ?, ?, 'Clean', ?, ?, ?, ?, 'scheduled')`,
        ).bind(
          `m${i}`,
          NOW,
          NOW,
          kind?.id,
          other.id,
          starts,
          new Date(Date.parse(starts) + 3_600_000).toISOString(),
        ),
      );
    }
    await env.DB.batch(statements);
    const asked = (await invokeByName(
      "staffing.leave.request",
      { type: annual, startDate: "2026-07-01", endDate: "2026-07-05" },
      tool(other.id),
    )) as { request: { id: string } };
    await expect(
      invokeByName("staffing.leave.approve", { id: asked.request.id }, tool(admin.id)),
    ).rejects.toMatchObject({ details: { rule: "leave_too_many_shifts" } });
  });

  it("the list of what waits reads a few rows a request, at its most (50)", async () => {
    const many = await createUser("member");
    for (let d = 0; d < 50; d++) {
      const day = new Date(Date.parse("2027-01-01T00:00:00.000Z") + d * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await invokeByName("staffing.leave.request", { type: annual, startDate: day }, tool(many.id));
    }
    queries = 0;
    const out = (await invokeByName("staffing.leave.pending", {}, tool(admin.id))) as {
      items: unknown[];
    };
    expect(out.items.length).toBe(50);
    expect(queries).toBeLessThan(200);
    console.log(`leave pending: ${queries} queries`);
  });
});
