// Orders in cos-runner (stage 25, ADR 0429): the payments adapter's dependencies, and the minute
// cron's orders step (expire pending orders past their time, apply verified payment events their
// first delivery did not).
import {
  applyPendingPaymentEvents,
  invokeByName,
  type PaymentEventDeps,
  parseFloor,
  queueEventSink,
  SYSTEM_USER,
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

/** The minute cron's orders step. With nothing due it is two indexed reads that return nothing. */
export async function runOrdersTick(env: Env, at: Date) {
  const deps = paymentEventDeps(env, () => at);
  const events = await applyPendingPaymentEvents(deps);
  const expired = (await invokeByName(
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
  )) as { expired: string[] };
  return { events, expired: expired.expired.length };
}
