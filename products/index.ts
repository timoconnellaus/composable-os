// Every product in this repository, by id. The installer offers these (`--product`), and a release
// carries a bundle of each (scripts/release/build-release.ts `--products all`).
import type { ProductDefinition } from "@composable-os/product";
import { product as composable } from "./composable/product.ts";
import { product as crm } from "./crm/product.ts";

export { HOSTED_PACKS_LEFT_OUT } from "./composable/product.ts";

export const products: Record<string, ProductDefinition> = {
  [crm.id]: crm,
  [composable.id]: composable,
};

/** The product installed when none is named. */
export const DEFAULT_PRODUCT = crm.id;

/**
 * The hosted product: what a host of many clients (stage 66) is installed as, with
 * `cos fleet install --product composable` and every later `cos fleet` and `cos client` command.
 */
export const HOSTED_PRODUCT = composable.id;
