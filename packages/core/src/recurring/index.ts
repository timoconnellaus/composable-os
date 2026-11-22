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
// - **Exceptions.** A record changed by someone other than the host (its time, a copied field,
//   its state) is marked edited and never written by the series again; one cancelled stays
//   cancelled, and one deleted is not made again (its date's key is kept).
// - **Changing a series** applies at once, in the write's batch, to its future records nobody
//   edited: copied fields (places never below what is claimed), times, and dates no longer in
//   the rule (removed, or cancelled when places are claimed on them). Moving or cancelling records
//   with claimed places needs `recurring.change` with the count confirmed. **Ending** it (its
//   `ended` states) does the same for every future record, edited or not.
// - **Closures** (records of the declared closure object): nothing is made on their dates, and
//   the future records already made in them are cancelled (a host move into `cancel`).
import { WEEKDAYS } from "@composable-os/sdk";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition, RecurringDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  addDays,
  isoWeekday,
  localInstant,
  localParts,
  parseLocalDate,
  parseLocalTime,
} from "../time/local.ts";
import { visibleSource } from "../visibility/index.ts";
import { armSeriesStatement, markEditedStatement, occurrenceStatement } from "./bookkeeping.ts";

/** The most records one run of one series makes; the rest are made by the next tick. */
export const RECURRING_MAX_PER_RUN = 60;
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
  const starts = localInstant(date, rule.minutes, rule.zone);
  return { date, starts, ends: rule.length === null ? null : starts + rule.length * 60_000 };
}

/** The records a rule makes from `first` to `last` (local dates, inclusive), in order. */
export function occurrencesBetween(rule: SeriesRule, first: string, last: string): Occurrence[] {
  const out: Occurrence[] = [];
  const start = first > rule.from ? first : rule.from;
  const end = rule.until !== null && rule.until < last ? rule.until : last;
  for (let date = start; date <= end; date = addDays(date, 1)) {
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

/** What one run of a series did. */
export interface GenerateResult {
  made: number;
  /** More dates are due than one run makes: the series runs again on the next tick. */
  more: boolean;
}

/**
 * Makes `series`' records that are due and not yet made, up to its horizon, as the host, in the
 * calling operation's batch, and sets when it next runs. Records whose start has passed, dates in
 * a closure and dates already made (edited, cancelled or deleted since) are not made.
 */
export async function generateSeries(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<GenerateResult> {
  const def = object.recurring;
  if (!def) throw new ValidationError(`${object.label} has no recurring schedule`);
  const now = Date.parse(ctx.now);
  const { timezone } = await loadGeneralSettings(ctx.db);
  const series = await records().load(ctx, object, id);
  const zone = series ? (ruleOf(def, series, timezone)?.zone ?? timezone) : timezone;
  const today = localParts(now, zone).date;
  const nextDaily = iso(localInstant(addDays(today, 1), DAILY_RUN_MINUTE, zone));
  const rule = series && !isEnded(def, series) ? ruleOf(def, series, timezone) : null;
  if (!series || !rule) {
    ctx.write(armSeriesStatement(object.name, id, nextDaily, ctx.now));
    return { made: 0, more: false };
  }
  const last = addDays(today, def.horizonDays);
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
  const batch = due.slice(0, RECURRING_MAX_PER_RUN);
  for (const occurrence of batch) {
    const values = {
      ...occurrenceValues(def, rule, occurrence, series),
      [def.link]: id,
    };
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
  }
  const more = due.length > batch.length;
  ctx.write(armSeriesStatement(object.name, id, more ? ctx.now : nextDaily, ctx.now));
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

/**
 * A write to a generated record by someone other than the host that changes what its series
 * sets (its times, zone, copied fields) or its state: the record is marked edited, and the series
 * never writes to it again. Returns the host values to add to the write (`into.changed`).
 */
export function generatedRecordEdited(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  by: Mover,
): Record<string, unknown> {
  if (by === "host") return {};
  const defs = seriesObjectsOf(object.name).map((o) => o.recurring as RecurringDefinition);
  if (!defs.length) return {};
  const watched = new Set<string>(object.states ? [object.states.field] : []);
  for (const def of defs) {
    for (const f of [def.into.starts, def.into.ends, def.into.zone, ...Object.keys(def.copy)]) {
      if (f) watched.add(f);
    }
  }
  const differs = [...watched].some(
    (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );
  if (!differs) return {};
  ctx.write(markEditedStatement(object.name, id, ctx.now));
  const changed = defs.find((def) => def.into.changed)?.into.changed;
  return changed && before[changed] !== true ? { [changed]: true } : {};
}

/** A series created: due now, so the minute cron makes its records. */
export function seriesCreated(ctx: HandlerContext, object: ObjectDefinition, id: string): void {
  if (!object.recurring) return;
  ctx.write(armSeriesStatement(object.name, id, ctx.now, ctx.now));
}

/** What a change to a series does to one of its future records. */
interface Planned {
  id: string;
  date: string;
  values: Record<string, unknown>;
  action: "update" | "remove" | "cancel";
  claimed: number;
}

/**
 * A series changed (ADR 0500): its future records follow, in this batch, and it is due now so
 * new dates are made. Records nobody edited take the new copied fields and times; dates no longer
 * in the rule are removed, or cancelled when places are claimed on them; ending the series does
 * that to every future record. Moving or cancelling records with claimed places is refused unless
 * `confirm` is their count (`recurring.change`).
 */
export async function seriesChanged(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  confirm: number | undefined,
): Promise<void> {
  const def = object.recurring;
  if (!def) return;
  const watched = [
    ...Object.values(def.rule),
    ...Object.values(def.copy),
    ...(def.ended ? [def.ended.field] : []),
  ].filter((f): f is string => typeof f === "string");
  const changed = watched.some(
    (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );
  ctx.write(armSeriesStatement(object.name, id, ctx.now, ctx.now));
  if (!changed) return;
  const generated = generatedOf(def);
  const { timezone } = await loadGeneralSettings(ctx.db);
  const ended = isEnded(def, after);
  const rule = ended ? null : ruleOf(def, after, timezone);
  const now = Date.parse(ctx.now);
  const rows = await ctx.db
    .selectFrom("core_recurrence_occurrence")
    .select(["local_date", "record_id", "edited_at"])
    .where("series_object", "=", object.name)
    .where("series_id", "=", id)
    .orderBy("local_date")
    .execute();
  const finals = new Set((generated.states?.moves ?? []).filter((m) => m.final).map((m) => m.to));
  const stateField = generated.states?.field;
  const plans: Planned[] = [];
  for (const row of rows) {
    if (row.edited_at && !ended) continue;
    const record = await records().load(ctx, generated, row.record_id);
    if (!record) continue;
    const starts = Date.parse(String(record[def.into.starts] ?? ""));
    if (!(starts > now)) continue;
    const state = stateField ? record[stateField] : null;
    if (typeof state === "string" && (state === def.cancel || finals.has(state))) continue;
    const claimed = await claimedOn(ctx, generated, row.record_id);
    if (!rule || !ruleIncludes(rule, row.local_date)) {
      plans.push({
        id: row.record_id,
        date: row.local_date,
        values: {},
        action: claimed > 0 ? "cancel" : "remove",
        claimed,
      });
      continue;
    }
    const wanted = occurrenceValues(def, rule, occurrenceOn(rule, row.local_date), after);
    const values = Object.fromEntries(
      Object.entries(wanted).filter(
        ([f, v]) => JSON.stringify(record[f] ?? null) !== JSON.stringify(v ?? null),
      ),
    );
    // Places are never set below what is claimed (capacity's own rule): kept at the claimed.
    const places = generated.capacity?.places;
    if (places && typeof values[places] === "number" && (values[places] as number) < claimed) {
      values[places] = claimed;
    }
    if (Object.keys(values).length) {
      plans.push({ id: row.record_id, date: row.local_date, values, action: "update", claimed });
    }
  }
  const timeFields = [def.into.starts, def.into.ends, def.into.zone].filter(Boolean) as string[];
  const needsConfirm = plans.filter(
    (p) =>
      p.claimed > 0 &&
      (p.action === "cancel" || timeFields.some((f) => Object.hasOwn(p.values, f))),
  );
  if (needsConfirm.length && confirm !== needsConfirm.length) {
    throw new ConflictError(
      `${needsConfirm.length} of this ${object.label.toLowerCase()}'s ${generated.plural?.toLowerCase() ?? "records"} have places taken and would be moved or cancelled. Confirm with that count (recurring.change) to go ahead.`,
      {
        rule: "recurring_confirm",
        count: needsConfirm.length,
        records: needsConfirm.map((p) => ({ id: p.id, date: p.date, action: p.action })),
      },
    );
  }
  for (const plan of plans) {
    if (plan.action === "update") {
      await records().update(ctx, generated, plan.id, plan.values, { by: "host" });
    } else if (plan.action === "cancel" && stateField) {
      await records().update(ctx, generated, plan.id, { [stateField]: def.cancel }, { by: "host" });
    } else {
      // Removed, and its date's key with it: the date can be made again if the rule returns to it.
      await records().remove(ctx, generated, plan.id);
      ctx.write(
        ctx.db
          .deleteFrom("core_recurrence_occurrence")
          .where("object_type", "=", generated.name)
          .where("record_id", "=", plan.id),
      );
    }
  }
}

/** Places held and taken on a record (0 when its object has no capacity). */
async function claimedOn(ctx: HandlerContext, object: ObjectDefinition, id: string) {
  if (!object.capacity) return 0;
  const row = await ctx.db
    .selectFrom("core_capacity")
    .select(["held", "taken"])
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .executeTakeFirst();
  return row ? row.held + row.taken : 0;
}

/**
 * A closure written (ADR 0500): the future records it covers, of every object a series with this
 * closure object generates, are cancelled as the host (one-off records too). A closure's dates
 * are local dates, from and until inclusive, each record's in its own zone (`into.zone`; the
 * organisation's when it has none). Shortening or deleting a
 * closure cancels nothing more and brings nothing back: the dates it no longer covers are made by
 * the next run, if they were never made.
 */
export async function closureWritten(
  ctx: HandlerContext,
  object: ObjectDefinition,
  after: Record<string, unknown>,
): Promise<void> {
  const defs = closuresOf(object.name);
  if (!defs.length) return;
  const { timezone } = await loadGeneralSettings(ctx.db);
  const seen = new Set<string>();
  for (const def of defs) {
    const closure = def.closures;
    if (!closure || seen.has(def.generates)) continue;
    seen.add(def.generates);
    const from = text(after[closure.from]);
    const until = text(after[closure.until]);
    if (!from || !until || !parseLocalDate(from) || !parseLocalDate(until) || until < from)
      continue;
    const generated = generatedOf(def);
    const startsCol = generated.fields.find((f) => f.name === def.into.starts)?.column;
    const stateField = generated.states?.field;
    const stateCol = generated.fields.find((f) => f.name === stateField)?.column;
    if (!startsCol || !stateField || !stateCol) continue;
    const zoneCol = def.into.zone
      ? generated.fields.find((f) => f.name === def.into.zone)?.column
      : undefined;
    // Only from states the host may move into the cancel state (a final state is left alone).
    const movable = [
      ...new Set(
        (generated.states?.moves ?? [])
          .filter((m) => m.to === def.cancel && m.by.includes("host"))
          .flatMap((m) => (typeof m.from === "string" ? [m.from] : [...m.from])),
      ),
    ];
    if (!movable.length) continue;
    // A record's local date is in its own zone; the text range is two days wider either side to
    // cover every offset, and each record's date is then worked out exactly.
    const now = Date.parse(ctx.now);
    const rows = (await (ctx.db as AnyDb)
      .selectFrom(visibleSource(ctx, generated))
      .select(["id", `${startsCol} as starts`, ...(zoneCol ? [`${zoneCol} as zone`] : [])])
      .where(startsCol, ">=", addDays(from, -2))
      .where(startsCol, "<", addDays(until, 3))
      .where(stateCol, "in", movable)
      .execute()) as { id: string; starts: string | null; zone?: string | null }[];
    for (const row of rows) {
      const starts = Date.parse(row.starts ?? "");
      if (!(starts > now)) continue;
      const date = localParts(starts, row.zone || timezone).date;
      if (date < from || date > until) continue;
      await records().update(ctx, generated, row.id, { [stateField]: def.cancel }, { by: "host" });
    }
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
