// Finance periods (stage 52, ADR 0790): the months the business closes, their versions, and the
// finance settings. A month is open (no version), closed (version n), or reopened (version n kept,
// with who, when and why) and then open again until it is closed as version n + 1.
//
// - **Its dates and instants**: a month with a version keeps the zone, dates and instants it was
//   first closed with, whatever the organisation's zone is since. An open month is in the
//   organisation's zone now, starting at the very instant the stored month before it ends (and
//   ending where a stored month after it starts), so a change of zone leaves no hour in two months
//   or in none.
// - **The first month** is the month finance was installed in (migration 1150's instant, read in
//   the organisation's zone), or an earlier month a human admin picks before anything is closed.
// - **In order**: a month is closed once it has ended and the month before it is closed (or it is
//   the first); a month is reopened only while no later month is closed.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addMonths, type LocalRange, localMonthAt, monthRange, parseMonth } from "./day.ts";

type Db = Kysely<CoreDatabase>;
export type PeriodRow = CoreDatabase["core_finance_period"];

/** The finance settings (`finance.settings.update`, a human admin's). */
export const FINANCE_SETTINGS = "finance_settings";
/** When finance was installed (migration 1150): its local month is the first month by default. */
export const FINANCE_INSTALLED_SETTING = "finance_installed_at";

export interface FinanceSettings {
  /** The financial year's first month, 1 to 12: used only to add months into a year. */
  yearStartMonth: number;
  /** The first month an admin picked, earlier than the install month; null: the install month. */
  firstPeriod: string | null;
  /** Labels an admin gave sales categories (`category key` → label), over the packs' own. */
  categoryLabels: Record<string, string>;
}

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {
  yearStartMonth: 1,
  firstPeriod: null,
  categoryLabels: {},
};

const parseJson = (value: string | undefined): unknown => {
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/** The stored settings, each part falling back to its default when missing or unreadable. */
export async function loadFinanceSettings(
  db: Db,
): Promise<FinanceSettings & { installedAt: string | null }> {
  const rows = await db
    .selectFrom("core_settings")
    .select(["key", "value"])
    .where("key", "in", [FINANCE_SETTINGS, FINANCE_INSTALLED_SETTING])
    .execute();
  const raw = parseJson(rows.find((r) => r.key === FINANCE_SETTINGS)?.value);
  const installed = parseJson(rows.find((r) => r.key === FINANCE_INSTALLED_SETTING)?.value);
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const year = Number(s.yearStartMonth);
  const labels: Record<string, string> = {};
  if (s.categoryLabels && typeof s.categoryLabels === "object") {
    for (const [k, v] of Object.entries(s.categoryLabels as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) labels[k] = v.trim();
    }
  }
  return {
    yearStartMonth: Number.isInteger(year) && year >= 1 && year <= 12 ? year : 1,
    firstPeriod:
      typeof s.firstPeriod === "string" && parseMonth(s.firstPeriod) ? s.firstPeriod : null,
    categoryLabels: labels,
    installedAt:
      typeof installed === "string" && !Number.isNaN(Date.parse(installed)) ? installed : null,
  };
}

/** Where finance stands: the organisation's zone, the first month and the month it is now. */
export interface FinanceClock {
  zone: string;
  firstMonth: string;
  /** The month finance was installed in, in the zone now: the first month unless one was picked. */
  installedMonth: string;
  currentMonth: string;
  /** Now, unix seconds. */
  now: number;
}

export async function financeClock(db: Db, nowIso: string): Promise<FinanceClock> {
  const [{ timezone }, settings] = await Promise.all([
    loadGeneralSettings(db),
    loadFinanceSettings(db),
  ]);
  const now = Math.floor(Date.parse(nowIso) / 1000);
  const currentMonth = localMonthAt(now, timezone);
  const installedMonth = settings.installedAt
    ? localMonthAt(Math.floor(Date.parse(settings.installedAt) / 1000), timezone)
    : currentMonth;
  return {
    zone: timezone,
    firstMonth: settings.firstPeriod ?? installedMonth,
    installedMonth,
    currentMonth,
    now,
  };
}

/** Every version of the months asked for (the `closing` rows of a batch in flight left out). */
export async function versionsOf(db: Db, months: readonly string[]): Promise<PeriodRow[]> {
  if (!months.length) return [];
  return (await db
    .selectFrom("core_finance_period")
    .selectAll()
    .where("month", "in", jsonList([...months]))
    .where("state", "!=", "closing")
    .orderBy("month")
    .orderBy("version")
    .execute()) as PeriodRow[];
}

const rangeOfRow = (row: PeriodRow): LocalRange => ({
  start: row.start_date,
  end: row.end_date,
  zone: row.zone,
  starts: row.starts,
  ends: row.ends,
});

/**
 * A month's dates and instants, from the versions of it and of the months either side: its latest
 * version's, else the organisation's zone now, joined to the stored months either side of it.
 */
export function rangeFrom(rows: readonly PeriodRow[], month: string, zone: string): LocalRange {
  const latest = (m: string) => rows.filter((r) => r.month === m).at(-1);
  const own = latest(month);
  if (own) return rangeOfRow(own);
  const range = monthRange(month, zone);
  const prev = latest(addMonths(month, -1));
  const next = latest(addMonths(month, 1));
  return {
    ...range,
    starts: prev ? prev.ends : range.starts,
    ends: next ? next.starts : range.ends,
  };
}

/** A month's dates and instants (`rangeFrom`), read. */
export async function rangeOf(db: Db, month: string, zone: string): Promise<LocalRange> {
  return rangeFrom(
    await versionsOf(db, [addMonths(month, -1), month, addMonths(month, 1)]),
    month,
    zone,
  );
}

/** A month is closed when its latest version is. */
export const isClosed = (versions: readonly PeriodRow[]) => versions.at(-1)?.state === "closed";

/** The latest closed month after `month`, if any (reopening `month` waits for it). */
export async function laterClosed(db: Db, month: string): Promise<string | null> {
  const row = await db
    .selectFrom("core_finance_period")
    .select("month")
    .where("state", "=", "closed")
    .where("month", ">", month)
    .orderBy("month", "desc")
    .executeTakeFirst();
  return row?.month ?? null;
}

/** Whether any month has a version (the first month is fixed from then on). */
export async function anyVersion(db: Db): Promise<boolean> {
  return !!(await db.selectFrom("core_finance_period").select("id").limit(1).executeTakeFirst());
}
