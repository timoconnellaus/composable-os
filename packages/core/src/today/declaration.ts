// A shipped pack's Today items (stage 60, ADR 0870): the host's half of the contract check. The
// SDK checks the declaration's shape and gates (`todayItemIssues`); this checks its SQL with the
// widget rules, which only the host has: one SELECT or WITH over rec_* views, writing nothing,
// naming only the parameters Today binds, and returning the columns the item says it returns
// (`value`; the rows' display column and record id). Nothing here runs a query.
import { type ExtensionManifest, TODAY_ITEM_PARAMS } from "@composable-os/sdk";
import { bindNamedParams } from "../dashboards/params.ts";
import { ValidationError } from "../errors.ts";
import { objectView } from "../extensions/naming.ts";
import { type Token, tokenize, validateReadOnlySql } from "../operations/query.ts";

/** Words after which a top-level select list ends. */
const SELECT_END = new Set([
  "from",
  "where",
  "group",
  "having",
  "order",
  "limit",
  "window",
  "union",
  "except",
  "intersect",
]);

const isIdentifier = (t: Token | undefined): t is Token =>
  t?.kind === "word" || t?.kind === "quoted";

/**
 * The names of the columns the outermost SELECT returns, lower-cased, as SQLite names them: an
 * alias, or a bare (or table-qualified) column's own name. `null` for a column with no name of its
 * own (an expression without `AS`, or `*`), which a Today item cannot name.
 */
export function resultColumns(source: string): (string | null)[] {
  const tokens = tokenize(source).filter((t) => t.kind !== "comment");
  let depth = 0;
  let start = -1;
  for (const [index, t] of tokens.entries()) {
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (depth === 0 && t.kind === "word" && t.value === "select") {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return [];
  if (tokens[start]?.value === "distinct" || tokens[start]?.value === "all") start++;
  const columns: Token[][] = [[]];
  depth = 0;
  for (const t of tokens.slice(start)) {
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
    if (depth === 0 && t.kind === "word" && SELECT_END.has(t.value)) break;
    if (depth === 0 && t.text === ";") break;
    if (depth === 0 && t.text === ",") columns.push([]);
    else columns.at(-1)?.push(t);
  }
  return columns.map((column) => {
    const last = column.at(-1);
    const before = column.at(-2);
    if (!isIdentifier(last)) return null;
    if (before?.kind === "word" && before.value === "as") return last.value;
    // `x`, `t.x`, or an expression followed by its alias without AS (`count(*) value`).
    if (column.length === 1 || (column.length === 3 && column[1]?.text === ".")) return last.value;
    if (before && (before.text === ")" || before.kind === "number" || isIdentifier(before))) {
      return last.value;
    }
    return null;
  });
}

/**
 * Every issue with the SQL of `manifest`'s Today items. `schemaObjects` is every name in the
 * database (sqlite_master); the views of the manifest's own objects count as present, since an
 * install creates them in the same batch.
 */
export function todayItemSqlIssues(
  manifest: ExtensionManifest,
  schemaObjects: ReadonlySet<string>,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const items = Object.entries(manifest.todayItems ?? {});
  if (!items.length) return issues;
  const names = new Set([...schemaObjects].map((n) => n.toLowerCase()));
  for (const object of Object.keys(manifest.objects)) {
    try {
      names.add(objectView(manifest.id, object).toLowerCase());
    } catch {
      // A bad id or object name is the contract's issue already.
    }
  }
  const check = (path: string, source: string, wants: readonly string[]) => {
    try {
      const bound = bindNamedParams(source, {}, TODAY_ITEM_PARAMS);
      validateReadOnlySql(bound.sql, names);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const reason = (error.details as { reason?: unknown } | undefined)?.reason;
      issues.push({ path, message: typeof reason === "string" ? reason : error.message });
      return;
    }
    const columns = resultColumns(source);
    const missing = wants.filter((column) => !columns.includes(column.toLowerCase()));
    for (const column of missing) {
      issues.push({ path, message: `The query returns no column named ${column}` });
    }
    if (!missing.length && columns.length !== wants.length) {
      issues.push({ path, message: `The query returns only ${wants.join(", ")}` });
    }
  };
  for (const [name, item] of items) {
    const path = `todayItems.${name}`;
    check(`${path}.sql`, item.sql, ["value"]);
    if (item.rows) {
      const { label, detail, record } = item.rows;
      // Names and record ids only: the rows return the columns they declare and nothing else.
      check(`${path}.rows.sql`, item.rows.sql, [label, ...(detail ? [detail] : []), record.id]);
    }
  }
  return issues;
}
