// Issuing an invoice (stage 35 step 3, ADR 0731): the draft takes the next number of its series
// and starts its order, in one batch. An invoice is an order: paying, refunding, places and grants
// are the order's, and the invoice adds a number, a bill-to, a due date in place of an expiry, the
// tax worked out on the document and (later) its PDF.
//
// The order is made by the one pricing path, `createOrder` → `priceOrder` (ADR 0693), with the
// invoice's lines as the host priced them (`priced`), one order line per invoice line (two when
// a record's amount with tax does not divide by its quantity, `orderPieces`):
//   - a record's line is the record (its object and id, its quantity), so its places are held,
//     its stock held and sold and what it grants granted, as on any order; its price is read from
//     the record again at issue and must be the one on the draft;
//   - a typed line is a line of the invoice itself (object `invoice`), for its whole amount;
//   - the order lines cost the invoice line's amount with tax, before its discount, exactly: with
//     amounts typed without tax that is its net plus its tax, as the document worked it out;
//   - a line's staff discount is a stage 34 `staff` adjustment on its order line (its amount with
//     tax), given by the person who issues it, with `orders:discount` and within the limit a human
//     admin set, or approved; a deduction line ("less deposit paid", step 6) is a `prepaid`
//     adjustment on the whole order;
//   - each order line keeps the line's tax (ADR 0732), and each payment on the order carries its
//     share of the document's tax (orders/payments.ts); its checkout asks the provider for none;
//   - no deal: the invoice's price is what staff wrote and the customer is sent;
//   - the goods rules hold (ADR 0682): a goods record needs a delivery, which an invoice does not
//     choose, so it is refused (at draft and again here);
//   - the agreements its records need are asked for (ADR 0644): refused at issue with the list.
// The order has no expiry; its due date is the invoice's; `order.overdue` lists it once past it.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConflictError, ForbiddenError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import {
  createOrder,
  type InvoiceAdjustment,
  type LineRequest,
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  type OrderRow,
  type PricedLine,
} from "../orders/orders.ts";
import { loadDiscountLimit, loadOrderCurrency } from "../orders/settings.ts";
import { holdsPermission } from "../principals.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localDateStart, localDay, parseLocalDate } from "../time/local.ts";
import {
  auditSnapshot,
  checkBillTo,
  checkRecordLines,
  type InvoiceRow,
  type LineRow,
  linesOf,
  loadDocument,
  requireDraft,
} from "./drafts.ts";
import { eventStatement } from "./events.ts";
import { numberStatements } from "./numbering.ts";
import { type InvoiceSettings, loadInvoiceSettings } from "./settings.ts";
import { lineAmounts } from "./tax.ts";

/** The object a typed line's order line names: the invoice it is a line of. */
export const INVOICE_LINE_OBJECT = "invoice";

/** One invoice line's figures as its order line carries them. */
interface LineFigures {
  line: LineRow;
  /** The line's amount with tax, before its discount: what its order line costs. */
  undiscounted: number;
  /** Its staff discount with tax: what it costs less (its `line_total` is what is left). */
  discount: number;
}

/** Each priced line's amounts with tax: before its discount, and the discount. */
export function lineFigures(doc: Pick<InvoiceRow, "tax_mode">, lines: readonly LineRow[]) {
  return lines
    .filter((line) => line.source !== "deduction")
    .map((line): LineFigures => {
      const undiscounted = lineAmounts({
        unitPrice: line.unit_price,
        quantityMilli: line.quantity_milli,
        rate: line.tax_rate,
        mode: doc.tax_mode,
        discount: null,
      }).total;
      const discount = undiscounted - line.line_total;
      if (discount < 0) {
        throw new ConflictError("A line costs more after its discount than before", {
          line: line.position,
        });
      }
      return { line, undiscounted, discount };
    });
}

/**
 * Whether an invoice's line discounts are within the limit a human admin set for staff discounts
 * (stage 34, ADR 0691): all of them together at most its amount and its percentage of what the
 * lines cost before them. `invoice.issue` waits for approval above it (its `reviewWhen`).
 */
export async function invoiceDiscountsWithinLimit(
  db: Kysely<CoreDatabase>,
  invoiceId: string,
): Promise<boolean> {
  let figures: LineFigures[];
  try {
    const doc = await loadDocument(db, "invoice", invoiceId);
    // Not a draft, or not one to issue: the handler refuses it.
    if (doc.state !== "draft") return true;
    figures = lineFigures(doc, await linesOf(db, "invoice", invoiceId));
  } catch (error) {
    if (error instanceof OperationError) return true;
    throw error;
  }
  const off = figures.reduce((sum, f) => sum + f.discount, 0);
  if (off === 0) return true;
  const subtotal = figures.reduce((sum, f) => sum + f.undiscounted, 0);
  const limit = await loadDiscountLimit(db);
  return off <= limit.amount && off * 10_000 <= Math.round(limit.percent * 100) * subtotal;
}

/** The business's local day for `now`, and the last instant of a local date, in its timezone. */
async function businessDays(db: Kysely<CoreDatabase>, now: string) {
  const zone = (await loadGeneralSettings(db)).timezone || "UTC";
  return {
    today: localDay(now, zone).date,
    endOf(date: string): string {
      const parts = parseLocalDate(date);
      if (!parts) throw new ValidationError("Not a date", { field: "dueOn" });
      return new Date(localDateStart(addLocalDays(parts, 1), zone) - 1).toISOString();
    },
    plus(date: string, days: number): string {
      const parts = parseLocalDate(date) as { year: number; month: number; day: number };
      const next = addLocalDays(parts, days);
      return `${next.year}-${String(next.month).padStart(2, "0")}-${String(next.day).padStart(2, "0")}`;
    },
  };
}

/** The bill-to as it is printed, fixed at issue: whom it is for, their address and email. */
async function billToPrinted(ctx: HandlerContext, doc: InvoiceRow) {
  // Through the seam, as the staff caller reads them (checkBillTo has read both already).
  const person = (await ctx.records.get("person", doc.person_id as string)).values;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  let name = text(person.displayName);
  let address: string | null = null;
  if (doc.organisation_id) {
    const org = (await ctx.records.get("organisation", doc.organisation_id)).values;
    const orgName = text(org.name);
    name = orgName ? `${orgName}${name ? `, attention ${name}` : ""}` : name;
    const addresses = Array.isArray(org.addresses) ? (org.addresses as unknown[]) : [];
    const first = (addresses.find(
      (a) => a && typeof a === "object" && (a as { isPrimary?: unknown }).isPrimary,
    ) ?? addresses[0]) as Record<string, unknown> | undefined;
    const parts = first
      ? ["line1", "line2", "city", "region", "postalCode", "country"]
          .map((key) => text(first[key]))
          .filter((p): p is string => p !== null)
      : [];
    address = parts.length ? parts.join("\n") : null;
  }
  return {
    bill_to_name: name,
    bill_to_address: address,
    // No tax number is kept on a Person or an Organisation yet: printed when one is.
    bill_to_tax_number: null,
    bill_to_email: text(person.primaryEmail)?.toLowerCase() ?? null,
  };
}

/** The business's details, bank details and footer as at issue (never changed afterwards). */
export function businessSnapshot(settings: InvoiceSettings): string {
  return JSON.stringify({
    business: settings.business,
    bank: settings.bank,
    footer: settings.pdfFooter,
  });
}

/** One order line an invoice line becomes: its quantity, unit price, tax and discount. */
export interface OrderPiece {
  quantity: number;
  unitPrice: number;
  tax: number;
  discount: number;
}

/**
 * The order lines one invoice line becomes, costing `undiscounted` (its amount with tax, before
 * its discount) exactly, with its tax and discount shared out in whole minor units:
 *   - a record's line keeps its quantity (its places, stock and grants). When its amount does not
 *     divide by it (amounts typed without tax: two at 45.45 plus 10% are 99.99), it is two lines
 *     of the record, some units a cent dearer than the rest (one at 49.99, one at 50.00), so no
 *     order line costs more than the invoice says and nothing is rounded;
 *   - a typed line is of its quantity when it is whole and its amount divides by it, else of one.
 */
export function orderPieces(
  record: boolean,
  whole: number | null,
  undiscounted: number,
  tax: number,
  discount: number,
): OrderPiece[] {
  const quantity = record
    ? (whole as number)
    : whole !== null && whole <= ORDER_MAX_QUANTITY && undiscounted % whole === 0
      ? whole
      : 1;
  const unit = Math.floor(undiscounted / quantity);
  const dearer = undiscounted - unit * quantity;
  const shape =
    dearer === 0
      ? [{ quantity, unitPrice: unit }]
      : [
          { quantity: quantity - dearer, unitPrice: unit },
          { quantity: dearer, unitPrice: unit + 1 },
        ];
  let taxLeft = tax;
  let offLeft = discount;
  return shape.map((piece, i) => {
    const total = piece.quantity * piece.unitPrice;
    const last = i === shape.length - 1;
    const share = last ? taxLeft : undiscounted ? Math.floor((tax * total) / undiscounted) : 0;
    taxLeft -= share;
    // The discount shared as the tax is (review of PR #460), so no piece carries tax and no money.
    const off = last
      ? offLeft
      : undiscounted
        ? Math.min(offLeft, total, Math.floor((discount * total) / undiscounted))
        : 0;
    offLeft -= off;
    return { ...piece, tax: share, discount: off };
  });
}

/**
 * Refuses an invoice whose lines would make more than an order's lines once a record's line
 * that does not divide by its quantity is split (`orderPieces`): at draft as at issue, so a
 * draft that is accepted can be issued (review of PR #460).
 */
export function requireOrderRoom(doc: Pick<InvoiceRow, "tax_mode">, lines: readonly LineRow[]) {
  let count = 0;
  for (const { line, undiscounted, discount } of lineFigures(doc, lines)) {
    const whole = line.quantity_milli % 1000 === 0 ? line.quantity_milli / 1000 : null;
    count += orderPieces(
      line.source === "record",
      whole,
      undiscounted,
      line.line_tax,
      discount,
    ).length;
  }
  if (count > ORDER_MAX_LINES) {
    throw new ValidationError(
      `These lines make ${count} order lines, more than an order's ${ORDER_MAX_LINES} (a record's line whose amount with tax does not divide by its quantity is two): split the invoice in two`,
      { field: "lines", rule: "too_many_lines", max: ORDER_MAX_LINES, count },
    );
  }
}

export interface IssuedInvoice {
  /** The invoice as this batch leaves it, without its number (read it after the commit). */
  invoice: InvoiceRow;
  order: OrderRow;
}

/**
 * Queues the issue of the draft `doc` in the calling operation's batch: its number, its fixed
 * columns and its order, which the database makes only after the invoice names it (migration
 * 1031). Refuses a draft with nothing to bill, no one to bill, a record whose price changed since
 * its line was added, goods, a waiver the bill-to has not agreed to, a line discount from someone
 * without `orders:discount`, and a due date before today.
 */
export async function issueInvoice(
  ctx: HandlerContext,
  doc: InvoiceRow,
  lines: readonly LineRow[],
): Promise<IssuedInvoice> {
  requireDraft("invoice", doc);
  if (!doc.person_id) {
    throw new ValidationError("An invoice is issued to someone: give it whom it bills (billTo)", {
      field: "billTo",
      rule: "bill_to_needed",
    });
  }
  // The bill-to as it is now: a Person out of the Trash, an organisation's contact still at it.
  await checkBillTo(ctx, { personId: doc.person_id, organisationId: doc.organisation_id });
  const currency = await loadOrderCurrency(ctx.db);
  if (currency !== doc.currency) {
    throw new ConflictError(
      `This invoice is in ${doc.currency}, and orders are now in ${currency ?? "no currency"}`,
      { rule: "currency" },
    );
  }
  const figures = lineFigures(doc, lines);
  if (!figures.length) {
    throw new ValidationError("An invoice needs at least one line to bill", {
      field: "lines",
      rule: "no_lines",
    });
  }
  // The record lines again, as the one order they become: still for sale, the goods rules, and
  // the price on the draft still the record's (a price changed since is the line added again).
  const fresh = await checkRecordLines(ctx, doc.currency, lines);
  const freshOf = new Map(fresh.map((line) => [`${line.object}\u0000${line.recordId}`, line]));
  for (const { line } of figures) {
    if (line.source !== "record") continue;
    const now = freshOf.get(`${line.source_object}\u0000${line.source_id}`);
    if (!now || now.unitPrice !== line.source_price) {
      throw new ConflictError(
        `The price of "${line.description}" changed since it was added: remove the line and add it again`,
        { rule: "price_changed", line: line.position },
      );
    }
  }
  if (
    figures.some((f) => f.discount > 0) &&
    !holdsPermission(ctx.user, ctx.permissionGrants, "orders:discount")
  ) {
    throw new ForbiddenError(
      "A line on this invoice has a discount: issuing it needs the permission to give discounts",
      { rule: "discount_permission", permission: "orders:discount" },
    );
  }

  const settings = await loadInvoiceSettings(ctx.db);
  const days = await businessDays(ctx.db, ctx.now);
  const issuedOn = days.today;
  const dueOn = doc.due_on ?? days.plus(issuedOn, doc.payment_terms_days);
  if (dueOn < issuedOn) {
    throw new ValidationError("The invoice's due date is before today: change it, or clear it", {
      field: "dueOn",
      rule: "due_on",
    });
  }

  // The order's lines, in the invoice's order: each invoice line one, or two (below).
  const priced: PricedLine[] = [];
  const requests: LineRequest[] = [];
  const adjustments: InvoiceAdjustment[] = [];
  for (const { line, undiscounted, discount } of figures) {
    const record = line.source === "record";
    const whole = line.quantity_milli % 1000 === 0 ? line.quantity_milli / 1000 : null;
    const base = record
      ? (freshOf.get(`${line.source_object}\u0000${line.source_id}`) as PricedLine)
      : null;
    for (const piece of orderPieces(record, whole, undiscounted, line.line_tax, discount)) {
      const id = newId("orderLine");
      priced.push({
        ...(base ?? {}),
        id,
        position: priced.length,
        object: record ? (line.source_object as string) : INVOICE_LINE_OBJECT,
        recordId: record ? (line.source_id as string) : doc.id,
        title: line.description,
        quantity: piece.quantity,
        unitPrice: piece.unitPrice,
        total: piece.quantity * piece.unitPrice,
        discount: 0,
        // Paid in full (or in parts staff allow): a record's own deposit is not the invoice's.
        deposit: null,
        taxAmount: piece.tax,
      });
      requests.push({
        object: record ? (line.source_object as string) : INVOICE_LINE_OBJECT,
        id: record ? (line.source_id as string) : doc.id,
        quantity: piece.quantity,
      });
      if (piece.discount > 0) {
        adjustments.push({
          kind: "staff",
          lineId: id,
          amount: piece.discount,
          percent:
            line.discount_kind === "percent" && line.discount_value !== null
              ? line.discount_value / 100
              : null,
          reason: line.discount_reason,
        });
      }
    }
  }
  if (priced.length > ORDER_MAX_LINES) {
    throw new ValidationError(
      `This invoice's lines make more than an order's ${ORDER_MAX_LINES} lines: split it in two`,
      { field: "lines", rule: "too_many_lines" },
    );
  }
  for (const line of lines) {
    if (line.source !== "deduction") continue;
    adjustments.push({
      kind: "prepaid",
      lineId: null,
      amount: line.line_total,
      percent: null,
      reason: line.description,
    });
  }

  const orderId = newId("order");
  const printed = await billToPrinted(ctx, doc);
  const set = {
    state: "issued",
    issued_on: issuedOn,
    issued_at: ctx.now,
    due_on: dueOn,
    order_id: orderId,
    business: businessSnapshot(settings),
    updated_at: ctx.now,
    updated_by: ctx.user.id,
    ...printed,
  };
  // The number first, then the order: the database makes an invoice's order only once the
  // invoice is issued and names it (migration 1031), so a draft deleted or changed meanwhile
  // takes no number and makes no order, and a batch that fails anywhere takes neither.
  ctx.write(...numberStatements(ctx.db, "invoice", doc.id, doc.version, set));
  const started = await createOrder(ctx, {
    id: orderId,
    lines: requests,
    priced,
    personId: doc.person_id,
    email: printed.bill_to_email,
    placedAs: "staff",
    pay: "full",
    invoice: {
      id: doc.id,
      dueAt: days.endOf(dueOn),
      // The seam takes off a line's own first, then the whole order's.
      adjustments: [
        ...adjustments.filter((a) => a.kind !== "prepaid"),
        ...adjustments.filter((a) => a.kind === "prepaid"),
      ],
      total: doc.total,
    },
  });
  ctx.write(
    eventStatement(ctx.db, {
      documentKind: "invoice",
      documentId: doc.id,
      event: "issued",
      amount: doc.total,
      currency: doc.currency,
      at: ctx.now,
      byUser: ctx.user.id,
    }),
  );
  const next = { ...doc, ...set, version: doc.version + 1 } as InvoiceRow;
  ctx.recordChange({
    object: "invoice",
    id: doc.id,
    action: "update",
    before: auditSnapshot(doc, lines),
    after: { ...auditSnapshot(next, lines), orderId, issuedOn, dueOn },
  });
  return { invoice: next, order: started.row };
}
