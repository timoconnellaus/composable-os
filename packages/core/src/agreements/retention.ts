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
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", KEEP_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_KEEP_YEARS;
  try {
    const parsed = keepYearsSchema.safeParse((JSON.parse(row.value) as { years?: unknown }).years);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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

/** Acceptances the purge may take now, oldest first, at most `limit` (index-ordered). */
export async function purgeableKept(
  db: Kysely<CoreDatabase>,
  now: string,
  limit: number,
): Promise<string[]> {
  const cutoff = purgeCutoff(now, await loadKeepYears(db));
  if (!cutoff) return [];
  const { rows } = await sql<{ id: string }>`
    SELECT a.id FROM core_agreement_acceptance a
    WHERE a.erased_at IS NOT NULL AND a.erased_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM core_agreement_copy c
        WHERE c.acceptance_id = a.id AND c.scrub_due_at IS NOT NULL)
    ORDER BY a.erased_at
    LIMIT ${limit}`.execute(db);
  return rows.map((r) => r.id);
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
