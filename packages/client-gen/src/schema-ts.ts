// JSON Schema (as zod writes it, draft 2020-12) to a TypeScript type, for the generated client.
// It covers what operation schemas use: objects, arrays, tuples, enums, constants, unions and
// intersections, nullable values, records and $defs references. Anything else is `unknown`, which
// is safe: a client is never told a value has a shape it may not have.

type Schema = Record<string, unknown>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? JSON.stringify(value)
    : "unknown";
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 1 ? (unique[0] as string) : unique.map((p) => `(${p})`).join(" | ");
}

export interface RenderContext {
  /** The root schema's `$defs`, for `#/$defs/<name>` references. */
  defs: Record<string, Schema>;
  depth: number;
}

const MAX_DEPTH = 12;

export function schemaToTs(schema: unknown, ctx: RenderContext = { defs: {}, depth: 0 }): string {
  if (schema === true || schema === undefined) return "unknown";
  if (schema === false) return "never";
  if (!schema || typeof schema !== "object") return "unknown";
  if (ctx.depth > MAX_DEPTH) return "unknown";
  const s = schema as Schema;
  const next: RenderContext = { ...ctx, depth: ctx.depth + 1 };
  const defs = (s.$defs as Record<string, Schema> | undefined) ?? undefined;
  if (defs) next.defs = { ...ctx.defs, ...defs };

  if (typeof s.$ref === "string") {
    const match = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const target = match ? next.defs[match[1] as string] : undefined;
    return target ? schemaToTs(target, next) : "unknown";
  }
  if ("const" in s) return literal(s.const);
  if (Array.isArray(s.enum)) return union(s.enum.map(literal));
  if (Array.isArray(s.anyOf)) return union(s.anyOf.map((x) => schemaToTs(x, next)));
  if (Array.isArray(s.oneOf)) return union(s.oneOf.map((x) => schemaToTs(x, next)));
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((x) => schemaToTs(x, next));
    if (parts.includes("unknown"))
      return parts.filter((p) => p !== "unknown").join(" & ") || "unknown";
    return parts.map((p) => `(${p})`).join(" & ");
  }
  const type = s.type;
  if (Array.isArray(type)) {
    return union(type.map((t) => schemaToTs({ ...s, type: t }, ctx)));
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(s.prefixItems)) {
        return `[${s.prefixItems.map((x) => schemaToTs(x, next)).join(", ")}]`;
      }
      const item = schemaToTs(s.items, next);
      return `${/[|&]/.test(item) ? `(${item})` : item}[]`;
    }
    case "object":
      return objectType(s, next);
    default:
      if (s.properties) return objectType(s, next);
      return "unknown";
  }
}

function objectType(s: Schema, ctx: RenderContext): string {
  const properties = (s.properties as Record<string, unknown> | undefined) ?? {};
  const required = new Set((s.required as string[] | undefined) ?? []);
  const fields = Object.entries(properties).map(([name, value]) => {
    const optional = required.has(name) ? "" : "?";
    return `${key(name)}${optional}: ${schemaToTs(value, ctx)}`;
  });
  const extra = s.additionalProperties;
  if (Object.keys(properties).length === 0) {
    if (extra === false) return "Record<string, never>";
    return `Record<string, ${extra && typeof extra === "object" ? schemaToTs(extra, ctx) : "unknown"}>`;
  }
  if (extra && typeof extra === "object") {
    // Named fields and others besides: the others are typed loosely so the two never conflict.
    return `{ ${fields.join("; ")} } & { [key: string]: unknown }`;
  }
  return `{ ${fields.join("; ")} }`;
}
