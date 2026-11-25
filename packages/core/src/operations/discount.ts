// discount.* operations (stage 34 step 4, ADR 0693).
//
//   discount.check   staff, customers and the public   whether a promo code applies to a basket
//                                                      and what it takes off; read-only
//
// The discount records themselves are a pack's (the Offers pack): staff read and change them
// through the record operations. What a discount takes off an order is the host's, worked out when
// it prices the order (orders/orders.ts, `priceOrder`): this operation asks the same function and
// holds nothing.
import { z } from "zod";
import { CODE_NOT_VALID, workOutDeal } from "../discounts/deal.ts";
import { ConfigError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { priceLines } from "../orders/orders.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { callerOf } from "../records/transitions.ts";
import { codeSchema, orderStartInput } from "./order.ts";

export const discountCheck = defineOperation({
  name: "discount.check",
  description:
    "Check a promo code against a basket before an order is started: whether it applies to " +
    "these lines for this caller, and what it would take off each. Nothing is held: the code's " +
    "uses are kept only once an order is started (order.start, order.applyCode). A code that " +
    "does not apply gets one answer, whatever the reason (unknown, ended, used up, not for this " +
    "buyer, not for these items): valid false and the same message. `better` says that a price " +
    "applying by itself (a member's) takes more off, so the code would not be the order's deal. " +
    "A guest is nobody proved: a code for members, new customers or one per person is not valid " +
    "for them. Amounts are in the currency's minor unit. Read-only.",
  input: z.object({
    code: codeSchema,
    lines: orderStartInput.shape.lines.describe(
      "What is in the basket. There is no price here: the host reads it from each record.",
    ),
  }),
  output: z.object({
    valid: z.boolean(),
    message: z.string().nullable().describe("Why not, the same words for every reason"),
    title: z.string().nullable().describe("The discount's name, when valid"),
    amount: z.number().describe("What the code takes off these lines; 0 when not valid"),
    lines: z.array(
      z.object({
        position: z.number(),
        discount: z.number().describe("What it takes off this line"),
      }),
    ),
    better: z
      .boolean()
      .describe("A price that applies by itself takes more off: that would be the deal instead"),
    reason: z.string().optional().describe("Staff only: why it does not apply"),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  // Code guessing (ADR 0940): 10 a minute per signed-in account with order.applyCode, and wrong
  // codes counted per caller (a guest naming no order, per address).
  publicLimit: { tier: "read", perCaller: {}, group: "code", guesses: "code" },
  hostInternal: true,
  // A code typed is never kept in the audit log: a single-use code is a secret until it is used
  // (stage 34 step 5, ADR 0699); the order's adjustment names the discount and the code's record.
  auditRedact: ["code"],
  // Not offered to an assistant (the spec): a person, or a buyer's own page, checks a code.
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const currency = await loadOrderCurrency(ctx.db);
    if (!currency) {
      throw new ConfigError("No currency is set for orders yet, so nothing can be sold");
    }
    const priced = await priceLines(ctx.db, input.lines, currency, ctx.now, callerOf(ctx));
    const caller = ctx.principal;
    const worked = await workOutDeal(
      ctx.db,
      priced.map((line) => ({ ...line, delivery: Boolean(line.delivery) })),
      caller.kind === "customer"
        ? { personId: caller.personId, placedAs: "customer" }
        : { personId: null, placedAs: caller.kind === "staff" ? "staff" : "public" },
      input.code,
      ctx.now,
      currency,
      // Wrong codes per client address (ADR 0940): checked first, a wrong one counted.
      { guesses: ctx.guesses },
    );
    const code = worked.code;
    if (!code.given || !code.valid) {
      return {
        valid: false,
        message: CODE_NOT_VALID,
        title: null,
        amount: 0,
        lines: [],
        better: false,
        ...(caller.kind === "staff" && code.given && !code.valid ? { reason: code.reason } : {}),
      };
    }
    const shares = new Map(code.deal.shares.map((s) => [s.lineId, s.amount]));
    return {
      valid: true,
      message: null,
      title: code.deal.title,
      amount: code.deal.amount,
      lines: priced
        .filter((line) => shares.has(line.id))
        .map((line) => ({ position: line.position, discount: shares.get(line.id) ?? 0 })),
      better: !code.applied,
    };
  },
});

export const discountOperations = [discountCheck] as const;
