// The stock behaviour (stage 37, ADR 0680): a record of an object that declares `stock` has a
// number on hand that nobody types. It changes only by a movement in the ledger
// (core_stock_movement, migration 0930), written in the batch of the write that makes it, and
// the count lives on capacity's counter (core_capacity, migration 0440) so a sale is refused by
// the database past what is available, as a place is:
//
//   places   every unit in, less every unit out by a movement other than a sale
//   taken    every unit sold (an order line's claim, confirmed when the order is paid)
//   held     what unpaid orders hold
//
//   on hand = places - taken          available = on hand - held
//
// A movement other than a sale is three statements, with no read before them: the counter made if
// it is missing (a record made before its object had stock), its places moved by the signed
// quantity, then the ledger row. Taking places below what is held and sold is refused by
// migration 0440's trigger with the numbers, so a correction can never make held stock vanish. A
// sale is capacity's claim (orders/holds.ts) and writes its `sold` row in the paid batch, before
// the claim is confirmed (`soldStatement`).
//
// Every movement is at the one default place in this stage (STOCK_PLACE); stock in several places
// is designed in the spec and built later, without rewriting the ledger.
import type { CoreDatabase, StockMovementKind } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { setStockLookup, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";

setStockLookup((object) => Boolean(getObject(object)?.stock));

/** The place every movement is at until stock is kept in several places (ADR 0680). */
export const STOCK_PLACE = "default";

/** Statements per movement other than a sale: the counter made if missing, moved, the ledger row. */
export const MOVEMENT_STATEMENTS = 3;

/** What moved the stock: an order line, a record, or a person's own correction. */
export interface MovementSource {
  type: string;
  id: string;
}

/** One movement of a record's stock, other than a sale. */
export interface MovementInput {
  object: string;
  record: string;
  /** Signed: in is positive, out negative. Never 0. */
  quantity: number;
  kind: Exclude<StockMovementKind, "sold">;
  source: MovementSource;
  /** The staff account that made it; null for the host. */
  by: string | null;
  note?: string | null | undefined;
  /** Minor units, for what was received. */
  unitCost?: number | null | undefined;
  /** The movement's id, when the caller needs it (default a new stm_ id). */
  id?: string;
}

/**
 * The statements of one movement: the counter's places by the quantity, then the ledger row.
 * Queue them in the batch of the write that makes the movement. Too few on hand for what unpaid
 * orders hold fails the batch with the counter's refusal (errors.ts, `capacityRefusal`).
 */
export function movementStatements(
  input: MovementInput,
  now: string,
): { id: string; statements: CompiledQuery[] } {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) {
    throw new ValidationError("A stock movement is a whole number, not 0", {
      rule: "stock",
      object: input.object,
      record: input.record,
      quantity: input.quantity,
    });
  }
  const id = input.id ?? newId("stockMovement");
  return {
    id,
    statements: [
      // Not an upsert of the quantity: migration 0440's insert trigger would judge a negative one
      // before the conflict made it an update.
      stockCounterInsert(input.object, input.record, now),
      CompiledQuery.raw(
        "UPDATE core_capacity SET places = coalesce(places, 0) + ?, updated_at = ? WHERE object_type = ? AND record_id = ?",
        [input.quantity, now, input.object, input.record],
      ),
      CompiledQuery.raw(
        "INSERT INTO core_stock_movement (id, object_type, record_id, place, quantity, kind, source_type, source_id, by_user, at, note, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          input.object,
          input.record,
          STOCK_PLACE,
          input.quantity,
          input.kind,
          input.source.type,
          input.source.id,
          input.by,
          now,
          input.note ?? null,
          input.unitCost ?? null,
        ],
      ),
    ],
  };
}

/**
 * The one statement that writes a paid order's `sold` movements: one per held claim of the order
 * on a stock record, named after the claim (stm_ + its ULID) and sourced to its order line, with
 * no read before it. Queue it before the order's claims are confirmed, in the paid batch; a claim
 * already confirmed writes nothing again. Null when none of `objects` has stock.
 */
export function soldStatement(
  orderId: string,
  objects: readonly string[],
  now: string,
): CompiledQuery | null {
  const stocked = [...new Set(objects)].filter((o) => getObject(o)?.stock);
  if (!stocked.length) return null;
  return CompiledQuery.raw(
    `INSERT INTO core_stock_movement (id, object_type, record_id, place, quantity, kind, source_type, source_id, by_user, at, note, unit_cost) SELECT 'stm_' || substr(c.id, 5), c.object_type, c.record_id, ?, -c.quantity, 'sold', 'order_line', l.id, NULL, ?, NULL, NULL FROM core_capacity_claim c JOIN core_order_line l ON l.order_id = c.for_id AND l.object_type = c.object_type AND l.record_id = c.record_id WHERE c.for_type = 'order' AND c.for_id = ? AND c.state = 'held' AND c.object_type IN (${stocked.map(() => "?").join(", ")})`,
    [STOCK_PLACE, now, orderId, ...stocked],
  );
}

/** The statement that gives a new record of a stock object its counter, with nothing on hand. */
export function stockCounterInsert(object: string, record: string, now: string): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_capacity (object_type, record_id, places, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT (object_type, record_id) DO NOTHING",
    [object, record, now],
  );
}

/**
 * The statement that gives every record a JSON list names (`[{ "r": <id> }, …]`) a counter with
 * nothing on hand where it has none: the first statement of a record's stockMoves (moves.ts).
 */
export function stockCounterInsertMany(object: string, json: string, now: string): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_capacity (object_type, record_id, places, updated_at) SELECT DISTINCT ?, json_extract(value, '$.r'), 0, ? FROM json_each(?) WHERE true ON CONFLICT (object_type, record_id) DO NOTHING",
    [object, now, json],
  );
}

/** A counter with nothing on hand for an object's records that have none (an object gaining stock). */
export function backfillStockCounters(input: {
  object: string;
  table: string;
  now: string;
}): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_capacity (object_type, record_id, places, updated_at) SELECT ?, t.id, 0, ? FROM ${input.table} t WHERE true ON CONFLICT (object_type, record_id) DO NOTHING`,
    [input.object, input.now],
  );
}

/** A record's numbers, read from its counter: on hand, held and available. */
export interface StockNumbers {
  onHand: number;
  held: number;
  available: number;
}

export async function readStockNumbers(
  db: Kysely<CoreDatabase>,
  object: string,
  record: string,
): Promise<StockNumbers> {
  const row = await db
    .selectFrom("core_capacity")
    .select(["places", "held", "taken"])
    .where("object_type", "=", object)
    .where("record_id", "=", record)
    .executeTakeFirst();
  const onHand = Number(row?.places ?? 0) - Number(row?.taken ?? 0);
  const held = Number(row?.held ?? 0);
  return { onHand, held, available: Math.max(onHand - held, 0) };
}
