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

/** Addresses read per batch: every one is read, however many (never cut, never refused). */
const ADDRESS_BATCH = 50;

/**
 * The addresses that are the erased Person's own and that their acceptances hold: the sign-in
 * address they agreed with themselves (`self`), and the one they agreed with as a guardian for a
 * child (`guardian`, they being the agent). Erase redacts them wherever else they appear (the
 * audit, approvals, orders), as any address of theirs. Never the address of someone else's
 * acceptance for them (a guardian's for a child, a parent's purchase settled to the child, a
 * paper form's copy): that address is the other person's, and erasing the child must not touch
 * them (the review of PR #288). A buyer's acceptance settled to them is left out too: its address
 * is theirs only if it is already one of their addresses, which erase has from their record.
 * Copies go to the acceptance's own address, so they add nothing. Read in bounded batches until
 * none is left (the second review of PR #288: nobody is un-erasable).
 */
export async function agreementAddresses(
  ctx: HandlerContext,
  personIds: readonly string[],
): Promise<string[]> {
  if (!personIds.length) return [];
  const people = list(personIds);
  const out: string[] = [];
  for (let after = ""; ; ) {
    const { rows } = await sql<{ address: string }>`
      SELECT DISTINCT lower(trim(a.email)) AS address FROM core_agreement_acceptance a
      WHERE a.email IS NOT NULL AND (
        (a.by = 'self' AND a.person_id IN ${people})
        OR (a.by = 'guardian' AND a.agent_person_id IN ${people}))
        AND lower(trim(a.email)) > ${after}
      ORDER BY address
      LIMIT ${ADDRESS_BATCH}`.execute(ctx.db);
    out.push(...rows.map((r) => r.address).filter(Boolean));
    if (rows.length < ADDRESS_BATCH) return out;
    after = rows[rows.length - 1]?.address ?? "";
  }
}

/** How an erased Person may be named in free text: whole names, and given with family names. */
interface NameForms {
  /** Whole names: the display name, given and family together, and each name they typed. */
  whole: string[];
  /** Given and family name pairs: both must appear (a family name alone is a sibling's too). */
  pairs: [string, string][];
}

/** The erased People's names, read before their rows go. */
async function nameForms(ctx: HandlerContext, personIds: readonly string[]): Promise<NameForms> {
  const people = list(personIds);
  const { rows } = await sql<{
    display: string | null;
    given: string | null;
    family: string | null;
  }>`
    SELECT display_name AS display, given_name AS given, family_name AS family
    FROM core_person WHERE id IN ${people}`.execute(ctx.db);
  const typed = await sql<{ name: string | null }>`
    SELECT DISTINCT typed_name AS name FROM core_agreement_acceptance
    WHERE typed_name IS NOT NULL AND ((by = 'self' AND person_id IN ${people})
      OR (by = 'guardian' AND agent_person_id IN ${people}))`.execute(ctx.db);
  const clean = (s: string | null) => (s ?? "").trim().toLowerCase();
  const whole = new Set<string>();
  const pairs: [string, string][] = [];
  for (const r of rows) {
    for (const n of [r.display, [r.given, r.family].filter(Boolean).join(" ")]) {
      if (clean(n).length >= 2) whole.add(clean(n));
    }
    if (clean(r.given).length >= 2 && clean(r.family).length >= 2) {
      pairs.push([clean(r.given), clean(r.family)]);
    }
  }
  for (const t of typed.rows) if (clean(t.name).length >= 2) whole.add(clean(t.name));
  return { whole: [...whole], pairs };
}

/**
 * Whether `text` names them: case-insensitively, a whole name of theirs as whole words (`Ann
 * Lee` in "mother, Ann Lee", not in "Joanne Leeds"), or their given and family names both as
 * whole words anywhere ("Lee, Ann"). A nickname or a family name alone is not matched: that
 * residual is accepted, since only staff with agreements:manage read this text (ADR 0646).
 */
export function namesThem(text: string, names: NameForms): boolean {
  const lower = text.toLowerCase();
  const word = (w: string) =>
    new RegExp(
      `(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
      "u",
    ).test(lower);
  return names.whole.some(word) || names.pairs.some(([g, f]) => word(g) && word(f));
}

/** A buyer's acceptances read per batch. */
const GUEST_BATCH = 200;

/**
 * A buyer's acceptances nobody settled, on a purchase that is theirs as erase decides it
 * (`records/erase-stores.ts`): their Person on it, or nobody's and one of their own addresses;
 * never another identified Person's. `unpaid`: an unpaid order or an unconfirmed checkout (erase
 * deletes them); `paidUnsettled`: a paid order nobody settled (erase keeps them detached). Read in
 * bounded batches until none is left (never cut short).
 */
export async function buyerAcceptances(
  ctx: HandlerContext,
  personIds: readonly string[],
  addresses: readonly string[],
): Promise<{ id: string; unpaid: number; paidUnsettled: number }[]> {
  const people = list(personIds);
  const addrs = list(addresses.map((a) => a.trim().toLowerCase()));
  const guests: { id: string; unpaid: number; paidUnsettled: number }[] = [];
  for (let after = ""; ; ) {
    const page = await sql<{ id: string; unpaid: number; paidUnsettled: number }>`
      SELECT a.id,
        (o.id IS NOT NULL AND o.paid = 0) OR (c.id IS NOT NULL AND c.subscription_ref IS NULL)
          AS unpaid,
        (o.id IS NOT NULL AND o.paid > 0 AND o.person_id IS NULL AND lower(o.email) IN ${addrs})
          AS paidUnsettled
      FROM core_agreement_acceptance a
      LEFT JOIN core_order o ON o.id = a.order_id
      LEFT JOIN core_subscription_checkout c ON c.id = a.subscription_checkout
      WHERE a.by = 'guest' AND a.person_id IS NULL AND a.erased_at IS NULL
        -- Only a purchase that is theirs, as erase-stores.ts decides it: their Person on it, or
        -- nobody's and one of their own addresses (never another identified Person's).
        AND (o.person_id IN ${people} OR (o.person_id IS NULL AND lower(o.email) IN ${addrs})
          OR ((c.payer_person_id IN ${people} OR c.holder_person_id IN ${people})
            AND (c.payer_person_id IS NULL OR c.payer_person_id IN ${people})
            AND (c.holder_person_id IS NULL OR c.holder_person_id IN ${people}))
          OR (c.id IS NOT NULL AND c.payer_person_id IS NULL AND c.holder_person_id IS NULL
            AND lower(c.email) IN ${addrs})
          -- An unconfirmed checkout they would have paid for: erase closes it, whoever holds it.
          OR (c.id IS NOT NULL AND c.subscription_ref IS NULL AND c.payer_person_id IN ${people}))
        AND a.id > ${after}
      ORDER BY a.id
      LIMIT ${GUEST_BATCH}`.execute(ctx.db);
    guests.push(...page.rows);
    if (page.rows.length < GUEST_BATCH) break;
    after = page.rows[page.rows.length - 1]?.id ?? "";
  }
  return guests;
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

  const [own, approvals] = await Promise.all([
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
  ]);
  const guests = await buyerAcceptances(ctx, personIds, addresses);
  // Their dependants (any family link of theirs, live or ended; read before erase deletes the
  // links): a paper form for one of them may name them in who signed it or in staff's note.
  const dependants = (
    await sql<{ id: string }>`SELECT DISTINCT dependant_id AS id FROM core_person_link
      WHERE guardian_id IN ${people} AND kind = 'guardian'`.execute(ctx.db)
  ).rows.map((r) => r.id);
  if (dependants.length) {
    // Coordinator decision of 2026-11-23 (owner to confirm), as narrowed after the second review
    // of PR #288: only a paper form whose free text names them (`namesThem`) loses who signed it
    // and the note; the form, its version, its date and who recorded it stay. Another guardian's
    // form, and the child's own, are untouched. A paper form records no agent, so there is no
    // "recorded as the agent" case. Migration 0855 allows only clearing.
    const names = await nameForms(ctx, personIds);
    const forms = await sql<{ id: string; signed_by: string | null; note: string | null }>`
      SELECT id, signed_by, note FROM core_agreement_acceptance
      WHERE by = 'paper' AND person_id IN ${list(dependants)}
        AND (signed_by IS NOT NULL OR note IS NOT NULL)`.execute(ctx.db);
    const naming = forms.rows
      .filter((f) => namesThem(`${f.signed_by ?? ""}\n${f.note ?? ""}`, names))
      .map((f) => f.id);
    if (naming.length) {
      ctx.write(
        sql`UPDATE core_agreement_acceptance SET signed_by = NULL, note = NULL
          WHERE by = 'paper' AND id IN ${list(naming)}`.compile(ctx.db),
      );
    }
  }
  const unpaid = guests.filter((g) => g.unpaid).map((g) => g.id);
  const unsettled = guests.filter((g) => !g.unpaid && g.paidUnsettled).map((g) => g.id);
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
