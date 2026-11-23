// The time claim's SQL (stage 45 step 2, ADR 0621): what the schema reconciler builds on a staffed
// object's own table, and on the table that holds a shift's account, so every statement that writes
// a shift writes its claim in core_staff_time in that same statement (migration 0811), whichever
// code path or statement shape wrote it.
//
// A shift's claim is derived from its stored row alone: the account (the row's user field, or the
// `user` field of the record its relation names, in or out of the Trash), the object, the record,
// and its start and end as whole unix seconds. A record in the Trash, in a state that is not live,
// with no account, or with no valid time (an end not after its start) claims nothing.
//
// The triggers re-derive the claim of every row a statement touches: AFTER INSERT (a REPLACE and an
// upsert are inserts first), AFTER UPDATE OF every column the claim reads plus the id (an id update
// moves the claim), AFTER DELETE. On the account's table, a profile inserted, deleted, given another
// account or another id re-derives its shifts. A row a REPLACE deletes with recursive triggers off
// fires nothing: its claim is left behind, and can only refuse more (core_staff_time's own
// triggers refuse an overlap for every statement shape).
import { CompiledQuery } from "kysely";
import { ident } from "../extensions/naming.ts";

/** The columns and tables one staffed object's claim is derived from. */
export interface StaffedTables {
  /** The object's registry name (core_staff_time.object_type). */
  object: string;
  /** Its x_* table. */
  table: string;
  /** The person's column: a user field, or a relation to the account's holder. */
  who: string;
  /** The holder's table and its user column, when the person is a relation. */
  account?: { table: string; column: string } | undefined;
  starts: string;
  ends: string;
  /** The states column and the live states. */
  state: string;
  live: readonly string[];
}

const seconds = (column: string) => `CAST(strftime('%s', r.${ident(column)}) AS INTEGER)`;

/** A string as an SQL literal (an object name, a state, an account id). */
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The account a row's claim is for, as SQL over the row `r` (and its holder `p`). */
function accountExpr(t: StaffedTables): string {
  return t.account ? `p.${ident(t.account.column)}` : `r.${ident(t.who)}`;
}

/**
 * The claims the rows of `t` meeting `where` (over the row `r`) give, as a SELECT. `account`
 * replaces the account expression (a literal: the claims the rows would give another account).
 */
export function selectClaims(t: StaffedTables, where: string, account = accountExpr(t)): string {
  const join =
    t.account && account === accountExpr(t)
      ? ` LEFT JOIN ${ident(t.account.table)} p ON p.id = r.${ident(t.who)}`
      : "";
  return (
    `SELECT ${literal(t.object)} AS object_type, r.id AS record_id, ${account} AS account_id, ` +
    `${seconds(t.starts)} AS starts, ${seconds(t.ends)} AS ends ` +
    `FROM ${ident(t.table)} r${join} ` +
    `WHERE (${where}) AND r.deleted_at IS NULL ` +
    `AND r.${ident(t.state)} IN (${t.live.map(literal).join(", ")}) ` +
    `AND ${account} IS NOT NULL AND ${account} != '' ` +
    `AND ${seconds(t.starts)} IS NOT NULL AND ${seconds(t.ends)} IS NOT NULL ` +
    `AND ${seconds(t.ends)} > ${seconds(t.starts)}`
  );
}

/**
 * The claims of the rows of `t` meeting `where`, written (INSERT … SELECT) in order of start, so
 * each insert's overlap check reads only the claims that end after it starts: a profile's 2,000
 * past classes given to another account read a few rows each, not every one already written.
 */
export function deriveClaims(t: StaffedTables, where: string): string {
  return `INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) ${selectClaims(t, where)} ORDER BY starts`;
}

/** The trigger names one staffed object owns: on its table, and on its account's table. */
export function staffedTriggerNames(t: Pick<StaffedTables, "table" | "account">): string[] {
  return [
    `${t.table}__staffed_ins`,
    `${t.table}__staffed_upd`,
    `${t.table}__staffed_del`,
    ...(t.account
      ? [
          `${t.account.table}__staffs_${t.table}_ins`,
          `${t.account.table}__staffs_${t.table}_upd`,
          `${t.account.table}__staffs_${t.table}_del`,
        ]
      : []),
  ];
}

/** DROP TRIGGER statements for an object's triggers (safe when they do not exist). */
export function dropStaffedTriggers(t: Pick<StaffedTables, "table" | "account">): string[] {
  return staffedTriggerNames(t).map((name) => `DROP TRIGGER IF EXISTS ${ident(name)}`);
}

/** CREATE TRIGGER statements keeping an object's claims (run after its columns exist). */
export function createStaffedTriggers(t: StaffedTables): string[] {
  const object = literal(t.object);
  const [ins, upd, del, holderIns, holderUpd, holderDel] = staffedTriggerNames(t).map(ident);
  const clear = (keys: string) =>
    `DELETE FROM core_staff_time WHERE object_type = ${object} AND record_id IN (${keys});`;
  // Every column the claim reads, and the id (an id update moves the claim).
  const columns = [...new Set(["id", "deleted_at", t.who, t.starts, t.ends, t.state])].map(ident);
  // A live shift whose end is at or before its start is refused, whoever writes it (it would
  // claim nothing, and so could sit inside another of its person's shifts).
  const backwards =
    `SELECT RAISE(ABORT, 'core_staff_time_backwards') FROM ${ident(t.table)} r ` +
    `WHERE r.id = NEW.id AND r.deleted_at IS NULL ` +
    `AND r.${ident(t.state)} IN (${t.live.map(literal).join(", ")}) ` +
    `AND ${seconds(t.starts)} IS NOT NULL AND ${seconds(t.ends)} IS NOT NULL ` +
    `AND ${seconds(t.ends)} <= ${seconds(t.starts)};`;
  const out = [
    `CREATE TRIGGER ${ins} AFTER INSERT ON ${ident(t.table)} BEGIN ${backwards} ${clear("NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
    `CREATE TRIGGER ${upd} AFTER UPDATE OF ${columns.join(", ")} ON ${ident(t.table)} BEGIN ${backwards} ${clear("OLD.id, NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
    `CREATE TRIGGER ${del} AFTER DELETE ON ${ident(t.table)} BEGIN ${clear("OLD.id")} END`,
  ];
  if (t.account && holderIns && holderUpd && holderDel) {
    const holder = ident(t.account.table);
    const who = `r.${ident(t.who)}`;
    const shiftsOf = (ids: string) =>
      `SELECT r.id FROM ${ident(t.table)} r WHERE ${who} IN (${ids}) AND r.deleted_at IS NULL`;
    const rederive = (ids: string) =>
      `${clear(shiftsOf(ids))} ${deriveClaims(t, `${who} IN (${ids})`)};`;
    out.push(
      `CREATE TRIGGER ${holderIns} AFTER INSERT ON ${holder} BEGIN ${rederive("NEW.id")} END`,
      `CREATE TRIGGER ${holderUpd} AFTER UPDATE OF id, ${ident(t.account.column)} ON ${holder} BEGIN ${rederive("OLD.id, NEW.id")} END`,
      `CREATE TRIGGER ${holderDel} AFTER DELETE ON ${holder} BEGIN ${rederive("OLD.id")} END`,
    );
  }
  return out;
}

/** A claim's latest end among its account's earlier claims (a window over a CTE of claims). */
const PREVIOUS_END =
  "MAX(ends) OVER (PARTITION BY account_id ORDER BY starts, object_type, record_id " +
  "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)";

/**
 * Every claim of an object derived again from its rows (installing, an upgrade, a changed
 * declaration), in order of start. This also heals a claim a raw REPLACE left behind (its row is
 * gone, so it is not derived again). Shifts that overlap an earlier one of the same account, or
 * another object's claim, are left without a claim: the reconcile refused the plan if any of them
 * has not ended (clashQuery), so these are past shifts that clashed before the claim existed,
 * reported by the reconcile and never written over.
 */
export function resyncClaims(t: StaffedTables): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_staff_time WHERE object_type = ?", [t.object]),
    CompiledQuery.raw(
      `WITH d AS MATERIALIZED (${selectClaims(t, "1 = 1")}), ` +
        `w AS (SELECT d.*, ${PREVIOUS_END} AS prev_end FROM d) ` +
        "INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) " +
        "SELECT object_type, record_id, account_id, starts, ends FROM w " +
        "WHERE (prev_end IS NULL OR prev_end <= starts) AND NOT EXISTS (" +
        "SELECT 1 FROM core_staff_time c WHERE c.account_id = w.account_id " +
        `AND c.object_type != ${literal(t.object)} AND c.ends > w.starts AND c.starts < w.ends) ` +
        "ORDER BY starts",
    ),
  ];
}

/** An object's claims dropped (its declaration removed, or the object hidden or renamed). */
export function dropClaims(object: string): CompiledQuery {
  return CompiledQuery.raw("DELETE FROM core_staff_time WHERE object_type = ?", [object]);
}

/** A shift that would clash with an earlier one once `t`'s claims are derived. */
export interface ClashRow {
  object_type: string;
  record_id: string;
  starts: number;
  ends: number;
  other_object: string;
  other: string;
  other_starts: number;
  other_ends: number;
  /** How many shifts clash in all. */
  total: number;
}

/**
 * The shifts that would clash once `t`'s claims are derived (ADR 0621): with an earlier one of
 * their account among its own rows, or with another object's claim already held. One pass per
 * account in order of start (a running latest end), never a pair of every two shifts; each clash
 * is named with the earliest shift it overlaps. Clashes involving a shift that has not ended (by
 * `now`, unix seconds) come first. Read before the triggers are built.
 */
export function clashQuery(t: StaffedTables, now: number, limit = 5): string {
  const object = literal(t.object);
  return (
    `WITH d AS MATERIALIZED (${selectClaims(t, "1 = 1")}), ` +
    "o AS MATERIALIZED (SELECT object_type, record_id, account_id, starts, ends FROM d " +
    "UNION ALL SELECT object_type, record_id, account_id, starts, ends FROM core_staff_time " +
    `WHERE object_type != ${object} AND account_id IN (SELECT account_id FROM d)), ` +
    `w AS (SELECT o.*, ${PREVIOUS_END} AS prev_end FROM o), ` +
    "f AS (SELECT * FROM w WHERE prev_end > starts), " +
    "p AS (SELECT f.object_type, f.record_id, f.starts, f.ends, b.object_type AS other_object, " +
    "b.record_id AS other, b.starts AS other_starts, b.ends AS other_ends, " +
    "ROW_NUMBER() OVER (PARTITION BY f.object_type, f.record_id ORDER BY b.starts, b.record_id) AS n " +
    "FROM f JOIN o b ON b.account_id = f.account_id AND b.ends > f.starts AND b.starts < f.ends " +
    "AND NOT (b.object_type = f.object_type AND b.record_id = f.record_id) " +
    "AND (b.starts < f.starts OR (b.starts = f.starts AND (b.object_type, b.record_id) < (f.object_type, f.record_id)))) " +
    "SELECT object_type, record_id, starts, ends, other_object, other, other_starts, other_ends, " +
    `count(*) OVER () AS total FROM p WHERE n = 1 AND (object_type = ${object} OR other_object = ${object}) ` +
    `ORDER BY max(ends, other_ends) > ${Math.floor(now)} DESC, starts LIMIT ${limit}`
  );
}
