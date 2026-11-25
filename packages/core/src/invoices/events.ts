// The document event log (stage 35 decision 11, ADR 0730): one row per issue, send, payment
// applied or reversed, credit, refund confirmed, paid back and void, queued by host code in the
// batch of the event itself, so the log and the documents always agree. Finance reports (stage
// 52) and Accounting sync (stage 61) read it by `seq` and never touch invoices/ or orders/. The
// database refuses any update or delete of a row, and a row below the newest (migration 1030).
import type { CoreDatabase, CoreInvoiceEventTable } from "@composable-os/db";
import type { Compilable, Kysely, Selectable } from "kysely";

export const INVOICE_EVENTS = [
  "issued",
  "sent",
  "payment_applied",
  "payment_reversed",
  "credited",
  "refund_confirmed",
  "paid_back",
  "voided",
] as const;
export type InvoiceEvent = (typeof INVOICE_EVENTS)[number];

export const DOCUMENT_KINDS = ["quote", "invoice", "credit_note"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The most rows one read of the log returns. */
export const EVENTS_PAGE_MAX = 500;

export interface EventEntry {
  documentKind: DocumentKind;
  documentId: string;
  /** The invoice it concerns (a credit note's invoice); null for a quote's. */
  invoiceId?: string | null;
  event: InvoiceEvent;
  paymentId?: string | null;
  method?: string | null;
  amount?: number | null;
  currency?: string | null;
  at: string;
  /** The staff account that caused it; null for the host's own (a verified payment, the cron). */
  byUser?: string | null;
}

/** The insert to queue in the event's own batch. */
export function eventStatement(db: Kysely<CoreDatabase>, entry: EventEntry): Compilable {
  return db.insertInto("core_invoice_event").values({
    document_kind: entry.documentKind,
    document_id: entry.documentId,
    invoice_id: entry.invoiceId ?? (entry.documentKind === "invoice" ? entry.documentId : null),
    event: entry.event,
    payment_id: entry.paymentId ?? null,
    method: entry.method ?? null,
    amount: entry.amount ?? null,
    currency: entry.currency ?? null,
    at: entry.at,
    by_user: entry.byUser ?? null,
  });
}

export type EventRow = Selectable<CoreInvoiceEventTable>;

/** The rows after `after` (a seq; 0 for the start), oldest first, at most `limit`. */
export function eventsAfter(
  db: Kysely<CoreDatabase>,
  after: number,
  limit: number,
): Promise<EventRow[]> {
  return db
    .selectFrom("core_invoice_event")
    .selectAll()
    .where("seq", ">", after)
    .orderBy("seq")
    .limit(Math.min(limit, EVENTS_PAGE_MAX))
    .execute();
}
