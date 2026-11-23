// The `recurring` behaviour (stage 31, ADR 0500): a series (a record of an object that declares
// `recurring`) keeps a weekly rule in local wall-clock time, and the host makes the dated records
// it generates (classes) ahead, up to the series' horizon.
//
// - **Generation** is the minute cron's (`runRecurringDue` → `recurring.generate`, as the host):
//   a series is due when it was written (its write sets it due now) and once a day after local
//   midnight in its zone. Each record made is keyed on the series and its local date
//   (core_recurrence_occurrence's primary key) in the batch that creates it, so a re-run, or two
//   runs at once, cannot make a date twice: the second batch fails whole.
// - **Local time is the rule.** 06:00 is 06:00 on both sides of a clock change: the instant moves,
//   the wall clock does not. A time in a change's gap moves forward by the gap; a time that
//   happens twice is the first (time/local.ts). Each record stores its instant and its zone.
// - **Exceptions** (ADR 0620, amending 0500). A copied field changed by someone other than the
//   host (a coach swapped on one class) is that record's own (core_recurrence_exception, with who
//   and when): the series never writes it again and still writes the rest. A record whose time,
//   zone or state was changed by hand is detached whole and never written by the series again;
//   one cancelled stays cancelled, and one deleted is not made again (its date's key is kept).
//   `recurring.follow` makes a field, or a record detached whole, follow the series again.
// - **Changing a series** applies at once, in the write's batch, to its future records not
//   detached whole, field by field (never a field a record keeps as its own): copied fields (places never below what is claimed), times, and dates no longer in
//   the rule (removed, or cancelled when places are claimed on them). Moving or cancelling records
//   with claimed places needs `recurring.change` with the count confirmed. **Ending** it (its
//   `ended` states) does the same for every future record, edited or not.
// - **Closures** (records of the declared closure object): nothing is made on their dates, and
//   the future records already made in them are cancelled (a host move into `cancel`).
import { WEEKDAYS } from "@composable-os/sdk";
import { addDaysToDate } from "../automations/cron.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition, RecurringDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { followersOn } from "../records/follows.ts";
import type { Mover } from "../records/transitions.ts";
import { loadGeneralSettings } from "../settings.ts";
import { assertPlansStaffFree, generationClash } from "../staffing/index.ts";
import {
  isoWeekday,
  localParts,
  parseLocalDate,
  parseLocalTime,
  wallClockOf,
  wallClockToInstant,
} from "../time/local.ts";
import { visibleSource } from "../visibility/index.ts";
import {
  armSeriesStatement,
  batchOf,
  clearExceptionStatement,
  clearExceptionsStatement,
  guardAndBumpOccurrence,
  guardAndBumpSeriesOccurrences,
  guardSeries,
  guardStatement,
  markEditedStatement,
  noteException,
  noteSeriesBump,
  occurrenceStatement,
  reattachStatement,
  recordKey,
  setExceptionStatement,
} from "./bookkeeping.ts";

/**
 * The most records one run of one series makes, and one minute tick makes across every series
 * (ADR 0500, "Cost"). A run's records go in one D1 batch, which counts as one query against the
 * 1000 queries a Worker invocation may make on Workers Paid; the reads each record needs (about
 * five) count one each. 25 a run and 100 a tick keep a tick near 500 queries, half the limit,
 * with the rest of the minute cron beside it.
 */
export const RECURRING_MAX_PER_RUN = 25;
export const RECURRING_MAX_PER_TICK = 100;
/** Minutes after local midnight a series' daily run is due. */
const DAILY_RUN_MINUTE = 5;

// --- The record operations, as recurring reaches them ---------------------------------------------

/** What recurring needs of the record operations (operations/record.ts registers them). */
export interface RecurringWriter {
  load(
    ctx: HandlerContext,
    object: ObjectDefinition,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  create(
    ctx: HandlerContext,
    object: ObjectDefinition,
    values: Record<string, unknown>,
    options: { by: Mover },
  ): Promise<string>;
  update(
    ctx: HandlerContext,
    object: ObjectDefinition,
    id: string,
    values: Record<string, unknown>,
    options: { by: Mover },
  ): Promise<boolean>;
  remove(ctx: HandlerContext, object: ObjectDefinition, id: string): Promise<void>;
}

let writer: RecurringWriter | null = null;

export function setRecurringWriter(next: RecurringWriter): void {
  writer = next;
}

function records(): RecurringWriter {
  if (!writer) throw new Error("recurring: the record operations are not loaded");
  return writer;
}

// --- The rule -------------------------------------------------------------------------------------

/** A series' rule, read from its values. */
export interface SeriesRule {
  weekdays: ReadonlySet<number>;
  /** Minutes of the local day. */
  minutes: number;
  /** Minutes long, or null. */
  length: number | null;
  from: string;
  until: string | null;
  zone: string;
}

/** One record a rule makes: its local date and its instants. */
export interface Occurrence {
  date: string;
  starts: number;
  ends: number | null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * Checks a series' rule values as written (ADR 0500): the time is `HH:MM`, the length whole
 * minutes from 1 to a day, the dates real and in order. A rule may be incomplete (a draft makes
 * nothing); what is given must be right.
 */
export function assertRuleValues(object: ObjectDefinition, values: Record<string, unknown>): void {
  const def = object.recurring;
  if (!def) return;
  const label = (name: string) => object.fields.find((f) => f.name === name)?.label ?? name;
  const refuse = (field: string, message: string) => {
    throw new ValidationError(`${object.label}: ${label(field)} ${message}`, {
      field,
      rule: "recurring_rule",
    });
  };
  const time = values[def.rule.time];
  if (text(time) !== null && parseLocalTime(time as string) === null) {
    refuse(def.rule.time, "must be a local time, HH:MM (00:00 to 23:59)");
  }
  if (def.rule.length) {
    const length = values[def.rule.length];
    if (
      length !== null &&
      length !== undefined &&
      !(typeof length === "number" && Number.isInteger(length) && length >= 1 && length <= 1440)
    ) {
      refuse(def.rule.length, "must be whole minutes, from 1 to 1440");
    }
  }
  const from = text(values[def.rule.from]);
  const until = def.rule.until ? text(values[def.rule.until]) : null;
  if (from && until && until < from)
    refuse(def.rule.until ?? def.rule.from, "is before the first date");
}

/** The rule a series' values give, or null when it is incomplete (nothing is made). */
export function ruleOf(
  def: RecurringDefinition,
  values: Record<string, unknown>,
  defaultZone: string,
): SeriesRule | null {
  const days = values[def.rule.weekdays];
  const weekdays = new Set(
    (Array.isArray(days) ? days : [])
      .map((d) => (WEEKDAYS as readonly string[]).indexOf(String(d)) + 1)
      .filter((d) => d > 0),
  );
  const minutes = parseLocalTime(text(values[def.rule.time]) ?? "");
  const from = text(values[def.rule.from]);
  if (!weekdays.size || minutes === null || !from || !parseLocalDate(from)) return null;
  const lengthValue = def.rule.length ? values[def.rule.length] : null;
  const until = def.rule.until ? text(values[def.rule.until]) : null;
  return {
    weekdays,
    minutes,
    length: typeof lengthValue === "number" && lengthValue > 0 ? lengthValue : null,
    from,
    until: until && parseLocalDate(until) ? until : null,
    zone: text(def.rule.zone ? values[def.rule.zone] : null) ?? defaultZone,
  };
}

/** Whether a rule makes a record on `date`. */
export function ruleIncludes(rule: SeriesRule, date: string): boolean {
  if (date < rule.from || (rule.until !== null && date > rule.until)) return false;
  return rule.weekdays.has(isoWeekday(date));
}

/** The record a rule makes on `date`. */
export function occurrenceOn(rule: SeriesRule, date: string): Occurrence {
  const starts = wallClockToInstant(wallClockOf(date, rule.minutes), rule.zone);
  return { date, starts, ends: rule.length === null ? null : starts + rule.length * 60_000 };
}

/** The records a rule makes from `first` to `last` (local dates, inclusive), in order. */
export function occurrencesBetween(rule: SeriesRule, first: string, last: string): Occurrence[] {
  const out: Occurrence[] = [];
  const start = first > rule.from ? first : rule.from;
  const end = rule.until !== null && rule.until < last ? rule.until : last;
  for (let date = start; date <= end; date = addDaysToDate(date, 1)) {
    if (rule.weekdays.has(isoWeekday(date))) out.push(occurrenceOn(rule, date));
  }
  return out;
}

function isEnded(def: RecurringDefinition, values: Record<string, unknown>): boolean {
  if (!def.ended) return false;
  const value = values[def.ended.field];
  return typeof value === "string" && def.ended.in.includes(value);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The generated record's values for an occurrence of `series`. */
function occurrenceValues(
  def: RecurringDefinition,
  rule: SeriesRule,
  occurrence: Occurrence,
  series: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = { [def.into.starts]: iso(occurrence.starts) };
  if (def.into.ends) values[def.into.ends] = occurrence.ends === null ? null : iso(occurrence.ends);
  if (def.into.zone) values[def.into.zone] = rule.zone;
  for (const [target, source] of Object.entries(def.copy)) values[target] = series[source] ?? null;
  return values;
}

// --- Generation ------------------------------------------------------------------------------------

function generatedOf(def: RecurringDefinition): ObjectDefinition {
  const generated = getObject(def.generates);
  if (!generated) throw new Error(`recurring: ${def.generates} is not installed`);
  return generated;
}

/** The closures' date ranges overlapping `first`..`last`. */
async function closureRanges(
  ctx: HandlerContext,
  def: RecurringDefinition,
  first: string,
  last: string,
): Promise<{ from: string; until: string }[]> {
  if (!def.closures) return [];
  const closure = getObject(def.closures.object);
  const fromCol = closure?.fields.find((f) => f.name === def.closures?.from)?.column;
  const untilCol = closure?.fields.find((f) => f.name === def.closures?.until)?.column;
  if (!closure || !fromCol || !untilCol) return [];
  const rows = (await (ctx.db as AnyDb)
    .selectFrom(visibleSource(ctx, closure))
    .select([`${fromCol} as from`, `${untilCol} as until`])
    .where(fromCol, "<=", last)
    .where(untilCol, ">=", first)
    .execute()) as { from: string | null; until: string | null }[];
  return rows.flatMap((r) => (r.from && r.until ? [{ from: r.from, until: r.until }] : []));
}

// biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
type AnyDb = import("kysely").Kysely<any>;

/**
 * A series' horizon in days: its declared `horizonDays`, never less than the largest value of
 * `horizonAtLeast`'s field among that object's live records (a class type's booking window), so a
 * class exists by the time its booking opens.
 */
export async function horizonOf(ctx: HandlerContext, def: RecurringDefinition): Promise<number> {
  const floor = def.horizonAtLeast;
  if (!floor) return def.horizonDays;
  const target = getObject(floor.object);
  const column = target?.fields.find((f) => f.name === floor.field)?.column;
  if (!target || !column) return def.horizonDays;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(visibleSource(ctx, target))
    .select((eb) => eb.fn.max(column).as("days"))
    .executeTakeFirst()) as { days: number | null } | undefined;
  const days = Math.ceil(Number(row?.days ?? 0));
  return Math.min(Math.max(def.horizonDays, Number.isFinite(days) ? days + 1 : 0), 366);
}

/** What one run of a series did. */
export interface GenerateResult {
  made: number;
  /** More dates are due than one run makes: the series runs again on the next tick. */
  more: boolean;
}

/**
 * Makes `series`' records that are due and not yet made, up to its horizon, as the host, in the
 * calling operation's batch, and sets when it next runs. Records whose start has passed, dates in
 * a closure and dates already made (edited, cancelled or deleted since) are not made. At most
 * `limit` records. The batch is guarded on the series' version: a change to the series committed
 * after this run read it fails the run, which the next tick makes again from the new series.
 */
export async function generateSeries(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  limit = RECURRING_MAX_PER_RUN,
): Promise<GenerateResult> {
  const def = object.recurring;
  if (!def) throw new ValidationError(`${object.label} has no recurring schedule`);
  await guardSeries(ctx, object.name, id);
  const now = Date.parse(ctx.now);
  const { timezone } = await loadGeneralSettings(ctx.db);
  const series = await records().load(ctx, object, id);
  const zone = series ? (ruleOf(def, series, timezone)?.zone ?? timezone) : timezone;
  const today = localParts(now, zone).date;
  const nextDaily = iso(
    wallClockToInstant(wallClockOf(addDaysToDate(today, 1), DAILY_RUN_MINUTE), zone),
  );
  const rule = series && !isEnded(def, series) ? ruleOf(def, series, timezone) : null;
  if (!series || !rule) {
    ctx.write(armSeriesStatement(object.name, id, nextDaily, ctx.now));
    noteSeriesBump(ctx, object.name, id);
    return { made: 0, more: false };
  }
  const last = addDaysToDate(today, await horizonOf(ctx, def));
  const generated = generatedOf(def);
  const made = new Set(
    (
      await ctx.db
        .selectFrom("core_recurrence_occurrence")
        .select("local_date")
        .where("series_object", "=", object.name)
        .where("series_id", "=", id)
        .where("local_date", ">=", today)
        .execute()
    ).map((r) => r.local_date),
  );
  const closures = await closureRanges(ctx, def, today, last);
  const closed = (date: string) => closures.some((c) => c.from <= date && date <= c.until);
  const due = occurrencesBetween(rule, today, last).filter(
    (o) => o.starts > now && !made.has(o.date) && !closed(o.date),
  );
  const batch = due.slice(0, Math.max(0, limit));
  const staffed = generated.staffed;
  const stateField = generated.states?.field;
  for (const occurrence of batch) {
    const values: Record<string, unknown> = {
      ...occurrenceValues(def, rule, occurrence, series),
      [def.link]: id,
    };
    // The host's generation never fails on a clash (ADR 0621): a date whose pattern person is
    // already on an overlapping shift is made with nobody on it, and keeps that as its own (a
    // field exception), so the series does not write the clash back; a rosterer settles it.
    const who = staffed?.who.field;
    const uncovered =
      who !== undefined &&
      values[who] !== null &&
      values[who] !== undefined &&
      (await generationClash(ctx, generated, {
        ...(stateField ? { [stateField]: generated.states?.initial } : {}),
        ...values,
      })) !== null;
    if (uncovered && who) values[who] = null;
    const record = await records().create(ctx, generated, values, { by: "host" });
    ctx.write(
      occurrenceStatement({
        seriesObject: object.name,
        seriesId: id,
        date: occurrence.date,
        object: generated.name,
        record,
        now: ctx.now,
      }),
    );
    if (uncovered && who && Object.hasOwn(def.copy, who)) {
      writeException(ctx, generated.name, record, who, true);
    }
  }
  const more = due.length > batch.length;
  ctx.write(armSeriesStatement(object.name, id, more ? ctx.now : nextDaily, ctx.now));
  noteSeriesBump(ctx, object.name, id);
  if (!more) {
    ctx.write(
      ctx.db
        .updateTable("core_recurrence_series")
        .set({ generated_until: last })
        .where("object_type", "=", object.name)
        .where("record_id", "=", id),
    );
  }
  return { made: batch.length, more };
}

// --- Writes to a series, a generated record or a closure (record.ts calls these) ----------------

/** The objects whose recurring declarations generate `object`'s records. */
function seriesObjectsOf(object: string): ObjectDefinition[] {
  return listObjects().filter((o) => o.recurring?.generates === object);
}

/** The recurring declarations whose closures are `object`'s records. */
function closuresOf(object: string): RecurringDefinition[] {
  return listObjects().flatMap((o) =>
    o.recurring?.closures?.object === object ? [o.recurring] : [],
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of a generated record its series sets as one: its time, its end and its zone. */
function timeFieldsOf(def: RecurringDefinition): string[] {
  return [def.into.starts, def.into.ends, def.into.zone].filter((f): f is string => Boolean(f));
}

/** The occurrence a series made a record for, or null (a one-off record). */
async function occurrenceOf(ctx: HandlerContext, object: string, id: string) {
  return (
    (await ctx.db
      .selectFrom("core_recurrence_occurrence")
      .select(["series_object", "series_id", "local_date", "edited_at", "version"])
      .where("object_type", "=", object)
      .where("record_id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

type OccurrenceRow = NonNullable<Awaited<ReturnType<typeof occurrenceOf>>>;

/**
 * Queues the guard that the record's occurrence is as read and the bump that fails a change of its
 * series planned before this write (ADR 0620): of a series change and an edit to one of its
 * records racing, exactly one commits. Edits of different records, and runs, do not contend.
 */
async function guardRecord(ctx: HandlerContext, object: string, id: string, row: OccurrenceRow) {
  await guardAndBumpOccurrence(ctx, {
    object,
    record: id,
    seriesObject: row.series_object,
    seriesId: row.series_id,
    date: row.local_date,
    version: Number(row.version),
  });
}

/** Sets or clears a field exception, and notes it for the rest of the batch. */
function writeException(
  ctx: HandlerContext,
  object: string,
  id: string,
  field: string,
  set: boolean,
): void {
  ctx.write(
    set
      ? setExceptionStatement(object, id, field, ctx.user.id, ctx.now)
      : clearExceptionStatement(object, id, field),
  );
  noteException(ctx, recordKey(object, id), field, set);
}

/** A series' values: as this batch wrote them, else as stored. */
async function seriesValuesOf(
  ctx: HandlerContext,
  seriesObject: ObjectDefinition,
  id: string,
): Promise<Record<string, unknown> | null> {
  const queued = batchOf(ctx).seriesValues.get(recordKey(seriesObject.name, id));
  if (queued) return queued;
  return records().load(ctx, seriesObject, id);
}

/**
 * A write to a generated record by someone other than the host (ADR 0500, amended by ADR 0620).
 *
 * - A change of a **copied field** (its coach, room, places) makes that field the record's own:
 *   a row in core_recurrence_exception with who and when. The series never writes that field of
 *   that record again, and still writes its others. Set by hand back to the value the series
 *   gives it now, the field follows the series again (its exception is cleared).
 * - A change of its **time, end, zone or state** detaches the whole record, as before: the
 *   occurrence is marked edited, `into.changed` is set, and the series never writes to it again.
 * - A record a series made and one its series has already detached whole: nothing more.
 *
 * Either way the write guards its occurrence's version and bumps it, so a series change planned
 * before it fails and is made again from the new state. What it did is noted for the rest of the
 * batch (a series change later in the same batch sees it). Returns the host values to add to the
 * write (`into.changed`).
 */
export async function generatedRecordEdited(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  by: Mover,
): Promise<Record<string, unknown>> {
  if (by === "host") return {};
  const defs = seriesObjectsOf(object.name).map((o) => o.recurring as RecurringDefinition);
  if (!defs.length) return {};
  const stateField = object.states?.field;
  const differs = (f: string) => !same(before[f], after[f]);
  const changedFlag = (def: RecurringDefinition | undefined) => {
    const changed = def?.into.changed ?? defs.find((d) => d.into.changed)?.into.changed;
    return changed && before[changed] !== true ? { [changed]: true } : {};
  };
  const occurrence = await occurrenceOf(ctx, object.name, id);
  const seriesObject = occurrence ? getObject(occurrence.series_object) : null;
  const def = seriesObject?.recurring;
  if (!occurrence || !seriesObject || !def) {
    // Not a record a series made (a one-off): as before, any change of what a series would set
    // marks it changed. There is no series to guard.
    const watched = new Set<string>(stateField ? [stateField] : []);
    for (const d of defs)
      for (const f of [...timeFieldsOf(d), ...Object.keys(d.copy)]) watched.add(f);
    if (![...watched].some(differs)) return {};
    ctx.write(markEditedStatement(object.name, id, ctx.now));
    return changedFlag(undefined);
  }
  const whole = [...timeFieldsOf(def), ...(stateField ? [stateField] : [])].some(differs);
  const copied = Object.keys(def.copy).filter(differs);
  if (!whole && !copied.length) return {};
  // Detached whole already (by hand, or under the rule before ADR 0620): the series leaves it be.
  const key = recordKey(object.name, id);
  const batch = batchOf(ctx);
  // Guarded and bumped detached or not: a `recurring.follow` reattaching it meanwhile must fail.
  await guardRecord(ctx, object.name, id, occurrence);
  if (occurrence.edited_at || batch.detached.has(key)) return changedFlag(def);
  batch.values.set(key, { ...(batch.values.get(key) ?? {}), ...after });
  if (whole) {
    ctx.write(markEditedStatement(object.name, id, ctx.now));
    batch.detached.add(key);
    return changedFlag(def);
  }
  const series = await seriesValuesOf(ctx, seriesObject, occurrence.series_id);
  for (const field of copied) {
    const source = def.copy[field] as string;
    writeException(ctx, object.name, id, field, !(series && same(after[field], series[source])));
  }
  return {};
}

/** A series created or restored from Trash: due now, so the minute cron makes its records. */
export function seriesCreated(ctx: HandlerContext, object: ObjectDefinition, id: string): void {
  if (!object.recurring) return;
  ctx.write(armSeriesStatement(object.name, id, ctx.now, ctx.now));
  noteSeriesBump(ctx, object.name, id);
}

/** A generated record's exceptions: whether it is detached whole, and the fields it keeps. */
export interface RecordExceptions {
  /** Made by a series (false: a one-off, which has no exceptions). */
  generated: boolean;
  series: { object: string; id: string; date: string } | null;
  /** Detached whole (its time or state changed by hand, or a copied field before ADR 0620). */
  detached: boolean;
  fields: { field: string; setBy: string; setAt: string }[];
}

/** What a record keeps as its own of what its series sets (`recurring.exceptions`). */
export async function exceptionsOf(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<RecordExceptions> {
  const occurrence = await occurrenceOf(ctx, object.name, id);
  if (!occurrence) return { generated: false, series: null, detached: false, fields: [] };
  const rows = await ctx.db
    .selectFrom("core_recurrence_exception")
    .select(["field", "set_by", "set_at"])
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .orderBy("field")
    .execute();
  return {
    generated: true,
    series: {
      object: occurrence.series_object,
      id: occurrence.series_id,
      date: occurrence.local_date,
    },
    detached: occurrence.edited_at !== null,
    fields: rows.map((r) => ({ field: r.field, setBy: r.set_by, setAt: r.set_at })),
  };
}

/** What `recurring.follow` did. */
export interface FollowResult {
  /** Fields that follow the series again (their value is the series' now). */
  followed: string[];
  /** Fields kept as the record's own because they were not named (a record detached whole). */
  kept: string[];
  /** It was detached whole and is now the series' again. */
  reattached: boolean;
}

/**
 * "Follow the series" (ADR 0620): the named copied fields of a generated record (default every
 * one) take the series' values now, as the host, and follow it from now on. A record detached
 * whole (by the rule before ADR 0620, or its time put back since) is the series' again, provided
 * its time, end and zone are the series' for its date (else refused: it was moved by hand, and
 * following would move it); its copied fields that are not named and differ from the series are
 * kept as exceptions, so following changes nothing but what was asked. Past, cancelled and
 * finished records are never changed by their series, and are refused.
 */
export async function followSeries(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  fields?: readonly string[],
): Promise<FollowResult> {
  const occurrence = await occurrenceOf(ctx, object.name, id);
  const seriesObject = occurrence ? getObject(occurrence.series_object) : null;
  const def = seriesObject?.recurring;
  if (!occurrence || !seriesObject || !def) {
    throw new ValidationError(`This ${object.label.toLowerCase()} was not made by a series`, {
      rule: "recurring_not_generated",
    });
  }
  const copied = Object.keys(def.copy);
  for (const f of fields ?? []) {
    if (!copied.includes(f)) {
      throw new ValidationError(`${f} is not a field the series sets`, {
        field: "fields",
        rule: "recurring_not_copied",
        copied,
      });
    }
  }
  // An empty list is refused rather than read as "every field" (omit it for that).
  if (fields && !fields.length) {
    throw new ValidationError("Name at least one field, or leave fields out for every one", {
      field: "fields",
      rule: "recurring_no_fields",
    });
  }
  const named = fields ? [...new Set(fields)] : copied;
  const record = await records().load(ctx, object, id);
  const series = await records().load(ctx, seriesObject, occurrence.series_id);
  if (!record) throw new NotFoundError(object.name, id);
  if (!series) throw new NotFoundError(seriesObject.name, occurrence.series_id);
  const stateField = object.states?.field;
  const finals = new Set((object.states?.moves ?? []).filter((m) => m.final).map((m) => m.to));
  const state = stateField ? record[stateField] : null;
  const starts = Date.parse(String(record[def.into.starts] ?? ""));
  if (
    !(starts > Date.parse(ctx.now)) ||
    (typeof state === "string" && (state === def.cancel || finals.has(state)))
  ) {
    throw new ConflictError(
      `This ${object.label.toLowerCase()} has passed, or is cancelled or finished: its series no longer changes it.`,
      { rule: "recurring_past" },
    );
  }
  const { timezone } = await loadGeneralSettings(ctx.db);
  const rule = isEnded(def, series) ? null : ruleOf(def, series, timezone);
  if (!rule || !ruleIncludes(rule, occurrence.local_date)) {
    throw new ConflictError(
      `Its series no longer makes a ${object.label.toLowerCase()} on ${occurrence.local_date}.`,
      { rule: "recurring_not_in_series", date: occurrence.local_date },
    );
  }
  const wanted = occurrenceValues(def, rule, occurrenceOn(rule, occurrence.local_date), series);
  const reattached = occurrence.edited_at !== null;
  const kept: string[] = [];
  if (reattached) {
    const moved = timeFieldsOf(def).filter((f) => !same(record[f], wanted[f]));
    // Compared with the series as it is now: a record dated before a `recurring.change { from }`
    // kept the old time, so it reads as moved too (ADR 0620, a stated limit: no series history).
    if (moved.length) {
      throw new ConflictError(
        `This ${object.label.toLowerCase()}'s time is not its series' for its date (it was moved by hand, or the series changed from a later date), so it cannot follow its series without moving. Change its time to the series' first.`,
        { rule: "recurring_moved", fields: moved },
      );
    }
    // A state changed by hand (paused) detached it too: put it back first (a made record starts
    // in the initial state, and the series would otherwise move a record its states hold back).
    const initial = object.states?.initial;
    if (stateField && initial && state !== initial) {
      throw new ConflictError(
        `This ${object.label.toLowerCase()} is ${String(state)}, changed by hand; move it back to ${initial} before it follows its series.`,
        { rule: "recurring_state", state, initial },
      );
    }
    ctx.write(reattachStatement(object.name, id));
    for (const f of copied) {
      if (named.includes(f)) continue;
      // Not named: kept as its own where it differs, and no exception left where it does not.
      const differs = !same(record[f], wanted[f]);
      writeException(ctx, object.name, id, f, differs);
      if (differs) kept.push(f);
    }
  }
  await guardRecord(ctx, object.name, id, occurrence);
  const values: Record<string, unknown> = {};
  for (const f of named) {
    writeException(ctx, object.name, id, f, false);
    if (!same(record[f], wanted[f])) values[f] = wanted[f] ?? null;
  }
  // Places are never set below what is claimed (capacity's own rule): kept at the claimed.
  const places = object.capacity?.places;
  if (places && typeof values[places] === "number") {
    const claimed = await claimedOn(ctx, object, id);
    if ((values[places] as number) < claimed) values[places] = claimed;
  }
  const changed = def.into.changed;
  if (reattached && changed && record[changed] === true) values[changed] = null;
  if (Object.keys(values).length) {
    await records().update(ctx, object, id, values, { by: "host" });
  }
  return { followed: named, kept, reattached };
}

/** What a change to a series does to one of its future records. */
interface Planned {
  id: string;
  date: string;
  values: Record<string, unknown>;
  action: "update" | "remove" | "cancel";
  /** An update's record as it will be (a shift's claim is checked on it, ADR 0621). */
  after?: Record<string, unknown>;
  claimed: number;
  /** Live records that follow it (a class's bookings, ADR 0507), places or not. */
  followers: number;
  state: string | null;
}

/** States of `object` the host may move into `cancel` from. */
function cancellableFrom(object: ObjectDefinition, cancel: string): Set<string> {
  return new Set(
    (object.states?.moves ?? [])
      .filter((m) => m.to === cancel && m.by.includes("host"))
      .flatMap((m) => (typeof m.from === "string" ? [m.from] : [...m.from])),
  );
}

/** Refused unless `confirm` is the number of records with places taken this would move or cancel. */
function assertConfirmed(
  plans: readonly {
    id: string;
    date: string;
    action: string;
    claimed: number;
    followers?: number;
  }[],
  confirm: number | undefined,
  what: string,
  how: string,
): void {
  if (!plans.length || confirm === plans.length) return;
  throw new ConflictError(
    `${plans.length} ${what} have places taken and would be moved or cancelled. Confirm with that count (${how}) to go ahead.`,
    {
      rule: "recurring_confirm",
      count: plans.length,
      // How many live records that follow them (bookings) the cancel moves with them (ADR 0507).
      followers: plans.reduce((sum, p) => sum + (p.followers ?? 0), 0),
      records: plans.map((p) => ({
        id: p.id,
        date: p.date,
        action: p.action,
        followers: p.followers ?? 0,
      })),
    },
  );
}

/** The options of a change to a series. */
export interface SeriesChangeOptions {
  /** How many records with places taken the caller confirms are moved or cancelled. */
  confirm?: number | undefined;
  /** The local date the change applies from (default today). Earlier records keep the old series. */
  from?: string | undefined;
  /** The series goes to Trash: its future records are dealt with as for an ended series. */
  trashed?: boolean | undefined;
}

/**
 * A series changed (ADR 0500): its future records follow, in this batch, and it is due now so
 * new dates are made. Records nobody edited take the new copied fields and times; dates no longer
 * in the rule are removed, or cancelled when places are claimed on them; ending (or trashing) the
 * series does that to every future record. Moving or cancelling records with claimed places is
 * refused unless `confirm` is their count (`recurring.change`). Only records from today (in the
 * series' zone, or `from` when later) are read. The batch is guarded: the series' version and each
 * planned record's claimed places must be as read, or it fails as a conflict to try again.
 */
export async function seriesChanged(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: SeriesChangeOptions = {},
): Promise<void> {
  const def = object.recurring;
  if (!def) return;
  const watched = [
    ...Object.values(def.rule),
    ...Object.values(def.copy),
    ...(def.ended ? [def.ended.field] : []),
  ].filter((f): f is string => typeof f === "string");
  const changed =
    options.trashed ||
    watched.some((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
  await guardSeries(ctx, object.name, id);
  ctx.write(armSeriesStatement(object.name, id, ctx.now, ctx.now));
  noteSeriesBump(ctx, object.name, id);
  // A hand edit later in this batch compares with the series as written here.
  const batch = batchOf(ctx);
  batch.seriesValues.set(recordKey(object.name, id), after);
  if (!changed) return;
  const generated = generatedOf(def);
  const { timezone } = await loadGeneralSettings(ctx.db);
  const ended = options.trashed || isEnded(def, after);
  const rule = ended ? null : ruleOf(def, after, timezone);
  const now = Date.parse(ctx.now);
  // Today in either zone (a change of zone moves it), or the date the change applies from.
  const zones = [ruleOf(def, before, timezone)?.zone ?? timezone, rule?.zone ?? timezone];
  const today = zones.map((z) => localParts(now, z).date).sort()[0] as string;
  const first =
    options.from && parseLocalDate(options.from) && options.from > today ? options.from : today;
  // Guarded and bumped against hand edits (ADR 0620), read before the rows below: a hand edit
  // committing between the two reads would otherwise be counted yet not seen.
  await guardAndBumpSeriesOccurrences(ctx, object.name, id, first);
  const rows = await ctx.db
    .selectFrom("core_recurrence_occurrence")
    .select(["local_date", "record_id", "edited_at", "version"])
    .where("series_object", "=", object.name)
    .where("series_id", "=", id)
    .where("local_date", ">=", first)
    .orderBy("local_date")
    .execute();
  // The fields each of those records keeps as its own (ADR 0620): the series writes the rest.
  const own = new Map<string, Set<string>>();
  if (!ended) {
    const exceptions = await ctx.db
      .selectFrom("core_recurrence_exception as e")
      .innerJoin("core_recurrence_occurrence as o", (join) =>
        join.onRef("o.object_type", "=", "e.object_type").onRef("o.record_id", "=", "e.record_id"),
      )
      .select(["e.record_id", "e.field"])
      .where("o.series_object", "=", object.name)
      .where("o.series_id", "=", id)
      .where("o.local_date", ">=", first)
      .execute();
    for (const e of exceptions) {
      const fields = own.get(e.record_id) ?? new Set<string>();
      fields.add(e.field);
      own.set(e.record_id, fields);
    }
  }
  // What this batch queued before the change (a hand edit of one of its records): the reads above
  // cannot see it, so it is added here.
  for (const row of rows) {
    const queued = batch.exceptions.get(recordKey(generated.name, row.record_id));
    if (!queued) continue;
    const fields = own.get(row.record_id) ?? new Set<string>();
    for (const [field, set] of queued) {
      if (set) fields.add(field);
      else fields.delete(field);
    }
    own.set(row.record_id, fields);
  }
  const versions = new Map(rows.map((r) => [r.record_id, Number(r.version)]));
  const finals = new Set((generated.states?.moves ?? []).filter((m) => m.final).map((m) => m.to));
  const stateField = generated.states?.field;
  const plans: Planned[] = [];
  for (const row of rows) {
    const key = recordKey(generated.name, row.record_id);
    if ((row.edited_at || batch.detached.has(key)) && !ended) continue;
    const stored = await records().load(ctx, generated, row.record_id);
    if (!stored) continue;
    const record = { ...stored, ...(batch.values.get(key) ?? {}) };
    const starts = Date.parse(String(record[def.into.starts] ?? ""));
    if (!(starts > now)) continue;
    const state =
      stateField && typeof record[stateField] === "string" ? (record[stateField] as string) : null;
    if (state !== null && (state === def.cancel || finals.has(state))) continue;
    const claimed = await claimedOn(ctx, generated, row.record_id);
    const followers = await followersOn(ctx, generated.name, row.record_id);
    if (!rule || !ruleIncludes(rule, row.local_date)) {
      plans.push({
        id: row.record_id,
        date: row.local_date,
        values: {},
        // Places taken, or anything following it (a waiting booking): cancelled, never removed.
        action: claimed > 0 || followers > 0 ? "cancel" : "remove",
        claimed,
        followers,
        state,
      });
      continue;
    }
    const wanted = occurrenceValues(def, rule, occurrenceOn(rule, row.local_date), after);
    const kept = own.get(row.record_id);
    // The series now gives a kept field the record's own value: indistinguishable from following
    // it, so the exception goes (as when a person sets it back by hand).
    for (const f of kept ?? []) {
      if (Object.hasOwn(wanted, f) && same(record[f], wanted[f])) {
        writeException(ctx, generated.name, row.record_id, f, false);
      }
    }
    const values = Object.fromEntries(
      Object.entries(wanted).filter(([f, v]) => !kept?.has(f) && !same(record[f], v)),
    );
    // Places are never set below what is claimed (capacity's own rule): kept at the claimed.
    const places = generated.capacity?.places;
    if (places && typeof values[places] === "number" && (values[places] as number) < claimed) {
      values[places] = claimed;
    }
    if (Object.keys(values).length) {
      plans.push({
        id: row.record_id,
        date: row.local_date,
        values,
        action: "update",
        after: { ...record, ...values },
        claimed,
        followers,
        state,
      });
    }
  }
  // A record the host cannot move into the cancel state is refused before anything is written.
  const cancellable = cancellableFrom(generated, def.cancel);
  const stuck = plans.filter(
    (p) => p.action === "cancel" && (!stateField || !cancellable.has(p.state ?? "")),
  );
  if (stuck.length) {
    throw new ConflictError(
      `${stuck.length} ${generated.plural?.toLowerCase() ?? "records"} with places taken are in a state the platform cannot cancel them from; change them by hand first.`,
      {
        rule: "recurring_cannot_cancel",
        records: stuck.map((p) => ({ id: p.id, date: p.date, state: p.state })),
      },
    );
  }
  const timeFields = [def.into.starts, def.into.ends, def.into.zone].filter(Boolean) as string[];
  assertConfirmed(
    plans.filter(
      (p) =>
        (p.claimed > 0 || p.followers > 0) &&
        (p.action === "cancel" || timeFields.some((f) => Object.hasOwn(p.values, f))),
    ),
    options.confirm,
    `of this ${object.label.toLowerCase()}'s ${generated.plural?.toLowerCase() ?? "records"}`,
    options.trashed ? "end the series with recurring.change first" : "recurring.change",
  );
  // A change that would put a shift's person on two shifts at once on any date is refused whole,
  // naming the dates (ADR 0621): the rosterer settles those dates first.
  await assertPlansStaffFree(
    ctx,
    generated,
    plans.flatMap((p) =>
      p.action === "update" && p.after ? [{ id: p.id, date: p.date, after: p.after }] : [],
    ),
  );
  for (const plan of plans) {
    // Booked meanwhile, or given back: the plan no longer holds and the change is tried again.
    if (generated.capacity) {
      ctx.write(guardStatement("claimed", generated.name, plan.id, plan.claimed));
    }
    if (plan.action === "update") {
      await records().update(ctx, generated, plan.id, plan.values, { by: "host" });
    } else if (plan.action === "cancel" && stateField) {
      await records().update(ctx, generated, plan.id, { [stateField]: def.cancel }, { by: "host" });
    } else {
      // Removed, and its date's key with it: the date can be made again if the rule returns to it.
      await records().remove(ctx, generated, plan.id);
      batch.removed.set(recordKey(generated.name, plan.id), {
        series: recordKey(object.name, id),
        date: plan.date,
        version: versions.get(plan.id) ?? 0,
      });
      ctx.write(
        ctx.db
          .deleteFrom("core_recurrence_occurrence")
          .where("object_type", "=", generated.name)
          .where("record_id", "=", plan.id),
        clearExceptionsStatement(generated.name, plan.id),
      );
    }
  }
}

/** Places held and taken on a record (0 when its object has no capacity). */
export async function claimedOn(ctx: HandlerContext, object: ObjectDefinition, id: string) {
  if (!object.capacity) return 0;
  const row = await ctx.db
    .selectFrom("core_capacity")
    .select(["held", "taken"])
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .executeTakeFirst();
  return row ? row.held + row.taken : 0;
}

/** A closure's valid range, or null. */
function rangeOf(
  closure: { from: string; until: string },
  values: Record<string, unknown> | null,
): { from: string; until: string } | null {
  if (!values) return null;
  const from = text(values[closure.from]);
  const until = text(values[closure.until]);
  if (!from || !until || !parseLocalDate(from) || !parseLocalDate(until) || until < from) {
    return null;
  }
  return { from, until };
}

/**
 * A closure written (ADR 0500): the future records it newly covers, of every object a series
 * with this closure object generates, are cancelled as the host (one-off records too). A
 * closure's dates are local dates, from and until inclusive, each record's in its own zone
 * (`into.zone`; the organisation's when it has none). An edit that leaves the dates as they were
 * cancels nothing (a class staff reopened stays open); a changed range cancels only the dates it
 * did not cover before. Shortening or deleting a closure brings nothing back: dates never made are
 * made by the next run. Cancelling records with places taken is refused unless `confirm` is their
 * count (`recurring.close`, destructive: an AI asks, a person approves).
 */
export async function closureWritten(
  ctx: HandlerContext,
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  confirm?: number,
): Promise<void> {
  const defs = closuresOf(object.name);
  if (!defs.length) return;
  const { timezone } = await loadGeneralSettings(ctx.db);
  const seen = new Set<string>();
  const targets: {
    generated: ObjectDefinition;
    stateField: string;
    cancel: string;
    id: string;
    date: string;
    claimed: number;
    followers: number;
  }[] = [];
  for (const def of defs) {
    const closure = def.closures;
    if (!closure || seen.has(def.generates)) continue;
    seen.add(def.generates);
    const range = rangeOf(closure, after);
    const old = rangeOf(closure, before);
    if (!range || (old && old.from === range.from && old.until === range.until)) continue;
    const generated = generatedOf(def);
    const startsCol = generated.fields.find((f) => f.name === def.into.starts)?.column;
    const stateField = generated.states?.field;
    const stateCol = generated.fields.find((f) => f.name === stateField)?.column;
    if (!startsCol || !stateField || !stateCol) continue;
    const zoneCol = def.into.zone
      ? generated.fields.find((f) => f.name === def.into.zone)?.column
      : undefined;
    // Only from states the host may move into the cancel state (a final state is left alone).
    const movable = [...cancellableFrom(generated, def.cancel)];
    if (!movable.length) continue;
    // A record's local date is in its own zone; the text range is two days wider either side to
    // cover every offset, and each record's date is then worked out exactly.
    const now = Date.parse(ctx.now);
    const rows = (await (ctx.db as AnyDb)
      .selectFrom(visibleSource(ctx, generated))
      .select(["id", `${startsCol} as starts`, ...(zoneCol ? [`${zoneCol} as zone`] : [])])
      .where(startsCol, ">=", addDaysToDate(range.from, -2))
      .where(startsCol, "<", addDaysToDate(range.until, 3))
      .where(stateCol, "in", movable)
      .execute()) as { id: string; starts: string | null; zone?: string | null }[];
    for (const row of rows) {
      const starts = Date.parse(row.starts ?? "");
      if (!(starts > now)) continue;
      const date = localParts(starts, row.zone || timezone).date;
      if (date < range.from || date > range.until) continue;
      if (old && date >= old.from && date <= old.until) continue;
      const claimed = await claimedOn(ctx, generated, row.id);
      const followers = await followersOn(ctx, generated.name, row.id);
      targets.push({
        generated,
        stateField,
        cancel: def.cancel,
        id: row.id,
        date,
        claimed,
        followers,
      });
    }
  }
  assertConfirmed(
    targets
      .filter((t) => t.claimed > 0 || t.followers > 0)
      .map((t) => ({
        id: t.id,
        date: t.date,
        action: "cancel",
        claimed: t.claimed,
        followers: t.followers,
      })),
    confirm,
    "of the records this closure covers",
    "recurring.close",
  );
  for (const t of targets) {
    if (t.generated.capacity)
      ctx.write(guardStatement("claimed", t.generated.name, t.id, t.claimed));
    await records().update(ctx, t.generated, t.id, { [t.stateField]: t.cancel }, { by: "host" });
  }
}

/** Refuses a recurring operation on an object that has no schedule. */
export function requireSeriesObject(name: string): ObjectDefinition {
  const object = getObject(name);
  if (!object?.recurring) {
    throw new ValidationError(`${name} has no recurring schedule`, { field: "object" });
  }
  return object;
}

/** Refuses `recurring.close` on an object that is no schedule's closures. */
export function requireClosureObject(name: string): ObjectDefinition {
  const object = getObject(name);
  if (!object || !closuresOf(name).length) {
    throw new ValidationError(`${name} is not the closures of a recurring schedule`, {
      field: "object",
    });
  }
  return object;
}
