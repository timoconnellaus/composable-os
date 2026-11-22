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
  kind: "claimed" | "claimant" | "series" | "full" | "unmoved",
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

/** The statements that delete an object's bookkeeping, when its table is dropped for good. */
export function dropRecurringStatements(object: string): CompiledQuery[] {
  return [
    CompiledQuery.raw(
      "DELETE FROM core_recurrence_occurrence WHERE series_object = ? OR object_type = ?",
      [object, object],
    ),
    CompiledQuery.raw("DELETE FROM core_recurrence_series WHERE object_type = ?", [object]),
  ];
}
