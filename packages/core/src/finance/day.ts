// The business's day and month (stage 52, ADR 0790). Every date in finance is a local date in the
// organisation's zone (`org_timezone`): a day runs from its local midnight to the next one, so a day
// across a clock change is 23 or 25 hours and nothing is cut at UTC midnight. A month runs from
// its first day to its last, local.
import { ValidationError } from "../errors.ts";
import { addLocalDays, localParts, parseLocalDate, wallClockToInstant } from "../time/local.ts";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/** A span of local dates (both included) in a zone, with its instants as unix seconds, half-open. */
export interface LocalRange {
  start: string;
  end: string;
  zone: string;
  starts: number;
  ends: number;
}

/** The instant (unix seconds) of the local midnight starting `date` in `zone`. */
export function midnightOf(date: string, zone: string): number {
  const d = parseLocalDate(date);
  if (!d) throw new ValidationError(`${date} is not a date`, { field: "date" });
  return Math.floor(wallClockToInstant({ ...d, hour: 0, minute: 0 }, zone) / 1000);
}

/** The local date after `date`. */
export function nextDate(date: string): string {
  const d = parseLocalDate(date);
  if (!d) throw new ValidationError(`${date} is not a date`, { field: "date" });
  return fmt(addLocalDays(d, 1));
}

/** A business day: its local midnight to the next one. */
export function dayRange(date: string, zone: string): LocalRange {
  return {
    start: date,
    end: date,
    zone,
    starts: midnightOf(date, zone),
    ends: midnightOf(nextDate(date), zone),
  };
}

/** The local dates from `start` to `end`, both included. */
export function datesOf(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = nextDate(d)) out.push(d);
  return out;
}

/** The local date the instant `seconds` falls on in `zone`. */
export function localDateAt(seconds: number, zone: string): string {
  return localParts(seconds * 1000, zone).date;
}

/** The month (`YYYY-MM`) the instant `seconds` falls in, in `zone`. */
export function localMonthAt(seconds: number, zone: string): string {
  return localDateAt(seconds, zone).slice(0, 7);
}

/** A month's year and number, or null when `month` is not `YYYY-MM`. */
export function parseMonth(month: string): { year: number; month: number } | null {
  const m = MONTH_RE.exec(month);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

function requireMonth(month: string) {
  const m = parseMonth(month);
  if (!m) throw new ValidationError(`${month} is not a month (YYYY-MM)`, { field: "month" });
  return m;
}

/** The month `n` months after `month` (before, when `n` is negative). */
export function addMonths(month: string, n: number): string {
  const m = requireMonth(month);
  const index = m.year * 12 + (m.month - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${pad((index % 12) + 1)}`;
}

/** A month's first and last local dates. */
export function monthDates(month: string): { start: string; end: string } {
  const m = requireMonth(month);
  const last = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${pad(last)}` };
}

/** A month in `zone`: day 1 to its last day, its instants from local midnight to local midnight. */
export function monthRange(month: string, zone: string): LocalRange {
  const { start, end } = monthDates(month);
  return {
    start,
    end,
    zone,
    starts: midnightOf(start, zone),
    ends: midnightOf(nextDate(end), zone),
  };
}
