// The family link at the seam (stage 31a step 6, ADR 0540): the one place that decides whether a
// customer may read or act for another Person. A guardian (a parent) is linked by staff to a
// dependant (a child) in `core_person_link`; while the link is live, a customer's scope on an
// object whose customer declaration opts in (`guardians`) is their own Person's records **or a
// live dependant's**, and nothing else. No other code reads the link to decide access: the seam's
// sources (index.ts), its write helpers (writes.ts) and the family a customer is shown
// (`familyOf`) all ask here.
//
// A link is live while it has not ended and both its People are out of the Trash. Everything here is
// read at the moment of the read or the write, never cached, so ending a link (or erasing either
// Person, which deletes it) stops the guardian's reads at once; their writes carry a guard in
// their own batch (`linkGuardStatement`), so a link ended a moment before cannot be written
// through. One hop only: a dependant's own dependants are not their guardian's, and the link has a
// direction: a dependant never acts for their guardian.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, type RawBuilder, sql } from "kysely";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { Principal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";

/** The one kind of link today. */
export const GUARDIAN_LINK = "guardian";

/** What is wrong with an object's `customer.guardians` (empty when nothing is). */
export function guardianProblems(object: ObjectDefinition): string[] {
  const declared = object.customer?.guardians;
  if (!declared || !object.customer) return [];
  const problems: string[] = [];
  if (object.name === "person") {
    problems.push("a Person's own record cannot open to their guardians");
  }
  if (declared.madeBy !== undefined) {
    const name = declared.madeBy;
    const field = object.fields.find((f) => f.name === name);
    if (
      !field?.column ||
      field.fieldType !== "relation" ||
      field.options?.to !== "person" ||
      field.options.many
    ) {
      problems.push(`customer.guardians.madeBy "${name}" must be a relation to one person`);
    } else if (!field.readOnly) {
      problems.push(`customer.guardians.madeBy "${name}" must be read-only: the host sets it`);
    }
    if (name === object.customer.field) {
      problems.push("customer.guardians.madeBy cannot be the customer field");
    }
    if (object.customer.write.includes(name)) {
      problems.push(
        `customer.guardians.madeBy "${name}" is set by the host: customer.write may not list it`,
      );
    }
  }
  return problems;
}

/**
 * The live dependants of `personId`, as a subquery of ids: links not ended, of kind guardian,
 * whose guardian and dependant are both out of the Trash. The id is a bound parameter.
 */
export function dependantsSql(personId: string): RawBuilder<unknown> {
  return sql`SELECT l.dependant_id FROM core_person_link l JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL WHERE l.guardian_id = ${personId} AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL`;
}

/**
 * Whose records these are, as a predicate on the view column `column`: the caller's own Person,
 * and with `dependants`, a live dependant's too. Columns are trusted registry identifiers; the
 * person id is bound.
 */
export function ownersWhere(
  column: string,
  personId: string,
  dependants: boolean,
): RawBuilder<unknown> {
  const own = sql`${sql.ref(column)} = ${personId}`;
  return dependants ? sql`(${own} OR ${sql.ref(column)} IN (${dependantsSql(personId)}))` : own;
}

/** Whether `personId` is a live dependant of `guardianId` now. */
export async function isLiveDependant(
  db: Kysely<CoreDatabase>,
  guardianId: string,
  personId: string,
): Promise<boolean> {
  if (guardianId === personId) return false;
  const { rows } = await sql<{
    one: number;
  }>`SELECT 1 AS one WHERE ${personId} IN (${dependantsSql(guardianId)})`.execute(db);
  return rows.length > 0;
}

/**
 * The statement a guardian's write carries in its own batch (migration 0650): the batch fails
 * unless the link is still live when it commits.
 */
export function linkGuardStatement(guardianId: string, dependantId: string): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_person_link_guard (guardian_id, dependant_id) VALUES (?, ?)",
    [guardianId, dependantId],
  );
}

/** A Person a customer is linked to, as they are shown: an id and a name, nothing else. */
export interface FamilyMember {
  readonly personId: string;
  readonly name: string;
}

/**
 * Who a customer is linked to: the dependants they act for, and the guardians who act for them;
 * `self` is the caller (null for anyone who is not a customer).
 */
export interface Family {
  readonly self: FamilyMember | null;
  readonly dependants: readonly FamilyMember[];
  readonly guardians: readonly FamilyMember[];
}

/**
 * The caller's live links (ADR 0540: a link is shown to staff, its guardian and its dependant,
 * never to anyone else), with each other Person's display name only. Empty for anyone who is not
 * a customer.
 */
export async function familyOf(reader: {
  readonly db: Kysely<CoreDatabase>;
  readonly principal: Principal;
}): Promise<Family> {
  const principal = reader.principal;
  if (principal.kind !== "customer") return { self: null, dependants: [], guardians: [] };
  const me = principal.personId;
  // Three independent reads, sent together.
  const [own, dependants, guardians] = await Promise.all([
    sql<{
      name: string;
    }>`SELECT display_name AS name FROM core_person WHERE id = ${me} AND deleted_at IS NULL`.execute(
      reader.db,
    ),
    sql<{
      id: string;
      name: string;
    }>`SELECT p.id AS id, p.display_name AS name FROM core_person p WHERE p.id IN (${dependantsSql(me)}) ORDER BY p.display_name, p.id`.execute(
      reader.db,
    ),
    sql<{
      id: string;
      name: string;
    }>`SELECT p.id AS id, p.display_name AS name FROM core_person_link l JOIN core_person p ON p.id = l.guardian_id AND p.deleted_at IS NULL JOIN core_person me ON me.id = l.dependant_id AND me.deleted_at IS NULL WHERE l.dependant_id = ${me} AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL ORDER BY p.display_name, p.id`.execute(
      reader.db,
    ),
  ]);
  const shown = (rows: { id: string; name: string }[]) =>
    rows.map((row) => ({ personId: String(row.id), name: String(row.name) }));
  return {
    self: { personId: me, name: String(own.rows[0]?.name ?? "") },
    dependants: shown(dependants.rows),
    guardians: shown(guardians.rows),
  };
}

/**
 * The caller's live dependants by id, each with what a parent calls them: their given name, else
 * the first word of their display name, else their display name; "Child" when all are blank. For
 * a customer only (empty for anyone else); one statement, the caller's id bound. The calendar feed
 * (ADR 0890) puts it before a child's event so a parent tells two children's apart.
 */
export async function dependantFirstNames(reader: {
  readonly db: Kysely<CoreDatabase>;
  readonly principal: Principal;
}): Promise<Map<string, string>> {
  const principal = reader.principal;
  if (principal.kind !== "customer") return new Map();
  const { rows } = await sql<{
    id: string;
    given: string | null;
    name: string | null;
  }>`SELECT p.id AS id, p.given_name AS given, p.display_name AS name FROM core_person p WHERE p.id IN (${dependantsSql(principal.personId)})`.execute(
    reader.db,
  );
  return new Map(
    rows.map((row) => {
      const given = (row.given ?? "").trim();
      const display = (row.name ?? "").trim();
      return [String(row.id), given || display.split(/\s+/)[0] || display || "Child"];
    }),
  );
}

/**
 * For staff ending a link (ADR 0540): how many live records a guardian made for a dependant, per
 * object that records who made them (`guardians.madeBy`). They stay when the link ends; staff are
 * told. Ids are bound; columns are registry identifiers.
 */
export async function recordsMadeFor(
  db: Kysely<CoreDatabase>,
  guardianId: string,
  dependantId: string,
): Promise<{ object: string; label: string; count: number }[]> {
  const out: { object: string; label: string; count: number }[] = [];
  for (const object of listObjects()) {
    const declared = object.customer;
    const madeBy = declared?.guardians?.madeBy;
    if (!declared || !madeBy) continue;
    const owner = object.fields.find((f) => f.name === declared.field);
    const maker = object.fields.find((f) => f.name === madeBy);
    const ownerColumn = owner ? viewColumnOf(owner) : null;
    const makerColumn = maker ? viewColumnOf(maker) : null;
    if (!ownerColumn || !makerColumn) continue;
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*) AS n FROM ${sql.table(object.source)} WHERE ${sql.ref(ownerColumn)} = ${dependantId} AND ${sql.ref(makerColumn)} = ${guardianId}`.execute(
      db,
    );
    const count = Number(rows[0]?.n ?? 0);
    if (count) out.push({ object: object.name, label: object.plural ?? object.label, count });
  }
  return out;
}

/**
 * For staff linking or reading a link (ADR 0540): a warning when the dependant has an email that
 * is also the guardian's, or a customer account's sign-in address. Signing in links an account to
 * the Person with its address, so a parent's address on the child's record would make the parent's
 * account the child's. Null when there is nothing to warn of. Ids are bound.
 */
export async function sharedEmailWarning(
  db: Kysely<CoreDatabase>,
  guardianId: string,
  dependantId: string,
): Promise<string | null> {
  const { rows } = await sql<{
    shared: string;
  }>`SELECT DISTINCT e.email AS shared FROM core_person_emails e WHERE e.person_id = ${dependantId} AND (e.email IN (SELECT g.email FROM core_person_emails g WHERE g.person_id = ${guardianId}) OR e.email IN (SELECT c.email FROM core_customer c WHERE c.person_id IS NULL OR c.person_id != ${dependantId}))`.execute(
    db,
  );
  if (!rows.length) return null;
  return (
    "The child's record has an email that is also the parent's or another account's " +
    `(${rows.map((r) => r.shared).join(", ")}). Signing in with it would open that account as ` +
    "the child's: give the child their own address or none."
  );
}

/**
 * Whether `personId` is a live dependant of anyone (a child, for consent to be contacted: news
 * and offers never go to them, ADR 0675). One statement.
 */
export async function hasLiveGuardian(
  db: Kysely<CoreDatabase>,
  personId: string,
): Promise<boolean> {
  const { rows } = await sql<{
    one: number;
  }>`SELECT 1 AS one FROM core_person_link l JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL WHERE l.dependant_id = ${personId} AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL LIMIT 1`.execute(
    db,
  );
  return rows.length > 0;
}

/**
 * The live Person a host-made link names now (a stop link, ADR 0675): itself, or the Person it
 * was merged into (followed a few hops); null for one erased, or in the Trash and not merged.
 */
export async function livePersonAfterMerges(
  db: Kysely<CoreDatabase>,
  personId: string,
): Promise<string | null> {
  let id = personId;
  for (let hop = 0; hop < 5; hop += 1) {
    const { rows } = await sql<{
      deleted_at: string | null;
      merged_into_id: string | null;
    }>`SELECT deleted_at, merged_into_id FROM core_person WHERE id = ${id}`.execute(db);
    const row = rows[0];
    if (!row) return null;
    if (row.deleted_at === null) return id;
    if (!row.merged_into_id) return null;
    id = row.merged_into_id;
  }
  return null;
}
