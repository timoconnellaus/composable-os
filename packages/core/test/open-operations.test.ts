// Stage 22 (ADR 0411): open-operations.json lists every operation customers or the public may
// call, with its risk class, and this test keeps it equal to the registry. So opening an
// operation is always a line in a diff, and CI fails on one that is open but not listed.
//
// To update the file after opening an operation on purpose:
//   pnpm --filter @composable-os/core open-operations
import deals from "@composable-os/extension-deals";
import leads from "@composable-os/extension-leads";
import lifecycle from "@composable-os/extension-lifecycle";
import { toManifest } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import committed from "../open-operations.json";
import { toolOperation } from "../src/extensions/tools.ts";
import { coreRegistry, createRegistry, defineOperation, openOperations } from "../src/index.ts";

// Tools of the shipped extensions are operations too (`x.<extension>.<tool>`): one that a
// shipped extension opens to customers or the public is listed with the core operations.
const shippedTools = [deals, leads, lifecycle].flatMap((extension) => {
  const manifest = toManifest(extension);
  return Object.entries(manifest.tools).map(([name, tool]) =>
    toolOperation(manifest, name, tool, "shipped"),
  );
});
const fromRegistry = openOperations([...coreRegistry.list(), ...shippedTools]);
// scripts/write-open-operations.mjs reads this line.
console.log(`OPEN_OPERATIONS ${JSON.stringify(fromRegistry)}`);

const fixture = (name: string, audiences: ("staff" | "customer" | "public")[]) =>
  defineOperation({
    name,
    description: "A fixture operation for the generated list's own test.",
    input: z.object({}),
    output: z.object({}),
    permission: "records:read",
    risk: "read",
    audiences,
    handler: async () => ({}),
  });

describe("open-operations.json", () => {
  it("is the registry's list of operations open to customers or the public", () => {
    expect(
      committed,
      "The registry and open-operations.json differ. If you meant to open or close an " +
        "operation, run `pnpm --filter @composable-os/core open-operations` and commit the file.",
    ).toEqual(fromRegistry);
  });

  it("covers the shipped extensions' tools", () => {
    expect(shippedTools.length).toBeGreaterThan(0);
    expect(shippedTools.every((op) => op.name.startsWith("x."))).toBe(true);
  });

  it("lists an operation as soon as it is open to anyone but staff, and no other", () => {
    const registry = createRegistry([
      fixture("fixture.staffOnly", ["staff"]),
      fixture("fixture.mine", ["customer"]),
      fixture("fixture.shared", ["customer", "staff"]),
      fixture("fixture.anyone", ["public"]),
    ]);
    expect(openOperations(registry.list()).operations).toEqual([
      { name: "fixture.anyone", audiences: ["public"], risk: "read" },
      { name: "fixture.mine", audiences: ["customer"], risk: "read" },
      { name: "fixture.shared", audiences: ["staff", "customer"], risk: "read" },
    ]);
  });

  it("differs from the committed file when the registry opens one, which is what fails CI", () => {
    const opened = createRegistry([...coreRegistry.list(), fixture("fixture.mine", ["customer"])]);
    expect(openOperations(opened.list())).not.toEqual(committed);
  });
});
