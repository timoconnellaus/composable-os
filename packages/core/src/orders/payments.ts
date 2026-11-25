// The two ways an order becomes paid. The first (stage 25, ADR 0427): a payment the provider has
// reported and the payments gatekeeper has verified, applied here. The second (stage 34, ADR
// 0694): a payment the host applies itself, `applyOtherPayment`, below.
//
// `applyVerifiedPayment` is a function, not an operation. Nothing a person, an MCP client, an
// extension or an import can send reaches it: they can only call operations, no operation passes
// its input here, and the moves it makes (`paid`, `part_paid`) are `host` moves the transition
// engine refuses to every caller. It is for the handler that receives the gatekeeper's verified
// webhook, which has itself established that the provider said so. The return page of a checkout
// never calls it.
//
// It queues its writes on the calling operation's batch, so the payment row, the order's new
// state, its history and whatever the move hooks add commit together or not at all.
import type { RecordedKind } from "@composable-os/db";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { eventStatement } from "../invoices/events.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import type { PaymentsTaxReport } from "./gateway.ts";
import {
  type Charge,
  changeOrder,
  chargeFor,
  chargeOptions,
  formatMoney,
  loadOrderRow,
  type OrderChange,
  type OrderRow,
  owedOn,
} from "./orders.ts";
import { loadMinPartPayment, loadRecordedPaymentNotice } from "./settings.ts";
import { discountsWaiting } from "./staff-discounts.ts";

/** The provider name of every payment row the host makes itself (migration 0952). */
export const HOST_PROVIDER = "host";

/** A payment as the gatekeeper hands it over once it has verified the provider's webhook. */
export interface VerifiedPayment {
  /** The provider's name, as the gatekeeper knows it (`stripe`, `fake`). */
  provider: string;
  /** The provider's own id for this event. The same event applied twice changes nothing. */
  eventId: string;
  /** The order it is for: the id the checkout was opened with. */
  orderId: string;
  /** What was paid, in the currency's minor unit. */
  amount: number;
  /** ISO 4217. */
  currency: string;
  /** The provider's reference for the payment itself, kept for a refund. */
  paymentRef?: string | undefined;
  /** The lines the checkout asked the provider to tax (ADR 0479); null when it asked for none. */
  sentTax?: SentTaxLine[] | null | undefined;
  /** The provider's tax on this payment, as it said it. Stored, never recalculated. */
  tax?: PaymentsTaxReport | undefined;
}

/** A taxed checkout's line as it was sent (orders/tax.ts CheckoutTaxLine). */
export interface SentTaxLine {
  ref: string;
  amount: number;
  taxCode: string;
}

/**
 * Whether the provider's tax report fits the payment and the checkout it was for: none on a
 * checkout that asked for none (or zero), one on every taxed checkout, never more than the amount,
 * and line by line on the lines sent, each at most its share and all summing to the total.
 */
function taxReportFits(
  amount: number,
  sent: readonly SentTaxLine[] | null | undefined,
  tax: PaymentsTaxReport | undefined,
): boolean {
  if (!sent) return tax === undefined || tax.amount === 0;
  if (!tax || tax.amount > amount) return false;
  const byRef = new Map(sent.map((line) => [line.ref, line]));
  const seen = new Set<string>();
  let sum = 0;
  for (const line of tax.lines) {
    const asked = byRef.get(line.ref);
    if (!asked || seen.has(line.ref) || line.amount > asked.amount) return false;
    seen.add(line.ref);
    sum += line.amount;
  }
  return sum === tax.amount;
}

export type PaymentResult =
  /** The payment was added to the order, which is now part paid or paid. */
  | { outcome: "applied"; order: OrderRow; charge: Charge }
  /** This event was applied before. Nothing was queued. */
  | { outcome: "duplicate"; orderId: string }
  /** The amount or currency is not one this order could be charged. Staff are told. */
  | { outcome: "mismatch"; orderId: string }
  /** The order had already closed (expired, cancelled, refunded or paid). Staff are told. */
  | { outcome: "late"; orderId: string };

const money = (amount: number, currency: string) => `${amount} ${currency} (minor units)`;

/**
 * Applies one verified payment to its order, in the calling operation's batch.
 *
 * - An event seen before changes nothing (`duplicate`). The payment row's primary key is the
 *   provider's event id, so two deliveries applied at the same moment cannot both commit.
 * - The amount must be one the order could be charged (`chargeFor`) and the currency the
 *   order's. Otherwise nothing moves, the payment is recorded as a `mismatch` and admins are
 *   notified.
 * - A payment for an order that is no longer open is recorded as `late` and admins are notified:
 *   it never makes the order paid by itself (staff honour it or refund it).
 * - Otherwise what is paid goes up by the amount and the order moves, as the host, to `paid`
 *   when nothing is owed and to `part_paid` when a balance remains.
 *
 * Throws NotFoundError for an order that does not exist, and the caller's batch fails with a
 * conflict when the order changed between this read and the commit: apply the event again.
 */
export async function applyVerifiedPayment(
  ctx: HandlerContext,
  payment: VerifiedPayment,
): Promise<PaymentResult> {
  if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) {
    throw new ValidationError("A payment has a whole, positive amount in minor units");
  }
  const seen = await ctx.db
    .selectFrom("core_order_payment")
    .select("order_id")
    .where("provider", "=", payment.provider)
    .where("event_id", "=", payment.eventId)
    .executeTakeFirst();
  if (seen) return { outcome: "duplicate", orderId: seen.order_id };

  const row = await loadOrderRow(ctx.db, payment.orderId);
  const currency = payment.currency.toUpperCase();
  // Only a taxed checkout's figure is kept: one the host asked for, as the provider said it.
  const taxed = payment.sentTax && payment.tax ? payment.tax : null;
  const record = (outcome: "applied" | "mismatch" | "late") =>
    ctx.write(
      ctx.db.insertInto("core_order_payment").values({
        provider: payment.provider,
        event_id: payment.eventId,
        order_id: row.id,
        amount: payment.amount,
        currency,
        outcome,
        payment_ref: payment.paymentRef ?? null,
        received_at: ctx.now,
        ...(taxed ? { tax_amount: taxed.amount, tax_country: taxed.country } : {}),
      }),
    );
  const tellStaff = async (title: string, body: string, kind: string) => {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title,
        body,
        link: { kind: "record", object: "order", id: row.id },
        dedupeKey: `order.${kind}:${payment.provider}:${payment.eventId}`,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
  };

  // An order an erase detached (no Person and no address: stage 44 step 8, ADR 0646) is nobody's:
  // a payment on it, a part-paid one's balance included, is handled as one after it closed.
  const erased = row.person_id === null && row.email === null;
  if ((row.state !== "pending" && row.state !== "part_paid") || erased) {
    record("late");
    // A drop-in's place went back when its order closed (ADR 0560): the payment is owed back,
    // asked for by the host and approved by a person, never honoured.
    const owed = await (await import("./moves.ts")).oweLateRefund(ctx, row.id, {
      paymentRef: payment.paymentRef ?? null,
      amount: payment.amount,
      orderState: row.state,
    });
    await tellStaff(
      "A payment arrived for an order that had closed",
      `Order ${row.id} is ${row.state}, and ${money(payment.amount, currency)} was paid on it. ` +
        (owed
          ? "What it paid for was no longer held: its refund is being asked for, for a person to approve."
          : erased
            ? "The person it was for was erased, so it cannot be honoured: refund it."
            : "Honour it or refund it."),
      "late_payment",
    );
    return { outcome: "late", orderId: row.id };
  }

  let charge: Charge | null = null;
  // The provider's tax must fit what this checkout asked for (ADR 0479); a figure that does not
  // is not stored and moves nothing, as an amount that does not match.
  if (currency === row.currency && taxReportFits(payment.amount, payment.sentTax, payment.tax)) {
    try {
      charge = chargeFor(
        row,
        await loadMinPartPayment(ctx.db),
        payment.amount,
        await chargeOptions(ctx.db, row),
      );
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  if (!charge) {
    record("mismatch");
    await tellStaff(
      "A payment does not match its order",
      `Order ${row.id} could not be charged (or the provider's tax did not fit what was asked) ${money(payment.amount, currency)}: it is ` +
        `${row.state}, for ${money(row.total, row.currency)} with ${row.paid} paid. ` +
        "Nothing was changed. Check it with the provider.",
      "payment_mismatch",
    );
    return { outcome: "mismatch", orderId: row.id };
  }

  record("applied");
  if (taxed && payment.sentTax) {
    // Each line's share of the provider's tax, by the line the checkout sent it as.
    const codes = new Map(payment.sentTax.map((line) => [line.ref, line.taxCode]));
    for (const line of taxed.lines) {
      ctx.write(
        ctx.db
          .updateTable("core_order_line")
          .set((eb) => ({
            tax_amount: eb("tax_amount", "+", line.amount),
            tax_code: codes.get(line.ref) ?? null,
          }))
          .where("id", "=", line.ref)
          .where("order_id", "=", row.id),
      );
    }
  }
  const next = await settle(
    ctx,
    row,
    payment.amount,
    taxed
      ? { tax_amount: row.tax_amount + taxed.amount, tax_country: taxed.country ?? row.tax_country }
      : {},
    { id: payment.eventId, method: "provider", by: null },
  );
  return { outcome: "applied", order: next, charge };
}

/**
 * The one settle path of both doors into paid: what is paid goes up by `amount` and the order
 * moves, as the host, to `paid` when nothing is owed and to `part_paid` when a balance remains
 * (due now, when it had no due date). The move hooks do the rest in the same batch: grants, holds
 * confirmed, `sellable.moves`, one-per-Person uses spent, a guest's acceptances settled.
 */
async function settle(
  ctx: HandlerContext,
  row: OrderRow,
  amount: number,
  change: OrderChange,
  /** The payment row applied: an invoice's order writes it to the document event log. */
  payment: { id: string; method: string; by: string | null },
): Promise<OrderRow> {
  const paid = row.paid + amount;
  // What a credit note took off is not owed (ADR 0735): paid and credited together settle it.
  if (paid + row.credited > row.total) {
    // Both callers allow at most the balance, so this is a bug, not a caller's mistake.
    throw new ConflictError("A payment would take an order past its total", { order: row.id });
  }
  const settled = paid + row.credited === row.total;
  // An invoice's order (stage 35, ADR 0731): every payment applied, by either door, is in the
  // document event log, in the payment's own batch, so no path is missed.
  if (row.invoice_id) {
    ctx.write(
      eventStatement(ctx.db, {
        documentKind: "invoice",
        documentId: row.invoice_id,
        event: "payment_applied",
        paymentId: payment.id,
        method: payment.method,
        amount,
        currency: row.currency,
        at: ctx.now,
        byUser: payment.by,
      }),
    );
  }
  return changeOrder(
    ctx,
    row,
    settled ? "paid" : "part_paid",
    {
      paid,
      ...(settled ? { paid_at: ctx.now } : { balance_due_at: row.balance_due_at ?? ctx.now }),
      ...change,
    },
    // The host's move: only a verified payment, or a payment the host applied itself
    // (applyOtherPayment), makes an order paid.
    "host",
  );
}

// --- The second door: paid another way (stage 34, ADR 0694) ----------------------------------------

/**
 * A payment a person says they received (a bank transfer, cash, a cheque, a card machine). The
 * operation that records one passes its own checked inputs: who received it is always the caller,
 * never input.
 */
export interface RecordedPayment {
  method: "recorded";
  kind: RecordedKind;
  /** The person who received it: the calling user. */
  recordedBy: string;
  /** The day it was received (YYYY-MM-DD). */
  receivedOn: string;
  /** The payer's reference (a bank reference, a cheque number). */
  reference: string | null;
}

/**
 * A payment the host applies itself. Only `recorded` exists yet: a gift voucher and stored value
 * (stage 34 steps 7 and 8) add theirs, each with its ledger entry in the same batch (the database
 * refuses a `voucher` or `stored_value` row without one, migration 0952).
 */
export type OtherPayment = RecordedPayment;

export const RECORDED_KINDS = ["transfer", "cash", "cheque", "card_machine", "other"] as const;

const KIND_WORDS: Record<RecordedKind, string> = {
  transfer: "bank transfer",
  cash: "cash",
  cheque: "cheque",
  card_machine: "card machine",
  other: "another way",
};

/** Admins are told, with a link to the order. */
async function tellAdmins(
  ctx: HandlerContext,
  orderId: string,
  title: string,
  body: string,
  dedupeKey: string,
): Promise<void> {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: { kind: "record", object: "order", id: orderId },
      dedupeKey,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/**
 * The second door into paid (ADR 0694, amending ADR 0427): applies a payment the host makes
 * itself, in the calling operation's batch, through the same settle path as a verified payment.
 * A function, not an operation: only the operations that name a way of paying call it
 * (`order.recordPayment` today; an invoice's and the till's later), each with its own checks and
 * a person behind it. Nothing passes a caller's input through.
 *
 * - The order must be owed money (pending or part paid), have a Person or an address (an erased
 *   one is nobody's), and no person's discount waiting for approval (its price is not settled).
 * - Any amount up to what is owed: more is refused. The currency is the order's.
 * - A recorded payment over the threshold a human admin set, or on an order whose buyer opened a
 *   payment page, tells the admins; every one is on the Person's timeline.
 * - A drop-in (an order that moves a record) is paid in full or not at all.
 */
export async function applyOtherPayment(
  ctx: HandlerContext,
  input: {
    orderId: string;
    amount: number;
    payment: OtherPayment;
    /**
     * The threshold over which admins are told, when the calling operation has its own (an
     * invoice's recorded payment: the invoice settings', stage 35). Left out, the order setting's.
     */
    noticeOver?: number | undefined;
  },
): Promise<{ order: OrderRow; paymentId: string }> {
  const { amount, payment } = input;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ValidationError("A payment has a whole, positive amount in minor units", {
      field: "amount",
    });
  }
  const row = await loadOrderRow(ctx.db, input.orderId);
  if (row.state !== "pending" && row.state !== "part_paid") {
    throw new ConflictError(`Nothing is owed on this order: it is ${row.state}`, {
      order: row.id,
      state: row.state,
    });
  }
  if (row.person_id === null && row.email === null) {
    throw new ConflictError("This order's person was erased: it cannot be paid", {
      order: row.id,
    });
  }
  if (row.state === "pending" && (await discountsWaiting(ctx.db, row.id, ctx.now)) > 0) {
    throw new ConflictError(
      "A discount on this order is waiting for approval: take the payment once it is decided",
      { rule: "discount_waiting", order: row.id },
    );
  }
  const owed = owedOn(row);
  // A drop-in (a record its order moves, ADR 0560) is paid in full or not at all: its booking
  // moves at the first payment and cannot move back (review of PR #426).
  const { movedRecords } = await import("./moves.ts");
  if (amount < owed && (await movedRecords(ctx, row.id)).length) {
    throw new ValidationError(
      `This order books a place when it is paid, so it is paid in full: ${formatMoney(owed, row.currency)}`,
      { field: "amount", rule: "paid_in_full", owed },
    );
  }
  if (amount > owed) {
    throw new ValidationError(`At most ${formatMoney(owed, row.currency)} is owed on this order`, {
      field: "amount",
      rule: "overpaid",
      owed,
    });
  }
  const paymentId = newId("orderPayment");
  ctx.write(
    ctx.db.insertInto("core_order_payment").values({
      provider: HOST_PROVIDER,
      event_id: paymentId,
      order_id: row.id,
      amount,
      currency: row.currency,
      outcome: "applied",
      // The host's own reference to the payment: a refund or a reversal names it.
      payment_ref: paymentId,
      received_at: ctx.now,
      method: payment.method,
      recorded_kind: payment.kind,
      recorded_by: payment.recordedBy,
      received_on: payment.receivedOn,
      reference: payment.reference,
    }),
  );
  const order = await settle(
    ctx,
    row,
    amount,
    {},
    {
      id: paymentId,
      method: payment.method,
      by: payment.recordedBy,
    },
  );
  const what = `${formatMoney(amount, row.currency)} by ${KIND_WORDS[payment.kind]}`;
  if (row.person_id) {
    ctx.postActivity({
      subject: `Payment recorded: ${what}`,
      payload: {
        kind: "order.paymentRecorded",
        orderId: row.id,
        paymentId,
        amount,
        method: payment.method,
        recordedKind: payment.kind,
        currency: row.currency,
      },
      links: [{ object: "person", id: row.person_id }],
    });
  }
  // A payment page the buyer opened stays open at the provider (review of PR #426): a payment
  // made there now arrives as not matching or late, and staff refund it. Admins are told so.
  const pageOpen = await ctx.db
    .selectFrom("core_order_checkout")
    .select("ref")
    .where("order_id", "=", row.id)
    .executeTakeFirst();
  if (pageOpen || amount > (input.noticeOver ?? (await loadRecordedPaymentNotice(ctx.db)))) {
    await tellAdmins(
      ctx,
      row.id,
      "A payment was recorded on an order",
      `${what} was recorded on order ${row.id} as received on ${payment.receivedOn}. It is ` +
        `now ${order.state}.` +
        (pageOpen
          ? " The buyer had opened a payment page for it: a payment made there now is not " +
            "taken as paid (it shows as late or not matching), and is refunded."
          : ""),
      `order.payment_recorded:${paymentId}`,
    );
  }
  return { order, paymentId };
}

/**
 * Undoes a recorded payment entered in error (ADR 0694): a second row of the amount negated,
 * naming the first, with a reason; nothing is edited or deleted. The order's paid goes down and,
 * when it was paid, it moves back to part paid as the host, its balance due now. What the payment
 * granted stays: staff take the right payment, or cancel the order. Refused for the provider's
 * payment (that is a refund), for any other method (a refund back onto it), for a reversal, for
 * one already reversed or with money paid back on it, and on an order no longer paid or part paid.
 * Admins are told of every reversal.
 */
export async function reverseOtherPayment(
  ctx: HandlerContext,
  input: { paymentId: string; reason: string; reversedBy: string },
): Promise<{ order: OrderRow; reversalId: string }> {
  const rows = await ctx.db
    .selectFrom("core_order_payment")
    .selectAll()
    .where("event_id", "=", input.paymentId)
    .execute();
  const payment = rows.find((p) => p.provider === HOST_PROVIDER);
  if (!payment) {
    if (rows.length) {
      throw new ConflictError(
        "This is the payment provider's payment: it is refunded (order.refund), not reversed",
        { rule: "reverse_method", method: "provider" },
      );
    }
    throw new NotFoundError("payment", input.paymentId);
  }
  if (payment.method !== "recorded") {
    throw new ConflictError("This payment is refunded back to what paid it, not reversed", {
      rule: "reverse_method",
      method: payment.method,
    });
  }
  if (payment.reverses !== null) {
    throw new ConflictError("A reversal cannot itself be reversed", { rule: "reverse_reversal" });
  }
  const [reversed, paidBack] = await Promise.all([
    ctx.db
      .selectFrom("core_order_payment")
      .select("event_id")
      .where("provider", "=", HOST_PROVIDER)
      .where("reverses", "=", payment.event_id)
      .executeTakeFirst(),
    ctx.db
      .selectFrom("core_order_refund")
      .select("id")
      .where("provider", "=", HOST_PROVIDER)
      .where("payment_ref", "=", payment.event_id)
      .executeTakeFirst(),
  ]);
  if (reversed) {
    throw new ConflictError("This payment has already been reversed", {
      rule: "payment_guard",
      reason: "reversed",
    });
  }
  if (paidBack) {
    throw new ConflictError(
      "Money was paid back on this payment, so it was received: it cannot be reversed",
      { rule: "reverse_refunded" },
    );
  }
  const row = await loadOrderRow(ctx.db, payment.order_id);
  if (row.state !== "paid" && row.state !== "part_paid") {
    throw new ConflictError(`A payment on an order that is ${row.state} cannot be reversed`, {
      order: row.id,
      state: row.state,
    });
  }
  // What a drop-in's payment booked cannot be moved back by its order (review of PR #426): staff
  // cancel the booking first (as any cancel of a paid booking, the refund owed for it is not sent
  // for money taken another way), then reverse the payment, then cancel the order.
  const { movedRecords } = await import("./moves.ts");
  if ((await movedRecords(ctx, row.id)).some((r) => r.paid)) {
    throw new ConflictError(
      "This payment booked a place that is still booked: cancel the booking first, then reverse the payment",
      { rule: "reverse_booked", order: row.id },
    );
  }
  const reversalId = newId("orderPayment");
  ctx.write(
    ctx.db.insertInto("core_order_payment").values({
      provider: HOST_PROVIDER,
      event_id: reversalId,
      order_id: row.id,
      amount: -payment.amount,
      currency: payment.currency,
      outcome: "applied",
      payment_ref: payment.event_id,
      received_at: ctx.now,
      method: "recorded",
      recorded_kind: payment.recorded_kind,
      recorded_by: input.reversedBy,
      received_on: payment.received_on,
      reverses: payment.event_id,
      reason: input.reason,
    }),
  );
  if (row.invoice_id) {
    // An invoice's order (ADR 0733): the reversal is in the document event log, in its batch.
    ctx.write(
      eventStatement(ctx.db, {
        documentKind: "invoice",
        documentId: row.invoice_id,
        event: "payment_reversed",
        paymentId: reversalId,
        method: "recorded",
        amount: payment.amount,
        currency: payment.currency,
        at: ctx.now,
        byUser: input.reversedBy,
      }),
    );
  }
  const order = await changeOrder(
    ctx,
    row,
    "part_paid",
    {
      paid: row.paid - payment.amount,
      balance_due_at: row.balance_due_at ?? ctx.now,
      ...(row.state === "paid" ? { paid_at: null } : {}),
    },
    // The host's move: a payment it applied is taken back off.
    "host",
  );
  const what = formatMoney(payment.amount, payment.currency);
  if (row.person_id) {
    ctx.postActivity({
      subject: `Payment reversed: ${what}`,
      payload: {
        kind: "order.paymentReversed",
        orderId: row.id,
        paymentId: payment.event_id,
        reversalId,
        amount: payment.amount,
        currency: payment.currency,
      },
      links: [{ object: "person", id: row.person_id }],
    });
  }
  await tellAdmins(
    ctx,
    row.id,
    "A recorded payment was reversed",
    `The payment of ${what} recorded on order ${row.id} was reversed as entered in error. The ` +
      `order is part paid with ${formatMoney(order.total - order.paid, order.currency)} owed.`,
    `order.payment_reversed:${reversalId}`,
  );
  return { order, reversalId };
}
