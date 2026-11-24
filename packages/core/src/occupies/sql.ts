// The claim on a thing's SQL (stage 49 step 2, ADR 0765): what the schema reconciler builds on an
// occupying object's own table, on the thing's table and on the table its margins are read from,
// so every statement that writes an occupant writes its claims in core_thing_time in that same
// statement (migration 1095), whichever code path or statement shape wrote it. It follows the
// time claim's (staffing/sql.ts, ADR 0621).
//
// An occupant's claims are derived from its stored row alone: one per thing its relation names
// (in or out of the Trash) that is claimed (its `only` flag set, when declared), with the row's
// start less its margin before and end plus its margin after, as whole unix seconds. A record in
// the Trash, in a state that is not live, or with no valid time claims nothing.
//
// The triggers re-derive the claims of every row a statement touches: AFTER INSERT (a REPLACE and
// an upsert are inserts first), AFTER UPDATE OF every column the claim reads plus the id, AFTER
// DELETE. On the thing's table, a thing inserted, deleted, given another id or its flag changed
// re-derives its claims (marking a room "one booking at a time" claims it for everything in it);
// on the margins' table, a changed margin re-derives the claims of the records naming it.
//
// A claim that has ended (by the database's clock) is written only when it overlaps nothing: what
// happened before the room was claimed is history, never a reason to refuse an edit of it. Every
// claim that has not ended meets core_thing_time's own triggers, which refuse an overlap for every
// statement shape.
import { CompiledQuery } from "kysely";
import { ident } from "../extensions/naming.ts";
import { literal } from "../staffing/sql.ts";

/** A margin's column: the occupant's own, or a column of the record its `via` relation names. */
export interface MarginColumn {
  column: string;
  via?: { column: string; table: string } | undefined;
}

/** The columns and tables one occupying object's claims are derived from. */
export interface OccupiesTables {
  /** The object's registry name (core_thing_time.object_type). */
  object: string;
  /** Its x_* table. */
  table: string;
  /** The thing's relation column, and whether it holds many (a JSON list of ids). */
  thing: string;
  many: boolean;
  /** The thing's object, its table and its `only` flag's column. */
  holder: { object: string; table: string; only?: string | undefined };
  starts: string;
  ends: string;
  /** The states column and the live states. */
  state: string;
  live: readonly string[];
  before?: MarginColumn | undefined;
  after?: MarginColumn | undefined;
}

/** The database's clock, unix seconds (a claim that has ended is history). */
export const DB_NOW = "CAST(strftime('%s', 'now') AS INTEGER)";

const seconds = (column: string) => `CAST(strftime('%s', r.${ident(column)}) AS INTEGER)`;

/** A margin in whole seconds, as SQL over the row `r` (never negative; empty is none). */
function marginExpr(m: MarginColumn | undefined): string {
  if (!m) return "0";
  const value = m.via
    ? `(SELECT m.${ident(m.column)} FROM ${ident(m.via.table)} m WHERE m.id = r.${ident(m.via.column)})`
    : `r.${ident(m.column)}`;
  return `CAST(max(0, coalesce(${value}, 0)) * 60 AS INTEGER)`;
}

/** The relation columns a margin is read through (each gets its own triggers and index). */
export function marginVias(
  t: OccupiesTables,
): { column: string; table: string; fields: string[] }[] {
  const out = new Map<string, { column: string; table: string; fields: string[] }>();
  for (const m of [t.before, t.after]) {
    if (!m?.via) continue;
    const key = `${m.via.table}\u0000${m.via.column}`;
    const entry = out.get(key) ?? { column: m.via.column, table: m.via.table, fields: [] };
    if (!entry.fields.includes(m.column)) entry.fields.push(m.column);
    out.set(key, entry);
  }
  return [...out.values()];
}

/** The thing ids a row names, joined as `h` (one record, or each of many). */
function thingsJoin(t: OccupiesTables): string {
  const holder = ident(t.holder.table);
  const column = `r.${ident(t.thing)}`;
  return t.many
    ? ` JOIN json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) j JOIN ${holder} h ON h.id = j.value`
    : ` JOIN ${holder} h ON h.id = ${column}`;
}

/**
 * The claims the rows of `t` meeting `where` (over the row `r` and its thing `h`) give, as a
 * SELECT of object_type, record_id, thing_object, thing_record, starts, ends.
 */
export function selectClaims(t: OccupiesTables, where: string): string {
  const only = t.holder.only ? ` AND h.${ident(t.holder.only)} = 1` : "";
  return (
    `SELECT DISTINCT ${literal(t.object)} AS object_type, r.id AS record_id, ` +
    `${literal(t.holder.object)} AS thing_object, h.id AS thing_record, ` +
    `${seconds(t.starts)} - ${marginExpr(t.before)} AS starts, ` +
    `${seconds(t.ends)} + ${marginExpr(t.after)} AS ends ` +
    `FROM ${ident(t.table)} r${thingsJoin(t)} ` +
    `WHERE (${where}) AND r.deleted_at IS NULL${only} ` +
    `AND r.${ident(t.state)} IN (${t.live.map(literal).join(", ")}) ` +
    `AND ${seconds(t.starts)} IS NOT NULL AND ${seconds(t.ends)} IS NOT NULL ` +
    `AND ${seconds(t.ends)} > ${seconds(t.starts)}`
  );
}

/** A claim's latest end among the earlier claims of its thing (a window over derived claims). */
const PREVIOUS_END =
  "MAX(ends) OVER (PARTITION BY thing_object, thing_record ORDER BY starts, object_type, record_id " +
  "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)";

/**
 * The claims of the rows of `t` meeting `where`, written (INSERT … SELECT) in order of start. A
 * claim that has ended by `now` (SQL, unix seconds) is written only when it overlaps neither an
 * earlier one of the same derivation nor one already held; the rest meet core_thing_time's
 * triggers. Used inside triggers, so no WITH clause (SQLite allows none there).
 */
export function deriveClaims(t: OccupiesTables, where: string, now = DB_NOW): string {
  return (
    "INSERT INTO core_thing_time (object_type, record_id, thing_object, thing_record, starts, ends) " +
    "SELECT object_type, record_id, thing_object, thing_record, starts, ends FROM " +
    `(SELECT d.*, ${PREVIOUS_END} AS prev_end FROM (${selectClaims(t, where)}) d) w ` +
    `WHERE w.ends > ${now} OR ((w.prev_end IS NULL OR w.prev_end <= w.starts) AND NOT EXISTS (` +
    "SELECT 1 FROM core_thing_time c WHERE c.thing_object = w.thing_object " +
    "AND c.thing_record = w.thing_record " +
    "AND NOT (c.object_type = w.object_type AND c.record_id = w.record_id) " +
    "AND c.ends > w.starts AND c.starts < w.ends)) " +
    "ORDER BY starts"
  );
}

/** The trigger names one occupying object owns: on its table, its thing's and its margins'. */
export function occupiesTriggerNames(t: OccupiesTables): string[] {
  return [
    `${t.table}__occupies_ins`,
    `${t.table}__occupies_upd`,
    `${t.table}__occupies_del`,
    `${t.holder.table}__occupied_${t.table}_ins`,
    `${t.holder.table}__occupied_${t.table}_upd`,
    `${t.holder.table}__occupied_${t.table}_del`,
    ...marginVias(t).flatMap((v) => [
      `${v.table}__margins_${t.table}_${v.column}_ins`,
      `${v.table}__margins_${t.table}_${v.column}_upd`,
      `${v.table}__margins_${t.table}_${v.column}_del`,
    ]),
  ];
}

/** DROP TRIGGER statements for an object's triggers (safe when they do not exist). */
export function dropOccupiesTriggers(t: OccupiesTables): string[] {
  return occupiesTriggerNames(t).map((name) => `DROP TRIGGER IF EXISTS ${ident(name)}`);
}

/** The columns of the occupant's table an index helps the triggers find it by. */
export function occupiesIndexColumns(t: OccupiesTables): string[] {
  return [...(t.many ? [] : [t.thing]), ...marginVias(t).map((v) => v.column)];
}

/** CREATE TRIGGER statements keeping an object's claims (run after its columns exist). */
export function createOccupiesTriggers(t: OccupiesTables): string[] {
  const object = literal(t.object);
  const table = ident(t.table);
  const names = occupiesTriggerNames(t).map(ident);
  const [ins, upd, del, holderIns, holderUpd, holderDel] = names;
  const clear = (keys: string) =>
    `DELETE FROM core_thing_time WHERE object_type = ${object} AND record_id IN (${keys});`;
  const vias = marginVias(t);
  // Every column the claims read, and the id (an id update moves them).
  const columns = [
    ...new Set([
      "id",
      "deleted_at",
      t.thing,
      t.starts,
      t.ends,
      t.state,
      ...[t.before, t.after].flatMap((m) => (m ? [m.via?.column ?? m.column] : [])),
    ]),
  ].map(ident);
  // A live record naming a thing whose end is at or before its start is refused, whoever writes
  // it (it would claim nothing, and so could sit inside another's time in the room).
  const thingSet = `r.${ident(t.thing)} IS NOT NULL AND r.${ident(t.thing)} NOT IN ('', '[]')`;
  const backwards =
    `SELECT RAISE(ABORT, 'core_thing_time_backwards') FROM ${table} r ` +
    `WHERE r.id = NEW.id AND r.deleted_at IS NULL AND ${thingSet} ` +
    `AND r.${ident(t.state)} IN (${t.live.map(literal).join(", ")}) ` +
    `AND ${seconds(t.starts)} IS NOT NULL AND ${seconds(t.ends)} IS NOT NULL ` +
    `AND ${seconds(t.ends)} <= ${seconds(t.starts)};`;
  const out = [
    `CREATE TRIGGER ${ins} AFTER INSERT ON ${table} BEGIN ${backwards} ${clear("NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
    `CREATE TRIGGER ${upd} AFTER UPDATE OF ${columns.join(", ")} ON ${table} BEGIN ${backwards} ${clear("OLD.id, NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
    `CREATE TRIGGER ${del} AFTER DELETE ON ${table} BEGIN ${clear("OLD.id")} END`,
  ];
  // The thing: its claims derived again when it comes, goes, changes id or its flag changes.
  const holder = ident(t.holder.table);
  const thingObject = literal(t.holder.object);
  const naming = (ids: string) => (t.many ? `h.id IN (${ids})` : `r.${ident(t.thing)} IN (${ids})`);
  const rederiveThing = (ids: string) =>
    `DELETE FROM core_thing_time WHERE object_type = ${object} AND thing_object = ${thingObject} AND thing_record IN (${ids}); ${deriveClaims(t, naming(ids))};`;
  const holderColumns = ["id", ...(t.holder.only ? [t.holder.only] : [])].map(ident);
  out.push(
    `CREATE TRIGGER ${holderIns} AFTER INSERT ON ${holder} BEGIN ${rederiveThing("NEW.id")} END`,
    `CREATE TRIGGER ${holderUpd} AFTER UPDATE OF ${holderColumns.join(", ")} ON ${holder} BEGIN ${rederiveThing("OLD.id, NEW.id")} END`,
    `CREATE TRIGGER ${holderDel} AFTER DELETE ON ${holder} BEGIN ${rederiveThing("OLD.id")} END`,
  );
  // The margins' records (a service): a changed margin re-derives the records naming it.
  vias.forEach((v, i) => {
    const [vIns, vUpd, vDel] = names.slice(6 + i * 3, 9 + i * 3);
    const source = ident(v.table);
    const via = `r.${ident(v.column)}`;
    const rederive = (ids: string) =>
      `${clear(`SELECT r.id FROM ${table} r WHERE ${via} IN (${ids})`)} ${deriveClaims(t, `${via} IN (${ids})`)};`;
    const watched = ["id", ...v.fields].map(ident).join(", ");
    out.push(
      `CREATE TRIGGER ${vIns} AFTER INSERT ON ${source} BEGIN ${rederive("NEW.id")} END`,
      `CREATE TRIGGER ${vUpd} AFTER UPDATE OF ${watched} ON ${source} BEGIN ${rederive("OLD.id, NEW.id")} END`,
      `CREATE TRIGGER ${vDel} AFTER DELETE ON ${source} BEGIN ${rederive("OLD.id")} END`,
    );
  });
  return out;
}

/**
 * Every claim of an object derived again from its rows (installing, an upgrade, a changed
 * declaration), in order of start. This also heals a claim a raw REPLACE left behind (its row is
 * gone, so it is not derived again). A claim that has ended by `now` and overlaps another is left
 * out (the reconcile reported it); one that has not meets the triggers (the reconcile refused the
 * plan first, so only a race reaches them).
 */
export function resyncClaims(t: OccupiesTables, now: number): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_thing_time WHERE object_type = ?", [t.object]),
    CompiledQuery.raw(deriveClaims(t, "1 = 1", String(Math.floor(now)))),
  ];
}

/** An object's claims dropped (its declaration removed, or the object hidden or renamed). */
export function dropClaims(object: string): CompiledQuery {
  return CompiledQuery.raw("DELETE FROM core_thing_time WHERE object_type = ?", [object]);
}

/** A record that would share a thing with an earlier one once `t`'s claims are derived. */
export interface ThingClashRow {
  object_type: string;
  record_id: string;
  starts: number;
  ends: number;
  other_object: string;
  other: string;
  other_starts: number;
  other_ends: number;
  /** How many records clash in all. */
  total: number;
}

/**
 * The records that would share a thing at once when `t`'s claims are derived (ADR 0765): with an
 * earlier one among its own rows, or with another object's claim on the thing already held. One
 * pass per thing in order of start (a running latest end); each clash is named with the earliest
 * record it overlaps. Clashes involving a record that has not ended (by `now`, unix seconds) come
 * first. Read before the triggers are built.
 */
export function clashQuery(t: OccupiesTables, now: number, limit = 5): string {
  const object = literal(t.object);
  const thingObject = literal(t.holder.object);
  return (
    `WITH d AS MATERIALIZED (${selectClaims(t, "1 = 1")}), ` +
    "o AS MATERIALIZED (SELECT object_type, record_id, thing_record, starts, ends FROM d " +
    "UNION ALL SELECT object_type, record_id, thing_record, starts, ends FROM core_thing_time " +
    `WHERE object_type != ${object} AND thing_object = ${thingObject} ` +
    "AND thing_record IN (SELECT thing_record FROM d)), " +
    "w AS (SELECT o.*, MAX(ends) OVER (PARTITION BY thing_record ORDER BY starts, object_type, " +
    "record_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end FROM o), " +
    "f AS (SELECT * FROM w WHERE prev_end > starts), " +
    "p AS (SELECT f.object_type, f.record_id, f.starts, f.ends, b.object_type AS other_object, " +
    "b.record_id AS other, b.starts AS other_starts, b.ends AS other_ends, " +
    "ROW_NUMBER() OVER (PARTITION BY f.object_type, f.record_id, f.thing_record ORDER BY b.starts, b.record_id) AS n " +
    "FROM f JOIN o b ON b.thing_record = f.thing_record AND b.ends > f.starts AND b.starts < f.ends " +
    "AND NOT (b.object_type = f.object_type AND b.record_id = f.record_id) " +
    "AND (b.starts < f.starts OR (b.starts = f.starts AND (b.object_type, b.record_id) < (f.object_type, f.record_id)))) " +
    "SELECT object_type, record_id, starts, ends, other_object, other, other_starts, other_ends, " +
    `count(*) OVER () AS total FROM p WHERE n = 1 AND (object_type = ${object} OR other_object = ${object}) ` +
    `ORDER BY max(ends, other_ends) > ${Math.floor(now)} DESC, starts LIMIT ${limit}`
  );
}
