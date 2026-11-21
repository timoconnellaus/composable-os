// The capacity behaviour inside the record operations (stage 26, ADR 0431): record.create,
// record.update and the record CSV import keep a record's counter in step with its places and
// pool fields, in the batch of the write, so the rule holds for every actor (people, MCP
// clients, extensions, automations, imports, approved actions). Lowering places below what is
// held and taken is refused by the database (migration 0440's trigger), with the numbers.
//
// Claimants (stage 25's orders, later bookings) call `queueClaim`. Outside a dry run it only
// queues claimStatements; in the approval queue's dry run, whose writes are discarded, it reports
// against the counter as it is and claims nothing. The approved action claims when it runs and
// may be refused then.
import { CompiledQuery } from "kysely";
import { ValidationError } from "../errors.ts";
import type { CapacityDefinition, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { type ClaimRequest, claimStatements } from "./index.ts";

/** A counter row and its pool's, as read for a dry run or for capacity.get. */
export interface CounterRead {
  places: number | null;
  held: number;
  taken: number;
  pool_object_type: string | null;
  pool_record_id: string | null;
  pool_places: number | null;
  pool_held: number | null;
  pool_taken: number | null;
}

/** One read: the record's counter joined with its pool's (both by primary key). */
export async function readCounter(
  db: HandlerContext["db"],
  object: string,
  record: string,
): Promise<CounterRead | undefined> {
  return db
    .selectFrom("core_capacity as c")
    .leftJoin("core_capacity as p", (join) =>
      join
        .onRef("p.object_type", "=", "c.pool_object_type")
        .onRef("p.record_id", "=", "c.pool_record_id"),
    )
    .select([
      "c.places",
      "c.held",
      "c.taken",
      "c.pool_object_type",
      "c.pool_record_id",
      "p.places as pool_places",
      "p.held as pool_held",
      "p.taken as pool_taken",
    ])
    .where("c.object_type", "=", object)
    .where("c.record_id", "=", record)
    .executeTakeFirst();
}

function left(places: number | null, held: number, taken: number): number | null {
  return places === null ? null : Math.max(places - held - taken, 0);
}

/** What a dry run has already claimed, per counter, so two lines on one counter add up. */
const simulated = new WeakMap<object, Map<string, number>>();

/**
 * Queues a claim in the handler's batch. In the approval queue's dry run it claims nothing and
 * throws the refusal the database would give, judged against the counter as it is now.
 */
export async function queueClaim(ctx: HandlerContext, request: ClaimRequest): Promise<string> {
  const { id, statements } = claimStatements(ctx.db, request, ctx.now);
  if (ctx.simulation) {
    await simulateClaim(ctx, request);
    return id;
  }
  ctx.write(...statements);
  return id;
}

async function simulateClaim(ctx: HandlerContext, request: ClaimRequest): Promise<void> {
  const row = await readCounter(ctx.db, request.object, request.record);
  if (!row) throw new ValidationError("A referenced record does not exist");
  const seen = simulated.get(ctx) ?? new Map<string, number>();
  simulated.set(ctx, seen);
  const levels = [
    {
      object: request.object,
      record: request.record,
      left: left(row.places, row.held, row.taken),
    },
    ...(row.pool_object_type && row.pool_record_id
      ? [
          {
            object: row.pool_object_type,
            record: row.pool_record_id,
            left: left(row.pool_places, row.pool_held ?? 0, row.pool_taken ?? 0),
          },
        ]
      : []),
  ];
  for (const level of levels) {
    const key = `${level.object}|${level.record}`;
    const already = seen.get(key) ?? 0;
    const available = level.left === null ? null : Math.max(level.left - already, 0);
    if (available !== null && request.quantity > available) {
      throw new ValidationError(
        `Not enough places: asked for ${request.quantity}, ${available} left`,
        {
          rule: "capacity",
          object: level.object,
          record: level.record,
          asked: request.quantity,
          available,
        },
      );
    }
  }
  for (const level of levels) {
    const key = `${level.object}|${level.record}`;
    seen.set(key, (seen.get(key) ?? 0) + request.quantity);
  }
}

/** The places a write gives, validated: a whole number from 0, or null (unlimited). */
function placesOf(object: ObjectDefinition, capacity: CapacityDefinition, value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${object.label}: places must be a whole number from 0, or empty for unlimited`,
      { field: capacity.places, rule: "capacity" },
    );
  }
  return value;
}

/**
 * The statement that keeps a record's counter in step with its places and pool fields, or null
 * when the write touches neither (on update). Queue it after the record's own write. `after` is
 * the record's values after the write; `changed` the fields it sets.
 */
export async function counterWrite(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  after: Record<string, unknown>,
  changed: readonly string[] | "create",
): Promise<CompiledQuery | null> {
  const capacity = object.capacity;
  if (!capacity) return null;
  const touches =
    changed === "create" ||
    changed.includes(capacity.places) ||
    (capacity.pool !== undefined && changed.includes(capacity.pool.field));
  if (!touches) return null;
  const places = placesOf(object, capacity, after[capacity.places]);
  const poolId = capacity.pool ? after[capacity.pool.field] : null;
  const pool =
    capacity.pool && typeof poolId === "string" && poolId
      ? { object: capacity.pool.object, record: poolId }
      : null;
  if (changed !== "create" && ctx.simulation) {
    // The dry run writes nothing, so say now what the database would refuse.
    const row = await readCounter(ctx.db, object.name, id);
    if (row && places !== null && row.held + row.taken > places) {
      throw new ValidationError(
        `Places cannot be fewer than are claimed: ${row.held} held and ${row.taken} taken`,
        {
          rule: "capacity",
          object: object.name,
          record: id,
          places,
          held: row.held,
          taken: row.taken,
        },
      );
    }
  }
  // An upsert: a record made before its object declared a capacity gets its counter here too.
  return CompiledQuery.raw(
    "INSERT INTO core_capacity (object_type, record_id, places, pool_object_type, pool_record_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET places = excluded.places, pool_object_type = excluded.pool_object_type, pool_record_id = excluded.pool_record_id, updated_at = excluded.updated_at",
    [object.name, id, places, pool?.object ?? null, pool?.record ?? null, ctx.now],
  );
}

/**
 * Refuses moving a record with confirmed claims to Trash: people have paid for its places.
 * Trash releases nothing by itself; held claims stay held until what they were taken for
 * releases them.
 */
export async function assertNoConfirmedClaims(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  if (!object.capacity) return;
  const row = await ctx.db
    .selectFrom("core_capacity")
    .select("taken")
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .executeTakeFirst();
  if (row && row.taken > 0) {
    throw new ValidationError(
      `${object.label} has ${row.taken} places taken by paid orders and cannot be deleted`,
      { rule: "capacity", object: object.name, record: id, taken: row.taken },
    );
  }
}

/** The statements that delete an object's counters and claims, when its table is dropped. */
export function dropCapacityStatements(object: string): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_capacity_claim WHERE object_type = ?", [object]),
    CompiledQuery.raw("DELETE FROM core_capacity WHERE object_type = ?", [object]),
  ];
}

/** The counter backfill for an object's records that have none (an object gaining a capacity). */
export function backfillCounters(input: {
  object: string;
  table: string;
  placesColumn: string;
  pool?: { column: string; object: string } | undefined;
  now: string;
}): CompiledQuery {
  const places = `CASE WHEN typeof(t.${input.placesColumn}) IN ('integer', 'real') AND t.${input.placesColumn} >= 0 THEN CAST(t.${input.placesColumn} AS INTEGER) END`;
  const poolRecord = input.pool
    ? `(SELECT p.record_id FROM core_capacity p WHERE p.object_type = ? AND p.record_id = t.${input.pool.column})`
    : "NULL";
  const poolObject = input.pool ? `CASE WHEN ${poolRecord} IS NULL THEN NULL ELSE ? END` : "NULL";
  const params = input.pool
    ? [input.object, input.pool.object, input.pool.object, input.pool.object, input.now]
    : [input.object, input.now];
  return CompiledQuery.raw(
    `INSERT INTO core_capacity (object_type, record_id, places, pool_object_type, pool_record_id, updated_at) SELECT ?, t.id, ${places}, ${poolObject}, ${poolRecord}, ? FROM ${input.table} t WHERE true ON CONFLICT (object_type, record_id) DO NOTHING`,
    params,
  );
}
