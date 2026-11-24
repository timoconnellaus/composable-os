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
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  /^(?:order\.(?:start|checkout|cancel)|subscription\.(?:start|cancel|resume|portal|change|pause|coolOff)|x\.[a-z0-9]+\.(?:buy|orderStart|checkout|subscribe))$/;
const PURCHASE_CODE =
  /\b(?:price|prices|useBuy\w*|checkout|orderStart|formatPrice|formatMinor|useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal|useCoolOff)\b/;
/** A subscription's billing operations: never in a native block (stage 32a, ADR 0490). */
const BILLING_OPERATION = /^subscription\.(?:start|cancel|resume|portal|change|pause|coolOff)$/;
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
  /\b(?:useSubscribe|useCancelSubscription|useResumeSubscription|useBillingPortal|useCoolOff)\b/;

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

/** A billing operation named in a string, read in the raw source (strings are not blanked). */
const BILLING_NAME = /["'`]subscription\.(?:start|cancel|resume|portal|change|pause|coolOff)["'`]/;

/** A native block that names a subscription's billing operation as a string: `{ line, … }`. */
export function lintBillingNames(source) {
  const problems = [];
  source.split("\n").forEach((line, index) => {
    if (BILLING_NAME.test(line))
      problems.push({ line: index + 1, rule: "native-billing", message: NATIVE_BILLING });
  });
  return problems;
}

/** An operation's name as a string: a core one with a verb, or an extension tool's. */
const OPERATION_NAME =
  /["'`]((?:subscription|order|media|access|public|my|record)\.[a-z][a-zA-Z]*|x\.[a-z0-9]+\.[a-z][a-zA-Z0-9]*)["'`]/g;

/**
 * Operations a block's code names that its block.json does not list (what `cos add` tells a
 * client app to allow): the list must say everything the block calls.
 */
export function lintUnlisted(source, listed) {
  const problems = [];
  const known = new Set(listed);
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(OPERATION_NAME)) {
      if (!known.has(match[1])) {
        problems.push({
          line: index + 1,
          rule: "unlisted-operation",
          message: `names ${match[1]}, which its block.json does not list in operations`,
        });
      }
    }
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

// A native block's text and icons take their colour from the block theme (`native-base/theme.ts`):
// React Native draws a <Text> with no colour black, invisible on a dark theme. Every <Text> not
// inside another (which inherits) has a style with a colour, a <TextInput> a colour and a
// placeholder colour, an <ActivityIndicator> a colour, and every colour a native block names is
// the theme's: no colour literal outside theme.ts.
const THEMED =
  "takes no colour from the theme: React Native draws it black, unreadable on a dark theme; give it a style with color: theme.color.*";
const LITERAL_COLOUR =
  "names a colour of its own: take it from native-base/theme.ts (theme.color.*), so the company's theme reaches it";
const COLOUR_LITERAL = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(.*\)|white|black)$/i;

/** True when `node` is, or reads from, the theme (`theme.color.text`, `cond ? theme.a : theme.b`). */
function fromTheme(node) {
  if (ts.isParenthesizedExpression(node)) return fromTheme(node.expression);
  if (ts.isConditionalExpression(node))
    return fromTheme(node.whenTrue) && fromTheme(node.whenFalse);
  let root = node;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
    root = root.expression;
  return root !== node && ts.isIdentifier(root) && root.text === "theme";
}

/** The `StyleSheet.create({...})` objects of a file, by the name they are bound to. */
function styleSheets(file) {
  const sheets = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "StyleSheet.create" &&
      node.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      const styles = new Map();
      for (const prop of node.initializer.arguments[0].properties) {
        if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer))
          styles.set(prop.name.getText(file), prop.initializer);
      }
      sheets.set(node.name.text, styles);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sheets;
}

function hasColour(object, file) {
  return object.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name.getText(file) === "color",
  );
}

/** True when the style expression surely gives a colour (every branch does). */
function styleHasColour(node, file, sheets) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node)) return styleHasColour(node.expression, file, sheets);
  if (ts.isObjectLiteralExpression(node)) return hasColour(node, file);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.some((e) => styleHasColour(e, file, sheets));
  if (ts.isConditionalExpression(node))
    return (
      styleHasColour(node.whenTrue, file, sheets) && styleHasColour(node.whenFalse, file, sheets)
    );
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const style = sheets.get(node.expression.text)?.get(node.name.text);
    return style ? hasColour(style, file) : false;
  }
  return false;
}

function attribute(element, name) {
  const attr = element.attributes.properties.find(
    (a) => ts.isJsxAttribute(a) && a.name.getText() === name,
  );
  if (!attr) return undefined;
  const init = attr.initializer;
  if (init && ts.isJsxExpression(init)) return init.expression ?? null;
  return init ?? null;
}

/** The problems of a native block's file: text and icons with no themed colour. */
export function lintNativeColour(source, fileName = "block.tsx") {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sheets = styleSheets(file);
  // React Native's own components, by the names this file gives them; native-base's themed Text
  // (`native-base/text.tsx`) takes its colour from the theme already.
  const native = new Map();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react-native" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const el of statement.importClause.namedBindings.elements)
        native.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  const problems = [];
  const at = (node, rule, message) =>
    problems.push({
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      rule,
      message,
    });
  const opening = (node) =>
    ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  const insideText = (node) => {
    for (let up = node.parent; up; up = up.parent) {
      const o = opening(up);
      if (
        o &&
        (native.get(o.tagName.getText(file)) === "Text" || o.tagName.getText(file) === "Text")
      )
        return true;
    }
    return false;
  };
  const visit = (node) => {
    const element = opening(node);
    if (element) {
      const tag = native.get(element.tagName.getText(file));
      const style = attribute(element, "style");
      if ((tag === "Text" && !insideText(node)) || tag === "TextInput") {
        if (!styleHasColour(style, file, sheets))
          at(element, "native-text-colour", `has a <${tag}> that ${THEMED}`);
      }
      if (tag === "TextInput" && !attribute(element, "placeholderTextColor"))
        at(
          element,
          "native-text-colour",
          `has a <TextInput> with no placeholderTextColor: give it theme.color.muted`,
        );
      if (tag === "ActivityIndicator" && !attribute(element, "color"))
        at(
          element,
          "native-text-colour",
          `has an <ActivityIndicator> that ${THEMED.replace("a style with color", "color")}`,
        );
    }
    if (
      ts.isJsxAttribute(node) &&
      /^(?:color|placeholderTextColor|tintColor)$/.test(node.name.getText(file))
    ) {
      const value =
        node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
      if (value && !fromTheme(value))
        at(
          node,
          "native-text-colour",
          `has a ${node.name.getText(file)} that ${THEMED.replace("; give it a style with color: theme.color.*", "")}: use theme.color.*`,
        );
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      COLOUR_LITERAL.test(node.text)
    )
      at(node, "native-literal-colour", LITERAL_COLOUR);
    ts.forEachChild(node, visit);
  };
  visit(file);
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
    for (const file of codeFiles(dir)) {
      const text = readFileSync(file, "utf8");
      const native = spec.skin === "native";
      for (const p of [
        ...lintSource(text),
        ...(noPurchase ? lintNoPurchase(text) : []),
        ...(native && !noPurchase ? lintNativeBilling(text) : []),
        ...(native ? lintBillingNames(text) : []),
        ...(native && /\.[jt]sx$/.test(file) ? lintNativeColour(text, file) : []),
        ...(native && /\.[jt]s$/.test(file) && !file.endsWith(`native-base${sep}theme.ts`)
          ? lintNativeColour(text, file).filter((p) => p.rule === "native-literal-colour")
          : []),
        ...lintUnlisted(text, spec.operations ?? []),
      ]) {
        out.push(`${relative(root, file)}:${p.line}: ${p.rule}: the block ${p.message}`);
      }
    }
  }
  return out;
}

/** Every code file of a block, its subfolders' too. */
export function codeFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...codeFiles(path));
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) found.push(path);
  }
  return found;
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
