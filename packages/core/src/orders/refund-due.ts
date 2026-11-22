// Refunds the host owes (stage 31a step 8, ADR 0560): a drop-in booking whose order is paid,
// cancelled in time or by the gym, wrote a row in core_sellable_refund_due in its move's batch
// (orders/moves.ts). The minute cron asks the payments gatekeeper for each one here, after that
// batch committed, so a move that fails never leaves a refund waiting for approval.
//
//   1. claim the row (`due` -> `asking`) in its own statement: of two ticks at once one asks;
//   2. `order.refundDue` asks for the refund as the host's automation, as `order.refund` would
//      (one refund per payment, newest first): the gatekeeper's outbound action
//      `payments.refund`, always reviewed, approved only by a person with `orders:refund`;
//      the row becomes `asked`, or `skipped` when nothing is left to refund (staff refunded it);
//   3. a row the operation failed on, or left `asking` (the Worker stopped between the two), is
//      never asked again by itself: it is `skipped` with why, and admins are told to refund by
//      hand. Asking twice could put two refunds in front of a person; telling them cannot.
import type { CrmDb } from "@composable-os/db";
import { errorForLog } from "../log.ts";
import type { GateFloor } from "../gate.ts";
import type { EventSink } from "../automations/types.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { invokeByName } from "../invoke.ts";
import type { HandlerContext } from "../operation.ts";
import { notifyStatements } from "../notifications/send.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadOrderRow } from "./orders.ts";
import { requestRefund, type RequestedRefund } from "./refunds.ts";

/** How many owed refunds one tick asks for. */
export const REFUND_DUE_BATCH = 20;
/** A row left `asking` this long is given up on and staff are told. */
export const REFUND_DUE_STALE_MINUTES = 15;

/**
 * The operation's work: asks for the refund one claimed row owes, in the operation's batch.
 * Returns what was asked, or why nothing was.
 */
export async function requestDueRefund(
  ctx: HandlerContext,
  id: string,
): Promise<{ state: "asked" | "skipped"; refunds: RequestedRefund[]; note: string | null }> {
  const due = await ctx.db
    .selectFrom("core_sellable_refund_due")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!due || due.state !== "asking") {
    return { state: "skipped", refunds: [], note: "not claimed" };
  }
  const mark = (state: "asked" | "skipped", note: string | null) =>
    ctx.write(
      ctx.db
        .updateTable("core_sellable_refund_due")
        .set({ state, note, updated_at: ctx.now })
        .where("id", "=", id)
        .where("state", "=", "asking"),
    );
  const order = await loadOrderRow(ctx.db, due.order_id);
  if (order.state !== "paid") {
    const note = `The order is ${order.state}: nothing to ask for`;
    mark("skipped", note);
    return { state: "skipped", refunds: [], note };
  }
  try {
    const asked = await requestRefund(ctx, order, { reason: due.reason });
    mark("asked", null);
    return { state: "asked", refunds: asked.refunds, note: null };
  } catch (error) {
    // Everything paid was already refunded or asked for (staff did it by hand): nothing owed.
    const conflict = (error as { code?: string }).code === "conflict";
    if (!conflict) throw error;
    const note = (error as Error).message;
    mark("skipped", note);
    return { state: "skipped", refunds: [], note };
  }
}

export interface RefundsDueOptions {
  integrations?: IntegrationRuntime | undefined;
  floor?: GateFloor | undefined;
  events?: EventSink | undefined;
  clock?: (() => Date) | undefined;
}

/** Tells admins an owed refund was not asked for, and marks it so. */
async function giveUp(crm: CrmDb, id: string, orderId: string, why: string, now: string) {
  const plan = await notifyStatements(
    crm.query,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: "A refund owed could not be asked for",
      body:
        `Order ${orderId} is owed a refund (a drop-in cancelled in time or by the gym), and the ` +
        `host could not ask for it (${why}). Refund it from the order.`,
      link: { kind: "record", object: "order", id: orderId },
      dedupeKey: `order.refund_due_failed:${orderId}`,
      source: { actor: "system" },
    },
    now,
  );
  await crm.batch([
    crm.query
      .updateTable("core_sellable_refund_due")
      .set({ state: "skipped", note: why.slice(0, 500), updated_at: now })
      .where("id", "=", id),
    ...plan.statements,
  ]);
}

/** The minute cron's step: asks for the refunds owed. With nothing owed it is one indexed read. */
export async function runRefundsDue(
  crm: CrmDb,
  { integrations, floor, events, clock }: RefundsDueOptions = {},
): Promise<{ asked: number; skipped: number; failed: number }> {
  const result = { asked: 0, skipped: 0, failed: 0 };
  const now = () => (clock?.() ?? new Date()).toISOString();
  const stale = new Date(Date.parse(now()) - REFUND_DUE_STALE_MINUTES * 60_000).toISOString();
  const left = await crm.query
    .selectFrom("core_sellable_refund_due")
    .select(["id", "order_id"])
    .where("state", "=", "asking")
    .where("updated_at", "<", stale)
    .limit(REFUND_DUE_BATCH)
    .execute();
  for (const row of left) {
    await giveUp(crm, row.id, row.order_id, "it was left half asked", now());
    result.failed += 1;
  }
  const due = await crm.query
    .selectFrom("core_sellable_refund_due")
    .select(["id", "order_id"])
    .where("state", "=", "due")
    .orderBy("created_at")
    .limit(REFUND_DUE_BATCH)
    .execute();
  for (const row of due) {
    const claimed = await crm.query
      .updateTable("core_sellable_refund_due")
      .set({ state: "asking", updated_at: now() })
      .where("id", "=", row.id)
      .where("state", "=", "due")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) !== 1) continue;
    try {
      const out = (await invokeByName(
        "order.refundDue",
        { id: row.id },
        {
          actor: "automation",
          user: SYSTEM_USER,
          origin: { surface: "system", automationId: "system.orders" },
          db: crm,
          ...(integrations ? { integrations } : {}),
          ...(floor ? { floor } : {}),
          ...(events ? { events } : {}),
          ...(clock ? { clock } : {}),
        },
      )) as { state: "asked" | "skipped" };
      if (out.state === "asked") result.asked += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      console.error("refund owed not asked for", row.order_id, errorForLog(error));
      await giveUp(crm, row.id, row.order_id, (error as Error).message ?? "an error", now());
    }
  }
  return result;
}
