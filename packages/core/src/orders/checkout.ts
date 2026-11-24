// Opening a checkout (stage 25, ADR 0429): the provider's hosted page for one payment on an order.
//
// What the page charges is the host's: `chargeFor` says it, from the order as the host reads it.
// A buyer chooses an amount only towards a part-paid order's balance, between the set minimum and
// the balance. The buyer is sent back to `returnUrl`, which must be on an origin the deployment
// lists; coming back there tells the host nothing. Only the provider's verified webhook marks a
// payment (orders/events.ts).

import { sha256Hex } from "../digest.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { openProviderCheckout, paymentsTarget } from "./gateway.ts";
import { type Charge, chargeFor, type OrderRow } from "./orders.ts";
import { isAllowedReturnUrl, loadMinPartPayment, loadReturnOrigins } from "./settings.ts";
import { discountsWaiting } from "./staff-discounts.ts";
import { checkoutTax } from "./tax.ts";

export interface OpenedCheckout {
  url: string;
  provider: string;
  ref: string;
  amount: number;
  currency: string;
  kind: Charge["kind"];
  expiresAt: string | null;
}

/** A retried press of "Pay" within ten minutes, for the same amount, opens the same page. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

/** The first 8 bytes of the SHA-256 of `text`, as 16 hex characters. */
async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16);
}

const KIND_WORDS: Record<Charge["kind"], string> = {
  full: "",
  deposit: "Deposit: ",
  balance: "Balance: ",
  part: "Towards the balance: ",
};

/**
 * Opens the provider's page for what `row` may be charged now, and records the checkout in the
 * calling operation's batch. Refuses a return address off the deployment's list, an amount
 * `chargeFor` refuses, a deployment with no payment account, and an order with a staff discount
 * waiting for approval (ADR 0691): its price is not settled until a person decides.
 */
export async function openCheckout(
  ctx: HandlerContext,
  row: OrderRow,
  input: { returnUrl: string; amount?: number | undefined },
): Promise<OpenedCheckout> {
  const origins = await loadReturnOrigins(ctx.db);
  if (!isAllowedReturnUrl(input.returnUrl, origins)) {
    throw new ValidationError("The return address is not on this deployment's list of sites", {
      field: "returnUrl",
      rule: "return_origin",
    });
  }
  const charge = chargeFor(row, await loadMinPartPayment(ctx.db), input.amount);
  if (row.state === "pending" && (await discountsWaiting(ctx.db, row.id, ctx.now)) > 0) {
    throw new ConflictError(
      "A discount on this order is waiting for approval: pay once it is decided",
      {
        rule: "discount_waiting",
        order: row.id,
      },
    );
  }
  const target = await paymentsTarget(ctx.db);
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["title", "quantity"])
    .where("order_id", "=", row.id)
    .orderBy("position")
    .execute();
  const items = lines.map((l) => (l.quantity > 1 ? `${l.quantity} x ${l.title}` : l.title));
  const description = `${KIND_WORDS[charge.kind]}${items.join(", ")}`.slice(0, 200) || row.id;
  const bucket = Math.floor(Date.parse(ctx.now) / IDEMPOTENCY_WINDOW_MS);
  const idempotencyKey = `${row.id}:${row.version}:${charge.amount}:${bucket}:${await shortHash(input.returnUrl)}`;
  // Tax at checkout (ADR 0479): null unless an admin turned it on and the lines declare a code,
  // and then the request is exactly as before.
  const tax = await checkoutTax(ctx.db, row.id, charge.amount, KIND_WORDS[charge.kind]);
  const opened = await openProviderCheckout(ctx.integrations, target, {
    orderId: row.id,
    amount: charge.amount,
    currency: charge.currency,
    description,
    returnUrl: input.returnUrl,
    ...(row.email ? { customerEmail: row.email } : {}),
    idempotencyKey: tax ? `${idempotencyKey}:tax` : idempotencyKey,
    ...(tax ? { tax } : {}),
  });
  ctx.write(
    ctx.db
      .insertInto("core_order_checkout")
      .values({
        provider: opened.provider,
        ref: opened.ref,
        order_id: row.id,
        amount: charge.amount,
        currency: charge.currency,
        kind: charge.kind,
        created_at: ctx.now,
        tax_lines: tax ? JSON.stringify(tax.lines) : null,
      })
      .onConflict((oc) => oc.columns(["provider", "ref"]).doNothing()),
    // The latest checkout's reference, for staff and the provider's dashboard. Not a record field
    // and not the order's money, so it is written without a move.
    ctx.db
      .updateTable("core_order")
      .set({ provider: opened.provider, provider_ref: opened.ref })
      .where("id", "=", row.id),
  );
  return {
    url: opened.url,
    provider: opened.provider,
    ref: opened.ref,
    amount: charge.amount,
    currency: charge.currency,
    kind: charge.kind,
    expiresAt: opened.expiresAt,
  };
}
