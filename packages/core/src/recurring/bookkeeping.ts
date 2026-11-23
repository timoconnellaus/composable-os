// The `recurring` behaviour's bookkeeping (stage 31, ADR 0500; migration 0560): one row per
// series saying when it next runs and its version, and one per record it made, keyed on the
// series and the local date. The keys are the idempotency: a date is made once, however many
// runs there are. Guards (core_write_guard) fail a batch planned from a read that is no longer
// true.
import { CompiledQuery } from "kysely";

/**
 * The statement that makes a series due at `at` (now, for a write to it) and bumps its version,
 * so a run or a change planned from the version before fails its batch.
 */
export function armSeriesStatement(object: string, id: string, at: string, now: string) {
  return CompiledQuery.raw(
    "INSERT INTO core_recurrence_series (object_type, record_id, next_run_at, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET next_run_at = excluded.next_run_at, version = core_recurrence_series.version + 1, updated_at = excluded.updated_at",
    [object, id, at, now],
  );
}

/** A series' version as read now (0 when it has no row yet). */
export async function seriesVersion(
  db: import("kysely").Kysely<import("@composable-os/db").CoreDatabase>,
  object: string,
  id: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_recurrence_series")
    .select("version")
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .executeTakeFirst();
  return row?.version ?? 0;
}

/** A guard: the batch fails unless what `kind` names is still `expected` (migration 0560). */
export function guardStatement(
  kind: "claimed" | "claimant" | "series" | "full" | "unmoved" | "held_cap",
  object: string,
  record: string,
  expected: number,
) {
  return CompiledQuery.raw(
    "INSERT INTO core_write_guard (kind, object_type, record_id, expected) VALUES (?, ?, ?, ?)",
    [kind, object, record, expected],
  );
}

/** The occurrence row for a record a series made. Fails the batch if the date was made. */
export function occurrenceStatement(input: {
  seriesObject: string;
  seriesId: string;
  date: string;
  object: string;
  record: string;
  now: string;
}) {
  return CompiledQuery.raw(
    "INSERT INTO core_recurrence_occurrence (series_object, series_id, local_date, object_type, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.seriesObject, input.seriesId, input.date, input.object, input.record, input.now],
  );
}

/** Marks a made record as edited by someone other than the host: the series leaves it alone. */
export function markEditedStatement(object: string, record: string, now: string) {
  return CompiledQuery.raw(
    "UPDATE core_recurrence_occurrence SET edited_at = ? WHERE object_type = ? AND record_id = ? AND edited_at IS NULL",
    [now, object, record],
  );
}

// --- Field-level exceptions (stage 45 step 1, ADR 0620; migration 0810) ---------------------------

/** Makes `field` the record's own: the series no longer writes it. Who and when are the latest. */
export function setExceptionStatement(
  object: string,
  record: string,
  field: string,
  by: string,
  now: string,
) {
  return CompiledQuery.raw(
    "INSERT INTO core_recurrence_exception (object_type, record_id, field, set_by, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (object_type, record_id, field) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at",
    [object, record, field, by, now],
  );
}

/** The record's `field` follows its series again. */
export function clearExceptionStatement(object: string, record: string, field: string) {
  return CompiledQuery.raw(
    "DELETE FROM core_recurrence_exception WHERE object_type = ? AND record_id = ? AND field = ?",
    [object, record, field],
  );
}

/** Every exception of a record, when the record is removed with its date's key. */
export function clearExceptionsStatement(object: string, record: string) {
  return CompiledQuery.raw(
    "DELETE FROM core_recurrence_exception WHERE object_type = ? AND record_id = ?",
    [object, record],
  );
}

/** A record detached whole follows its series again (`recurring.follow`). */
export function reattachStatement(object: string, record: string) {
  return CompiledQuery.raw(
    "UPDATE core_recurrence_occurrence SET edited_at = NULL WHERE object_type = ? AND record_id = ?",
    [object, record],
  );
}

// --- The series' version within one batch ----------------------------------------------------------

/**
 * Version bumps already queued in a batch, per series. A batch can hold several writes that guard
 * a series and bump it (a bulk edit of five of its classes; an edit then the series' own change):
 * each guard must expect the version the batch will have reached by then, not the one read.
 * Keyed on the context's `write`, which every context sharing the batch shares.
 */
const queuedBumps = new WeakMap<object, Map<string, number>>();

function bumpsOf(ctx: { write: object }): Map<string, number> {
  let map = queuedBumps.get(ctx.write);
  if (!map) {
    map = new Map();
    queuedBumps.set(ctx.write, map);
  }
  return map;
}

/**
 * Queues the guard that the series' version is still what was read, counting the bumps this
 * batch queued before it, so the guard is the version the series has at that point of the batch.
 */
export async function guardSeries(
  ctx: {
    db: import("kysely").Kysely<import("@composable-os/db").CoreDatabase>;
    write: (...statements: CompiledQuery[]) => void;
  },
  object: string,
  id: string,
): Promise<void> {
  const read = await seriesVersion(ctx.db, object, id);
  const queued = bumpsOf(ctx).get(`${object}\u0000${id}`) ?? 0;
  ctx.write(guardStatement("series", object, id, read + queued));
}

/** Notes that this batch queued a bump of the series' version (armSeriesStatement or bumpSeries). */
export function noteSeriesBump(ctx: { write: object }, object: string, id: string): void {
  const map = bumpsOf(ctx);
  const key = `${object}\u0000${id}`;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * A write to one of a series' records that a change of the series must not plan over (an
 * exception set or cleared, a record detached): bumps the series' version, so a run or a change
 * planned before it fails its batch and is made again from what is there now.
 */
export function bumpSeriesStatement(object: string, id: string, now: string) {
  return CompiledQuery.raw(
    "UPDATE core_recurrence_series SET version = version + 1, updated_at = ? WHERE object_type = ? AND record_id = ?",
    [now, object, id],
  );
}

/** The statements that delete an object's bookkeeping, when its table is dropped for good. */
export function dropRecurringStatements(object: string): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_recurrence_exception WHERE object_type = ?", [object]),
    CompiledQuery.raw(
      "DELETE FROM core_recurrence_occurrence WHERE series_object = ? OR object_type = ?",
      [object, object],
    ),
    CompiledQuery.raw("DELETE FROM core_recurrence_series WHERE object_type = ?", [object]),
  ];
}
