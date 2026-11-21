#!/usr/bin/env node
// The block lint (stage 24, ADR 0424): a block holds no rules. Prices, places and what a customer
// may see are the host's (ADRs 0401, 0404); a block that calculates a price, checks a capacity or
// checks a permission instead of calling an operation is refused. Run by `pnpm lint` over every
// block (blocks/*, packs/*/blocks/*), and by its tests over fixtures.
//
// It reads the code with comments and string contents removed, so words in copy ("Total") are
// not code. It is a lint, not a proof: what it cannot see, review does.
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
    for (const name of readdirSync(dir)) {
      if (!/\.(tsx?|jsx?)$/.test(name)) continue;
      const file = join(dir, name);
      for (const p of lintSource(readFileSync(file, "utf8"))) {
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
