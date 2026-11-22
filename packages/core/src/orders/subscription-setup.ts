// What the host needs before any subscription can be started (ADR 0459): the sites the provider
// may send a subscriber back to, the orders' currency and a payments connection. One function, so
// `subscription.start` and "is a plan on sale" (customers/plan-on-sale.ts) cannot drift apart.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConfigError } from "../errors.ts";
import { type PaymentsTarget, paymentsTarget } from "./gateway.ts";
import { loadOrderCurrency, loadReturnOrigins } from "./settings.ts";

export interface SubscriptionSetup {
  /** The listed sites a return address must be on; empty: no start can be made. */
  returnOrigins: string[];
  /** The orders' currency, or null while none is set. */
  currency: string | null;
  /** The payments connection, or null while none is connected. */
  target: PaymentsTarget | null;
}

export async function subscriptionSetup(db: Kysely<CoreDatabase>): Promise<SubscriptionSetup> {
  let target: PaymentsTarget | null = null;
  try {
    target = await paymentsTarget(db);
  } catch (error) {
    // Not connected is its only refusal.
    if (!(error instanceof ConfigError)) throw error;
  }
  return {
    returnOrigins: [...(await loadReturnOrigins(db))],
    currency: await loadOrderCurrency(db),
    target,
  };
}

/** Whether a subscription could be started at all (every part of the setup is there). */
export function setupComplete(
  setup: SubscriptionSetup,
): setup is SubscriptionSetup & { currency: string; target: PaymentsTarget } {
  return setup.returnOrigins.length > 0 && setup.currency !== null && setup.target !== null;
}
