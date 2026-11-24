// What a settings form shows for a field (src/lib/draft.ts `drafted`).
import { describe, expect, it } from "vitest";
import { drafted } from "../src/lib/draft.ts";

type Settings = { email: string | null; digestHour: number };
const saved: Settings = { email: "con_1", digestHour: 8 };

describe("drafted", () => {
  it("shows a field turned off, not the saved value it replaces", () => {
    expect(drafted<Settings, "email">({ email: null }, saved, "email")).toBeNull();
  });

  it("shows the saved value for a field not changed, and nothing before it loads", () => {
    expect(drafted<Settings, "digestHour">({ email: null }, saved, "digestHour")).toBe(8);
    expect(drafted<Settings, "email">({}, undefined, "email")).toBeUndefined();
  });
});
