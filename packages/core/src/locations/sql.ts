// The `agree` rule's SQL (stage 64 step 2, ADR 0911): what the schema reconciler builds on an
// object that declares `agree` and on the table its paths pass through, so the database refuses a
// live record whose two paths name different locations, whichever code path or statement shape
// wrote it, and however many write at once.
//
// On the declaring object's table (a class): AFTER INSERT, and AFTER UPDATE OF the id, the Trash
// column and every column its paths read, the row just written is read back and refused when it
// is live and both its sides name a location and they differ. On the table a path passes through
// (a room): AFTER UPDATE OF the columns read there, every live record naming the changed row
// through that path is read (by an index on the relation) and the change refused when one would
// then disagree. So a room's location is fixed while a live class at another location would name
// it, and the race between the two writes cannot leave them apart.
//
// A side that is empty (no location, or no room) agrees with anything. A record in the Trash is
// not read; restoring it is an update of `deleted_at`, and checked.
import { fitName, ident } from "../extensions/naming.ts";

/** A side of a rule: a column of the row, or (`via`) a column of the row its relation names. */
export interface AgreeSide {
  column: string;
  via?: { column: string; table: string } | undefined;
}

/** The tables and columns one declaring object's rules read. */
export interface AgreeTables {
  table: string;
  rules: readonly { a: AgreeSide; b: AgreeSide }[];
}

/**
 * Whether a column holds data: it exists, it exists and the reconcile fills its empty rows with
 * the main location (`filled`), the reconcile adds it filled (`main`), or adds it empty.
 */
export type Presence = (table: string, column: string) => "exists" | "filled" | "main" | "absent";

/** The message a declaring row's refusal raises (errors.ts answers it as `location_mismatch`). */
export const LOCATION_MISMATCH = "core_location_mismatch";
/**
 * The message a passed-through row's refusal raises (a room moved from under a live class):
 * errors.ts answers it as `location_mismatch` too, with the words of the write path's own read.
 */
export const LOCATION_IN_USE = "core_location_in_use";

/**
 * A side as SQL over the row `r`. `present` says whether a column holds data yet: a column this
 * reconcile adds is either filled with the main location (`main`) or empty (`absent`), so the
 * check before a reconcile reads what the rows will hold after it.
 */
export function sideExpr(side: AgreeSide, present: Presence = () => "exists", table = ""): string {
  const main = "(SELECT id FROM core_location WHERE main = 1)";
  const value = (t: string, column: string, alias: string) => {
    const state = present(t, column);
    if (state === "main") return main;
    if (state === "absent") return "NULL";
    if (state === "filled") return `coalesce(${alias}.${ident(column)}, ${main})`;
    return `${alias}.${ident(column)}`;
  };
  if (!side.via) return value(table, side.column, "r");
  const via = side.via;
  const link = value(table, via.column, "r");
  if (link === "NULL") return "NULL";
  const target = value(via.table, side.column, "v");
  if (target === "NULL") return "NULL";
  return `(SELECT ${target} FROM ${ident(via.table)} v WHERE v.id = ${link})`;
}

/** The SQL condition over `r` true when some rule's two sides name two different locations. */
export function disagrees(t: AgreeTables, present?: Presence): string {
  return t.rules
    .map(({ a, b }) => {
      const x = sideExpr(a, present, t.table);
      const y = sideExpr(b, present, t.table);
      return `(${x} IS NOT NULL AND ${y} IS NOT NULL AND ${x} <> ${y})`;
    })
    .join(" OR ");
}

/** The relation columns a declaring table's paths pass through, by the table they name. */
export function agreeVias(t: AgreeTables): { table: string; links: string[]; columns: string[] }[] {
  const out = new Map<string, { table: string; links: string[]; columns: string[] }>();
  for (const rule of t.rules) {
    for (const side of [rule.a, rule.b]) {
      if (!side.via) continue;
      const entry = out.get(side.via.table) ?? { table: side.via.table, links: [], columns: [] };
      if (!entry.links.includes(side.via.column)) entry.links.push(side.via.column);
      if (!entry.columns.includes(side.column)) entry.columns.push(side.column);
      out.set(side.via.table, entry);
    }
  }
  return [...out.values()];
}

/** The trigger names one declaring object owns: on its table, and on each table it passes through. */
function agreeTriggerNamesUnfitted(t: AgreeTables): string[] {
  return [
    `${t.table}__agree_ins`,
    `${t.table}__agree_upd`,
    ...agreeVias(t).map((v) => `${v.table}__agreed_${t.table}`),
  ];
}

/** agreeTriggerNames with each name fitted to an identifier (naming.ts `fitName`). */
export function agreeTriggerNames(t: AgreeTables): string[] {
  return agreeTriggerNamesUnfitted(t).map(fitName);
}

/** DROP TRIGGER statements for an object's agree triggers (safe when they do not exist). */
export function dropAgreeTriggers(t: AgreeTables): string[] {
  return agreeTriggerNames(t).map((name) => `DROP TRIGGER IF EXISTS ${ident(name)}`);
}

/** The columns of the declaring table an index helps the other tables' triggers find it by. */
export function agreeIndexColumns(t: AgreeTables): string[] {
  return [...new Set(agreeVias(t).flatMap((v) => v.links))];
}

/** CREATE TRIGGER statements keeping an object's rules (run after its columns exist). */
export function createAgreeTriggers(t: AgreeTables): string[] {
  const table = ident(t.table);
  const [ins, upd, ...vias] = agreeTriggerNames(t).map(ident);
  const refuse = (where: string, message = LOCATION_MISMATCH) =>
    `SELECT RAISE(ABORT, '${message}') FROM ${table} r WHERE ${where} AND r.deleted_at IS NULL AND (${disagrees(t)}) LIMIT 1;`;
  const columns = [
    ...new Set([
      "id",
      "deleted_at",
      ...t.rules.flatMap((r) => [r.a, r.b]).map((s) => s.via?.column ?? s.column),
    ]),
  ].map(ident);
  const out = [
    `CREATE TRIGGER ${ins} AFTER INSERT ON ${table} BEGIN ${refuse("r.id = NEW.id")} END`,
    `CREATE TRIGGER ${upd} AFTER UPDATE OF ${columns.join(", ")} ON ${table} BEGIN ${refuse("r.id = NEW.id")} END`,
  ];
  agreeVias(t).forEach((via, i) => {
    const naming = via.links.map((c) => `r.${ident(c)} = NEW.id`).join(" OR ");
    const watched = via.columns.map(ident).join(", ");
    out.push(
      `CREATE TRIGGER ${vias[i]} AFTER UPDATE OF ${watched} ON ${ident(via.table)} BEGIN ${refuse(`(${naming})`, LOCATION_IN_USE)} END`,
    );
  });
  return out;
}

/** Live records that disagree once a reconcile's columns are filled: read before its triggers. */
export function agreeClashQuery(t: AgreeTables, present: Presence): string {
  return `SELECT r.id AS id FROM ${ident(t.table)} r WHERE r.deleted_at IS NULL AND (${disagrees(t, present)}) LIMIT 5`;
}
