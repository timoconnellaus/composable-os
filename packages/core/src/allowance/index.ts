// The allowance behaviour's statements (stage 32b, ADR 0493): a holder's terms, a spend and a
// give-back, each a fixed set of statements queued in the batch of the write that needs them.
//
// There is no check-then-write. A spend is three statements with no read of the count first:
//
//   1. the holder's counter for the period, made at nought if it is the period's first use, with
//      the limit copied from the holder's terms;
//   2. `used = used + 1` on it, refused by migration 0533's trigger and CHECK past the limit;
//   3. the use row, refused by its trigger when the holder is not the spender's Person's, is not
//      live, or is not valid at the spender's time.
//
// Either refusal fails the batch, so nothing in it is applied, the spender's own write included.
// D1 runs one statement at a time per database, so concurrent spends cannot both take the last
// use. A give-back is two statements (the counter down by what the spender's open use counted,
// then the use marked returned), idempotent: the second time no open use matches.
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


/** A holder's terms, as the host keeps them in core_allowance. */
export interface AllowanceTerms {
  object: string;
  record: string;
  personId: string | null;
  /** Null: unlimited. */
  uses: number | null;
  per: AllowancePer;
  zone: string;
  validFrom: string | null;
  validUntil: string | null;
  live: boolean;
}

/**
 * Statements per spend and per give-back (whatever the holder). A spend made by a record write
 * adds one more first: the holder's terms, when it has none yet (termsIfMissing).
 */
export const SPEND_STATEMENTS = 3;
export const RETURN_STATEMENTS = 2;

/**
 * The statements that keep a holder's terms: its row, and the limit of its current and future
 * periods (a period's limit never drops below what it has spent: ADR 0494).
 */
export function termsStatements(terms: AllowanceTerms, now: string): CompiledQuery[] {
  return [
    CompiledQuery.raw(
      "INSERT INTO core_allowance (object_type, record_id, person_id, uses, per, zone, valid_from, valid_until, live, trashed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET person_id = excluded.person_id, uses = excluded.uses, per = excluded.per, zone = excluded.zone, valid_from = excluded.valid_from, valid_until = excluded.valid_until, live = excluded.live, updated_at = excluded.updated_at",
      [
        terms.object,
        terms.record,
        terms.personId,
        terms.uses,
        terms.per,
        terms.zone,
        terms.validFrom,
        terms.validUntil,
        terms.live ? 1 : 0,
        now,
      ],
    ),
    CompiledQuery.raw(
      "UPDATE core_allowance_period SET uses = CASE WHEN ? IS NULL THEN NULL ELSE max(?, used) END, updated_at = ? WHERE object_type = ? AND record_id = ? AND ends_at > ?",
      [terms.uses, terms.uses, now, terms.object, terms.record, now],
    ),
  ];
}

/** The statement that inserts a holder's terms only when it has none (a holder older than them). */
export function termsIfMissing(terms: AllowanceTerms, now: string): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_allowance (object_type, record_id, person_id, uses, per, zone, valid_from, valid_until, live, trashed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (object_type, record_id) DO NOTHING",
    [
      terms.object,
      terms.record,
      terms.personId,
      terms.uses,
      terms.per,
      terms.zone,
      terms.validFrom,
      terms.validUntil,
      terms.live ? 1 : 0,
      now,
    ],
  );
}

/** The statement that marks a holder in or out of the Trash (it cannot be spent while there). */
export function trashStatement(holder: RecordRef, trashed: boolean, now: string): CompiledQuery {
  return CompiledQuery.raw(
    "UPDATE core_allowance SET trashed = ?, updated_at = ? WHERE object_type = ? AND record_id = ?",
    [trashed ? 1 : 0, now, holder.object, holder.id],
  );
}

/** One spend: a use of `holder` in `period` for `spender`, at the spender's time. */
export interface SpendRequest {
  holder: RecordRef;
  period: AllowancePeriod;
  spender: RecordRef;
  personId: string;
  /** The spender's time, an ISO instant inside `period`. */
  at: string;
  by: Mover;
  /** The use this one takes over (a moved spender's). */
  movedFrom?: string | null;
  /** The use's id (default a new alu_ id). */
  id?: string;
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
  const { holder, period } = request;
  return {
    id,
    statements: [
      CompiledQuery.raw(
        "INSERT INTO core_allowance_period (object_type, record_id, period, per, starts_at, ends_at, uses, used, updated_at) SELECT a.object_type, a.record_id, ?, ?, ?, ?, a.uses, 0, ? FROM core_allowance a WHERE a.object_type = ? AND a.record_id = ? ON CONFLICT (object_type, record_id, period) DO NOTHING",
        [period.key, period.per, period.startsAt, period.endsAt, now, holder.object, holder.id],
      ),
      CompiledQuery.raw(
        "UPDATE core_allowance_period SET used = used + 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND period = ?",
        [now, holder.object, holder.id, period.key],
      ),
      CompiledQuery.raw(
        "INSERT INTO core_allowance_use (id, object_type, record_id, period, spender_type, spender_id, person_id, at, spent_at, spent_by, moved_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          holder.object,
          holder.id,
          period.key,
          request.spender.object,
          request.spender.id,
          request.personId,
          request.at,
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
      "UPDATE core_allowance_period SET used = used - 1, updated_at = ? WHERE (object_type, record_id, period) IN (SELECT object_type, record_id, period FROM core_allowance_use WHERE spender_type = ? AND spender_id = ? AND returned_at IS NULL)",
      [now, spender.object, spender.id],
    ),
    CompiledQuery.raw(
      "UPDATE core_allowance_use SET returned_at = ?, returned_by = ? WHERE spender_type = ? AND spender_id = ? AND returned_at IS NULL",
      [now, by, spender.object, spender.id],
    ),
  ];
}

/**
 * The statements that remove an object's allowance rows when its table is dropped: a holder's
 * terms, periods and uses (by cascade); a spender's open uses given back first, then its uses.
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
      "UPDATE core_allowance_period SET used = used - (SELECT count(*) FROM core_allowance_use u WHERE u.spender_type = ? AND u.returned_at IS NULL AND u.object_type = core_allowance_period.object_type AND u.record_id = core_allowance_period.record_id AND u.period = core_allowance_period.period), updated_at = ? WHERE (object_type, record_id, period) IN (SELECT object_type, record_id, period FROM core_allowance_use WHERE spender_type = ? AND returned_at IS NULL)",
      [object, now, object],
    ),
    CompiledQuery.raw("DELETE FROM core_allowance_use WHERE spender_type = ?", [object]),
  ];
}
