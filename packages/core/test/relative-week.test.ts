// Weeks for relative filter values (stage 27: Ticketing's "This week's events"). A week starts on
// Monday, in UTC, as the other tokens are.
import { describe, expect, it } from "vitest";
import { relativeValue } from "../src/relative.ts";

describe("startOfWeek and startOfNextWeek", () => {
  it("are the Monday of this week and of the next, whatever the day", () => {
    // 2026-11-21 is a Saturday; 2026-11-16 a Monday; 2026-11-22 a Sunday.
    for (const now of [
      "2026-11-16T00:00:00.000Z",
      "2026-11-21T15:00:00.000Z",
      "2026-11-22T23:59:59.000Z",
    ]) {
      expect(relativeValue("startOfWeek", "usr", now)).toBe("2026-11-16");
      expect(relativeValue("startOfNextWeek", "usr", now)).toBe("2026-11-23");
    }
    // Across a month and a year.
    expect(relativeValue("startOfWeek", "usr", "2027-01-01T12:00:00.000Z")).toBe("2026-12-28");
    expect(relativeValue("startOfNextWeek", "usr", "2027-01-01T12:00:00.000Z")).toBe("2027-01-04");
  });
});
