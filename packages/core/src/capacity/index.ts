// The capacity behaviour (stage 26, ADR 0430): a record has a number of places and the host never
// gives out more than there are, whoever asks and however many ask at once.
//
// There is no check-then-write. A claim is a fixed set of statements the caller queues in the
// batch of the write that needs it (an order, a booking), and the database refuses it:
//
//   1. `held = held + n` on the record's counter;
//   2. `held = held + n` on the counter of the record's pool, when it has one (one level only);
//   3. the claim row, copying the pool it drew on from the counter.
//
// Statement 1 or 2 going past its places fails (migration 0440's trigger and CHECK), so the batch
// fails and nothing in it is applied, including the order it was for. A claim on a record that
// has no counter fails statement 3's foreign key. Nothing is read first, so concurrent claims
// cannot both pass: D1 runs one statement at a time per database.
//
// The refusal (`invalid_input`, details { rule: "capacity", object, record, asked, available })
// is read from the database's message by toOperationError (errors.ts, `capacityRefusal`).
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type Kysely, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";

/** What a claim is taken for: an order line (stage 25), later a booking. */
export interface ClaimFor {
  type: string;
  id: string;
}

/** Places to claim from one record's capacity. */
export interface ClaimRequest {
  object: string;
  record: string;
  quantity: number;
  for: ClaimFor;
  /** The claim's id, when the caller needs it (default a new clm_ id). */
  id?: string;
}

/** The statements a claim adds to a batch, and the claim's id. */
export interface ClaimStatements {
  id: string;
  statements: Compilable[];
}

/** Statements per claim: the record's counter, its pool's counter and the claim row. */
export const CLAIM_STATEMENTS = 3;

/**
 * The statements that hold `quantity` places on a record (and on its pool) for `for`. Queue them
 * with `ctx.write` in the same batch as the write that needs them; the batch fails with a
 * capacity refusal (see `capacityRefusal`) when there are not enough places.
 */
export function claimStatements(
  db: Kysely<CoreDatabase>,
  request: ClaimRequest,
  now: string,
): ClaimStatements {
  const quantity = request.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ValidationError("A claim is for a whole number of places, at least 1", {
      rule: "capacity",
      object: request.object,
      record: request.record,
      asked: quantity,
    });
  }
  const id = request.id ?? newId("capacityClaim");
  const counter = () =>
    db
      .selectFrom("core_capacity")
      .where("object_type", "=", request.object)
      .where("record_id", "=", request.record);
  const statements: Compilable[] = [
    db
      .updateTable("core_capacity")
      .set({ held: sql<number>`held + ${quantity}`, updated_at: now })
      .where("object_type", "=", request.object)
      .where("record_id", "=", request.record),
    // The pool named on the record's counter, if any: no row matches when there is none.
    db
      .updateTable("core_capacity")
      .set({ held: sql<number>`held + ${quantity}`, updated_at: now })
      .where("object_type", "=", counter().select("pool_object_type"))
      .where("record_id", "=", counter().select("pool_record_id")),
    db.insertInto("core_capacity_claim").values({
      id,
      object_type: request.object,
      record_id: request.record,
      pool_object_type: counter().select("pool_object_type"),
      pool_record_id: counter().select("pool_record_id"),
      quantity,
      state: "held",
      for_type: request.for.type,
      for_id: request.for.id,
      created_at: now,
      updated_at: now,
    }),
  ];
  return { id, statements };
}

/** A counter for a record: its places (null is unlimited) and the pool it draws on. */
export interface CounterInput {
  object: string;
  record: string;
  places: number | null;
  pool?: { object: string; record: string } | null;
}

/** The statement that creates a record's counter, with nothing claimed. */
export function counterInsert(db: Kysely<CoreDatabase>, input: CounterInput, now: string) {
  return db.insertInto("core_capacity").values({
    object_type: input.object,
    record_id: input.record,
    places: input.places,
    pool_object_type: input.pool?.object ?? null,
    pool_record_id: input.pool?.record ?? null,
    updated_at: now,
  });
}
