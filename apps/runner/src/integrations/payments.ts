// Orders in cos-runner (stage 25, ADR 0429): the payments adapter's dependencies, and the minute
// cron's orders step (expire pending orders past their time, apply verified payment events their
// first delivery did not, and tell staff of subscriptions with no event: stage 32a).
import {
  applyPendingPaymentEvents,
  invokeByName,
  orderExpiryDue,
  type PaymentEventDeps,
  parseFloor,
  queueEventSink,
  runCoolOffSweep,
  runRefundsDue,
  runUnsettledGuests,
  SYSTEM_USER,
  sweepSubscriptions,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { appOrigin } from "../notifications/deliver.ts";
import { integrationRuntime } from "./runtime.ts";

/** What applying a payment event needs here: the database, events, the integration host. */
export function paymentEventDeps(env: Env, clock?: () => Date): PaymentEventDeps {
  return {
    crm: createCrmDb(env.DB),
    integrations: integrationRuntime(env),
    ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    floor: parseFloor(env.APPROVAL_FLOOR),
    appOrigin: appOrigin(env),
    ...(clock ? { clock } : {}),
  };
}

/** The minute of each hour the subscription sweep's unindexed reads run in (an hour's first tick). */
export const SUBSCRIPTION_SWEEP_MINUTE = 0;

/** The minute cron's orders step. With nothing due it is indexed reads that return nothing, and no write. */
export async function runOrdersTick(env: Env, at: Date) {
  const deps = paymentEventDeps(env, () => at);
  const events = await applyPendingPaymentEvents(deps);
  // Through the pipeline only when an order is due: a quiet minute writes no audit row.
  const expired = (await orderExpiryDue(deps.crm.query, at.toISOString()))
    ? ((await invokeByName(
        "order.expireDue",
        {},
        {
          actor: "automation",
          user: SYSTEM_USER,
          origin: { surface: "system", automationId: "system.orders" },
          db: deps.crm,
          clock: () => at,
          ...(deps.events ? { events: deps.events } : {}),
          ...(deps.floor ? { floor: deps.floor } : {}),
        },
      )) as { expired: string[] })
    : { expired: [] };
  // Subscriptions with no event (stage 32a): past due too long every minute (an indexed read);
  // events not arriving, and offers whose plan has gone, once an hour: no index holds their
  // reads, so each reads the whole table (docs/cloudflare-costs.md). Each looks at a one-day
  // window, a page at a time, and tells staff once (its dedupe key).
  const subscriptions = await sweepSubscriptions(deps.crm, at.toISOString(), {
    unindexed: at.getUTCMinutes() === SUBSCRIPTION_SWEEP_MINUTE,
  });
  // Refunds the host owes (ADR 0560): a paid drop-in cancelled in time or by the gym. Each is
  // asked for as the gatekeeper's `payments.refund`, which waits for a person to approve.
  const refunds = await runRefundsDue(deps.crm, {
    integrations: deps.integrations,
    floor: deps.floor,
    events: deps.events,
    clock: () => at,
  });
  // Cooling offs whose call to the provider was lost or never made (stage 44 step 7, ADR 0647):
  // the provider read first, asked again while the period is open, else admins told once.
  const coolingOff = await runCoolOffSweep(deps.crm, {
    integrations: deps.integrations,
    floor: deps.floor,
    events: deps.events,
    clock: () => at,
  });
  // Paid guest drop-ins nobody said whose by the time booking closed: one call each (ADR 0560).
  const unsettled = await runUnsettledGuests(deps.crm, {
    floor: deps.floor,
    events: deps.events,
    clock: () => at,
  });
  return {
    events,
    expired: expired.expired.length,
    subscriptions,
    refunds,
    coolingOff,
    unsettled,
  };
}
