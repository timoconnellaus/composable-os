// stockMoves (stage 37 step 2, ADR 0681): a record's state moves stock. An object declares that
// when its record enters a state (`when`), the host writes a movement of its quantity on the
// record its relation `on` points to: a receipt received adds, a write-off removes, a count line
// sets on hand to the number counted. With `through`, the state is another record's (a count's
// `applied`) and every live line pointing to it moves in its batch. The transition engine
// (records/lifecycle.ts) calls `stockMovesOnMove` on every move, for every actor, so the movement
// commits in the batch of the write that makes the move, or not at all.
//
// However many lines move, it is three statements, with the lines as one JSON parameter:
//
//   add, remove   the counters made if missing; each counter's places moved by its lines' sum;
//                 a ledger row per line
//   set           the counters made if missing; a `counted` row per line whose number differs
//                 from on hand as the batch commits (by that difference); each counter's places
//                 set so on hand is the number counted
//
// A count is judged at the commit, not when its lines were read: a sale between the read and the
// commit is counted in the difference. Too few on hand for a remove, or a count below what unpaid
// orders hold, fails the batch with the counter's refusal and its numbers (errors.ts, `rule:
// "stock"`, migration 0440's trigger). Once a record has moved stock, the fields that fed the
// movement cannot change, and a moved record's lines cannot be added or changed
// (`assertStockMovesKept`): the ledger keeps what moved.
import { CompiledQuery, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { fieldStorage, objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition, StockMovesDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { enteredBy } from "../records/transitions.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import { STOCK_PLACE, stockCounterInsertMany } from "./index.ts";
import { watchLow } from "./low.ts";

/** The most lines one record's move moves (a count's lines): its JSON stays well under D1's limits. */
export const STOCK_MOVES_MAX_LINES = 500;

/** Statements one move writes, whatever the number of lines. */
export const STOCK_MOVES_STATEMENTS = 3;

/** One line of a move: the record whose values moved stock, and what they say. */
export interface StockMoveLine {
  /** The record that moved it (the receipt, the count line): the movement's source. */
  source: string;
  /** The stock record that moves. */
  record: string;
  quantity: number;
  unitCost: number | null;
  note: string | null;
}

/** A relation's stored value as an id (a relation may be read as `{ id }`). */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

const labelOf = (object: ObjectDefinition, field: string) =>
  object.fields.find((f) => f.name === field)?.label ?? field;

function refuse(object: ObjectDefinition, field: string, message: string, extra = {}): never {
  throw new ValidationError(message, {
    rule: "stock_moves",
    object: object.name,
    field,
    ...extra,
  });
}

/** One line as `object`'s declaration reads it from `values`, checked. */
function lineOf(
  object: ObjectDefinition,
  moves: StockMovesDefinition,
  source: string,
  values: Record<string, unknown>,
): StockMoveLine {
  const record = idOf(values[moves.on]);
  if (!record) {
    refuse(object, moves.on, `${object.label} needs ${labelOf(object, moves.on)} to move stock`, {
      record: source,
    });
  }
  const quantity = values[moves.quantity];
  const least = moves.move === "set" ? 0 : 1;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < least) {
    refuse(
      object,
      moves.quantity,
      moves.move === "set"
        ? `${object.label} needs ${labelOf(object, moves.quantity)}: a whole number, 0 or more`
        : `${object.label} needs ${labelOf(object, moves.quantity)}: a whole number above 0`,
      { record: source },
    );
  }
  const cost = moves.unitCost ? values[moves.unitCost] : null;
  if (cost !== null && cost !== undefined && (!Number.isInteger(cost) || (cost as number) < 0)) {
    refuse(
      object,
      moves.unitCost as string,
      `${labelOf(object, moves.unitCost as string)} is a whole number of minor units, 0 or more`,
      { record: source },
    );
  }
  const note = moves.note ? values[moves.note] : null;
  return {
    source,
    record,
    quantity,
    unitCost: typeof cost === "number" ? cost : null,
    note: typeof note === "string" && note.trim() ? note.slice(0, 500) : null,
  };
}

/**
 * The statements of one move of `lines` (see the header), for the batch of the write that makes
 * it. `object` is the stock object; `source` the object whose records moved it.
 */
export function stockMoveStatements(input: {
  object: string;
  source: string;
  move: StockMovesDefinition["move"];
  kind: StockMovesDefinition["kind"];
  lines: readonly StockMoveLine[];
  by: string | null;
  now: string;
}): CompiledQuery[] {
  const { object, now } = input;
  const json = JSON.stringify(
    input.lines.map((line) => ({
      m: newId("stockMovement"),
      s: line.source,
      r: line.record,
      q: line.quantity,
      c: line.unitCost,
      n: line.note,
    })),
  );
  const at = (key: string) => `json_extract(j.value, '$.${key}')`;
  const records = "SELECT json_extract(value, '$.r') FROM json_each(?)";
  const counters = stockCounterInsertMany(object, json, now);
  if (input.move === "set") {
    return [
      counters,
      // Each line's difference from on hand at this point of the batch, where there is one.
      CompiledQuery.raw(
        `INSERT INTO core_stock_movement (id, object_type, record_id, place, quantity, kind, source_type, source_id, by_user, at, note, unit_cost) SELECT ${at("m")}, ?, c.record_id, ?, ${at("q")} - (coalesce(c.places, 0) - c.taken), ?, ?, ${at("s")}, ?, ?, ${at("n")}, NULL FROM json_each(?) j JOIN core_capacity c ON c.object_type = ? AND c.record_id = ${at("r")} WHERE ${at("q")} - (coalesce(c.places, 0) - c.taken) <> 0`,
        [object, STOCK_PLACE, input.kind, input.source, input.by, now, json, object],
      ),
      CompiledQuery.raw(
        `UPDATE core_capacity SET places = taken + (SELECT ${at("q")} FROM json_each(?) j WHERE ${at("r")} = core_capacity.record_id), updated_at = ? WHERE object_type = ? AND record_id IN (${records})`,
        [json, now, object, json],
      ),
    ];
  }
  const sign = input.move === "add" ? 1 : -1;
  return [
    counters,
    CompiledQuery.raw(
      `UPDATE core_capacity SET places = coalesce(places, 0) + ? * (SELECT sum(${at("q")}) FROM json_each(?) j WHERE ${at("r")} = core_capacity.record_id), updated_at = ? WHERE object_type = ? AND record_id IN (${records})`,
      [sign, json, now, object, json],
    ),
    CompiledQuery.raw(
      `INSERT INTO core_stock_movement (id, object_type, record_id, place, quantity, kind, source_type, source_id, by_user, at, note, unit_cost) SELECT ${at("m")}, ?, ${at("r")}, ?, ? * ${at("q")}, ?, ?, ${at("s")}, ?, ?, ${at("n")}, ${at("c")} FROM json_each(?) j`,
      [object, STOCK_PLACE, sign, input.kind, input.source, input.by, now, json],
    ),
  ];
}

/** Queues one move's statements and its low-stock check. */
function queueMove(
  ctx: HandlerContext,
  object: ObjectDefinition,
  moves: StockMovesDefinition,
  lines: readonly StockMoveLine[],
): void {
  if (!lines.length) return;
  if (moves.move === "set") {
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.record)) {
        refuse(
          object,
          moves.on,
          `${labelOf(object, moves.on)} ${line.record} is counted twice: count it on one line`,
          { record: line.record },
        );
      }
      seen.add(line.record);
    }
  }
  ctx.write(
    ...stockMoveStatements({
      object: moves.object,
      source: object.name,
      move: moves.move,
      kind: moves.kind,
      lines,
      by: enteredBy(ctx),
      now: ctx.now,
    }),
  );
  watchLow(
    ctx,
    moves.object,
    lines.map((l) => l.record),
  );
}

/** Objects whose lines a record of `object` entering `state` moves (their `stockMoves.through`). */
function linesMovedBy(object: string, state: string): ObjectDefinition[] {
  return listObjects().filter(
    (o) => o.stockMoves?.throughObject === object && o.stockMoves.when === state,
  );
}

/**
 * Queues the stock a record's move moves (ADR 0681): its own, when its object declares
 * `stockMoves` for the state entered, and its lines', for each object whose `stockMoves` goes
 * `through` this one to that state. Called by the transition engine on every move.
 */
export async function stockMovesOnMove(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  after: Record<string, unknown>,
  entered: string,
): Promise<void> {
  const own = object.stockMoves;
  if (own && !own.through && own.when === entered) {
    queueMove(ctx, object, own, [lineOf(object, own, id, after)]);
  }
  for (const lineObject of linesMovedBy(object.name, entered)) {
    const moves = lineObject.stockMoves as StockMovesDefinition;
    const column = (field: string | undefined) => {
      const found = field ? lineObject.fields.find((f) => f.name === field)?.column : undefined;
      if (field && !found) throw new ValidationError(`${lineObject.label} cannot read ${field}`);
      return found;
    };
    const read: [string, string | undefined][] = [
      ["r", column(moves.on)],
      ["q", column(moves.quantity)],
      ["c", column(moves.unitCost)],
      ["n", column(moves.note)],
    ];
    const through = sql.ref(column(moves.through) as string);
    const rows = (
      await sql<Record<string, unknown>>`SELECT id, updated_at AS u, ${sql.join(
        read.map(([as, col]) =>
          col ? sql`${sql.ref(col)} AS ${sql.ref(as)}` : sql`NULL AS ${sql.ref(as)}`,
        ),
      )} FROM ${sql.table(lineObject.source)} WHERE ${through} = ${id} ORDER BY id LIMIT ${STOCK_MOVES_MAX_LINES + 1}`.execute(
        ctx.db,
      )
    ).rows;
    if (rows.length > STOCK_MOVES_MAX_LINES) {
      refuse(
        lineObject,
        moves.through as string,
        `${object.label} has more than ${STOCK_MOVES_MAX_LINES} ${lineObject.plural?.toLowerCase() ?? "lines"}: split it into several`,
        { record: id, most: STOCK_MOVES_MAX_LINES },
      );
    }
    const values = (row: Record<string, unknown>) => ({
      [moves.on]: row.r,
      [moves.quantity]: row.q,
      ...(moves.unitCost ? { [moves.unitCost]: row.c } : {}),
      ...(moves.note ? { [moves.note]: row.n } : {}),
    });
    queueMove(
      ctx,
      lineObject,
      moves,
      rows.map((row) => lineOf(lineObject, moves, String(row.id), values(row))),
    );
    // The lines moved are the lines there are at the commit (the review of #422): a line added,
    // edited, sent to Trash or restored after the read fails this batch (`moved_meanwhile`, a
    // conflict: look again). An `unmoved` guard that can never hold (a history count is never
    // -1), inserted only when the lines' count or latest change differs from what was read.
    const latest = rows.reduce((m, row) => (String(row.u) > m ? String(row.u) : m), "");
    ctx.write(
      sql`INSERT INTO core_write_guard (kind, object_type, record_id, expected) SELECT 'unmoved', ${object.name}, ${id}, -1 WHERE (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM ${sql.table(lineObject.source)} WHERE ${through} = ${id}) IS NOT ${`${rows.length}:${latest}`}`.compile(
        ctx.db,
      ),
    );
  }
}

/** The fields of a stockMoves declaration that fed a movement. */
function movedFields(moves: StockMovesDefinition): string[] {
  return [moves.on, moves.quantity, moves.unitCost, moves.note, moves.through].filter(
    (f): f is string => f !== undefined,
  );
}

/**
 * Refuses a write that would make the ledger disagree with what moved it (ADR 0681): changing
 * the fields that fed a movement of a record that has moved stock (it is in its `when`, which
 * nothing leaves), or adding or changing a line of a record that has.
 */
export async function assertStockMovesKept(
  ctx: HandlerContext,
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  written: Record<string, unknown>,
): Promise<void> {
  const moves = object.stockMoves;
  if (!moves) return;
  const changed = movedFields(moves).filter(
    (field) =>
      Object.hasOwn(written, field) &&
      JSON.stringify(idOrValue(written[field])) !== JSON.stringify(idOrValue(before?.[field])),
  );
  if (!moves.through) {
    const field = object.states?.field;
    if (before && field && before[field] === moves.when && changed.length) {
      refuse(
        object,
        changed[0] as string,
        `${object.label} has moved stock: its ${changed.map((f) => labelOf(object, f).toLowerCase()).join(", ")} cannot change`,
      );
    }
    return;
  }
  if (before !== null && !changed.length) return;
  await assertParentsOpen(ctx, object, moves, [
    idOf(Object.hasOwn(written, moves.through) ? written[moves.through] : before?.[moves.through]),
    idOf(before?.[moves.through]),
  ]);
}

/**
 * Refuses restoring a line from the Trash onto a record that has moved stock (the review of
 * #422): it would sit under it, never moved. Called by record.restore.
 */
export async function assertStockLineRestorable(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  const moves = object.stockMoves;
  if (!moves?.through) return;
  const column = fieldStorage(object.name, moves.through)?.column;
  const table = objectTableOf(object.name);
  if (!column || !table) return;
  const row = await sql<{
    p: unknown;
  }>`SELECT ${sql.ref(column)} AS p FROM ${sql.table(table)} WHERE id = ${id}`.execute(ctx.db);
  await assertParentsOpen(ctx, object, moves, [idOf(row.rows[0]?.p)]);
}

/**
 * Refuses a line's write onto a record of `moves.throughObject` that has moved stock, and queues
 * a guard that fails the write's batch if one moves before it commits (an `unmoved` guard on its
 * state history, migration 0670): a line is never added or changed under a count being applied.
 */
async function assertParentsOpen(
  ctx: HandlerContext,
  object: ObjectDefinition,
  moves: StockMovesDefinition,
  ids: readonly (string | null)[],
): Promise<void> {
  const parentObject = moves.throughObject ? getObject(moves.throughObject) : undefined;
  const stateField = parentObject?.states?.field;
  const column = parentObject?.fields.find((f) => f.name === stateField)?.column;
  if (!parentObject || !column) return;
  const parents = ids.filter((p): p is string => p !== null);
  // One read per parent per call: a call adding many lines to one count reads it once.
  let open = openParents.get(ctx.write);
  if (!open) {
    open = new Set<string>();
    openParents.set(ctx.write, open);
  }
  const unread = [...new Set(parents)].filter((p) => !open.has(`${parentObject.name}:${p}`));
  if (!unread.length) return;
  const read = await sql<{
    id: string;
    moved: number;
    n: number;
  }>`SELECT p.id, p.${sql.ref(column)} = ${moves.when} AS moved, (SELECT count(*) FROM core_transition_history h WHERE h.object_type = ${parentObject.name} AND h.record_id = p.id) AS n FROM ${sql.table(parentObject.source)} p WHERE p.id IN (${sql.join(unread)})`.execute(
    ctx.db,
  );
  const moved = read.rows.find((r) => Number(r.moved) === 1);
  if (moved) {
    refuse(
      object,
      moves.through as string,
      `${parentObject.label} has moved stock: its ${object.plural?.toLowerCase() ?? "lines"} cannot be added or changed`,
      { record: moved.id },
    );
  }
  for (const r of read.rows)
    ctx.write(guardStatement("unmoved", parentObject.name, r.id, Number(r.n)));
  for (const p of unread) open.add(`${parentObject.name}:${p}`);
}

/** Parents read as not yet moved, per call. */
const openParents = new WeakMap<object, Set<string>>();

const idOrValue = (value: unknown) => idOf(value) ?? value ?? null;
