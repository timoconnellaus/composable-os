// The `stock` behaviour (stage 37, ADR 0680): an object declares that its records are things
// counted on a shelf (a variant of an item in a shop), and the host keeps how many there are, from
// a ledger nobody edits, never selling more than there is, for every actor. Its declaration, its
// manifest schema and its contract checks live here; the host's side is packages/core/src/stock/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * What customers and the public are told about a record's stock (staff always see the numbers):
 * `availability` (the default), "In stock" or "Sold out"; `low`, "only N left" at or below
 * `lowAt`; `exact`, the number available.
 */
export const STOCK_SHOW = ["exact", "low", "availability"] as const;
export type StockShow = (typeof STOCK_SHOW)[number];

/**
 * The read-only values the host adds to every record of an object with stock: on hand (what is
 * on the shelf, sold units gone), held (by orders being paid for) and available (on hand less
 * held). An object with stock cannot have fields of these names.
 */
export const STOCK_VALUES = ["onHand", "held", "available"] as const;

/** The kinds of movement in the ledger (ADR 0680). Step 1 of stage 37 writes `opening`, `adjusted` and `sold`. */
export const STOCK_MOVEMENT_KINDS = [
  "opening",
  "received",
  "sold",
  "returned",
  "written_off",
  "counted",
  "adjusted",
  "used",
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * A number of things on hand (ADR 0680). The host keeps the count from a ledger of movements
 * (opening stock, a correction, a sale) and nobody types it: an order line holds its quantity
 * while the order is unpaid and sells it when it is paid, refused by the database past what is
 * available, in the order's own batch. A refund changes nothing in stock; a return does.
 *
 * - `reorderAt` is this object's number field holding the reorder level (a record at or below it
 *   is low); `reorderQty` the number field holding how many to order then.
 * - `show` is what customers and the public are told (default `availability`); `lowAt` is the
 *   threshold for `low`.
 *
 * An object with stock is not also a capacity (its counter is the stock's), and is not bought by
 * deposit, by subscription or by moving a record (`sellable.deposit`, `recurring`, `moves`).
 */
export interface StockSpec {
  reorderAt?: string;
  reorderQty?: string;
  show?: StockShow;
  lowAt?: number;
}

const fieldName = z.string().max(40);

export const stockManifestSchema = z
  .object({
    reorderAt: fieldName.optional(),
    reorderQty: fieldName.optional(),
    show: z.enum(STOCK_SHOW).optional(),
    lowAt: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type StockManifest = z.infer<typeof stockManifestSchema>;

/** Reports problems with `objects.<name>.stock` through `contract`. */
export function checkObjectStock(
  _m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const stock = object.stock;
  if (!stock) return;
  const path = `objects.${name}.stock`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  for (const key of ["reorderAt", "reorderQty"] as const) {
    const local = stock[key];
    if (local === undefined) continue;
    const field = fieldOf(local);
    if (field?.type !== "number" || field.many) {
      contract(`${path}.${key}`, `"${local}" must be a number field of ${name}`);
    }
  }
  for (const reserved of STOCK_VALUES) {
    if (Object.hasOwn(object.fields, reserved)) {
      contract(
        `objects.${name}.fields.${reserved}`,
        `"${reserved}" is a value the host adds to an object with stock; rename the field`,
      );
    }
  }
  if (object.capacity) {
    contract(path, "An object has stock or a capacity, not both: stock keeps its own counter");
  }
  const sellable = object.sellable;
  if (sellable) {
    for (const key of ["deposit", "recurring", "moves"] as const) {
      if (sellable[key] !== undefined) {
        contract(
          `objects.${name}.sellable.${key}`,
          `A thing in stock is sold whole, on an order: it has no sellable.${key}`,
        );
      }
    }
  }
  if (stock.lowAt !== undefined && stock.show !== "low") {
    contract(`${path}.lowAt`, 'lowAt is the threshold of show: "low"');
  }
  if (stock.show === "low" && stock.lowAt === undefined) {
    contract(`${path}.lowAt`, 'show: "low" needs lowAt, the number at or below which it says so');
  }
}
