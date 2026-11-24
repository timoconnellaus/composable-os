// The stock behaviour (stage 37, ADR 0682): goods the host counts, from a ledger nobody can change.
//
// A record of an object that declares `stock` has a counter on capacity's engine (core_capacity,
// migration 0440), made with the record: `places` is every unit that came in less every unit that
// went out other than by a sale, `taken` every unit sold, `held` what unpaid orders hold. So:
//
//   on hand   = places - taken          (the sum of the record's movements)
//   available = on hand - held          (what can be bought now)
//
// Capacity's statements do the rest unchanged. An order line holds its quantity (`held + n`,
// refused by the database past what is available: an oversell fails the order's batch whatever
// path it came by), confirms when paid (`held - n, taken + n`) and is released on cancel or
// expiry. A refund changes nothing: a stock line keeps its sale (orders/holds.ts).
//
// Every change of on hand is a movement (core_stock_movement, migration 0935), written in the same
// batch as the counter's change, with its kind, signed quantity, place, source and who. Nothing is
// read before the counter's statement: a removal past what is not held fails in the database (the
// counter's trigger), with the numbers, as a claim past the places does.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";

/** The kinds of movement. Steps after the first write `received`, `counted`, `returned` and more. */
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
 * The one place every movement is at, until stock in several places is built (decision 11). The
 * ledger carries it from the first migration, so no history is rewritten then.
 */
export const DEFAULT_STOCK_PLACE = "default";

/** The most one movement may move, either way. */
export const STOCK_QUANTITY_MAX = 1_000_000;

/** Who made a movement: a staff account, or the host carrying out a rule (a sale). */
export type StockMover = { account: string } | "host";

/** One movement of a record's stock by a whole number of units. */
export interface StockMovementRequest {
  object: string;
  record: string;
  /** Signed: what comes in is positive, what goes out negative. Never 0. */
  quantity: number;
  kind: StockMovementKind;
  by: StockMover;
  /** What it came from: an order line, a record. */
  source?: { type: string; id: string } | undefined;
  note?: string | null | undefined;
  /** Minor units, for `received` only. */
  unitCost?: number | null | undefined;
  /** The movement's id, when the caller needs it (default a new smv_ id). */
  id?: string | undefined;
}

/** Statements per movement: the ledger row and the counter. */
export const MOVEMENT_STATEMENTS = 2;

/**
 * The statements that move a record's stock by `quantity`: its ledger row, then its counter's
 * places. Queue them in the batch of the write that makes the movement. A removal that would leave
 * less on hand than unpaid orders hold fails the batch, with the numbers (errors.ts, stock's
 * refusal). The record must have a counter (made with it, or by the reconciler's backfill).
 */
export function movementStatements(
  db: Kysely<CoreDatabase>,
  request: StockMovementRequest,
  now: string,
): { id: string; statements: CompiledQuery[] } {
  const quantity = request.quantity;
  if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > STOCK_QUANTITY_MAX) {
    throw new ValidationError(
      `A stock movement is a whole number of units, not 0, at most ${STOCK_QUANTITY_MAX} either way`,
      { rule: "stock", object: request.object, record: request.record, quantity },
    );
  }
  const id = request.id ?? newId("stockMovement");
  // Written from the counter's row, so a record with no counter gets neither: the ledger and the
  // counter never disagree.
  const insert = CompiledQuery.raw(
    "INSERT INTO core_stock_movement (id, object_type, record_id, place_id, quantity, kind, source_type, source_id, made_by, made_as, note, unit_cost, created_at) SELECT ?, object_type, record_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM core_capacity WHERE object_type = ? AND record_id = ?",
    [
      id,
      DEFAULT_STOCK_PLACE,
      quantity,
      request.kind,
      request.source?.type ?? null,
      request.source?.id ?? null,
      request.by === "host" ? null : request.by.account,
      request.by === "host" ? "host" : "staff",
      request.note ?? null,
      request.unitCost ?? null,
      now,
      request.object,
      request.record,
    ],
  );
  const counter = db
    .updateTable("core_capacity")
    .set({ places: sql<number>`places + ${quantity}`, updated_at: now })
    .where("object_type", "=", request.object)
    .where("record_id", "=", request.record)
    .compile();
  return { id, statements: [insert, counter] };
}

/** The source type of a sale's movement: the order line it sold. */
export const ORDER_LINE_SOURCE = "order_line";

/**
 * The statement that writes a `sold` movement for each of an order's held claims on `objects`
 * (the order's lines whose objects declare stock), as the host. One statement, however many
 * lines: queue it in the paid batch **before** the claims are confirmed (it reads them while
 * held). Each movement takes its claim's ULID (`smv_<ulid of clm_…>`), so a claim is sold once:
 * a second confirm finds no held claim, and a repeated id is refused by the ledger.
 */
export function orderSoldStatement(
  orderId: string,
  claimType: string,
  objects: readonly string[],
  now: string,
): CompiledQuery | null {
  if (!objects.length) return null;
  const marks = objects.map(() => "?").join(", ");
  return CompiledQuery.raw(
    `INSERT INTO core_stock_movement (id, object_type, record_id, place_id, quantity, kind, source_type, source_id, made_by, made_as, note, unit_cost, created_at) SELECT 'smv_' || substr(c.id, instr(c.id, '_') + 1), c.object_type, c.record_id, ?, -c.quantity, 'sold', ?, l.id, NULL, 'host', NULL, NULL, ? FROM core_capacity_claim c JOIN core_order_line l ON l.order_id = c.for_id AND l.object_type = c.object_type AND l.record_id = c.record_id WHERE c.for_type = ? AND c.for_id = ? AND c.state = 'held' AND c.object_type IN (${marks})`,
    [DEFAULT_STOCK_PLACE, ORDER_LINE_SOURCE, now, claimType, orderId, ...objects],
  );
}
