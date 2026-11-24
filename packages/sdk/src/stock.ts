// The `stock` behaviour (stage 37, ADR 0682): an object declares that its records are goods the
// business counts, and the host keeps how many there are from a ledger nobody can change. Its
// declaration, its manifest schema and its contract checks live here; the host's side is
// packages/core/src/stock/.
import { z } from "zod";
import { CAPACITY_SHOW, type CapacityShow } from "./capacity.ts";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * The read-only values the host adds to every record of an object with stock: how many are on
 * hand, how many of those are held while someone pays, and how many are available to buy (on hand
 * less held). An object with stock cannot have fields of these names.
 */
export const STOCK_VALUES = ["onHand", "held", "available"] as const;

/**
 * Goods counted by the host (ADR 0682). Each record has a counter on capacity's engine and a
 * ledger of movements: every change has a kind, a signed quantity, a place, who and why. Nobody
 * types on hand: it is the sum of the ledger, changed only by movements (opening stock, an
 * adjustment, a sale, and later receipts, counts, write-offs and returns). An order line holds
 * its quantity while the order is unpaid, refused by the database past what is available, and
 * writes a `sold` movement when it is paid. A refund changes nothing in stock; a return does.
 *
 * - `reorderAt` is this object's number field holding the reorder level: at or below it the
 *   record is low (staff are told, a later step). `reorderQty` is its number field holding how
 *   many to order then. Both optional.
 * - `show` is what customers and the public are told (default `availability`: in stock or sold
 *   out); `low` says "only N left" at or below `lowAt`; `exact` the number available.
 *
 * The object must be `sellable` (not by subscription, not bought by making a record), and has no
 * `capacity`: one counter per record.
 */
export interface StockSpec {
  reorderAt?: string;
  reorderQty?: string;
  show?: CapacityShow;
  lowAt?: number;
}

const fieldName = z.string().max(40);

export const stockManifestSchema = z
  .object({
    reorderAt: fieldName.optional(),
    reorderQty: fieldName.optional(),
    show: z.enum(CAPACITY_SHOW).optional(),
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

  if (!object.sellable) {
    contract(path, `${name} must be sellable: stock is what an order of it holds and sells`);
  } else if (object.sellable.recurring) {
    contract(path, "A plan is subscribed to, not taken from stock");
  } else if (object.sellable.moves) {
    contract(path, "A record bought by making it (sellable.moves) is not taken from stock");
  }
  if (object.capacity) {
    contract(path, `${name} declares a capacity: a record has places or stock, not both`);
  }
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
  if (stock.lowAt !== undefined && stock.show !== "low") {
    contract(`${path}.lowAt`, 'lowAt is the threshold of show: "low"');
  }
  if (stock.show === "low" && stock.lowAt === undefined) {
    contract(`${path}.lowAt`, 'show: "low" needs lowAt, the number at or below which it says so');
  }
}
