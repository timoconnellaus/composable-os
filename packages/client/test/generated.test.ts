// Stage 23, acceptance criterion 5 (ADR 0418): a generated client runs in workerd, the Workers
// target. test/generated/ holds a client generated for two fixture operations and the scenario
// the React Native target also runs (packages/client-gen/test/targets.test.ts keeps both the
// generator's current output).
import { describe, expect, it } from "vitest";
import { createCustomerClient, operations } from "./generated/customer.ts";
import { scenario } from "./generated/scenario.ts";

describe("a generated client in workerd", () => {
  it("runs the scenario: a read, a write retried with its key, and an old app's error", async () => {
    const result = (await scenario()) as {
      greeting: unknown;
      key: unknown;
      saved: unknown;
      sent: { url: string; key: string | null }[];
      upgrade: boolean;
    };
    expect(result.greeting).toEqual({ greeting: "Hello, Ada" });
    expect(result.key).toEqual(["fixture.greet", { name: "Ada" }]);
    expect(result.saved).toEqual({ id: "rec_1" });
    expect(result.sent.map((s) => s.key)).toEqual([
      null,
      "key-1-0123456789abcdef",
      "key-1-0123456789abcdef",
    ]);
  });

  it("is typed: its table and factory are the generator's", () => {
    expect(Object.keys(operations).sort()).toEqual(["fixture.greet", "fixture.save"]);
    const api = createCustomerClient({
      baseUrl: "https://h",
      fetch: async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => '{"data":{"greeting":"x"}}',
      }),
    });
    expect(api.query("fixture.greet", { name: "Ada" }).queryKey).toEqual([
      "fixture.greet",
      { name: "Ada" },
    ]);
  });
});
