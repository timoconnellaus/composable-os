// Orders (stage 25, ADR 0427): the host's own code for starting an order and for every change to
// one. An order is priced here, from the records being bought, and moved here, through the
// transition engine. The order.* operations and the payment code call these functions; nothing
// else writes core_order.
//
// What a caller can and cannot decide:
//   - a caller names records and quantities, and whether to pay in full or by deposit;
//   - the host reads every price, the deposit and the balance's due date from the records, and
//     works out the total. No function here takes an amount from a caller for a new order;
//   - a move to `paid`, `part_paid`, `expired` or `refunded` is a `host` move (fields/order.ts):
//     only platform code passes `by: "host"`, and no operation takes the mover from its input.
import type { CoreDatabase, CoreOrderTable } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { type OrderState, orderObject } from "../fields/order.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { applyTransition } from "../records/lifecycle.ts";
import type { Mover } from "../records/transitions.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { claimOrderPlaces } from "./holds.ts";
import { type Sellable, sellableOf, sellableProblems } from "./sellable.ts";
import {
  currencyDecimals,
  loadOrderCurrency,
  loadOrderExpiryMinutes,
  toMinorUnits,
} from "./settings.ts";

export type OrderRow = Selectable<CoreOrderTable>;

/** The most lines one order may have. */
export const ORDER_MAX_LINES = 50;
/** The most of one record an order line may ask for. Stage 27's `maxPerOrder` narrows it. */
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
  total: number;
  /** Deposit for one unit and when the balance is due, when the record offers a deposit. */
  deposit: { amount: number; balanceDueAt: string } | null;
}

/** Why a line cannot be bought. A caller outside the org sees the rule, not the record. */
export type LineRule =
  | "not_for_sale"
  | "no_price"
  | "currency"
  | "duplicate_line"
  | "deposit_not_offered";

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
 * Reads what `lines` cost, from the records, as the host. Refuses a record that is not for sale
 * (its object is not sellable, or it does not exist or is in the Trash: one answer for all
 * three), one with no price, and one priced in another currency.
 */
export async function priceLines(
  db: Kysely<CoreDatabase>,
  lines: readonly LineRequest[],
  currency: string,
): Promise<PricedLine[]> {
  // The host's own read, org-wide: a guest cannot see a ticket type through the seam, and the
  // price is the host's to read whoever is buying.
  const reader = orgReader(db);
  const seen = new Set<string>();
  const priced: PricedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const key = `${line.object}\u0000${line.id}`;
    if (seen.has(key)) {
      refuseLine("duplicate_line", index, "The same item is on the order twice: use a quantity");
    }
    seen.add(key);
    const object = getObject(line.object);
    const sellable: Sellable | undefined = object ? sellableOf(object.name) : undefined;
    if (!object || !sellable || sellableProblems(sellable, object).length) {
      refuseLine("not_for_sale", index, "This cannot be bought");
    }
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const row = (await (db as any)
      .selectFrom(visibleSource(reader, object))
      .selectAll()
      .where("id", "=", line.id)
      .executeTakeFirst()) as AnyRow | undefined;
    if (!row) refuseLine("not_for_sale", index, "This cannot be bought");
    const field = (name: string) => object.fields.find((f) => f.name === name);
    const read = (name: string) => {
      const col = column(field(name));
      return col ? (row[col] ?? null) : null;
    };
    const priceField = field(sellable.price);
    const pricedIn = priceField?.options?.currency;
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
    let deposit: PricedLine["deposit"] = null;
    if (sellable.deposit) {
      const amount = toMinorUnits(read(sellable.deposit.amount), currency);
      const balanceDueAt = dueMoment(read(sellable.deposit.balanceDue));
      if (amount !== null && amount > 0 && balanceDueAt) deposit = { amount, balanceDueAt };
    }
    const title = object.titleField ? read(object.titleField) : null;
    priced.push({
      id: newId("orderLine"),
      position: index,
      object: object.name,
      recordId: line.id,
      title: title == null || title === "" ? object.label : String(title),
      quantity: line.quantity,
      unitPrice,
      total: unitPrice * line.quantity,
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
  const lines = await priceLines(ctx.db, input.lines, currency);
  const total = lines.reduce((sum, line) => sum + line.total, 0);
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

  const minutes = await loadOrderExpiryMinutes(ctx.db);
  const id = newId("order");
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
    paid_at: null,
    cancelled_at: null,
    refunded_at: null,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: 0,
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
        created_at: ctx.now,
      }),
    ),
    ...outcome.history,
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
export async function changeOrder(
  ctx: HandlerContext,
  row: OrderRow,
  to: OrderState,
  change: OrderChange,
  by: Mover,
): Promise<OrderRow> {
  const before = orderSnapshot(row);
  const next: OrderRow = {
    ...row,
    ...change,
    state: to,
    updated_at: ctx.now,
    version: row.version + 1,
    // A guest's link outlives the order's closing by a while, then stops.
    access_until: CLOSED.has(to)
      ? new Date(Date.parse(ctx.now) + ORDER_ACCESS_DAYS_AFTER_CLOSE * 86_400_000).toISOString()
      : null,
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
 * - Part paid: the balance, or a part of it the buyer names, at least `minPart` (or the balance,
 *   when less is owed) and never more than the balance.
 * - Any other state: nothing.
 */
export function chargeFor(row: OrderRow, minPart: number, amount?: number): Charge {
  const refuse = (message: string, rule: string, extra?: object): never => {
    throw new ValidationError(message, { rule, order: row.id, ...extra });
  };
  if (row.state === "pending") {
    const due = row.pay === "deposit" ? (row.deposit as number) : row.total;
    if (amount !== undefined && amount !== due) {
      refuse("The first payment on an order is not the buyer's to choose", "charge_amount", {
        due,
      });
    }
    return {
      amount: due,
      currency: row.currency,
      kind: row.pay === "deposit" ? "deposit" : "full",
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
