// The booking-system copy's settings and its lists' ages (stage 65, ADR 0922). One row of settings,
// a human admin's (`outside.settings.update`); every list's age is worked out when it is read, from
// the date its file was exported, so no cron is needed for it.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, type Selectable, type SqlBool, sql } from "kysely";
import { localDateAt } from "../finance/day.ts";
import { loadGeneralSettings } from "../settings.ts";

type Db = Kysely<CoreDatabase>;

/** The kinds of list a business loads. */
export const LIST_KINDS = ["members", "timetable"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** A members list counts for this many days from its export, unless an admin sets otherwise. */
export const DEFAULT_LARGEST_AGE_DAYS = 31;
export const MAX_LARGEST_AGE_DAYS = 90;
/** The admins are told this many days before a members list stops counting (stage 65 step 4). */
export const TOO_OLD_NOTICE_DAYS = 3;
/** Replaced and removed lists stay this long as a log (counts only). */
export const LIST_LOG_DAYS = 30;

export interface OutsideSettings {
  source: "file";
  /** Off: the copy is kept, and nothing reads it (every outside read answers empty). */
  enabled: boolean;
  /** The outside membership and pass types that make a Person a member; null: every `membership`. */
  memberTypes: string[] | null;
  /** Where a member manages their membership, and where to book a class: https, shown as is. */
  manageUrl: string | null;
  bookUrl: string | null;
  largestAgeDays: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const DEFAULT_OUTSIDE_SETTINGS: OutsideSettings = {
  source: "file",
  enabled: true,
  memberTypes: null,
  manageUrl: null,
  bookUrl: null,
  largestAgeDays: DEFAULT_LARGEST_AGE_DAYS,
  updatedBy: null,
  updatedAt: null,
};

function stringList(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

/** The stored settings, or the defaults when the row is missing. */
export async function loadOutsideSettings(db: Db): Promise<OutsideSettings> {
  const row = await db
    .selectFrom("core_outside_settings")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!row) return { ...DEFAULT_OUTSIDE_SETTINGS };
  return {
    source: "file",
    enabled: row.enabled === 1,
    memberTypes: stringList(row.member_types),
    manageUrl: row.manage_url,
    bookUrl: row.book_url,
    largestAgeDays: row.largest_age_days,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export type ListRow = Selectable<CoreDatabase["core_outside_list"]>;

/** The current list of each kind (at most one per kind). */
export async function currentLists(db: Db): Promise<Map<ListKind, ListRow>> {
  const rows = await db
    .selectFrom("core_outside_list")
    .selectAll()
    .where("state", "=", "current")
    .execute();
  return new Map(rows.map((r) => [r.kind, r]));
}

/**
 * Rows of a current list. A removed list's rows still waiting for the removal's next pass
 * (`outside/remove.ts`) are no copy: every read of the copy holds to this (stage 65 step 10).
 */
export function onCurrentList(column: string) {
  return sql<SqlBool>`${sql.ref(column)} IN (SELECT id FROM core_outside_list WHERE state = 'current')`;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Today in the organisation's zone, for a list's age. */
export async function businessToday(db: Db, now: string): Promise<string> {
  const { timezone } = await loadGeneralSettings(db);
  return localDateAt(Math.floor(Date.parse(now) / 1000), timezone);
}

export interface ListAge {
  /** Days since the export date, in the business's zone (0 on the day itself). */
  days: number;
  /** A members list past the largest age stops counting; it is still shown, marked so. */
  tooOld: boolean;
  /** The last day it counts. */
  countsUntil: string;
}

/** A list's age on `today`: within the largest age it counts; past it, it is "too old to count". */
export function listAge(exportedOn: string, today: string, largestAgeDays: number): ListAge {
  const days = Math.max(0, daysBetween(exportedOn, today));
  const until = new Date(Date.parse(`${exportedOn}T00:00:00Z`) + largestAgeDays * 86_400_000);
  return {
    days,
    tooOld: days > largestAgeDays,
    countsUntil: until.toISOString().slice(0, 10),
  };
}
