// The allowance behaviour inside the record operations (stage 32b, ADRs 0493 and 0494).
// record.create, record.update, record.delete, record.restore and the record CSV import call it,
// so the rule holds for every actor: people, MCP clients, the assistant, automations, extensions,
// imports, approved actions and a customer at the seam.
//
// - A holder's write keeps its terms (core_allowance) in the same batch.
// - A spender's move into a spend state spends a use; its move into a return state gives it back;
//   any other move keeps it. Who can cause either is whoever the spender's `states` lets make that
//   move: an extension cannot hook a write, and no operation spends or returns on its own.
// - Reads here are for choosing a holder and saying why one cannot pay. The count is never read
//   to decide a spend: the statements in allowance/index.ts are refused by the database.
//
// In the approval queue's dry run (writes discarded) a spend is judged against the counters as
// they are, plus what the same call has already spent or given back, and refused as the database
// would refuse it; the approved action spends when it runs and may be refused then.
import { CompiledQuery } from "kysely";
import {
  type AllowanceRefusalDetails,
  type AllowanceRefusalReason,
  allowanceMessage,
  NotFoundError,
  ValidationError,
} from "../errors.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { AllowanceDefinition, ObjectDefinition } from "../fields/types.ts";
import { localParts } from "../local-time.ts";
import type { HandlerContext, RecordRef } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import type { Mover, TransitionOutcome } from "../records/transitions.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  type AllowanceTerms,
  returnStatements,
  spendStatements,
  termsIfMissing,
  termsStatements,
  trashStatement,
} from "./index.ts";
import { type AllowancePer, type AllowancePeriod, boundOf, periodOf } from "./periods.ts";

type HolderDefinition = Extract<AllowanceDefinition, { kind: "holder" }>;
type SpenderDefinition = Extract<AllowanceDefinition, { kind: "spender" }>;
type Values = Record<string, unknown>;

const PERIODS: readonly AllowancePer[] = ["total", "week", "month"];

export function holderOf(object: ObjectDefinition): HolderDefinition | undefined {
  return object.allowance?.kind === "holder" ? object.allowance : undefined;
}

export function spenderOf(object: ObjectDefinition): SpenderDefinition | undefined {
  return object.allowance?.kind === "spender" ? object.allowance : undefined;
}

// --- The record code a moved spender's write runs through ----------------------------------------

type RecordUpdate = (
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
  options: { by?: Mover },
) => Promise<boolean>;
let recordUpdate: RecordUpdate | null = null;

/** Set by operations/record.ts when it loads (this module cannot import it: it imports this). */
export function setAllowanceRecordUpdate(update: RecordUpdate): void {
  recordUpdate = update;
}

// --- Reading records as the host -----------------------------------------------------------------

function fieldValue(object: ObjectDefinition, row: Values | undefined, name: string): unknown {
  const field = object.fields.find((f) => f.name === name);
  const column = field ? viewColumnOf(field) : null;
  if (!field || !column || !row) return null;
  const raw = row[column] ?? null;
  if (field.fieldType === "formula") return formulaFromStorage(field.options?.resultType, raw);
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY | undefined;
  return type && FIELD_TYPE_REGISTRY[type] ? FIELD_TYPE_REGISTRY[type].fromStorage(raw) : raw;
}

function rowValues(object: ObjectDefinition, row: Values): Values {
  return Object.fromEntries(object.fields.map((f) => [f.name, fieldValue(object, row, f.name)]));
}

/** A record's values, read org-wide from its object's view (live records only). */
async function readValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<Values | undefined> {
  const { rows } = await ctx.db.executeQuery<Values>(
    CompiledQuery.raw(`SELECT * FROM ${object.source} WHERE id = ?`, [id]),
  );
  return rows[0] ? rowValues(object, rows[0]) : undefined;
}

/** The organisation's zone, read once per call. */
const zones = new WeakMap<object, Promise<string>>();
function orgZone(ctx: HandlerContext): Promise<string> {
  let zone = zones.get(ctx);
  if (!zone) {
    zone = loadGeneralSettings(ctx.db).then((s) => s.timezone || "UTC");
    zones.set(ctx, zone);
  }
  return zone;
}

const present = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

const iso = (value: unknown): string | null => {
  if (!present(value)) return null;
  const at = new Date(String(value));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

// --- Holders: their terms ------------------------------------------------------------------------

/** A holder's terms from its record's values (ADR 0493). Refuses uses that are not a count. */
export async function holderTerms(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Values,
): Promise<AllowanceTerms> {
  const def = holderOf(object) as HolderDefinition;
  const zoneValue = def.zone ? values[def.zone] : null;
  const zone = typeof zoneValue === "string" && zoneValue ? zoneValue : await orgZone(ctx);
  const rawUses = values[def.uses];
  let uses: number | null = null;
  if (present(rawUses)) {
    if (typeof rawUses !== "number" || !Number.isInteger(rawUses) || rawUses < 0) {
      throw new ValidationError(
        `${object.label}: uses must be a whole number from 0, or empty for unlimited`,
        { rule: "allowance", field: def.uses },
      );
    }
    uses = rawUses;
  }
  const perValue = "fixed" in def.per ? def.per.fixed : values[def.per.field];
  const per = PERIODS.includes(perValue as AllowancePer) ? (perValue as AllowancePer) : "total";
  const typeOf = (name: string | undefined) =>
    name ? object.fields.find((f) => f.name === name)?.fieldType : undefined;
  const state = object.states ? values[object.states.field] : null;
  const person = values[def.person];
  return {
    object: object.name,
    record: id,
    personId: typeof person === "string" && person ? person : null,
    uses,
    per,
    zone,
    validFrom: def.from ? boundOf(values[def.from], "from", typeOf(def.from), zone) : null,
    validUntil: def.until ? boundOf(values[def.until], "until", typeOf(def.until), zone) : null,
    live: def.live === null ? true : def.live.includes(String(state ?? "")),
  };
}

/**
 * The statements that keep a holder's terms in step with its record, or none when the write
 * touches none of its terms. `after` is the record as the write leaves it.
 */
export async function holderWrite(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  after: Values,
  changed: readonly string[] | "create",
): Promise<CompiledQuery[]> {
  const def = holderOf(object);
  if (!def) return [];
  const terms = [
    def.person,
    def.uses,
    "field" in def.per ? def.per.field : undefined,
    def.from,
    def.until,
    def.zone,
    object.states?.field,
  ].filter((f): f is string => f !== undefined);
  if (changed !== "create" && !terms.some((f) => changed.includes(f))) return [];
  return termsStatements(await holderTerms(ctx, object, id, after), ctx.now);
}

/** The statements for a holder moving into or out of the Trash; none for other objects. */
export function holderTrash(
  object: ObjectDefinition,
  id: string,
  trashed: boolean,
  now: string,
): CompiledQuery[] {
  return holderOf(object) ? [trashStatement({ object: object.name, id }, trashed, now)] : [];
}

// --- Spenders ------------------------------------------------------------------------------------

/** A spender's open use: the holder and period it counts in. */
interface OpenUse {
  id: string;
  object: string;
  record: string;
  period: string;
}

async function openUse(ctx: HandlerContext, spender: RecordRef): Promise<OpenUse | null> {
  const row = await ctx.db
    .selectFrom("core_allowance_use")
    .select(["id", "object_type", "record_id", "period"])
    .where("spender_type", "=", spender.object)
    .where("spender_id", "=", spender.id)
    .where("returned_at", "is", null)
    .executeTakeFirst();
  return row
    ? { id: row.id, object: row.object_type, record: row.record_id, period: row.period }
    : null;
}

/**
 * Refuses moving a spender that holds a use to the Trash: give it back first (move it to a return
 * state), so a use is never lost with a record that can come back.
 */
export async function assertSpenderDeletable(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  if (!spenderOf(object)) return;
  if (await openUse(ctx, { object: object.name, id })) {
    throw new ValidationError(
      `${object.label} holds a use of an allowance: move it to a state that gives the use back before deleting it`,
      { rule: "allowance", object: object.name, record: id },
    );
  }
}

/** Uses this call has queued (or, in a dry run, simulated) per holder and period, not yet applied. */
const pending = new WeakMap<object, Map<string, number>>();
const pendingKey = (object: string, record: string, period: string) =>
  `${object}|${record}|${period}`;
function addPending(ctx: HandlerContext, key: string, n: number) {
  const map = pending.get(ctx) ?? new Map<string, number>();
  pending.set(ctx, map);
  map.set(key, (map.get(key) ?? 0) + n);
}
const pendingOf = (ctx: HandlerContext, key: string) => pending.get(ctx)?.get(key) ?? 0;

function refusal(details: AllowanceRefusalDetails): ValidationError {
  return new ValidationError(allowanceMessage(details), { ...details });
}

/** A holder that could pay for a spender, as read for choosing. */
interface Candidate {
  object: ObjectDefinition;
  def: HolderDefinition;
  id: string;
  values: Values;
  terms: AllowanceTerms;
}

/** The Person's holders whose object spends on `spender` (any state: the reasons are wanted). */
async function holdersOf(
  ctx: HandlerContext,
  spender: ObjectDefinition,
  personId: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const object of listObjects()) {
    const def = holderOf(object);
    if (!def || !def.spendsOn.some((s) => s.object === spender.name)) continue;
    const personField = object.fields.find((f) => f.name === def.person);
    const column = personField ? viewColumnOf(personField) : null;
    if (!column) continue;
    const { rows } = await ctx.db.executeQuery<Values>(
      CompiledQuery.raw(`SELECT * FROM ${object.source} WHERE ${column} = ? ORDER BY id`, [
        personId,
      ]),
    );
    for (const row of rows) {
      const values = rowValues(object, row);
      const id = String(row.id);
      out.push({ object, def, id, values, terms: await holderTerms(ctx, object, id, values) });
    }
  }
  return out;
}

/** Whether a spender's value meets one condition, given the holder's values. */
function meets(
  clause: HolderDefinition["spendsOn"][number]["when"][number],
  spender: Values,
  holder: Values,
): boolean {
  const value = spender[clause.field];
  if (clause.in !== undefined) {
    const limit = typeof clause.in === "string" ? holder[clause.in] : clause.in;
    if (!present(limit)) return true;
    const allowed = (Array.isArray(limit) ? limit : [limit]).map(String);
    const given = Array.isArray(value) ? value.map(String) : present(value) ? [String(value)] : [];
    return given.some((v) => allowed.includes(v));
  }
  for (const [bound, test] of [
    ["atLeast", (v: number, b: number) => v >= b],
    ["below", (v: number, b: number) => v < b],
  ] as const) {
    const raw = clause[bound];
    if (raw === undefined) continue;
    const limit = typeof raw === "string" ? holder[raw] : raw;
    if (!present(limit)) return true;
    if (!present(value)) return false;
    return test(Number(value), Number(limit));
  }
  return true;
}

/** Why a holder cannot pay for this spender at `at`, or null when it can (uses aside). */
function cannotPay(
  candidate: Candidate,
  spender: ObjectDefinition,
  values: Values,
  at: string,
): AllowanceRefusalReason | null {
  const { terms } = candidate;
  if (!terms.live) return "not_live";
  if (terms.validFrom && at < terms.validFrom) return "not_yet_valid";
  if (terms.validUntil && at >= terms.validUntil) return "ended";
  const covers = candidate.def.spendsOn
    .filter((s) => s.object === spender.name)
    .some((s) => s.when.every((clause) => meets(clause, values, candidate.values)));
  return covers ? null : "not_covered";
}

/** Uses spent in a holder's period, as stored plus what this call has queued. */
async function usedIn(ctx: HandlerContext, holder: RecordRef, period: string): Promise<number> {
  const row = await ctx.db
    .selectFrom("core_allowance_period")
    .select("used")
    .where("object_type", "=", holder.object)
    .where("record_id", "=", holder.id)
    .where("period", "=", period)
    .executeTakeFirst();
  return (row?.used ?? 0) + pendingOf(ctx, pendingKey(holder.object, holder.id, period));
}

const END = "9999-12-31T23:59:59.999Z";

/**
 * The order holders are spent in, when the host chooses (ADR 0494): an unlimited one first (it
 * costs nothing); then the one whose use would lapse first, the end of its period for a week or a
 * month, its `until` for a total; then by object and id, so the choice is always the same.
 */
function precedence(a: Candidate & { lapse: string }, b: Candidate & { lapse: string }) {
  const unlimited = Number(b.terms.uses === null) - Number(a.terms.uses === null);
  if (unlimited !== 0) return unlimited;
  if (a.lapse !== b.lapse) return a.lapse < b.lapse ? -1 : 1;
  if (a.object.name !== b.object.name) return a.object.name < b.object.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lapseOf(candidate: Candidate, period: AllowancePeriod): string {
  const until = candidate.terms.validUntil ?? END;
  if (candidate.terms.per === "total") return until;
  return period.endsAt < until ? period.endsAt : until;
}

/** What the host fills on a spender, its time, and the values conditions read. */
interface SpenderRead {
  values: Values;
  at: string;
}

async function readSpender(
  ctx: HandlerContext,
  object: ObjectDefinition,
  def: SpenderDefinition,
  after: Values,
  options: { fillCopies: boolean; needAt: boolean },
): Promise<SpenderRead> {
  const filled: Values = {};
  const related = new Map<string, Values | undefined>();
  const through = async (path: string, from: Values): Promise<unknown> => {
    const [rel, target] = path.split(".");
    if (!rel || !target) return from[path];
    const id = from[rel];
    if (typeof id !== "string" || !id) return null;
    if (!related.has(rel)) {
      const field = object.fields.find((f) => f.name === rel);
      const to = field?.options?.to ? getObject(field.options.to) : undefined;
      related.set(rel, to ? await readValues(ctx, to, id) : undefined);
    }
    return related.get(rel)?.[target] ?? null;
  };
  if (options.fillCopies) {
    for (const [target, source] of Object.entries(def.copy)) {
      filled[target] = (await through(source, after)) ?? null;
    }
  }
  const merged = { ...after, ...filled };
  let at = ctx.now;
  if (def.at && (options.needAt || options.fillCopies)) {
    const value = def.at.includes(".") ? await through(def.at, merged) : merged[def.at];
    const instant = iso(value);
    if (!instant && options.needAt) {
      throw new ValidationError(
        `${object.label} needs its time (${def.at}) before it can spend a use`,
        { rule: "allowance", field: def.at.split(".")[0] },
      );
    }
    if (instant) at = instant;
  }
  if (options.fillCopies && (def.local.weekday || def.local.minute) && (def.at || options.needAt)) {
    const zoneValue = def.local.zone
      ? def.local.zone.includes(".")
        ? await through(def.local.zone, merged)
        : merged[def.local.zone]
      : null;
    const zone = typeof zoneValue === "string" && zoneValue ? zoneValue : await orgZone(ctx);
    const local = localParts(at, zone);
    if (def.local.weekday) filled[def.local.weekday] = local.weekday;
    if (def.local.minute) filled[def.local.minute] = local.minuteOfDay;
  }
  return { values: filled, at };
}

/** What a spender's write adds: values the host sets on it, and statements for its batch. */
export interface SpenderOutcome {
  values: Values;
  statements: CompiledQuery[];
}

const NOTHING: SpenderOutcome = Object.freeze({ values: {}, statements: [] }) as SpenderOutcome;

/**
 * The allowance's part of a spender's write (ADR 0493): call it after the lifecycle has judged
 * the move, with the record's values before (null on create), the values written and the
 * lifecycle's outcome. Queue the statements after the record's own write.
 */
export async function spenderWrite(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Values | null,
  written: Values,
  outcome: TransitionOutcome,
  by: Mover,
): Promise<SpenderOutcome> {
  const def = spenderOf(object);
  if (!def || !object.states) return NOTHING;
  const ref = { object: object.name, id };
  const after: Values = { ...(before ?? {}), ...written, ...outcome.values };
  const to = outcome.moved?.id;
  const entering = to !== undefined && def.spendIn.includes(to);
  const returning = to !== undefined && def.returnIn.includes(to);
  const reads = [def.at, def.local.zone, ...Object.values(def.copy)]
    .filter((p): p is string => typeof p === "string" && p.includes("."))
    .map((p) => p.split(".")[0] as string);
  const relationChanged = reads.some(
    (rel) => Object.hasOwn(written, rel) && String(written[rel] ?? "") !== String(before?.[rel] ?? ""),
  );
  const fillCopies = before === null || entering || relationChanged;
  const open = before === null ? null : await openUse(ctx, ref);
  const holderWritten =
    Object.hasOwn(written, def.holder) &&
    String(written[def.holder] ?? "") !== String(before?.[def.holder] ?? "");
  if (holderWritten && open && !returning) {
    throw new ValidationError(
      `${object.label} has spent a use of ${String(before?.[def.holder])}: give it back before naming another`,
      { rule: "allowance", field: def.holder },
    );
  }
  const spending = entering && !open;
  const read = fillCopies
    ? await readSpender(ctx, object, def, after, { fillCopies, needAt: spending })
    : { values: {}, at: ctx.now };
  const values: Values = { ...read.values };
  const statements: CompiledQuery[] = [];

  if (returning && open) {
    statements.push(...returnStatements(ref, by, ctx.now));
    addPending(ctx, pendingKey(open.object, open.record, open.period), -1);
  }
  if (!spending) return { values, statements };

  const spenderValues = { ...after, ...values };
  const person = spenderValues[def.person];
  if (typeof person !== "string" || !person) {
    throw new ValidationError(`${object.label} needs a person before it can spend a use`, {
      rule: "allowance",
      reason: "no_holder",
      field: def.person,
    });
  }

  // A record moved from another (ADR 0493): that record is moved in this batch, giving its use
  // back, and this one spends from the same holder.
  let movedFrom: OpenUse | null = null;
  const fromId = def.movedFrom && before === null ? after[def.movedFrom.field] : null;
  if (def.movedFrom && typeof fromId === "string" && fromId) {
    if (by === "customer") {
      throw new ValidationError(
        `Only staff move a ${object.label.toLowerCase()} to another; cancel it and make a new one`,
        { rule: "allowance", field: def.movedFrom.field },
      );
    }
    const source = await readValues(ctx, object, fromId);
    if (!source) throw new NotFoundError(object.name, fromId);
    if (source[def.person] !== person) {
      throw new ValidationError(`A ${object.label.toLowerCase()} moves to the same person`, {
        rule: "allowance",
        field: def.movedFrom.field,
      });
    }
    movedFrom = await openUse(ctx, { object: object.name, id: fromId });
    if (!recordUpdate) throw new Error("allowance: the record writer is not set");
    await recordUpdate(
      ctx,
      object,
      fromId,
      { [object.states.field]: def.movedFrom.state },
      { by },
    );
  }

  const named = holderWritten
    ? String(written[def.holder])
    : movedFrom
      ? movedFrom.record
      : null;
  const candidates = await holdersOf(ctx, object, person);
  const at = read.at;
  let chosen: Candidate;
  let period: AllowancePeriod;
  if (named) {
    const candidate = candidates.find((c) => c.id === named);
    if (!candidate) {
      const anyone = listObjects().some((o) => holderOf(o)?.spendsOn.some((s) => s.object === object.name));
      throw refusal({ rule: "allowance", reason: anyone ? "not_theirs" : "no_holder" });
    }
    const reason = cannotPay(candidate, object, spenderValues, at);
    if (reason) {
      throw refusal({ rule: "allowance", reason, object: candidate.object.name, record: named });
    }
    chosen = candidate;
    period = periodOf(at, candidate.terms.per, candidate.terms.zone);
  } else {
    const payable = candidates
      .map((c) => ({ c, reason: cannotPay(c, object, spenderValues, at) }))
      .map(({ c, reason }) => {
        const p = periodOf(at, c.terms.per, c.terms.zone);
        return { ...c, period: p, lapse: lapseOf(c, p), reason };
      })
      .sort(precedence);
    const covering = payable.filter((c) => c.reason === null);
    if (!covering.length) {
      const first = payable[0];
      throw refusal(
        first?.reason
          ? { rule: "allowance", reason: first.reason, object: first.object.name, record: first.id }
          : { rule: "allowance", reason: "no_holder" },
      );
    }
    let pick: (typeof covering)[number] | undefined;
    for (const c of covering) {
      if (c.terms.uses === null) {
        pick = c;
        break;
      }
      const used = await usedIn(ctx, { object: c.object.name, id: c.id }, c.period.key);
      if (used < c.terms.uses) {
        pick = c;
        break;
      }
    }
    // All full: the first is spent and refused by the database (or by the dry run below), with
    // its numbers.
    pick ??= covering[0] as (typeof covering)[number];
    chosen = pick;
    period = pick.period;
  }

  const holder = { object: chosen.object.name, id: chosen.id };
  if (ctx.simulation) {
    // The dry run writes nothing, so say now what the database would refuse.
    const used = await usedIn(ctx, holder, period.key);
    if (chosen.terms.uses !== null && used + 1 > chosen.terms.uses) {
      throw refusal({
        rule: "allowance",
        reason: "no_uses_left",
        object: holder.object,
        record: holder.id,
        period: period.key,
        uses: chosen.terms.uses,
        used,
      });
    }
  }
  addPending(ctx, pendingKey(holder.object, holder.id, period.key), 1);
  // A holder written before its object declared the behaviour has no terms yet.
  statements.push(termsIfMissing(chosen.terms, ctx.now));
  statements.push(
    ...spendStatements(
      {
        holder,
        period,
        spender: ref,
        personId: person,
        at,
        by,
        movedFrom: movedFrom?.id ?? null,
      },
      ctx.now,
    ).statements,
  );
  values[def.holder] = chosen.id;
  return { values, statements };
}
