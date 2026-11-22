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
//   order.startHeld        a pack's tool: staff, customers, the public   a record made with its order
//   order.applyPaymentEvent, order.expireDue, order.refundDue the host's own (actor automation)
//   order.settings.*       staff; changed by a human admin only
//
// No operation here takes a price, a total or an amount paid, and none makes an order paid: that
// is `applyVerifiedPayment` (orders/payments.ts), which is not an operation.
//
// order.start, order.view, order.cancel and order.checkout are `hostInternal` (ADR 0428): the host itself starts
// and changes the order for a caller outside the org, so they keep the database. They touch only
// the order they made or the one the caller proved is theirs (their own Person through the seam,
// or the order's token), and answer only with what a customer may read of an order.
import { z } from "zod";
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
import { movesFollowPerson, releaseUnsettledGuests, startHeld } from "../orders/moves.ts";
import {
  changeOrder,
  createOrder,
  loadOrderRow,
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  type OrderRow,
  overdueOrders,
  type PricedLine,
  requireState,
} from "../orders/orders.ts";
import { requestDueRefund } from "../orders/refund-due.ts";
import { refundablePayments, requestRefund } from "../orders/refunds.ts";
import {
  currencySchema,
  loadMinPartPayment,
  loadOrderCurrency,
  loadOrderExpiryMinutes,
  loadOrderTax,
  loadOrderTaxCodes,
  loadReturnOrigins,
  minPartPaymentSchema,
  ORDER_CURRENCY_SETTING,
  ORDER_EXPIRY_SETTING,
  ORDER_MIN_PART_SETTING,
  ORDER_RETURN_ORIGINS_SETTING,
  ORDER_TAX_CODES_SETTING,
  ORDER_TAX_SETTING,
  orderExpiryMinutesSchema,
  returnOriginsSchema,
  taxCodesSchema,
} from "../orders/settings.ts";
import { taxCodeOf } from "../orders/tax.ts";
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
  lines: z.array(lineSchema),
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
  }));
}

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
    })),
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
});

export const orderStart = defineOperation({
  name: "order.start",
  description:
    "Start an order for one or more records that are for sale, as a signed-in customer, a guest " +
    "(with an email address) or staff. The host prices it from the records: a caller never " +
    "sends a price or a total. The order starts pending and is not paid: paying happens on the " +
    "payment provider's page (order.checkout), and only the provider's confirmation marks it " +
    "paid. An unpaid order expires after a few minutes. Returns the order with its lines and " +
    "amounts in the currency's minor unit; a guest also gets `token`, shown once, which is the " +
    "only way back to the order (order.view).",
  input: orderStartInput,
  output: orderSchema.extend({
    token: z.string().nullable().describe("A guest's key to this order. Null for everyone else."),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
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
      placedAs: caller.kind,
      pay: input.pay,
      accessHash: token ? await hashOrderToken(token) : null,
    });
    return { ...fromRow(started.row, started.lines.map(toLine), isStaff(ctx)), token };
  },
});

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
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
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
    const expired = await expireDueOrders(ctx, input.limit);
    // Paid guest drop-ins nobody said whose by the time booking closed (ADR 0560): released and
    // owed back. Logged and left for the next tick if it fails, never failing the expiry.
    try {
      await releaseUnsettledGuests(ctx);
    } catch (error) {
      console.error("order.expireDue: unsettled guest drop-ins not released", error);
    }
    return { expired };
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
    "An order's money in detail, for staff: each checkout opened, each verified payment (applied, " +
    "late or not matching) and each refund (asked for or confirmed), with what can still be " +
    "refunded per payment. Amounts are in the currency's minor unit. Read-only.",
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
      }),
    ),
    refundable: z.array(
      z.object({ paymentRef: z.string(), paid: z.number(), refundable: z.number() }),
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
      })),
      refundable: refundable.map((r) => ({
        paymentRef: r.paymentRef,
        paid: r.paid,
        refundable: r.refundable,
      })),
    };
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
});

async function loadSettings(ctx: HandlerContext) {
  return {
    currency: await loadOrderCurrency(ctx.db),
    expiryMinutes: await loadOrderExpiryMinutes(ctx.db),
    minPartPayment: await loadMinPartPayment(ctx.db),
    returnOrigins: await loadReturnOrigins(ctx.db),
    tax: await loadOrderTax(ctx.db),
    taxCodes: await loadOrderTaxCodes(ctx.db),
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
    "the payment provider calculates tax at checkout, or the product tax code of an object for " +
    "sale. Only what you pass changes. Orders already started keep the currency they were " +
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
  }),
  output: orderSettings.extend({ previous: orderSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationError(
        "Pass currency, expiryMinutes, minPartPayment, returnOrigins, tax or taxCodes",
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
  orderSettingsGet,
  orderSettingsUpdate,
] as const;
