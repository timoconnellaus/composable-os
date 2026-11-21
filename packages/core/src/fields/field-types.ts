// The field-type registry for extension fields (ADR 0023): for every SDK field type, its SQLite
// storage, zod validation, filter semantics (and so its filter operators), CSV mapping and the UI
// widgets that display and edit it. Browser-safe: the UI renders widgets from `widget`.
import {
  documentMaxBytesOf,
  documentSchemaOf,
  type FieldManifest,
  type FieldTypeName,
  onStep,
  SLUG_RE,
  validateDocument,
} from "@composable-os/sdk";
import { z } from "zod";
import type { FieldType } from "./types.ts";

export type WidgetKind =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime"
  | "checkbox"
  | "select"
  | "multiSelect"
  | "relation"
  | "user"
  | "email"
  | "phone"
  | "url"
  | "formula"
  | "document";

/** The storage value of a field: what goes into its column. */
export type StoredValue = string | number | null;

export interface FieldTypeSpec {
  /** SQLite column type. Null: no column (formula fields are computed in the rec_* view). */
  storage: "TEXT" | "REAL" | "INTEGER" | null;
  /** How filters treat it (this picks the operators, see OPS_BY_TYPE). */
  filterType(field: FieldManifest): FieldType;
  /** Stored as a JSON array; filters match any element. */
  multi(field: FieldManifest): boolean;
  sortable(field: FieldManifest): boolean;
  /** Validates a value written by record operations (null clears it). */
  schema(field: FieldManifest): z.ZodType;
  /** Converts a validated value to its column value. */
  toStorage(value: unknown): StoredValue;
  /** Converts a column value back to the API value. */
  fromStorage(value: unknown): unknown;
  /** CSV mapping: parse a cell (empty → null) and format a value. */
  csv: { parse(cell: string, field: FieldManifest): unknown; format(value: unknown): string };
  widget: { display: WidgetKind; edit: WidgetKind | null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const nullable = (schema: z.ZodType) => schema.nullable();
const text = (max: number) => z.string().max(max);
const identity = (value: unknown) => (value === undefined ? null : (value as StoredValue));
const jsonArray = {
  toStorage: (value: unknown) => (value == null ? null : JSON.stringify(value)),
  fromStorage: (value: unknown) =>
    typeof value === "string" ? (JSON.parse(value) as unknown[]) : value == null ? null : value,
};
const csvText = {
  parse: (cell: string) => (cell === "" ? null : cell),
  format: (value: unknown) => (value == null ? "" : String(value)),
};
const csvNumber = {
  parse: (cell: string) => {
    if (cell.trim() === "") return null;
    const n = Number(cell.replace(/[,$€£%\s]/g, ""));
    if (!Number.isFinite(n)) throw new Error(`"${cell}" is not a number`);
    return n;
  },
  format: (value: unknown) => (value == null ? "" : String(value)),
};
const csvList = {
  parse: (cell: string) =>
    cell.trim() === ""
      ? null
      : cell
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean),
  format: (value: unknown) => (Array.isArray(value) ? value.map(String).join("; ") : ""),
};

const choices = (field: FieldManifest) => (field.options ?? []).map((o) => o.value);

/**
 * A document field's value: checked against the field's schema, every fault named by its path
 * from the document's root (ADR 0445). The same check runs wherever a value is validated: the
 * record operations, the CSV import, seeds, the host's own writes and the approval dry run.
 */
function documentValueSchema(field: FieldManifest): z.ZodType {
  // A richText field's schema is the platform's one (ADR 0440); a document's is its own.
  const schema = documentSchemaOf(field);
  const maxBytes = documentMaxBytesOf(field);
  return z.unknown().superRefine((value, ctx) => {
    if (value === null) return;
    if (!schema) {
      ctx.addIssue({ code: "custom", message: "This document field has no schema" });
      return;
    }
    const result = validateDocument(schema, value, maxBytes === undefined ? {} : { maxBytes });
    if (result.ok) return;
    for (const issue of result.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
}

function textType(max: number, widget: WidgetKind, edit: WidgetKind, schema?: z.ZodType) {
  return {
    storage: "TEXT",
    filterType: () => "text",
    multi: () => false,
    sortable: () => widget !== "textarea",
    schema: () => nullable(schema ?? text(max)),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: widget, edit },
  } satisfies FieldTypeSpec;
}

function numberType(widget: WidgetKind) {
  return {
    storage: "REAL",
    filterType: () => "number",
    multi: () => false,
    sortable: () => true,
    // The field's bounds (stage 41): below `min`, above `max` or off `step` is refused.
    schema: (field: FieldManifest) => {
      let n = z.number().finite();
      if (field.min !== undefined) n = n.min(field.min, `At least ${field.min}`);
      if (field.max !== undefined) n = n.max(field.max, `At most ${field.max}`);
      const { step } = field;
      const from = field.min ?? 0;
      return nullable(
        step === undefined
          ? n
          : n.refine((v) => onStep(v, from, step), `In steps of ${step} from ${from}`),
      );
    },
    toStorage: identity,
    fromStorage: identity,
    csv: csvNumber,
    widget: { display: widget, edit: widget },
  } satisfies FieldTypeSpec;
}

/**
 * Whether `name` is an IANA time zone this runtime knows (ADR 0460): one of
 * `Intl.supportedValuesOf("timeZone")`, or `UTC`. Aliases the list leaves out are refused, so a
 * stored zone is always one every reader can format in.
 */
export function isTimeZoneName(name: string): boolean {
  if (name === "UTC") return true;
  zones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return zones.has(name);
}
let zones: Set<string> | undefined;

/** A document-valued type (ADR 0445): stored as its JSON, read whole, never filtered. */
const documentType: FieldTypeSpec = {
  storage: "TEXT",
  filterType: () => "json",
  multi: () => false,
  sortable: () => false,
  schema: (field) => nullable(documentValueSchema(field)),
  toStorage: (value) => (value == null ? null : JSON.stringify(value)),
  fromStorage: (value) =>
    typeof value === "string" ? (JSON.parse(value) as unknown) : (value ?? null),
  csv: {
    parse: (cell) => {
      if (cell.trim() === "") return null;
      try {
        return JSON.parse(cell) as unknown;
      } catch {
        throw new Error("is not a JSON document");
      }
    },
    format: (value) => (value == null ? "" : JSON.stringify(value)),
  },
  widget: { display: "document", edit: null },
};

export const FIELD_TYPE_REGISTRY: Record<FieldTypeName, FieldTypeSpec> = {
  // A time zone (ADR 0460): text, but only a name from the runtime's list of zones.
  timezone: textType(
    64,
    "text",
    "text",
    z.string().refine(isTimeZoneName, "Not a time zone: use an IANA name such as Asia/Bangkok"),
  ),
  text: textType(1000, "text", "text"),
  longText: textType(100_000, "textarea", "textarea"),
  email: textType(320, "email", "email", z.email().max(320)),
  phone: textType(64, "phone", "phone", z.string().regex(/^[+0-9 ().-]{3,64}$/)),
  url: textType(2000, "url", "url", z.url().max(2000)),
  number: numberType("number"),
  currency: numberType("currency"),
  percent: numberType("percent"),
  date: {
    storage: "TEXT",
    filterType: () => "date",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.string().regex(DATE_RE, "Expected YYYY-MM-DD")),
    toStorage: identity,
    fromStorage: identity,
    csv: {
      parse: (cell) => {
        if (cell.trim() === "") return null;
        if (!DATE_RE.test(cell.trim())) throw new Error(`"${cell}" is not a YYYY-MM-DD date`);
        return cell.trim();
      },
      format: csvText.format,
    },
    widget: { display: "date", edit: "date" },
  },
  datetime: {
    storage: "TEXT",
    filterType: () => "datetime",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.string().regex(DATETIME_RE, "Expected an ISO-8601 timestamp")),
    toStorage: identity,
    fromStorage: identity,
    csv: {
      parse: (cell) => {
        if (cell.trim() === "") return null;
        const date = new Date(cell.trim());
        if (Number.isNaN(date.getTime())) throw new Error(`"${cell}" is not a timestamp`);
        return date.toISOString();
      },
      format: csvText.format,
    },
    widget: { display: "datetime", edit: "datetime" },
  },
  boolean: {
    storage: "INTEGER",
    filterType: () => "boolean",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.boolean()),
    toStorage: (value) => (value == null ? null : value ? 1 : 0),
    fromStorage: (value) => (value == null ? null : Boolean(value)),
    csv: {
      parse: (cell) => {
        const v = cell.trim().toLowerCase();
        if (v === "") return null;
        if (["true", "yes", "y", "1"].includes(v)) return true;
        if (["false", "no", "n", "0"].includes(v)) return false;
        throw new Error(`"${cell}" is not true or false`);
      },
      format: (value) => (value == null ? "" : value ? "true" : "false"),
    },
    widget: { display: "checkbox", edit: "checkbox" },
  },
  select: {
    storage: "TEXT",
    filterType: () => "enum",
    multi: () => false,
    sortable: () => true,
    schema: (field) => nullable(z.enum(choices(field) as [string, ...string[]])),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "select", edit: "select" },
  },
  multiSelect: {
    storage: "TEXT",
    filterType: () => "enum",
    multi: () => true,
    sortable: () => false,
    schema: (field) => nullable(z.array(z.enum(choices(field) as [string, ...string[]])).max(200)),
    ...jsonArray,
    csv: csvList,
    widget: { display: "multiSelect", edit: "multiSelect" },
  },
  relation: {
    storage: "TEXT",
    filterType: () => "id",
    multi: (field) => field.many === true,
    sortable: (field) => field.many !== true,
    schema: (field) =>
      nullable(
        field.many ? z.array(z.string().min(1).max(64)).max(500) : z.string().min(1).max(64),
      ),
    toStorage: (value) =>
      value == null ? null : Array.isArray(value) ? JSON.stringify(value) : (value as string),
    fromStorage: (value) =>
      typeof value === "string" && value.startsWith("[") ? (JSON.parse(value) as unknown) : value,
    csv: {
      parse: (cell, field) => (field.many ? csvList.parse(cell) : csvText.parse(cell)),
      format: (value) => (Array.isArray(value) ? csvList.format(value) : csvText.format(value)),
    },
    widget: { display: "relation", edit: "relation" },
  },
  user: {
    storage: "TEXT",
    filterType: () => "id",
    multi: () => false,
    sortable: () => false,
    schema: () => nullable(z.string().min(1).max(64)),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "user", edit: "user" },
  },
  // One JSON document checked against the field's schema (stage 41, ADR 0445). Not filtered or
  // sorted itself: its declared paths are columns of their own (schema.ts).
  document: documentType,
  // Rich text (stage 28, ADR 0440): a document with the platform's one schema. The admin shows
  // its JSON until the editor (stage 28, step 5) edits it.
  richText: documentType,
  // A record's address (stage 28, ADR 0442). Unique among live records by an index the
  // reconciler makes; made from the title when left empty (records/slug.ts).
  slug: textType(
    120,
    "text",
    "text",
    z.string().max(120).regex(SLUG_RE, "Lowercase letters and digits in words joined by hyphens"),
  ),
  formula: {
    storage: null,
    // Replaced by the formula's result type when the registry is built.
    filterType: () => "text",
    multi: () => false,
    sortable: () => true,
    schema: () => z.never(),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "formula", edit: null },
  },
};

/** The filter type a formula result maps to. */
export function formulaFilterType(resultType: string): FieldType {
  switch (resultType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    default:
      return "text";
  }
}

/** Converts a formula's stored value (booleans are 0/1) to its API value. */
export function formulaFromStorage(resultType: string | undefined, value: unknown): unknown {
  if (resultType === "boolean") return value == null ? null : Boolean(value);
  return value ?? null;
}
