// What a caller may know of a record's stock (stage 37, ADR 0680, after ADR 0433 for places).
// Staff see the numbers: on hand, held, available, the reorder level. A customer or the public is
// told only what the object's `show` allows, worked out here, in the host: `availability` (the
// default) in stock or sold out, `low` "only N left" at or below the threshold, `exact` the
// number available. Never on hand or held, and only of a record they may read (their own, or one
// the public scope shows them); any other is not found, as one that does not exist.
import { sql } from "kysely";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, StockDefinition } from "../fields/types.ts";
import { readStockNumbers } from "../stock/index.ts";
import { unknownObject } from "./customer.ts";
import { type AnyRow, orgReader, type Reader, visibleSource, visibleTable } from "./index.ts";

export type StockStatus = "in_stock" | "low" | "sold_out";

/** stock.get's answer. Outside callers get `status` and at most `available`. */
export interface StockView {
  object: string;
  id: string;
  status: StockStatus;
  available?: number;
  onHand?: number;
  held?: number;
  /** The record's reorder level, when its object names one and it has a value. */
  reorderAt?: number | null;
  reorderQty?: number | null;
  /** On hand is at or below the reorder level. */
  atReorderLevel?: boolean;
  show?: StockDefinition["show"];
  lowAt?: number | null;
  /** Staff only: the last movements, newest first (the whole ledger is stock.movements). */
  recent?: RecentMovement[];
}

/** A movement as stock.get shows staff. */
export interface RecentMovement {
  id: string;
  kind: string;
  quantity: number;
  place: string;
  at: string;
  note: string | null;
}

/** How many movements stock.get gives staff. */
export const STOCK_RECENT = 5;

/** The status `show` gives for `available` units. */
export function stockStatus(stock: StockDefinition, available: number): StockStatus {
  if (available <= 0) return "sold_out";
  if (stock.show === "low" && stock.lowAt !== undefined && available <= stock.lowAt) return "low";
  return "in_stock";
}

/** What `show` lets someone outside the organisation know. */
export function outsideStockView(
  object: ObjectDefinition & { stock: StockDefinition },
  id: string,
  available: number,
): StockView {
  const status = stockStatus(object.stock, available);
  const base = { object: object.name, id, status };
  switch (object.stock.show) {
    case "exact":
      return { ...base, available };
    case "low":
      return status === "low" ? { ...base, available } : base;
    default:
      return base;
  }
}

async function readableBy(reader: Reader, object: ObjectDefinition, id: string): Promise<boolean> {
  try {
    const source = visibleSource(reader, object);
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const row = await (reader.db as any)
      .selectFrom(source)
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return Boolean(row);
  } catch {
    // The object does not exist for this caller.
    return false;
  }
}

/** The record's own number fields named by the declaration, read as the organisation. */
async function levels(
  reader: Reader,
  object: ObjectDefinition & { stock: StockDefinition },
  id: string,
): Promise<{ reorderAt: number | null; reorderQty: number | null }> {
  const columnOf = (name: string | undefined) =>
    name ? object.fields.find((f) => f.name === name)?.column : undefined;
  const at = columnOf(object.stock.reorderAt);
  const qty = columnOf(object.stock.reorderQty);
  if (!at && !qty) return { reorderAt: null, reorderQty: null };
  const columns = [...(at ? [sql.ref(at).as("at")] : []), ...(qty ? [sql.ref(qty).as("qty")] : [])];
  const row = (await orgReader(reader.db)
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    .db.selectFrom(object.source as any)
    .select(columns)
    .where("id", "=", id)
    .executeTakeFirst()) as { at?: unknown; qty?: unknown } | undefined;
  const num = (value: unknown) => (typeof value === "number" ? value : null);
  return { reorderAt: num(row?.at), reorderQty: num(row?.qty) };
}

/**
 * A record's stock for `reader`: the numbers for staff, what `show` allows for a customer or the
 * public. An object without stock, or a record not live, is not found.
 */
export async function readStock(reader: Reader, name: string, id: string): Promise<StockView> {
  const object = getObject(name);
  if (!object?.stock) throw unknownObject(name);
  const withStock = object as ObjectDefinition & { stock: StockDefinition };
  const live = (await orgReader(reader.db)
    .db.selectFrom(visibleTable(orgReader(reader.db), object, "t"))
    .select("t.deleted_at")
    .where("t.id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
  if (!live || live.deleted_at !== null) throw new NotFoundError(name, id);
  if (reader.principal.kind !== "staff" && !(await readableBy(reader, object, id))) {
    throw new NotFoundError(name, id);
  }
  const numbers = await readStockNumbers(reader.db, name, id);
  if (reader.principal.kind !== "staff") return outsideStockView(withStock, id, numbers.available);
  const level = await levels(reader, withStock, id);
  const recent = await reader.db
    .selectFrom("core_stock_movement")
    .select(["id", "kind", "quantity", "place", "at", "note"])
    .where("object_type", "=", name)
    .where("record_id", "=", id)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(STOCK_RECENT)
    .execute();
  return {
    object: name,
    id,
    status: stockStatus(object.stock, numbers.available),
    ...numbers,
    ...level,
    atReorderLevel: level.reorderAt !== null && numbers.onHand <= level.reorderAt,
    show: object.stock.show,
    lowAt: object.stock.lowAt ?? null,
    recent,
  };
}
