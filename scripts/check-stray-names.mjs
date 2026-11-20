#!/usr/bin/env node
// The lint for stray names (stage 20, ADR 0400).
//
// A name that depends on a product is written once, in that product's definition under
// products/. This check, run by `pnpm lint`, fails when a tracked file anywhere else contains a
// name from RULES: a retired brand, a retired prefix, or a part of the extension contract that was
// renamed. ALLOW lists the files that keep such names on purpose.
//
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT = "a product's name comes from its definition (products/<id>/product.ts)";

/** @type {{ name: string, pattern: RegExp, instead: string }[]} */
export const RULES = [
  {
    name: "the retired brand",
    pattern: /Relationship OS/i,
    instead: `say "Composable OS" for the platform; ${PRODUCT}`,
  },
  {
    name: "the retired package scope and repository name",
    pattern: /relationship[-_]?os(?!crm)/i,
    instead: "the scope is @composable-os/*, the repository composable-os",
  },
  {
    name: "the retired domain",
    pattern: /relationshiposcrm/i,
    instead: `the platform's site is composableos.dev; ${PRODUCT}`,
  },
  {
    name: "the retired Worker and resource prefix",
    pattern: /(?<![A-Za-z0-9])ros-(?=[a-z0-9<$*])/,
    instead: "packages name Workers cos-*; a deployment's names come from the product definition",
  },
  {
    name: "the retired variable prefix",
    pattern: /(?<![A-Za-z0-9_])ROS_(?=[A-Z])/,
    instead: "variables are COS_*",
  },
  {
    name: "the old host module",
    pattern: /codemode:crm\b/,
    instead: "the module is codemode:ops",
  },
  {
    name: "the old context module",
    pattern: /\bctx\.crm\b/,
    instead: "it is ctx.ops",
  },
  {
    name: "an old view name",
    pattern:
      /\bcrm_(?:people|organisations|affiliations|activities|activity_links|tasks|task_links|record_tags|users|stage_history|x_[a-z]|\*)/,
    instead: "the views are rec_<object> (packages/sdk/src/renamed.ts has the mapping)",
  },
];

/**
 * Files that keep the old names: patterns over repository-relative paths. These are records of
 * what was decided or run at the time, and are left as written (docs/adr/README.md).
 */
export const ALLOW = [
  // ADRs 0001 to 0352 and stage specs 00 to 17: before the move to Composable OS.
  /^docs\/adr\/0[0-3]\d\d-/,
  /^docs\/stages\/(?:0\d|1[0-7])[a-z]?-/,
  /^docs\/stages\/assets\//,
  // The decision and the spec that retire the names have to say what they were.
  /^docs\/adr\/0400-/,
  /^docs\/adr\/README\.md$/,
  /^docs\/stages\/20-/,
  // Applied migrations are immutable: the views had their old names until migration 0380.
  /^packages\/db\/migrations\/0[0-3][0-7]\d_/,
  /^packages\/db\/migrations\/0380_/,
  // Output of eval runs made before the rename.
  /^evals\/[a-z-]+\/reports\//,
  // This check and its tests.
  /^scripts\/check-stray-names(?:\.test)?\.mjs$/,
];

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
    process.exitCode = 1;
  } else {
    console.log(`stray names: ok (${RULES.length} rule${RULES.length === 1 ? "" : "s"})`);
  }
}
