#!/usr/bin/env node
// The block lint (stage 24, ADR 0424): a block holds no rules. Prices, places and what a customer
// may see are the host's (ADRs 0401, 0404); a block that calculates a price, checks a capacity or
// checks a permission instead of calling an operation is refused. Run by `pnpm lint` over every
// block (blocks/*, packs/*/blocks/*), and by its tests over fixtures.
//
// It reads the code with comments and string contents removed, so words in copy ("Total") are
// not code. It is a lint, not a proof: what it cannot see, review does.
//
// A block marked `"noPurchase": true` in its block.json (stage 42: the app's course screens, as
// the owner decided buying is on the web only) may also not buy: no order or checkout operation
// in its `operations`, and no price, buy hook or checkout in its code. Stage 32a adds the
// subscription's billing operations (start, cancel, resume, the portal) and their hooks, and holds
// every native block to them whether marked or not: in the app a subscription is read only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Comments and the contents of strings replaced by spaces, keeping line numbers. */
export function codeOnly(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") (out += " "), i++;
    } else if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") (out += " "), i++;
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const MONEY = "\\w*(?:price|amount|total|subtotal|tax|vat|discount|fee|cost|charge)\\w*";
const PLACES = "\\w*(?:capacity|available|remaining|places|seats|spots|stock|soldout|left)\\w*";

/** What a block may not do, each with the pattern that finds it and what to do instead. */
export const RULES = [
  {
    id: "price-calculation",
    pattern: new RegExp(
      `\\b${MONEY}\\b\\s*[-+*/%]=?\\s*[\\w(.]|[\\w).]\\s*[-+*/%]=?\\s*\\b${MONEY}\\b|\\b${MONEY}\\b[^;\\n]*\\.reduce\\(|Math\\.(?:round|floor|ceil)\\([^)]*\\b${MONEY}\\b`,
      "i",
    ),
    message:
      "calculates a price: prices are the host's (the sellable behaviour); show what an operation returns",
  },
  {
    id: "capacity-check",
    pattern: new RegExp(
      `\\b${PLACES}\\b\\s*(?:<=?|>=?|===?|!==?)\\s*[\\w(.]|[\\w).]\\s*(?:<=?|>=?)\\s*\\b${PLACES}\\b`,
      "i",
    ),
    message:
      "checks a capacity: places are the host's (the capacity behaviour); call the operation and show its answer",
  },
  {
    id: "permission-check",
    pattern:
      /\b(?:roles?|permissions?)\b\s*(?:===?|!==?|\.includes\()|\b(?:isAdmin|isStaff|hasPermission|hasRole|canAccess)\b|\.role\s*(?:===?|!==?)/,
    message:
      "checks a permission: what a caller may see or do is the host's (audiences and the visibility seam); call an operation open to them",
  },
];

/** What a `noPurchase` block may not name, in its operations or its code. */
const PURCHASE_OPERATION =
  /^(?:order\.(?:start|checkout|cancel)|subscription\.(?:start|cancel|resume|portal|change|pause)|x\.[a-z0-9]+\.(?:buy|orderStart|checkout|subscribe))$/;
const PURCHASE_CODE =
  /\b(?:price|prices|useBuy|checkout|orderStart|formatPrice|formatMinor|useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal)\b/;
/** A subscription's billing operations: never in a native block (stage 32a, ADR 0490). */
const BILLING_OPERATION = /^subscription\.(?:start|cancel|resume|portal|change|pause)$/;
const NATIVE_BILLING =
  "is a native block that changes a subscription: in the app a subscription is read only; billing is on the web";
const NO_PURCHASE =
  "buys or shows a price in a block marked noPurchase: buying is on the web only; show no price and no buy button";

/** The problems of a `noPurchase` block's code: `{ line, rule, message }`. */
export function lintNoPurchase(source) {
  const problems = [];
  codeOnly(source)
    .split("\n")
    .forEach((line, index) => {
      if (PURCHASE_CODE.test(line))
        problems.push({ line: index + 1, rule: "no-purchase", message: NO_PURCHASE });
    });
  return problems;
}

const BILLING_CODE =
  /\b(?:useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal)\b/;

/** The problems of a native block's code that changes a subscription: `{ line, rule, message }`. */
export function lintNativeBilling(source) {
  const problems = [];
  codeOnly(source)
    .split("\n")
    .forEach((line, index) => {
      if (BILLING_CODE.test(line))
        problems.push({ line: index + 1, rule: "native-billing", message: NATIVE_BILLING });
    });
  return problems;
}

/** The problems in one file's text: `{ line, rule, message }`. */
export function lintSource(source) {
  const problems = [];
  codeOnly(source)
    .split("\n")
    .forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line))
          problems.push({ line: index + 1, rule: rule.id, message: rule.message });
      }
    });
  return problems;
}

/** Every block folder (one with a block.json) under the given roots. */
export function blockFolders(root) {
  const found = [];
  const scan = (parent) => {
    if (!existsSync(parent)) return;
    for (const name of readdirSync(parent)) {
      const dir = join(parent, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, "block.json"))) found.push(dir);
    }
  };
  scan(join(root, "blocks"));
  if (existsSync(join(root, "packs"))) {
    for (const pack of readdirSync(join(root, "packs"))) scan(join(root, "packs", pack, "blocks"));
  }
  return found;
}

/** Lints the blocks in `folders`; returns lines to print, empty when every block is clean. */
export function lintBlocks(folders, root) {
  const out = [];
  for (const dir of folders) {
    const spec = JSON.parse(readFileSync(join(dir, "block.json"), "utf8"));
    const noPurchase = spec.noPurchase === true;
    if (spec.skin === "native" && !noPurchase) {
      for (const op of spec.operations ?? []) {
        if (BILLING_OPERATION.test(op)) {
          out.push(
            `${relative(root, join(dir, "block.json"))}: native-billing: the block lists ${op}: it ${NATIVE_BILLING}`,
          );
        }
      }
    }
    if (noPurchase) {
      for (const op of spec.operations ?? []) {
        if (PURCHASE_OPERATION.test(op)) {
          out.push(
            `${relative(root, join(dir, "block.json"))}: no-purchase: the block lists ${op}: ${NO_PURCHASE}`,
          );
        }
      }
    }
    for (const name of readdirSync(dir)) {
      if (!/\.(tsx?|jsx?)$/.test(name)) continue;
      const file = join(dir, name);
      const text = readFileSync(file, "utf8");
      const native = spec.skin === "native" && !noPurchase ? lintNativeBilling(text) : [];
      for (const p of [
        ...lintSource(text),
        ...(noPurchase ? lintNoPurchase(text) : []),
        ...native,
      ]) {
        out.push(`${relative(root, file)}:${p.line}: ${p.rule}: the block ${p.message}`);
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const folders = process.argv.slice(2).length
    ? process.argv.slice(2).map((d) => join(process.cwd(), d))
    : blockFolders(root);
  const problems = lintBlocks(folders, root);
  for (const line of problems) console.error(line);
  if (problems.length) process.exitCode = 1;
  else console.log(`blocks: ok (${folders.length} blocks hold no rules)`);
}
