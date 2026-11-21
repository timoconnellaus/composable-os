// The structured document field (stage 41, ADR 0445): a field whose value is one JSON document,
// checked against a schema the object declares. A program's layout is one; stage 28's `richText`
// is one fixed schema of this kind.
//
//   layout: {
//     type: "document",
//     label: "Layout",
//     schema: { root: { type: "object", fields: { weeks: { type: "array", max: 52, of: ... } } } },
//     maxBytes: 262_144,
//     paths: { weekCount: { label: "Weeks", path: "weeks", count: true } },
//   }
//
// The schema language is plain data, so a manifest carries it and the host, the check and the
// test host read the same declaration. It is small on purpose: objects with named fields (every
// key known, nothing else accepted), lists with a maximum, text with a maximum, numbers with
// bounds, true or false, one of a fixed set of words, the id of a record of a named object, a
// tagged union of objects, and named definitions a schema may use again (for nesting, as rich
// text's lists do). There is no free pattern: a text node may name the characters it allows.
//
// Validation never repairs a value. It returns every fault (up to a limit) with the path of the
// fault, as a list of keys and indexes from the document's root.
//
// An object node may be `private`: removed from what a customer or the public reads
// (`redactDocument`), unless its `unless` key is true (a coach's note marked as shown to
// members). The host does that at the visibility seam; staff read the whole document.

/** The most a document may be, in bytes of its JSON, whatever a field declares. */
export const DOCUMENT_MAX_BYTES = 524_288;
/** A field that declares no `maxBytes`. */
export const DOCUMENT_DEFAULT_BYTES = 65_536;
/** The deepest a value may nest (objects and lists), and a schema. */
export const DOCUMENT_MAX_DEPTH = 24;
/** The most entries any one list may declare. */
export const DOCUMENT_MAX_LIST = 1000;
/** The longest a text node may declare, and the default when it declares none. */
export const DOCUMENT_MAX_TEXT = 20_000;
export const DOCUMENT_DEFAULT_TEXT = 1000;
/** Faults reported for one value, at most. */
export const DOCUMENT_MAX_ISSUES = 20;
/** Declared paths (view columns) per field, at most. */
export const DOCUMENT_MAX_PATHS = 12;

const ID_RE = /^[a-z][a-z0-9]{0,9}_[A-Za-z0-9]{1,60}$/;
const KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const OBJECT_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/;
// Control characters other than tab and newline (and a lone carriage return) are refused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// Markup a text node with `noMarkup` refuses (ADR 0440): the start of a tag, closing tag, comment
// or processing instruction, and any character reference, named or numeric.
const MARKUP_RE = /<[A-Za-z!/?]|&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/;
// What a link may be. No quote, angle bracket, backslash, backtick or space anywhere.
const URL_TAIL = "[^\\s<>\"'`\\\\]*";
const WEB_RE = new RegExp(
  `^https?://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#]${URL_TAIL})?$`,
  "i",
);
const MAILTO_RE = /^mailto:[^\s<>"'`\\:/][^\s<>"'`\\]*$/i;
const TEL_RE = /^tel:[+0-9 ().-]{3,40}$/i;
const PATH_RE = new RegExp(`^/(?![/\\\\])${URL_TAIL}$`);
const ANCHOR_RE = /^#[A-Za-z0-9_-]{1,100}$/;

/** Whether `value` is a link of the given kind (a text node's `href`). */
export function isDocumentHref(value: string, kind: "web" | "link"): boolean {
  if (WEB_RE.test(value)) return true;
  if (kind === "web") return false;
  return (
    MAILTO_RE.test(value) || TEL_RE.test(value) || PATH_RE.test(value) || ANCHOR_RE.test(value)
  );
}

/** Whether `value` holds markup a `noMarkup` text node refuses. */
export function hasMarkup(value: string): boolean {
  return MARKUP_RE.test(value);
}

interface NodeBase {
  /** For people and models: what the node holds. */
  description?: string;
  /** In an object's `fields`: the key may be left out. */
  optional?: boolean;
}

export interface DocumentObjectNode extends NodeBase {
  type: "object";
  fields: Record<string, DocumentNode>;
  /**
   * Removed when a customer or the public reads the document. `{ unless: "<key>" }` keeps it when
   * that boolean key of the object is true (a note marked as shown to members).
   */
  private?: true | { unless: string };
}
export interface DocumentArrayNode extends NodeBase {
  type: "array";
  of: DocumentNode;
  max: number;
  min?: number;
  /** A key of the listed objects whose values must differ (labels, level numbers). */
  unique?: string;
}
export interface DocumentTextNode extends NodeBase {
  type: "text";
  /** Characters at most. Default 1000. */
  max?: number;
  min?: number;
  /** Newlines allowed. */
  multiline?: boolean;
  /** The only characters allowed, e.g. "0123456789X" for a tempo. */
  chars?: string;
  /**
   * Refuses markup (stage 28, ADR 0440): an HTML tag, closing tag, comment or processing
   * instruction (`<b`, `</`, `<!`, `<?`) and a character reference (`&amp;`, `&#60;`). A lone
   * `<` before a space or a digit is text. Rich text's text is always this.
   */
  noMarkup?: boolean;
  /**
   * The text is a link (stage 28, ADR 0440). `web`: an absolute `http:` or `https:` URL.
   * `link`: that, or `mailto:`, `tel:`, a path on the site (`/about`, never `//host`) or an
   * anchor (`#top`). Any other scheme (`javascript:`, `data:`, `vbscript:`) is refused.
   */
  href?: "web" | "link";
}
export interface DocumentNumberNode extends NodeBase {
  type: "number";
  min?: number;
  max?: number;
  integer?: boolean;
  /** Multiples of this from `min` (or 0): 0.5 for an RPE. */
  step?: number;
}
export interface DocumentBooleanNode extends NodeBase {
  type: "boolean";
}
export interface DocumentChoiceNode extends NodeBase {
  type: "choice";
  options: readonly string[];
}
/** The id of a live record of `to`, checked by the host when the document is written. */
export interface DocumentRefNode extends NodeBase {
  type: "ref";
  to: string;
}
/** One of several object shapes, told apart by the value of `tag`. */
export interface DocumentUnionNode extends NodeBase {
  type: "union";
  tag: string;
  variants: Record<string, DocumentObjectNode>;
}
/** A named definition of the schema's `defs`. */
export interface DocumentUseNode extends NodeBase {
  type: "use";
  def: string;
}

export type DocumentNode =
  | DocumentObjectNode
  | DocumentArrayNode
  | DocumentTextNode
  | DocumentNumberNode
  | DocumentBooleanNode
  | DocumentChoiceNode
  | DocumentRefNode
  | DocumentUnionNode
  | DocumentUseNode;

export interface DocumentSchema {
  root: DocumentObjectNode;
  defs?: Record<string, DocumentNode>;
}

/**
 * A value inside the document that the object's rec_* view shows as a column of its own, which
 * lists, filters, sorts and dashboards read like any field: `path` is keys from the root through
 * objects only (`title`, `meta.level`). With `count`, the path names a list and the column is its
 * length.
 */
export interface DocumentPathSpec {
  label: string;
  path: string;
  count?: boolean;
  description?: string;
}

/** What a declared path reads as: the type of its column. */
export type DocumentPathType = "text" | "number" | "boolean" | "id";

/** A fault in a value: where, and what is wrong. */
export interface DocumentIssue {
  path: (string | number)[];
  message: string;
}

export type DocumentResult =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; issues: DocumentIssue[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Bytes of a value's JSON, as stored. */
export function documentBytes(value: unknown): number {
  // UTF-8 length by hand: the SDK is type-checked with no DOM or runtime library.
  const text = JSON.stringify(value) ?? "";
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// --- Checking a schema ---------------------------------------------------------------------------

/**
 * What is wrong with a declared schema, as `[path, message]` pairs (the path from the schema's
 * own root: `root.fields.weeks.of`). Empty when nothing is. `knownObjects`, when given, holds the
 * objects a `ref` may name.
 */
export function checkDocumentSchema(
  schema: unknown,
  knownObjects?: ReadonlySet<string>,
): [string, string][] {
  const problems: [string, string][] = [];
  const add = (path: string, message: string) => {
    if (problems.length < 50) problems.push([path, message]);
  };
  if (!isObject(schema)) {
    add("", "A document schema is an object with a `root` object node");
    return problems;
  }
  for (const key of Object.keys(schema)) {
    if (key !== "root" && key !== "defs") add(key, `Unknown key "${key}" (root, defs)`);
  }
  const defs = isObject(schema.defs) ? schema.defs : {};
  if (schema.defs !== undefined && !isObject(schema.defs)) add("defs", "defs is an object");
  for (const name of Object.keys(defs)) {
    if (!KEY_RE.test(name)) add(`defs.${name}`, "A definition's name is camelCase");
  }

  const node = (path: string, value: unknown, depth: number, inFields: boolean): void => {
    if (depth > DOCUMENT_MAX_DEPTH) {
      add(path, `The schema nests deeper than ${DOCUMENT_MAX_DEPTH}`);
      return;
    }
    if (!isObject(value)) {
      add(path, "A node is an object with a `type`");
      return;
    }
    const allowed = new Set(["type", "description", "optional"]);
    const expect = (...keys: string[]) => {
      for (const key of keys) allowed.add(key);
    };
    if (value.optional !== undefined && (typeof value.optional !== "boolean" || !inFields)) {
      add(`${path}.optional`, "optional is true or false, on a field of an object");
    }
    if (value.description !== undefined && typeof value.description !== "string") {
      add(`${path}.description`, "description is text");
    }
    const num = (key: string, opts: { int?: boolean; min?: number; max?: number } = {}) => {
      const v = value[key];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || (opts.int && !Number.isInteger(v))) {
        add(`${path}.${key}`, `${key} is ${opts.int ? "a whole number" : "a number"}`);
        return undefined;
      }
      if (opts.min !== undefined && v < opts.min)
        add(`${path}.${key}`, `${key} is at least ${opts.min}`);
      if (opts.max !== undefined && v > opts.max)
        add(`${path}.${key}`, `${key} is at most ${opts.max}`);
      return v;
    };
    switch (value.type) {
      case "object": {
        expect("fields", "private");
        object(path, value, depth);
        break;
      }
      case "array": {
        expect("of", "max", "min", "unique");
        const max = num("max", { int: true, min: 1, max: DOCUMENT_MAX_LIST });
        if (value.max === undefined) add(`${path}.max`, "A list declares its most entries (max)");
        const min = num("min", { int: true, min: 0 });
        if (min !== undefined && max !== undefined && min > max)
          add(`${path}.min`, "min is above max");
        node(`${path}.of`, value.of, depth + 1, false);
        if (value.unique !== undefined) {
          const of = resolve(value.of);
          // The key of an object, or of every variant of a union.
          const shapes =
            of?.type === "object"
              ? [of]
              : of?.type === "union"
                ? Object.values(of.variants ?? {})
                : [];
          const keyNodes = shapes.map((shape) => resolve(shape.fields?.[String(value.unique)]));
          if (
            typeof value.unique !== "string" ||
            !keyNodes.length ||
            keyNodes.some((n) => !n || !["text", "number", "choice", "ref"].includes(n.type))
          ) {
            add(
              `${path}.unique`,
              "unique names a text, number, choice or ref key of the listed objects",
            );
          }
        }
        break;
      }
      case "text": {
        expect("max", "min", "multiline", "chars", "noMarkup", "href");
        if (value.noMarkup !== undefined && typeof value.noMarkup !== "boolean") {
          add(`${path}.noMarkup`, "noMarkup is true or false");
        }
        if (value.href !== undefined && value.href !== "web" && value.href !== "link") {
          add(`${path}.href`, "href is web or link");
        }
        const max = num("max", { int: true, min: 1, max: DOCUMENT_MAX_TEXT });
        const min = num("min", { int: true, min: 0 });
        if (min !== undefined && (max ?? DOCUMENT_DEFAULT_TEXT) < min)
          add(`${path}.min`, "min is above max");
        if (value.multiline !== undefined && typeof value.multiline !== "boolean") {
          add(`${path}.multiline`, "multiline is true or false");
        }
        if (
          value.chars !== undefined &&
          (typeof value.chars !== "string" || !value.chars.length || value.chars.length > 200)
        ) {
          add(`${path}.chars`, "chars is the allowed characters, 1 to 200 of them");
        }
        break;
      }
      case "number": {
        expect("min", "max", "integer", "step");
        const min = num("min");
        const max = num("max");
        if (min !== undefined && max !== undefined && min > max)
          add(`${path}.min`, "min is above max");
        if (value.integer !== undefined && typeof value.integer !== "boolean") {
          add(`${path}.integer`, "integer is true or false");
        }
        const step = num("step");
        if (step !== undefined && step <= 0) add(`${path}.step`, "step is above 0");
        break;
      }
      case "boolean":
        break;
      case "choice": {
        expect("options");
        const options = value.options;
        if (
          !Array.isArray(options) ||
          !options.length ||
          options.length > 100 ||
          options.some((o) => typeof o !== "string" || !o.length || o.length > 100)
        ) {
          add(`${path}.options`, "A choice lists 1 to 100 words");
        } else if (new Set(options).size !== options.length) {
          add(`${path}.options`, "A choice lists each word once");
        }
        break;
      }
      case "ref": {
        expect("to");
        if (typeof value.to !== "string" || !OBJECT_RE.test(value.to)) {
          add(`${path}.to`, "A ref names an object: `<extension>.<object>` or a core object");
        } else if (knownObjects && !knownObjects.has(value.to)) {
          add(`${path}.to`, `Unknown object "${value.to}"`);
        }
        break;
      }
      case "union": {
        expect("tag", "variants");
        if (typeof value.tag !== "string" || !KEY_RE.test(value.tag)) {
          add(`${path}.tag`, "A union's tag is a camelCase key");
        }
        if (!isObject(value.variants) || !Object.keys(value.variants).length) {
          add(`${path}.variants`, "A union has at least one variant");
          break;
        }
        for (const [name, variant] of Object.entries(value.variants)) {
          const vp = `${path}.variants.${name}`;
          if (!name.length || name.length > 100) add(vp, "A variant's name is 1 to 100 characters");
          if (!isObject(variant) || variant.type !== "object") {
            add(vp, "A variant is an object node");
            continue;
          }
          if (
            isObject(variant.fields) &&
            typeof value.tag === "string" &&
            value.tag in variant.fields
          ) {
            add(
              `${vp}.fields.${value.tag}`,
              "A variant does not declare its union's tag: the host does",
            );
          }
          node(vp, variant, depth + 1, false);
        }
        break;
      }
      case "use": {
        expect("def");
        if (typeof value.def !== "string" || !Object.hasOwn(defs, value.def)) {
          add(`${path}.def`, `"${String(value.def)}" is not one of the schema's defs`);
        }
        break;
      }
      default:
        add(
          `${path}.type`,
          "type is one of object, array, text, number, boolean, choice, ref, union, use",
        );
        return;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key))
        add(`${path}.${key}`, `Unknown key "${key}" on a ${String(value.type)} node`);
    }
  };

  const object = (path: string, value: Record<string, unknown>, depth: number) => {
    if (!isObject(value.fields)) {
      add(`${path}.fields`, "An object node lists its fields");
      return;
    }
    const keys = Object.keys(value.fields);
    if (keys.length > 100) add(`${path}.fields`, "An object has at most 100 fields");
    for (const key of keys) {
      if (!KEY_RE.test(key)) add(`${path}.fields.${key}`, "A field's key is camelCase");
      node(`${path}.fields.${key}`, value.fields[key], depth + 1, true);
    }
    const priv = value.private;
    if (priv !== undefined && priv !== true) {
      const unless = isObject(priv) ? priv.unless : undefined;
      const flag =
        typeof unless === "string" ? (value.fields as Record<string, unknown>)[unless] : undefined;
      if (!isObject(flag) || flag.type !== "boolean") {
        add(`${path}.private`, "private is true, or { unless: <a boolean key of this object> }");
      }
    }
  };

  const resolve = (value: unknown, seen = new Set<string>()): DocumentNode | undefined => {
    if (!isObject(value)) return undefined;
    if (value.type !== "use") return value as unknown as DocumentNode;
    const name = String(value.def);
    if (seen.has(name) || !Object.hasOwn(defs, name)) return undefined;
    seen.add(name);
    return resolve(defs[name], seen);
  };

  if (!isObject(schema.root) || schema.root.type !== "object") {
    add("root", "root is an object node");
  } else {
    node("root", schema.root, 0, false);
  }
  for (const [name, def] of Object.entries(defs)) node(`defs.${name}`, def, 0, false);
  // A definition that only names itself (a: use a) would never reach a value.
  for (const name of Object.keys(defs)) {
    if (!resolve({ type: "use", def: name }))
      add(`defs.${name}`, "A definition must reach a node that is not `use`");
  }
  return problems;
}

/** The node a declared path reaches, or why it reaches none. */
export function documentPathNode(
  schema: DocumentSchema,
  spec: Pick<DocumentPathSpec, "path" | "count">,
): { type: DocumentPathType } | string {
  const keys = spec.path.split(".");
  if (!keys.length || keys.some((key) => !KEY_RE.test(key))) {
    return "A path is camelCase keys joined by dots, from the document's root";
  }
  let current: DocumentNode | undefined = schema.root;
  for (const key of keys) {
    const at = useOf(schema, current);
    if (at?.type !== "object")
      return `"${spec.path}" passes through something that is not an object`;
    current = at.fields[key];
    if (!current) return `"${spec.path}" is not in the schema (no "${key}")`;
  }
  const end = useOf(schema, current);
  if (spec.count) {
    return end?.type === "array"
      ? { type: "number" }
      : `"${spec.path}" is not a list, so it has no count`;
  }
  switch (end?.type) {
    case "text":
    case "choice":
      return { type: "text" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "ref":
      return { type: "id" };
    default:
      return `"${spec.path}" is not a text, number, boolean, choice or ref (use count for a list)`;
  }
}

/** The JSON path SQLite reads a declared path with: `$.meta.level`. */
export function documentJsonPath(path: string): string {
  if (!path.split(".").every((key) => KEY_RE.test(key)))
    throw new Error(`Bad document path ${path}`);
  return `$.${path}`;
}

function useOf(schema: DocumentSchema, node: DocumentNode | undefined): DocumentNode | undefined {
  let current = node;
  for (let hops = 0; current?.type === "use" && hops < 20; hops += 1) {
    current = schema.defs?.[current.def];
  }
  return current?.type === "use" ? undefined : current;
}

// --- Validating a value ----------------------------------------------------------------------------

/**
 * Checks `value` against `schema`: every fault, with its path, or the value and its size. A value
 * over `maxBytes` (capped at DOCUMENT_MAX_BYTES) is refused before it is walked.
 */
export function validateDocument(
  schema: DocumentSchema,
  value: unknown,
  options: { maxBytes?: number } = {},
): DocumentResult {
  const limit = Math.min(options.maxBytes ?? DOCUMENT_DEFAULT_BYTES, DOCUMENT_MAX_BYTES);
  let bytes: number;
  try {
    bytes = documentBytes(value);
  } catch {
    return { ok: false, issues: [{ path: [], message: "The document is not JSON" }] };
  }
  if (bytes > limit) {
    return {
      ok: false,
      issues: [{ path: [], message: `The document is ${bytes} bytes; at most ${limit}` }],
    };
  }
  const issues: DocumentIssue[] = [];
  const fault = (path: (string | number)[], message: string) => {
    if (issues.length < DOCUMENT_MAX_ISSUES) issues.push({ path: [...path], message });
  };
  const walk = (node: DocumentNode, v: unknown, path: (string | number)[], depth: number) => {
    if (issues.length >= DOCUMENT_MAX_ISSUES) return;
    if (depth > DOCUMENT_MAX_DEPTH) {
      fault(path, `Nested deeper than ${DOCUMENT_MAX_DEPTH}`);
      return;
    }
    switch (node.type) {
      case "use": {
        const target = useOf(schema, node);
        if (!target) fault(path, `The schema's definition "${node.def}" is missing`);
        else walk(target, v, path, depth);
        return;
      }
      case "object":
        objectValue(node, v, path, depth, null);
        return;
      case "union": {
        if (!isObject(v)) {
          fault(path, `Expected an object with "${node.tag}"`);
          return;
        }
        const tag = v[node.tag];
        const variant =
          typeof tag === "string" && Object.hasOwn(node.variants, tag)
            ? node.variants[tag]
            : undefined;
        if (!variant) {
          fault([...path, node.tag], `Expected one of ${Object.keys(node.variants).join(", ")}`);
          return;
        }
        objectValue(variant, v, path, depth, node.tag);
        return;
      }
      case "array": {
        if (!Array.isArray(v)) {
          fault(path, "Expected a list");
          return;
        }
        if (v.length > node.max) fault(path, `At most ${node.max} entries (this has ${v.length})`);
        if (node.min !== undefined && v.length < node.min) {
          fault(path, `At least ${node.min} ${node.min === 1 ? "entry" : "entries"}`);
        }
        const seen = new Map<string, number>();
        v.slice(0, node.max).forEach((item, i) => {
          walk(node.of, item, [...path, i], depth + 1);
          if (node.unique && isObject(item) && item[node.unique] !== undefined) {
            const key = JSON.stringify(item[node.unique]);
            const first = seen.get(key);
            if (first !== undefined) {
              fault(
                [...path, i, node.unique],
                `${JSON.stringify(item[node.unique])} is there twice (also entry ${first})`,
              );
            } else seen.set(key, i);
          }
        });
        return;
      }
      case "text": {
        if (typeof v !== "string") {
          fault(path, "Expected text");
          return;
        }
        const max = node.max ?? DOCUMENT_DEFAULT_TEXT;
        if (v.length > max) fault(path, `At most ${max} characters (this has ${v.length})`);
        if (node.min !== undefined && v.length < node.min)
          fault(path, `At least ${node.min} characters`);
        if (CONTROL_RE.test(v)) fault(path, "Control characters are not allowed");
        else if (!node.multiline && /[\r\n]/.test(v)) fault(path, "One line only");
        if (node.chars) {
          const allowed = new Set(node.chars);
          const bad = [...v].find((c) => !allowed.has(c));
          if (bad !== undefined) fault(path, `"${bad}" is not allowed here (only ${node.chars})`);
        }
        if (node.noMarkup && MARKUP_RE.test(v)) {
          fault(path, "Markup is not allowed: rich text is data, not HTML");
        }
        if (node.href && !isDocumentHref(v, node.href)) {
          fault(
            path,
            node.href === "web"
              ? "Expected an http or https address"
              : "Expected an http, https, mailto or tel address, a path on the site or an anchor",
          );
        }
        return;
      }
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fault(path, "Expected a number");
          return;
        }
        if (node.integer && !Number.isInteger(v)) fault(path, "Expected a whole number");
        if (node.min !== undefined && v < node.min) fault(path, `At least ${node.min}`);
        if (node.max !== undefined && v > node.max) fault(path, `At most ${node.max}`);
        if (node.step !== undefined) {
          const steps = (v - (node.min ?? 0)) / node.step;
          if (Math.abs(steps - Math.round(steps)) > 1e-9) fault(path, `In steps of ${node.step}`);
        }
        return;
      }
      case "boolean":
        if (typeof v !== "boolean") fault(path, "Expected true or false");
        return;
      case "choice":
        if (typeof v !== "string" || !node.options.includes(v)) {
          fault(path, `Expected one of ${node.options.join(", ")}`);
        }
        return;
      case "ref":
        if (typeof v !== "string" || !ID_RE.test(v)) fault(path, `Expected the id of a ${node.to}`);
        return;
    }
  };
  const objectValue = (
    node: DocumentObjectNode,
    v: unknown,
    path: (string | number)[],
    depth: number,
    tag: string | null,
  ) => {
    if (!isObject(v)) {
      fault(path, "Expected an object");
      return;
    }
    for (const key of Object.keys(v)) {
      if (key === tag) continue;
      if (!Object.hasOwn(node.fields, key)) {
        fault([...path, key], `Unknown key "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(node.fields)) {
      if (!Object.hasOwn(v, key) || v[key] === undefined) {
        if (!child.optional) fault([...path, key], "Required");
        continue;
      }
      walk(child, v[key], [...path, key], depth + 1);
    }
  };
  walk(schema.root, value, [], 0);
  return issues.length ? { ok: false, issues } : { ok: true, value, bytes };
}

/** "weeks.0.sessions.2: Required", for messages. */
export function formatDocumentIssue(issue: DocumentIssue): string {
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

// --- Reading a value -----------------------------------------------------------------------------

/** Every `ref` in a valid value: the object it names, the id, and where it is. */
export function documentRefs(
  schema: DocumentSchema,
  value: unknown,
): { to: string; id: string; path: (string | number)[] }[] {
  const refs: { to: string; id: string; path: (string | number)[] }[] = [];
  visit(schema, value, (node, v, path) => {
    if (node.type === "ref" && typeof v === "string") refs.push({ to: node.to, id: v, path });
  });
  return refs;
}

/**
 * The document as someone outside the org may read it: every `private` object removed (from a
 * list, its entry; from an object, its key), unless its `unless` key is true. A value that does
 * not fit the schema is returned as null: an outsider is never shown what was not checked.
 */
export function redactDocument(schema: DocumentSchema, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  const strip = (
    node: DocumentNode | undefined,
    v: unknown,
    depth: number,
  ): { keep: boolean; value: unknown } => {
    const at = useOf(schema, node);
    if (!at || depth > DOCUMENT_MAX_DEPTH) return { keep: false, value: null };
    switch (at.type) {
      case "object":
      case "union": {
        if (!isObject(v)) return { keep: false, value: null };
        const shape: DocumentObjectNode | undefined =
          at.type === "object" ? at : at.variants[String(v[at.tag])];
        if (!shape) return { keep: false, value: null };
        if (shape.private) {
          const unless = shape.private === true ? null : shape.private.unless;
          if (!unless || v[unless] !== true) return { keep: false, value: null };
        }
        const out: Record<string, unknown> = {};
        if (at.type === "union") out[at.tag] = v[at.tag];
        for (const [key, child] of Object.entries(shape.fields)) {
          if (!Object.hasOwn(v, key)) continue;
          const kept = strip(child, v[key], depth + 1);
          if (kept.keep) out[key] = kept.value;
        }
        return { keep: true, value: out };
      }
      case "array": {
        if (!Array.isArray(v)) return { keep: false, value: null };
        return {
          keep: true,
          value: v
            .map((item) => strip(at.of, item, depth + 1))
            .filter((r) => r.keep)
            .map((r) => r.value),
        };
      }
      default:
        return { keep: true, value: v };
    }
  };
  if (!validateDocument(schema, value, { maxBytes: DOCUMENT_MAX_BYTES }).ok) return null;
  const result = strip(schema.root, value, 0);
  return result.keep ? result.value : null;
}

function visit(
  schema: DocumentSchema,
  value: unknown,
  each: (node: DocumentNode, value: unknown, path: (string | number)[]) => void,
): void {
  const walk = (
    node: DocumentNode | undefined,
    v: unknown,
    path: (string | number)[],
    depth: number,
  ) => {
    const at = useOf(schema, node);
    if (!at || depth > DOCUMENT_MAX_DEPTH) return;
    each(at, v, path);
    if (at.type === "array" && Array.isArray(v)) {
      v.forEach((item, i) => {
        walk(at.of, item, [...path, i], depth + 1);
      });
    } else if ((at.type === "object" || at.type === "union") && isObject(v)) {
      const shape = at.type === "object" ? at : at.variants[String(v[at.tag])];
      for (const [key, child] of Object.entries(shape?.fields ?? {})) {
        if (Object.hasOwn(v, key)) walk(child, v[key], [...path, key], depth + 1);
      }
    }
  };
  walk(schema.root, value, [], 0);
}
