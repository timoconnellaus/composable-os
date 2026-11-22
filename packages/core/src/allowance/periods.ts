// The periods an allowance counts in (stage 32b, ADR 0493): all time, a week from Monday 00:00,
// or a calendar month from the 1st at 00:00, in the holder's zone. A period is named by its local
// start (`week:2026-11-23`, `month:2026-11`), so the same instant always falls in the same period
// and a change of clocks inside a week moves nothing: the week is still Monday to Monday on the
// wall clock, 167 or 169 hours long.
import { addLocalDays, localParts, wallClockToIso } from "../local-time.ts";

export type AllowancePer = "total" | "week" | "month";

/** One period: its key and its bounds, ISO instants, [startsAt, endsAt). */
export interface AllowancePeriod {
  key: string;
  per: AllowancePer;
  startsAt: string;
  endsAt: string;
}

/** The bounds of the one `total` period: every instant the host writes is inside them. */
export const TOTAL_PERIOD = {
  key: "total",
  per: "total",
  startsAt: "0000-01-01T00:00:00.000Z",
  endsAt: "9999-12-31T23:59:59.999Z",
} as const satisfies AllowancePeriod;

const pad = (n: number) => String(n).padStart(2, "0");

/** The period of `per` in `zone` containing the instant `at` (an ISO string). */
export function periodOf(at: string, per: AllowancePer, zone: string): AllowancePeriod {
  if (per === "total") return { ...TOTAL_PERIOD };
  const local = localParts(at, zone);
  if (per === "week") {
    const monday = addLocalDays(local, 1 - local.weekday);
    return {
      key: `week:${monday.year}-${pad(monday.month)}-${pad(monday.day)}`,
      per,
      startsAt: wallClockToIso(monday, zone),
      endsAt: wallClockToIso(addLocalDays(monday, 7), zone),
    };
  }
  const first = { year: local.year, month: local.month, day: 1 };
  const next =
    local.month === 12
      ? { year: local.year + 1, month: 1, day: 1 }
      : { year: local.year, month: local.month + 1, day: 1 };
  return {
    key: `month:${local.year}-${pad(local.month)}`,
    per,
    startsAt: wallClockToIso(first, zone),
    endsAt: wallClockToIso(next, zone),
  };
}

/**
 * A holder's `from` or `until` as an instant. A datetime is itself. A date is that day's local
 * midnight for `from`, and the next day's for `until`: a pass valid until the 10th can pay for a
 * class at 20:00 on the 10th.
 */
export function boundOf(
  value: unknown,
  kind: "from" | "until",
  fieldType: string | undefined,
  zone: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date || fieldType === "date") {
    const [y, m, d] = date
      ? [Number(date[1]), Number(date[2]), Number(date[3])]
      : (() => {
          const p = localParts(text, zone);
          return [p.year, p.month, p.day];
        })();
    const day = { year: y as number, month: m as number, day: d as number };
    return wallClockToIso(kind === "until" ? addLocalDays(day, 1) : day, zone);
  }
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
