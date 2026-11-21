// `cos ext check` and `cos ext test` (ADR 0405, stage 21). The broken fixtures in ./fixtures and
// the issues in fixtures/expected.json are shared with apps/runner/test/same-issues.test.ts, which
// puts the same source through the host's `extension.check`: both must report exactly those
// issues. The shipped extensions must pass unchanged.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkExtensionDir, locate } from "../src/node/check.ts";
import { type ExtIo, outsideSummary, runExt } from "../src/node/cli.ts";
import { untested } from "../src/node/test.ts";
import expected from "./fixtures/expected.json" with { type: "json" };

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
const shipped = (name: string) => join(import.meta.dirname, "..", "..", "..", "extensions", name);

function io(): ExtIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

describe("cos ext check on the broken fixtures", () => {
  for (const [name, issues] of Object.entries(expected)) {
    it(`${name}: reports the issues the host reports`, async () => {
      const result = await checkExtensionDir(fixture(name));
      expect(result.ok).toBe(false);
      expect(result.issues.map(({ file: _file, line: _line, ...issue }) => issue)).toEqual(issues);
      for (const issue of result.issues) expect(issue.file).toBe("index.ts");
    });
  }

  it("prints a file, the manifest path and the message, and exits 1", async () => {
    const out = io();
    expect(await runExt(["check", fixture("badformula")], out)).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toMatch(
      /badformula\/index\.ts:\d+ {2}objects\.invoice\.fields\.withTax\.expression/,
    );
    expect(text).toContain('Unknown field "amout"');
    expect(text).toContain("1 issue in");
  });

  it("prints the issues as JSON with --json", async () => {
    const out = io();
    expect(await runExt(["check", fixture("stagerule"), "--json"], out)).toBe(1);
    const parsed = JSON.parse(out.lines.join("\n")) as { ok: boolean; issues: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toHaveLength(expected.stagerule.length);
  });
});

describe("cos ext check on the shipped extensions", () => {
  for (const name of ["deals", "leads", "lifecycle"]) {
    it(`${name} passes unchanged`, async () => {
      const out = io();
      expect(await runExt(["check", shipped(name)], out)).toBe(0);
      expect(out.lines.join("\n")).toMatch(new RegExp(`^ok: ${name} `));
    });

    it(`${name}: every tool and automation is named in a test`, async () => {
      expect(await untested(shipped(name))).toEqual([]);
    });
  }

  it("reconciles the extension another one builds on first (Leads relates to deals.deal)", async () => {
    const result = await checkExtensionDir(shipped("leads"));
    expect(result.issues).toEqual([]);
    expect(JSON.stringify(result.manifest)).toContain('"deals.deal"');
  });
});

describe("cos ext", () => {
  it("says what is wrong when the directory is not an extension in a checkout", async () => {
    const out = io();
    expect(await runExt(["check", "/nonexistent-extension"], out)).toBe(2);
    expect(out.errors.join("\n")).toContain("No such directory");
  });

  it("prints its help for an unknown command", async () => {
    const out = io();
    expect(await runExt(["frobnicate", "x"], out)).toBe(2);
    expect(out.lines.join("\n")).toContain("cos ext check <dir>");
  });

  it("refuses to run tests when a tool has none", async () => {
    // The fixture declares an automation (followUp) and has no test files.
    const out = io();
    expect(await runExt(["test", fixture("missingtest")], out)).toBe(1);
    expect(out.lines.join("\n")).toContain("No test names automation followUp.");
  });
});

describe("locate", () => {
  const files = {
    "index.ts":
      "export default defineExtension({ objects: { deal: { fields: {} } }, automations: { wonDeal } });",
    "automations.ts": "export const wonDeal = defineAutomation({\n  steps: [],\n});",
  };

  it("finds the file that declares the named part of a path", () => {
    expect(locate(files, "objects.deal.titleField")).toEqual({ file: "index.ts", line: 1 });
    expect(
      locate({ "automations.ts": files["automations.ts"] }, "automations.wonDeal.steps.0.name"),
    ).toEqual({
      file: "automations.ts",
      line: 1,
    });
  });

  it("falls back to index.ts", () => {
    expect(locate(files, "nothing.here")).toEqual({ file: "index.ts" });
  });
});

describe("what an extension opens to people outside the org (stage 22, ADR 0414)", () => {
  it("is nothing for an extension that is for staff only", () => {
    expect(
      outsideSummary({ id: "plain", objects: { a: {} }, tools: { t: { risk: "write" } } }),
    ).toEqual([]);
    expect(outsideSummary(null)).toEqual([]);
  });

  it("is one line per object a customer sees and per tool they can call", () => {
    const lines = outsideSummary({
      id: "shop",
      objects: {
        order: { customer: { field: "buyer", read: ["status", "total"], write: [] } },
        supplier: {},
      },
      tools: {
        cancel: {
          risk: "write",
          audiences: ["customer"],
          customerFields: { "shop.order": ["status"] },
        },
        report: { risk: "read", audiences: ["staff"] },
      },
    });
    expect(lines).toEqual([
      "This extension opens the host to people outside the org. Review these lines:",
      "  customers see shop.order where buyer is them: read status, total; write nothing",
      "  tool cancel (write) is open to customer, and may also set shop.order: status",
    ]);
  });
});
