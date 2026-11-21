// Stage 22, acceptance criterion 3 (ADR 0244, ADR 0410): records are read through the visibility
// seam and nowhere else. This test reads the source of packages/core and fails when a file
// outside `src/visibility/` reads a `rec_*` view or a core record table, unless the read is on
// the list below of reads still to be moved, with the reason it has not moved yet.
//
// The list is a ratchet. A new read in a listed file changes its count and fails; so does a file
// that is not listed. When you move a read onto the seam, lower the count (or delete the line).
// Never raise a count to make this pass: read through `visibleSource(ctx, object)` instead, or
// `orgReader(db)` for work that has no caller.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Tables that hold records or parts of records. `rec_*` views and `x_*` tables are matched by prefix. */
const RECORD_TABLES = [
  "core_person",
  "core_person_emails",
  "core_person_phones",
  "core_organisation",
  "core_organisation_domains",
  "core_organisation_addresses",
  "core_affiliation",
  "core_activity",
  "core_activity_links",
  "core_task",
  "core_task_links",
  "core_record_tags",
  "core_base_people",
  "core_base_organisations",
  "core_base_activities",
  "core_base_tasks",
  // Stage 25 (ADR 0427): orders and their lines are records.
  "core_order",
  "core_order_line",
];

// `rec_user` is the staff directory, not a record: no object declares it, and it is read by
// staff-only operations (user.list, owner pickers).
const NAMED = `(?:rec_(?!user\\b)[a-z0-9_]+|x_[a-z0-9_]+|(?:${RECORD_TABLES.join("|")})(?![a-z0-9_]))`;
const READS = [
  // Kysely: selectFrom("rec_person"), leftJoin("core_person as p", …)
  new RegExp(`\\b(?:selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\\(\\s*["'\`]${NAMED}`, "g"),
  // SQL text: FROM rec_person, JOIN core_task t
  new RegExp(`\\b(?:FROM|JOIN)\\s+${NAMED}`, "g"),
  // An object's view or table named through the registry: object.source, viewOf(…), objectTableOf(…)
  /\b(?:selectFrom|innerJoin|leftJoin)\(\s*[A-Za-z_.]+\.source\b/g,
  /\bsql\.table\(\s*[A-Za-z_.]+\.source\b/g,
  /\b(?:FROM|JOIN)\s+\$\{\s*sql\.(?:table|ref|raw)\(/g,
];

/** Reads of a record view or table in `text`, comments ignored. */
function recordReads(text: string): string[] {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  return READS.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[0]));
}

const WHY = {
  /** SQL text run by `query.sql`, dashboards and routines. Stage 14a rewrites it at the seam's second door. */
  sql: "door 2 (stage 14a): SQL text run by query.sql, dashboards and routines",
  /** Reads for a caller that get their scope in stage 14a: summaries, duplicates, memory. */
  later: "stage 14a: a read for a caller that takes its scope there",
  /**
   * Rows that belong to a record (emails, links, tags, affiliations), reached from a record that
   * was itself read through the seam. Stage 14a gives them their parents' scope (ADR 0244).
   */
  part: "inherited: parts of a record, reached from one already read",
  /** Scheduled and background work for the whole org, with no caller (ADR 0244: org-wide). */
  org: "org-wide: a job or check with no caller",
  /** A staff write reading what it is about to change: uniqueness, snapshots, merge, import, erase. */
  write: "staff write path: uniqueness, snapshots, merge, import, erase",
  /**
   * The host's own code for orders (ADR 0427, ADR 0428): the order it is about to move or apply
   * a payment to, and an order whose caller it has itself established (their own through the
   * seam first, or the order's token). What a caller is answered with is what a customer may
   * read of an order.
   */
  host: "host code for orders: the order it is about to change, or one the caller proved is theirs",
} as const;
type Why = (typeof WHY)[keyof typeof WHY];

/**
 * Reads not yet on the seam: file → how many, and why. All of it is code only staff can reach:
 * an operation is closed to customers and the public unless it says otherwise (ADR 0402), and
 * test/audiences-isolation.test.ts proves the ones that are open read nothing of anyone else's.
 */
const REMAINING: Record<string, [reads: number, why: Why]> = {
  "ai/embedding.ts": [9, WHY.org],
  "ai/summaries.ts": [16, WHY.later],
  "assistant/memory.ts": [2, WHY.later],
  "assistant/producers.ts": [5, WHY.sql],
  "assistant/routine-backtest.ts": [1, WHY.sql],
  "assistant/routines.ts": [2, WHY.sql],
  "automations/records.ts": [7, WHY.org],
  "dashboards/describe.ts": [5, WHY.sql],
  "dashboards/overview.ts": [12, WHY.sql],
  "duplicates/check.ts": [5, WHY.write],
  "duplicates/rules.ts": [9, WHY.write],
  "duplicates/scan.ts": [10, WHY.org],
  "entitlements.ts": [2, WHY.org],
  "filter.ts": [1, WHY.part],
  "integrations/outbound-check.ts": [2, WHY.org],
  "notifications/delivery.ts": [1, WHY.org],
  "notifications/digest-content.ts": [4, WHY.org],
  "notifications/routes.ts": [2, WHY.org],
  "notifications/send.ts": [2, WHY.org],
  "operations/activity.ts": [1, WHY.part],
  "operations/affiliation.ts": [5, WHY.part],
  "operations/duplicate.ts": [3, WHY.later],
  "operations/enrichment.ts": [8, WHY.write],
  "operations/erasure.ts": [2, WHY.write],
  "operations/import.ts": [8, WHY.write],
  "operations/order.ts": [1, WHY.host],
  "operations/organisation.ts": [9, WHY.write],
  "operations/person.ts": [7, WHY.write],
  "operations/setup.ts": [1, WHY.write],
  "operations/suggestions.ts": [6, WHY.write],
  "orders/checkout.ts": [1, WHY.host],
  "orders/grants.ts": [1, WHY.host],
  "orders/guests.ts": [1, WHY.host],
  "orders/holds.ts": [1, WHY.host],
  "orders/late.ts": [2, WHY.host],
  "orders/orders.ts": [2, WHY.host],
  "records/erase-log.ts": [1, WHY.write],
  "records/erase-stores.ts": [1, WHY.write],
  "records/erase-subject.ts": [6, WHY.write],
  "records/erase.ts": [8, WHY.write],
  "records/links.ts": [10, WHY.part],
  "records/tags.ts": [1, WHY.part],
  "retention.ts": [1, WHY.org],
  "sync/ingest.ts": [8, WHY.org],
};

const outside = Object.entries(sources)
  .map(([path, text]) => [path.replace("../src/", ""), text] as const)
  .filter(([path]) => !path.startsWith("visibility/"));

describe("records are read through the visibility seam only", () => {
  it("finds the source files", () => {
    expect(outside.length).toBeGreaterThan(200);
    expect(Object.keys(sources).some((p) => p.endsWith("visibility/index.ts"))).toBe(true);
  });

  it("recognises a read however it is written", () => {
    const OPEN = "$" + "{";
    expect(recordReads('db.selectFrom("rec_person").selectAll()')).toHaveLength(1);
    expect(recordReads('q.leftJoin("core_organisation as o", "o.id", "p.org")')).toHaveLength(1);
    expect(recordReads("sql`SELECT * FROM rec_x_deals_deal d JOIN core_task t`")).toHaveLength(2);
    expect(recordReads("sql`SELECT id FROM x_deals_deal`")).toHaveLength(1);
    expect(recordReads("(db as AnyDb).selectFrom(object.source)")).toHaveLength(1);
    expect(recordReads(`sql\`SELECT 1 FROM ${OPEN}sql.table(def.source)} AS r\``)).toHaveLength(2);
    // Not reads of a record: the seam itself, other tables, writes, comments.
    expect(recordReads("db.selectFrom(visibleSource(ctx, object))")).toHaveLength(0);
    expect(recordReads(`sql\`SELECT 1 FROM ${OPEN}visibleSource(ctx, object)}\``)).toHaveLength(0);
    expect(recordReads('db.selectFrom("core_person_signature")')).toHaveLength(0);
    expect(recordReads('db.selectFrom("rec_user")')).toHaveLength(0);
    expect(recordReads('db.insertInto("core_person").values(v)')).toHaveLength(0);
    expect(recordReads('// db.selectFrom("rec_person")')).toHaveLength(0);
  });

  it("no file outside the seam reads a record view or table, except the listed ones", () => {
    const found: Record<string, number> = {};
    for (const [path, text] of outside) {
      const reads = recordReads(text).length;
      if (reads) found[path] = reads;
    }
    const listed = Object.fromEntries(Object.entries(REMAINING).map(([p, [n]]) => [p, n]));
    expect(found).toEqual(listed);
  });
});
