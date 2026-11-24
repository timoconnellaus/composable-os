// Journey signals (stage 53, ADR 0802): the last time each Person had each signal a shipped pack
// declares (`journeySignals`: a record of one of its objects created, or entering a state), kept in
// `core_person_signal` (migration 1175), one row per Person and signal.
//
// The host writes them, never a pack: the pipeline hands every write's recorded changes here and
// queues the result in that write's own batch, beside the value marks (ADR 0590), so a signal is
// recorded for every actor on every path (record.create and record.update, an import, the host's
// own moves through the transition engine: a membership following its subscription, a booking
// promoted from the waitlist), commits with the write or not at all, and is never recorded by an
// approval queue's dry run. Each row says who stood behind the write that made it (`standing`, as
// the write's value marks do) and whether it was a bulk write, for the journey engine to read.
//
// Nothing here reads the database: one statement per batch whatever the number of records, its
// rows in one bound JSON parameter (D1 allows 100 bound parameters a statement).

import { journeySignalFires } from "@composable-os/sdk";
import type { Compilable, CompiledQuery } from "kysely";
import { sql } from "kysely";
import { getObject } from "../fields/index.ts";
import type { HandlerContext, RecordChange } from "../operation.ts";
import type { Standing } from "../routine-mail/marks.ts";

/** One signal a write made: about whom, which, and the record that made it. */
export interface SignalRow {
  person: string;
  signal: string;
  object: string;
  record: string;
}

/** A relation's stored value (an id, or a record reference), or null. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

/**
 * The signals `changes` make, one per Person and signal (the last change wins: every row of one
 * batch has the same time). A record with no Person (a guest's held booking) makes none.
 */
export function signalsOf(changes: readonly RecordChange[]): SignalRow[] {
  const rows = new Map<string, SignalRow>();
  for (const change of changes) {
    if (change.action !== "create" && change.action !== "update") continue;
    const object = getObject(change.object);
    if (!object?.signals?.length || !change.after) continue;
    const before = change.action === "create" ? null : (change.before ?? null);
    if (change.action === "update" && !before) continue;
    for (const signal of object.signals) {
      if (!journeySignalFires(signal, object.states?.field, before, change.after)) continue;
      const person = idOf(change.after[signal.person]);
      if (!person) continue;
      rows.set(`${person}\u0000${signal.id}`, {
        person,
        signal: signal.id,
        object: change.object,
        record: change.id,
      });
    }
  }
  return [...rows.values()];
}

/**
 * The statement recording `changes`' signals, for the write's batch: one upsert for all of them,
 * whatever their number; none when they make no signal. A later time replaces the row; an earlier
 * one (a write that committed after a newer one was recorded) never does.
 */
export function signalStatements(
  ctx: Pick<HandlerContext, "db">,
  changes: readonly RecordChange[],
  info: { standing: Standing; bulk: boolean; now: string },
): (Compilable | CompiledQuery)[] {
  const rows = signalsOf(changes);
  if (!rows.length) return [];
  const json = JSON.stringify(rows.map((r) => [r.person, r.signal, r.object, r.record]));
  return [
    sql`INSERT INTO core_person_signal (person_id, signal, last_at, object_type, record_id, standing, bulk)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ${info.now},
        json_extract(value, '$[2]'), json_extract(value, '$[3]'), ${info.standing}, ${info.bulk ? 1 : 0}
      FROM json_each(${json}) WHERE true
      ON CONFLICT (person_id, signal) DO UPDATE SET
        last_at = excluded.last_at, object_type = excluded.object_type,
        record_id = excluded.record_id, standing = excluded.standing, bulk = excluded.bulk
      WHERE excluded.last_at >= core_person_signal.last_at`.compile(ctx.db),
  ];
}

/** Queues a merge's signals: the survivor keeps the later of each (stage 53). */
export function queueMergeSignals(ctx: HandlerContext, survivorId: string, mergedId: string): void {
  ctx.write(
    sql`INSERT INTO core_person_signal (person_id, signal, last_at, object_type, record_id, standing, bulk)
      SELECT ${survivorId}, signal, last_at, object_type, record_id, standing, bulk
      FROM core_person_signal WHERE person_id = ${mergedId}
      ON CONFLICT (person_id, signal) DO UPDATE SET
        last_at = excluded.last_at, object_type = excluded.object_type,
        record_id = excluded.record_id, standing = excluded.standing, bulk = excluded.bulk
      WHERE excluded.last_at > core_person_signal.last_at`.compile(ctx.db),
    ctx.db.deleteFrom("core_person_signal").where("person_id", "=", mergedId),
  );
}

/** Queues the statement deleting erased People's signals. */
export function queueEraseSignals(ctx: HandlerContext, personIds: readonly string[]): void {
  if (!personIds.length) return;
  ctx.write(
    sql`DELETE FROM core_person_signal WHERE person_id IN (SELECT value FROM json_each(${JSON.stringify(personIds)}))`.compile(
      ctx.db,
    ),
  );
}
