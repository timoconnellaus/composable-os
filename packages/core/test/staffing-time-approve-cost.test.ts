// Stage 58 step 2 (ADR 0851): what approving and the differences cost. One approval of a hundred
// entries of a hundred people, each changed (an overlap check, a guarded update and a notice
// each), stays well under D1's 1,000 statements per invocation and binds at most 100 variables to
// any statement (the local runtime enforces neither). The differences over 62 days for 30 people
// counted by time, each with a year of entries and a year of shifts, read a fixed number of
// statements, whatever the people or dates, and only the range's rows.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

let rowsRead = 0;
let statements = 0;
let maxBound = 0;

/** env.DB, counting every statement prepared, the variables bound to each, and rows read. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        statements += 1;
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  maxBound = Math.max(maxBound, args.length);
                  return wrap(s.bind(...args));
                };
              }
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
    if (prop === "batch") return (list: D1PreparedStatement[]) => target.batch(list);
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

const ext = extId("apprcost");
const DUTY = `${ext}.duty`;
const NOW = "2026-06-20T10:00:00.000Z";
const PEOPLE = 100;
const COUNTED = 30;
const DAYS = 365;

const objects = {
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
      kind: { type: "relation", label: "Duty", to: `${ext}.kind` },
      staff: { type: "user", label: "Staff" },
      startsAt: { type: "datetime", label: "Starts at" },
      endsAt: { type: "datetime", label: "Ends at" },
      state: {
        type: "select",
        label: "State",
        options: [{ value: "scheduled", label: "Scheduled" }],
      },
    },
    states: { field: "state", initial: "scheduled", moves: [] },
    staffed: {
      who: { field: "staff" },
      starts: "startsAt",
      ends: "endsAt",
      kind: "kind",
      live: ["scheduled"],
    },
  },
};
const installed = {
  grantable: [`${ext}:manage`],
  restricted: [`${ext}:manage`],
  settings: { recordsTime: { type: "boolean", label: "Staff record their time", default: true } },
  staffing: { rosters: `${ext}:manage`, settings: { recordsTime: "recordsTime" } },
};

let extUser: ActingUser;
let manager: ActingUser;
const people: ActingUser[] = [];
const tool = (user: ActingUser, operation: string) =>
  context(extUser, {
    db,
    actor: "extension",
    clock: () => new Date(NOW),
    extension: {
      id: ext,
      permissions: { operations: [operation], objects: {} } as never,
      tool: {
        name: "time",
        humanOnly: true,
        permission: "records:write",
        calledBy: { account: user.id, actor: "human" },
      },
    },
  });

const now = Date.parse(NOW) / 1000;
const dateOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
  const admin = await createUser("admin");
  extUser = await createUser("member");
  manager = await createUser("member");
  await env.DB.prepare("UPDATE core_user SET kind = 'extension' WHERE id = ?")
    .bind(extUser.id)
    .run();
  await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
    .bind(JSON.stringify([`${ext}:manage`]), manager.id)
    .run();
  await reconcile(manifest(ext, { objects } as never), NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  const list: D1PreparedStatement[] = [];
  for (let i = 0; i < PEOPLE; i++) {
    const who = await createUser("member");
    people.push(who);
    // One waiting entry yesterday, 09:00 to 12:00 UTC.
    const starts = now - 86_400 - 3600;
    list.push(
      env.DB.prepare(
        "INSERT INTO core_time_entry (id, account_id, starts, ends, zone, local_date, how, state, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'UTC', ?, 'entered', 'waiting', ?, ?, ?)",
      ).bind(`tme_wait${i}`, who.id, starts, starts + 3 * 3600, dateOf(starts), who.id, NOW, NOW),
    );
  }
  for (let i = 0; i < COUNTED; i++) {
    const who = people[i] as ActingUser;
    list.push(
      env.DB.prepare(
        "INSERT INTO core_staff_pay_basis (account_id, from_date, basis, set_by, set_at) VALUES (?, '2025-01-01', 'by_time', ?, ?)",
      ).bind(who.id, admin.id, NOW),
    );
    // A year of shifts (06:00 to 08:00) and entries against every other one, before yesterday.
    for (let d = 2; d <= DAYS; d++) {
      const day = now - d * 86_400 - 4 * 3600;
      list.push(
        env.DB.prepare(
          "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) VALUES (?, ?, ?, ?, ?)",
        ).bind(DUTY, `shift_${i}_${d}`, who.id, day, day + 7200),
      );
      if (d % 2 === 0) {
        list.push(
          env.DB.prepare(
            "INSERT INTO core_time_entry (id, account_id, starts, ends, zone, local_date, against_object, against_record, how, state, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'UTC', ?, ?, ?, 'entered', 'approved', ?, ?, ?)",
          ).bind(
            `tme_y${i}_${d}`,
            who.id,
            day,
            day + 7200,
            dateOf(day),
            DUTY,
            `shift_${i}_${d}`,
            who.id,
            NOW,
            NOW,
          ),
        );
      }
    }
  }
  for (let i = 0; i < list.length; i += 500) await env.DB.batch(list.slice(i, i + 500));
}, 600_000);

describe("approving and the differences at size", () => {
  it("one approval of a hundred changed entries stays under D1's limits", async () => {
    statements = 0;
    maxBound = 0;
    const ids = people.map((_, i) => `tme_wait${i}`);
    const day = dateOf(now - 86_400 - 3600);
    const done = (await invokeByName(
      "staffing.time.approve",
      { ids, changes: ids.map((id) => ({ id, startsAt: `${day}T09:00`, endsAt: `${day}T11:30` })) },
      tool(manager, "staffing.time.approve"),
    )) as { approved: { state: string; recorded: unknown }[] };
    expect(done.approved).toHaveLength(PEOPLE);
    expect(done.approved.every((e) => e.state === "approved" && e.recorded)).toBe(true);
    expect(statements).toBeGreaterThan(PEOPLE * 2);
    expect(statements).toBeLessThan(1000);
    expect(maxBound).toBeLessThanOrEqual(100);
  });

  it("the differences over 62 days read a fixed number of statements and the range's rows only", async () => {
    const read = async (from: string, to: string) => {
      statements = 0;
      rowsRead = 0;
      maxBound = 0;
      const answer = (await invokeByName(
        "staffing.time.differences",
        { from, to },
        tool(manager, "staffing.time.differences"),
      )) as { items: { notRecorded: boolean }[] };
      return { answer, statements, rowsRead, maxBound };
    };
    const short = await read(dateOf(now - 10 * 86_400), dateOf(now - 4 * 86_400));
    const long = await read(dateOf(now - 63 * 86_400), dateOf(now - 2 * 86_400));
    // Every other shift has no entry: flagged for each of the thirty people.
    expect(long.answer.items.filter((d) => d.notRecorded).length).toBeGreaterThanOrEqual(
      COUNTED * 29,
    );
    expect(long.statements).toBeLessThan(60);
    expect(long.statements - short.statements).toBeLessThanOrEqual(2);
    expect(long.maxBound).toBeLessThanOrEqual(100);
    // A year of shifts and entries is in the tables: a week's read reads far fewer rows than a
    // year holds, and 62 days' grows with the range, never with the history.
    const year = COUNTED * DAYS * 1.5;
    expect(short.rowsRead).toBeLessThan(year / 4);
    expect(long.rowsRead / short.rowsRead).toBeLessThan((62 / 7) * 1.5);
  });
});
