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
import {
  CODE_NOT_VALID,
  type CodeOutcome,
  type Deal,
  type DealBuyer,
  workOutDeal,
} from "../discounts/deal.ts";
import { holdDealUse } from "../discounts/uses.ts";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { invoiceObject } from "../fields/invoice.ts";
import { type OrderState, orderObject } from "../fields/order.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { mulDivHalfUp } from "../invoices/tax.ts";
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
import { type Adjusted, type AdjustmentShare, applyAdjustments } from "./adjustments.ts";
import {
  applyGoodsRules,
  type DeliveryFacts,
  type DeliveryRequest,
  type GoodsFacts,
  type GoodsOutcome,
  goodsFactsOf,
  type QuoteProblem,
} from "./goods.ts";
import { claimOrderPlaces } from "./holds.ts";
import { holdOncePerPerson } from "./once.ts";
import {
  GRANTS_PER_ORDER_CEILING,
  lineLimit,
  type Sellable,
  sellableOf,
  sellableProblems,
  viewRow,
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
    balance: row.total - row.paid - row.credited,
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
    // An invoice's order (ADR 0731): its move hook keeps the invoice's state in step.
    invoiceId: row.invoice_id,
    credited: row.credited,
  };
}

/** What is still owed on an order: its total, less what was paid and what credit notes took off. */
export function owedOn(row: Pick<OrderRow, "total" | "paid" | "credited">): number {
  return row.total - row.paid - row.credited;
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
  /** Goods (ADR 0682): where the record is sold. */
  goods?: GoodsFacts;
  /** A delivery option (ADR 0682): its kind, free over, countries and whether it is offered. */
  delivery?: DeliveryFacts;
  /**
   * An invoice's line only (ADR 0731): the tax the host worked out on the document for it (ADR
   * 0732), kept on the order's line. Every other line's tax is the provider's, at checkout.
   */
  taxAmount?: number;
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

/**
 * A date or datetime field's value as a moment: a datetime as it is; a date from the start of its
 * day (`start`) or through its end (`end`), in UTC. Null when empty. A sale window's ends, and the
 * moment a balance falls due (a date's last instant).
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
  return Boolean(await db.selectFrom(source).select("id").where("id", "=", id).executeTakeFirst());
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
    const row = await viewRow(db, visibleSource(reader, object), line.id);
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
      const balanceDueAt = windowMoment(read(sellable.deposit.balanceDue), "end");
      if (amount !== null && amount > 0 && balanceDueAt) deposit = { amount, balanceDueAt };
    }
    const title = object.titleField ? read(object.titleField) : null;
    const trial = sellable.recurring?.trialDays ? read(sellable.recurring.trialDays) : null;
    const onceFlag = sellable.onePerPerson ? read(sellable.onePerPerson) : null;
    // Goods and delivery (ADR 0682): what the record says, for the goods rules (orders/goods.ts).
    const facts =
      sellable.goods || sellable.delivery
        ? await goodsFactsOf(db, object, sellable, row, currency)
        : {};
    priced.push({
      ...facts,
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

/** An order as the seam priced it: the goods rules' outcome, its deal and what is owed. */
export interface PricedOrder extends GoodsOutcome {
  /** The one discount on the order (ADR 0693), taken off `lines` (each line's `discount`). */
  deal: Deal | null;
  /** What the code given did: nothing given, applied, beaten by a better deal, or not valid. */
  code: CodeOutcome;
  /** The lines after the deal: what each costs and what is owed. */
  adjusted: Adjusted;
}

/** The deal's shares as the seam's adjustments: one on each line it takes something off. */
export function dealShares(deal: Deal | null): AdjustmentShare[] {
  return (deal?.shares ?? []).map((share) => ({
    lineId: share.lineId,
    amount: share.amount,
    percent: deal?.percent ?? null,
  }));
}

/**
 * Prices an order as the host (ADRs 0682, 0685 and 0693): the lines, then the delivery chosen (a
 * line of quantity 1, last), then the deal (the one discount the buyer gets: an automatic one or
 * the code, the better for them), then the goods rules, which work out the channel, refuse what is
 * not sold there or cannot be delivered so, and price the postage, its free-over on the goods' net
 * after the deal. `order.start`, `order.startHeld` (its lines priced by the host, `priced`) and
 * `order.quote` all price through it, so a quote and the order it becomes agree. A code that does
 * not apply is refused (`start`) or reported (`quote`), with one answer whatever the reason: the
 * reason goes to staff only.
 */
export async function priceOrder(
  db: Kysely<CoreDatabase>,
  lines: readonly LineRequest[],
  delivery: DeliveryRequest | undefined,
  currency: string,
  now: string,
  buyer: Principal | undefined,
  mode: "start" | "quote",
  options: {
    /** What the buyer typed, if anything. Never an amount. */
    code?: string | undefined;
    /** Whose order it is, for who a discount is for; left out, nobody proved (a guest's). */
    dealBuyer?: DealBuyer | undefined;
    /** Lines the host priced itself for a record made in the same batch (order.startHeld). */
    priced?: readonly PricedLine[] | undefined;
    /** A pending order being priced again: its own use is not counted against a limit. */
    orderId?: string | undefined;
    /**
     * An invoice's order (ADR 0731): no deal. Its price is the invoice's, as staff wrote it and the
     * customer was sent it, with its own discounts on its lines; a member's price or a code found
     * at issue would make the order differ from the document. The goods rules still hold.
     */
    noDeal?: boolean | undefined;
  } = {},
): Promise<PricedOrder> {
  const all = delivery
    ? [...lines, { object: delivery.object, id: delivery.id, quantity: 1 }]
    : [...lines];
  const priced = options.priced
    ? [...options.priced]
    : await priceLines(db, all, currency, now, buyer);
  const worked: { deal: Deal | null; code: CodeOutcome } = options.noDeal
    ? { deal: null, code: { given: false } }
    : await workOutDeal(
        db,
        priced.map((line) => ({ ...line, delivery: Boolean(line.delivery) })),
        options.dealBuyer ?? { personId: null, placedAs: "public" },
        options.code,
        now,
        currency,
        { excludeOrderId: options.orderId },
      );
  const problems: QuoteProblem[] = [];
  if (worked.code.given && !worked.code.valid) {
    const details = {
      rule: "code_not_valid",
      field: "code",
      // Staff read the discounts anyway; nobody else learns why, or whether the code exists.
      ...(buyer?.kind === "staff" ? { reason: worked.code.reason } : {}),
    };
    if (mode === "start") throw new ValidationError(CODE_NOT_VALID, details);
    problems.push({ rule: "code_not_valid", message: CODE_NOT_VALID });
  }
  const shares = new Map((worked.deal?.shares ?? []).map((s) => [s.lineId, s.amount]));
  const discounted = priced.map((line) => ({ ...line, discount: shares.get(line.id) ?? 0 }));
  const goods = await applyGoodsRules(db, discounted, delivery, mode);
  const adjusted = applyAdjustments(goods.lines, dealShares(worked.deal));
  return {
    ...goods,
    lines: goods.lines.map((line, i) => ({ ...line, discount: adjusted.discounts[i] ?? 0 })),
    problems: [...problems, ...goods.problems],
    deal: worked.deal,
    code: worked.code,
    adjusted,
  };
}

// --- Starting an order -------------------------------------------------------------------------

export interface NewOrder {
  lines: readonly LineRequest[];
  /** Whose order it is; null when the address matched several people. */
  personId: string | null;
  /** The address it is placed with, normalised; null only for an invoice's order with none. */
  email: string | null;
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
  /**
   * How an order with goods gets to the buyer (ADR 0682): a delivery option and, for post, the
   * address. Priced by the host; the channel follows from it.
   */
  delivery?: DeliveryRequest | undefined;
  /** A promo code the buyer typed (ADR 0693). Never an amount: the host reads the discount. */
  code?: string | undefined;
  /**
   * Platform code only (`invoice.issue`, ADR 0731): the order an invoice starts, its lines in
   * `priced` built from the invoice's. No operation takes it from its input.
   */
  invoice?: InvoiceOrder | undefined;
}

/** An adjustment an invoice brings to its order (ADR 0731): the document's own money off. */
export interface InvoiceAdjustment {
  /**
   * `staff`: a line's discount as staff wrote it on the invoice; `prepaid`: a final invoice's
   * "less deposit paid" (stage 35 step 6 writes its lines), on the whole order.
   */
  kind: "staff" | "prepaid";
  /** The order line it is on; null: the whole order, spread over its lines. */
  lineId: string | null;
  amount: number;
  /** A staff discount asked as a percentage (0 to 100). */
  percent: number | null;
  /** A staff discount's why, as on the invoice. */
  reason: string | null;
}

/** What an invoice tells the order it starts (ADR 0731). */
export interface InvoiceOrder {
  /** The invoice: the order's `invoice_id`, and the source of its host adjustments. */
  id: string;
  /** When the invoice is due: the order's `balance_due_at`. It never expires. */
  dueAt: string;
  /** In the order the seam takes them off: staff discounts, then prepaid. */
  adjustments: readonly InvoiceAdjustment[];
  /** The invoice's total, which the order's must equal (checked again by the database). */
  total: number;
}

export interface StartedOrder {
  row: OrderRow;
  lines: PricedLine[];
  /** The order's one deal (ADR 0693), when it has one. */
  deal: Deal | null;
  /** Whether the code given applied (false: a better deal did); null when none was given. */
  codeApplied: boolean | null;
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
  // One seam for every path (ADR 0693): the lines (or, for order.startHeld, the lines the host
  // priced itself for a record made in this batch: the goods rules hold for them too), the deal,
  // the delivery. Staff take money off a pending order afterwards (orders/staff-discounts.ts),
  // through the same adjustment stage.
  const dealBuyer: DealBuyer = { personId: input.personId, placedAs: input.placedAs };
  const goods = await priceOrder(
    ctx.db,
    input.lines,
    input.delivery,
    currency,
    ctx.now,
    callerOf(ctx),
    "start",
    { code: input.code, dealBuyer, priced: input.priced, noDeal: Boolean(input.invoice) },
  );
  const invoice = input.invoice;
  if (invoice && (input.pay !== "full" || input.placedAs !== "staff" || !input.priced)) {
    throw new ConflictError("An invoice's order is staff's, paid in full, its lines the host's");
  }
  // An invoice's own money off comes off through the same adjustment stage (ADR 0731): its
  // lines' staff discounts (and their rounding), then any "less deposit paid".
  const adjusted = invoice
    ? applyAdjustments(
        goods.lines,
        invoice.adjustments.map((a) => ({ lineId: a.lineId, amount: a.amount })),
      )
    : goods.adjusted;
  const lines = invoice
    ? goods.lines.map((line, i) => ({ ...line, discount: adjusted.discounts[i] ?? 0 }))
    : goods.lines;
  const total = adjusted.total;
  if (total <= 0) {
    throw new ValidationError("An order with nothing to pay cannot be started", { rule: "total" });
  }
  if (invoice && (total !== invoice.total || adjusted.discount !== sumOf(invoice.adjustments))) {
    // The invoice's lines are mapped so that this always holds: anything else is a bug.
    throw new ConflictError("The invoice's order does not come to the invoice's total", {
      rule: "invoice_total",
      total,
      invoice: invoice.total,
    });
  }

  let deposit: number | null = null;
  let balanceDueAt: string | null = null;
  let pay = input.pay;
  if (pay === "deposit") {
    for (const line of lines) {
      if (!line.deposit) {
        refuseLine("deposit_not_offered", line.position, "This cannot be paid by deposit");
      }
    }
    const offered = lines.map((line) => line.deposit as NonNullable<PricedLine["deposit"]>);
    deposit = lines.reduce((sum, line, i) => sum + (offered[i]?.amount ?? 0) * line.quantity, 0);
    // The earliest date any line gives: every item is paid for by the time its own is due.
    balanceDueAt = offered.map((d) => d.balanceDueAt).sort()[0] as string;
    if (deposit >= adjusted.subtotal) {
      throw new ValidationError("The deposit is the whole price: pay in full", {
        rule: "deposit_not_offered",
      });
    }
    if (deposit >= total) {
      // The deal left the deposit at or above what is owed (the spec's rule 6): the buyer pays in
      // full, as `chargeFor` would ask.
      pay = "full";
      deposit = null;
      balanceDueAt = null;
    } else if (balanceDueAt <= ctx.now) {
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
  // A visitor's order always has its address; only an invoice's (staff's) may have none.
  const guestRows = await agreed.guestRows({ orderId: id, email: input.email ?? "" });

  const minutes = await loadOrderExpiryMinutes(ctx.db);
  const row: OrderRow = {
    id,
    person_id: input.personId,
    email: input.email,
    currency,
    total,
    paid: 0,
    state: "pending",
    pay,
    deposit,
    // An invoice's order is due, not expiring (ADR 0731): its due date is the invoice's.
    balance_due_at: invoice ? invoice.dueAt : balanceDueAt,
    expires_at: invoice ? null : new Date(Date.parse(ctx.now) + minutes * 60_000).toISOString(),
    placed_as: input.placedAs,
    provider: null,
    provider_ref: null,
    access_hash: input.accessHash ?? null,
    access_until: null,
    email_link_hash: null,
    refunded: 0,
    // The tax on what has been paid: none yet. An invoice's lines keep the document's tax, and each
    // payment on its order carries its share of it (ADR 0731).
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
    channel: goods.channel,
    invoice_id: invoice?.id ?? null,
    credited: 0,
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
        ...(line.taxAmount ? { tax_amount: line.taxAmount } : {}),
      }),
    ),
    ...outcome.history,
    ...agreed.guards,
    // After the order: a guest's acceptance names an order that must exist (migration 0851).
    ...guestRows,
  );
  // The order's delivery and, for post, its address (ADR 0682), after its line.
  if (goods.delivery) {
    const address = goods.delivery.address;
    ctx.write(
      ctx.db.insertInto("core_order_delivery").values({
        order_id: id,
        line_id: goods.delivery.line.id,
        kind: goods.delivery.kind,
        name: address?.name ?? null,
        line1: address?.line1 ?? null,
        line2: address?.line2 || null,
        city: address?.city || null,
        region: address?.region || null,
        postcode: address?.postcode || null,
        country: address?.country ?? null,
        created_at: ctx.now,
        // What free postage was decided from (ADR 0693): a code put on later decides it again.
        price: goods.delivery.price,
        free_over: goods.delivery.freeOver,
      }),
    );
  }
  // The deal (ADR 0693): an adjustment on each line it takes something off, naming the discount,
  // and its use held in this batch, after the order. The database refuses the use past a limit.
  if (goods.deal) writeDeal(ctx, id, goods.deal, dealBuyer);
  // An invoice's money off (ADR 0731): one adjustment row each, after its lines, naming the
  // invoice (the staff discounts their person and why, as stage 34's staff discounts do).
  if (invoice) {
    ctx.write(
      ...invoice.adjustments.map((a) =>
        ctx.db.insertInto("core_order_adjustment").values({
          id: newId("orderAdjustment"),
          order_id: id,
          line_id: a.lineId,
          kind: a.kind,
          source_object: "invoice",
          source_id: invoice.id,
          given_by: a.kind === "staff" ? ctx.user.id : null,
          reason: a.reason,
          percent: a.percent,
          amount: a.amount,
          approval: ctx.approval?.actionId ?? null,
          created_at: ctx.now,
        }),
      ),
    );
  }
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
  return {
    row,
    lines,
    deal: goods.deal,
    codeApplied: goods.code.given && goods.code.valid ? goods.code.applied : null,
  };
}

const sumOf = (adjustments: readonly { amount: number }[]) =>
  adjustments.reduce((sum, a) => sum + a.amount, 0);

/**
 * Queues a deal on a pending order, in the calling batch, after the order and its lines: one
 * `code` or `automatic` adjustment per line it takes something off, and its use, held.
 */
export function writeDeal(
  ctx: HandlerContext,
  orderId: string,
  deal: Deal,
  buyer: DealBuyer,
): void {
  ctx.write(
    ...deal.shares.map((share) =>
      ctx.db.insertInto("core_order_adjustment").values({
        id: newId("orderAdjustment"),
        order_id: orderId,
        line_id: share.lineId,
        kind: deal.kind,
        source_object: deal.discountObject,
        source_id: deal.discountId,
        percent: deal.percent,
        amount: share.amount,
        created_at: ctx.now,
      }),
    ),
  );
  holdDealUse(ctx, orderId, deal, buyer);
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
    | "credited"
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
    // closed order (its Person given, a refund) keeps the date it closed with; an expired order
    // becoming paid (a late payment honoured) closes again, as paid, and its time starts now.
    access_until: !CLOSED.has(to)
      ? null
      : CLOSED.has(row.state) && row.access_until && !(to === "paid" && row.state !== "paid")
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
export function chargeFor(
  row: OrderRow,
  minPart: number,
  amount?: number,
  /**
   * An invoice's order (stage 35 decision 8, ADR 0731): whether staff allowed part payments on
   * the invoice. Without, a checkout is for the whole balance, whatever is paid already; with, a
   * part of at least `minPart` (or what is owed, when less), from the first payment on.
   */
  options: { partsAllowed?: boolean } = {},
): Charge {
  const refuse = (message: string, rule: string, extra?: object): never => {
    throw new ValidationError(message, { rule, order: row.id, ...extra });
  };
  if (row.invoice_id && (row.state === "pending" || row.state === "part_paid")) {
    // What a credit note took off is not owed (ADR 0735).
    const owed = owedOn(row);
    const whole: Charge["kind"] =
      row.state === "pending" && row.credited === 0 ? "full" : "balance";
    if (owed <= 0) refuse("Nothing is owed on this invoice", "charge_state", { state: row.state });
    if (!options.partsAllowed) {
      if (amount !== undefined && amount !== owed) {
        refuse(
          "This invoice is paid in full: part payments are not allowed on it",
          "charge_amount",
          {
            due: owed,
          },
        );
      }
      return { amount: owed, currency: row.currency, kind: whole };
    }
    const least = Math.min(minPart, owed);
    const wanted = amount ?? owed;
    if (!Number.isInteger(wanted) || wanted < least || wanted > owed) {
      refuse(`A payment towards this invoice is between ${least} and ${owed}`, "charge_amount", {
        least,
        balance: owed,
      });
    }
    return { amount: wanted, currency: row.currency, kind: wanted === owed ? whole : "part" };
  }
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

/**
 * What `chargeFor` needs to know of an order's invoice (ADR 0731): whether staff allowed part
 * payments on it. One read, and only for an invoice's order.
 */
export async function chargeOptions(
  db: Kysely<CoreDatabase>,
  row: OrderRow,
): Promise<{ partsAllowed?: boolean }> {
  if (!row.invoice_id) return {};
  // The host's own read, org-wide, through the seam.
  const invoice = await viewRow(
    db,
    visibleSource(orgReader(db), getObject("invoice") ?? invoiceObject),
    row.invoice_id,
  );
  return { partsAllowed: invoice?.allow_part_payments === 1 };
}

/**
 * The share of an invoice's tax (worked out on the document, ADR 0732) that a payment of `amount`
 * on its order carries (ADR 0731): in proportion to the invoice's total, rounded half up, never
 * past the document's tax; the payment that settles an order nothing was credited on takes what is
 * left, so the payments' shares add up to the document's tax exactly. Zero for any other order:
 * there the provider says the tax at checkout (ADR 0479).
 */
export async function invoiceTaxShare(
  db: Kysely<CoreDatabase>,
  row: OrderRow,
  amount: number,
): Promise<number> {
  if (!row.invoice_id || amount <= 0) return 0;
  const invoice = await viewRow(
    db,
    visibleSource(orgReader(db), getObject("invoice") ?? invoiceObject),
    row.invoice_id,
  );
  const tax = Number(invoice?.tax_total ?? 0);
  if (!tax || !row.total) return 0;
  const left = Math.max(0, tax - row.tax_amount);
  if (row.credited === 0 && row.paid + amount === row.total) return left;
  return Math.min(left, mulDivHalfUp(amount, tax, row.total));
}

// --- Overdue balances --------------------------------------------------------------------------

/** How many overdue orders one read returns. */
export const OVERDUE_LIMIT = 200;

/**
 * Part-paid orders whose balance was due before `now`, and invoices' orders nothing has been paid
 * on past their due date (ADR 0731), oldest first. Nothing moves them: staff extend the date,
 * cancel or credit, or the buyer pays. Reads core_order_balance_due_idx and
 * core_order_invoice_due_idx only.
 */
export async function overdueOrders(
  db: Kysely<CoreDatabase>,
  now: string,
  limit = OVERDUE_LIMIT,
): Promise<OrderRow[]> {
  return db
    .selectFrom("core_order")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("state", "=", "part_paid"),
        eb.and([eb("state", "=", "pending"), eb("invoice_id", "is not", null)]),
      ]),
    )
    .where("balance_due_at", "<", now)
    .orderBy("balance_due_at")
    .limit(Math.min(Math.max(limit, 1), OVERDUE_LIMIT))
    .execute();
}

/**
 * Refuses a change to an invoice's order made other than through the invoice (ADR 0731): its money
 * is moved by the invoice's own operations, so the document, its order and its event log always
 * agree. `instead` says what to do.
 */
export function refuseInvoiceOrder(
  row: Pick<OrderRow, "id" | "invoice_id">,
  instead: string,
): void {
  if (row.invoice_id) {
    throw new ConflictError(`This order is an invoice's: ${instead}`, {
      rule: "invoice_order",
      order: row.id,
      invoice: row.invoice_id,
    });
  }
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
