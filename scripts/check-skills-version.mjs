#!/usr/bin/env node
// The version guard for skills (stage 21, ADR 0405).
//
// The skills in skills/ describe one version of the extension contract. skills/CONTRACT_VERSION
// holds that number and every SKILL.md says it ("contract version N"). This check, run by
// `pnpm lint`, fails when the SDK's CONTRACT_VERSION (packages/sdk/src/contract.ts) is a different
// number: whoever changes the contract version reads the skills, updates what changed, and only
// then moves the number in skills/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOW =
  "read each skill in skills/ against the new contract, update what changed, then write the " +
  "new number in skills/CONTRACT_VERSION and in each SKILL.md";

/**
 * @param {{ contractSource: string, versionFile: string | null, skills: [path: string, text: string][] }} input
 * @returns {string[]} problems; empty when the skills describe the SDK's contract version
 */
export function checkSkillsVersion({ contractSource, versionFile, skills }) {
  const sdk = /export const CONTRACT_VERSION = (\d+);/.exec(contractSource)?.[1];
  if (!sdk) return ["packages/sdk/src/contract.ts: no `export const CONTRACT_VERSION = <n>;`"];
  if (versionFile === null) return ["skills/CONTRACT_VERSION is missing"];
  const described = versionFile.trim();
  const problems = [];
  if (described !== sdk) {
    problems.push(
      `skills/CONTRACT_VERSION says ${described || "nothing"} and the SDK's CONTRACT_VERSION is ${sdk}: ${HOW}`,
    );
  }
  if (!skills.length) problems.push("skills/ has no SKILL.md");
  for (const [path, text] of skills) {
    const said = /contract version (\d+)/i.exec(text)?.[1];
    if (said !== sdk) {
      problems.push(
        `${path} ${said ? `describes contract version ${said}` : 'does not say "contract version <n>"'} and the SDK's CONTRACT_VERSION is ${sdk}: ${HOW}`,
      );
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "skills");
  const versionPath = join(dir, "CONTRACT_VERSION");
  const skills = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
        .map((entry) => [
          `skills/${entry.name}/SKILL.md`,
          readFileSync(join(dir, entry.name, "SKILL.md"), "utf8"),
        ])
    : [];
  const problems = checkSkillsVersion({
    contractSource: readFileSync(join(root, "packages", "sdk", "src", "contract.ts"), "utf8"),
    versionFile: existsSync(versionPath) ? readFileSync(versionPath, "utf8") : null,
    skills,
  });
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`skills contract version: ok (${skills.length} skills)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
