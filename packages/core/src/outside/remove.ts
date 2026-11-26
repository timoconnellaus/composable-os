// Removing the booking system's copy (`outside.lists.remove`, stage 65 step 10, ADR 0926): one
// kind of list, or both (what disconnecting the booking system means for a list source). The list
// is marked `removed` at once, so it stops counting at once (every read of the copy holds to the
// current lists, `onCurrentList`), and its rows are deleted in bounded passes in the same batch.
//
// In budget on D1 (ADR 0500: 1,000 statements an invocation, 100 bound parameters a statement,
// 5 terms a compound SELECT): one read of the counts (scalar subqueries, no compound SELECT), one
// read of the current lists, one update of the lists, and at most `REMOVE_MAX_STATEMENTS` deletes,
// each of at most `REMOVE_PASS_ROWS` rows and binding at most two parameters. A copy larger than
// one invocation's passes is removed by calling again: what is left belongs to no current list, so
// nothing reads it meanwhile, and the next load of its kind replaces it anyway.
//
// What is kept, and why: the settings (the business's, holding no person); the lists' log rows
// (counts only, never a name, kept 30 days as every replaced list's); an erased Person's
// suppressions (`core_outside_suppressed`: without them an erased Person comes back with the next
// list); staff's "nobody here" decisions (`core_outside_unlinked`: a keyed hash of a ref, no
// person); the timeline's "Linked to the booking system's list" activities (a Person's history,
// naming no address); the audit.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { LIST_KINDS, type ListKind } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** Rows one delete statement removes. */
export const REMOVE_PASS_ROWS = 2_000;
/** Delete statements one call queues: with its reads and the audit, far under D1's 1,000. */
export const REMOVE_MAX_STATEMENTS = 100;

/** The tables a kind's copy is in, in the order a removal empties them. */
const TABLES: Record<ListKind, { table: string; match?: "person" | "staff" }[]> = {
  members: [
    { table: "core_outside_match", match: "person" },
    { table: "core_outside_membership" },
    { table: "core_outside_membership_type" },
    { table: "core_outside_person" },
  ],
  timetable: [
    { table: "core_outside_match", match: "staff" },
    { table: "core_outside_booking" },
    { table: "core_outside_class" },
    { table: "core_outside_class_type" },
    { table: "core_outside_staff" },
  ],
};

export interface RemovalPlan {
  statements: CompiledQuery[];
  /** The kinds whose current list this removes. */
  lists: ListKind[];
  /** Rows the statements delete. */
  rows: number;
  /** Rows left for the next call. */
  remaining: number;
}

/**
 * The batch that removes `kinds` from the copy: marks their current lists removed (unless
 * `markLists` is false: finishing a removal already made, as the daily maintenance does) and
 * deletes rows of no current list, at most `maxStatements` deletes of `passRows` rows each. Every
 * pass is scoped to rows of a list that is not current, so a list loaded since is never touched.
 * Reads two statements.
 */
export async function planRemoval(
  db: Db,
  kinds: readonly ListKind[],
  now: string,
  opts: { passRows?: number; maxStatements?: number; markLists?: boolean } = {},
): Promise<RemovalPlan> {
  const passRows = opts.passRows ?? REMOVE_PASS_ROWS;
  const maxStatements = opts.maxStatements ?? REMOVE_MAX_STATEMENTS;
  const markLists = opts.markLists ?? true;
  const parts = kinds.flatMap((kind) => TABLES[kind]);
  const key = (p: { table: string; match?: string }) => `${p.table}:${p.match ?? ""}`;
  const current = await db
    .selectFrom("core_outside_list")
    .select(["id", "kind"])
    .where("state", "=", "current")
    .execute();
  const lists = markLists ? current.filter((l) => kinds.includes(l.kind)).map((l) => l.kind) : [];
  // The lists whose rows stay: every current list but those this call removes.
  const keep = JSON.stringify(current.filter((l) => !lists.includes(l.kind)).map((l) => l.id));
  // Which rows a pass may take, as SQL over this file's own constants (nothing from a caller
  // reaches the text; `keep` is bound): a table's rows of no kept list; To match's rows whose
  // outside row is on no kept list.
  const scope = (p: { table: string; match?: "person" | "staff" }) =>
    p.match
      ? `t.kind = '${p.match}' AND NOT EXISTS (SELECT 1 FROM ${
          p.match === "person" ? "core_outside_person" : "core_outside_staff"
        } o WHERE o.ref = t.ref AND o.list_id IN (SELECT value FROM json_each(?1)))`
      : "t.list_id NOT IN (SELECT value FROM json_each(?1))";
  // One SELECT of scalar subqueries: no compound SELECT, one bound parameter.
  const counted = await db.executeQuery<Record<string, number>>(
    CompiledQuery.raw(
      `SELECT ${parts
        .map((p, i) => `(SELECT count(*) FROM ${p.table} t WHERE ${scope(p)}) AS n${i}`)
        .join(", ")}`,
      [keep],
    ),
  );
  const counts = new Map(
    parts.map((p, i) => [key(p), Number(counted.rows[0]?.[`n${i}`] ?? 0)] as const),
  );

  const statements: CompiledQuery[] = [];
  if (lists.length) {
    statements.push(
      CompiledQuery.raw(
        "UPDATE core_outside_list SET state = 'removed', ended_at = ? WHERE state = 'current' AND kind IN (SELECT value FROM json_each(?))",
        [now, JSON.stringify(lists)],
      ),
    );
  }
  let rows = 0;
  let remaining = 0;
  let deletes = 0;
  for (const p of parts) {
    let left = counts.get(key(p)) ?? 0;
    while (left > 0 && deletes < maxStatements) {
      statements.push(
        CompiledQuery.raw(
          `DELETE FROM ${p.table} WHERE rowid IN (SELECT t.rowid FROM ${p.table} t WHERE ${scope(p)} LIMIT ?2)`,
          [keep, passRows],
        ),
      );
      deletes += 1;
      const n = Math.min(left, passRows);
      rows += n;
      left -= n;
    }
    remaining += left;
  }
  return { statements, lists, rows, remaining };
}

/**
 * The daily maintenance's step: finishes a removal a call left unfinished (rows of no current
 * list), within the same bounds as one call. With nothing to do it costs two reads.
 */
export async function finishOutsideRemoval(
  db: CrmDb,
  now: string,
): Promise<{ rows: number; remaining: number }> {
  const plan = await planRemoval(db.query, LIST_KINDS, now, { markLists: false });
  if (plan.statements.length) await db.batch(plan.statements);
  return { rows: plan.rows, remaining: plan.remaining };
}
