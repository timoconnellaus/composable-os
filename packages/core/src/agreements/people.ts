// What erase, the Trash purge and merge do to a Person's agreements (stage 44 steps 2 and 8, ADRs
// 0642 and 0646).
//
// Erase (and the Trash purge, which deletes the Person the same way), queued after the Person's
// row is deleted (the triggers allow a detach only once the Person is gone):
//   - their own acceptances are kept, detached (no Person, no account, `erased_at` set), with the
//     version, the time, how, the name typed, the address and the signature, until the retention
//     purge (decision 15, `retention.ts`). Their health answers and their minor mark are deleted
//     at once.
//   - acceptances they made as a guardian for a child (coordinator decision of 2026-11-23, owner
//     to confirm): the record that a guardian agreed, the version and the time stay; the
//     guardian, their account, their typed name and their drawn signature are cleared; the
//     address stays, as for their own; `erased_at` is set, so it no longer counts for the child
//     (the child is due again) and the purge covers it. The child's health answers are the
//     child's: they stay until the purge.
//   - a buyer's acceptances with their address (a guest's, taken with an order or a subscription
//     checkout and settled to nobody yet): on an unpaid order or an unconfirmed checkout, deleted
//     at once (no contract was made); on a paid order nobody settled, kept detached like their
//     own, once erase has cleared the order's address (it can never settle after that).
//   - a copy waiting for a person's approval: that approval is turned down and redacted here; the
//     copy row is cancelled and, if it ever reached the email gatekeeper, owes a scrub of the
//     gatekeeper's storage (migration 0855's trigger; `copy.ts` asks the gatekeeper).
// The database allows exactly these updates and deletes (migrations 0851 and 0855); nothing else
// in an acceptance changes.
//
// Merge: acceptances, and acceptances made as a guardian, follow the merged Person to the
// survivor (the trigger allows a move only to the Person's `merged_into_id`, which the merge set
// earlier in its batch); the minor mark is kept if either Person had it. Nothing in an
// acceptance changes; a buyer's acceptances not yet settled are nobody's and are not touched.
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { ERASED } from "../records/erase-subject.ts";
import { keptUntil, loadKeepYears } from "./retention.ts";

const list = (values: readonly string[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values.length ? values : [""])}))`;

/**
 * The addresses the Person's acceptances and copies hold (their own, and those they made as a
 * guardian): erase redacts them wherever else they appear (the audit, approvals), as any address
 * of theirs.
 */
export async function agreementAddresses(
  ctx: HandlerContext,
  personIds: readonly string[],
): Promise<string[]> {
  if (!personIds.length) return [];
  const people = list(personIds);
  const { rows } = await sql<{ address: string | null }>`
    SELECT a.email AS address FROM core_agreement_acceptance a
      WHERE (a.person_id IN ${people} OR a.agent_person_id IN ${people}) AND a.email IS NOT NULL
    UNION
    SELECT c.to_address AS address FROM core_agreement_copy c
      JOIN core_agreement_acceptance a ON a.id = c.acceptance_id
      WHERE (a.person_id IN ${people} OR a.agent_person_id IN ${people})
        AND c.to_address IS NOT NULL
    LIMIT 50`.execute(ctx.db);
  return [...new Set(rows.map((r) => r.address?.trim().toLowerCase() ?? "").filter(Boolean))];
}

/** What erase did to the Person's agreements: what is kept, until when, and what went. */
export interface AgreementsErased {
  /** Acceptances kept, detached, as the business's evidence. */
  kept: number;
  /** When the retention purge deletes them (the period counted from now). */
  keptUntil: string | null;
  /** A buyer's acceptances on an unpaid order or an unconfirmed checkout, deleted now. */
  deleted: number;
  /** Approvals of a copy that were waiting, turned down. */
  approvalsTurnedDown: number;
}

/**
 * Queues the erase of `personIds`' agreements. Reads before the batch (the order's address is
 * still there to match), writes after the Person's row and its orders' addresses are deleted
 * (the triggers check both): call it after queueEraseOrders and the Person's delete.
 */
export async function queueEraseAgreements(
  ctx: HandlerContext,
  personIds: readonly string[],
  addresses: readonly string[] = [],
): Promise<AgreementsErased> {
  const none: AgreementsErased = { kept: 0, keptUntil: null, deleted: 0, approvalsTurnedDown: 0 };
  if (!personIds.length) return none;
  const people = list(personIds);
  const addrs = list(addresses.map((a) => a.trim().toLowerCase()));

  const [own, approvals, guests] = await Promise.all([
    sql<{ n: number }>`SELECT count(*) AS n FROM core_agreement_acceptance
      WHERE (person_id IN ${people} OR agent_person_id IN ${people}) AND erased_at IS NULL`.execute(
      ctx.db,
    ),
    // A copy waiting for a person: its approval, turned down below (the copy row's id is
    // cleared by the erase trigger, so it is read now).
    sql<{ id: string }>`SELECT c.pending_action_id AS id FROM core_agreement_copy c
      JOIN core_agreement_acceptance a ON a.id = c.acceptance_id
      WHERE (a.person_id IN ${people} OR a.agent_person_id IN ${people})
        AND c.pending_action_id IS NOT NULL`.execute(ctx.db),
    // A buyer's acceptances nobody settled, with their address or their Person on the purchase.
    sql<{ id: string; unpaid: number; paidUnsettled: number }>`
      SELECT a.id,
        (o.id IS NOT NULL AND o.paid = 0) OR (c.id IS NOT NULL AND c.subscription_ref IS NULL)
          AS unpaid,
        (o.id IS NOT NULL AND o.paid > 0 AND o.person_id IS NULL AND o.email IN ${addrs})
          AS paidUnsettled
      FROM core_agreement_acceptance a
      LEFT JOIN core_order o ON o.id = a.order_id
      LEFT JOIN core_subscription_checkout c ON c.id = a.subscription_checkout
      WHERE a.by = 'guest' AND a.person_id IS NULL AND a.erased_at IS NULL
        AND (lower(a.email) IN ${addrs} OR o.email IN ${addrs} OR o.person_id IN ${people}
          OR c.email IN ${addrs} OR c.payer_person_id IN ${people}
          OR c.holder_person_id IN ${people})
      LIMIT 500`.execute(ctx.db),
  ]);
  const unpaid = guests.rows.filter((g) => g.unpaid).map((g) => g.id);
  const unsettled = guests.rows.filter((g) => !g.unpaid && g.paidUnsettled).map((g) => g.id);
  const turnedDown = approvals.rows.map((r) => r.id);

  if (turnedDown.length) {
    const ids = list(turnedDown);
    ctx.write(
      sql`UPDATE core_pending_action SET
          input = ${JSON.stringify(ERASED)}, reason = ${ERASED}, preview = '[]',
          simulated = ${JSON.stringify({ output: null, records: [] })},
          status_reason = CASE WHEN status = 'pending'
            THEN 'Rejected: the person it was for was erased' ELSE status_reason END,
          decided_by = CASE WHEN status = 'pending' THEN ${ctx.user.id} ELSE decided_by END,
          decided_at = CASE WHEN status = 'pending' THEN ${ctx.now} ELSE decided_at END,
          status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END
        WHERE id IN ${ids}`.compile(ctx.db),
    );
  }
  if (unpaid.length) {
    const ids = list(unpaid);
    ctx.write(
      sql`DELETE FROM core_agreement_answer WHERE acceptance_id IN ${ids}`.compile(ctx.db),
      sql`DELETE FROM core_agreement_signature WHERE acceptance_id IN ${ids}`.compile(ctx.db),
      sql`DELETE FROM core_agreement_acceptance WHERE id IN ${ids} AND by = 'guest'
        AND person_id IS NULL AND erased_at IS NULL`.compile(ctx.db),
    );
  }
  ctx.write(
    // The notice to staff that a health form of theirs had a "yes" (ADR 0643): it names nobody,
    // but beside a kept acceptance it would still say that this erased person answered yes.
    sql`DELETE FROM core_notifications WHERE dedupe_key IN (SELECT 'agreement-health:' || id FROM core_agreement_acceptance WHERE person_id IN ${people})`.compile(
      ctx.db,
    ),
    // Their own: detached. A guardian's account on a child's acceptance is the guardian's: kept.
    sql`UPDATE core_agreement_acceptance SET person_id = NULL, account_id = CASE WHEN by = 'guardian' THEN account_id ELSE NULL END, erased_at = coalesce(erased_at, ${ctx.now}) WHERE person_id IN ${people}`.compile(
      ctx.db,
    ),
    // As a guardian: who agreed is no longer named, nor what they typed or drew.
    sql`UPDATE core_agreement_acceptance SET agent_person_id = NULL, account_id = NULL, typed_name = NULL, erased_at = coalesce(erased_at, ${ctx.now}) WHERE agent_person_id IN ${people}`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_agreement_signature WHERE acceptance_id IN (SELECT id FROM core_agreement_acceptance WHERE by = 'guardian' AND agent_person_id IS NULL AND erased_at IS NOT NULL)`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_agreement_minor WHERE person_id IN ${people}`.compile(ctx.db),
  );
  if (unsettled.length) {
    // A paid order nobody settled, whose address erase just cleared: kept detached.
    ctx.write(
      sql`UPDATE core_agreement_acceptance SET erased_at = ${ctx.now}
        WHERE id IN ${list(unsettled)} AND erased_at IS NULL`.compile(ctx.db),
    );
  }
  // Health answers on every acceptance kept detached, at once (the trigger allows it once the
  // acceptance is detached).
  ctx.write(
    sql`DELETE FROM core_agreement_answer WHERE acceptance_id IN (SELECT id FROM core_agreement_acceptance WHERE person_id IS NULL AND erased_at IS NOT NULL)`.compile(
      ctx.db,
    ),
  );
  const kept = Number(own.rows[0]?.n ?? 0) + unsettled.length;
  return {
    kept,
    keptUntil: kept ? keptUntil(ctx.now, await loadKeepYears(ctx.db)) : null,
    deleted: unpaid.length,
    approvalsTurnedDown: turnedDown.length,
  };
}

export function queueMergeAgreements(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): void {
  ctx.write(
    ctx.db
      .updateTable("core_agreement_acceptance")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId),
    ctx.db
      .updateTable("core_agreement_acceptance")
      .set({ agent_person_id: survivorId })
      .where("agent_person_id", "=", mergedId),
    sql`INSERT OR IGNORE INTO core_agreement_minor (person_id, set_by, set_at) SELECT ${survivorId}, set_by, set_at FROM core_agreement_minor WHERE person_id = ${mergedId}`.compile(
      ctx.db,
    ),
    ctx.db.deleteFrom("core_agreement_minor").where("person_id", "=", mergedId),
  );
}

/** What a merge of `mergedId` would move: the merge preview's counts (ADR 0646). */
export async function mergeAgreementCounts(
  ctx: HandlerContext,
  mergedId: string,
): Promise<{ acceptances: number; asGuardian: number; minor: boolean }> {
  const { rows } = await sql<{ own: number; guardian: number; minor: number }>`SELECT
      (SELECT count(*) FROM core_agreement_acceptance WHERE person_id = ${mergedId}) AS own,
      (SELECT count(*) FROM core_agreement_acceptance WHERE agent_person_id = ${mergedId})
        AS guardian,
      EXISTS (SELECT 1 FROM core_agreement_minor WHERE person_id = ${mergedId}) AS minor`.execute(
    ctx.db,
  );
  const row = rows[0];
  return {
    acceptances: Number(row?.own ?? 0),
    asGuardian: Number(row?.guardian ?? 0),
    minor: Boolean(row?.minor),
  };
}

/** Whether a merge would move any agreement record of `mergedId` (ADR 0642: a person's act). */
export async function mergeMovesAgreements(
  ctx: HandlerContext,
  mergedId: string,
): Promise<boolean> {
  const counts = await mergeAgreementCounts(ctx, mergedId);
  return counts.acceptances > 0 || counts.asGuardian > 0 || counts.minor;
}
