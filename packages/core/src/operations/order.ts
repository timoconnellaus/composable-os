// order.* operations (stage 25, ADRs 0427 and 0428).
//
// Who may call what:
//   order.start            staff, customers and the public   starts an order, priced by the host
//   order.get              staff and customers               an order through the visibility seam
//   order.list             staff                             a page of orders, filtered and sorted
//   order.view             anyone, with the order's token    a guest's way back to one order
//   order.cancel           staff; a customer, their own unpaid order
//   order.extendBalanceDue staff                             a part-paid order's due date
//   order.setPerson        staff                             after merging people with one address
//   order.overdue          staff                             balances past their due date
//   order.checkout         staff, customers and the public   the provider's page to pay on
//   order.paidLate         staff                             late payments awaiting a decision
//   order.honourLate       staff (a person, orders:refund)   keep a late payment
//   order.refund           staff (orders:refund)             ask for a refund; a person approves
//   order.payments         staff                             checkouts, payments and refunds
//   order.adjust           staff (orders:discount)           money off a pending order, with a reason;
//                                                            over the limit, or from an AI, a human
//                                                            admin approves (ADR 0691)
//   order.unadjust         staff (orders:discount)           take that money off again
//   order.recordPayment    staff (a person, orders:payments) a payment taken another way (ADR 0694)
//   order.reversePayment   staff (a person, orders:payments) undo one entered in error
//   order.recordRefund     staff (a person, orders:refund)   money paid back on a recorded payment
//   order.startHeld        a pack's tool: staff, customers, the public   a record made with its order
//   order.applyPaymentEvent, order.expireDue, order.refundDue the host's own (actor automation)
//   order.settings.*       staff; changed by a human admin only
//
// No operation here takes a price or a total. Two functions make an order paid, and neither is an
// operation: `applyVerifiedPayment` (the provider's payment the gatekeeper verified) and
// `applyOtherPayment` (orders/payments.ts, ADR 0694), which only order.recordPayment calls here: a
// person with `orders:payments` saying they received an amount, never more than is owed. The other
// amount a caller names is a staff discount's (order.adjust): money off, given by a person with
// `orders:discount` and a reason, within a limit only a human admin sets.
//
// order.start, order.view, order.cancel and order.checkout are `hostInternal` (ADR 0428): the host itself starts
// and changes the order for a caller outside the org, so they keep the database. They touch only
// the order they made or the one the caller proved is theirs (their own Person through the seam,
// or the order's token), and answer only with what a customer may read of an order.
import { z } from "zod";
import { isMinor, personFacts } from "../agreements/due.ts";
import { enforcePurchase, guestAcceptancesSchema, pointsOfObjects } from "../agreements/enforce.ts";
import { sameEmailPeople } from "../customers/accounts.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import { ORDER_STATES } from "../fields/order.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { openCheckout } from "../orders/checkout.ts";
import { applyPaymentEvent } from "../orders/events.ts";
import { grantsFollowPerson } from "../orders/grants.ts";
import {
  hashOrderToken,
  newOrderToken,
  ORDER_TOKEN,
  orderForToken,
  resolveBuyer,
} from "../orders/guests.ts";
import { EXPIRE_BATCH, expireDueOrders, honourLatePayment, paidLate } from "../orders/late.ts";
import { movesFollowPerson, releaseUnsettledGuest, startHeld } from "../orders/moves.ts";
import {
  changeOrder,
  createOrder,
  loadOrderRow,
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  type OrderRow,
  OVERDUE_LIMIT,
  overdueOrders,
  type PricedLine,
  requireState,
} from "../orders/orders.ts";
import { applyOtherPayment, RECORDED_KINDS, reverseOtherPayment } from "../orders/payments.ts";
import { requestDueRefund } from "../orders/refund-due.ts";
import { recordRefund, refundablePayments, requestRefund } from "../orders/refunds.ts";
import {
  currencySchema,
  discountLimitSchema,
  loadDiscountLimit,
  loadMinPartPayment,
  loadOrderCurrency,
  loadOrderExpiryMinutes,
  loadOrderTax,
  loadOrderTaxCodes,
  loadRecordedPaymentNotice,
  loadReturnOrigins,
  minPartPaymentSchema,
  ORDER_CURRENCY_SETTING,
  ORDER_DISCOUNT_LIMIT_SETTING,
  ORDER_EXPIRY_SETTING,
  ORDER_MIN_PART_SETTING,
  ORDER_RECORDED_NOTICE_SETTING,
  ORDER_RETURN_ORIGINS_SETTING,
  ORDER_TAX_CODES_SETTING,
  ORDER_TAX_SETTING,
  orderExpiryMinutesSchema,
  recordedPaymentNoticeSchema,
  returnOriginsSchema,
  taxCodesSchema,
} from "../orders/settings.ts";
import {
  type AdjustmentRow,
  giveStaffDiscount,
  liveAdjustments,
  type Repriced,
  removeAdjustment,
  staffDiscountWithinLimit,
} from "../orders/staff-discounts.ts";
import { taxCodeOf } from "../orders/tax.ts";
import { placedAs } from "../principals.ts";
import { callerMover } from "../records/lifecycle.ts";
import type { VisibleRecord } from "../visibility/records.ts";

const orderId = z.string().min(1).max(64).describe("Order id (ord_…)");
const when = z.string().nullable();

const lineSchema = z.object({
  id: z.string(),
  position: z.number(),
  /** The object and id of the record bought. */
  object: z.string(),
  recordId: z.string(),
  title: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  total: z.number(),
  taxAmount: z
    .number()
    .describe("The tax inside this line's payments, as the payment provider calculated it"),
  discount: z
    .number()
    .describe("The line's share of the order's discounts: it costs total less this"),
});

/** Money off an order, as staff read it (ADR 0690). */
const adjustmentSchema = z.object({
  id: z.string(),
  lineId: z.string().nullable().describe("The line it is on; null: spread over the order"),
  kind: z.enum(["code", "automatic", "staff", "referral"]),
  amount: z.number().describe("What it took off, in the currency's minor unit"),
  percent: z.number().nullable().describe("The percentage asked for, when it was one"),
  reason: z.string().nullable(),
  givenBy: z.string().nullable().describe("The staff account that gave it"),
  approval: z.string().nullable().describe("The approval it waited in, when it did"),
  createdAt: z.string(),
});

/**
 * An order as its buyer may read it. Amounts are integers in the currency's minor unit (cents).
 * `personId`, `email` and `placedAs` are there for staff only.
 */
export const orderSchema = z.object({
  id: z.string(),
  state: z.enum(ORDER_STATES),
  currency: z.string(),
  total: z.number(),
  paid: z.number(),
  balance: z.number(),
  refunded: z.number().describe("What has gone back to the buyer, confirmed by the provider"),
  pay: z.enum(["full", "deposit"]),
  deposit: z.number().nullable(),
  balanceDueAt: when,
  expiresAt: when,
  paidAt: when,
  createdAt: z.string(),
  taxAmount: z
    .number()
    .describe(
      "The tax inside what has been paid, as the payment provider calculated it. Prices include " +
        "it, so it does not add to the total. Zero when tax is off or none was charged.",
    ),
  taxRefunded: z.number().describe("The tax the provider said went back with refunds"),
  taxCountry: z.string().nullable().describe("The country the latest taxed payment was for"),
  discount: z
    .number()
    .describe("Money taken off the order (its discounts), already out of the total"),
  lines: z.array(lineSchema),
  adjustments: z
    .array(adjustmentSchema)
    .optional()
    .describe("Staff only: the discounts on the order, in the order they were given"),
  personId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  placedAs: z.enum(["customer", "public", "staff"]).optional(),
});
export type Order = z.infer<typeof orderSchema>;

const isStaff = (ctx: HandlerContext) => ctx.principal.kind === "staff";

/** The order from its table row, as its buyer may read it (and, for staff, whose it is). */
function fromRow(row: OrderRow, lines: readonly Order["lines"][number][], staff: boolean): Order {
  return {
    id: row.id,
    state: row.state,
    currency: row.currency,
    total: row.total,
    paid: row.paid,
    balance: row.total - row.paid,
    refunded: row.refunded,
    pay: row.pay,
    deposit: row.deposit,
    balanceDueAt: row.balance_due_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    taxAmount: row.tax_amount,
    taxRefunded: row.tax_refunded,
    taxCountry: row.tax_country,
    discount: row.discount,
    lines: [...lines],
    ...(staff ? { personId: row.person_id, email: row.email, placedAs: row.placed_as } : {}),
  };
}

const toLine = (line: PricedLine): Order["lines"][number] => ({
  id: line.id,
  position: line.position,
  object: line.object,
  recordId: line.recordId,
  title: line.title,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  total: line.total,
  taxAmount: 0,
  discount: line.discount,
});

/** The lines of an order the host has already established the caller may see. */
async function linesOf(ctx: HandlerContext, id: string): Promise<Order["lines"]> {
  const rows = await ctx.db
    .selectFrom("core_order_line")
    .selectAll()
    .where("order_id", "=", id)
    .orderBy("position")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    object: row.object_type,
    recordId: row.record_id,
    title: row.title,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    total: row.line_total,
    taxAmount: row.tax_amount,
    discount: row.line_discount,
  }));
}

const toAdjustment = (row: AdjustmentRow): z.infer<typeof adjustmentSchema> => ({
  id: row.id,
  lineId: row.line_id,
  kind: row.kind,
  amount: row.amount,
  percent: row.percent,
  reason: row.reason,
  givenBy: row.given_by,
  approval: row.approval,
  createdAt: row.created_at,
});

const text = (value: unknown) => (value == null ? null : String(value));

/** An order record the seam returned, without its lines. */
function fromRecord(record: VisibleRecord, staff: boolean): Omit<Order, "lines"> {
  const v = record.values;
  return orderSchema.omit({ lines: true }).parse({
    id: record.id,
    state: v.state,
    currency: v.currency,
    total: v.total,
    paid: v.paid,
    balance: v.balance,
    refunded: v.refunded ?? 0,
    pay: v.pay,
    deposit: v.deposit ?? null,
    balanceDueAt: text(v.balanceDueAt),
    expiresAt: text(v.expiresAt),
    paidAt: text(v.paidAt),
    createdAt: String(v.createdAt),
    taxAmount: v.taxAmount ?? 0,
    taxRefunded: v.taxRefunded ?? 0,
    taxCountry: text(v.taxCountry),
    discount: v.discount ?? 0,
    ...(staff ? { personId: text(v.personId), email: text(v.email), placedAs: v.placedAs } : {}),
  });
}

/** An order read through the seam: only what the caller's scope returned is in `values`. */
async function throughSeam(ctx: HandlerContext, id: string): Promise<Order> {
  const record: VisibleRecord = await ctx.records.get("order", id);
  const page = await ctx.records.list("orderLine", {
    filter: { field: "orderId", op: "eq", value: id },
    sort: { field: "position", direction: "asc" },
    limit: ORDER_MAX_LINES,
  });
  const v = record.values;
  const staff = isStaff(ctx);
  return orderSchema.parse({
    id: record.id,
    state: v.state,
    currency: v.currency,
    total: v.total,
    paid: v.paid,
    balance: v.balance,
    refunded: v.refunded ?? 0,
    pay: v.pay,
    deposit: v.deposit ?? null,
    balanceDueAt: text(v.balanceDueAt),
    expiresAt: text(v.expiresAt),
    paidAt: text(v.paidAt),
    createdAt: String(v.createdAt),
    taxAmount: v.taxAmount ?? 0,
    taxRefunded: v.taxRefunded ?? 0,
    taxCountry: text(v.taxCountry),
    discount: v.discount ?? 0,
    lines: page.items.map((line) => ({
      id: line.id,
      position: line.values.position,
      object: line.values.object,
      recordId: line.values.recordId,
      title: line.values.title,
      quantity: line.values.quantity,
      unitPrice: line.values.unitPrice,
      total: line.values.total,
      taxAmount: line.values.taxAmount ?? 0,
      discount: line.values.discount ?? 0,
    })),
    ...(staff ? { adjustments: (await liveAdjustments(ctx.db, id)).map(toAdjustment) } : {}),
    ...(staff ? { personId: text(v.personId), email: text(v.email), placedAs: v.placedAs } : {}),
  });
}

// --- Starting an order -------------------------------------------------------------------------

export const orderStartInput = z.object({
  lines: z
    .array(
      z.object({
        object: z.string().min(1).max(80).describe("The object of the record to buy"),
        id: z.string().min(1).max(64).describe("The record to buy"),
        quantity: z.number().int().min(1).max(ORDER_MAX_QUANTITY).default(1),
      }),
    )
    .min(1)
    .max(ORDER_MAX_LINES)
    .describe(
      "What to buy. There is no price here: the host reads it from each record, and a price " +
        "or total sent anyway is ignored.",
    ),
  pay: z
    .enum(["full", "deposit"])
    .default("full")
    .describe(
      "full: pay the whole price now. deposit: pay the deposit now and the balance by its due " +
        "date, when every line offers a deposit.",
    ),
  email: z
    .string()
    .trim()
    .max(320)
    .optional()
    .describe(
      "The buyer's email address. Required when the caller is not a signed-in customer; a " +
        "signed-in customer's order uses their account's address and must not pass one.",
    ),
  agreements: guestAcceptancesSchema.optional(),
});

export const orderStart = defineOperation({
  name: "order.start",
  description:
    "Start an order for one or more records that are for sale, as a signed-in customer, a guest " +
    "(with an email address) or staff. The host prices it from the records: a caller never " +
    "sends a price or a total. The order starts pending and is not paid: paying happens on the " +
    "payment provider's page (order.checkout), and only the provider's confirmation marks it " +
    "paid. An unpaid order expires after a few minutes. Nobody buys without the agreements the " +
    "business needs for what is bought: refused with rule agreements_due and the documents " +
    "while any is due (a guest passes their acceptances in `agreements`; a signed-in customer " +
    "agrees first; staff send a link, sign at the desk or record paper). Returns the order with " +
    "its lines and amounts in the currency's minor unit; a guest also gets `token`, shown once, " +
    "which is the only way back to the order (order.view).",
  input: orderStartInput,
  output: orderSchema.extend({
    token: z.string().nullable().describe("A guest's key to this order. Null for everyone else."),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  // What a visitor typed, drew and answered never reaches the audit log.
  redact: ["agreements"],
  // Never the token: it is the guest's, and the audit log is read by staff.
  auditSummary: (output) => ({ id: output.id }),
  async handler(input, ctx) {
    const caller = ctx.principal;
    let personId: string | null;
    let email: string;
    let token: string | null = null;
    if (caller.kind === "customer") {
      if (input.email !== undefined) {
        throw new ValidationError("You are signed in: the order uses your account's address", {
          field: "email",
        });
      }
      const account = await ctx.db
        .selectFrom("core_customer")
        .select("email")
        .where("id", "=", caller.customerId)
        .executeTakeFirst();
      if (!account) throw new NotFoundError("customer", caller.customerId);
      personId = caller.personId;
      email = account.email;
    } else {
      if (!input.email) {
        throw new ValidationError("An order needs the buyer's email address", { field: "email" });
      }
      const buyer = await resolveBuyer(ctx, input.email);
      personId = buyer.personId;
      email = buyer.email;
      if (caller.kind === "public") token = newOrderToken();
    }
    const started = await createOrder(ctx, {
      lines: input.lines,
      personId,
      email,
      placedAs: placedAs(caller),
      pay: input.pay,
      accessHash: token ? await hashOrderToken(token) : null,
      agreements: input.agreements,
    });
    return { ...fromRow(started.row, started.lines.map(toLine), isStaff(ctx)), token };
  },
});

/**
 * The People an address is theirs: the live ones with it, and the survivor of any merge of one
 * that had it.
 */
async function addressPeople(ctx: HandlerContext, email: string): Promise<Set<string>> {
  if (!email) return new Set();
  const people = new Set(await sameEmailPeople(ctx.db, email));
  const merged = await ctx.db
    .selectFrom("core_person_emails as e")
    .innerJoin("core_person as p", "p.id", "e.person_id")
    .select("p.merged_into_id")
    .where("e.email", "=", email)
    .where("p.merged_into_id", "is not", null)
    .execute();
  for (const row of merged) if (row.merged_into_id) people.add(row.merged_into_id);
  return people;
}

// --- Reading an order --------------------------------------------------------------------------

export const orderGet = defineOperation({
  name: "order.get",
  description:
    "Get one order with its lines: its state, amounts (in the currency's minor unit), what has " +
    "been paid, the balance and when it is due. A signed-in customer gets their own orders only; " +
    "anyone else's is not found. Read-only.",
  input: z.object({ id: orderId }),
  output: orderSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return throughSeam(ctx, input.id);
  },
});

export const orderList = defineOperation({
  name: "order.list",
  description:
    "A page of orders, newest first unless sorted otherwise, without their lines (order.get has " +
    "them). Filter and sort on an order's fields: state, total, paid, balance, pay, personId, " +
    "email, createdAt, balanceDueAt. Amounts are in the currency's minor unit. Pass nextCursor " +
    "back as cursor for the next page. Read-only.",
  input: z.object({
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({
    items: z.array(orderSchema.omit({ lines: true })),
    nextCursor: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await ctx.records.list("order", input);
    return {
      items: page.items.map((record) => fromRecord(record, true)),
      nextCursor: page.nextCursor,
    };
  },
});

export const orderView = defineOperation({
  name: "order.view",
  description:
    "See one order with the token it was started with (a guest's link from order.start or the " +
    "confirmation email). The token opens that order only, while it is open and for 30 days " +
    "after it closes. A wrong id, a wrong token and an old link are all not found. Read-only.",
  input: z.object({
    id: orderId,
    token: z.string().min(1).max(128).describe("The order's token"),
  }),
  output: orderSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  redact: ["token"],
  async handler(input, ctx) {
    const row = ORDER_TOKEN.test(input.token)
      ? await orderForToken(ctx.db, input.id, input.token, ctx.now)
      : null;
    if (!row) throw new NotFoundError("order", input.id);
    // Whoever holds the token sees what a customer may read of an order, and no more.
    return fromRow(row, await linesOf(ctx, row.id), false);
  },
});

// --- Changing an order -------------------------------------------------------------------------

export const orderCancel = defineOperation({
  name: "order.cancel",
  description:
    "Cancel an order. A signed-in customer can cancel their own order while nothing has been " +
    "paid on it. Staff can also cancel an order that is part paid (a deposit was paid): that " +
    "gives up its places, and refunding what was paid is a separate step. A paid order is " +
    "refunded, not cancelled. Returns the order.",
  input: z.object({ id: orderId }),
  output: orderSchema,
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer"],
  hostInternal: true,
  async handler(input, ctx) {
    // A customer's own order only: another's is not found, as through the seam.
    if (!isStaff(ctx)) await ctx.records.get("order", input.id);
    const row = await loadOrderRow(ctx.db, input.id);
    requireState(row, ["pending", "part_paid"], "cancelled");
    // The engine has the rule: a customer may make only `pending` → `cancelled`.
    const next = await changeOrder(
      ctx,
      row,
      "cancelled",
      { cancelled_at: ctx.now },
      callerMover(ctx),
    );
    return fromRow(next, await linesOf(ctx, row.id), isStaff(ctx));
  },
});

export const orderExtendBalanceDue = defineOperation({
  name: "order.extendBalanceDue",
  description:
    "Give a part-paid order (a deposit was paid) more time: set the date its balance is due. " +
    "The new date must be in the future. Nothing else changes: the order keeps its places, and " +
    "the buyer pays the rest from their order link. Returns the order.",
  input: z.object({
    id: orderId,
    balanceDueAt: z.iso
      .datetime({ offset: true })
      .describe("When the balance is now due (ISO 8601, with a time zone)"),
  }),
  output: orderSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    requireState(row, ["part_paid"], "given a new due date");
    const due = new Date(input.balanceDueAt).toISOString();
    if (due <= ctx.now) {
      throw new ValidationError("The new due date must be in the future", {
        field: "balanceDueAt",
      });
    }
    const next = await changeOrder(ctx, row, row.state, { balance_due_at: due }, callerMover(ctx));
    return fromRow(next, await linesOf(ctx, row.id), true);
  },
});

export const orderSetPerson = defineOperation({
  name: "order.setPerson",
  description:
    "Say whose order it is, for an order that belongs to no one yet because the address it was " +
    "placed with matched several people. Merge those people first, then pass the one that " +
    "remains. An order that already has a person is refused. Returns the order.",
  input: z.object({ id: orderId, personId: z.string().min(1).max(64) }),
  output: orderSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    if (row.person_id) {
      throw new ConflictError("This order already has a person", { order: row.id });
    }
    // The person must be one the caller can see, and live.
    await ctx.records.get("person", input.personId);
    // One of the People the order's address matches, or the survivor of merging them (stage 44,
    // the review of PR #280): never a Person with another address, whom the order's guest
    // acceptances would otherwise settle to.
    if (!(await addressPeople(ctx, row.email ?? "")).has(input.personId)) {
      throw new ValidationError(
        "That Person does not have this order's address: merge the People who do, then pass the " +
          "one that remains",
        { field: "personId", rule: "order_person" },
      );
    }
    // A minor is the order's only once nothing is due for them (a guest's acceptances never count
    // for a minor): a parent, a guardian or a paper form agrees first, or the order is refunded.
    if (isMinor(await personFacts(ctx.db, input.personId))) {
      const lines = await ctx.db
        .selectFrom("core_order_line")
        .select("object_type")
        .where("order_id", "=", row.id)
        .execute();
      const agreed = await enforcePurchase(
        ctx,
        pointsOfObjects(lines.map((line) => line.object_type)),
        { guest: false, participant: input.personId, payer: input.personId },
        undefined,
      );
      if (agreed.guards.length) ctx.write(...agreed.guards);
    }
    const next = await changeOrder(
      ctx,
      row,
      row.state,
      { person_id: input.personId },
      callerMover(ctx),
    );
    // What the order already granted to its buyer (a ticket's holder) follows, in this batch; so
    // does a paid guest drop-in still held for it (ADR 0560).
    await grantsFollowPerson(ctx, row.id, input.personId);
    await movesFollowPerson(ctx, row.id, input.personId);
    return fromRow(next, await linesOf(ctx, row.id), true);
  },
});

export const orderOverdue = defineOperation({
  name: "order.overdue",
  description:
    "List part-paid orders whose balance is past its due date, oldest first. Nothing happens to " +
    "them by itself: extend the date (order.extendBalanceDue), cancel (order.cancel), or the " +
    "buyer pays. Read-only.",
  input: z.object({ limit: z.number().int().min(1).max(OVERDUE_LIMIT).default(50) }),
  output: z.object({ items: z.array(orderSchema.omit({ lines: true })) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await overdueOrders(ctx.db, ctx.now, input.limit);
    return {
      items: rows.map((row) => {
        const { lines: _lines, ...rest } = fromRow(row, [], true);
        return rest;
      }),
    };
  },
});

// --- Paying ------------------------------------------------------------------------------------

/** The order a checkout is for: the caller's own (customer), any (staff), or the token's. */
async function orderForPaying(
  ctx: HandlerContext,
  id: string,
  token: string | undefined,
): Promise<OrderRow> {
  if (token !== undefined) {
    const row = ORDER_TOKEN.test(token) ? await orderForToken(ctx.db, id, token, ctx.now) : null;
    if (!row) throw new NotFoundError("order", id);
    return row;
  }
  if (ctx.principal.kind === "public") throw new NotFoundError("order", id);
  // A customer's own order only: another's is not found, as through the seam.
  if (!isStaff(ctx)) await ctx.records.get("order", id);
  return loadOrderRow(ctx.db, id);
}

export const orderCheckout = defineOperation({
  name: "order.checkout",
  description:
    "Open the payment provider's own page to pay for an order, and get its address to send the " +
    "buyer to. The host says what is charged: the whole price or the deposit for an order with " +
    "nothing paid (no amount may be given), or, for a part-paid order, the balance or a part of " +
    "it of at least the set minimum (`amount`, in the currency's minor unit). The buyer comes " +
    "back to `returnUrl`, which must be on one of the deployment's listed sites; coming back " +
    "does not mark anything paid. Only the provider's confirmation does. A guest passes the " +
    "order's token; a signed-in customer pays their own orders.",
  input: z.object({
    id: orderId,
    token: z.string().min(1).max(128).optional().describe("A guest's token for the order"),
    returnUrl: z.string().min(1).max(2000).describe("Where the buyer comes back to"),
    amount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Part-paid orders only: how much to pay towards the balance, in minor units"),
  }),
  output: z.object({
    url: z.string().describe("The provider's payment page"),
    amount: z.number(),
    currency: z.string(),
    kind: z.enum(["full", "deposit", "balance", "part"]),
    expiresAt: z.string().nullable(),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  redact: ["token"],
  auditSummary: (output, input) => ({ id: input.id, amount: output.amount, kind: output.kind }),
  async handler(input, ctx) {
    const row = await orderForPaying(ctx, input.id, input.token);
    const opened = await openCheckout(ctx, row, {
      returnUrl: input.returnUrl,
      amount: input.amount,
    });
    return {
      url: opened.url,
      amount: opened.amount,
      currency: opened.currency,
      kind: opened.kind,
      expiresAt: opened.expiresAt,
    };
  },
});

export const orderApplyPaymentEvent = defineOperation({
  name: "order.applyPaymentEvent",
  description:
    "Platform use only: apply a payment or refund event the payments gatekeeper verified and the " +
    "host stored. Takes only the event's key: the event itself is read from what the host " +
    "stored, so nothing passed here can describe a payment. Applying an event twice changes " +
    "nothing. Run by the host's payments adapter and the minute cron.",
  input: z.object({
    provider: z.string().min(1).max(40),
    eventId: z.string().min(1).max(200),
  }),
  output: z.object({
    outcome: z.string(),
    orderId: z.string().nullable(),
    state: z.enum(ORDER_STATES).nullable(),
    confirmation: z.object({ orderId: z.string(), token: z.string() }).nullable(),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  // Never the confirmation's token.
  auditSummary: (output) => ({ outcome: output.outcome, orderId: output.orderId }),
  async handler(input, ctx) {
    return applyPaymentEvent(ctx, input);
  },
});

export const orderExpireDue = defineOperation({
  name: "order.expireDue",
  description:
    "Platform use only: expire pending orders whose time to pay has run out (the minute cron). " +
    "Their held places go back. Part-paid orders never expire. Returns the orders expired.",
  input: z.object({ limit: z.number().int().min(1).max(EXPIRE_BATCH).default(EXPIRE_BATCH) }),
  output: z.object({ expired: z.array(z.string()) }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({ count: output.expired.length }),
  async handler(input, ctx) {
    return { expired: await expireDueOrders(ctx, input.limit) };
  },
});

const latePaymentSchema = z.object({
  orderId: z.string(),
  provider: z.string(),
  eventId: z.string(),
  amount: z.number(),
  currency: z.string(),
  receivedAt: z.string(),
  orderState: z.enum(ORDER_STATES),
  orderTotal: z.number(),
});

export const orderPaidLate = defineOperation({
  name: "order.paidLate",
  description:
    "List payments that arrived after their order had closed (expired or cancelled), oldest " +
    "first, that staff have not decided on: honour one (order.honourLate) or refund it " +
    "(order.refund). Amounts are in the currency's minor unit. Read-only.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ items: z.array(latePaymentSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return { items: await paidLate(ctx.db, input.limit) };
  },
});

export const orderHonourLate = defineOperation({
  name: "order.honourLate",
  description:
    "Keep a payment that arrived after the order expired: the order becomes paid (part paid for " +
    "a late deposit). When what it bought has limited places they are taken again, and this is " +
    "refused when they have gone: refund the payment instead. A person with the refund " +
    "permission decides, not an AI assistant. Returns the order.",
  input: z.object({ id: orderId }),
  output: orderSchema,
  permission: "orders:refund",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    const next = await honourLatePayment(ctx, row);
    return fromRow(next, await linesOf(ctx, row.id), true);
  },
});

export const orderRefund = defineOperation({
  name: "order.refund",
  description:
    "Ask for a refund of an order's payments: all that can be refunded, or `amount` (in the " +
    "currency's minor unit). Nothing is sent yet: each refund goes to the Approvals inbox, with " +
    "what will be sent back and to which payment, and a person with the refund permission " +
    "approves it (an AI assistant can ask, never approve). The order is marked refunded only " +
    "when the payment provider confirms everything paid has gone back; a part refund is " +
    "recorded as an amount. A part-paid order is cancelled first. Returns the refunds asked for " +
    "and the pending approvals.",
  input: z.object({
    id: orderId,
    amount: z.number().int().positive().optional().describe("Minor units; default all"),
    reason: z.string().trim().min(1).max(500).describe("Why, in staff's words"),
  }),
  output: z.object({
    refunds: z.array(
      z.object({
        id: z.string(),
        paymentRef: z.string(),
        amount: z.number(),
        pendingActionId: z.string().nullable(),
      }),
    ),
    pending: z.array(z.record(z.string(), z.unknown())),
  }),
  permission: "orders:refund",
  // The refund itself is the gatekeeper's outbound action, reviewed on its own, always: asking
  // is never queued, so a refund is not reviewed twice.
  risk: "outbound",
  bookkeeping: true,
  auditSummary: (output, input) => ({
    id: input.id,
    refunds: output.refunds.map((r) => ({ id: r.id, amount: r.amount })),
  }),
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    const asked = await requestRefund(ctx, row, { amount: input.amount, reason: input.reason });
    return {
      refunds: asked.refunds,
      pending: asked.pending as unknown as Record<string, unknown>[],
    };
  },
});

export const orderPayments = defineOperation({
  name: "order.payments",
  description:
    "An order's money in detail, for staff: each checkout opened, each payment (the provider's, " +
    "applied, late or not matching; or one a person recorded, and its reversal) and each refund " +
    "(asked for or confirmed), with what can still be refunded per payment. Amounts are in the " +
    "currency's minor unit. Read-only.",
  input: z.object({ id: orderId }),
  output: z.object({
    checkouts: z.array(
      z.object({
        provider: z.string(),
        ref: z.string(),
        amount: z.number(),
        kind: z.string(),
        createdAt: z.string(),
        taxed: z.boolean().describe("Whether tax was asked of the provider for this payment"),
      }),
    ),
    payments: z.array(
      z.object({
        provider: z.string(),
        eventId: z.string(),
        amount: z.number(),
        currency: z.string(),
        outcome: z.string(),
        paymentRef: z.string().nullable(),
        resolved: z.string().nullable(),
        receivedAt: z.string(),
        taxAmount: z.number().nullable().describe("The provider's tax on it; null: not taxed"),
        taxCountry: z.string().nullable(),
        method: z
          .string()
          .describe("provider (the payment page), or recorded (taken another way by a person)"),
        recordedKind: z.string().nullable().describe("A recorded one: transfer, cash, …"),
        recordedBy: z.string().nullable().describe("A recorded one: who received it"),
        receivedOn: z.string().nullable(),
        reference: z.string().nullable(),
        reverses: z
          .string()
          .nullable()
          .describe("A reversal: the payment it takes back off (its amount is negative)"),
        reason: z.string().nullable().describe("A reversal's reason"),
      }),
    ),
    refunds: z.array(
      z.object({
        id: z.string(),
        amount: z.number(),
        status: z.string(),
        paymentRef: z.string().nullable(),
        reason: z.string().nullable(),
        pendingActionId: z.string().nullable(),
        createdAt: z.string(),
        confirmedAt: z.string().nullable(),
        taxAmount: z
          .number()
          .nullable()
          .describe("The tax it gave back, when the provider said; null: not said"),
        method: z.string().describe("provider, or recorded (paid back by a person)"),
        recordedKind: z.string().nullable(),
      }),
    ),
    refundable: z.array(
      z.object({
        paymentRef: z.string(),
        method: z.string(),
        paid: z.number(),
        refundable: z.number(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    const [checkouts, payments, refunds, refundable] = await Promise.all([
      ctx.db
        .selectFrom("core_order_checkout")
        .selectAll()
        .where("order_id", "=", row.id)
        .orderBy("created_at")
        .execute(),
      ctx.db
        .selectFrom("core_order_payment")
        .selectAll()
        .where("order_id", "=", row.id)
        .orderBy("received_at")
        .execute(),
      ctx.db
        .selectFrom("core_order_refund")
        .selectAll()
        .where("order_id", "=", row.id)
        .orderBy("created_at")
        .execute(),
      refundablePayments(ctx, row.id),
    ]);
    return {
      checkouts: checkouts.map((c) => ({
        provider: c.provider,
        ref: c.ref,
        amount: c.amount,
        kind: c.kind,
        createdAt: c.created_at,
        taxed: c.tax_lines !== null,
      })),
      payments: payments.map((p) => ({
        provider: p.provider,
        eventId: p.event_id,
        amount: p.amount,
        currency: p.currency,
        outcome: p.outcome,
        paymentRef: p.payment_ref,
        resolved: p.resolved,
        receivedAt: p.received_at,
        taxAmount: p.tax_amount,
        taxCountry: p.tax_country,
        method: p.method,
        recordedKind: p.recorded_kind,
        recordedBy: p.recorded_by,
        receivedOn: p.received_on,
        reference: p.reference,
        reverses: p.reverses,
        reason: p.reason,
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        amount: r.amount,
        status: r.status,
        paymentRef: r.payment_ref,
        reason: r.reason,
        pendingActionId: r.pending_action_id,
        createdAt: r.created_at,
        confirmedAt: r.confirmed_at,
        taxAmount: r.tax_amount,
        method: r.method,
        recordedKind: r.recorded_kind,
      })),
      refundable: refundable.map((r) => ({
        paymentRef: r.paymentRef,
        method: r.method,
        paid: r.paid,
        refundable: r.refundable,
      })),
    };
  },
});

// --- Payments taken another way (stage 34, ADR 0694) ---------------------------------------------

const recordedKind = z
  .enum(RECORDED_KINDS)
  .describe("How it was paid: transfer, cash, cheque, card_machine or other");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD");

/** How far back a recorded payment's day may be. */
const RECEIVED_DAYS_BACK = 366;

/**
 * A real calendar day, no later than tomorrow in UTC (today wherever the business is) and at most
 * a year back: a payment is recorded once received, and soon after (review of PR #426).
 */
function receivedDayOk(day: string, now: string): boolean {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day) return false;
  const today = Date.parse(`${now.slice(0, 10)}T00:00:00Z`);
  return at <= today + 86_400_000 && at >= today - RECEIVED_DAYS_BACK * 86_400_000;
}

const paidAnotherWay = z.object({
  paymentId: z.string(),
  order: orderSchema,
});

export const orderRecordPayment = defineOperation({
  name: "order.recordPayment",
  description:
    "Record a payment taken another way than the payment page (a bank transfer, cash, a " +
    "cheque, a card machine) on an order still owed money: any amount up to what is owed, never " +
    "more (a drop-in that books a place is paid in full). The order becomes paid (or part paid) " +
    "as if the provider had been paid, and what it bought is given. The payment names you as " +
    "the person who received it. Admins are told of one over the amount an admin set, or when " +
    "the buyer had opened a payment page (a payment made there now is refunded). A person only, with the permission to record payments: " +
    "AI assistants, MCP clients, automations and extensions are refused. Returns the payment's " +
    "id and the order.",
  input: z.object({
    id: orderId,
    amount: z
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .describe("What was received, in the currency's minor unit (cents)"),
    kind: recordedKind,
    receivedOn: isoDate.describe("The day it was received (YYYY-MM-DD)"),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("The payer's reference: a bank reference, a cheque number"),
  }),
  output: paidAnotherWay,
  permission: "orders:payments",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    id: input.id,
    paymentId: output.paymentId,
    amount: input.amount,
    kind: input.kind,
  }),
  async handler(input, ctx) {
    if (!receivedDayOk(input.receivedOn, ctx.now)) {
      throw new ValidationError(
        "The day received is a real day, not after today and at most a year ago",
        { field: "receivedOn", rule: "received_on" },
      );
    }
    const paid = await applyOtherPayment(ctx, {
      orderId: input.id,
      amount: input.amount,
      payment: {
        method: "recorded",
        kind: input.kind,
        // Who received it is the caller, never input.
        recordedBy: ctx.user.id,
        receivedOn: input.receivedOn,
        reference: input.reference ?? null,
      },
    });
    return {
      paymentId: paid.paymentId,
      order: fromRow(paid.order, await linesOf(ctx, paid.order.id), true),
    };
  },
});

export const orderReversePayment = defineOperation({
  name: "order.reversePayment",
  description:
    "Reverse a payment recorded in error (order.recordPayment): a second entry takes it back " +
    "off, nothing is deleted, and an order it had paid is part paid again with the amount owed. " +
    "What the order gave stays: take the right payment or cancel the order. A drop-in's booking " +
    "is cancelled first. Not for the payment " +
    "provider's payments (refund those). Admins are told. A person only, with the permission to " +
    "record payments. Get the payment's id from order.payments. Returns the reversal's id and " +
    "the order.",
  input: z.object({
    paymentId: z.string().min(1).max(64).describe("The recorded payment (opy_…)"),
    reason: z.string().trim().min(1).max(500).describe("Why it was entered in error"),
  }),
  output: paidAnotherWay,
  permission: "orders:payments",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    paymentId: input.paymentId,
    reversalId: output.paymentId,
    id: output.order.id,
  }),
  async handler(input, ctx) {
    const reversed = await reverseOtherPayment(ctx, {
      paymentId: input.paymentId,
      reason: input.reason,
      reversedBy: ctx.user.id,
    });
    return {
      paymentId: reversed.reversalId,
      order: fromRow(reversed.order, await linesOf(ctx, reversed.order.id), true),
    };
  },
});

export const orderRecordRefund = defineOperation({
  name: "order.recordRefund",
  description:
    "Record money paid back by hand on a payment that was recorded (taken by transfer, cash and " +
    "so on): how it went back, how much (default: all that is left on that payment) and why. " +
    "Nothing is sent: you say you paid it. The order is refunded once everything paid has gone " +
    "back. Payments made on the payment page are refunded with order.refund instead. A person " +
    "only, with the refund permission. Returns the refund and the order.",
  input: z.object({
    id: orderId,
    paymentId: z.string().min(1).max(64).describe("The recorded payment it went back on (opy_…)"),
    amount: z.number().int().positive().optional().describe("Minor units; default all"),
    kind: recordedKind.describe(
      "How it was paid back: transfer, cash, cheque, card_machine or other",
    ),
    reference: z.string().trim().min(1).max(200).optional().describe("Its reference, if any"),
    reason: z.string().trim().min(1).max(500).describe("Why, in staff's words"),
  }),
  output: z.object({ refundId: z.string(), amount: z.number(), order: orderSchema }),
  permission: "orders:refund",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    id: input.id,
    paymentId: input.paymentId,
    refundId: output.refundId,
    amount: output.amount,
  }),
  async handler(input, ctx) {
    const row = await loadOrderRow(ctx.db, input.id);
    const done = await recordRefund(ctx, row, {
      paymentId: input.paymentId,
      amount: input.amount,
      kind: input.kind,
      reference: input.reference ?? null,
      reason: input.reason,
    });
    return {
      refundId: done.refundId,
      amount: done.amount,
      order: fromRow(done.order, await linesOf(ctx, done.order.id), true),
    };
  },
});

// --- Staff discounts (stage 34, ADR 0691) -------------------------------------------------------

const adjustInput = z
  .object({
    id: orderId,
    lineId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "The line to take it off (orl_…). Left out: the whole order, spread over its lines",
      ),
    percent: z
      .number()
      .gt(0)
      .max(100)
      .multipleOf(0.01)
      .optional()
      .describe("A percentage off what is left to pay, rounded down on each line. Or pass amount"),
    amount: z
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .optional()
      .describe("An amount off, in the currency's minor unit (cents). Or pass percent"),
    reason: z.string().trim().min(1).max(500).describe("Why: shown to staff on the order"),
  })
  .refine((v) => (v.percent === undefined) !== (v.amount === undefined), {
    message: "Pass percent or amount, not both",
  });

/** The order as a change to its adjustments leaves it: its lines' shares are not written yet. */
async function repriced(ctx: HandlerContext, result: Repriced): Promise<Order> {
  const lines = await linesOf(ctx, result.order.id);
  return fromRow(
    result.order,
    lines.map((line) => ({ ...line, discount: result.discounts.get(line.id) ?? line.discount })),
    true,
  );
}

export const orderAdjust = defineOperation({
  name: "order.adjust",
  description:
    "Give a discount on a pending order whose payment page has not opened: a percentage or an " +
    "amount, off one line or the whole order, with a reason. Within the limit an admin set it " +
    "applies at once and the order's total drops; above it, the discount waits in the Approvals " +
    "inbox for an admin, and the order cannot be paid until it is decided. An AI's request " +
    "always waits. A discount cannot take an order to nothing. Returns the order.",
  input: adjustInput,
  output: orderSchema,
  permission: "orders:discount",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // An AI asks; a person decides (ADR 0480): whatever the preset or the amount.
  alwaysReview: ["assistant", "mcp"],
  // A person's discount over the limit a human admin set waits for an admin.
  reviewWhen: (input, db) => staffDiscountWithinLimit(db, input).then((within) => !within),
  async handler(input, ctx) {
    return repriced(ctx, await giveStaffDiscount(ctx, input.id, input));
  },
});

export const orderUnadjust = defineOperation({
  name: "order.unadjust",
  description:
    "Take a discount off a pending order whose payment page has not opened: the order's total " +
    "goes back up by what it took off. Get the discount's id from order.get. An AI's request " +
    "always waits for an admin. Returns the order.",
  input: z.object({
    id: orderId,
    adjustmentId: z.string().min(1).max(64).describe("The discount to take off (oad_…)"),
  }),
  output: orderSchema,
  permission: "orders:discount",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // Raising the price a customer was given, perhaps undoing an admin's approval: an AI asks, a
  // human admin decides (review of PR #380).
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    return repriced(ctx, await removeAdjustment(ctx, input.id, input.adjustmentId));
  },
});

// --- Settings ----------------------------------------------------------------------------------

const orderSettings = z.object({
  currency: z
    .string()
    .nullable()
    .describe("The one currency every order is in (ISO 4217). Null: not set, nothing can be sold."),
  expiryMinutes: z.number().describe("Minutes an order nothing has been paid on lasts."),
  minPartPayment: z
    .number()
    .describe("The least a buyer may pay towards a balance, in the currency's minor unit."),
  returnOrigins: z
    .array(z.string())
    .describe("The sites a buyer may be sent back to after paying (https origins)."),
  tax: z
    .boolean()
    .describe(
      "Whether the payment provider calculates tax at checkout (Stripe Tax). Off until a human " +
        "admin turns it on. Prices include tax, so what a buyer pays does not change.",
    ),
  taxCodes: z
    .record(z.string(), z.string())
    .describe("A human admin's product tax code per object, over the one its pack declares."),
  discountLimit: discountLimitSchema.describe(
    "How much staff may take off one order on their own (order.adjust). Above it, a discount " +
      "waits for an admin. Nothing (0) until a human admin sets it.",
  ),
  recordedPaymentNotice: z
    .number()
    .describe(
      "Admins are told of a payment recorded by hand (order.recordPayment) for more than this, " +
        "in minor units. 0 until a human admin sets it: every one is told.",
    ),
});

async function loadSettings(ctx: HandlerContext) {
  return {
    currency: await loadOrderCurrency(ctx.db),
    expiryMinutes: await loadOrderExpiryMinutes(ctx.db),
    minPartPayment: await loadMinPartPayment(ctx.db),
    returnOrigins: await loadReturnOrigins(ctx.db),
    tax: await loadOrderTax(ctx.db),
    taxCodes: await loadOrderTaxCodes(ctx.db),
    discountLimit: await loadDiscountLimit(ctx.db),
    recordedPaymentNotice: await loadRecordedPaymentNotice(ctx.db),
  };
}

/** Every object for sale that declares a product tax code: what tax at checkout can apply to. */
function taxObjects(codes: Readonly<Record<string, string>>) {
  return listObjects()
    .filter((object) => object.sellable?.tax)
    .map((object) => ({
      object: object.name,
      label: object.label,
      declared: object.sellable?.tax?.code as string,
      code: taxCodeOf(object, codes) as string,
      place: Boolean(object.sellable?.tax?.place),
    }));
}

export const orderSettingsGet = defineOperation({
  name: "order.settings.get",
  description:
    "Get the order settings: the deployment's currency, how long an unpaid order lasts, the " +
    "least a buyer may pay towards a balance, and tax at checkout: whether it is on, and each " +
    "object for sale that declares a product tax code with the code it is taxed at. Read-only.",
  input: z.object({}),
  output: orderSettings.extend({
    taxObjects: z.array(
      z.object({
        object: z.string(),
        label: z.string(),
        declared: z.string().describe("The code its pack declares"),
        code: z.string().describe("The code it is taxed at: an admin's, else the pack's"),
        place: z.boolean().describe("Taxed where it takes place (an in-person event)"),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const settings = await loadSettings(ctx);
    return { ...settings, taxObjects: taxObjects(settings.taxCodes) };
  },
});

export const orderSettingsUpdate = defineOperation({
  name: "order.settings.update",
  description:
    "Change the order settings: the currency every order is in, the minutes an unpaid order " +
    "lasts, the least part payment, the sites a buyer may come back to after paying, whether " +
    "the payment provider calculates tax at checkout, the product tax code of an object for " +
    "sale, how much staff may take off an order on their own, or above what a payment recorded " +
    "by hand tells admins. Only what you pass changes. Orders already started keep the currency they were " +
    "started in; turning tax on or off changes only payments made from then on. Admins only, " +
    "and only a human can call it: AI assistants, MCP clients, automations and extensions are " +
    "refused.",
  input: z.object({
    currency: currencySchema.optional(),
    expiryMinutes: orderExpiryMinutesSchema.optional(),
    minPartPayment: minPartPaymentSchema.optional(),
    returnOrigins: returnOriginsSchema
      .optional()
      .describe(
        "Replaces the list of sites a buyer may come back to, e.g. https://shop.example.com",
      ),
    tax: z
      .boolean()
      .optional()
      .describe(
        "Turn tax at checkout on or off. On, the provider taxes each line whose object declares " +
          "a tax code, inside the price, where the org has a tax registration in its account.",
      ),
    taxCodes: taxCodesSchema
      .optional()
      .describe(
        "Replaces the admin's product tax codes, by object (e.g. ticketing.tickettype → " +
          "txcd_50010001). Only objects that declare a tax code may be given one; an object left " +
          "out is taxed at its pack's code.",
      ),
    discountLimit: discountLimitSchema
      .optional()
      .describe(
        "How much staff may take off one order without an admin's approval: at most this " +
          "percentage of the order and at most this amount (minor units), both at once.",
      ),
    recordedPaymentNotice: recordedPaymentNoticeSchema
      .optional()
      .describe("Tell admins of a payment recorded by hand for more than this (minor units)"),
  }),
  output: orderSettings.extend({ previous: orderSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationError(
        "Pass currency, expiryMinutes, minPartPayment, returnOrigins, tax, taxCodes, discountLimit or recordedPaymentNotice",
      );
    }
    for (const object of Object.keys(input.taxCodes ?? {})) {
      if (!getObject(object)?.sellable?.tax) {
        throw new ValidationError(
          `${object} declares no tax code, so it is not taxed and cannot be given one`,
          { field: "taxCodes", object },
        );
      }
    }
    const previous = await loadSettings(ctx);
    const next = {
      currency: input.currency ?? previous.currency,
      expiryMinutes: input.expiryMinutes ?? previous.expiryMinutes,
      minPartPayment: input.minPartPayment ?? previous.minPartPayment,
      returnOrigins: input.returnOrigins
        ? [...new Set(input.returnOrigins)]
        : previous.returnOrigins,
      tax: input.tax ?? previous.tax,
      taxCodes: input.taxCodes ?? previous.taxCodes,
      discountLimit: input.discountLimit ?? previous.discountLimit,
      recordedPaymentNotice: input.recordedPaymentNotice ?? previous.recordedPaymentNotice,
    };
    const store = (key: string, field: keyof typeof next) => {
      const value = JSON.stringify(next[field]);
      ctx.write(
        ctx.db
          .insertInto("core_settings")
          .values({ key, value, updated_at: ctx.now, updated_by: ctx.user.id })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
          ),
      );
      ctx.recordChange({
        object: "settings",
        id: key,
        action: "update",
        before: { [field]: previous[field] },
        after: { [field]: next[field] },
      });
    };
    if (input.currency !== undefined) store(ORDER_CURRENCY_SETTING, "currency");
    if (input.expiryMinutes !== undefined) store(ORDER_EXPIRY_SETTING, "expiryMinutes");
    if (input.minPartPayment !== undefined) store(ORDER_MIN_PART_SETTING, "minPartPayment");
    if (input.returnOrigins !== undefined) store(ORDER_RETURN_ORIGINS_SETTING, "returnOrigins");
    if (input.tax !== undefined) store(ORDER_TAX_SETTING, "tax");
    if (input.taxCodes !== undefined) store(ORDER_TAX_CODES_SETTING, "taxCodes");
    if (input.discountLimit !== undefined) store(ORDER_DISCOUNT_LIMIT_SETTING, "discountLimit");
    if (input.recordedPaymentNotice !== undefined) {
      store(ORDER_RECORDED_NOTICE_SETTING, "recordedPaymentNotice");
    }
    return { ...next, previous };
  },
});

// --- A record made with its order (ADR 0560) ------------------------------------------------------

export const orderStartHeld = defineOperation({
  name: "order.startHeld",
  description:
    "From a pack's tool: make a record that is bought when it is made (a drop-in booking for a " +
    "class) and start its order, in one step. The record is held for the order (a place in the " +
    "class) while it is unpaid, and the host prices it: a caller never sends a price. Paying on " +
    "the provider's page (order.checkout) moves it on; the order expiring unpaid releases it. " +
    "`values` are the record's fields a customer may set (its class); whose it is is the caller, " +
    "or with forPersonId a child staff linked to them. A guest gives their email address and is " +
    "matched to no one until the payment is verified (the answer is the same whatever it matches). The " +
    "record's own rules apply as for the caller's own booking (when booking opens and closes, " +
    "booked by staff only, places left, one per person). Returns the order; a guest also gets " +
    "`token`, shown once.",
  input: z.object({
    object: z
      .string()
      .min(1)
      .max(80)
      .describe("The object to make a record of, e.g. bookings.booking"),
    values: z
      .record(z.string().max(80), z.unknown())
      .default({})
      .describe("The record's fields a customer may set, e.g. { class: <id> }"),
    forPersonId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A child linked to the signed-in customer to make it for (ADR 0540)"),
    email: z
      .string()
      .trim()
      .max(320)
      .optional()
      .describe("The buyer's address: required for a guest; a signed-in customer passes none"),
    agreements: guestAcceptancesSchema.optional(),
  }),
  output: orderSchema.extend({
    recordId: z.string().describe("The record made and held for the order"),
    token: z.string().nullable().describe("A guest's key to this order. Null for everyone else."),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  toolOnly: true,
  mcp: { expose: false },
  redact: ["agreements"],
  auditSummary: (output) => ({ id: output.id, recordId: output.recordId }),
  async handler(input, ctx) {
    const started = await startHeld(ctx, input);
    return {
      ...fromRow(started.row, started.lines.map(toLine), isStaff(ctx)),
      recordId: started.recordId,
      token: started.token,
    };
  },
});

export const orderReleaseUnsettled = defineOperation({
  name: "order.releaseUnsettled",
  description:
    "Platform use only (the minute cron): release one paid guest drop-in still held for no one " +
    "(an address several People share, not settled by staff) once booking for it has closed: " +
    "its place goes back and its refund is owed, for a person to approve. One record per call.",
  input: z.object({ object: z.string().min(1).max(80), recordId: z.string().min(1).max(64) }),
  output: z.object({ released: z.boolean() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return { released: await releaseUnsettledGuest(ctx, input.object, input.recordId) };
  },
});

export const orderRefundDue = defineOperation({
  name: "order.refundDue",
  description:
    "Platform use only (the minute cron): ask for a refund the host owes, recorded when a record " +
    "bought with its order (a drop-in booking) was cancelled in time or by the gym. Asks as " +
    "order.refund does: nothing is sent; each refund waits in the Approvals inbox for a person " +
    "with the refund permission (an AI can never approve one).",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({
    state: z.enum(["asked", "skipped"]),
    refunds: z.array(
      z.object({
        id: z.string(),
        paymentRef: z.string(),
        amount: z.number(),
        pendingActionId: z.string().nullable(),
      }),
    ),
    note: z.string().nullable(),
  }),
  permission: "orders:refund",
  // As order.refund: the refund is the gatekeeper's outbound action, reviewed on its own, always.
  risk: "outbound",
  bookkeeping: true,
  actors: ["automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return requestDueRefund(ctx, input.id);
  },
});

export const orderOperations = [
  orderStart,
  orderStartHeld,
  orderRefundDue,
  orderReleaseUnsettled,
  orderGet,
  orderList,
  orderView,
  orderCancel,
  orderExtendBalanceDue,
  orderSetPerson,
  orderOverdue,
  orderCheckout,
  orderApplyPaymentEvent,
  orderExpireDue,
  orderPaidLate,
  orderHonourLate,
  orderRefund,
  orderPayments,
  orderRecordPayment,
  orderReversePayment,
  orderRecordRefund,
  orderAdjust,
  orderUnadjust,
  orderSettingsGet,
  orderSettingsUpdate,
] as const;
