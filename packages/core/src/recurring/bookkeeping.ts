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

// --- What one batch has queued ----------------------------------------------------------------------

type Db = import("kysely").Kysely<import("@composable-os/db").CoreDatabase>;
interface Ctx {
  db: Db;
  write: (...statements: CompiledQuery[]) => void;
}

/**
 * What a batch has queued that its own later reads cannot see (ADR 0620): queued writes are not
 * visible to reads in the same handler, so each guard and plan made later in the batch adds these
 * to what it reads. Keyed on the context's `write`, which every context sharing the batch shares.
 */
export interface BatchState {
  /** Bumps of a series' version (by the series' key). */
  seriesBumps: Map<string, number>;
  /** Bumps of one occurrence's version (by the record's key), with its series and date. */
  occurrenceBumps: Map<string, { series: string; date: string; n: number }>;
  /** A series change's bump of every occurrence of a series from a date. */
  seriesWideBumps: { series: string; from: string }[];
  /** Field exceptions set (true) or cleared (false), per record. */
  exceptions: Map<string, Map<string, boolean>>;
  /** Records detached whole. */
  detached: Set<string>;
  /** Values written to a record by hand. */
  values: Map<string, Record<string, unknown>>;
  /** A series' values as written. */
  seriesValues: Map<string, Record<string, unknown>>;
}

const batches = new WeakMap<object, BatchState>();

/** The key of a record (or a series) in a batch's state. */
export const recordKey = (object: string, id: string) => `${object}\u0000${id}`;

/** What this batch has queued so far. */
export function batchOf(ctx: { write: object }): BatchState {
  let state = batches.get(ctx.write);
  if (!state) {
    state = {
      seriesBumps: new Map(),
      occurrenceBumps: new Map(),
      seriesWideBumps: [],
      exceptions: new Map(),
      detached: new Set(),
      values: new Map(),
      seriesValues: new Map(),
    };
    batches.set(ctx.write, state);
  }
  return state;
}

/** Notes an exception set (true) or cleared (false) in this batch. */
export function noteException(
  ctx: { write: object },
  key: string,
  field: string,
  set: boolean,
): void {
  const state = batchOf(ctx);
  const fields = state.exceptions.get(key) ?? new Map<string, boolean>();
  fields.set(field, set);
  state.exceptions.set(key, fields);
}

/**
 * Queues the guard that the series' version is still what was read, counting the bumps this
 * batch queued before it, so the guard is the version the series has at that point of the batch.
 */
export async function guardSeries(ctx: Ctx, object: string, id: string): Promise<void> {
  const read = await seriesVersion(ctx.db, object, id);
  const queued = batchOf(ctx).seriesBumps.get(recordKey(object, id)) ?? 0;
  ctx.write(guardStatement("series", object, id, read + queued));
}

/** Notes that this batch queued a bump of the series' version (armSeriesStatement). */
export function noteSeriesBump(ctx: { write: object }, object: string, id: string): void {
  const map = batchOf(ctx).seriesBumps;
  const key = recordKey(object, id);
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A guard on one occurrence's version, or on the sum of a series' from a date (migration 0810). */
function recurrenceGuard(
  kind: "occurrence" | "occurrences",
  object: string,
  record: string,
  fromDate: string | null,
  expected: number,
) {
  return CompiledQuery.raw(
    "INSERT INTO core_recurrence_guard (kind, object_type, record_id, from_date, expected) VALUES (?, ?, ?, ?, ?)",
    [kind, object, record, fromDate, expected],
  );
}

/**
 * A write by hand to one generated record (ADR 0620): guards that its occurrence is as read and
 * bumps it, so a series change planned before it fails, and it fails if a series change touched it
 * meanwhile. Edits of other records of the series do not contend with it, nor does a run.
 */
export async function guardAndBumpOccurrence(
  ctx: Ctx,
  occurrence: {
    object: string;
    record: string;
    seriesObject: string;
    seriesId: string;
    date: string;
  },
): Promise<void> {
  const state = batchOf(ctx);
  const key = recordKey(occurrence.object, occurrence.record);
  const series = recordKey(occurrence.seriesObject, occurrence.seriesId);
  const row = await ctx.db
    .selectFrom("core_recurrence_occurrence")
    .select("version")
    .where("object_type", "=", occurrence.object)
    .where("record_id", "=", occurrence.record)
    .executeTakeFirst();
  const queued =
    (state.occurrenceBumps.get(key)?.n ?? 0) +
    state.seriesWideBumps.filter((b) => b.series === series && occurrence.date >= b.from).length;
  ctx.write(
    recurrenceGuard(
      "occurrence",
      occurrence.object,
      occurrence.record,
      null,
      Number(row?.version ?? 0) + queued,
    ),
    CompiledQuery.raw(
      "UPDATE core_recurrence_occurrence SET version = version + 1 WHERE object_type = ? AND record_id = ?",
      [occurrence.object, occurrence.record],
    ),
  );
  const entry = state.occurrenceBumps.get(key) ?? { series, date: occurrence.date, n: 0 };
  entry.n += 1;
  state.occurrenceBumps.set(key, entry);
}

/**
 * A change of a series planned from its occurrences from `from` on (ADR 0620): guards that none of
 * them was written by hand since they were read (the sum of their versions), then bumps them all,
 * so a hand edit planned before the change fails rather than land over it.
 */
export async function guardAndBumpSeriesOccurrences(
  ctx: Ctx,
  seriesObject: string,
  seriesId: string,
  from: string,
): Promise<void> {
  const state = batchOf(ctx);
  const series = recordKey(seriesObject, seriesId);
  const totals = async (date: string) => {
    const row = await ctx.db
      .selectFrom("core_recurrence_occurrence")
      .select((eb) => [eb.fn.sum<number>("version").as("sum"), eb.fn.countAll<number>().as("n")])
      .where("series_object", "=", seriesObject)
      .where("series_id", "=", seriesId)
      .where("local_date", ">=", date)
      .executeTakeFirst();
    return { sum: Number(row?.sum ?? 0), n: Number(row?.n ?? 0) };
  };
  let expected = (await totals(from)).sum;
  for (const bump of state.occurrenceBumps.values()) {
    if (bump.series === series && bump.date >= from) expected += bump.n;
  }
  for (const bump of state.seriesWideBumps) {
    if (bump.series === series) expected += (await totals(bump.from > from ? bump.from : from)).n;
  }
  ctx.write(
    recurrenceGuard("occurrences", seriesObject, seriesId, from, expected),
    CompiledQuery.raw(
      "UPDATE core_recurrence_occurrence SET version = version + 1 WHERE series_object = ? AND series_id = ? AND local_date >= ?",
      [seriesObject, seriesId, from],
    ),
  );
  state.seriesWideBumps.push({ series, from });
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
