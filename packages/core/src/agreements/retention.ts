// Keeping acceptances after erase, and the purge after the retention period (stage 44 step 8,
// ADR 0646; decision 15).
//
// - The setting: `agreement_retention` in core_settings, `{"years": n}`, a whole number of years
//   from 1 to 50, default 7 (a guess: the number is the business's lawyer's). A human admin's
//   choice (`agreement.setRetention`). Counted from the erase.
// - The purge (`agreement.purgeKept`, the daily cron's host step): deletes acceptances kept longer
//   than the period, oldest first, a bounded number per run, with their signature, answers and
//   copy row first. It passes by one a person put on hold, and one whose copy still owes the
//   email gatekeeper a scrub. Migration 0855's triggers refuse any other delete, by any writer,
//   whatever this code does.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { GateFloor } from "../gate.ts";
import { SYSTEM_USER } from "../users.ts";

export const KEEP_SETTING = "agreement_retention";
export const DEFAULT_KEEP_YEARS = 7;

export const keepYearsSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe("Years an erased person's acceptances are kept, counted from the erase (1 to 50)");

/**
 * The retention period in years. Missing: the default. A value that is not a whole number of
 * years from 1 to 50 is read as null: nothing is purged (a broken setting never deletes evidence
 * early; the database's triggers read it the same way).
 */
export async function loadKeepYears(db: Kysely<CoreDatabase>): Promise<number | null> {
  // Read by SQLite's own JSON functions, exactly as migration 0855's triggers read it, so the
  // host and the database never disagree (`7.0` is a real, not an integer, to both: the review
  // of PR #288).
  const { rows } = await sql<{ type: string | null; years: unknown }>`
    SELECT json_type(value, '$.years') AS type, json_extract(value, '$.years') AS years
    FROM core_settings WHERE key = ${KEEP_SETTING}`.execute(db);
  const row = rows[0];
  if (!row) return DEFAULT_KEEP_YEARS;
  if (row.type !== "integer") return null;
  const parsed = keepYearsSchema.safeParse(Number(row.years));
  return parsed.success ? parsed.data : null;
}

function shiftYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

/** When an acceptance erased at `erasedAt` is purged; null when nothing is purged. */
export function keptUntil(erasedAt: string, years: number | null): string | null {
  return years === null ? null : shiftYears(erasedAt, years);
}

/** Erased before this is past the period. Null: nothing is past it. */
export function purgeCutoff(now: string, years: number | null): string | null {
  return years === null ? null : shiftYears(now, -years);
}

/** The purge's bound per run. */
export const PURGE_KEPT_MAX = 100;

/**
 * A scrub owed this long no longer holds a kept acceptance past its retention period: the purge
 * goes ahead, and audits that the email gatekeeper may still hold the copy (the review of PR
 * #288). Migration 0855's copy trigger uses the same 30 days.
 */
export const SCRUB_GIVE_UP_DAYS = 30;

/** Acceptances the purge may take now, oldest first, at most `limit` (index-ordered). */
export async function purgeableKept(
  db: Kysely<CoreDatabase>,
  now: string,
  limit: number,
): Promise<{ id: string; unscrubbed: boolean }[]> {
  const cutoff = purgeCutoff(now, await loadKeepYears(db));
  if (!cutoff) return [];
  const giveUp = new Date(Date.parse(now) - SCRUB_GIVE_UP_DAYS * 86_400_000).toISOString();
  const { rows } = await sql<{ id: string; unscrubbed: number }>`
    SELECT a.id, EXISTS (SELECT 1 FROM core_agreement_copy c
        WHERE c.acceptance_id = a.id AND c.scrub_due_at IS NOT NULL) AS unscrubbed
    FROM core_agreement_acceptance a
    WHERE a.erased_at IS NOT NULL AND a.erased_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM core_agreement_copy c
        WHERE c.acceptance_id = a.id AND c.scrub_due_at IS NOT NULL
          AND (c.scrub_owed_since IS NULL OR c.scrub_owed_since >= ${giveUp}))
    ORDER BY a.erased_at
    LIMIT ${limit}`.execute(db);
  return rows.map((r) => ({ id: r.id, unscrubbed: Boolean(r.unscrubbed) }));
}

/** How many kept acceptances would be past a period of `years` now (not on hold). */
export async function keptPastPeriod(
  db: Kysely<CoreDatabase>,
  now: string,
  years: number,
): Promise<number> {
  const cutoff = purgeCutoff(now, years) as string;
  const { rows } = await sql<{ n: number }>`
    SELECT count(*) AS n FROM core_agreement_acceptance a
    WHERE a.erased_at IS NOT NULL AND a.erased_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id)`.execute(
    db,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The daily cron's agreements step: `agreement.purgeKept` until nothing more is due (or
 * `maxRounds`). Silent when nothing is due: no operation runs and no audit row is written.
 */
export async function runAgreementRetention(
  db: CrmDb,
  {
    floor,
    clock,
    maxRounds = 10,
  }: { floor?: GateFloor; clock?: () => Date; maxRounds?: number } = {},
): Promise<{ purged: number; rounds: number; more: boolean }> {
  const totals = { purged: 0, rounds: 0, more: false };
  const now = (clock?.() ?? new Date()).toISOString();
  if (!(await purgeableKept(db.query, now, 1)).length) return totals;
  // Loaded lazily: invoke.ts imports every operation (and so this module).
  const { invoke } = await import("../invoke.ts");
  let more = true;
  while (more && totals.rounds < maxRounds) {
    totals.rounds += 1;
    const result = (await invoke(
      "agreement.purgeKept",
      {},
      {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "system.agreements" },
        db,
        ...(floor ? { floor } : {}),
        ...(clock ? { clock } : {}),
      },
    )) as { purged: number; more: boolean };
    totals.purged += result.purged;
    more = result.more;
  }
  totals.more = more;
  return totals;
}
