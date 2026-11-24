// The stock behaviour inside the record operations (stage 37, ADR 0682): a record of an object
// with stock gets its counter in the batch that creates it, with nothing in stock. Nothing a
// record write sets changes it afterwards: on hand moves only with a movement (stock/index.ts).
import { CompiledQuery } from "kysely";
import type { ObjectDefinition } from "../fields/types.ts";

/** The statement that gives a new record of an object with stock its counter, or null. */
export function stockCounterInsert(
  object: ObjectDefinition,
  id: string,
  now: string,
): CompiledQuery | null {
  if (!object.stock) return null;
  return CompiledQuery.raw(
    "INSERT INTO core_capacity (object_type, record_id, places, pool_object_type, pool_record_id, updated_at) VALUES (?, ?, 0, NULL, NULL, ?) ON CONFLICT (object_type, record_id) DO NOTHING",
    [object.name, id, now],
  );
}

/** The counter backfill for an object's records that have none (an object gaining stock). */
export function stockCounterBackfill(object: string, table: string, now: string): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_capacity (object_type, record_id, places, pool_object_type, pool_record_id, updated_at) SELECT ?, t.id, 0, NULL, NULL, ? FROM ${table} t WHERE true ON CONFLICT (object_type, record_id) DO NOTHING`,
    [object, now],
  );
}
