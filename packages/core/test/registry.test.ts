// Acceptance criterion 2: every operation has a description, zod schemas, a permission and a risk
// class. This test covers every registered operation, so new ones are checked automatically.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTORS,
  coreOperations,
  coreRegistry,
  createRegistry,
  defineOperation,
  OPERATION_NAME_RE,
  operationProblems,
  PERMISSIONS,
  RISK_CLASSES,
} from "../src/index.ts";

describe("core registry", () => {
  it("registers every operation once", () => {
    const names = coreOperations.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
    expect(coreRegistry.names().sort()).toEqual([...names].sort());
  });

  for (const op of coreOperations) {
    describe(op.name, () => {
      it("is complete", () => {
        expect(operationProblems(op)).toEqual([]);
        expect(op.name).toMatch(OPERATION_NAME_RE);
        expect(op.description.trim().length).toBeGreaterThanOrEqual(20);
        expect(op.input).toBeInstanceOf(z.ZodType);
        expect(op.output).toBeInstanceOf(z.ZodType);
        expect(PERMISSIONS).toContain(op.permission);
        expect(RISK_CLASSES).toContain(op.risk);
        for (const actor of op.actors ?? []) expect(ACTORS).toContain(actor);
      });

      it("has JSON-Schema-convertible input and output (for MCP tools)", () => {
        expect(() => z.toJSONSchema(op.input, { unrepresentable: "any" })).not.toThrow();
        expect(() => z.toJSONSchema(op.output, { unrepresentable: "any" })).not.toThrow();
      });

      it("read operations use a read permission", () => {
        // extension.check runs extension source in the sandbox, so it stays admin-only; the
        // update.* reads (Settings → Updates) and Settings → AI (ai.settings, ai.testRole,
        // ai.usage) are admin-only too, as are the policy adjudicator's settings and agreement
        // rate (adjudicator.get, adjudicator.agreement: policy:manage). A health form's answers
        // are read only with agreements:health (stage 44, ADR 0643), and the address a paper
        // form's copy would go to only by whoever may send it, agreements:paper (ADR 0645). An
        // acceptance kept after its person was erased is found only with agreements:manage
        // (agreement.kept.find, ADR 0646). A person's check-in cards are listed only with
        // people:cards (personCode.list, ADR 0783). Journeys are read with journeys:read (stage
        // 53, ADR 0800): members hold it, viewers do not; their settings (staff addresses) with
        // journeys:manage. Who may be signed at the desk, and on which tablet, is read by whoever
        // may start a desk session, agreements:desk (ADR 0649).
        if (op.risk === "read") {
          expect([
            "journeys:read",
            "journeys:manage",
            "agreements:desk",
            "agreements:health",
            "people:cards",
            "agreements:manage",
            "agreements:paper",
            "records:read",
            "audit:read",
            "users:manage",
            "policy:manage",
            "extensions:manage",
            "settings:manage",
          ]).toContain(op.permission);
        }
      });

      it("is not both curated for MCP and hidden from it", () => {
        if (op.mcp?.curated) expect(op.mcp.expose).not.toBe(false);
      });
    });
  }

  it("curates about 20 MCP tools, each with a model-facing description", () => {
    const curated = coreOperations.filter((op) => op.mcp?.curated);
    expect(curated.length).toBeGreaterThanOrEqual(12);
    // Stage 2's ~15, the extension authoring tools and Code Mode (stage 3b), and connections,
    // integration.call and suggested contacts (stage 6a), and the assistant's cards (stage 17;
    // show_card is the assistant's only, so external clients gain one), the assistant's two offers
    // (stage 17 W4), and agents and approvals (stage 17 W5: five tools). None of the last seven is
    // listed to external clients: createCrmMcpServer leaves out what their actor cannot call.
    expect(curated.length).toBeLessThanOrEqual(39);
    for (const op of curated) expect(op.description.trim().length).toBeGreaterThanOrEqual(60);
  });

  it("hides erase, role changes, purge, policy changes and approvals from MCP", () => {
    for (const name of [
      "person.erase",
      "organisation.erase",
      "user.updateRole",
      "trash.purge",
      "policy.update",
      "approval.approve",
      "approval.reject",
      "connectedApp.revoke",
      "connectedApp.register",
    ]) {
      expect(coreRegistry.get(name)?.mcp?.expose, name).toBe(false);
    }
  });

  it("can look operations up by name", () => {
    expect(coreRegistry.get("person.create")?.name).toBe("person.create");
    expect(coreRegistry.require("person.list").risk).toBe("read");
    expect(coreRegistry.get("nope.nothing")).toBeUndefined();
  });
});

describe("defineOperation", () => {
  const valid = {
    name: "thing.do",
    description: "Does the thing, for tests. Has no side effects at all.",
    input: z.object({}),
    output: z.object({}),
    permission: "records:read",
    risk: "read",
    handler: async () => ({}),
  } as const;

  it("accepts a complete definition", () => {
    expect(defineOperation(valid).name).toBe("thing.do");
  });

  it.each([
    ["name", { name: "Thing" }],
    ["description", { description: "short" }],
    ["input", { input: undefined }],
    ["output", { output: undefined }],
    ["permission", { permission: undefined }],
    ["risk", { risk: "spicy" }],
    ["handler", { handler: undefined }],
  ])("rejects a definition with a bad %s", (_what, patch) => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed definitions.
    expect(() => defineOperation({ ...valid, ...patch } as any)).toThrow();
  });

  it("rejects duplicate names in a registry", () => {
    const op = defineOperation(valid);
    expect(() => createRegistry([op, op])).toThrow(/Duplicate/);
  });
});
