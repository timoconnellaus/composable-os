// Orders (stage 25, ADR 0427): the host's own code for starting an order and for every change to
// one. An order is priced here, from the records being bought, and moved here, through the
// transition engine. The order.* operations and the payment code call these functions; nothing
// else writes core_order.
//
// What a caller can and cannot decide:
//   - a caller names records and quantities, and whether to pay in full or by deposit;
//   - the host reads every price, the deposit and the balance's due date from the records, and
//     works out the total. No function here takes an amount from a caller for a new order;
//   - money off is an adjustment (ADR 0690): the total is what is owed after the adjustments,
//     priced through the seam (`priceLines`, then `applyAdjustments`), never sent by a caller;
//   - a move to `paid`, `part_paid`, `expired` or `refunded` is a `host` move (fields/order.ts):
//     only platform code passes `by: "host"`, and no operation takes the mover from its input.
import type { CoreDatabase, CoreOrderTable } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import {
  enforcePurchase,
  type GuestAcceptance,
  guestMinorNotice,
  pointsOfObjects,
} from "../agreements/enforce.ts";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { type OrderState, orderObject } from "../fields/order.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import type { Principal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { applyTransition } from "../records/lifecycle.ts";
import { callerOf, type Mover } from "../records/transitions.ts";
import {
  type AnyRow,
  buyableSource,
  orgReader,
  type VisibleSource,
  visibleSource,
} from "../visibility/index.ts";
import { applyAdjustments } from "./adjustments.ts";
import { claimOrderPlaces } from "./holds.ts";
import { holdOncePerPerson } from "./once.ts";
import {
  GRANTS_PER_ORDER_CEILING,
  lineLimit,
  type Sellable,
  sellableOf,
  sellableProblems,
} from "./sellable.ts";
import {
  currencyDecimals,
  loadOrderCurrency,
  loadOrderExpiryMinutes,
  toMinorUnits,
} from "./settings.ts";

export type OrderRow = Selectable<CoreOrderTable>;

/** The most lines one order may have. */
export const ORDER_MAX_LINES = 50;
/** The most of one record an order line may ask for. A sellable's `maxPerOrder` narrows it. */
export const ORDER_MAX_QUANTITY = 1000;
/** How long a guest's link shows an order after it closes (paid, cancelled, expired, refunded). */
export const ORDER_ACCESS_DAYS_AFTER_CLOSE = 30;

const CLOSED: ReadonlySet<OrderState> = new Set(["paid", "cancelled", "expired", "refunded"]);

const order = (): ObjectDefinition => getObject("order") ?? orderObject;

/** An order as the audit log and the transition engine see it: registry field names. */
export function orderSnapshot(row: OrderRow): Record<string, unknown> {
  return {
    personId: row.person_id,
    email: row.email,
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
    placedAs: row.placed_as,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    refundedAt: row.refunded_at,
    taxAmount: row.tax_amount,
    taxRefunded: row.tax_refunded,
    taxCountry: row.tax_country,
    discount: row.discount,
  };
}

/**
 * The order as platform code is about to change it: the table's row, read org-wide. Never
 * returned to a caller: operations answer with what the seam shows (operations/order.ts).
 */
export async function loadOrderRow(db: Kysely<CoreDatabase>, id: string): Promise<OrderRow> {
  const row = await db.selectFrom("core_order").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new NotFoundError("order", id);
  return row;
}

// --- Pricing -----------------------------------------------------------------------------------

/** One line a caller asks for. There is no price here, and nowhere to put one. */
export interface LineRequest {
  object: string;
  id: string;
  quantity: number;
}

export interface PricedLine {
  id: string;
  position: number;
  object: string;
  recordId: string;
  title: string;
  quantity: number;
  unitPrice: number;
  /** What the line costs before adjustments: `unitPrice * quantity`. */
  total: number;
  /** The line's share of the order's adjustments (ADR 0690); it costs `total - discount`. */
  discount: number;
  /** Deposit for one unit and when the balance is due, when the record offers a deposit. */
  deposit: { amount: number; balanceDueAt: string } | null;
  /** A plan's period and trial (ADR 0485): only when priced as a plan. */
  recurring?: { interval: "week" | "month" | "year"; trialDays: number | null };
  /** Sold once per Person (ADR 0512): the record's `onePerPerson` field is on. */
  once?: boolean;
}

/** Why a line cannot be bought. A caller outside the org sees the rule, not the record. */
export type LineRule =
  | "not_for_sale"
  | "no_price"
  | "currency"
  | "duplicate_line"
  | "deposit_not_offered"
  | "sale_window"
  | "max_per_order";

function refuseLine(rule: LineRule, line: number, message: string, extra?: object): never {
  throw new ValidationError(message, { rule, line, ...extra });
}

const column = (field: FieldDefinition | undefined) => (field ? viewColumnOf(field) : null);

/** A date or datetime field's value as the moment a balance falls due (a date: its last instant). */
function dueMoment(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * A sale window's end as a moment: a datetime as it is; a date from the start of its day
 * (`start`) or through its end (`end`), in UTC. Null when empty.
 */
function windowMoment(value: unknown, end: "start" | "end"): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}${end === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`
    : value;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * Reads what `lines` cost, from the records, as the host. Refuses a record that is not for sale
 * (its object is not sellable, or it does not exist or is in the Trash: one answer for all
 * three), one with no price, one priced in another currency, one outside its sale window and a
 * quantity over the record's most per order (ADR 0435). A customer or the public buys only what
 * they may read (ADR 0438): a record the seam does not show `buyer` gets the same answer.
 */
/**
 * Whether `principal` may buy the record: read it through the seam as their own or as the
 * public. Not what they read only through their own records (ADR 0439): a ticket type of an
 * event that is no longer on sale stays readable to its holder and cannot be bought.
 */
async function readable(
  db: Kysely<CoreDatabase>,
  principal: Principal,
  object: ObjectDefinition,
  id: string,
): Promise<boolean> {
  let source: VisibleSource<AnyRow, string>;
  try {
    source = buyableSource({ principal }, object);
  } catch {
    return false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = await (db as any)
    .selectFrom(source)
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  return Boolean(row);
}

export async function priceLines(
  db: Kysely<CoreDatabase>,
  lines: readonly LineRequest[],
  currency: string,
  now: string = new Date().toISOString(),
  buyer?: Principal,
  /** `plans`: price recurring plans (subscription.start, ADR 0485) instead of things to buy. */
  options: { plans?: boolean } = {},
): Promise<PricedLine[]> {
  // The host's own read, org-wide: a guest cannot see a ticket type through the seam, and the
  // price is the host's to read whoever is buying.
  const reader = orgReader(db);
  const seen = new Set<string>();
  const priced: PricedLine[] = [];
  /** Units on the lines so far whose objects grant something. */
  let granting = 0;
  for (const [index, line] of lines.entries()) {
    const key = `${line.object}\u0000${line.id}`;
    if (seen.has(key)) {
      refuseLine("duplicate_line", index, "The same item is on the order twice: use a quantity");
    }
    seen.add(key);
    const object = getObject(line.object);
    const sellable: Sellable | undefined = object ? sellableOf(object) : undefined;
    if (!object || !sellable || sellableProblems(sellable, object).length) {
      refuseLine("not_for_sale", index, "This cannot be bought");
    }
    // A record an order moves (ADR 0560) is made with its order (order.startHeld), never put on
    // another: a second order would pay for one held place twice.
    if (sellable.moves) {
      refuseLine("not_for_sale", index, "This is bought when it is made, not added to an order");
    }
    // A plan is subscribed to (subscription.start), never put on an order (ADR 0485); and only a
    // plan is subscribed to.
    if (Boolean(sellable.recurring) !== Boolean(options.plans)) {
      refuseLine(
        "not_for_sale",
        index,
        sellable.recurring ? "This is a plan: subscribe to it instead" : "This is not a plan",
      );
    }
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const row = (await (db as any)
      .selectFrom(visibleSource(reader, object))
      .selectAll()
      .where("id", "=", line.id)
      .executeTakeFirst()) as AnyRow | undefined;
    if (!row) refuseLine("not_for_sale", index, "This cannot be bought");
    if (buyer && buyer.kind !== "staff" && !(await readable(db, buyer, object, line.id))) {
      refuseLine("not_for_sale", index, "This cannot be bought");
    }
    const field = (name: string) => object.fields.find((f) => f.name === name);
    const read = (name: string) => {
      const col = column(field(name));
      return col ? (row[col] ?? null) : null;
    };
    const pricedIn = sellable.currency ?? field(sellable.price)?.options?.currency;
    if (pricedIn && pricedIn.toUpperCase() !== currency) {
      refuseLine(
        "currency",
        index,
        `This is priced in ${pricedIn}, and orders are in ${currency}`,
        {
          currency: pricedIn,
        },
      );
    }
    const unitPrice = toMinorUnits(read(sellable.price), currency);
    if (unitPrice === null) refuseLine("no_price", index, "This has no price yet");
    // The sale window and the most one order may hold (ADR 0435): the record's own fields.
    if (sellable.saleWindow) {
      const from = windowMoment(read(sellable.saleWindow.from ?? ""), "start");
      const until = windowMoment(read(sellable.saleWindow.until ?? ""), "end");
      if ((from && now < from) || (until && now > until)) {
        refuseLine(
          "sale_window",
          index,
          from && now < from ? "This is not on sale yet" : "This is no longer on sale",
          { from, until },
        );
      }
    }
    const own = sellable.maxPerOrder ? read(sellable.maxPerOrder) : null;
    const max = lineLimit(sellable, typeof own === "number" && Number.isFinite(own) ? own : null);
    if (max !== null && line.quantity > max) {
      refuseLine("max_per_order", index, `At most ${max} of this on one order`, {
        max,
        asked: line.quantity,
      });
    }
    // Everything granted is made in the paid batch, which has a size (GRANTS_PER_ORDER_CEILING).
    if (sellable.grants) {
      if (granting + line.quantity > GRANTS_PER_ORDER_CEILING) {
        refuseLine(
          "max_per_order",
          index,
          `At most ${GRANTS_PER_ORDER_CEILING} tickets or other grants on one order`,
          {
            max: GRANTS_PER_ORDER_CEILING - granting,
            asked: line.quantity,
            ceiling: GRANTS_PER_ORDER_CEILING,
          },
        );
      }
      granting += line.quantity;
    }
    let deposit: PricedLine["deposit"] = null;
    if (sellable.deposit) {
      const amount = toMinorUnits(read(sellable.deposit.amount), currency);
      const balanceDueAt = dueMoment(read(sellable.deposit.balanceDue));
      if (amount !== null && amount > 0 && balanceDueAt) deposit = { amount, balanceDueAt };
    }
    const title = object.titleField ? read(object.titleField) : null;
    const trial = sellable.recurring?.trialDays ? read(sellable.recurring.trialDays) : null;
    const onceFlag = sellable.onePerPerson ? read(sellable.onePerPerson) : null;
    priced.push({
      ...(onceFlag === 1 || onceFlag === true ? { once: true } : {}),
      ...(sellable.recurring
        ? {
            recurring: {
              interval: sellable.recurring.interval,
              trialDays:
                typeof trial === "number" && Number.isInteger(trial) && trial > 0 ? trial : null,
            },
          }
        : {}),
      id: newId("orderLine"),
      position: index,
      object: object.name,
      recordId: line.id,
      title: title == null || title === "" ? object.label : String(title),
      quantity: line.quantity,
      unitPrice,
      total: unitPrice * line.quantity,
      discount: 0,
      deposit,
    });
  }
  return priced;
}

// --- Starting an order -------------------------------------------------------------------------

export interface NewOrder {
  lines: readonly LineRequest[];
  /** Whose order it is; null when the address matched several people. */
  personId: string | null;
  /** The address it is placed with, normalised. */
  email: string;
  placedAs: "customer" | "public" | "staff";
  pay: "full" | "deposit";
  /** SHA-256 of the token a guest is given for this one order. */
  accessHash?: string | null;
  /**
   * Platform code only (`order.startHeld`, ADR 0560): the order's id, and its lines as the host
   * priced them for a record made in this same batch, which `priceLines` cannot read yet. No
   * operation takes either from its input.
   */
  id?: string;
  priced?: readonly PricedLine[];
  /**
   * Who it is for, when not the order's Person (stage 44 step 3): a drop-in a guardian buys for a
   * dependant (`order.startHeld`). Left out, the order's Person.
   */
  participantId?: string | null;
  /** A visitor's acceptances, carried in the buying call (only `placedAs: "public"`). */
  agreements?: readonly GuestAcceptance[] | undefined;
}

export interface StartedOrder {
  row: OrderRow;
  lines: PricedLine[];
}

/**
 * Queues the writes that start an order, priced by the host, in the calling operation's batch:
 * the order in `pending`, its lines, and its first history row. Refuses when no currency is set,
 * a line cannot be bought, the total is nothing, or a deposit is asked for and not offered.
 */
export async function createOrder(ctx: HandlerContext, input: NewOrder): Promise<StartedOrder> {
  if (!input.lines.length) throw new ValidationError("An order needs at least one line");
  if (input.lines.length > ORDER_MAX_LINES) {
    throw new ValidationError(`An order has at most ${ORDER_MAX_LINES} lines`);
  }
  for (const [index, line] of input.lines.entries()) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > ORDER_MAX_QUANTITY
    ) {
      throw new ValidationError("A quantity is a whole number, at least 1", { line: index });
    }
  }
  const currency = await loadOrderCurrency(ctx.db);
  if (!currency) {
    throw new ConfigError("No currency is set for orders yet, so nothing can be sold");
  }
  const priced = input.priced
    ? [...input.priced]
    : await priceLines(ctx.db, input.lines, currency, ctx.now, callerOf(ctx));
  // The seam's adjustment stage (ADR 0690): nothing is taken off an order as it starts yet (a
  // code or a member's price joins here with the discount behaviour); staff take money off a
  // pending order afterwards (orders/staff-discounts.ts), through the same function.
  const adjusted = applyAdjustments(priced, []);
  const lines = priced.map((line, i) => ({ ...line, discount: adjusted.discounts[i] ?? 0 }));
  const total = adjusted.total;
  if (total <= 0) {
    throw new ValidationError("An order with nothing to pay cannot be started", { rule: "total" });
  }

  let deposit: number | null = null;
  let balanceDueAt: string | null = null;
  if (input.pay === "deposit") {
    for (const line of lines) {
      if (!line.deposit) {
        refuseLine("deposit_not_offered", line.position, "This cannot be paid by deposit");
      }
    }
    const offered = lines.map((line) => line.deposit as NonNullable<PricedLine["deposit"]>);
    deposit = lines.reduce((sum, line, i) => sum + (offered[i]?.amount ?? 0) * line.quantity, 0);
    // The earliest date any line gives: every item is paid for by the time its own is due.
    balanceDueAt = offered.map((d) => d.balanceDueAt).sort()[0] as string;
    if (deposit >= total) {
      throw new ValidationError("The deposit is the whole price: pay in full", {
        rule: "deposit_not_offered",
      });
    }
    if (balanceDueAt <= ctx.now) {
      throw new ValidationError("The balance was due before today: pay in full", {
        rule: "deposit_not_offered",
      });
    }
  }

  const id = input.id ?? newId("order");
  // Nobody pays without the agreements they need (stage 44 step 3, ADR 0644): asked at the points
  // the bought objects declare, before anything is written, with the guard in this batch. A
  // visitor's acceptances in the call are checked now and recorded after the order (below).
  const agreed = await enforcePurchase(
    ctx,
    pointsOfObjects(lines.map((line) => line.object)),
    {
      guest: input.placedAs === "public",
      participant: input.participantId === undefined ? input.personId : input.participantId,
      payer: input.personId,
    },
    input.agreements,
  );
  const guestRows = await agreed.guestRows({ orderId: id, email: input.email });

  const minutes = await loadOrderExpiryMinutes(ctx.db);
  const row: OrderRow = {
    id,
    person_id: input.personId,
    email: input.email,
    currency,
    total,
    paid: 0,
    state: "pending",
    pay: input.pay,
    deposit,
    balance_due_at: balanceDueAt,
    expires_at: new Date(Date.parse(ctx.now) + minutes * 60_000).toISOString(),
    placed_as: input.placedAs,
    provider: null,
    provider_ref: null,
    access_hash: input.accessHash ?? null,
    access_until: null,
    email_link_hash: null,
    refunded: 0,
    tax_amount: 0,
    tax_refunded: 0,
    tax_country: null,
    subscription_id: null,
    period_start: null,
    period_end: null,
    invoice_ref: null,
    period_flag: null,
    provider_paid_at: null,
    paid_at: null,
    cancelled_at: null,
    refunded_at: null,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: 0,
    discount: adjusted.discount,
  };
  // The host creates the order: its first history row is the host's, whoever is buying.
  const outcome = await applyTransition(
    ctx,
    order(),
    id,
    null,
    { state: "pending" },
    { by: "host" },
  );

  // The one place an order takes places (stage 26, ADR 0432): a line whose record has a capacity
  // holds its quantity, in this batch. A refused claim fails the batch, so no order exists.
  // Confirming and releasing are the move hook's (orders/holds.ts).
  await claimOrderPlaces(ctx, id, lines);

  ctx.write(
    ctx.db.insertInto("core_order").values(row),
    ...lines.map((line) =>
      ctx.db.insertInto("core_order_line").values({
        id: line.id,
        order_id: id,
        position: line.position,
        object_type: line.object,
        record_id: line.recordId,
        title: line.title,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        line_total: line.total,
        line_discount: line.discount,
        created_at: ctx.now,
      }),
    ),
    ...outcome.history,
    ...agreed.guards,
    // After the order: a guest's acceptance names an order that must exist (migration 0851).
    ...guestRows,
  );
  // One per Person (ADR 0512): refused, or held in this batch, after the order it names.
  await holdOncePerPerson(
    ctx,
    id,
    lines
      .filter((line) => line.once)
      .map((line) => ({
        object: line.object,
        recordId: line.recordId,
        quantity: line.quantity,
        position: line.position,
      })),
    { personId: input.personId, placedAs: input.placedAs },
  );
  recordHostChange(ctx, { object: "order", id, action: "create", after: orderSnapshot(row) });
  postOrderMove(ctx, row, null);
  return { row, lines };
}

// --- Changing an order -------------------------------------------------------------------------

/** Columns platform code may set when it changes an order. Never the id, the lines or the total. */
export type OrderChange = Partial<
  Pick<
    OrderRow,
    | "person_id"
    | "paid"
    | "refunded"
    | "balance_due_at"
    | "provider"
    | "provider_ref"
    | "paid_at"
    | "cancelled_at"
    | "refunded_at"
    | "tax_amount"
    | "tax_refunded"
    | "tax_country"
  >
>;

/**
 * Queues one change to an order, in the calling operation's batch: the move to `to` (through the
 * transition engine, which refuses a move the machine does not declare or `by` may not make,
 * writes history and runs the move hooks) and any columns that go with it. `row` is the order as
 * just read; a write made from a read that is no longer current fails its batch (the version
 * check, migration 0421) and can be made again.
 *
 * `by` is the caller's mover for a move a person makes (`callerMover(ctx)`), and `host` only
 * from platform code that has itself established why: a verified payment, an expiry, a refund
 * the provider confirmed.
 */
export function changeOrder(
  ctx: HandlerContext,
  row: OrderRow,
  to: OrderState,
  change: OrderChange,
  by: Mover,
): Promise<OrderRow> {
  return writeOrderChange(ctx, row, to, change, by);
}

/** What a change to a pending order's adjustments sets: its total and their sum (ADR 0690). */
export type OrderPriceChange = Pick<OrderRow, "total" | "discount">;

/**
 * Queues a pending order's new price after its adjustments changed, in the calling batch, with
 * the version check and the audit row of any change. Only orders/staff-discounts.ts calls it, with
 * a total `applyAdjustments` worked out from the order's lines.
 */
export function changeOrderPrice(
  ctx: HandlerContext,
  row: OrderRow,
  change: OrderPriceChange,
  by: Mover,
): Promise<OrderRow> {
  requireState(row, ["pending"], "repriced");
  return writeOrderChange(ctx, row, row.state, change, by);
}

async function writeOrderChange(
  ctx: HandlerContext,
  row: OrderRow,
  to: OrderState,
  change: OrderChange | OrderPriceChange,
  by: Mover,
): Promise<OrderRow> {
  const before = orderSnapshot(row);
  const next: OrderRow = {
    ...row,
    ...change,
    state: to,
    updated_at: ctx.now,
    version: row.version + 1,
    // A guest's link outlives the order's closing by a while, then stops. A later change to a
    // closed order (its Person given, a refund) keeps the date it closed with.
    access_until: !CLOSED.has(to)
      ? null
      : CLOSED.has(row.state) && row.access_until
        ? row.access_until
        : new Date(Date.parse(ctx.now) + ORDER_ACCESS_DAYS_AFTER_CLOSE * 86_400_000).toISOString(),
  };
  // The engine and the move hooks see the order as this write leaves it (what is now paid).
  const outcome = await applyTransition(ctx, order(), row.id, before, orderSnapshot(next), { by });
  ctx.write(
    ctx.db
      .updateTable("core_order")
      .set({
        ...change,
        state: to,
        updated_at: next.updated_at,
        version: next.version,
        access_until: next.access_until,
      })
      .where("id", "=", row.id),
    ...outcome.history,
  );
  recordHostChange(ctx, {
    object: "order",
    id: row.id,
    action: "update",
    before,
    after: orderSnapshot(next),
  });
  if (to !== row.state) postOrderMove(ctx, next, row.state);
  // A guest's purchase landing on a minor tells staff (ADR 0644): the batch that pays it or
  // gives it its Person settles its acceptances (migration 0853).
  if (next.person_id && next.paid > 0) {
    await guestMinorNotice(ctx, { orderId: row.id }, next.person_id);
  }
  return next;
}

const MOVE_WORDS: Record<OrderState, string> = {
  pending: "started",
  part_paid: "part paid",
  paid: "paid",
  cancelled: "cancelled",
  expired: "expired",
  refunded: "refunded",
};

/** Whole and minor units, for a timeline line: `120.00 AUD`. */
export function formatMoney(amount: number, currency: string): string {
  const digits = currencyDecimals(currency);
  return `${(amount / 10 ** digits).toFixed(digits)} ${currency}`;
}

/**
 * An order's move on its Person's timeline, in the move's own batch (ADR 0429): started, part
 * paid, paid, cancelled, expired, refunded. An order that belongs to no one yet posts nothing.
 */
function postOrderMove(ctx: HandlerContext, row: OrderRow, from: OrderState | null): void {
  if (!row.person_id) return;
  const money =
    row.state === "pending"
      ? formatMoney(row.total, row.currency)
      : row.state === "refunded"
        ? formatMoney(row.refunded, row.currency)
        : `${formatMoney(row.paid, row.currency)} of ${formatMoney(row.total, row.currency)}`;
  ctx.postActivity({
    subject: `Order ${MOVE_WORDS[row.state]}: ${money}`,
    payload: {
      kind: "order.moved",
      orderId: row.id,
      from,
      to: row.state,
      total: row.total,
      paid: row.paid,
      refunded: row.refunded,
      currency: row.currency,
    },
    links: [{ object: "person", id: row.person_id }],
  });
}

// --- What a checkout may charge ----------------------------------------------------------------

export interface Charge {
  amount: number;
  currency: string;
  /** What the payment is: the whole price, the deposit, the whole balance or a part of it. */
  kind: "full" | "deposit" | "balance" | "part";
}

/**
 * What a checkout for `row` may charge (the payments gatekeeper asks before it opens the
 * provider's page, and a verified payment is checked against the same rule).
 * - Nothing paid yet: the whole price, or the deposit when the buyer chose one. No other amount.
 *   A deposit an adjustment left at or above the total (ADR 0690) is not taken: the whole price
 *   is, and the order is paid in full.
 * - Part paid: the balance, or a part of it the buyer names, at least `minPart` (or the balance,
 *   when less is owed) and never more than the balance.
 * - Any other state: nothing.
 */
export function chargeFor(row: OrderRow, minPart: number, amount?: number): Charge {
  const refuse = (message: string, rule: string, extra?: object): never => {
    throw new ValidationError(message, { rule, order: row.id, ...extra });
  };
  if (row.state === "pending") {
    const byDeposit = row.pay === "deposit" && (row.deposit as number) < row.total;
    const due = byDeposit ? (row.deposit as number) : row.total;
    if (amount !== undefined && amount !== due) {
      refuse("The first payment on an order is not the buyer's to choose", "charge_amount", {
        due,
      });
    }
    return {
      amount: due,
      currency: row.currency,
      kind: byDeposit ? "deposit" : "full",
    };
  }
  if (row.state === "part_paid") {
    const balance = row.total - row.paid;
    const least = Math.min(minPart, balance);
    const wanted = amount ?? balance;
    if (!Number.isInteger(wanted) || wanted < least || wanted > balance) {
      refuse(`A payment towards this order is between ${least} and ${balance}`, "charge_amount", {
        least,
        balance,
      });
    }
    return {
      amount: wanted,
      currency: row.currency,
      kind: wanted === balance ? "balance" : "part",
    };
  }
  return refuse("Nothing can be paid on this order", "charge_state", { state: row.state });
}

// --- Overdue balances --------------------------------------------------------------------------

/** How many overdue orders one read returns. */
export const OVERDUE_LIMIT = 200;

/**
 * Part-paid orders whose balance was due before `now`, oldest first. Nothing moves them: staff
 * extend the date, cancel, or the buyer pays. Reads core_order_balance_due_idx only.
 */
export function overdueOrders(db: Kysely<CoreDatabase>, now: string, limit = OVERDUE_LIMIT) {
  return db
    .selectFrom("core_order")
    .selectAll()
    .where("state", "=", "part_paid")
    .where("balance_due_at", "<", now)
    .orderBy("balance_due_at")
    .limit(Math.min(Math.max(limit, 1), OVERDUE_LIMIT))
    .execute();
}

/** Refuses a change to an order that is not in one of `states`. */
export function requireState(row: OrderRow, states: readonly OrderState[], what: string): void {
  if (!states.includes(row.state)) {
    throw new ConflictError(`An order that is ${row.state} cannot be ${what}`, {
      order: row.id,
      state: row.state,
    });
  }
}
