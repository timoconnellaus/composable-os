// Every product in this repository, by id. The installer offers these (`--product`).
import type { ProductDefinition } from "@composable-os/product";
import { product as crm } from "./crm/product.ts";

export const products: Record<string, ProductDefinition> = { [crm.id]: crm };

/** The product installed when none is named. */
export const DEFAULT_PRODUCT = crm.id;
