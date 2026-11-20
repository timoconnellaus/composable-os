#!/usr/bin/env node
// The lint for stray names (stage 20, ADR 0400).
//
// A name that depends on a product is written once, in that product's definition under
// products/. This check, run by `pnpm lint`, fails when a tracked file anywhere else contains a
// name from RULES: a retired brand, a retired prefix, or a part of the extension contract that was
// renamed. ALLOW lists the files that keep such names on purpose.
//
// The rule list is empty until the renames have landed; each rule is turned on by the commit that
// removes the last use of its name.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {{ name: string, pattern: RegExp, instead: string }[]} */
export const RULES = [];

/** Files that keep the old names: patterns over repository-relative paths. */
export const ALLOW = [];

/** Never read: a product's own definition and apps, and files that are not ours to rename. */
const SKIP = [/^products\//, /^pnpm-lock\.yaml$/, /(^|\/)worker-configuration\.d\.ts$/];

const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm|bin|mp3|mp4|wav|webm)$/i;

/**
 * Problems in `files` (path → text), as "path:line: message" strings. `rules` and `allow` default
 * to the repository's.
 */
export function checkStrayNames(files, rules = RULES, allow = ALLOW) {
  const problems = [];
  for (const [path, text] of files) {
    if (SKIP.some((re) => re.test(path)) || allow.some((re) => re.test(path))) continue;
    const lines = text.split("\n");
    for (const rule of rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
      lines.forEach((line, index) => {
        const match = pattern.exec(line);
        if (match) {
          problems.push(`${path}:${index + 1}: "${match[0]}" (${rule.name}): ${rule.instead}`);
        }
      });
    }
  }
  return problems;
}

/** Every tracked text file under `root`, as [path, text] pairs. */
export function* trackedFiles(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  for (const path of listed.split("\0")) {
    if (!path || BINARY.test(path)) continue;
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (text.includes("\0")) continue;
    yield [path, text];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = RULES.length ? checkStrayNames(trackedFiles(root)) : [];
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(
      `\n${problems.length} stray name(s). Product names come from products/<id>/product.ts; ` +
        "see scripts/check-stray-names.mjs for the rules and the files allowed to keep old names.",
    );
    process.exit(1);
  }
  console.log(`stray names: ok (${RULES.length} rule${RULES.length === 1 ? "" : "s"})`);
}
