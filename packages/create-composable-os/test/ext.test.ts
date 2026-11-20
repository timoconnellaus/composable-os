// `cos ext` reaches the extension check through the cos command (ADR 0405). What the check
// reports is tested in packages/extension-check and, against the host, in apps/runner.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";

const root = join(import.meta.dirname, "..", "..", "..");

async function cos(argv: string[]) {
  const lines: string[] = [];
  const code = await runCli(argv, {
    io: {
      interactive: false,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      ask: async () => "",
    },
    redactor: new Redactor(),
    env: {},
  });
  return { code, text: lines.join("\n") };
}

describe("cos ext", () => {
  it("check passes a shipped extension and exits 0", async () => {
    const { code, text } = await cos(["ext", "check", join(root, "extensions", "lifecycle")]);
    expect(text).toContain("ok: lifecycle");
    expect(code).toBe(0);
  });

  it("check lists the issues of a broken extension and exits 1", async () => {
    const broken = join(root, "packages", "extension-check", "test", "fixtures", "missingrelation");
    const { code, text } = await cos(["ext", "check", broken]);
    expect(text).toContain('Unknown relation target "premises.site"');
    expect(code).toBe(1);
  });

  it("is in the help", async () => {
    expect((await cos(["--help"])).text).toContain("cos ext check <dir>");
  });
});
