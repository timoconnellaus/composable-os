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
//   order.settings.*       staff; changed by a human admin only
//
// No operation here takes a price, a total or an amount paid, and none makes an order paid: that
// is `applyVerifiedPayment` (orders/payments.ts), which is not an operation.
//
// order.start, order.view and order.cancel are `hostInternal` (ADR 0428): the host itself starts
// and changes the order for a caller outside the org, so they keep the database. They touch only
// the order they made or the one the caller proved is theirs (their own Person through the seam,
// or the order's token), and answer only with what a customer may read of an order.
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { ORDER_STATES } from "../fields/order.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  hashOrderToken,
  newOrderToken,
  ORDER_TOKEN,
  orderForToken,
  resolveBuyer,
} from "../orders/guests.ts";
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
import {
  currencySchema,
  loadMinPartPayment,
  loadOrderCurrency,
  loadOrderExpiryMinutes,
  minPartPaymentSchema,
  ORDER_CURRENCY_SETTING,
  ORDER_EXPIRY_SETTING,
  ORDER_MIN_PART_SETTING,
  orderExpiryMinutesSchema,
} from "../orders/settings.ts";
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
  pay: z.enum(["full", "deposit"]),
  deposit: z.number().nullable(),
  balanceDueAt: when,
  expiresAt: when,
  paidAt: when,
  createdAt: z.string(),
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
    pay: row.pay,
    deposit: row.deposit,
    balanceDueAt: row.balance_due_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
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
    pay: v.pay,
    deposit: v.deposit ?? null,
    balanceDueAt: text(v.balanceDueAt),
    expiresAt: text(v.expiresAt),
    paidAt: text(v.paidAt),
    createdAt: String(v.createdAt),
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
    pay: v.pay,
    deposit: v.deposit ?? null,
    balanceDueAt: text(v.balanceDueAt),
    expiresAt: text(v.expiresAt),
    paidAt: text(v.paidAt),
    createdAt: String(v.createdAt),
    lines: page.items.map((line) => ({
      id: line.id,
      position: line.values.position,
      object: line.values.object,
      recordId: line.values.recordId,
      title: line.values.title,
      quantity: line.values.quantity,
      unitPrice: line.values.unitPrice,
      total: line.values.total,
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
});

async function loadSettings(ctx: HandlerContext) {
  return {
    currency: await loadOrderCurrency(ctx.db),
    expiryMinutes: await loadOrderExpiryMinutes(ctx.db),
    minPartPayment: await loadMinPartPayment(ctx.db),
  };
}

export const orderSettingsGet = defineOperation({
  name: "order.settings.get",
  description:
    "Get the order settings: the deployment's currency, how long an unpaid order lasts, and the " +
    "least a buyer may pay towards a balance. Read-only.",
  input: z.object({}),
  output: orderSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return loadSettings(ctx);
  },
});

export const orderSettingsUpdate = defineOperation({
  name: "order.settings.update",
  description:
    "Change the order settings: the currency every order is in, the minutes an unpaid order " +
    "lasts, or the least part payment. Only what you pass changes. Orders already started keep " +
    "the currency they were started in. Admins only, and only a human can call it: AI " +
    "assistants, MCP clients, automations and extensions are refused.",
  input: z.object({
    currency: currencySchema.optional(),
    expiryMinutes: orderExpiryMinutesSchema.optional(),
    minPartPayment: minPartPaymentSchema.optional(),
  }),
  output: orderSettings.extend({ previous: orderSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationError("Pass currency, expiryMinutes or minPartPayment");
    }
    const previous = await loadSettings(ctx);
    const next = {
      currency: input.currency ?? previous.currency,
      expiryMinutes: input.expiryMinutes ?? previous.expiryMinutes,
      minPartPayment: input.minPartPayment ?? previous.minPartPayment,
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
    return { ...next, previous };
  },
});

export const orderOperations = [
  orderStart,
  orderGet,
  orderList,
  orderView,
  orderCancel,
  orderExtendBalanceDue,
  orderSetPerson,
  orderOverdue,
  orderSettingsGet,
  orderSettingsUpdate,
] as const;
