// Credit notes and void (stage 35 step 5, ADR 0735): mistakes are put right with a numbered credit
// note, never by editing what was sent.
//
// A credit note is drafted against an issued invoice (`creditNote.create`, invoices:write): some
// of its lines (part quantities), or an amount at one of its rates. Issuing it (`creditNote.issue`,
// invoices:credit, a person only) gives it its number and, in one batch:
//   1. reduces what is owed first (`credited` on the invoice's order: balance = total - paid -
//      credited), as far as the credit note says (`settle`: reduce, refund, or both in that order);
//   2. gives back the rest of it from what was paid, payment by payment, newest first: a
//      provider's through the existing refund approval (`payments.refund`, a person with
//      `orders:refund` approves), a recorded one owed until a person records it paid back
//      (`order.recordRefund`). Never more than was paid and not yet given back or owed back;
//   3. an invoice credited in full with nothing paid is `credited`, its order cancelled and its
//      places given back; with something paid it is paid once nothing is owed.
// `invoice.void` is the shortcut: a credit note for everything still owed on an invoice nothing
// was paid on, issued at once, and the invoice `void`.
//
// What may be credited is bounded three ways against the credit notes issued before: each line by
// its quantity and its amount, each rate by the invoice's total at it, and the invoice by its
// total. So credit notes together never credit more than the invoice, and what they give back
// never more than was paid on it. A provider refund of an invoice's applied payment is only ever
// asked for here (order.refund refuses one), so a credit note and a refund never both give the
// same money back.
import type { CoreCreditNoteLineTable, CoreCreditNoteTable } from "@composable-os/db";
import type { Selectable } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { refusePageOpen } from "../orders/checkout.ts";
import { changeOrder, formatMoney, loadOrderRow, type OrderRow, owedOn } from "../orders/orders.ts";
import { askSameRefundAgain, refundablePayments, requestRefund } from "../orders/refunds.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localDay } from "../time/local.ts";
import { orgReader, type Viewer, visibleSource } from "../visibility/index.ts";
import {
  DOCUMENT_MAX_LINES,
  documentObject,
  documentVisible,
  type InvoiceRow,
  type LineRow,
  linesOf,
  loadDocument,
} from "./drafts.ts";
import { eventStatement } from "./events.ts";
import { businessSnapshot } from "./issue.ts";
import { numberStatements } from "./numbering.ts";
import { loadInvoiceSettings } from "./settings.ts";
import { documentTotals, lineAmounts, mulDivHalfUp } from "./tax.ts";

export type CreditNoteRow = Selectable<CoreCreditNoteTable>;
export type CreditLineRow = Selectable<CoreCreditNoteLineTable>;
export type Settle = CreditNoteRow["settle"];

/** The credit notes the seam shows `reader` (their `rec_credit_note` view), as a source. */
export function creditNoteSource(reader: Viewer) {
  return visibleSource(reader, documentObject("creditNote"));
}

/** An invoice's states a credit note may be made for: issued and not yet credited or void. */
const CREDITABLE: ReadonlySet<string> = new Set(["issued", "sent", "part_paid", "paid"]);

export function requireCreditable(invoice: InvoiceRow): void {
  if (!CREDITABLE.has(invoice.state)) {
    throw new ConflictError(
      invoice.state === "draft"
        ? "A draft invoice is changed or deleted, not credited"
        : `This invoice is ${invoice.state}: nothing is left to credit`,
      { rule: "credit_state", state: invoice.state },
    );
  }
}

/** What credit notes already issued against an invoice took, per line, per rate and in all. */
export interface Credited {
  byLine: Map<string, { milli: number; total: number; tax: number }>;
  /** Keyed by the rate's key; `""` is the invoice's untaxed part. */
  byRate: Map<string, { total: number; tax: number }>;
  total: number;
}

export async function creditedSoFar(
  ctx: Pick<HandlerContext, "db">,
  invoiceId: string,
  except?: string,
): Promise<Credited> {
  // The invoice's issued credit notes through the seam, org-wide (host code), then their lines.
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const notes = (await (ctx.db as any)
    .selectFrom(creditNoteSource(orgReader(ctx.db)))
    .select("id")
    .where("invoice_id", "=", invoiceId)
    .where("state", "=", "issued")
    .execute()) as { id: string }[];
  const ids = notes.map((n) => n.id).filter((id) => id !== except);
  const rows = ids.length
    ? await ctx.db
        .selectFrom("core_credit_note_line")
        .select(["credits_line_id", "quantity_milli", "line_total", "line_tax", "tax_key"])
        .where("credit_note_id", "in", ids)
        .execute()
    : [];
  const out: Credited = { byLine: new Map(), byRate: new Map(), total: 0 };
  for (const row of rows) {
    out.total += row.line_total;
    const rate = out.byRate.get(row.tax_key ?? "") ?? { total: 0, tax: 0 };
    rate.total += row.line_total;
    rate.tax += row.line_tax;
    out.byRate.set(row.tax_key ?? "", rate);
    if (row.credits_line_id) {
      const line = out.byLine.get(row.credits_line_id) ?? { milli: 0, total: 0, tax: 0 };
      line.milli += row.quantity_milli;
      line.total += row.line_total;
      line.tax += row.line_tax;
      out.byLine.set(row.credits_line_id, line);
    }
  }
  return out;
}

/** What is left to credit of an invoice at each rate, and in all. */
function roomByRate(invoice: InvoiceRow, lines: readonly LineRow[], credited: Credited) {
  const totals = documentTotals(
    lines.map((l) => {
      const sign = l.source === "deduction" ? -1 : 1;
      return {
        taxKey: l.tax_key,
        taxLabel: l.tax_label,
        taxRate: l.tax_rate,
        net: sign * l.line_net,
        tax: sign * l.line_tax,
        total: sign * l.line_total,
      };
    }),
  );
  const room = new Map<
    string,
    { total: number; tax: number; label: string | null; rate: number }
  >();
  for (const rate of totals.byRate) {
    const used = credited.byRate.get(rate.key) ?? { total: 0, tax: 0 };
    room.set(rate.key, {
      total: rate.total - used.total,
      tax: rate.tax - used.tax,
      label: rate.label,
      rate: rate.rate,
    });
  }
  const untaxed = totals.total - totals.byRate.reduce((sum, r) => sum + r.total, 0);
  const usedUntaxed = credited.byRate.get("") ?? { total: 0, tax: 0 };
  room.set("", { total: untaxed - usedUntaxed.total, tax: 0, label: null, rate: 0 });
  return { room, total: invoice.total - credited.total };
}

/** What a credit note may hold: some of the invoice's lines, or an amount at one of its rates. */
export type CreditRequest =
  | { lines: readonly { lineId: string; quantity?: number | undefined }[]; amount?: undefined }
  | {
      lines?: undefined;
      amount: {
        /** In minor units, as the invoice's amounts are typed (with or without tax). */
        value: number;
        /** One of the invoice's rates' keys; null for its untaxed part. */
        taxRate: string | null;
        description?: string | undefined;
      };
    };

/** A credit note's line as written. */
export type NewCreditLine = Omit<CreditLineRow, "credit_note_id" | "created_at">;

function refuseCredit(message: string, rule: string, extra?: object): never {
  throw new ValidationError(message, { rule, ...extra });
}

/**
 * The lines a credit request makes against `invoice`, checked against what credit notes issued
 * before took: a line's quantity at most what is left of it, its amount the line's in proportion
 * (all of what is left, for the rest of it); an amount at a rate at most what is left at that
 * rate; and together at most what is left of the invoice.
 */
export function creditLines(
  invoice: InvoiceRow,
  invoiceLines: readonly LineRow[],
  credited: Credited,
  request: CreditRequest,
): NewCreditLine[] {
  const out: NewCreditLine[] = [];
  if (request.lines) {
    const seen = new Set<string>();
    for (const [position, asked] of request.lines.entries()) {
      if (seen.has(asked.lineId))
        refuseCredit("A line is credited once per credit note", "duplicate_line");
      seen.add(asked.lineId);
      const line = invoiceLines.find((l) => l.id === asked.lineId);
      if (!line || line.source === "deduction") {
        refuseCredit("That is not a line of this invoice that can be credited", "credit_line", {
          lineId: asked.lineId,
        });
      }
      const used = credited.byLine.get(line.id) ?? { milli: 0, total: 0, tax: 0 };
      const leftMilli = line.quantity_milli - used.milli;
      const milli = asked.quantity === undefined ? leftMilli : Math.round(asked.quantity * 1000);
      if (leftMilli <= 0 || line.line_total - used.total <= 0) {
        refuseCredit(`"${line.description}" has been credited in full`, "credited_in_full", {
          lineId: line.id,
        });
      }
      if (!Number.isInteger(milli) || milli <= 0 || milli > leftMilli) {
        refuseCredit(
          `At most ${leftMilli / 1000} of "${line.description}" is left to credit`,
          "credit_quantity",
          { lineId: line.id, left: leftMilli / 1000 },
        );
      }
      // The rest of a line is what is left of it, exactly; a part is its share, half up.
      const rest = milli === leftMilli;
      const total = rest
        ? line.line_total - used.total
        : Math.min(
            line.line_total - used.total,
            mulDivHalfUp(line.line_total, milli, line.quantity_milli),
          );
      const tax = rest
        ? line.line_tax - used.tax
        : Math.min(
            line.line_tax - used.tax,
            total,
            mulDivHalfUp(line.line_tax, milli, line.quantity_milli),
          );
      out.push({
        id: newId("creditNoteLine"),
        position,
        description: line.description,
        quantity_milli: milli,
        unit: line.unit,
        unit_price: line.unit_price,
        tax_key: line.tax_key,
        tax_label: line.tax_label,
        tax_rate: line.tax_rate,
        line_net: total - tax,
        line_tax: tax,
        line_total: total,
        credits_line_id: line.id,
      });
    }
  } else {
    const { value, taxRate, description } = request.amount;
    const used = invoiceLines.find(
      (l) => (l.tax_key ?? null) === taxRate && l.source !== "deduction",
    );
    if (!used) {
      refuseCredit(
        taxRate === null
          ? "This invoice has no line without tax to credit an amount against"
          : `This invoice has no line at the rate ${taxRate}`,
        "credit_rate",
        { taxRate },
      );
    }
    const amounts = lineAmounts({
      unitPrice: value,
      quantityMilli: 1000,
      rate: used.tax_rate,
      mode: invoice.tax_mode,
      discount: null,
    });
    out.push({
      id: newId("creditNoteLine"),
      position: 0,
      description: description ?? `Credit at ${used.tax_label ?? "no tax"}`,
      quantity_milli: 1000,
      unit: null,
      unit_price: value,
      tax_key: used.tax_key,
      tax_label: used.tax_label,
      tax_rate: used.tax_rate,
      line_net: amounts.net,
      line_tax: amounts.tax,
      line_total: amounts.total,
      credits_line_id: null,
    });
  }
  checkRoom(invoice, invoiceLines, credited, out);
  return out;
}

/** Refuses credit lines beyond what is left at their rates, or of the invoice. */
function checkRoom(
  invoice: InvoiceRow,
  invoiceLines: readonly LineRow[],
  credited: Credited,
  lines: readonly NewCreditLine[],
): void {
  const { room, total } = roomByRate(invoice, invoiceLines, credited);
  const asked = new Map<string, { total: number; tax: number }>();
  let all = 0;
  for (const line of lines) {
    const key = line.tax_key ?? "";
    const entry = asked.get(key) ?? { total: 0, tax: 0 };
    entry.total += line.line_total;
    entry.tax += line.line_tax;
    asked.set(key, entry);
    all += line.line_total;
  }
  if (all <= 0) refuseCredit("A credit note credits something", "credit_nothing");
  for (const [key, want] of asked) {
    const left = room.get(key) ?? { total: 0, tax: 0 };
    if (want.total > left.total || want.tax > left.tax) {
      refuseCredit(
        `At most ${formatMoney(Math.max(0, left.total), invoice.currency)} is left to credit ${key ? `at ${key}` : "without tax"}`,
        "credit_beyond_invoice",
        { taxRate: key || null, left: Math.max(0, left.total) },
      );
    }
  }
  if (all > total) {
    refuseCredit(
      `At most ${formatMoney(Math.max(0, total), invoice.currency)} is left to credit on this invoice`,
      "credit_beyond_invoice",
      { left: Math.max(0, total) },
    );
  }
}

/** The totals columns of a credit note's lines. */
export function creditTotals(lines: readonly NewCreditLine[]) {
  const totals = documentTotals(
    lines.map((l) => ({
      taxKey: l.tax_key,
      taxLabel: l.tax_label,
      taxRate: l.tax_rate,
      net: l.line_net,
      tax: l.line_tax,
      total: l.line_total,
    })),
  );
  return {
    net_total: totals.net,
    tax_total: totals.tax,
    total: totals.total,
    tax_by_rate: JSON.stringify(totals.byRate),
  };
}

/** A new draft credit note's row, for `invoice`. */
export function draftRow(
  ctx: HandlerContext,
  invoice: InvoiceRow,
  lines: readonly NewCreditLine[],
  reason: string,
  settle: Settle,
): CreditNoteRow {
  return {
    id: newId("creditNote"),
    state: "draft",
    number: null,
    number_seq: null,
    invoice_id: invoice.id,
    currency: invoice.currency,
    tax_mode: invoice.tax_mode,
    person_id: invoice.person_id,
    organisation_id: invoice.organisation_id,
    bill_to_name: null,
    bill_to_address: null,
    bill_to_tax_number: null,
    bill_to_email: null,
    reason,
    settle,
    issued_on: null,
    issued_at: null,
    business: null,
    created_at: ctx.now,
    created_by: ctx.user.id,
    updated_at: ctx.now,
    updated_by: ctx.user.id,
    version: 0,
    ...creditTotals(lines),
  };
}

/** The inserts of a draft credit note and its lines. */
export function draftStatements(
  ctx: HandlerContext,
  row: CreditNoteRow,
  lines: readonly NewCreditLine[],
) {
  return [
    ctx.db.insertInto("core_credit_note").values(row),
    ...lines.map((line) =>
      ctx.db
        .insertInto("core_credit_note_line")
        .values({ ...line, credit_note_id: row.id, created_at: ctx.now }),
    ),
  ];
}

/**
 * A credit note, whole: through the seam first (as `reader` sees it; host code: org-wide), then
 * its table for what its view leaves out (its reason, its version) and its lines.
 */
export async function loadCreditNote(
  ctx: Pick<HandlerContext, "db">,
  id: string,
  reader: Viewer = orgReader(ctx.db),
) {
  if (!(await documentVisible(ctx.db, reader, "creditNote", id))) {
    throw new NotFoundError("credit note", id);
  }
  const note = await ctx.db
    .selectFrom("core_credit_note")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!note) throw new NotFoundError("credit note", id);
  const lines = await ctx.db
    .selectFrom("core_credit_note_line")
    .selectAll()
    .where("credit_note_id", "=", id)
    .orderBy("position")
    .limit(DOCUMENT_MAX_LINES + 1)
    .execute();
  return { note, lines };
}

/**
 * What a credit note gives back on one payment, and where that stands:
 *   - `given_back`: the provider confirmed the refund, or a person recorded it paid back;
 *   - `asked`: the refund waits in Approvals, or was approved and waits for the provider;
 *   - `owed`: not given back. A recorded payment's until a person pays it back; a provider's whose
 *     refund a person rejected, whose approval expired or that failed, until it is asked for
 *     again (`creditNote.askRefundAgain`).
 */
export interface CreditRefund {
  id: string;
  creditNoteId: string;
  provider: string;
  paymentRef: string;
  method: "provider" | "recorded";
  amount: number;
  refundId: string | null;
  attempt: number;
  paidBackAt: string | null;
  state: "given_back" | "asked" | "owed";
  /**
   * Why an owed one is owed: a recorded payment not yet paid back; a provider's refund a person
   * rejected, whose approval expired, that failed when it was applied, or that the provider has
   * not confirmed within CREDIT_REFUND_CONFIRM_DAYS of its approval.
   */
  why: "not_paid_back" | "rejected" | "expired" | "failed" | "unconfirmed" | null;
}

/**
 * How long a provider's refund, once approved, may go without its confirmation before it is owed
 * again (review of PR #460): five days. A card refund the provider takes is confirmed within
 * seconds by its webhook, which it retries for up to three days; past that, it did not happen, or
 * its confirmation was lost, and staff are told (orders/refund-due.ts).
 */
export const CREDIT_REFUND_CONFIRM_DAYS = 5;

/** The money back an order's credit notes (or one of them) give, each with where it stands. */
export async function creditRefunds(
  ctx: Pick<HandlerContext, "db" | "now">,
  orderId: string,
  creditNoteId?: string,
): Promise<CreditRefund[]> {
  let query = ctx.db
    .selectFrom("core_credit_note_refund as c")
    .leftJoin("core_order_refund as r", "r.id", "c.refund_id")
    .leftJoin("core_pending_action as p", "p.id", "r.pending_action_id")
    .select([
      "c.id",
      "c.credit_note_id",
      "c.provider",
      "c.payment_ref",
      "c.method",
      "c.amount",
      "c.refund_id",
      "c.attempt",
      "c.paid_back_at",
      "r.status as refund",
      "p.status as action",
      "p.expires_at",
      "p.decided_at",
    ])
    .where("c.order_id", "=", orderId);
  if (creditNoteId) query = query.where("c.credit_note_id", "=", creditNoteId);
  const rows = await query.orderBy("c.created_at").orderBy("c.id").execute();
  const confirmBy = new Date(
    Date.parse(ctx.now) - CREDIT_REFUND_CONFIRM_DAYS * 86_400_000,
  ).toISOString();
  return rows.map((row) => {
    let state: CreditRefund["state"];
    let why: CreditRefund["why"] = null;
    if (row.method === "recorded") {
      state = row.paid_back_at ? "given_back" : "owed";
      if (!row.paid_back_at) why = "not_paid_back";
    } else if (row.refund === "confirmed") {
      state = "given_back";
    } else if (row.action === "applied") {
      const lapsed = (row.decided_at ?? "") < confirmBy;
      state = lapsed ? "owed" : "asked";
      if (lapsed) why = "unconfirmed";
    } else if (row.action === "pending" && (row.expires_at === null || row.expires_at > ctx.now)) {
      state = "asked";
    } else {
      state = "owed";
      why = row.action === "rejected" ? "rejected" : row.action === "failed" ? "failed" : "expired";
    }
    return {
      id: row.id,
      creditNoteId: row.credit_note_id,
      provider: row.provider,
      paymentRef: row.payment_ref,
      method: row.method,
      amount: row.amount,
      refundId: row.refund_id,
      attempt: row.attempt,
      paidBackAt: row.paid_back_at,
      state,
      why,
    };
  });
}

/**
 * Asks again, in the calling batch, for each of a credit note's provider refunds that is owed:
 * the same amount, on the same payment, through the same approval. One that may have reached the
 * provider (it failed when it was applied, or the provider never confirmed it) is asked again under
 * the same refund id, which is the provider's idempotency key, so a refund that did happen is
 * recognised there, never made twice; one that never left the approval (rejected, expired) is a
 * new refund. Returns the approvals asked for.
 */
export async function askRefundAgain(
  ctx: HandlerContext,
  note: CreditNoteRow,
): Promise<{ asked: CreditRefund[]; pending: string[] }> {
  if (note.state !== "issued") {
    throw new ConflictError("Only an issued credit note gives money back", {
      rule: "credit_state",
    });
  }
  const invoice = await loadDocument(ctx.db, "invoice", note.invoice_id, ctx);
  const order = await loadOrderRow(ctx.db, invoice.order_id as string);
  const owed = (await creditRefunds(ctx, order.id, note.id)).filter(
    (r) => r.method === "provider" && r.state === "owed",
  );
  if (!owed.length) {
    throw new ConflictError(
      "Nothing this credit note gives back through the payment provider is owed: each refund was confirmed or waits for a person",
      { rule: "refund_not_owed" },
    );
  }
  const pending: string[] = [];
  for (const row of owed) {
    let refundId: string;
    if ((row.why === "failed" || row.why === "unconfirmed") && row.refundId) {
      const again = await askSameRefundAgain(ctx, order, row.refundId);
      refundId = row.refundId;
      if (again.pendingActionId) pending.push(again.pendingActionId);
    } else {
      const asked = await requestRefund(ctx, order, {
        amount: row.amount,
        reason: `Credit note ${note.number}, asked again: ${note.reason ?? ""}`.slice(0, 500),
        paymentRef: row.paymentRef,
        outcome: "applied",
      });
      const refund = asked.refunds[0];
      if (asked.refunds.length !== 1 || !refund || refund.amount !== row.amount) {
        // What can go back on the payment is less than the credit note owes: a bug, write nothing.
        throw new ConflictError("This payment cannot give back what the credit note owes", {
          rule: "credit_beyond_paid",
        });
      }
      refundId = refund.id;
      if (refund.pendingActionId) pending.push(refund.pendingActionId);
    }
    ctx.write(
      ctx.db
        .updateTable("core_credit_note_refund")
        .set({ refund_id: refundId, attempt: row.attempt + 1 })
        .where("id", "=", row.id)
        .where("attempt", "=", row.attempt),
    );
  }
  ctx.recordChange({
    object: "creditNote",
    id: note.id,
    action: "update",
    before: { owed: owed.reduce((sum, r) => sum + r.amount, 0) },
    after: {
      askedAgain: owed.map((r) => ({ paymentRef: r.paymentRef, amount: r.amount, why: r.why })),
    },
  });
  // Two asks at once are never both made: the order's version moves, so the second batch fails.
  await changeOrder(ctx, order, order.state, {}, "host");
  return { asked: owed, pending };
}

/** How a credit note settled, once issued. */
export interface Settled {
  reduced: number;
  refunded: {
    provider: string;
    paymentRef: string;
    method: "provider" | "recorded";
    amount: number;
    refundId: string | null;
    pendingActionId: string | null;
  }[];
  order: OrderRow;
  invoiceState: InvoiceRow["state"];
}

/**
 * Queues the issue of draft credit note `note` in the calling batch: its number and snapshot, what
 * it takes off what is owed, what it gives back and how, the invoice's and its order's new states,
 * and the event log. `voiding`: the credit note is the invoice's void (`invoice.void`), and the
 * invoice becomes `void` rather than `credited`.
 */
export async function issueCreditNote(
  ctx: HandlerContext,
  note: CreditNoteRow,
  noteLines: readonly NewCreditLine[],
  options: { voiding?: { reason: string } } = {},
): Promise<Settled> {
  if (note.state !== "draft") {
    throw new ConflictError("This credit note has been issued: it is never changed", {
      rule: "document_immutable",
    });
  }
  const invoice = await loadDocument(ctx.db, "invoice", note.invoice_id, ctx);
  requireCreditable(invoice);
  if (!invoice.order_id) {
    throw new ConflictError("This invoice has no order to credit", { rule: "credit_state" });
  }
  const invoiceLines = await linesOf(ctx.db, "invoice", invoice.id);
  // Bounded again on what is issued now: another credit note may have been issued meanwhile.
  checkRoom(invoice, invoiceLines, await creditedSoFar(ctx, invoice.id, note.id), noteLines);
  const order = await loadOrderRow(ctx.db, invoice.order_id);
  if (order.state !== "pending" && order.state !== "part_paid" && order.state !== "paid") {
    throw new ConflictError(`This invoice's order is ${order.state}: nothing is left to credit`, {
      rule: "credit_state",
      state: order.state,
    });
  }
  const credit = note.total;
  const owed = owedOn(order);
  if (note.settle === "reduce" && credit > owed) {
    throw new ValidationError(
      `Only ${formatMoney(owed, order.currency)} is still owed: give the rest back too (settle both)`,
      { field: "settle", rule: "credit_beyond_owed", owed },
    );
  }
  if (note.settle === "refund" && owed > 0) {
    throw new ValidationError(
      `${formatMoney(owed, order.currency)} is still owed: take that off first (settle both)`,
      { field: "settle", rule: "credit_owed_first", owed },
    );
  }
  const reduced = note.settle === "refund" ? 0 : Math.min(credit, owed);
  const back = credit - reduced;

  // What can go back, payment by payment, newest first: what was applied and not yet given back
  // or asked for, less what earlier credit notes still owe back on it (by hand, or a provider's
  // refund rejected, expired or failed, to be asked for again).
  await refusePageOpen(ctx, order, "credit it");
  const owedBack = (await creditRefunds(ctx, order.id)).filter((r) => r.state === "owed");
  const payments = (await refundablePayments(ctx, order.id, "applied"))
    .map((p) => ({
      ...p,
      refundable:
        p.refundable -
        owedBack
          .filter((o) => o.provider === p.provider && o.paymentRef === p.paymentRef)
          .reduce((sum, o) => sum + o.amount, 0),
    }))
    .filter((p) => p.refundable > 0);
  const available = payments.reduce((sum, p) => sum + p.refundable, 0);
  if (back > available) {
    throw new ValidationError(
      `Only ${formatMoney(available, order.currency)} paid on this invoice can still be given back`,
      { field: "settle", rule: "credit_beyond_paid", available },
    );
  }

  const settings = await loadInvoiceSettings(ctx.db);
  const zone = (await loadGeneralSettings(ctx.db)).timezone || "UTC";
  const issuedOn = localDay(ctx.now, zone).date;
  // The number first: the refund rows below name an issued credit note (migration 1031).
  ctx.write(
    ...numberStatements(ctx.db, "credit_note", note.id, note.version, {
      state: "issued",
      issued_on: issuedOn,
      issued_at: ctx.now,
      bill_to_name: invoice.bill_to_name,
      bill_to_address: invoice.bill_to_address,
      bill_to_tax_number: invoice.bill_to_tax_number,
      bill_to_email: invoice.bill_to_email,
      business: businessSnapshot(settings),
      updated_at: ctx.now,
      updated_by: ctx.user.id,
    }),
  );

  // The order: credited up by what was taken off. Credited in full with nothing paid, it is
  // cancelled (its places go back); paid and credited until nothing is owed, it is paid. The
  // write always moves the order's version, so two credit notes issued at once cannot both be
  // judged against the same read.
  const credited = order.credited + reduced;
  const cancelled = order.paid === 0 && credited === order.total;
  const settled =
    !cancelled && order.state === "part_paid" && order.paid + credited === order.total;
  const next = await changeOrder(
    ctx,
    order,
    cancelled ? "cancelled" : settled ? "paid" : order.state,
    {
      credited,
      ...(cancelled ? { cancelled_at: ctx.now } : {}),
      ...(settled ? { paid_at: ctx.now } : {}),
    },
    // The host's move: a person with invoices:credit issued the credit note that says so.
    "host",
    cancelled ? { invoiceState: options.voiding ? "void" : "credited" } : {},
  );

  // What goes back: the provider's payments asked for (each waits for a person's approval), the
  // recorded ones owed until a person records them paid back.
  const refunded: Settled["refunded"] = [];
  let left = back;
  for (const payment of payments) {
    if (left <= 0) break;
    const amount = Math.min(left, payment.refundable);
    left -= amount;
    if (payment.method === "provider") {
      const asked = await requestRefund(ctx, next, {
        amount,
        reason: `Credit note for invoice ${invoice.number}: ${note.reason ?? ""}`.slice(0, 500),
        paymentRef: payment.paymentRef,
        outcome: "applied",
      });
      for (const refund of asked.refunds) {
        refunded.push({
          provider: payment.provider,
          paymentRef: payment.paymentRef,
          method: "provider",
          amount: refund.amount,
          refundId: refund.id,
          pendingActionId: refund.pendingActionId,
        });
        ctx.write(
          ctx.db.insertInto("core_credit_note_refund").values({
            id: newId("creditNoteRefund"),
            credit_note_id: note.id,
            order_id: order.id,
            provider: payment.provider,
            payment_ref: payment.paymentRef,
            method: "provider",
            amount: refund.amount,
            refund_id: refund.id,
            created_at: ctx.now,
          }),
        );
      }
    } else if (payment.method === "recorded") {
      refunded.push({
        provider: payment.provider,
        paymentRef: payment.paymentRef,
        method: "recorded",
        amount,
        refundId: null,
        pendingActionId: null,
      });
      ctx.write(
        ctx.db.insertInto("core_credit_note_refund").values({
          id: newId("creditNoteRefund"),
          credit_note_id: note.id,
          order_id: order.id,
          provider: payment.provider,
          payment_ref: payment.paymentRef,
          method: "recorded",
          amount,
          created_at: ctx.now,
        }),
      );
    } else {
      // A voucher or stored value comes with stage 34's steps 7 and 8.
      throw new ConflictError("This payment cannot be given back by a credit note yet", {
        rule: "refund_method",
        method: payment.method,
      });
    }
  }
  const asked = refunded.reduce((sum, r) => sum + r.amount, 0);
  if (left > 0 || asked !== back) {
    // Bounded above (`available`): anything else is a bug, and nothing is written.
    throw new ConflictError("A credit note would give back other than it says", {
      rule: "credit_beyond_paid",
    });
  }

  // The invoice moved with its order's write above (its version, and `credited` or `void` when
  // credited in full with nothing paid; otherwise its money state follows its order).
  const invoiceState: InvoiceRow["state"] = cancelled
    ? options.voiding
      ? "void"
      : "credited"
    : next.state === "paid"
      ? "paid"
      : invoice.state;
  const entry = {
    invoiceId: invoice.id,
    currency: invoice.currency,
    at: ctx.now,
    byUser: ctx.user.id,
  };
  ctx.write(
    eventStatement(ctx.db, {
      ...entry,
      documentKind: "credit_note",
      documentId: note.id,
      event: "issued",
      amount: credit,
    }),
    eventStatement(ctx.db, {
      ...entry,
      documentKind: "credit_note",
      documentId: note.id,
      event: "credited",
      amount: credit,
    }),
    ...(options.voiding
      ? [
          eventStatement(ctx.db, {
            ...entry,
            documentKind: "invoice",
            documentId: invoice.id,
            event: "voided",
            amount: credit,
          }),
        ]
      : []),
  );
  if (invoice.person_id) {
    ctx.postActivity({
      subject: options.voiding
        ? `Invoice ${invoice.number} void`
        : `Credit note for invoice ${invoice.number}: ${formatMoney(credit, invoice.currency)}`,
      payload: {
        kind: options.voiding ? "invoice.voided" : "invoice.credited",
        invoiceId: invoice.id,
        creditNoteId: note.id,
        amount: credit,
        reduced,
        given: back,
        currency: invoice.currency,
      },
      links: [
        { object: "person", id: invoice.person_id },
        ...(invoice.organisation_id
          ? [{ object: "organisation" as const, id: invoice.organisation_id }]
          : []),
      ],
    });
  }
  ctx.recordChange({
    object: "creditNote",
    id: note.id,
    action: "update",
    before: { state: "draft", total: credit },
    after: {
      state: "issued",
      total: credit,
      invoiceId: invoice.id,
      reduced,
      given: back,
      ...(options.voiding ? { voided: true } : {}),
    },
  });
  return { reduced, refunded, order: next, invoiceState };
}

/**
 * The lines of a void's credit note: everything still left on the invoice. With no credit note
 * before, each line in full; otherwise what is left at each rate, as an amount at it.
 */
export function voidLines(
  invoice: InvoiceRow,
  invoiceLines: readonly LineRow[],
  credited: Credited,
): NewCreditLine[] {
  const priced = invoiceLines.filter((l) => l.source !== "deduction");
  if (credited.total === 0 && priced.length === invoiceLines.length) {
    return creditLines(invoice, invoiceLines, credited, {
      lines: priced.map((l) => ({ lineId: l.id })),
    });
  }
  const { room } = roomByRate(invoice, invoiceLines, credited);
  const out: NewCreditLine[] = [];
  for (const [key, left] of room) {
    if (left.total <= 0) continue;
    out.push({
      id: newId("creditNoteLine"),
      position: out.length,
      description: `Void of ${invoice.number}${left.label ? ` at ${left.label}` : ""}`,
      quantity_milli: 1000,
      unit: null,
      unit_price: invoice.tax_mode === "inclusive" ? left.total : left.total - left.tax,
      tax_key: key || null,
      tax_label: key ? left.label : null,
      tax_rate: key ? left.rate : 0,
      line_net: left.total - left.tax,
      line_tax: left.tax,
      line_total: left.total,
      credits_line_id: null,
    });
  }
  return out;
}
