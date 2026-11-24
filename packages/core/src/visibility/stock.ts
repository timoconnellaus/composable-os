// What a caller may know of a record's stock (stage 37, ADR 0682). Staff see the numbers: on hand,
// held while buyers pay, available, the reorder level and the last movements. A customer or the
// public is told only what the object's `show` allows, worked out here, in the host: by default
// in stock or sold out (`availability`), "only N left" at or below `lowAt` (`low`), or the number
// available (`exact`). Never on hand, held or a movement.
//
// As for places (ADR 0438), an outside caller asks only about a record they may read: a published
// variant the public scope shows them, or one of their own. Any other is not found.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, StockDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { DEFAULT_STOCK_PLACE, type StockMovementKind } from "../stock/index.ts";
import { readableBy } from "./capacity.ts";
import { unknownObject } from "./customer.ts";
import { orgReader, type Reader, visibleTable } from "./index.ts";

export type StockStatus = "in_stock" | "low" | "sold_out";

/** One movement, as staff read it. */
export interface StockMovementView {
  id: string;
  kind: StockMovementKind;
  quantity: number;
  place: string;
  source: { type: string; id: string } | null;
  /** The staff account that made it; null when the host did (a sale). */
  madeBy: string | null;
  madeAs: "staff" | "host";
  note: string | null;
  /** Minor units, on a receipt. */
  unitCost: number | null;
  at: string;
}

/** stock.get's answer. Outside callers get `status` and at most `available`. */
export interface StockView {
  object: string;
  id: string;
  status: StockStatus;
  available?: number;
  onHand?: number;
  held?: number;
  place?: string;
  show?: StockDefinition["show"];
  lowAt?: number | null;
  /** The record's reorder level and quantity (its fields), when the object names them. */
  reorderAt?: number | null;
  reorderQty?: number | null;
  /** On hand is at or below the reorder level. */
  low?: boolean;
  movements?: StockMovementView[];
}

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

/** The object, which must declare stock; otherwise the unknown-object answer. */
export function stockObject(name: string): ObjectDefinition & { stock: StockDefinition } {
  const object = getObject(name);
  if (!object?.stock) throw unknownObject(name);
  return object as ObjectDefinition & { stock: StockDefinition };
}

/** How many movements stock.get shows staff. */
export const STOCK_GET_MOVEMENTS = 10;

/**
 * A record's stock for `reader`: everything for staff, what `show` allows for a customer or the
 * public. An object without stock, or a record not live, is not found.
 */
export async function readStock(reader: Reader, name: string, id: string): Promise<StockView> {
  const object = stockObject(name);
  const org = orgReader(reader.db);
  if (reader.principal.kind !== "staff") {
    const live = await org.db
      .selectFrom(visibleTable(org, object, "t"))
      .select("t.deleted_at")
      .where("t.id", "=", id)
      .executeTakeFirst();
    if (!live || live.deleted_at !== null || !(await readableBy(reader, object, id))) {
      throw new NotFoundError(name, id);
    }
    const counter = await reader.db
      .selectFrom("core_capacity")
      .select(["places", "held", "taken"])
      .where("object_type", "=", name)
      .where("record_id", "=", id)
      .executeTakeFirst();
    const available = counter
      ? Math.max(Number(counter.places ?? 0) - counter.taken - counter.held, 0)
      : 0;
    return outsideStockView(object, id, available);
  }
  const numbers = await staffNumbers(reader.db, object, id);
  return {
    object: name,
    id,
    status: stockStatus(object.stock, numbers.available),
    ...numbers,
    place: DEFAULT_STOCK_PLACE,
    show: object.stock.show,
    lowAt: object.stock.lowAt ?? null,
    movements: (await stockMovements(reader.db, name, id, { limit: STOCK_GET_MOVEMENTS })).items,
  };
}

/** The numbers staff see: one read of the record's view (its stock columns and reorder fields). */
async function staffNumbers(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition & { stock: StockDefinition },
  id: string,
) {
  const column = (name: string | undefined) => {
    const field = name ? object.fields.find((f) => f.name === name) : undefined;
    return field ? viewColumnOf(field) : null;
  };
  const columns = {
    onHand: column("onHand"),
    held: column("held"),
    available: column("available"),
    reorderAt: column(object.stock.reorderAt),
    reorderQty: column(object.stock.reorderQty),
  };
  const selected = Object.entries(columns).flatMap(([as, col]) =>
    col ? [`"${col.replaceAll('"', '""')}" AS "${as}"`] : [],
  );
  const row = (
    await sql<
      Record<string, unknown>
    >`SELECT ${sql.raw(selected.join(", "))} FROM ${sql.table(object.source)} WHERE id = ${id}`.execute(
      db,
    )
  ).rows[0];
  if (!row) throw new NotFoundError(object.name, id);
  const number = (value: unknown) =>
    value === null || value === undefined || value === "" ? null : Number(value);
  const onHand = number(row.onHand) ?? 0;
  const reorderAt = number(row.reorderAt);
  return {
    onHand,
    held: number(row.held) ?? 0,
    available: number(row.available) ?? 0,
    reorderAt,
    reorderQty: number(row.reorderQty),
    low: reorderAt !== null && onHand <= reorderAt,
  };
}

/**
 * A live record's counter as it is now, for a staff write about to move it (stock.opening,
 * stock.adjust): on hand, held, and whether it has its opening stock. A record in the Trash, or
 * one with no counter, is not found.
 */
export async function liveStockCounter(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition & { stock: StockDefinition },
  id: string,
): Promise<{ onHand: number; held: number; hasOpening: boolean }> {
  const org = orgReader(db);
  const live = await org.db
    .selectFrom(visibleTable(org, object, "t"))
    .select("t.deleted_at")
    .where("t.id", "=", id)
    .executeTakeFirst();
  const row = await db
    .selectFrom("core_capacity as c")
    .select([
      "c.places",
      "c.held",
      "c.taken",
      (eb) =>
        eb
          .exists(
            eb
              .selectFrom("core_stock_movement as m")
              .select("m.id")
              .whereRef("m.object_type", "=", "c.object_type")
              .whereRef("m.record_id", "=", "c.record_id")
              .where("m.kind", "=", "opening"),
          )
          .as("opening"),
    ])
    .where("c.object_type", "=", object.name)
    .where("c.record_id", "=", id)
    .executeTakeFirst();
  if (!live || live.deleted_at !== null || !row) throw new NotFoundError(object.name, id);
  return {
    onHand: Number(row.places ?? 0) - row.taken,
    held: row.held,
    hasOpening: Boolean(row.opening),
  };
}

/** A page of a record's movements, newest first. The cursor is opaque. */
export async function stockMovements(
  db: Kysely<CoreDatabase>,
  object: string,
  id: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<{ items: StockMovementView[]; nextCursor: string | null }> {
  let query = db
    .selectFrom("core_stock_movement")
    .selectAll()
    .where("object_type", "=", object)
    .where("record_id", "=", id);
  if (options.cursor) {
    const [at, last] = decodeCursor(options.cursor);
    query = query.where((eb) =>
      eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", last)])]),
    );
  }
  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(options.limit + 1)
    .execute();
  const page = rows.slice(0, options.limit);
  const tail = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      quantity: row.quantity,
      place: row.place_id,
      source:
        row.source_type && row.source_id ? { type: row.source_type, id: row.source_id } : null,
      madeBy: row.made_by,
      madeAs: row.made_as,
      note: row.note,
      unitCost: row.unit_cost,
      at: row.created_at,
    })),
    nextCursor: rows.length > options.limit && tail ? encodeCursor(tail.created_at, tail.id) : null,
  };
}

function encodeCursor(at: string, id: string): string {
  return btoa(JSON.stringify([at, id]));
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const parsed = JSON.parse(atob(cursor)) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Not one of ours: refused below.
  }
  throw new ValidationError("Not a cursor stock.movements gave", { field: "cursor" });
}
