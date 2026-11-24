// formatDate shows a date-only value (YYYY-MM-DD) as that calendar day in every time zone: as an
// instant it is midnight UTC, which west of UTC is the day before. In Node, not workerd, because
// workerd's clock is always UTC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const original = process.env.TZ;
let formatDate: (value: string | null | undefined) => string;

beforeAll(async () => {
  process.env.TZ = "America/New_York";
  ({ formatDate } = await import("../src/lib/format.ts"));
});

afterAll(() => {
  process.env.TZ = original;
});

describe("formatDate west of UTC", () => {
  it("keeps a date-only value's day", () => {
    expect(formatDate("2024-03-01")).toBe("Mar 1, 2024");
  });

  it("shows an instant in local time", () => {
    expect(formatDate("2024-03-01T02:00:00.000Z")).toBe("Feb 29, 2024");
  });
});
