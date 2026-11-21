// Confirming and releasing claims (stage 26, ADR 0432). A hold has no clock of its own: whatever
// it was taken for (an order, later a booking) confirms it when it is paid and releases it when
// it is cancelled, expires or is refunded, in the batch of its own write. Nothing here knows how
// old a hold is, and nothing assumes it is short: an order part paid by a deposit keeps its hold
// until the balance is paid, possibly weeks.
//
// Each is three statements, however many claims they touch, with no read before them:
//
//   1. the counters the claims were made on: held (or taken) down by what the claims hold;
//   2. the pools the claims drew on (copied onto each claim when it was made), the same;
//   3. the claims' state.
//
// They only touch claims in the state they move from, so confirming or releasing twice changes
// nothing: the second time no claim matches and no counter moves. Places go back to the pool the
// claim drew on even if the record has since moved to another pool.
import { CompiledQuery } from "kysely";
import type { ClaimFor } from "./index.ts";

/** Which claims: one by id, or every claim taken for something (an order's lines). */
export type ClaimTarget = { claim: string } | { for: ClaimFor };

/** Statements per confirm or release, whatever the number of claims. */
export const CONFIRM_STATEMENTS = 3;
export const RELEASE_STATEMENTS = 3;

function targetWhere(target: ClaimTarget, alias: string): { sql: string; params: string[] } {
  return "claim" in target
    ? { sql: `${alias}.id = ?`, params: [target.claim] }
    : {
        sql: `${alias}.for_type = ? AND ${alias}.for_id = ?`,
        params: [target.for.type, target.for.id],
      };
}

/**
 * Moves `from` claims' quantities off one counter column (and onto another, for a confirm).
 * Statement 1 matches counters by the claim's record, statement 2 by the pool it drew on.
 */
function counterMoves(
  target: ClaimTarget,
  state: "held" | "confirmed",
  sets: { minus: "held" | "taken"; plus?: "taken" },
  now: string,
): CompiledQuery[] {
  const where = targetWhere(target, "c");
  return (["record", "pool"] as const).map((level) => {
    const [object, record] =
      level === "record" ? ["object_type", "record_id"] : ["pool_object_type", "pool_record_id"];
    const sum = `(SELECT coalesce(sum(c.quantity), 0) FROM core_capacity_claim c WHERE ${where.sql} AND c.state = '${state}' AND c.${object} = core_capacity.object_type AND c.${record} = core_capacity.record_id)`;
    const assignments = [
      `${sets.minus} = ${sets.minus} - ${sum}`,
      ...(sets.plus ? [`${sets.plus} = ${sets.plus} + ${sum}`] : []),
      "updated_at = ?",
    ];
    const params = [...where.params, ...(sets.plus ? where.params : []), now, ...where.params];
    return CompiledQuery.raw(
      `UPDATE core_capacity SET ${assignments.join(", ")} WHERE (object_type, record_id) IN (SELECT c.${object}, c.${record} FROM core_capacity_claim c WHERE ${where.sql} AND c.state = '${state}' AND c.${object} IS NOT NULL)`,
      params,
    );
  });
}

function claimMove(
  target: ClaimTarget,
  from: "held" | "confirmed",
  to: "confirmed" | "released",
  now: string,
): CompiledQuery {
  const where = targetWhere(target, "core_capacity_claim");
  const stamp = to === "confirmed" ? "confirmed_at" : "released_at";
  return CompiledQuery.raw(
    `UPDATE core_capacity_claim SET state = '${to}', ${stamp} = ?, updated_at = ? WHERE ${where.sql} AND state = '${from}'`,
    [now, now, ...where.params],
  );
}

/**
 * The statements that confirm held claims: their places move from held to taken, on the record
 * and on the pool. However old the hold, it is still there to confirm. Queue them in the batch
 * of the write that paid for them.
 */
export function confirmStatements(target: ClaimTarget, now: string): CompiledQuery[] {
  return [
    ...counterMoves(target, "held", { minus: "held", plus: "taken" }, now),
    claimMove(target, "held", "confirmed", now),
  ];
}

/**
 * The statements that give places back. By default held claims (an order cancelled or expired);
 * with `confirmed`, confirmed claims (a refund, when the object releases on refund). The places
 * return to the record and to the pool the claim drew on, and can be claimed again.
 */
export function releaseStatements(
  target: ClaimTarget,
  now: string,
  options: { confirmed?: boolean } = {},
): CompiledQuery[] {
  const from = options.confirmed ? "confirmed" : "held";
  return [
    ...counterMoves(target, from, { minus: from === "held" ? "held" : "taken" }, now),
    claimMove(target, from, "released", now),
  ];
}
