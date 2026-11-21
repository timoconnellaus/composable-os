// Stage 22, acceptance criterion 2: the visibility seam changes nothing for staff. Every read
// below returns the same rows and costs the same D1 `rows_read` as it did before the seam was
// built. The baseline (test/fixtures/visibility-staff-baseline.json) was recorded by this test on
// the commit before `packages/core/src/visibility/` existed, on the deterministic seed.
//
// To re-record after a deliberate change to a read: empty the baseline to `{}`, run this file
// with `--silent=false`, and copy the JSON after `SEAM_BASELINE` into the fixture. Say why in the
// commit: a changed number here is a changed D1 bill or a changed result for staff.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { seedDatabase } from "@composable-os/db/seed";
import deals from "@composable-os/extension-deals";
import { toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { reconcile } from "./extension-helpers.ts";
import baseline from "./fixtures/visibility-staff-baseline.json";

const NOW = "2026-11-10T12:00:00.000Z";
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

// Fixed ids and times, so the seed and every output are the same on every run.
const admin: ActingUser = {
  id: "usr_01JSEAM0000000000000ADM1N",
  email: "seam-admin@example.com",
  name: "Seam Admin",
  role: "admin",
};
const member: ActingUser = {
  id: "usr_01JSEAM000000000000MEMBER",
  email: "seam-member@example.com",
  name: "Seam Member",
  role: "member",
};

interface Measured {
  rowsRead: number;
  /** SHA-256 of the output JSON: the rows, in order, with every value. */
  output: string;
  /** How many items the output held, so a hash of nothing is noticed. */
  items: number;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function countItems(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const o = output as Record<string, unknown>;
  for (const key of ["items", "hits", "groups"]) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).length;
  }
  if (typeof o.rowCount === "number") return o.rowCount;
  if (typeof o.count === "number") return o.count;
  if (o.buckets && typeof o.buckets === "object") {
    return Object.values(o.buckets as Record<string, unknown[]>).reduce(
      (n, list) => n + list.length,
      0,
    );
  }
  return typeof o.id === "string" ? 1 : 0;
}

async function measure(name: string, input: unknown, user: ActingUser): Promise<Measured> {
  rowsRead = 0;
  const output = await invokeByName(name, input, {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    clock: () => new Date(NOW),
  });
  return { rowsRead, output: await sha256(JSON.stringify(output)), items: countItems(output) };
}

async function firstId(table: string, where = "1 = 1"): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`,
  ).first<{ id: string }>();
  if (!row) throw new Error(`No row in ${table}`);
  return row.id;
}

const actual: Record<string, Measured> = {};

beforeAll(async () => {
  for (const user of [admin, member]) {
    await env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(user.id, user.name, user.email, NOW, NOW)
      .run();
    await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?")
      .bind(user.role, user.id)
      .run();
  }
  await reconcile(toManifest(deals), NOW);
  await seedDatabase(env.DB, {
    people: 1500,
    organisations: 300,
    activities: 600,
    tasks: 400,
    deals: 200,
    owners: [admin.id, member.id],
    dealsUntil: "2026-11-01",
  });
  // Something in the Trash, so trash.list and the `includeDeleted` loads read real rows.
  await env.DB.prepare(
    "UPDATE core_person SET deleted_at = ? WHERE id IN (SELECT id FROM core_person ORDER BY id DESC LIMIT 3)",
  )
    .bind(NOW)
    .run();

  const person = await firstId("rec_person", "organisation_id IS NOT NULL");
  const organisation = await firstId("rec_organisation");
  const activity = await firstId("rec_activity");
  const task = await firstId("rec_task");
  const deal = await firstId("rec_x_deals_deal");
  const linked = await env.DB.prepare(
    "SELECT object_type AS object, record_id AS id FROM core_activity_links ORDER BY activity_id LIMIT 1",
  ).first<{ object: string; id: string }>();
  const page1 = (await invokeByName(
    "person.list",
    { limit: 50 },
    { actor: "human", user: member, origin: { surface: "ui" }, db },
  )) as { nextCursor: string };

  const reads: [key: string, operation: string, input: unknown, user?: ActingUser][] = [
    ["person.list", "person.list", { limit: 50 }],
    ["person.list page 2", "person.list", { limit: 50, cursor: page1.nextCursor }],
    [
      "person.list by createdAt",
      "person.list",
      { limit: 50, sort: { field: "createdAt", direction: "desc" } },
    ],
    [
      "person.list filtered",
      "person.list",
      { limit: 50, filter: { field: "organisationName", op: "contains", value: "a" } },
    ],
    ["person.list fields", "person.list", { limit: 20, fields: ["displayName", "primaryEmail"] }],
    ["organisation.list", "organisation.list", { limit: 50 }],
    ["activity.list", "activity.list", { limit: 50 }],
    ["task.list", "task.list", { limit: 50 }],
    [
      "task.list filtered",
      "task.list",
      { limit: 50, filter: { field: "status", op: "eq", value: "open" } },
    ],
    ["task.listMine", "task.listMine", {}, admin],
    ["user.list", "user.list", {}],
    ["record.list deals", "record.list", { object: "deals.deal", limit: 50 }],
    [
      "record.list deals by value",
      "record.list",
      { object: "deals.deal", limit: 50, sort: { field: "value", direction: "desc" } },
    ],
    ["record.list stages", "record.list", { object: "deals.stage", limit: 50 }],
    ["record.list person", "record.list", { object: "person", limit: 20, fields: ["displayName"] }],
    ["record.get deal", "record.get", { object: "deals.deal", id: deal }],
    ["record.get person", "record.get", { object: "person", id: person }],
    ["record.count person", "record.count", { object: "person" }],
    [
      "record.count person filtered",
      "record.count",
      { object: "person", filter: { field: "organisationName", op: "contains", value: "a" } },
    ],
    ["record.count deals", "record.count", { object: "deals.deal" }],
    ["record.groups task", "record.groups", { object: "task", groupBy: "status" }],
    [
      "record.groups deals",
      "record.groups",
      { object: "deals.deal", groupBy: "stage", sumField: "value" },
    ],
    ["export.csv person", "export.csv", { object: "person", maxRows: 200 }],
    ["export.csv deals", "export.csv", { object: "deals.deal", maxRows: 200 }],
    ["person.get", "person.get", { id: person }],
    ["organisation.get", "organisation.get", { id: organisation }],
    ["activity.get", "activity.get", { id: activity }],
    ["task.get", "task.get", { id: task }],
    [
      "activity.listForRecord",
      "activity.listForRecord",
      { object: linked?.object, recordId: linked?.id },
    ],
    ["affiliation.list", "affiliation.list", { personId: person }],
    ["search.global", "search.global", { query: "ada" }],
    ["search.global deals", "search.global", { query: "a", objects: ["deals.deal", "person"] }],
    ["trash.list", "trash.list", {}, admin],
  ];
  for (const [key, operation, input, user] of reads) {
    actual[key] = await measure(operation, input, user ?? member);
  }
  console.log(`SEAM_BASELINE ${JSON.stringify(actual, null, 2)}`);
}, 180_000);

describe("staff reads are unchanged by the visibility seam", () => {
  const recorded = baseline as Record<string, Measured>;

  it("covers every read in the baseline, and the baseline covers every read", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(recorded).sort());
  });

  it("every read returned something to compare", () => {
    const empty = Object.entries(actual)
      .filter(([key, m]) => m.items === 0 && key !== "task.listMine")
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it("returns the same rows", () => {
    const outputs = (set: Record<string, Measured>) =>
      Object.fromEntries(Object.entries(set).map(([k, m]) => [k, `${m.items} ${m.output}`]));
    expect(outputs(actual)).toEqual(outputs(recorded));
  });

  it("costs the same rows_read", () => {
    const cost = (set: Record<string, Measured>) =>
      Object.fromEntries(Object.entries(set).map(([k, m]) => [k, m.rowsRead]));
    expect(cost(actual)).toEqual(cost(recorded));
  });
});
