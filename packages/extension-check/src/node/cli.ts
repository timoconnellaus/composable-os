// The `cos ext` commands (ADR 0405). `runExt` is called by the cos command with what follows
// `ext` on the command line; it returns the exit code.
import { relative, resolve } from "node:path";
import { checkExtensionDir, ExtCheckError, type LocatedIssue } from "./check.ts";
import { runVitest, untested } from "./test.ts";

export interface ExtIo {
  out(line: string): void;
  err(line: string): void;
}

export const EXT_HELP = `cos ext: check and test an extension in a Composable OS checkout.

  cos ext check <dir> [--json]   The checks extension.check runs in a deployment: allowed imports,
                                 types against @composable-os/sdk, the contract, formulas,
                                 automations, and a dry-run reconcile against an empty local
                                 database. Exit code 0 only when there are no issues.
  cos ext test <dir>             The extension's Vitest tests. Fails first if a tool or an
                                 automation is named in no test file.
`;

/** One issue as text: where, what, and the fix when the check has one. */
export function formatIssue(dir: string, issue: LocatedIssue): string {
  const file = `${dir}/${issue.file}${issue.line ? `:${issue.line}` : ""}`;
  const at = issue.stage === "typecheck" ? "" : `  ${issue.path}`;
  const lines = [`${file}${at}`, `  ${issue.stage}/${issue.code}: ${issue.message}`];
  if (issue.suggestion) lines.push(`  fix: ${issue.suggestion}`);
  return lines.join("\n");
}

async function check(dir: string, json: boolean, io: ExtIo): Promise<number> {
  const result = await checkExtensionDir(dir);
  if (json) {
    io.out(JSON.stringify({ id: result.id, ok: result.ok, issues: result.issues }, null, 2));
    return result.ok ? 0 : 1;
  }
  const shown = relative(process.cwd(), resolve(dir)) || ".";
  for (const issue of result.issues) io.out(`${formatIssue(shown, issue)}\n`);
  if (!result.ok) {
    const n = result.issues.length;
    io.out(`${n} issue${n === 1 ? "" : "s"} in ${shown}. Fix them and run the check again.`);
    return 1;
  }
  const changes = result.plan?.changes.length ?? 0;
  io.out(
    `ok: ${result.id} ${result.manifest?.version ?? ""} passes the check ` +
      `(${changes} schema change${changes === 1 ? "" : "s"} on an empty database).`,
  );
  return 0;
}

async function test(dir: string, io: ExtIo): Promise<number> {
  const missing = await untested(dir);
  if (missing.length) {
    for (const name of missing) io.out(`No test names ${name}.`);
    io.out(
      "Every tool and automation needs at least one test (createTestHost in " +
        "@composable-os/sdk/testing: runTool, runAutomation).",
    );
    return 1;
  }
  return runVitest(dir);
}

export async function runExt(argv: string[], io: ExtIo): Promise<number> {
  const args = argv.filter((arg) => !arg.startsWith("--"));
  const [command, dir] = args;
  if (!command || argv.includes("--help") || (command !== "check" && command !== "test") || !dir) {
    io.out(EXT_HELP);
    return command && dir ? 2 : argv.includes("--help") ? 0 : 2;
  }
  try {
    return command === "check"
      ? await check(dir, argv.includes("--json"), io)
      : await test(dir, io);
  } catch (error) {
    if (error instanceof ExtCheckError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
