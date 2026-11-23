// A tool's `redactResult` (ADR 0628): keys of its answer the host never keeps (a calendar feed's
// address, shown once). Each must be a key of the tool's answer, and the manifest carries it.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.ts";

function withTool(redactResult: string[]) {
  return {
    id: "feeds",
    version: "1.0.0",
    contractVersion: 1,
    permissions: {},
    objects: {},
    tools: {
      rotate: {
        description: "A new private address, shown once and never kept.",
        risk: "write",
        humanOnly: true,
        redactResult,
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { path: { type: "string" }, createdAt: { type: "string" } },
        },
      },
    },
  };
}

describe("a tool's redactResult", () => {
  it("names keys of the tool's answer", () => {
    const ok = validateManifest(withTool(["path"]));
    expect(ok.issues).toEqual([]);
    expect(ok.manifest?.tools.rotate?.redactResult).toEqual(["path"]);
    const bad = validateManifest(withTool(["token"]));
    expect(bad.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      `tools.rotate.redactResult: "token" is not a key of the tool's answer`,
    ]);
  });
});
