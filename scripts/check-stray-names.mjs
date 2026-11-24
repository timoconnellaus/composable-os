#!/usr/bin/env node
// The lint for stray names (stage 20, ADR 0400).
//
// A name that depends on a product is written once, in that product's definition under
// products/. This check, run by `pnpm lint`, fails when a tracked file anywhere else contains a
// name from RULES: a retired brand, a retired prefix, or a part of the extension contract that was
// renamed. ALLOW lists the files that keep such names on purpose.
//
// A system a business uses (its booking system, course platform or CMS) is named only where a
// connector for it is defined, documented and listed, and no file says which business uses, used
// or is leaving it (ADR 0921): a file allowed a system's name may not name a client.
//
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT = "a product's name comes from its definition (products/<id>/product.ts)";

/** This check and its tests: the only files that may name what the rules forbid everywhere. */
const SELF = /^scripts\/check-stray-names(?:\.test)?\.mjs$/;

/** What a rule about a client's supplier says to write instead. */
const SUPPLIER =
  "the repository names a system only where its connector is defined, documented and listed " +
  "(the owner's decision of 2026-11-22, amended 2026-11-24, ADR 0921)";

/**
 * A rule with its own `allow` uses it in place of ALLOW: a client's suppliers are kept out of
 * every file, old ADRs and specs included. A rule marked `supplier` names a system a business
 * uses: the files it allows (other than this check) are also checked for a client's name.
 * @type {{ name: string, pattern: RegExp, instead: string, allow?: RegExp[], supplier?: boolean }[]}
 */
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
  {
    name: "a client's booking system",
    pattern: /mind\s?body/i,
    instead: `${SUPPLIER}: say "its current booking system"`,
    // The connector for it (stage 65, the owner's decision 4, 2026-11-24): its package, its ADR,
    // the stage's spec, the integrations guide, the catalogue and the site's list of connections.
    allow: [
      SELF,
      /^packages\/gatekeeper-booking-system-mindbody\//,
      /^docs\/adr\/0927-/,
      /^docs\/stages\/65-/,
      /^docs\/integrations\.md$/,
      /^packages\/core\/src\/integrations\/catalogue\.ts$/,
      /^apps\/marketing\//,
      /^apps\/marketing\/SITE\.md$/,
    ],
    supplier: true,
  },
  {
    name: "a client's course platform",
    pattern: /learn\s?worlds/i,
    instead: `${SUPPLIER}: say "the hosted course platform"`,
    allow: [SELF],
    supplier: true,
  },
  {
    name: "a client's website CMS",
    pattern: /\bEmDash\b/,
    instead: `${SUPPLIER}: say "its current CMS"`,
    allow: [SELF],
    supplier: true,
  },
];

/**
 * Clients with no product definition here, as patterns. Empty: a name added here is itself public,
 * so a client is listed only once it has agreed to be named.
 * @type {RegExp[]}
 */
export const CLIENTS = [];

/**
 * Products that are the platform's own, not a business's: their labels name no client. The CRM is
 * the first product on the platform (ADR 0400).
 */
const PLATFORM_PRODUCTS = new Set(["crm"]);

/** A phrase that points at one client without naming it. */
const ONE_CLIENT = /\b(?:first|our)\s+clients?\b/i;

/** The rule a file allowed a system's name breaks when it also names a client. */
export const BESIDE = {
  name: "a business named beside a system",
  instead:
    "a file that names a system a business uses never says which business uses, used or is " +
    'leaving it (ADR 0921): say "a business"',
};

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
  SELF,
];

/** Never read: a product's own definition and apps, and files that are not ours to rename. */
const SKIP = [/^products\//, /^pnpm-lock\.yaml$/, /(^|\/)worker-configuration\.d\.ts$/];

const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm|bin|mp3|mp4|wav|webm)$/i;

/** A pattern matching `label` as a whole word or phrase, any case. */
function labelPattern(label) {
  const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

/**
 * The labels of the client products under `root`/products (`label: "…"` in each product.ts),
 * leaving out the platform's own, as patterns.
 */
export function productClients(root) {
  let ids;
  try {
    ids = readdirSync(join(root, "products"), { withFileTypes: true });
  } catch {
    return [];
  }
  const clients = [];
  for (const entry of ids) {
    if (!entry.isDirectory() || PLATFORM_PRODUCTS.has(entry.name)) continue;
    let text;
    try {
      text = readFileSync(join(root, "products", entry.name, "product.ts"), "utf8");
    } catch {
      continue;
    }
    const label = /\blabel:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1];
    if (label?.trim()) clients.push(labelPattern(label));
  }
  return clients;
}

/**
 * Problems in `files` (path → text), as "path:line: message" strings. `rules` and `allow` default
 * to the repository's; `clients` are the patterns for clients' names (none by default: the
 * command line adds the products' labels to CLIENTS). A phrase pointing at one client ("our
 * client", "the first client") counts as a client's name.
 */
export function checkStrayNames(files, rules = RULES, allow = ALLOW, clients = CLIENTS) {
  const problems = [];
  const named = [...clients, ONE_CLIENT];
  for (const [path, text] of files) {
    if (SKIP.some((re) => re.test(path))) continue;
    const lines = text.split("\n");
    const beside = rules.some(
      (rule) => rule.supplier && !SELF.test(path) && (rule.allow ?? allow).some((re) => re.test(path)),
    );
    if (beside) {
      lines.forEach((line, index) => {
        for (const client of named) {
          const match = new RegExp(client.source, client.flags.replace("g", "")).exec(line);
          if (match) {
            problems.push(`${path}:${index + 1}: "${match[0]}" (${BESIDE.name}): ${BESIDE.instead}`);
            break;
          }
        }
      });
    }
    for (const rule of rules) {
      if ((rule.allow ?? allow).some((re) => re.test(path))) continue;
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
  const clients = [...CLIENTS, ...productClients(root)];
  const problems = RULES.length ? checkStrayNames(trackedFiles(root), RULES, ALLOW, clients) : [];
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
