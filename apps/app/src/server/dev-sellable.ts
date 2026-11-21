// A development sellable (stage 25): until stage 27's manifest `sellable` exists, nothing can be
// bought in a running app. The app var ORDERS_DEV_SELLABLE (`<object>:<priceField>`, e.g.
// `deals.deal:value`) makes one object something an order line may point at, once per isolate.
// Local only: `pnpm dev` adds it to .dev.vars, and no deployed configuration sets it.
import { registerSellable } from "@composable-os/core";

let registered: string | null = null;

/** Parses `<object>:<priceField>`, or null when it is not that. */
export function parseDevSellable(
  value: string | undefined,
): { object: string; price: string } | null {
  const match = /^([a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)?):([a-z][a-zA-Z0-9]*)$/.exec(
    value?.trim() ?? "",
  );
  return match?.[1] && match[2] ? { object: match[1], price: match[2] } : null;
}

/** Registers the development sellable named by env ORDERS_DEV_SELLABLE, when it is set. */
export function ensureDevSellable(env: object): void {
  const value = (env as { ORDERS_DEV_SELLABLE?: string }).ORDERS_DEV_SELLABLE;
  if (!value || registered === value) return;
  const sellable = parseDevSellable(value);
  if (!sellable) {
    console.error("ORDERS_DEV_SELLABLE is not <object>:<priceField>; ignoring it");
    registered = value;
    return;
  }
  registerSellable(sellable);
  registered = value;
}
