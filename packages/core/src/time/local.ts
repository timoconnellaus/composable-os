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
