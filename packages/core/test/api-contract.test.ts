// Stage 23, acceptance criterion 9 (ADR 0417): the contract guard. The HTTP surface's manifest
// for each audience is committed as a golden file, packages/core/api/v1/<audience>.json, and this
// test fails while the registry and the files differ, saying what in the change would break a
// client compiled against the committed files. So a change to the API is always a diff, and a
// breaking one says so.
//
// To update the files after changing the API on purpose:
//   pnpm --filter @composable-os/core api-contract
import { env } from "cloudflare:workers";
import deals from "@composable-os/extension-deals";
import leads from "@composable-os/extension-leads";
import lifecycle from "@composable-os/extension-lifecycle";
import { toManifest } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import customer from "../api/v1/customer.json";
import publicContract from "../api/v1/public.json";
import staff from "../api/v1/staff.json";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  API_VERSION,
  type ApiContract,
  breakingChanges,
  buildContract,
  contractFor,
  coreRegistry,
  defineOperation,
} from "../src/index.ts";

const shippedTools = [deals, leads, lifecycle].flatMap((extension) => {
  const manifest = toManifest(extension);
  return Object.entries(manifest.tools).map(([name, tool]) =>
    toolOperation(manifest, name, tool, "shipped"),
  );
});
const contract = buildContract([...coreRegistry.list(), ...shippedTools]);
const computed = {
  staff: contractFor(contract, "staff"),
  customer: contractFor(contract, "customer"),
  public: contractFor(contract, "public"),
};
// scripts/write-api-contract.mjs reads these lines (only it asks for them: they are large).
if ((env as { PRINT_API_CONTRACT?: string }).PRINT_API_CONTRACT === "1")
  for (const [audience, value] of Object.entries(computed)) {
    console.log(`API_CONTRACT ${audience} ${JSON.stringify(value)}`);
  }

const committed = {
  staff: staff as ApiContract,
  customer: customer as ApiContract,
  public: publicContract as ApiContract,
};

describe("the committed API contract", () => {
  for (const audience of ["staff", "customer", "public"] as const) {
    it(`for ${audience} is the registry's`, () => {
      const breaking = breakingChanges(committed[audience], computed[audience]);
      expect(
        computed[audience],
        `The ${audience} API differs from api/${API_VERSION}/${audience}.json` +
          (breaking.length
            ? `, and the change would break a client compiled against it (${breaking.join("; ")}): ` +
              "that is a new API version (ADR 0417)."
            : ". If you meant to change the API, run `pnpm --filter @composable-os/core api-contract`."),
      ).toEqual(committed[audience]);
    });
  }

  it("names no staff operation to customers or the public", () => {
    const staffOnly = new Set(
      contract.operations.filter((op) => op.audiences.join() === "staff").map((op) => op.name),
    );
    const outside = JSON.stringify([committed.customer, committed.public]);
    expect([...staffOnly].filter((name) => outside.includes(`"${name}"`))).toEqual([]);
  });

  it("each mutation lists the queries it makes stale", () => {
    const update = computed.customer.operations.find((op) => op.name === "me.update");
    expect(update?.kind).toBe("mutation");
    expect(update?.invalidates).toEqual(expect.arrayContaining(["me.get", "my.get", "my.list"]));
    const personUpdate = computed.staff.operations.find((op) => op.name === "person.update");
    expect(personUpdate?.invalidates).toEqual(
      expect.arrayContaining(["person.get", "person.list"]),
    );
  });
});

describe("breaking changes", () => {
  const op = (input: z.ZodObject, name = "fixture.op") =>
    defineOperation({
      name,
      description: "A fixture operation for the contract guard's own test of breaking changes.",
      input,
      output: z.object({ id: z.string() }),
      permission: "records:read",
      risk: "read",
      audiences: ["customer"],
      handler: async () => ({ id: "x" }),
    });
  const before = buildContract([op(z.object({ a: z.string().optional() }))]);

  it("an added optional input is not one", () => {
    const after = buildContract([
      op(z.object({ a: z.string().optional(), b: z.number().optional() })),
    ]);
    expect(breakingChanges(before, after)).toEqual([]);
  });

  it("a newly required input, a removed input and a removed operation are", () => {
    expect(breakingChanges(before, buildContract([op(z.object({ a: z.string() }))]))).toEqual([
      "fixture.op now requires input a",
    ]);
    expect(breakingChanges(before, buildContract([op(z.object({}))]))).toEqual([
      "fixture.op no longer takes input a",
    ]);
    expect(breakingChanges(before, buildContract([]))).toEqual(["fixture.op was removed"]);
  });
});
