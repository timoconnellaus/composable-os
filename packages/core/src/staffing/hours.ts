// Open hours (stage 49 step 3, ADR 0762): when someone takes appointments, in core_staff_hours.
// A weekly rule is read by wall clock in its zone, on the fly, as a regular time off is
// (`regularOverlaps`), so 09:00 to 17:00 is eight hours on both sides of a clock change and 22:00
// to 06:00 runs into the next day. Extra hours are a range of instants. What a range is open for
// is every kind of work, or the kinds it lists. Free times (step 4) subtract time off, claims and
// rooms from these ranges; nothing here reads them.
import type { CoreStaffHoursTable } from "@composable-os/db";
import {
  isoWeekday,
  localParts,
  parseLocalTime,
  wallClockOf,
  wallClockToInstant,
} from "../time/local.ts";

/** The most open-hours entries one account holds (weekly and extra together). */
export const HOURS_MAX = 50;

/** A kind of work an entry is open for (the shift's `staffed.kind`: a service, a class type). */
export interface KindRef {
  object: string;
  id: string;
}

/** A half-open range of unix seconds. */
export interface Range {
  starts: number;
  ends: number;
}

type HoursRow = Pick<
  CoreStaffHoursTable,
  | "kind"
  | "weekdays"
  | "start_time"
  | "end_time"
  | "from_date"
  | "until_date"
  | "starts_at"
  | "ends_at"
  | "zone"
  | "only_for"
>;

const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Adds `days` to a `YYYY-MM-DD` date. */
function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The kinds an entry is open for, or null for every kind. */
export function onlyForOf(row: Pick<CoreStaffHoursTable, "only_for">): KindRef[] | null {
  if (!row.only_for) return null;
  const list = JSON.parse(row.only_for) as KindRef[];
  return list.length ? list : null;
}

/** Whether an entry is open for `kind` (every entry is, when no kind is asked about). */
export function openFor(row: Pick<CoreStaffHoursTable, "only_for">, kind?: KindRef): boolean {
  const only = onlyForOf(row);
  return !only || !kind || only.some((k) => k.object === kind.object && k.id === kind.id);
}

/** One entry's open ranges that overlap `from`..`to` (unix seconds), unclipped. */
function rangesOf(row: HoursRow, from: number, to: number): Range[] {
  if (row.kind === "extra") {
    if (!row.starts_at || !row.ends_at) return [];
    const starts = Date.parse(row.starts_at) / 1000;
    const ends = Date.parse(row.ends_at) / 1000;
    return starts < to && ends > from ? [{ starts, ends }] : [];
  }
  const days = new Set(
    (row.weekdays ?? "")
      .split(",")
      .map((d) => WEEKDAY_NAMES.indexOf(d.trim()) + 1)
      .filter((d) => d > 0),
  );
  const open = parseLocalTime(row.start_time ?? "");
  const close = parseLocalTime(row.end_time ?? "");
  if (!days.size || open === null || close === null) return [];
  const out: Range[] = [];
  // The day before too: an overnight rule that started then runs into the range.
  const first = plusDays(localParts(from * 1000, row.zone).date, -1);
  const last = localParts(Math.max(from, to - 1) * 1000, row.zone).date;
  for (let date = first; date <= last; date = plusDays(date, 1)) {
    if (!days.has(isoWeekday(date))) continue;
    if (row.from_date && date < row.from_date) continue;
    if (row.until_date && date > row.until_date) continue;
    const starts = wallClockToInstant(wallClockOf(date, open), row.zone) / 1000;
    const ends =
      wallClockToInstant(wallClockOf(close > open ? date : plusDays(date, 1), close), row.zone) /
      1000;
    if (starts < to && ends > from) out.push({ starts, ends });
  }
  return out;
}

/**
 * When `rows` (one person's open hours) are open for `kind` between `from` and `to` (unix
 * seconds): the ranges clipped to from..to, in order, touching and overlapping ones merged, so
 * 09:00 to 12:00 and 12:00 to 15:00 are one range. Bounded by the caller (free times read at most
 * 31 days).
 */
export function openRanges(
  rows: readonly HoursRow[],
  from: number,
  to: number,
  kind?: KindRef,
): Range[] {
  if (!(to > from)) return [];
  const all = rows
    .filter((row) => openFor(row, kind))
    .flatMap((row) => rangesOf(row, from, to))
    .map((r) => ({ starts: Math.max(r.starts, from), ends: Math.min(r.ends, to) }))
    .filter((r) => r.ends > r.starts)
    .sort((a, b) => a.starts - b.starts);
  const merged: Range[] = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r.starts <= last.ends) last.ends = Math.max(last.ends, r.ends);
    else merged.push({ ...r });
  }
  return merged;
}

/** Whether `rows` are open for `kind` over the whole of `starts`..`ends`. */
export function openCovers(
  rows: readonly HoursRow[],
  starts: number,
  ends: number,
  kind?: KindRef,
): boolean {
  const ranges = openRanges(rows, starts, ends, kind);
  return ranges.length === 1 && ranges[0]?.starts === starts && ranges[0]?.ends === ends;
}
