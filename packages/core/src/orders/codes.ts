// A code put on, or taken off, a pending order (stage 34 step 4, ADR 0693): order.applyCode and
// order.removeCode. Only before the order's payment page has opened (a page already open was made
// for the old amount).
//
// The deal is worked out again through the same function as at the start (`workOutDeal`), from
// the prices the order's lines were started at (not today's records), the order's own Person and
// how it was placed, and the code: the better for the buyer of the code and any automatic
// discount (decision 9). The old deal's adjustments are marked removed and its use released, the
// new deal's written and its use held, in one batch; staff discounts stay, after the deal. Free
// postage is decided again on the goods' net (the spec's rule 8), from the delivery's price and
// free-over as the order was started with. A code that does not apply is refused with one answer
// whatever the reason, and nothing changes.
import { CODE_NOT_VALID, type Deal, type DealBuyer, workOutDeal } from "../discounts/deal.ts";
import { releaseDealUses } from "../discounts/uses.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { orderLineObject } from "../fields/order.ts";
import type { HandlerContext } from "../operation.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { type AdjustmentShare, applyAdjustments } from "./adjustments.ts";
import {
  changeOrderPrice,
  dealShares,
  loadOrderRow,
  type OrderRow,
  refuseInvoiceOrder,
  requireState,
  writeDeal,
} from "./orders.ts";
import { type AdjustmentRow, liveAdjustments, refuseOpenCheckout } from "./staff-discounts.ts";

interface StoredLine {
  id: string;
  position: number;
  object: string;
  recordId: string;
  unitPrice: number;
  quantity: number;
  total: number;
  delivery: boolean;
}

export interface CodeChanged {
  order: OrderRow;
  /** Each line's share of the adjustments and its total, by line id (not written yet). */
  lines: ReadonlyMap<string, { total: number; unitPrice: number; discount: number }>;
  deal: Deal | null;
  /** Whether the code given applied (false: a better deal did); null when it was taken off. */
  codeApplied: boolean | null;
}

/** The order's lines as started: the host's own read, org-wide, through the seam. */
async function storedLines(ctx: HandlerContext, orderId: string, deliveryLine: string | null) {
  const lineObject = getObject("orderLine") ?? orderLineObject;
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const rows = (await (ctx.db as any)
    .selectFrom(visibleSource(orgReader(ctx.db), lineObject))
    .select(["id", "position", "object_type", "record_id", "unit_price", "quantity", "line_total"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute()) as {
    id: string;
    position: number;
    object_type: string;
    record_id: string;
    unit_price: number;
    quantity: number;
    line_total: number;
  }[];
  return rows.map(
    (row): StoredLine => ({
      id: row.id,
      position: row.position,
      object: row.object_type,
      recordId: row.record_id,
      unitPrice: row.unit_price,
      quantity: row.quantity,
      total: row.line_total,
      delivery: row.id === deliveryLine,
    }),
  );
}

const isDeal = (a: AdjustmentRow) => a.kind === "code" || a.kind === "automatic";

/** The deal on the order now is the one worked out: the same discount taking the same off. */
function sameDeal(live: readonly AdjustmentRow[], deal: Deal | null): boolean {
  const current = live.filter(isDeal);
  if (!deal) return current.length === 0;
  if (current.length !== deal.shares.length) return false;
  return deal.shares.every((share) =>
    current.some(
      (a) =>
        a.line_id === share.lineId &&
        a.amount === share.amount &&
        a.kind === deal.kind &&
        a.source_id === deal.discountId,
    ),
  );
}

/**
 * Puts `code` on a pending order (or, with null, takes its code off), in the calling batch. The
 * caller has established the order is theirs (operations/order.ts, `orderForPaying`).
 */
export async function changeOrderCode(
  ctx: HandlerContext,
  orderId: string,
  code: string | null,
): Promise<CodeChanged> {
  const row = await loadOrderRow(ctx.db, orderId);
  refuseInvoiceOrder(row, "its price is the invoice's and takes no code");
  requireState(row, ["pending"], code === null ? "changed" : "given a code");
  await refuseOpenCheckout(ctx, row);
  const [live, delivery] = await Promise.all([
    liveAdjustments(ctx.db, row.id),
    ctx.db
      .selectFrom("core_order_delivery")
      .select(["line_id", "price", "free_over"])
      .where("order_id", "=", row.id)
      .executeTakeFirst(),
  ]);
  if (code === null && !live.some((a) => a.kind === "code")) {
    throw new ConflictError("There is no code on this order", { rule: "no_code", order: row.id });
  }
  const lines = await storedLines(ctx, row.id, delivery?.line_id ?? null);
  const buyer: DealBuyer = { personId: row.person_id, placedAs: row.placed_as };
  const worked = await workOutDeal(ctx.db, lines, buyer, code ?? undefined, ctx.now, row.currency, {
    excludeOrderId: row.id,
    // Wrong codes per client address (ADR 0940): checked first, a wrong one counted.
    guesses: ctx.guesses,
  });
  if (worked.code.given && !worked.code.valid) {
    throw new ValidationError(CODE_NOT_VALID, {
      rule: "code_not_valid",
      field: "code",
      ...(ctx.principal.kind === "staff" ? { reason: worked.code.reason } : {}),
    });
  }
  const codeApplied = worked.code.given && worked.code.valid ? worked.code.applied : null;
  const deal = worked.deal;

  // Free postage on the goods' net after the new deal, from what the order was started with.
  const shares = new Map((deal?.shares ?? []).map((s) => [s.lineId, s.amount]));
  const priced = lines.map((line) => ({ ...line }));
  const deliveryLine = priced.find((line) => line.delivery);
  let postage: number | null = null;
  if (deliveryLine && delivery?.price != null) {
    const goodsNet = priced
      .filter((line) => !line.delivery && getObject(line.object)?.sellable?.goods)
      .reduce((sum, line) => sum + line.total - (shares.get(line.id) ?? 0), 0);
    const free = delivery.free_over !== null && goodsNet >= delivery.free_over;
    const charged = free ? 0 : delivery.price;
    if (charged !== deliveryLine.total) {
      postage = charged;
      deliveryLine.unitPrice = charged;
      deliveryLine.total = charged;
    }
  }

  if (sameDeal(live, deal) && postage === null) {
    const adjusted = applyAdjustments(priced, live.map(toShare));
    return {
      order: row,
      lines: linesOut(priced, adjusted.discounts),
      deal,
      codeApplied,
    };
  }

  const staff = live.filter((a) => !isDeal(a));
  const adjusted = applyAdjustments(priced, [...dealShares(deal), ...staff.map(toShare)]);
  if (adjusted.total <= 0) {
    throw new ValidationError("A discount cannot take an order to nothing to pay", {
      rule: "total",
    });
  }
  const old = live.filter(isDeal).map((a) => a.id);
  if (old.length) {
    ctx.write(
      ctx.db
        .updateTable("core_order_adjustment")
        .set({ removed_at: ctx.now, removed_by: removedBy(ctx) })
        .where("id", "in", old)
        .where("order_id", "=", row.id)
        .where("removed_at", "is", null),
    );
  }
  releaseDealUses(ctx, row.id);
  if (postage !== null && deliveryLine) {
    ctx.write(
      ctx.db
        .updateTable("core_order_line")
        .set({ unit_price: postage, line_total: postage, line_discount: 0 })
        .where("id", "=", deliveryLine.id)
        .where("order_id", "=", row.id),
    );
  }
  if (deal) writeDeal(ctx, row.id, deal, buyer);
  ctx.write(
    ...priced.map((line, i) =>
      ctx.db
        .updateTable("core_order_line")
        .set({ line_discount: adjusted.discounts[i] ?? 0 })
        .where("id", "=", line.id)
        .where("order_id", "=", row.id),
    ),
  );
  const order = await changeOrderPrice(
    ctx,
    row,
    { total: adjusted.total, discount: adjusted.discount },
    // The host reprices: the caller only named a code, and the price is the host's.
    "host",
  );
  return { order, lines: linesOut(priced, adjusted.discounts), deal, codeApplied };
}

/** Who took a deal off: a staff account, a customer's account, or the guest holding the token. */
function removedBy(ctx: HandlerContext): string {
  const caller = ctx.principal;
  if (caller.kind === "customer") return `customer:${caller.customerId}`;
  if (caller.kind === "public") return "public";
  return ctx.user.id;
}

const toShare = (a: AdjustmentRow): AdjustmentShare => ({
  lineId: a.line_id,
  amount: a.amount,
  percent: a.percent,
});

function linesOut(lines: readonly StoredLine[], discounts: readonly number[]) {
  return new Map(
    lines.map((line, i) => [
      line.id,
      { total: line.total, unitPrice: line.unitPrice, discount: discounts[i] ?? 0 },
    ]),
  );
}
