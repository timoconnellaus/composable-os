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

const PEOPLE = 3000;
let rowsRead = 0;

/** env.DB, counting meta.rows_read for every statement Kysely runs. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all") {
                return async () => {
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
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

let member: ActingUser;
let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await seedDatabase(env.DB, { people: PEOPLE, organisations: 600, activities: 600, tasks: 400 });
}, 120_000);

async function read(name: string, input: unknown, user = member): Promise<number> {
  rowsRead = 0;
  await invokeByName(name, input, { actor: "human", user, origin: { surface: "ui" }, db });
  return rowsRead;
}

describe("rows read on hot paths", () => {
  it("list pages in the default order walk the sort index", async () => {
    // Includes one read of sqlite_master, a row per table, index and trigger: routine mail's log
    // and marks (migration 0750) and stage 44's acceptances (migration 0851) took person.list
    // from about 985 to about 1,030; stage 45's offers (migration 0812) to about 1,054; stage 44
    // step 4's copies (migration 0854, a table, an index and its triggers) to about 1,065; stage
    // 45's pay periods (migration 0813: four tables, five indexes, twelve triggers) to about 1,087;
    // stage 45's checklists (migration 0815: five tables, seven indexes, ten triggers) to about 1,124;
    // a child's paper copy to the guardian (migration 0857: an index, four triggers) to about 1,140;
    // stage 44 step 7's cooling off (migration 0856: a column, a table, four indexes and its key's
    // autoindex, three triggers): 1,138 measured on the merged tree; stage 34's adjustments
    // (migration 0950: a table and its key's autoindex, an index, four triggers, three views made
    // again): 1,166 measured on the merged tree.
    expect(await read("person.list", { limit: 50 })).toBeLessThan(1_185);
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
