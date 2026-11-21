// The extension field types (ADR 0023) and the facts about them both the SDK and the host need:
// the formula type a field reads as, and which type changes are lossless. Storage, validation,
// filter operators, CSV mapping and widgets live in the host's field-type registry
// (`@composable-os/core`, fields/field-types.ts), keyed by these names.
import type { FormulaType } from "./formula/ast.ts";

export const FIELD_TYPES = [
  "text",
  "longText",
  "number",
  "currency",
  "percent",
  "date",
  "datetime",
  "boolean",
  "select",
  "multiSelect",
  "relation",
  "user",
  "email",
  "phone",
  "url",
  "formula",
  // A JSON document checked against a schema the field declares (stage 41, ADR 0445).
  "document",
  // An IANA time zone name (`Asia/Bangkok`), checked against the runtime's list of zones. Left
  // empty on a new record, the host fills in the deployment's zone (ADR 0460).
  "timezone",
  // Structured prose: a document with the platform's one rich text schema (stage 28, ADR 0440).
  "richText",
  // A record's address in its object (`summer-launch`): lowercase words joined by hyphens,
  // unique among the object's live records, made from the title when left empty (ADR 0442).
  "slug",
] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

/** What a formula sees when it reads a field of this type (null: not readable from formulas). */
export function formulaTypeOf(
  type: FieldTypeName,
  many = false,
): Exclude<FormulaType, "null"> | null {
  switch (type) {
    case "text":
    case "longText":
    case "select":
    case "user":
    case "email":
    case "phone":
    case "url":
    case "timezone":
    case "slug":
      return "text";
    case "relation":
      return many ? null : "text";
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "multiSelect":
    case "formula":
    case "document":
    case "richText":
      return null;
  }
}

/**
 * Type changes the reconciler accepts: the stored values stay valid and keep their meaning.
 * Anything else is refused with a suggestion to add a new field and migrate.
 */
export const LOSSLESS_TYPE_CHANGES: Readonly<Record<FieldTypeName, readonly FieldTypeName[]>> = {
  text: ["longText"],
  longText: [],
  number: ["currency", "percent"],
  currency: ["number"],
  percent: ["number"],
  date: ["datetime"],
  datetime: [],
  boolean: [],
  select: ["text", "longText"],
  multiSelect: [],
  relation: [],
  user: [],
  email: ["text", "longText"],
  phone: ["text", "longText"],
  url: ["text", "longText"],
  formula: [],
  document: [],
  timezone: ["text", "longText"],
  richText: [],
  slug: ["text", "longText"],
};

export function isLosslessChange(from: FieldTypeName, to: FieldTypeName): boolean {
  return from === to || LOSSLESS_TYPE_CHANGES[from].includes(to);
}
