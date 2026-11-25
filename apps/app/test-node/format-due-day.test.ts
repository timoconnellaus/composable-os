// formatDueDay: the day a deadline (an order's balance due) falls on. A whole-day deadline is
// stored as the day's last millisecond in UTC and shows as that UTC day; any other moment (a
// datetime deposit field, order.extend from the API, MCP or the assistant) shows as its local day.
// In Node, not workerd, because workerd's clock is always UTC.
import { afterEach, describe, expect, it, vi } from "vitest";

const original = process.env.TZ;

async function formatIn(zone: string) {
  process.env.TZ = zone;
  vi.resetModules();
  return import("../src/lib/format.ts");
}

afterEach(() => {
  process.env.TZ = original;
});

describe("formatDueDay", () => {
  it("keeps a whole-day deadline's day east of UTC", async () => {
    const format = await formatIn("Australia/Sydney");
    expect(format.formatDate("2024-03-01T23:59:59.999Z")).toBe("Mar 2, 2024");
    expect(format.formatDueDay("2024-03-01T23:59:59.999Z")).toBe("Mar 1, 2024");
  });

  it("shows a moment set by the hour as its local day", async () => {
    // order.extend { balanceDueAt: "2026-12-01T09:00:00+10:00" } is stored as this.
    const sydney = await formatIn("Australia/Sydney");
    expect(sydney.formatDueDay("2026-11-30T23:00:00.000Z")).toBe("Dec 1, 2026");
    // A datetime deposit field of 1 December, 20:00 in New York.
    const newYork = await formatIn("America/New_York");
    expect(newYork.formatDueDay("2026-12-02T01:00:00.000Z")).toBe("Dec 1, 2026");
  });

  it("passes an empty or unreadable value through", async () => {
    const format = await formatIn("Australia/Sydney");
    expect(format.formatDueDay(null)).toBe("");
    expect(format.formatDueDay("soon")).toBe("soon");
  });
});
