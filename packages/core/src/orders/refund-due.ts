// Refunds the host owes (stage 31a step 8, ADR 0560): a drop-in whose order is paid, cancelled in
// time or by the gym, or paid for after its place went back, wrote a row in
// core_sellable_refund_due in that batch (orders/moves.ts, payments.ts). The minute cron asks the
// payments gatekeeper for each one here, after that batch committed, so a move that fails never
// leaves a refund waiting for approval.
//
//   1. claim the row (`due` -> `asking`, the attempt counted) in its own statement: of two ticks
//      at once one asks;
//   2. `order.refundDue` asks for the refund as the host's automation, as `order.refund` would
//      (one refund per payment, newest first): the gatekeeper's outbound action
//      `payments.refund`, always reviewed, approved only by a person with `orders:refund`. Each
//      refund's id is `rfd_<row>_<attempt>_<n>`: the provider's idempotency key, so an action
//      left over from a crash and approved is still one refund. The row becomes `asked`, or
//      `skipped` when nothing is left to refund (staff refunded it);
//   3. a row the operation failed on (the approval policy denied it, payments are not set up), or
//      left `asking` (the Worker stopped between the two), is never asked again by itself: it is
//      `skipped` with why, and admins are told, including when an approval for it is already
//      waiting. Asking twice could put two refunds in front of a person; telling them cannot;
//   4. an `asked` row whose order is refunded is `done`; one whose every approval was rejected
//      or expired is `lapsed`, and admins are told once to refund it from the order. A refund
//      waiting for a person is never asked again (refundablePayments counts it).
import type { CrmDb } from "@composable-os/db";
import type { EventSink } from "../automations/types.ts";
import { OperationError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { invokeByName } from "../invoke.ts";
import { errorForLog } from "../log.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadOrderRow } from "./orders.ts";
import { type RequestedRefund, requestRefund } from "./refunds.ts";

/** How many owed refunds one tick asks for, and how many asked ones it looks at. */
export const REFUND_DUE_BATCH = 20;
/** A row left `asking` this long is given up on and staff are told. */
export const REFUND_DUE_STALE_MINUTES = 15;

/** The prefix of every refund id one attempt of a row asks for. */
export const dueRefundPrefix = (rowId: string, attempt: number) =>
  `rfd_${rowId.replace(/^rdu_/, "")}_${attempt}_`;

/**
 * The operation's work: asks for the refund one claimed row owes, in the operation's batch.
 * Returns what was asked, or why nothing was. Throws (and so writes nothing) when a refund could
 * not be put in front of a person.
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
  const prefix = dueRefundPrefix(due.id, due.attempt);
  try {
    // An order closed with a late payment on it (expired, cancelled) is refunded the same way.
    // A payment owed back on its own (a duplicate or late one) is refunded alone, for exactly
    // its amount; a whole order's refund is everything refundable on it.
    const asked = await requestRefund(ctx, order, {
      reason: due.reason,
      refundId: (n) => `${prefix}${n}`,
      ...(due.payment_ref ? { paymentRef: due.payment_ref } : {}),
      ...(due.payment_ref && due.amount ? { amount: due.amount } : {}),
    });
    if (asked.refunds.some((r) => r.pendingActionId === null)) {
      // Denied by the approval policy, or applied without a person: never left at that.
      throw new OperationError(
        "forbidden",
        "The approval policy did not put the refund in front of a person",
      );
    }
    mark("asked", null);
    return { state: "asked", refunds: asked.refunds, note: null };
  } catch (error) {
    // Nothing paid on it, or everything paid already refunded or asked for (staff did it by
    // hand, or a refund is waiting for a person): nothing more owed.
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

async function tell(crm: CrmDb, orderId: string, title: string, body: string, now: string) {
  return notifyStatements(
    crm.query,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: { kind: "record", object: "order", id: orderId },
      dedupeKey: `order.refund_due:${orderId}:${title}:${now}`,
      source: { actor: "system" },
    },
    now,
  );
}

/** Refund actions of one attempt of a row that are waiting for a person (a crash's leftovers). */
async function waitingActions(crm: CrmDb, rowId: string, attempt: number, now: string) {
  const prefix = dueRefundPrefix(rowId, attempt);
  const rows = await crm.query
    .selectFrom("core_pending_action")
    .select(["id", "expires_at", "input"])
    .where("action_kind", "=", "payments.refund")
    .where("status", "=", "pending")
    .where("input", "like", `%"refundId":"${prefix}%`)
    .execute();
  return rows.filter((r) => r.expires_at === null || r.expires_at > now);
}

/** Tells admins an owed refund was not asked for (or may be waiting), and marks it so. */
async function giveUp(
  crm: CrmDb,
  row: { id: string; order_id: string; attempt: number },
  why: string,
  now: string,
) {
  const waiting = await waitingActions(crm, row.id, row.attempt, now);
  const amounts = waiting.map((w) => {
    const found = /"amount":(\d+)/.exec(w.input ?? "");
    return found ? Number(found[1]) : null;
  });
  const plan = waiting.length
    ? await tell(
        crm,
        row.order_id,
        "A refund owed is partly waiting in Approvals",
        `Order ${row.order_id} is owed a refund (a drop-in cancelled or not kept), and its request ` +
          `was not recorded (${why}). ${waiting.length} refund(s) of it wait in Approvals ` +
          `(${amounts.map((a) => (a === null ? "an amount" : `${a} in minor units`)).join(", ")}, ` +
          `actions ${waiting.map((w) => w.id).join(", ")}): approve those. Anything else owed on ` +
          "the order was not asked for: refund the rest from the order once those are decided.",
        now,
      )
    : await tell(
        crm,
        row.order_id,
        "A refund owed could not be asked for",
        `Order ${row.order_id} is owed a refund (a drop-in cancelled or not kept), and the host ` +
          `could not ask for it (${why}). Refund it from the order.`,
        now,
      );
  await crm.batch([
    crm.query
      .updateTable("core_sellable_refund_due")
      .set({ state: "skipped", note: why.slice(0, 500), updated_at: now })
      .where("id", "=", row.id),
    ...plan.statements,
  ]);
}

/**
 * Asked rows: `done` once the order is refunded; `lapsed` once every approval asked for was
 * rejected or expired (staff told once, with why), so nothing promised is silently dropped.
 */
async function settleAsked(crm: CrmDb, now: string): Promise<{ lapsed: number }> {
  let lapsed = 0;
  const asked = await crm.query
    .selectFrom("core_sellable_refund_due")
    .select(["id", "order_id", "attempt"])
    .where("state", "=", "asked")
    .orderBy("updated_at")
    .limit(REFUND_DUE_BATCH)
    .execute();
  for (const row of asked) {
    const order = await crm.query
      .selectFrom("core_order")
      .select(["state"])
      .where("id", "=", row.order_id)
      .executeTakeFirst();
    const touch = (state: "done" | "lapsed" | "asked", note: string | null = null) =>
      crm.query
        .updateTable("core_sellable_refund_due")
        .set({ state, note, updated_at: now })
        .where("id", "=", row.id)
        .where("state", "=", "asked");
    if (!order || order.state === "refunded") {
      await crm.batch([touch("done")]);
      continue;
    }
    const prefix = dueRefundPrefix(row.id, row.attempt);
    const refunds = await crm.query
      .selectFrom("core_order_refund as r")
      .leftJoin("core_pending_action as p", "p.id", "r.pending_action_id")
      .select(["r.status", "p.status as action", "p.expires_at"])
      .where("r.order_id", "=", row.order_id)
      .where("r.id", "like", `${prefix}%`)
      .execute();
    if (!refunds.length) continue;
    const settled = (r: (typeof refunds)[number]) =>
      r.status === "confirmed" || r.action === "applied";
    const dead = (r: (typeof refunds)[number]) =>
      !settled(r) &&
      (r.action === "rejected" ||
        r.action === "expired" ||
        r.action === "failed" ||
        (r.action === "pending" && r.expires_at !== null && r.expires_at <= now));
    if (refunds.some((r) => !dead(r))) {
      // Waiting for a person, or done by the provider: keep looking (updated_at moves it back).
      if (refunds.every(settled)) await crm.batch([touch("done")]);
      else await crm.batch([touch("asked")]);
      continue;
    }
    const why = refunds.some((r) => r.action === "rejected")
      ? "a person rejected it"
      : refunds.some((r) => r.action === "failed")
        ? "it failed when it was applied"
        : "its approval expired before anyone decided";
    const plan = await tell(
      crm,
      row.order_id,
      "A refund owed was not approved",
      `Order ${row.order_id} is owed a refund (a drop-in cancelled or not kept); it was asked for ` +
        `and ${why}. The buyer was told it would be refunded: refund it from the order, or ` +
        "tell them why not.",
      now,
    );
    await crm.batch([touch("lapsed", why), ...plan.statements]);
    lapsed += 1;
  }
  return { lapsed };
}

/** The minute cron's step: asks for the refunds owed. With nothing owed it is two indexed reads. */
export async function runRefundsDue(
  crm: CrmDb,
  { integrations, floor, events, clock }: RefundsDueOptions = {},
): Promise<{ asked: number; skipped: number; failed: number; lapsed: number }> {
  const result = { asked: 0, skipped: 0, failed: 0, lapsed: 0 };
  const now = () => (clock?.() ?? new Date()).toISOString();
  const stale = new Date(Date.parse(now()) - REFUND_DUE_STALE_MINUTES * 60_000).toISOString();
  const left = await crm.query
    .selectFrom("core_sellable_refund_due")
    .select(["id", "order_id", "attempt"])
    .where("state", "=", "asking")
    .where("updated_at", "<", stale)
    .limit(REFUND_DUE_BATCH)
    .execute();
  for (const row of left) {
    await giveUp(crm, row, "it was left half asked", now());
    result.failed += 1;
  }
  const due = await crm.query
    .selectFrom("core_sellable_refund_due")
    .select(["id", "order_id", "attempt"])
    .where("state", "=", "due")
    .orderBy("created_at")
    .limit(REFUND_DUE_BATCH)
    .execute();
  for (const row of due) {
    const attempt = row.attempt + 1;
    const claimed = await crm.query
      .updateTable("core_sellable_refund_due")
      .set({ state: "asking", attempt, updated_at: now() })
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
      await giveUp(crm, { ...row, attempt }, (error as Error).message ?? "an error", now());
    }
  }
  result.lapsed = (await settleAsked(crm, now())).lapsed;
  return result;
}
