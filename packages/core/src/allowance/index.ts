// The allowance behaviour's statements (stage 32b, ADR 0493): a holder's terms, a spend and a
// give-back, each a fixed set of statements queued in the batch of the write that needs them.
//
// There is no check-then-write. A spend is three statements with no read of the count first:
//
//   1. the holder's counter for the period, made at nought if it is the period's first use, with
//      the limit copied from the holder's terms;
//   2. `used = used + 1` on it, refused by migration 0533's trigger past the limit;
//   3. the use row, refused by its trigger when the holder is not the spender's Person's, is not
//      live, its Person is in the Trash, or it is not valid at the spender's time.
//
// Either refusal fails the batch, so nothing in it is applied, the spender's own write included.
// D1 runs one statement at a time per database, so concurrent spends cannot both take the last
// use. A give-back is two statements (the counter down by what the spender's open use counted,
// then the use marked returned), idempotent: the second time no open use matches.
//
// A holder's terms are derived in SQL from its stored record (`termsSyncStatements`), queued after
// the record's own write, so the row always says what the record says after the batch, however
// many writes race (ADR 0494).
//
// The refusal (`invalid_input`, details { rule: "allowance", reason, … }) is read from the
// database's message by toOperationError (errors.ts, `allowanceRefusal`).
import { CompiledQuery } from "kysely";
import { newId } from "../ids.ts";
import type { RecordRef } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import type { AllowancePer, AllowancePeriod } from "./periods.ts";

export {
  type AllowancePer,
  type AllowancePeriod,
  boundOf as allowanceBoundOf,
  periodOf as allowancePeriodOf,
} from "./periods.ts";

/** Statements per spend and per give-back (whatever the holder). */
export const SPEND_STATEMENTS = 3;
export const RETURN_STATEMENTS = 2;

/** Where a holder's term fields are stored, and what its declaration fixes. */
export interface HolderStorage {
  object: string;
  /** The object's own table (quoted identifier). */
  table: string;
  person: string;
  uses: string;
  /** A fixed period, or the column of the select field that holds it. */
  per: { fixed: AllowancePer } | { column: string };
  from?: { column: string; date: boolean } | undefined;
  until?: { column: string; date: boolean } | undefined;
  zone?: string | undefined;
  /** The state column and the live states, or none (always live). */
  live?: { column: string; states: readonly string[] } | undefined;
  emptyIsUnlimited: boolean;
}

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The statements that derive holders' terms from their stored records: one holder (`id`), or
 * every record of the object (the reconciler's backfill when a declaration is installed or
 * changes). Then the current and future periods' limits follow the terms, the real limit.
 * `orgZone` is the zone a holder with no zone of its own is given when its terms are first
 * written; after that it keeps the zone it had.
 */
export function termsSyncStatements(
  storage: HolderStorage,
  target: { id: string } | "all",
  orgZone: string,
  now: string,
): CompiledQuery[] {
  const t = (column: string) => `t.${column}`;
  const uses = `CASE WHEN typeof(${t(storage.uses)}) IN ('integer', 'real') AND ${t(storage.uses)} >= 0 AND ${t(storage.uses)} = CAST(${t(storage.uses)} AS INTEGER) THEN CAST(${t(storage.uses)} AS INTEGER) WHEN ${t(storage.uses)} IS NULL OR ${t(storage.uses)} = '' THEN ${storage.emptyIsUnlimited ? "NULL" : "0"} ELSE 0 END`;
  const per =
    "fixed" in storage.per
      ? q(storage.per.fixed)
      : `CASE WHEN ${t(storage.per.column)} IN ('total', 'week', 'month') THEN ${t(storage.per.column)} ELSE 'total' END`;
  const stored = `(SELECT s.zone FROM core_allowance s WHERE s.object_type = ${q(storage.object)} AND s.record_id = t.id)`;
  const zone = storage.zone
    ? `coalesce(nullif(${t(storage.zone)}, ''), ${stored}, ?)`
    : `coalesce(${stored}, ?)`;
  const instant = (bound: HolderStorage["from"]) =>
    bound && !bound.date
      ? `CASE WHEN ${t(bound.column)} IS NULL OR ${t(bound.column)} = '' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${t(bound.column)}) END`
      : "NULL";
  const day = (bound: HolderStorage["from"]) =>
    bound?.date ? `nullif(substr(${t(bound.column)}, 1, 10), '')` : "NULL";
  const live = storage.live
    ? `CASE WHEN ${t(storage.live.column)} IN (${storage.live.states.map(q).join(", ") || "NULL"}) THEN 1 ELSE 0 END`
    : "1";
  const person = `CASE WHEN typeof(${t(storage.person)}) = 'text' AND ${t(storage.person)} <> '' THEN ${t(storage.person)} END`;
  const where = target === "all" ? "true" : "t.id = ?";
  return [
    CompiledQuery.raw(
      `INSERT INTO core_allowance (object_type, record_id, person_id, uses, per, zone, valid_from, valid_until, from_date, until_date, live, trashed, updated_at) SELECT ${q(storage.object)}, t.id, ${person}, ${uses}, ${per}, ${zone}, ${instant(storage.from)}, ${instant(storage.until)}, ${day(storage.from)}, ${day(storage.until)}, ${live}, CASE WHEN t.deleted_at IS NULL THEN 0 ELSE 1 END, ? FROM ${storage.table} t WHERE ${where} ON CONFLICT (object_type, record_id) DO UPDATE SET person_id = excluded.person_id, uses = excluded.uses, per = excluded.per, zone = excluded.zone, valid_from = excluded.valid_from, valid_until = excluded.valid_until, from_date = excluded.from_date, until_date = excluded.until_date, live = excluded.live, trashed = excluded.trashed, updated_at = excluded.updated_at`,
      [orgZone, now, ...(target === "all" ? [] : [target.id])],
    ),
    CompiledQuery.raw(
      `UPDATE core_allowance_period SET uses = (SELECT a.uses FROM core_allowance a WHERE a.object_type = core_allowance_period.object_type AND a.record_id = core_allowance_period.record_id), updated_at = ? WHERE object_type = ? AND ends_at > ?${target === "all" ? "" : " AND record_id = ?"}`,
      [now, storage.object, now, ...(target === "all" ? [] : [target.id])],
    ),
  ];
}

/**
 * The statement that records a change of a holder's period or zone (ADR 0494): before
 * `appliesFrom` (the end of the period running when it was made) spends are counted the old way.
 */
export function keyingChangeStatement(
  holder: RecordRef,
  previous: { per: AllowancePer; zone: string },
  appliesFrom: string,
  now: string,
): CompiledQuery {
  return CompiledQuery.raw(
    "UPDATE core_allowance SET prev_per = ?, prev_zone = ?, applies_from = ?, updated_at = ? WHERE object_type = ? AND record_id = ?",
    [previous.per, previous.zone, appliesFrom, now, holder.object, holder.id],
  );
}

/** One spend: a use of `holder` in `period` (of `zone`) for `spender`, at the spender's time. */
export interface SpendRequest {
  holder: RecordRef;
  period: AllowancePeriod;
  zone: string;
  spender: RecordRef;
  personId: string;
  /** The spender's time, an ISO instant inside `period`, and its local date in the zone. */
  at: string;
  atDate: string;
  by: Mover;
  /** The use this one takes over (a moved or re-spent spender's). */
  movedFrom?: string | null;
  /** The use's id (default a new alu_ id). */
  id?: string;
}

function periodInsert(holder: RecordRef, period: AllowancePeriod, zone: string, now: string) {
  return CompiledQuery.raw(
    "INSERT INTO core_allowance_period (object_type, record_id, period, per, zone, starts_at, ends_at, uses, used, updated_at) SELECT a.object_type, a.record_id, ?, ?, ?, ?, ?, a.uses, 0, ? FROM core_allowance a WHERE a.object_type = ? AND a.record_id = ? ON CONFLICT (object_type, record_id, period, zone) DO NOTHING",
    [period.key, period.per, zone, period.startsAt, period.endsAt, now, holder.object, holder.id],
  );
}

/**
 * The statements that spend one use (see the header). Queue them in the batch of the spender's
 * write; the batch fails with an allowance refusal when the holder cannot pay.
 */
export function spendStatements(
  request: SpendRequest,
  now: string,
): { id: string; statements: CompiledQuery[] } {
  const id = request.id ?? newId("allowanceUse");
  const { holder, period, zone } = request;
  return {
    id,
    statements: [
      periodInsert(holder, period, zone, now),
      CompiledQuery.raw(
        "UPDATE core_allowance_period SET used = used + 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND period = ? AND zone = ?",
        [now, holder.object, holder.id, period.key, zone],
      ),
      CompiledQuery.raw(
        "INSERT INTO core_allowance_use (id, object_type, record_id, period, zone, spender_type, spender_id, person_id, at, at_date, spent_at, spent_by, moved_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          holder.object,
          holder.id,
          period.key,
          zone,
          request.spender.object,
          request.spender.id,
          request.personId,
          request.at,
          request.atDate,
          now,
          request.by,
          request.movedFrom ?? null,
        ],
      ),
    ],
  };
}

/**
 * The statements that give back the spender's open use, if it has one: its period's counter goes
 * down by one and the use is marked returned. Idempotent.
 */
export function returnStatements(spender: RecordRef, by: Mover, now: string): CompiledQuery[] {
  return [
    CompiledQuery.raw(
      "UPDATE core_allowance_period SET used = used - 1, updated_at = ? WHERE (object_type, record_id, period, zone) IN (SELECT object_type, record_id, period, zone FROM core_allowance_use WHERE spender_type = ? AND spender_id = ? AND returned_at IS NULL)",
      [now, spender.object, spender.id],
    ),
    CompiledQuery.raw(
      "UPDATE core_allowance_use SET returned_at = ?, returned_by = ? WHERE spender_type = ? AND spender_id = ? AND returned_at IS NULL",
      [now, by, spender.object, spender.id],
    ),
  ];
}

/**
 * The statements that move one open use to another period (a re-keying after a change of period
 * or zone): out of its old counter, into the new one, even past its limit (`rekeyed`), as a lowered
 * limit leaves what was spent.
 */
export function rekeyStatements(
  use: { id: string; holder: RecordRef; period: string; zone: string },
  to: { period: AllowancePeriod; zone: string },
  now: string,
): CompiledQuery[] {
  const { holder } = use;
  return [
    periodInsert(holder, to.period, to.zone, now),
    CompiledQuery.raw(
      "UPDATE core_allowance_period SET used = used - 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND period = ? AND zone = ?",
      [now, holder.object, holder.id, use.period, use.zone],
    ),
    CompiledQuery.raw(
      "UPDATE core_allowance_period SET used = used + 1, rekeyed = rekeyed + 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND period = ? AND zone = ?",
      [now, holder.object, holder.id, to.period.key, to.zone],
    ),
    CompiledQuery.raw("UPDATE core_allowance_use SET period = ?, zone = ? WHERE id = ?", [
      to.period.key,
      to.zone,
      use.id,
    ]),
  ];
}

/**
 * The statements that remove an object's allowance rows when its table is dropped: a holder's
 * terms, periods and uses; a spender's open uses given back first, then its uses.
 */
export function dropAllowanceStatements(
  object: string,
  kind: "holder" | "spender",
  now: string,
): CompiledQuery[] {
  if (kind === "holder") {
    return [
      CompiledQuery.raw("DELETE FROM core_allowance_use WHERE object_type = ?", [object]),
      CompiledQuery.raw("DELETE FROM core_allowance_period WHERE object_type = ?", [object]),
      CompiledQuery.raw("DELETE FROM core_allowance WHERE object_type = ?", [object]),
    ];
  }
  return [
    CompiledQuery.raw(
      "UPDATE core_allowance_period SET used = used - (SELECT count(*) FROM core_allowance_use u WHERE u.spender_type = ? AND u.returned_at IS NULL AND u.object_type = core_allowance_period.object_type AND u.record_id = core_allowance_period.record_id AND u.period = core_allowance_period.period AND u.zone = core_allowance_period.zone), updated_at = ? WHERE (object_type, record_id, period, zone) IN (SELECT object_type, record_id, period, zone FROM core_allowance_use WHERE spender_type = ? AND returned_at IS NULL)",
      [object, now, object],
    ),
    CompiledQuery.raw("DELETE FROM core_allowance_use WHERE spender_type = ?", [object]),
  ];
}
