// Stage 45 step 5 (ADR 0628): what one fetch of a calendar feed costs, however long its person's
// history. A person with 3,000 past duty shifts (one a day for 3,000 days) and another with none,
// each with the same 30 shifts ahead: a fetch reads the claims that end after the feed's window
// opens (by account and end), never the history, so the two cost the same, and both a bounded few
// hundred rows. A calendar app polls this all day for every person, without a sign-in.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, getObject, invokeByName, objectTableOf } from "../src/index.ts";
import { feedTokenHash, newFeedToken, readStaffFeed } from "../src/staffing/feed.ts";
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
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

const ext = extId("feedcost");
const DUTY = `${ext}.duty`;
const KIND = `${ext}.kind`;
const NOW = "2026-06-20T00:00:00.000Z";
const HISTORY_DAYS = 3000;
const AHEAD = 30;
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
        place: { type: "text", label: "Place" },
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
        place: "place",
      },
      indexes: [["startsAt"]],
    },
  },
});

const installed = {
  id: ext,
  version: "1.0.0",
  tools: {
    feedRotate: {
      description: "A new feed address for yourself, shown once.",
      risk: "write",
      humanOnly: true,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
    },
  },
};

let history: string;
let fresh: string;

async function withFeed(user: ActingUser): Promise<string> {
  const token = newFeedToken();
  await env.DB.prepare(
    "INSERT INTO core_staff_feed (account_id, token_hash, tool, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(user.id, await feedTokenHash(token), `x.${ext}.feedRotate`, NOW)
    .run();
  return token;
}

beforeAll(async () => {
  const admin = await createUser("admin");
  const hist = await createUser("member");
  const none = await createUser("member");
  await reconcile(fixture, NOW);
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(ext, JSON.stringify(installed), admin.id, NOW, NOW)
    .run();
  const kind = (await invokeByName(
    "record.create",
    { object: KIND, values: { name: "Cleaning" } },
    { actor: "human", user: admin, origin: { surface: "ui" }, db: createCrmDb(env.DB) },
  )) as { id: string };
  const object = getObject(DUTY);
  const col = (f: string) => object?.fields.find((x) => x.name === f)?.column as string;
  const table = objectTableOf(DUTY) as string;
  const insert = (id: string, staff: string, startMs: number) =>
    env.DB.prepare(
      `INSERT INTO ${table} (id, created_at, updated_at, name, ${col("kind")}, ${col("staff")}, ${col("startsAt")}, ${col("endsAt")}, ${col("place")}, ${col("state")}) VALUES (?, ?, ?, 'Clean', ?, ?, ?, ?, 'Main floor', 'scheduled')`,
    ).bind(
      id,
      NOW,
      NOW,
      kind.id,
      staff,
      new Date(startMs).toISOString(),
      new Date(startMs + 3_600_000).toISOString(),
    );
  const statements: D1PreparedStatement[] = [];
  const now = Date.parse(NOW);
  for (let d = 1; d <= HISTORY_DAYS; d++) {
    statements.push(insert(`h${d}`, hist.id, now - d * 86_400_000 + 6 * 3_600_000));
  }
  for (let d = 1; d <= AHEAD; d++) {
    statements.push(insert(`hf${d}`, hist.id, now + d * 86_400_000 + 6 * 3_600_000));
    statements.push(insert(`nf${d}`, none.id, now + d * 86_400_000 + 9 * 3_600_000));
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  history = await withFeed(hist);
  fresh = await withFeed(none);
}, 240_000);

async function fetchCost(token: string) {
  queries = 0;
  rowsRead = 0;
  const feed = await readStaffFeed(db.query, token, new Date(NOW));
  return { shifts: feed?.shifts.length ?? -1, queries, rowsRead };
}

describe("a calendar feed's cost with years of shifts", () => {
  it("reads the window's claims, not the history: the same as a person with none", async () => {
    // Once each, so the registry is loaded for both alike.
    await fetchCost(fresh);
    const withHistory = await fetchCost(history);
    const without = await fetchCost(fresh);
    // Fourteen days back and every shift ahead.
    expect(withHistory.shifts).toBe(14 + AHEAD);
    expect(without.shifts).toBe(AHEAD);
    expect(withHistory.queries).toBeLessThan(20);
    // Without the claims' account-and-end index this read the 3,000 past shifts.
    expect(withHistory.rowsRead).toBeLessThan(600);
    expect(withHistory.rowsRead - without.rowsRead).toBeLessThan(100);
  });

  it("a made-up token costs one indexed lookup", async () => {
    const out = await fetchCost(newFeedToken());
    expect(out.shifts).toBe(-1);
    expect(out.queries).toBe(1);
    expect(out.rowsRead).toBeLessThanOrEqual(1);
  });
});
