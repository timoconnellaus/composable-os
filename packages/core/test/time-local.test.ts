// Stage 31 (ADR 0500): the shared wall-clock helper. A local date and time in a zone becomes an
// instant across both clock changes, in a zone with whole-hour offsets, one with half-hour
// offsets, and one whose clocks change by half an hour. A time in the gap moves forward by the
// gap; a time that happens twice is the first.
import { describe, expect, it } from "vitest";
import {
  addDays,
  isoWeekday,
  localDaysBefore,
  localInstant,
  localParts,
  parseLocalTime,
  realWallClock,
  zoneOffset,
} from "../src/index.ts";

const at = (date: string, time: string, zone: string) =>
  new Date(localInstant(date, parseLocalTime(time) as number, zone)).toISOString();

describe("a local time to an instant", () => {
  it("keeps 06:00 at 06:00 on both sides of each clock change (whole hours)", () => {
    const zone = "Australia/Sydney";
    // Clocks go back on Sunday 5 April 2026 (+11 to +10) and forward on 4 October (+10 to +11).
    expect(at("2026-04-04", "06:00", zone)).toBe("2026-04-03T19:00:00.000Z");
    expect(at("2026-04-05", "06:00", zone)).toBe("2026-04-04T20:00:00.000Z");
    expect(at("2026-10-03", "06:00", zone)).toBe("2026-10-02T20:00:00.000Z");
    expect(at("2026-10-04", "06:00", zone)).toBe("2026-10-03T19:00:00.000Z");
  });

  it("keeps 06:00 at 06:00 in a zone with a half-hour offset", () => {
    const zone = "Australia/Adelaide";
    expect(at("2026-04-04", "06:00", zone)).toBe("2026-04-03T19:30:00.000Z");
    expect(at("2026-04-05", "06:00", zone)).toBe("2026-04-04T20:30:00.000Z");
    expect(at("2026-10-03", "06:00", zone)).toBe("2026-10-02T20:30:00.000Z");
    expect(at("2026-10-04", "06:00", zone)).toBe("2026-10-03T19:30:00.000Z");
  });

  it("moves a time in the gap forward by the gap", () => {
    // 02:30 does not exist on 4 October in Sydney: it is 03:30, an hour later.
    expect(at("2026-10-04", "02:30", "Australia/Sydney")).toBe("2026-10-03T16:30:00.000Z");
    expect(localParts(Date.parse("2026-10-03T16:30:00.000Z"), "Australia/Sydney")).toEqual({
      date: "2026-10-04",
      minutes: 3 * 60 + 30,
    });
    // Adelaide's gap is 02:00 to 03:00 local too.
    expect(at("2026-10-04", "02:30", "Australia/Adelaide")).toBe("2026-10-03T17:00:00.000Z");
    // Lord Howe's clocks go forward half an hour (02:00 to 02:30): 02:15 is 02:45.
    expect(at("2026-10-04", "02:15", "Australia/Lord_Howe")).toBe("2026-10-03T15:45:00.000Z");
  });

  it("takes the first of a time that happens twice", () => {
    // 02:30 on 5 April in Sydney happens at +11 and again at +10: the first is the earlier.
    expect(at("2026-04-05", "02:30", "Australia/Sydney")).toBe("2026-04-04T15:30:00.000Z");
    expect(at("2026-04-05", "02:30", "Australia/Adelaide")).toBe("2026-04-04T16:00:00.000Z");
    // Northern clocks too: 01:30 on 1 November 2026 in New York, first at -4.
    expect(at("2026-11-01", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("is exact in a zone with no clock changes", () => {
    expect(at("2026-06-01", "00:00", "UTC")).toBe("2026-06-01T00:00:00.000Z");
    expect(at("2026-06-01", "23:59", "Asia/Bangkok")).toBe("2026-06-01T16:59:00.000Z");
  });
});

describe("local days and the wall clock", () => {
  it("counts whole local days back at the same time of day across a change", () => {
    // 06:00 on Thursday 8 October (+11) less 7 days is 06:00 on 1 October (+10): 167 hours.
    const start = Date.parse("2026-10-07T19:00:00.000Z");
    const opens = localDaysBefore(start, 7, "Australia/Sydney");
    expect(new Date(opens).toISOString()).toBe("2026-09-30T20:00:00.000Z");
    expect((start - opens) / 3_600_000).toBe(167);
  });

  it("does calendar arithmetic and weekdays without a zone", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(isoWeekday("2026-11-23")).toBe(1);
    expect(isoWeekday("2026-11-22")).toBe(7);
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("6:00")).toBeNull();
    expect(parseLocalTime("06:00")).toBe(360);
  });

  it("keeps the helper moved from offers.ts as it was", () => {
    expect(zoneOffset(Date.parse("2026-01-15T00:00:00Z"), "Australia/Sydney")).toBe(11 * 3_600_000);
    expect(zoneOffset(Date.parse("2026-07-15T00:00:00Z"), "Australia/Adelaide")).toBe(
      9.5 * 3_600_000,
    );
    expect(realWallClock(2026, 2, 30)).toBe(false);
    expect(realWallClock(2026, 2, 28, 23, 59, 59)).toBe(true);
  });
});
