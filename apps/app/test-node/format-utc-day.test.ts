// formatUtcDay shows the UTC day of a day stored as its end in UTC (an order's balance due): in
// local time, east of UTC, that instant is already the next day. In Node, not workerd, because
// workerd's clock is always UTC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const original = process.env.TZ;
let format: typeof import("../src/lib/format.ts");

beforeAll(async () => {
  process.env.TZ = "Australia/Sydney";
  format = await import("../src/lib/format.ts");
});

afterAll(() => {
  process.env.TZ = original;
});

describe("formatUtcDay east of UTC", () => {
  it("keeps the day a balance is due", () => {
    expect(format.formatDate("2024-03-01T23:59:59.999Z")).toBe("Mar 2, 2024");
    expect(format.formatUtcDay("2024-03-01T23:59:59.999Z")).toBe("Mar 1, 2024");
  });

  it("passes an empty or unreadable value through", () => {
    expect(format.formatUtcDay(null)).toBe("");
    expect(format.formatUtcDay("soon")).toBe("soon");
  });
});
