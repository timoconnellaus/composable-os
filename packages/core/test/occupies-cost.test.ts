// Stage 49 step 2 (ADR 0765), what the claim on a room costs for a room with a long history:
// 2,000 past classes. A new class reads a handful of rows (the claims index is by thing and end,
// so past bookings are never read); marking the room "one booking at a time" again is one
// statement that derives its 2,000 claims in order of start, a few rows each; a series' date
// reads a few rows more for its room; a reconcile's clash check is one pass per room (D1 allows
// 1,000 queries per invocation, and the local runtime does not enforce it).
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

const ext = extId("occcost");
const ROOM = `${ext}.room`;
const SERIES = `${ext}.series`;
const KLASS = `${ext}.klass`;
// The host's clock; the history is years before any real clock (the triggers read the
// database's), the new records years after.
const NOW = "2031-06-01T00:00:00.000Z";
const HISTORY_ENDS = Date.parse("2025-01-01T00:00:00.000Z");
const HISTORY = 2000;
const fixture = manifest(ext, {
  objects: {
    room: {
      label: "Room",
      plural: "Rooms",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        exclusive: { type: "boolean", label: "One booking at a time" },
      },
    },
    series: {
      label: "Series",
      plural: "Series",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        weekdays: {
          type: "multiSelect",
          label: "Weekdays",
          options: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((value) => ({
            value,
            label: value,
          })),
        },
        time: { type: "text", label: "Time" },
        length: { type: "number", label: "Length" },
        firstDate: { type: "date", label: "First date" },
        timezone: { type: "timezone", label: "Time zone" },
        room: { type: "relation", label: "Room", to: `${ext}.room` },
      },
      recurring: {
        generates: "klass",
        link: "series",
        rule: {
          weekdays: "weekdays",
          time: "time",
          length: "length",
          from: "firstDate",
          zone: "timezone",
        },
        into: { starts: "startsAt", ends: "endsAt", zone: "timezone" },
        copy: { name: "name", room: "room" },
        cancel: "cancelled",
        horizonDays: 28,
      },
    },
    klass: {
      label: "Class",
      plural: "Classes",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        series: { type: "relation", label: "Series", to: `${ext}.series`, readOnly: true },
        startsAt: { type: "datetime", label: "Starts at" },
        endsAt: { type: "datetime", label: "Ends at" },
        timezone: { type: "timezone", label: "Time zone" },
        room: { type: "relation", label: "Room", to: `${ext}.room` },
        state: {
          type: "select",
          label: "State",
          options: [
            { value: "scheduled", label: "Scheduled" },
            { value: "cancelled", label: "Cancelled" },
            { value: "done", label: "Done" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "scheduled",
        moves: [
          { from: "scheduled", to: "cancelled", by: ["staff", "host"], final: true },
          { from: "scheduled", to: "done", by: ["staff", "host"], final: true },
        ],
      },
      occupies: {
        thing: "room",
        starts: "startsAt",
        ends: "endsAt",
        live: ["scheduled", "done"],
        only: "exclusive",
      },
    },
  },
});

let admin: ActingUser;
let room: string;
const ctx = (): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  clock: () => new Date(NOW),
});
const held = async () =>
  (
    await env.DB.prepare("SELECT count(*) AS n FROM core_thing_time WHERE thing_record = ?")
      .bind(room)
      .first<{ n: number }>()
  )?.n;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(fixture, NOW);
  const made = await invokeByName(
    "record.create",
    { object: ROOM, values: { name: "Private studio", exclusive: true } },
    ctx(),
  );
  room = (made as { id: string }).id;
  // 2,000 past classes, one a day, written straight to the table (the trigger makes each claim).
  const object = getObject(KLASS);
  const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
  const table = objectTableOf(KLASS) as string;
  const statements: D1PreparedStatement[] = [];
  for (let i = HISTORY; i >= 1; i -= 1) {
    const day = new Date(HISTORY_ENDS - i * 86_400_000);
    const starts = new Date(day.getTime() + 6 * 3_600_000).toISOString();
    const ends = new Date(day.getTime() + 7 * 3_600_000).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("startsAt")}, ${col("endsAt")}, ${col("room")}, ${col("state")}) VALUES (?, ?, ?, 'Past', ?, ?, ?, 'done')`,
      ).bind(`past${i}`, NOW, NOW, starts, ends, room),
    );
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  expect(await held()).toBe(HISTORY);
}, 180_000);

describe("the claim on a room's cost with a long history", () => {
  it("a new class in a room with 2,000 past claims reads a handful of claims", async () => {
    const explained = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM core_thing_time c WHERE c.thing_object = ? AND c.thing_record = ? AND c.ends > ? AND c.starts < ?",
    )
      .bind(ROOM, room, 1, 2)
      .all<{ detail: string }>();
    expect(explained.results.map((r) => r.detail).join(" ")).toContain("core_thing_time_thing");
    rowsRead = 0;
    queries = 0;
    await invokeByName(
      "record.create",
      {
        object: KLASS,
        values: {
          name: "Tomorrow",
          room,
          startsAt: "2031-06-02T06:00:00.000Z",
          endsAt: "2031-06-02T07:00:00.000Z",
        },
      },
      ctx(),
    );
    expect(rowsRead).toBeLessThan(400);
  });

  it("marking the room again is one statement, deriving 2,000 claims a few rows each", async () => {
    await invokeByName(
      "record.update",
      { object: ROOM, id: room, values: { exclusive: false } },
      ctx(),
    );
    expect(await held()).toBe(0);
    rowsRead = 0;
    queries = 0;
    await invokeByName(
      "record.update",
      { object: ROOM, id: room, values: { exclusive: true } },
      ctx(),
    );
    expect(await held()).toBe(HISTORY + 1);
    expect(queries).toBeLessThan(40);
    // A pair of every two claims would be 2M rows.
    expect(rowsRead).toBeLessThan(60_000);
  });

  it("a series' dates in the room read a few rows each for the room", async () => {
    const series = (await invokeByName(
      "record.create",
      {
        object: SERIES,
        values: {
          name: "Daily",
          weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          time: "08:00",
          length: 60,
          firstDate: "2031-06-03",
          timezone: "UTC",
          room,
        },
      },
      ctx(),
    )) as { id: string };
    rowsRead = 0;
    queries = 0;
    const result = (await invokeByName(
      "recurring.generate",
      { object: SERIES, id: series.id, limit: 25 },
      { ...ctx(), actor: "automation", origin: { surface: "system" } },
    )) as { made: number };
    expect(result.made).toBe(25);
    // 25 dates, each a record with its bookkeeping: the room adds two reads a date.
    expect(queries).toBeLessThan(25 * 20);
    expect(rowsRead).toBeLessThan(25 * 400);
  });

  it("the reconcile's clash check over the history is one pass", async () => {
    const started = Date.now();
    const planned = await plan(fixture, NOW);
    expect(planned.issues).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
