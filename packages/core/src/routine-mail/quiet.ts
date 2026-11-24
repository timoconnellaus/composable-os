// Quiet hours (ADR 0676): texts and pushes do not buzz a phone overnight. One business-wide
// window (21:00 to 07:00 unless an admin chose), in the business's own time zone; email always
// goes at once. A text or push prepared inside the window waits until it ends, unless its kind is
// urgent and its moment (`until`, a class's start) comes before the window ends: a 6am class
// cancelled at 5am goes now, a class next week waits. A waiting one whose moment has passed when
// the window ends is dropped (`expired`); its email went when it was prepared.
import { z } from "zod";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export const quietHoursSchema = z
  .object({
    /** When texts and pushes start waiting, local time (`21:00`). */
    start: z.string().regex(CLOCK, "HH:MM"),
    /** When they go again (`07:00`). The same as `start`: no quiet hours. */
    end: z.string().regex(CLOCK, "HH:MM"),
  })
  .strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** Decision 4: 9pm to 7am. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "21:00", end: "07:00" };

const minutesOf = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return (h as number) * 60 + (m as number);
};

/** Seconds since local midnight at `at` in `zone`, or null for a zone Intl does not know. */
function localSeconds(at: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const seconds = get("hour") * 3600 + get("minute") * 60 + get("second");
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * When quiet hours that hold `at` end, as an instant, or null when `at` is outside them. A night
 * the clocks change is corrected once, so the end is the local `end` time of that morning.
 */
export function quietUntil(at: number, zone: string, quiet: QuietHours): number | null {
  const start = minutesOf(quiet.start) * 60;
  const end = minutesOf(quiet.end) * 60;
  if (start === end) return null;
  const now = localSeconds(at, zone) ?? localSeconds(at, "UTC");
  if (now === null) return null;
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const wait = (end - now + 86_400) % 86_400;
  let until = Math.floor(at / 1000) * 1000 + wait * 1000;
  // A change of the clocks in the night moves the local end by the change: put it back on `end`.
  const landed = localSeconds(until, zone);
  if (landed !== null && landed !== end) {
    const drift = ((landed - end + 86_400 + 43_200) % 86_400) - 43_200;
    until -= drift * 1000;
  }
  return until;
}

/**
 * What quiet hours do to a text or push prepared at `at`: go now, or wait until a moment. An
 * urgent kind goes now when its moment is before quiet hours end (waiting would make it late).
 */
export function quietDecision(
  at: number,
  zone: string,
  quiet: QuietHours,
  kind: { urgent: boolean; until: number | null },
): { waitUntil: string | null } {
  const until = quietUntil(at, zone, quiet);
  if (until === null) return { waitUntil: null };
  if (kind.urgent && kind.until !== null && kind.until < until) return { waitUntil: null };
  return { waitUntil: new Date(until).toISOString() };
}
