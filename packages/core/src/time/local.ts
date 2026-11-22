// Local wall-clock time in a time zone (ADR 0460): the offset of a zone at an instant, and whether
// a day and time exist. Moved unchanged from subscriptions/offers.ts (`paidUpMoment`), so
// `recurring`, closures, booking windows and allowances share one helper.

/** The offset of `timeZone` from UTC at `at`, in milliseconds. */
export function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
}

/** Whether these are a real day and time (no 30 February, no 24:00), checked by a round trip. */
export function realWallClock(y: number, m: number, d: number, h = 0, mi = 0, s = 0): boolean {
  const at = new Date(Date.UTC(y, m - 1, d, h, mi, s));
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === m - 1 &&
    at.getUTCDate() === d &&
    at.getUTCHours() === h &&
    at.getUTCMinutes() === mi &&
    at.getUTCSeconds() === s
  );
}

// --- Local dates and times (stage 31, ADR 0500) ---------------------------------------------------
//
// What `recurring`, closures and booking windows need on top: a local date and time in a zone
// to an instant across a clock change, and back. No Temporal: dates are `YYYY-MM-DD` strings,
// instants are milliseconds since the epoch.
//
// A local time that does not exist on a change day (02:30 when clocks go forward an hour) is
// moved forward by the gap (03:30); one that happens twice (02:30 when clocks go back) is the
// first of the two. Both are what a person standing in the room would expect a 02:30 class to do.

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` date's parts, or null when it is not a real date. */
export function parseLocalDate(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return realWallClock(y, m, d) ? { y, m, d } : null;
}

/** `HH:MM` (00:00 to 23:59) as minutes of the day, or null. */
export function parseLocalTime(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const [h, mi] = [Number(match[1]), Number(match[2])];
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** The date `days` after `date` (before, when negative): calendar arithmetic, no zone. */
export function addDays(date: string, days: number): string {
  const parts = parseLocalDate(date);
  if (!parts) throw new RangeError(`Not a date: ${date}`);
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days)).toISOString().slice(0, 10);
}

/** The ISO weekday of a date: 1 is Monday, 7 is Sunday. */
export function isoWeekday(date: string): number {
  const parts = parseLocalDate(date);
  if (!parts) throw new RangeError(`Not a date: ${date}`);
  const day = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The instant of a local date and time (minutes of the day) in `timeZone`. A time in the gap of
 * a clock change moves forward by the gap; a time that happens twice is the first.
 */
export function localInstant(date: string, minutes: number, timeZone: string): number {
  const parts = parseLocalDate(date);
  if (!parts) throw new RangeError(`Not a date: ${date}`);
  const wall = Date.UTC(parts.y, parts.m - 1, parts.d, 0, minutes);
  // The offsets either side of any change near this day: at most one change in two days.
  const before = zoneOffset(wall - DAY_MS, timeZone);
  const after = zoneOffset(wall + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((at) => at + zoneOffset(at, timeZone) === wall)
    .sort((a, b) => a - b);
  // In the gap no offset gives the wall clock back: the offset before the change reads it as
  // the same length of time after the change began, which is forward by the gap.
  return valid[0] ?? wall - before;
}

/** The local date and minutes of the day of an instant in `timeZone`. */
export function localParts(at: number, timeZone: string): { date: string; minutes: number } {
  const local = new Date(at + zoneOffset(at, timeZone));
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** The instant `days` local days before `at` (after, when negative), at the same wall clock. */
export function localDaysBefore(at: number, days: number, timeZone: string): number {
  const { date, minutes } = localParts(at, timeZone);
  const seconds = Math.floor((at + zoneOffset(at, timeZone)) / 1000) % 60;
  return localInstant(addDays(date, -days), minutes, timeZone) + seconds * 1000;
}
