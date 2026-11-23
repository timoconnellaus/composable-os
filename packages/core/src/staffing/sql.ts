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

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const seconds = (column: string) => `CAST(strftime('%s', r.${ident(column)}) AS INTEGER)`;

/** The account a row's claim is for, as SQL over the row `r` (and its holder `p`). */
function accountExpr(t: StaffedTables): string {
  return t.account ? `p.${ident(t.account.column)}` : `r.${ident(t.who)}`;
}

/** The claims the rows of `t` meeting `where` (over the row `r`) give, as a SELECT. */
export function selectClaims(t: StaffedTables, where: string): string {
  const account = accountExpr(t);
  const join = t.account
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

/** The claims of the rows of `t` meeting `where`, written (INSERT … SELECT). */
export function deriveClaims(t: StaffedTables, where: string): string {
  return `INSERT INTO core_staff_time (object_type, record_id, account_id, starts, ends) ${selectClaims(t, where)}`;
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
  const out = [
    `CREATE TRIGGER ${ins} AFTER INSERT ON ${ident(t.table)} BEGIN ${clear("NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
    `CREATE TRIGGER ${upd} AFTER UPDATE OF ${columns.join(", ")} ON ${ident(t.table)} BEGIN ${clear("OLD.id, NEW.id")} ${deriveClaims(t, "r.id = NEW.id")}; END`,
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

/** Every claim of an object derived again from its rows (installing, or a changed declaration). */
export function resyncClaims(t: StaffedTables): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_staff_time WHERE object_type = ?", [t.object]),
    CompiledQuery.raw(deriveClaims(t, "1 = 1")),
  ];
}

/** An object's claims dropped (its declaration removed, or the object hidden or renamed). */
export function dropClaims(object: string): CompiledQuery {
  return CompiledQuery.raw("DELETE FROM core_staff_time WHERE object_type = ?", [object]);
}

/**
 * Pairs of shifts that would clash once `t`'s claims are derived (ADR 0621): among its own rows,
 * and against other objects' claims already held. Read before the triggers are built, so a
 * declaration over records that already double-book someone is refused naming them.
 */
export function clashQuery(t: StaffedTables, limit = 5): string {
  return (
    `WITH d AS (${selectClaims(t, "1 = 1")}), o AS (SELECT object_type, record_id, account_id, starts, ends FROM d ` +
    `UNION ALL SELECT object_type, record_id, account_id, starts, ends FROM core_staff_time ` +
    `WHERE object_type != ${literal(t.object)}) ` +
    "SELECT a.record_id AS record, b.object_type AS other_object, b.record_id AS other, " +
    "a.account_id AS account FROM d a JOIN o b ON b.account_id = a.account_id " +
    "AND NOT (b.object_type = a.object_type AND b.record_id = a.record_id) " +
    "AND b.starts < a.ends AND b.ends > a.starts " +
    "AND (b.object_type != a.object_type OR a.record_id < b.record_id) " +
    `LIMIT ${limit}`
  );
}
