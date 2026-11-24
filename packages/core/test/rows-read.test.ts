// D1 bills rows read, i.e. rows scanned, not rows returned (docs/research/cloudflare-cost-audit.md).
// These budgets hold the hot read paths to their index plans on a seeded database. Before
// migration 0050 a 50-row person.list scanned every person about four times over, and
// search.global's hydration scanned every person once.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { seedDatabase } from "@composable-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { createUser } from "./helpers.ts";
import { meterRowsRead } from "./rows-read-meter.ts";

const PEOPLE = 3000;
const meter = meterRowsRead(env.DB);
const db = createCrmDb(meter.db);

let member: ActingUser;
let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await seedDatabase(env.DB, { people: PEOPLE, organisations: 600, activities: 600, tasks: 400 });
}, 120_000);

/** The rows a call reads itself. A cold call may scan sqlite_master once (the schema cache). */
async function read(name: string, input: unknown, user = member): Promise<number> {
  meter.reset();
  await invokeByName(name, input, { actor: "human", user, origin: { surface: "ui" }, db });
  expect(meter.schemaScans, name).toBeLessThanOrEqual(1);
  return meter.rows;
}

describe("rows read on hot paths", () => {
  it("list pages in the default order walk the sort index", async () => {
    // The page itself, about 420 rows; a cold call's one scan of sqlite_master (the schema
    // cache, about 720 rows in November 2026) is counted apart. A warm call never scans it.
    expect(await read("person.list", { limit: 50 })).toBeLessThan(500);
    expect(await read("person.list", { limit: 50 })).toBeLessThan(500);
    expect(meter.schemaScans).toBe(0);
    expect(await read("organisation.list", { limit: 50 })).toBeLessThan(1_050);
    expect(await read("activity.list", { limit: 50 })).toBeLessThan(1_500);
    expect(await read("task.list", { limit: 50 })).toBeLessThan(1_050);
  });

  it("other sorts order ids first instead of computing every view column for every row", async () => {
    const rows = await read("person.list", {
      limit: 50,
      sort: { field: "createdAt", direction: "desc" },
    });
    // One pass over people (plus the primary-affiliation join), not ~9 rows per person.
    expect(rows).toBeLessThan(PEOPLE * 3);
  });

  it("search hydrates hits by primary key", async () => {
    expect(await read("search.global", { query: "ada" })).toBeLessThan(1_500);
  });

  it("the Trash reads only trashed rows", async () => {
    expect(await read("trash.list", {}, admin)).toBeLessThan(100);
  });
});
