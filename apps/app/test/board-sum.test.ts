// A board column's sum (src/components/views/board-view.tsx `formatSum`).
import type { FieldInfo } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import { formatSum } from "../src/components/views/board-view.tsx";

// Only the fields formatSum reads.
const amount = { name: "amount", fieldType: "currency", options: {} } as unknown as FieldInfo;

describe("formatSum", () => {
  it("shows a currency field without its own currency in the base currency, as its cards do", () => {
    expect(formatSum(amount, 1200, "EUR")).toBe("€1,200");
  });

  it("keeps a field's own currency", () => {
    const own = { ...amount, options: { currency: "GBP" } } as FieldInfo;
    expect(formatSum(own, 1200, "EUR")).toBe("£1,200");
  });
});
