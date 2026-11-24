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
  // Stage 28 (ADR 0444): media items are records.
  "core_media",
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
  /**
   * A kind of access source the seam itself asks (ADR 0477's `registerAccessSource`): which of
   * the ids `holdsAccess` was given are live records of the object, answered only to the seam.
   */
  access: "an access source the seam asks: which of the ids it was given are live records",
  /**
   * Agreements (stage 44, ADR 0642): whether a Person the host already has (the caller's own, a
   * live dependant the seam's family gave, or one staff named) is in the Trash, a minor, and
   * their display name for staff. Never a list of anyone else.
   */
  agreements: "agreements: the Trash, minor and name facts of a Person the host was given",
  /**
   * Check-in codes (stage 51 step 3, ADR 0783): whether a Person a code, card or PIN names is
   * live, and their names to compare with the name typed, answered to host code only; a member's
   * own and their dependants' given names for their own app; that a Person staff named exists.
   */
  codes:
    "check-in codes: a Person a code names is live, names compared, given names for their own app",
  /**
   * A pack role's limit (ADR 0889): which People the staff account looks after, read to narrow
   * what its role reaches, never answered to anyone.
   */
  role: "a pack role's limit: the People its holder looks after, to narrow a staff read",
  /**
   * The public-write door (stage 29, ADRs 0720 and 0721): the counts its caps and spam rule take
   * of a form's submissions, and the empty fields of a Person the host itself matched. Nothing it
   * reads is answered to the caller.
   */
  intake: "the public-write door: its counts, and a Person the host matched",
  /**
   * Finance (stage 52, ADRs 0794 and 0796): the business's own figures, read org-wide from
   * orders, their lines and the name of whose order a refund was, answered only to an account
   * holding `finance:read`, never to a customer or the public.
   */
  finance: "finance: the business's figures, org-wide, for finance:read holders only",
} as const;
type Why = (typeof WHY)[keyof typeof WHY];

/**
 * Reads not yet on the seam: file → how many, and why. All of it is code only staff can reach:
 * an operation is closed to customers and the public unless it says otherwise (ADR 0402), and
 * test/audiences-isolation.test.ts proves the ones that are open read nothing of anyone else's.
 */
const REMAINING: Record<string, [reads: number, why: Why]> = {
  "ai/embedding.ts": [9, WHY.org],
  "finance/book.ts": [8, WHY.finance],
  "ai/summaries.ts": [16, WHY.later],
  // Stage 32b (ADR 0493): a spend checks its Person is not in the Trash, in the write's own path.
  "agreements/due.ts": [2, WHY.agreements],
  // Stage 44 step 4 (ADR 0645): the signed PDF names whom it is for, and a paper copy goes to
  // the Person's own address; read only after the operation checked who may have it. A child's
  // paper copy reads the child's live guardians (ADR 0648), each then shown only if the seam lets
  // the member of staff see them (`agreement.copy.preview`); the sender checks that a guardian
  // copy's link is still live (an existence check on the link and both People, nothing read).
  "agreements/copy.ts": [6, WHY.agreements],
  // Stage 44 step 8 (ADR 0646): erase finds a buyer's unsettled purchases by the erased Person's
  // address or id, and reads the erased Person's names (to find the paper forms that name them),
  // inside person.erase, which only an admin calls.
  "agreements/people.ts": [2, WHY.agreements],
  // Stage 44 step 6 (ADR 0649): a desk acceptance's marks read the creation time of the Person it
  // is for (a walk-in), on the Acceptances list staff already read. The desk operations read a
  // Person's names (the tablet's given name, a Person found by their exact full name or email
  // address and the one prepared for staff with agreements:desk), and the live dependants of the
  // Person a session is for.
  "agreements/desk-marks.ts": [1, WHY.agreements],
  "operations/agreement-desk.ts": [6, WHY.agreements],
  // Stage 44 step 8 (ADR 0646): the erase preview finds the Person to be erased, a Person in the
  // Trash included (as person.erase does); an admin and a person only, counts only.
  "operations/agreement-retention.ts": [1, WHY.agreements],
  "allowance/records.ts": [1, WHY.write],
  "assistant/memory.ts": [2, WHY.later],
  "assistant/producers.ts": [5, WHY.sql],
  "assistant/routine-backtest.ts": [1, WHY.sql],
  "assistant/routines.ts": [2, WHY.sql],
  "automations/records.ts": [7, WHY.org],
  // The waitlist (ADR 0520): the host's own conditions, its reads of who waits on a class and
  // of an erased booking's class and state.
  "capacity/waitlist.ts": [5, WHY.org],
  "dashboards/describe.ts": [5, WHY.sql],
  "dashboards/overview.ts": [12, WHY.sql],
  "duplicates/check.ts": [5, WHY.write],
  "duplicates/rules.ts": [9, WHY.write],
  "duplicates/scan.ts": [10, WHY.org],
  // Stage 32b (ADR 0493): a holder's view joins its allowance numbers (view DDL, not a read).
  "extensions/schema.ts": [1, WHY.part],
  "entitlements.ts": [2, WHY.org],
  "filter.ts": [1, WHY.part],
  "intake/person.ts": [3, WHY.intake],
  "intake/submit.ts": [2, WHY.intake],
  "integrations/outbound-check.ts": [2, WHY.org],
  "notifications/delivery.ts": [1, WHY.org],
  "notifications/digest-content.ts": [4, WHY.org],
  // Journeys (stage 53 step 3, ADR 0800): a manual entry reads whether each Person it is about to
  // add exists, is a minor, has an erased address or is already on it, and erase deletes their
  // entries.
  "journeys/entries.ts": [3, WHY.write],
  "notifications/routes.ts": [2, WHY.org],
  "notifications/send.ts": [2, WHY.org],
  // The room calendar (stage 57 step 1, ADR 0844): each occupant's times, state and declared
  // title, by id, for the claims in a range; never a Person, a hirer or money.
  "occupancy/index.ts": [1, WHY.host],
  "operations/activity.ts": [1, WHY.part],
  "operations/affiliation.ts": [5, WHY.part],
  // and agreement.listHealthNotes: the list's own record and the People on the declared list.
  "operations/agreement-acceptance.ts": [6, WHY.agreements],
  "operations/agreement.ts": [1, WHY.agreements],
  "operations/duplicate.ts": [3, WHY.later],
  "operations/enrichment.ts": [8, WHY.write],
  "operations/erasure.ts": [2, WHY.write],
  "operations/import.ts": [8, WHY.write],
  // Stage 44 (the review of PR #280): order.setPerson reads the People an order's address is
  // theirs (and merges of them) and the order's lines for their agreement points.
  "operations/order.ts": [4, WHY.host],
  "operations/organisation.ts": [9, WHY.write],
  "operations/person.ts": [7, WHY.write],
  "operations/person-code.ts": [2, WHY.codes],
  "operations/setup.ts": [1, WHY.write],
  "operations/suggestions.ts": [6, WHY.write],
  "orders/checkout.ts": [1, WHY.host],
  "orders/grants.ts": [1, WHY.host],
  "orders/guests.ts": [1, WHY.host],
  "orders/holds.ts": [1, WHY.host],
  // A paid order's `sold` movements (stage 37, ADR 0680): the order's own lines, joined to its
  // claims in the statement that writes them, in the host's paid batch.
  "stock/index.ts": [1, WHY.host],
  // A paid order's stock lines, for the low-stock check of its sale (stage 37 step 2, ADR 0681).
  "stock/sold.ts": [1, WHY.host],
  // The low-stock check (ADR 0681): each touched record's reorder level and title, joined in the
  // host's own statements at the end of the write's batch.
  "stock/low.ts": [1, WHY.write],
  // stockMoves (ADR 0681): a moved record's lines (a count's), and whether the record a line is
  // added to, or restored onto, has already moved stock, read by the write that moves or changes
  // them; and the guard in the apply's batch counting its lines again at the commit.
  "stock/moves.ts": [7, WHY.write],
  // Whether an object gaining or losing `stock` has any record or counter (ADR 0680, the review
  // of #370): one row at most, read by the reconcile that would change it.
  "extensions/reconciler.ts": [1, WHY.write],
  // Stage 44 step 3 (ADR 0644): honouring a late payment reads the order's lines for their points.
  "orders/late.ts": [3, WHY.host],
  // ADR 0560: a record an order moves, read as the host (its values, a twin of it for its Person, who a buyer may point at, members' unpaid holds, unsettled guest holds, a Person in the Trash; ADR 0694: whether a payment taken another way moves one).
  "orders/moves.ts": [10, WHY.host],
  // ADR 0560: an owed refund's order, read by the minute cron to settle the row.
  "orders/refund-due.ts": [1, WHY.host],
  // Programs' coach role (ADR 0889): the People an account looks after (its team's live records)
  // and whether a record is one of theirs; it only narrows what a staff read reaches.
  "pack-role-looks-after.ts": [4, WHY.role],
  "orders/orders.ts": [2, WHY.host],
  "people-codes/identify.ts": [3, WHY.codes],
  "records/erase-log.ts": [1, WHY.write],
  // Erase (and, ADR 0590, the marks of the erased person's orders).
  "records/erase-stores.ts": [2, WHY.write],
  "records/erase-subject.ts": [6, WHY.write],
  "records/erase.ts": [8, WHY.write],
  "records/links.ts": [10, WHY.part],
  "records/tags.ts": [1, WHY.part],
  "retention.ts": [1, WHY.org],
  // Routine mail (ADR 0590): the host reads the record it is about, its order, its person and
  // the orders an address paid itself, for a shipped pack's automation run with no caller.
  "routine-mail/index.ts": [4, WHY.org],
  // The roster (stage 45 step 3, ADRs 0623 and 0624): the host reads the shifts' titles, times and
  // person fields (never a booking or a Person) to answer an offer, list uncovered shifts and take
  // a leaver off their future shifts and patterns (writes are staff's, in the operation's batch).
  "staffing/due.ts": [1, WHY.host],
  "staffing/eligibility.ts": [1, WHY.host],
  "staffing/leaving.ts": [3, WHY.write],
  // The roster read (step 4, ADR 0626): every staffed object's live shifts in a range, their
  // holders' accounts and their kinds' and places' names; nothing of a booking or a Person.
  "staffing/week.ts": [3, WHY.host],
  "operations/staffing.ts": [2, WHY.host],
  "operations/staffing-screens.ts": [2, WHY.host],
  // Open hours (stage 49 step 3, ADR 0762): that the kinds an entry is for exist, by id only.
  "operations/staffing-hours.ts": [1, WHY.host],
  // Free times (stage 49 step 4, ADR 0763): the qualified providers' profiles (id and account),
  // and the times of the client's own live shifts of the object (the caller's own or a live
  // dependant's for a customer); answered only as which start times are free.
  "staffing/free.ts": [2, WHY.host],
  "staffing/sets.ts": [1, WHY.host],
  // Pay periods (step 6, ADR 0627): a period's shifts (person, times, kind, title, place), their
  // holders' accounts, their kinds' names and set-up minutes, and the evidence object's marker
  // only (who took a class list, never a booking's person), for someone who handles pay.
  "staffing/pay.ts": [7, WHY.host],
  // Time entries (stage 58, ADR 0850): a workedOn record's state, title and Trash mark, by id, and
  // the titles of what a person's own entries are against, by id; nothing of a Person.
  "staffing/time.ts": [2, WHY.host],
  // The calendar feed (ADR 0628): the token's own shifts, by id from their time claims.
  "staffing/feed.ts": [1, WHY.host],
  // Checklists (stage 45 step 4b, ADR 0650): a record's person, opening and closing times, state,
  // title and the checklist its relation names, for its run and who may tick it (never a booking
  // or a Person); the minute cron's records needing a run and open runs out of step with theirs;
  // and whether a duty carries a checklist (who may move a shift off it, or bin it).
  "checklists/index.ts": [3, WHY.host],
  "checklists/runs.ts": [2, WHY.host],
  // The host's read of a period's order by its invoice (stage 32a, ADR 0486).
  "subscriptions/periods.ts": [1, WHY.host],
  // Whether a paid invoice is the first period after a pause the host asked for (stage 32b, ADR 0531).
  "subscriptions/changes.ts": [1, WHY.host],
  // Deleting an account (stage 48 step 6, ADR 0713): the caller's own open orders, by the Person
  // the principal names, and their lines' titles, which the host then cancels as their order.cancel.
  "customers/account-delete.ts": [2, WHY.host],
  // Cooling off (stage 44 step 7, ADR 0647): the subscriptions a payer or staff asked about, the
  // payer checked by the host itself (a customer's own is the one they pay for, ADR 0487), their
  // paid orders and the refunds owed on them, and (in the end's batch and its follow-ups) the
  // bookings ahead the cooled-off membership paid for and the member's own waiting places, by the
  // host.
  "subscriptions/cooling-off.ts": [4, WHY.host],
  // `hasBought` (ADR 0458, #221): whose address it is, before anyone has signed in (no caller).
  // `samePeople` (ADR 0692): the ids of the People sharing a folded address with one the host
  // already has, for its own one-per-Person checks; never answered to a caller.
  "customers/accounts.ts": [5, WHY.org],
  // The subscription access source's `covers: "all"`: only live ids (stage 32a review, ADR 0488).
  "subscriptions/access.ts": [1, WHY.access],
  // Continuation offers (stage 32a step 4, ADR 0491): the import matching an address to its one
  // live Person, and the staff report's names (subscriptions:manage); the customer's own offers
  // read only rows of their own account and Person.
  "subscriptions/offers.ts": [3, WHY.write],
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
