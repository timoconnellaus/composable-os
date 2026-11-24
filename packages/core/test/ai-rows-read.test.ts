// Rows read by the stage 7a AI paths on a seeded database (cost audit U9, ADR 0153-0155): reading
// a summary, hybrid search, similar records, timeline one-liners and an embedding drain round walk
// indexes and primary keys, never whole tables. Writes add one queue statement, not a scan.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { seedDatabase } from "@composable-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  drainAllEmbeddings,
  drainEmbeddingQueue,
  type InvocationContext,
  invokeByName,
  memoryVectorStore,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
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
              if (p === "all" || p === "run") {
                return async () => {
                  const result = await (s[p] as () => Promise<D1Result>)();
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
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
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
const { models } = testRunner();
const vectors = memoryVectorStore();

let member: ActingUser;
let personId: string;
let orgId: string;
let activityIds: string[];

function ctx(): InvocationContext {
  return { actor: "human", user: member, origin: { surface: "ui" }, db, models, vectors };
}

async function measure(name: string, input: unknown): Promise<number> {
  rowsRead = 0;
  await invokeByName(name, input, ctx());
  return rowsRead;
}

beforeAll(async () => {
  member = await createUser("member");
  await seedDatabase(env.DB, { people: PEOPLE, organisations: 600, activities: 600, tasks: 400 });
  const person = await env.DB.prepare(
    "SELECT id FROM core_person WHERE deleted_at IS NULL LIMIT 1",
  ).first<{ id: string }>();
  const org = await env.DB.prepare(
    "SELECT id FROM core_organisation WHERE deleted_at IS NULL LIMIT 1",
  ).first<{ id: string }>();
  personId = person?.id as string;
  orgId = org?.id as string;
  activityIds = (
    await env.DB.prepare("SELECT id FROM core_activity LIMIT 20").all<{ id: string }>()
  ).results.map((r) => r.id);
  // Embed the organisations so similar-records has vectors (seeded rows bypass the pipeline).
  await env.DB.prepare(
    "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) SELECT 'organisation', id, '2030-01-01' FROM core_organisation",
  ).run();
  await drainAllEmbeddings({ db: createCrmDb(env.DB), models, vectors }, 10);
}, 180_000);

describe("rows read on the AI paths", () => {
  it("summary.get reads the record, its links and the cache row by key", async () => {
    // The budget includes one read of sqlite_master, which grows by a row per table and index:
    // migration 0401 (customer accounts) added 13 and took this from 389 to 402 rows; stages 23,
    // 25 and 26 (migrations 0410 to 0441) took it to about 454; stage 28's four content tables
    // and their indexes (migration 0460) to about 480; stage 42's media tables (migration 0510)
    // to about 501; stage 32a's offers (migration 0532) to about 524; stage 32b's allowances
    // (migration 0533) and stage 31's recurring bookkeeping and write guard (migration 0560:
    // three tables, two indexes, a trigger) to about 544; stage 32b's plan changes (migration 0630)
    // and stage 31a's family link (migration 0650: two tables, two indexes, three triggers) to
    // about 565; stage 44's agreement documents (migration 0850: four tables, two indexes, ten
    // triggers, an autoindex for the version's unique key) to about 588; stage 44's acceptances
    // (migration 0851: four tables, three indexes, ten triggers, the write guard made again) to
    // about 615; stage 45's time claim (migration 0811: three tables, three indexes, two triggers)
    // to about 635; stage 44's enforcement (migration 0853: three triggers) to about 638; routine
    // mail's log and marks (migration 0750) to about 655; stage 45's offers (migration 0812: four
    // tables, five indexes, three triggers) to about 661; stage 44 step 4's copies (migration
    // 0854) and stage 45's pay periods (migration 0813: four tables, five indexes, twelve
    // triggers) to about 691; stage 45's checklists (migration 0815: five tables, seven indexes, ten
    // triggers) to about 728; a child's paper copy to the guardian (migration 0857: an index, four
    // triggers) to about 744; stage 44 step 7's cooling off (migration 0856: a column, a table,
    // four indexes and its key's autoindex, three triggers): 742 measured on the merged tree;
    // stage 38's published text (migrations 0970 and 0971) and stage 34's folded addresses
    // (migration 0955: an index, four triggers): 768 measured on the merged tree.
    expect(
      await measure("summary.get", { subject: { kind: "record", object: "person", id: personId } }),
    ).toBeLessThan(785);
    expect(
      await measure("summary.get", {
        subject: { kind: "record", object: "organisation", id: orgId },
      }),
    ).toBeLessThan(1_500);
  });

  it("timeline one-liners read their activities by key", async () => {
    expect(await measure("summary.activityLines", { ids: activityIds })).toBeLessThan(200);
  });

  it("hybrid search costs about what full-text search does", async () => {
    expect(await measure("search.hybrid", { query: "acme renewal" })).toBeLessThan(3_000);
  });

  it("similar records reads the embedding row and hydrates hits by key", async () => {
    expect(await measure("record.similar", { object: "organisation", id: orgId })).toBeLessThan(
      200,
    );
  });

  it("a write adds one queue row, and a drain round reads its batch by key", async () => {
    rowsRead = 0;
    await invokeByName("person.update", { id: personId, location: "Lisbon" }, ctx());
    expect(rowsRead).toBeLessThan(400);
    rowsRead = 0;
    const out = await drainEmbeddingQueue({ db, models, vectors });
    expect(out.embedded).toBe(1);
    expect(rowsRead).toBeLessThan(200);
  });
});
