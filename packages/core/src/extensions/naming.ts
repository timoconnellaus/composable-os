// Physical names for extension schema (ADR 0024): tables, views and columns, built from names the
// manifest check has already validated (`[a-z][a-z0-9]*` ids and objects, camelCase fields).
// Each is re-checked by `ident`, as are the names built elsewhere from them (the reconciler's
// index names, `liveViewOf` in schema.ts).
import { EXTENSION_ID_RE, FIELD_NAME_RE, OBJECT_NAME_RE } from "@composable-os/sdk";

const IDENT_RE = /^[a-z][a-z0-9_]{0,120}$/;

/** Fails unless `name` is a plain lowercase SQL identifier. Defence in depth. */
export function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  return name;
}

/** Core objects that extension fields can extend, with their base and read views. */
export const CORE_TARGETS = {
  person: { base: "core_base_people", view: "rec_person" },
  organisation: { base: "core_base_organisations", view: "rec_organisation" },
  activity: { base: "core_base_activities", view: "rec_activity" },
  task: { base: "core_base_tasks", view: "rec_task" },
} as const;
export type CoreTarget = keyof typeof CORE_TARGETS;

export function isCoreTarget(object: string): object is CoreTarget {
  return Object.hasOwn(CORE_TARGETS, object);
}

export function assertExtensionId(id: string): string {
  if (!EXTENSION_ID_RE.test(id)) throw new Error(`Invalid extension id ${JSON.stringify(id)}`);
  return id;
}

/** `example.project` → { extension: "example", object: "project" }. */
export function splitObjectName(name: string): { extension: string; object: string } | null {
  const [extension, object, ...rest] = name.split(".");
  if (!extension || !object || rest.length) return null;
  if (!EXTENSION_ID_RE.test(extension) || !OBJECT_NAME_RE.test(object)) return null;
  return { extension, object };
}

/** Table holding an extension object's records: `x_<ext>_<object>`. */
export function objectTable(extension: string, object: string): string {
  return ident(`x_${assertExtensionId(extension)}_${object}`);
}

/** Read view of an extension object: `rec_x_<ext>_<object>`. */
export function objectView(extension: string, object: string): string {
  return ident(`rec_x_${assertExtensionId(extension)}_${object}`);
}

/** The read view of any object (core or extension). */
export function viewOf(objectName: string): string {
  if (isCoreTarget(objectName)) return CORE_TARGETS[objectName].view;
  const parts = splitObjectName(objectName);
  if (!parts) throw new Error(`Unknown object ${objectName}`);
  return objectView(parts.extension, parts.object);
}

/**
 * 1:1 side table holding extension `extension`'s fields on another object (ADR 0015):
 * `x_<ext>_<object>` for core objects, `x_<ext>_<otherext>_<object>` for extension objects.
 */
export function sideTable(extension: string, target: string): string {
  return ident(`x_${assertExtensionId(extension)}_${target.replace(".", "_")}`);
}

/**
 * The words SQLite (D1) will not take as a bare column name somewhere the platform writes one:
 * in a CREATE TABLE, an ADD COLUMN, or a bare SELECT, WHERE or ORDER BY on a view. A field whose
 * column would be one of them (`order`, `group`, `select`, `currentDate`) gets the column
 * `<word>_` instead, which no field name can produce (a camelCase name never makes a trailing
 * underscore). Every identifier is still spliced bare, so the fix is here, at the one place
 * columns are named (stage 27). test/sql-keywords.test.ts probes every SQLite keyword against
 * D1 and fails when this list and D1 disagree.
 */
export const RESERVED_COLUMN_WORDS: ReadonlySet<string> = new Set([
  "add",
  "all",
  "alter",
  "and",
  "as",
  "autoincrement",
  "between",
  "case",
  "cast",
  "check",
  "collate",
  "commit",
  "constraint",
  "create",
  "current_date",
  "current_time",
  "current_timestamp",
  "default",
  "deferrable",
  "delete",
  "distinct",
  "drop",
  "else",
  "escape",
  "except",
  "exists",
  "false",
  "foreign",
  "from",
  "group",
  "having",
  "in",
  "index",
  "insert",
  "intersect",
  "into",
  "is",
  "isnull",
  "join",
  "limit",
  "not",
  "nothing",
  "notnull",
  "null",
  "on",
  "or",
  "order",
  "primary",
  "raise",
  "references",
  "returning",
  "select",
  "set",
  "table",
  "then",
  "to",
  "transaction",
  "true",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "when",
  "where",
]);

/** camelCase field name → snake_case column name (`<word>_` for a reserved word). */
export function columnName(field: string): string {
  if (!FIELD_NAME_RE.test(field)) throw new Error(`Invalid field name ${JSON.stringify(field)}`);
  const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return ident(RESERVED_COLUMN_WORDS.has(snake) ? `${snake}_` : snake);
}

/** Registry name of a field: the local name on the extension's own objects, else `<ext>.<name>`. */
export function registryFieldName(extension: string, target: string, local: string): string {
  return target.startsWith(`${extension}.`) ? local : `${extension}.${local}`;
}

/** Column of a field in its object's rec_* view: own fields keep theirs, others get `<ext>__`. */
export function viewColumnName(extension: string, target: string, local: string): string {
  const column = columnName(local);
  return target.startsWith(`${extension}.`) ? column : ident(`${extension}__${column}`);
}
