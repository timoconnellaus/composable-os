// The accounting outbox (stage 61 step 4, ADR 0882): what host code queues to send to the books,
// one row of `core_accounting_post` per entry, each with its fixed reference. Steps 5 (summaries
// and payouts) and 6 (contacts and documents) build entries from host records and queue them
// here; the runner (`runner.ts`) sends them.
//
// - **Once.** The reference is `cos:<kind>:<source id>:<n>`, unique in the table: queuing the same
//   entry again is a no-op (an insert conditional on the reference, so two builders at once
//   queue one), and the books store it, so nothing is ever written there twice.
// - **The mapping's keys, not the books' refs.** Where an account or a tax rate goes, an entry
//   holds `{ map: <kind>, key? }`; the runner resolves it when it sends, so a mapping changed
//   before then applies, and an entry nobody mapped waits ("map passes to an account"). Where a
//   payment names its invoice, it holds `{ dep: "books_ref" }`: the books' ref of the entry it
//   depends on, known once that one is sent.
// - **Nothing before the start date.** An entry whose day is before it is never queued.
// - **Approval.** Until a person has approved `approve_until` days, an entry waits for its day to
//   be approved (`awaiting_approval`); after, it is queued at once. Decided in the insert itself,
//   so an approval counted meanwhile is read as it is.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { parseLocalDate } from "../time/local.ts";
import { ACCOUNTING_MAP_KINDS, type AccountingMapKind, KEYED_MAP_KINDS } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** The kinds the runner sends. A void is requested by a person and always reviewed (step 6). */
export const SENDABLE_KINDS = [
  "summary",
  "adjustment",
  "transfer",
  "contact",
  "invoice",
  "credit_note",
  "payment",
  "refund",
] as const;
export type SendableKind = (typeof SENDABLE_KINDS)[number];

/** Where a books account or tax rate goes: the mapping row it is resolved from when sent. */
export interface MapRef {
  map: AccountingMapKind;
  key?: string;
}
/** The books' ref of the entry this one depends on (a payment's invoice), once that is sent. */
export interface DepRef {
  dep: "books_ref";
}

/** The contract method each kind is sent with. */
export const KIND_METHOD: Record<SendableKind, string> = {
  summary: "postSummary",
  adjustment: "postSummary",
  transfer: "postTransfer",
  contact: "upsertContact",
  invoice: "postInvoice",
  credit_note: "postCreditNote",
  payment: "postPayment",
  refund: "postRefund",
};

/** The call's field that carries its date (none for a contact). */
export function dateField(kind: SendableKind): "date" | "issueDate" | null {
  if (kind === "contact") return null;
  return kind === "invoice" || kind === "credit_note" ? "issueDate" : "date";
}

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The fixed reference of an entry: `cos:<kind>:<source id>:<n>`. */
export function postReference(kind: SendableKind, sourceId: string, n = 1): string {
  if (!SOURCE_ID.test(sourceId) || !Number.isSafeInteger(n) || n < 1) {
    throw new ValidationError("An entry's source id is 1 to 64 of A-Z, a-z, 0-9, _ and -", {
      field: "sourceId",
      rule: "accounting_reference",
    });
  }
  return `cos:${kind}:${sourceId}:${n}`;
}

export interface QueuePostInput {
  connectionId: string;
  kind: SendableKind;
  /** What host record it is built from (`day`, `payout`, `invoice` …) and its id. */
  sourceKind: string;
  sourceId: string;
  /** The n-th entry from that source (an adjustment's version), from 1. */
  n?: number;
  /** The day its money belongs to; the date it carries is the same until a lock date moves it. */
  belongsDate: string;
  /** Its total in minor units, for the log. */
  amount: number;
  /** The call's lines, with `MapRef`s where accounts and tax rates go. */
  lines?: unknown[];
  /** The call's other fields (text, number, dates, accounts, amount), with `MapRef`s and `DepRef`s. */
  body: Record<string, unknown>;
  /** What a contact or document carries about the person it is for (an erase may clear it). */
  detail?: unknown;
  /** The entry that must be sent first (a payment's invoice, an invoice's contact). */
  dependsOn?: string | null;
}

/** Throws unless every `{ map }` in `value` names a mapping kind, with a key where it takes one. */
function checkRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) checkRefs(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if ("map" in object) {
    const kind = object.map as AccountingMapKind;
    const keyed = KEYED_MAP_KINDS.includes(kind);
    if (
      !ACCOUNTING_MAP_KINDS.includes(kind) ||
      keyed !== (typeof object.key === "string" && object.key !== "")
    ) {
      throw new ValidationError(`Not a mapping: ${JSON.stringify(value).slice(0, 100)}`, {
        field: "lines",
        rule: "accounting_map_ref",
      });
    }
    return;
  }
  if ("dep" in object) return;
  for (const item of Object.values(object)) checkRefs(item);
}

/**
 * The statement that queues one entry, once: nothing when its reference is queued already, or
 * when the books have no settings or its day is before the start date. Its state is read from the
 * settings in the same statement: `queued` once approval is over, else `awaiting_approval`.
 * Commit it in the builder's own batch, with the items it counts.
 */
export function queuePostStatement(
  input: QueuePostInput,
  now: string,
): { id: string; reference: string; statement: CompiledQuery } {
  if (!SENDABLE_KINDS.includes(input.kind)) {
    throw new ValidationError(`Not an entry the runner sends: ${input.kind}`, {
      field: "kind",
      rule: "accounting_kind",
    });
  }
  if (!parseLocalDate(input.belongsDate)) {
    throw new ValidationError("An entry's day is a date, YYYY-MM-DD", { field: "belongsDate" });
  }
  if (!Number.isSafeInteger(input.amount)) {
    throw new ValidationError("An entry's amount is whole minor units", { field: "amount" });
  }
  const lines = input.lines ?? [];
  checkRefs(lines);
  checkRefs(input.body);
  const id = newId("accountingPost");
  const reference = postReference(input.kind, input.sourceId, input.n ?? 1);
  const statement = CompiledQuery.raw(
    `INSERT INTO core_accounting_post (id, connection_id, kind, source_kind, source_id, n,
       reference, carries_date, belongs_date, amount, lines, body, detail, depends_on, state,
       created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11, ?12, ?13,
       CASE WHEN s.approved_days >= s.approve_until THEN 'queued' ELSE 'awaiting_approval' END,
       ?14, ?14
     FROM core_accounting_settings s
     WHERE s.id = 1 AND s.connection_id = ?2 AND s.start_date IS NOT NULL
       AND ?8 >= s.start_date
       AND NOT EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.reference = ?7)`,
    [
      id,
      input.connectionId,
      input.kind,
      input.sourceKind,
      input.sourceId,
      input.n ?? 1,
      reference,
      input.belongsDate,
      input.amount,
      JSON.stringify(lines),
      JSON.stringify(input.body),
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.dependsOn ?? null,
      now,
    ],
  );
  return { id, reference, statement };
}

/**
 * Queues one entry now, once. Returns the id of the entry with its reference: the one just queued,
 * or the one queued before. `null` when it was not queued: no books, or its day is before the start
 * date (nothing before it is ever sent).
 */
export async function queuePost(
  db: Db,
  input: QueuePostInput,
  now: string,
): Promise<{ id: string; reference: string; state: string } | null> {
  const { reference, statement } = queuePostStatement(input, now);
  await db.executeQuery(statement);
  const row = await db
    .selectFrom("core_accounting_post")
    .select(["id", "state"])
    .where("reference", "=", reference)
    .executeTakeFirst();
  return row ? { id: row.id, reference, state: row.state } : null;
}
