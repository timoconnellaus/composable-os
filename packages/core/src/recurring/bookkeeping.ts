// The `recurring` behaviour's bookkeeping (stage 31, ADR 0500; migration 0560): one row per
// series saying when it next runs, and one per record it made, keyed on the series and the local
// date. The keys are the idempotency: a date is made once, however many runs there are.
import { CompiledQuery } from "kysely";

/** The statement that makes a series due now (a write to it, or its first), or at `at`. */
export function armSeriesStatement(object: string, id: string, at: string, now: string) {
  return CompiledQuery.raw(
    "INSERT INTO core_recurrence_series (object_type, record_id, next_run_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET next_run_at = excluded.next_run_at, updated_at = excluded.updated_at",
    [object, id, at, now],
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
