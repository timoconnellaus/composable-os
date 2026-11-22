// Wall clocks and instants in a time zone. The first part (the zone's offset, a real wall clock)
// was private to subscriptions/offers.ts (`paidUpMoment`) and is moved here unchanged, shared with
// stage 31's timetable; below it, what the allowance's periods need (stage 32b, ADR 0493).

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

// --- Wall clocks to instants and back (stage 32b, ADR 0493) --------------------------------------
//
// A wall-clock time in a zone (06:00 in Australia/Sydney on a date) is turned into the instant it
// names, across a change of clocks; an instant is read back as its zone's date, weekday and minute
// of the day. Where a wall clock is not one instant:
//   - a time that does not exist (02:30 on the morning clocks go forward) moves forward by the
//     gap: it is read with the offset in force before the change (03:30 after it);
//   - a time that happens twice (01:30 on the morning clocks go back) is the first of the two.

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    offsetFormatters.set(timeZone, f);
  }
  return f;
}

/** A wall clock: a date and a time of day, with no zone. Months and days count from 1. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** What an instant reads as in a zone. `weekday` is ISO: 1 is Monday, 7 is Sunday. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Minutes since the local midnight, 0 to 1439. */
  minuteOfDay: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");

/** The date, time and weekday of the instant `at` (ms since the epoch) in `timeZone`. */
export function localParts(at: number | Date | string, timeZone: string): LocalParts {
  const ms = typeof at === "number" ? at : new Date(at).getTime();
  const parts = Object.fromEntries(
    offsetFormatter(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAYS.indexOf(String(parts.weekday)) + 1,
    date: `${year}-${pad(month)}-${pad(day)}`,
    minuteOfDay: hour * 60 + minute,
  };
}

const HOUR = 3_600_000;

/**
 * The instant (ms since the epoch) a wall clock names in `timeZone`. A time skipped by a change
 * of clocks moves forward by the gap; a time that happens twice is the first.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): number {
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  );
  // The offsets either side of any change near this time: a change of clocks is at most a few
  // hours, and never two within a day.
  const before = zoneOffset(asUtc - 14 * HOUR, timeZone);
  const after = zoneOffset(asUtc + 14 * HOUR, timeZone);
  const reads = (at: number) => {
    const p = localParts(at, timeZone);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) ===
      asUtc - (((asUtc % 1000) + 1000) % 1000)
    );
  };
  const candidates = [asUtc - before, asUtc - after].filter(reads).sort((a, b) => a - b);
  // A skipped time: read it with the offset before the change, which lands past the gap.
  return candidates[0] ?? asUtc - before;
}

/** The ISO string of `wallClockToInstant`. */
export function wallClockToIso(wall: WallClock, timeZone: string): string {
  return new Date(wallClockToInstant(wall, timeZone)).toISOString();
}

/** The local date `days` after `date` (`YYYY-MM-DD`), as a wall clock at midnight. */
export function addLocalDays(date: { year: number; month: number; day: number }, days: number) {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}
