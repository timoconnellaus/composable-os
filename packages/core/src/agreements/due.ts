// The one question (stage 44 step 2, ADR 0641 as amended): what must this Person still agree to at
// this agreement point. `agreementsDue` is the only place it is answered; every caller (the
// Person tab, a customer's "before you go on", step 3's checks at checkout, subscription start
// and booking) asks here, and a write that relied on the answer carries `agreementsGuard(rev)`
// in its own batch, so a publish, a version taking effect, an attach, a detach or a retire
// committed between the read and the commit fails the batch (`core_agreements_changed`).
//
// An acceptance of document D counts for D while (spec 44, "When an acceptance is current"):
//   1. its version has taken effect and its number is at least D's agree_from;
//   2. for a health document with "ask again after" set, it was made less than that many months ago;
//   3. it is for that Person, and for a minor (a live dependant, or a Person staff marked) it was
//      made by a guardian (with a live link at the time: the insert trigger checks it) or on paper;
//   4. its Person is not in the Trash.
// A newer counting acceptance replaces an older one for every purpose; both are kept.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";
import { readRev } from "./documents.ts";

type Db = Kysely<CoreDatabase>;

/** A version as a person is asked to read it. */
export interface DueVersion {
  id: string;
  number: number;
  effectiveFrom: string;
}

/** Why a document is due: never agreed, agreed to a version before "agree again", or too long ago. */
export type DueReason = "never" | "agree_again" | "ask_again" | "guardian";

export interface DueDocument {
  documentId: string;
  kind: string;
  title: string;
  /** Whom it is for: the participant or the payer the point was asked about. */
  personId: string;
  who: "participant" | "payer";
  version: DueVersion;
  /** A published version that takes effect later, which may be accepted early. */
  scheduled: DueVersion | null;
  reason: DueReason;
}

/** One live document attached somewhere, with what its current version says. */
interface Attached {
  id: string;
  kind: string;
  title: string;
  agreeFrom: number;
  who: "participant" | "payer";
  forWhom: "everyone" | "dependants";
  askAgainMonths: number | null;
  current: DueVersion;
  scheduled: DueVersion | null;
  points: string[];
  /** Number and effective moment of every version, by id. */
  versions: Map<string, { number: number; effectiveFrom: string }>;
}

/** The live documents attached to `point` (or to any point), with what is in effect. */
export async function attachedDocuments(db: Db, point: string | null): Promise<Attached[]> {
  let query = db
    .selectFrom("core_agreement_point as p")
    .innerJoin("core_agreement_document as d", "d.id", "p.document_id")
    .select(["d.id", "d.kind", "d.agree_from", "d.current_version_id", "p.point"])
    .where("d.state", "=", "live")
    .where("d.current_version_id", "is not", null);
  if (point !== null) query = query.where("p.point", "=", point);
  const rows = await query.orderBy("d.created_at").orderBy("d.id").execute();
  const ids = [...new Set(rows.map((r) => r.id))];
  if (!ids.length) return [];
  const versions = await db
    .selectFrom("core_agreement_version")
    .select([
      "id",
      "document_id",
      "number",
      "title",
      "who",
      "for_whom",
      "ask_again_months",
      "effective_from",
    ])
    .where("document_id", "in", ids)
    .orderBy("number")
    .execute();
  const out = new Map<string, Attached>();
  for (const row of rows) {
    const had = out.get(row.id);
    if (had) {
      had.points.push(row.point);
      continue;
    }
    const own = versions.filter((v) => v.document_id === row.id);
    const current = own.find((v) => v.id === row.current_version_id);
    if (!current) continue;
    const later = own.filter((v) => v.number > current.number).at(-1);
    out.set(row.id, {
      id: row.id,
      kind: row.kind,
      title: current.title,
      agreeFrom: row.agree_from,
      who: current.who,
      forWhom: current.for_whom,
      askAgainMonths: current.ask_again_months,
      current: { id: current.id, number: current.number, effectiveFrom: current.effective_from },
      scheduled: later
        ? { id: later.id, number: later.number, effectiveFrom: later.effective_from }
        : null,
      points: [row.point],
      versions: new Map(
        own.map((v) => [v.id, { number: v.number, effectiveFrom: v.effective_from }]),
      ),
    });
  }
  return [...out.values()];
}

/** What the host knows about a Person that changes what counts for them. */
export interface PersonFacts {
  exists: boolean;
  inTrash: boolean;
  /** Marked a minor by staff (core_agreement_minor). */
  marked: boolean;
  /** A live dependant of a family link (ADR 0540). */
  dependant: boolean;
}

export const isMinor = (facts: PersonFacts) => facts.marked || facts.dependant;

export async function personFacts(db: Db, personId: string): Promise<PersonFacts> {
  const { rows } = await sql<{
    deleted_at: string | null;
    marked: number;
    dependant: number;
  }>`SELECT p.deleted_at,
      EXISTS (SELECT 1 FROM core_agreement_minor m WHERE m.person_id = p.id) AS marked,
      EXISTS (SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        WHERE l.dependant_id = p.id AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL
          AND p.deleted_at IS NULL) AS dependant
    FROM core_person p WHERE p.id = ${personId}`.execute(db);
  const row = rows[0];
  if (!row) return { exists: false, inTrash: false, marked: false, dependant: false };
  return {
    exists: true,
    inTrash: row.deleted_at !== null,
    marked: Boolean(row.marked),
    dependant: Boolean(row.dependant),
  };
}

/** An acceptance as the question reads it: no name typed, no signature, no answers. */
export interface AcceptanceFact {
  id: string;
  documentId: string;
  versionId: string;
  by: "self" | "guardian" | "guest" | "paper";
  acceptedAt: string;
  /**
   * When it counts from, for "ask again after": the host's time, or for paper the date written on
   * the form (a form signed long ago is not new because it was typed in today).
   */
  countsFrom: string;
}

/** `now` less `months` calendar months (the host's clock, UTC). */
export function monthsBefore(now: string, months: number): string {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

/**
 * The acceptance that counts for a document now, newest first, or why none does. `acceptances`
 * are the Person's own, of this document.
 */
export function countingAcceptance(
  doc: Attached,
  facts: PersonFacts,
  acceptances: readonly AcceptanceFact[],
  now: string,
): { acceptance: AcceptanceFact | null; reason: DueReason } {
  if (!facts.exists || facts.inTrash) return { acceptance: null, reason: "never" };
  const minor = isMinor(facts);
  const cutoff = doc.askAgainMonths ? monthsBefore(now, doc.askAgainMonths) : null;
  let reason: DueReason = "never";
  const newest = [...acceptances].sort((a, b) => (a.countsFrom < b.countsFrom ? 1 : -1));
  for (const a of newest) {
    const version = doc.versions.get(a.versionId);
    if (!version || version.effectiveFrom > now) continue;
    if (minor && a.by !== "guardian" && a.by !== "paper") {
      if (reason === "never") reason = "guardian";
      continue;
    }
    if (version.number < doc.agreeFrom) {
      reason = "agree_again";
      continue;
    }
    if (cutoff && a.countsFrom <= cutoff) {
      if (reason !== "agree_again") reason = "ask_again";
      continue;
    }
    return { acceptance: a, reason: "never" };
  }
  return { acceptance: null, reason };
}

/**
 * Whether a document applies (one rule for every caller): a `dependants` document only when the
 * participant is a minor, and a `payer` document only to a Person who may pay, never a minor. In
 * a Person's own standing (the Person tab, "before you go on") they are both participant and
 * the one it is for.
 */
export const appliesTo = (
  doc: Attached,
  participant: PersonFacts,
  person: PersonFacts = participant,
) =>
  (doc.forWhom === "everyone" || isMinor(participant)) && (doc.who !== "payer" || !isMinor(person));

/** A Person's acceptances of these documents, without anything they typed or drew. */
export async function acceptancesOf(
  db: Db,
  personIds: readonly string[],
  documentIds: readonly string[],
): Promise<Map<string, AcceptanceFact[]>> {
  const out = new Map<string, AcceptanceFact[]>();
  if (!personIds.length || !documentIds.length) return out;
  const rows = await db
    .selectFrom("core_agreement_acceptance")
    .select(["id", "person_id", "document_id", "version_id", "by", "accepted_at", "signed_on"])
    .where("person_id", "in", [...personIds])
    // An erased acceptance (its Person's, or the guardian's who made it) no longer counts.
    .where("erased_at", "is", null)
    .where("document_id", "in", [...documentIds])
    .execute();
  for (const row of rows) {
    const key = `${row.person_id}\u0000${row.document_id}`;
    const list = out.get(key) ?? [];
    list.push({
      id: row.id,
      documentId: row.document_id,
      versionId: row.version_id,
      by: row.by,
      acceptedAt: row.accepted_at,
      countsFrom: row.signed_on ? `${row.signed_on}T00:00:00.000Z` : row.accepted_at,
    });
    out.set(key, list);
  }
  return out;
}

export const acceptanceKey = (personId: string, documentId: string) =>
  `${personId}\u0000${documentId}`;

export interface DueQuery {
  /** The agreement point; null asks about every point (a customer's "before you go on"). */
  point: string | null;
  /** The Person it is for. */
  participant: string | null;
  /** The Person who pays (null for a record that is not bought). */
  payer: string | null;
  now: string;
}

/**
 * What must still be agreed to at a point (ADR 0641 as amended), and the counter it was read at.
 * The counter is read first, so anything that changes what is due after it fails the guard.
 */
export async function agreementsDue(
  db: Db,
  query: DueQuery,
): Promise<{ rev: number; due: DueDocument[] }> {
  const rev = await readRev(db);
  const docs = await attachedDocuments(db, query.point);
  if (!docs.length) return { rev, due: [] };
  const people = [...new Set([query.participant, query.payer].filter((p): p is string => !!p))];
  const facts = new Map<string, PersonFacts>();
  for (const id of people) facts.set(id, await personFacts(db, id));
  const accepted = await acceptancesOf(
    db,
    people,
    docs.map((d) => d.id),
  );
  const participantFacts = query.participant ? facts.get(query.participant) : undefined;
  const due: DueDocument[] = [];
  for (const doc of docs) {
    const personId = doc.who === "payer" ? query.payer : query.participant;
    if (!personId) continue;
    const personFact = facts.get(personId) as PersonFacts;
    if (!appliesTo(doc, participantFacts ?? personFact, personFact)) continue;
    const { acceptance, reason } = countingAcceptance(
      doc,
      personFact,
      accepted.get(acceptanceKey(personId, doc.id)) ?? [],
      query.now,
    );
    if (acceptance) continue;
    due.push({
      documentId: doc.id,
      kind: doc.kind,
      title: doc.title,
      personId,
      who: doc.who,
      version: doc.current,
      scheduled: doc.scheduled,
      reason,
    });
  }
  return { rev, due };
}

/**
 * The statement a write that relied on `agreementsDue` carries in its own batch: it fails unless
 * the counter is still `rev` at commit (migration 0851, kind `agreements`).
 */
export function agreementsGuard(rev: number): CompiledQuery {
  // The row shape of every core_write_guard kind (recurring/bookkeeping.ts); this kind reads the
  // agreements counter and ignores the record.
  return CompiledQuery.raw(
    "INSERT INTO core_write_guard (kind, object_type, record_id, expected) VALUES (?, ?, ?, ?)",
    ["agreements", "core_agreement_rev", "1", rev],
  );
}

/**
 * For a write that needs nothing due (step 3: an order, a subscription, a booking): refused with
 * `rule: "agreements_due"` and the due documents by id and title, or the guard to queue.
 */
export async function requireNothingDue(db: Db, query: DueQuery): Promise<CompiledQuery> {
  const { rev, due } = await agreementsDue(db, query);
  if (due.length) throw dueRefusal(due);
  return agreementsGuard(rev);
}

/**
 * The refusal when something is due: `invalid_input`, `rule: "agreements_due"`, and the documents
 * by id, title and the version to read. A known Person's carry whose each is (the caller's own,
 * their dependant's, or for staff the Person's); a guest's carry no Person at all.
 */
export function dueRefusal(
  due: readonly {
    documentId: string;
    title: string;
    version: DueVersion;
    personId?: string | null;
  }[],
  message?: string,
): ValidationError {
  return new ValidationError(
    message ?? `Something must be agreed to first: ${due.map((d) => d.title).join(", ")}`,
    {
      rule: "agreements_due",
      documents: due.map((d) => ({
        documentId: d.documentId,
        title: d.title,
        versionId: d.version.id,
        ...(d.personId ? { personId: d.personId } : {}),
      })),
    },
  );
}

/** A document a guest must agree to with their purchase: no Person is read for it. */
export interface GuestDueDocument {
  documentId: string;
  kind: string;
  title: string;
  who: "participant" | "payer";
  version: DueVersion;
}

/**
 * What a guest (the public, buying without an account) must agree to at these points in the
 * buying call, and the counter, read first (stage 44 step 3, ADR 0644). No Person is read: a guest
 * is an unknown adult paying for themselves, so every live document attached there that is for
 * everyone is due, whatever the address matches, and the answer says nothing about whether the
 * address has agreed before (spec 44: "a guest who is already a member and has agreed is asked
 * again"). A `dependants` document never applies: a guest buys for no one else.
 */
export async function guestDue(
  db: Db,
  points: readonly string[],
): Promise<{ rev: number; due: GuestDueDocument[] }> {
  const rev = await readRev(db);
  const seen = new Set<string>();
  const due: GuestDueDocument[] = [];
  for (const point of new Set(points)) {
    for (const doc of await attachedDocuments(db, point)) {
      if (seen.has(doc.id) || doc.forWhom !== "everyone") continue;
      seen.add(doc.id);
      due.push({
        documentId: doc.id,
        kind: doc.kind,
        title: doc.title,
        who: doc.who,
        version: doc.current,
      });
    }
  }
  return { rev, due };
}

/**
 * `agreementsDue` at several points at once (an order with lines at different points): each
 * document once per Person, with the counter read before any of them.
 */
export async function agreementsDueAt(
  db: Db,
  points: readonly string[],
  query: Omit<DueQuery, "point">,
): Promise<{ rev: number; due: DueDocument[] }> {
  const rev = await readRev(db);
  const seen = new Set<string>();
  const due: DueDocument[] = [];
  for (const point of new Set(points)) {
    for (const doc of (await agreementsDue(db, { ...query, point })).due) {
      const key = `${doc.personId}\u0000${doc.documentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      due.push(doc);
    }
  }
  return { rev, due };
}
