// localDay is the person's own calendar day, not UTC's: a paper agreement signed at 9am in
// Sydney is dated that day. In Node, not workerd, because workerd's clock is always UTC.
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

describe("localDay east of UTC", () => {
  it("is the local day where UTC's is still the day before", () => {
    const morning = new Date("2024-03-01T22:00:00.000Z"); // 9am on 2 March in Sydney
    expect(morning.toISOString().slice(0, 10)).toBe("2024-03-01");
    expect(format.localDay(morning)).toBe("2024-03-02");
  });

  it("writes a datetime-local value in local time", () => {
    expect(format.localDateTimeInput(new Date("2024-03-01T22:05:00.000Z"))).toBe(
      "2024-03-02T09:05",
    );
  });
});
