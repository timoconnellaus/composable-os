// Whether the host has a subscription plan on sale to the public (ADR 0459): the condition under
// which "anyone starting a subscription" lets an address with no account get a sign-in code.
//
// "On sale" is exactly what `subscription.start` would accept from a guest, read with the same
// function (`priceLines` as the public, `plans: true`): a live record of a recurring sellable
// object the public may read, with a price above nothing in the orders' currency, inside its sale
// window; and a payments connection to open the provider's page with. Nothing here is the
// caller's: it is a fact about the host, the same for every address.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConfigError, ValidationError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import { paymentsTarget } from "../orders/gateway.ts";
import { priceLines } from "../orders/orders.ts";
import { sellableOf, sellableProblems } from "../orders/sellable.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import type { PublicPrincipal } from "../principals.ts";
import { type AnyRow, buyableSource, type VisibleSource } from "../visibility/index.ts";

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/**
 * How many of an object's public records are priced before giving up on it. A host with more
 * plans than this, every one of the first not on sale, reads as having none: the rule errs shut.
 */
export const PLANS_LOOKED_AT = 50;

/** Whether a guest could start a subscription to some plan now (ADR 0459). */
export async function hasPlanOnSale(
  db: Kysely<CoreDatabase>,
  now: string = new Date().toISOString(),
): Promise<boolean> {
  const currency = await loadOrderCurrency(db);
  if (!currency) return false;
  try {
    await paymentsTarget(db);
  } catch (error) {
    // Payments are not connected (its only refusal): nothing can be started.
    if (error instanceof ConfigError) return false;
    throw error;
  }
  for (const object of listObjects()) {
    const sellable = sellableOf(object);
    if (!sellable?.recurring || sellableProblems(sellable, object).length) continue;
    let source: VisibleSource<AnyRow, string>;
    try {
      source = buyableSource({ principal: PUBLIC }, object);
    } catch {
      continue; // the public reads nothing of it
    }
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (db as any)
      .selectFrom(source)
      .select("id")
      .limit(PLANS_LOOKED_AT)
      .execute()) as { id: string }[];
    for (const { id } of rows) {
      try {
        const [line] = await priceLines(
          db,
          [{ object: object.name, id, quantity: 1 }],
          currency,
          now,
          PUBLIC,
          { plans: true },
        );
        if (line?.recurring && line.unitPrice > 0) return true;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
      }
    }
  }
  return false;
}
