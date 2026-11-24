// A JSON Schema (zod's, from an operation's or a tool's input and output) as rows a person can
// read: one per field, its path, type, whether it is required, its constraints and description.
import { cell, code, table } from "./text.mjs";

const MAX_DEPTH = 5;

function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (s.unrepresentable) return "(not shown)";
  if (s.const !== undefined) return code(JSON.stringify(s.const));
  if (s.enum) return s.enum.map((v) => code(JSON.stringify(v))).join(", ");
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].join(" or ");
  if (s.allOf) return s.allOf.map(typeOf).join(" and ");
  const t = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (!t.length) return "any";
  return t
    .map((x) => {
      if (x === "array") return `array of ${typeOf(s.items)}`;
      if (x === "object" && s.additionalProperties && typeof s.additionalProperties === "object") {
        return `map of ${typeOf(s.additionalProperties)}`;
      }
      if (x === "string" && s.format) return `string (${s.format})`;
      return x;
    })
    .join(" or ");
}

function constraints(s) {
  const out = [];
  if (!s || typeof s !== "object") return "";
  if (s.minLength !== undefined) out.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) out.push(`max length ${s.maxLength}`);
  if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(`≤ ${s.maximum}`);
  if (s.exclusiveMaximum !== undefined) out.push(`< ${s.exclusiveMaximum}`);
  if (s.minItems !== undefined) out.push(`at least ${s.minItems}`);
  if (s.maxItems !== undefined) out.push(`at most ${s.maxItems}`);
  if (s.pattern) out.push(`pattern ${code(s.pattern)}`);
  if (s.default !== undefined) out.push(`default ${code(JSON.stringify(s.default))}`);
  return out.join(", ");
}

/** Where an object's properties are: itself, or the object arm of a nullable union. */
function objectOf(s) {
  if (!s || typeof s !== "object") return null;
  if (s.properties) return s;
  if (s.type === "array") return objectOf(s.items);
  const alts = s.anyOf ?? s.oneOf;
  if (alts) {
    const objects = alts.map(objectOf).filter(Boolean);
    if (objects.length === 1) return objects[0];
  }
  return null;
}

function walk(s, prefix, depth, rows) {
  const obj = objectOf(s);
  if (!obj || depth > MAX_DEPTH) return;
  const required = new Set(obj.required ?? []);
  for (const [name, prop] of Object.entries(obj.properties)) {
    const isArray =
      prop?.type === "array" || (Array.isArray(prop?.type) && prop.type.includes("array"));
    const path = `${prefix}${name}`;
    rows.push([
      code(path),
      cell(typeOf(prop)),
      required.has(name) ? "yes" : "",
      cell(constraints(prop)),
      cell(prop?.description ?? ""),
    ]);
    walk(prop, `${path}${isArray ? "[]" : ""}.`, depth + 1, rows);
  }
}

/** The schema as a table, or a sentence when it has no fields. */
export function schemaTable(s) {
  if (!s || typeof s !== "object") return "None.";
  if (s.unrepresentable) return "This schema cannot be shown as fields.";
  const rows = [];
  walk(s, "", 0, rows);
  if (!rows.length) {
    const t = typeOf(s);
    return t === "object" ? "No fields." : `A value of type ${cell(t)}.`;
  }
  return table(["Field", "Type", "Required", "Limits", "Description"], rows);
}
