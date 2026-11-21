// The one way an order becomes paid (stage 25, ADR 0427): a payment the provider has reported and
// the payments gatekeeper has verified, applied here.
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
import { ConflictError, ValidationError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import type { PaymentsTaxReport } from "./gateway.ts";
import { type Charge, changeOrder, chargeFor, loadOrderRow, type OrderRow } from "./orders.ts";
import { loadMinPartPayment } from "./settings.ts";

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
export function taxReportFits(
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

  if (row.state !== "pending" && row.state !== "part_paid") {
    record("late");
    await tellStaff(
      "A payment arrived for an order that had closed",
      `Order ${row.id} is ${row.state}, and ${money(payment.amount, currency)} was paid on it. ` +
        "Honour it or refund it.",
      "late_payment",
    );
    return { outcome: "late", orderId: row.id };
  }

  let charge: Charge | null = null;
  // The provider's tax must fit what this checkout asked for (ADR 0479); a figure that does not
  // is not stored and moves nothing, as an amount that does not match.
  if (currency === row.currency && taxReportFits(payment.amount, payment.sentTax, payment.tax)) {
    try {
      charge = chargeFor(row, await loadMinPartPayment(ctx.db), payment.amount);
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

  const paid = row.paid + payment.amount;
  if (paid > row.total) {
    // chargeFor allows at most the balance, so this is a bug, not a caller's mistake.
    throw new ConflictError("A payment would take an order past its total", { order: row.id });
  }
  record("applied");
  const settled = paid === row.total;
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
  const next = await changeOrder(
    ctx,
    row,
    settled ? "paid" : "part_paid",
    {
      paid,
      ...(settled ? { paid_at: ctx.now } : {}),
      ...(taxed
        ? {
            tax_amount: row.tax_amount + taxed.amount,
            tax_country: taxed.country ?? row.tax_country,
          }
        : {}),
    },
    // The host's move: this function is the only code that says a payment was verified.
    "host",
  );
  return { outcome: "applied", order: next, charge };
}
