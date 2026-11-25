// The allowance behaviour inside the record operations (stage 32b, ADRs 0493 and 0494).
// record.create, record.update, record.delete, record.restore and the record CSV import call it,
// so the rule holds for every actor: people, MCP clients, the assistant, automations, extensions,
// imports, approved actions and a customer at the seam.
//
// - A holder's write re-derives its terms (core_allowance) from the stored record in its batch.
// - A spender's move into a spend state spends a use; its move into a return state gives it back;
//   any other move keeps it. A change to what its time or copied values come from, while it holds
//   a use, gives the use back and spends again for the new target in the same batch, and so does a
//   change to the record it points at (a class rescheduled). Who can cause any of it is whoever the
//   write is allowed to: an extension cannot hook a write, and no operation spends on its own.
// - Reads here are for choosing a holder, refusing a spend the host can see will not fit, and
//   saying why. The database still refuses past the limit (allowance/index.ts): a spend that the
//   host read as fitting and the database refused raced another, and is answered as a conflict.
//
// In the approval queue's dry run (writes discarded) a spend is judged exactly as a real one is,
// against the counters as they are plus what the same call has already spent or given back.
import { CompiledQuery } from "kysely";
import {
  type AllowanceRefusalDetails,
  type AllowanceRefusalReason,
  allowanceMessage,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors.ts";
import { fieldStorage, objectTableOf } from "../extensions/schema.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { AllowanceDefinition, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext, RecordRef } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import type { Mover, TransitionOutcome } from "../records/transitions.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts } from "../time/local.ts";
import {
  type HolderStorage,
  keyingChangeStatement,
  rekeyStatements,
  returnStatements,
  spendStatements,
  termsSyncStatements,
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

/** Whether a spender of extension `extension` lets `holderObject` pay for it (ADR 0494). */
export function paysFor(spender: ObjectDefinition, holderObject: string): boolean {
  const def = spenderOf(spender);
  if (!def) return false;
  const ext = spender.name.split(".")[0];
  const holderExt = holderObject.split(".")[0];
  return holderExt === ext || def.paidBy.some((p) => p === holderObject || p === holderExt);
}

/** The holder objects that may pay for `spender`: they spend on it and it lets them. */
export function payingObjects(spender: ObjectDefinition): ObjectDefinition[] {
  return listObjects().filter(
    (o) => holderOf(o)?.spendsOn.some((s) => s.object === spender.name) && paysFor(spender, o.name),
  );
}

/** The spender's fields only the host fills: what conditions read (ADR 0493). */
export function hostFilled(object: ObjectDefinition): Set<string> {
  const def = spenderOf(object);
  if (!def) return new Set();
  return new Set(
    [...Object.keys(def.copy), def.local.weekday, def.local.minute].filter(
      (f): f is string => typeof f === "string",
    ),
  );
}

// --- The record code a moved spender's write runs through ----------------------------------------

type RecordUpdate = (
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
  options: { by?: Mover; movedInto?: string },
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

/** Where a holder object's term fields are stored, for deriving its terms in SQL. */
export function holderStorage(object: ObjectDefinition): HolderStorage {
  const def = holderOf(object) as HolderDefinition;
  const table = objectTableOf(object.name);
  const column = (name: string) => {
    const storage = fieldStorage(object.name, name);
    if (!storage?.column || !storage.own) {
      throw new Error(`allowance: ${object.name}.${name} has no column of its own`);
    }
    return storage.column;
  };
  if (!table) throw new Error(`allowance: ${object.name} has no table`);
  const bound = (name: string | undefined) =>
    name
      ? {
          column: column(name),
          date: object.fields.find((f) => f.name === name)?.fieldType === "date",
        }
      : undefined;
  return {
    object: object.name,
    table,
    person: column(def.person),
    uses: column(def.uses),
    per: "fixed" in def.per ? { fixed: def.per.fixed } : { column: column(def.per.field) },
    from: bound(def.from),
    until: bound(def.until),
    zone: def.zone ? column(def.zone) : undefined,
    live:
      def.live && object.states
        ? { column: column(object.states.field), states: def.live }
        : undefined,
    emptyIsUnlimited: def.emptyIsUnlimited,
  };
}

/** A holder's terms as the database keeps them. */
export interface StoredTerms {
  object: string;
  record: string;
  personId: string | null;
  uses: number | null;
  per: AllowancePer;
  zone: string;
  validFrom: string | null;
  validUntil: string | null;
  fromDate: string | null;
  untilDate: string | null;
  live: boolean;
  trashed: boolean;
  prevPer: AllowancePer | null;
  prevZone: string | null;
  appliesFrom: string | null;
}

type TermsRow = {
  object_type: string;
  record_id: string;
  person_id: string | null;
  uses: number | null;
  per: AllowancePer;
  zone: string;
  valid_from: string | null;
  valid_until: string | null;
  from_date: string | null;
  until_date: string | null;
  live: number;
  trashed: number;
  prev_per: AllowancePer | null;
  prev_zone: string | null;
  applies_from: string | null;
};

function fromTermsRow(row: TermsRow): StoredTerms {
  return {
    object: row.object_type,
    record: row.record_id,
    personId: row.person_id,
    uses: row.uses,
    per: row.per,
    zone: row.zone,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    fromDate: row.from_date,
    untilDate: row.until_date,
    live: row.live === 1,
    trashed: row.trashed === 1,
    prevPer: row.prev_per,
    prevZone: row.prev_zone,
    appliesFrom: row.applies_from,
  };
}

export async function storedTerms(
  ctx: HandlerContext,
  holder: RecordRef,
): Promise<StoredTerms | null> {
  const row = await ctx.db
    .selectFrom("core_allowance")
    .selectAll()
    .where("object_type", "=", holder.object)
    .where("record_id", "=", holder.id)
    .executeTakeFirst();
  return row ? fromTermsRow(row as TermsRow) : null;
}

/** How a spend at `at` is counted: the old period and zone before a change applies. */
export function keyingAt(terms: StoredTerms, at: string): { per: AllowancePer; zone: string } {
  if (terms.appliesFrom && at < terms.appliesFrom && terms.prevPer && terms.prevZone) {
    return { per: terms.prevPer, zone: terms.prevZone };
  }
  return { per: terms.per, zone: terms.zone };
}

/**
 * The statements that keep a holder's terms: derived in SQL from the record as the batch leaves
 * it. A change of its period or zone applies from the end of the period running now (ADR 0494):
 * that is recorded, and uses already spent for times from then are moved to their new periods.
 * Refuses uses that are not a count. `before` is null on create.
 */
export async function holderWrite(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Values | null,
  after: Values,
): Promise<CompiledQuery[]> {
  const def = holderOf(object);
  if (!def) return [];
  const rawUses = after[def.uses];
  if (present(rawUses)) {
    if (typeof rawUses !== "number" || !Number.isInteger(rawUses) || rawUses < 0) {
      throw new ValidationError(
        `${object.label}: uses must be a whole number from 0${def.emptyIsUnlimited ? ", or empty for unlimited" : ""}`,
        { rule: "allowance", field: def.uses },
      );
    }
  }
  const zone = await orgZone(ctx);
  const statements = termsSyncStatements(holderStorage(object), { id }, zone, ctx.now);
  if (before === null) return statements;
  const stored = await storedTerms(ctx, { object: object.name, id });
  if (!stored) return statements;
  const per =
    "fixed" in def.per
      ? def.per.fixed
      : PERIODS.includes(after[def.per.field] as AllowancePer)
        ? (after[def.per.field] as AllowancePer)
        : "total";
  const ownZone = def.zone ? after[def.zone] : null;
  const nextZone = typeof ownZone === "string" && ownZone ? ownZone : stored.zone;
  if (per === stored.per && nextZone === stored.zone) return statements;
  // The keying in force now; a change already waiting keeps its own start.
  const current = keyingAt(stored, ctx.now);
  const appliesFrom =
    stored.appliesFrom && stored.appliesFrom > ctx.now
      ? stored.appliesFrom
      : current.per === "total"
        ? ctx.now
        : periodOf(ctx.now, current.per, current.zone).endsAt;
  const holder = { object: object.name, id };
  statements.push(keyingChangeStatement(holder, current, appliesFrom, ctx.now));
  const open = await ctx.db
    .selectFrom("core_allowance_use")
    .select(["id", "period", "zone", "at"])
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .where("returned_at", "is", null)
    .where("at", ">=", appliesFrom)
    .execute();
  for (const use of open) {
    const to = periodOf(use.at, per, nextZone);
    if (to.key === use.period && nextZone === use.zone) continue;
    statements.push(
      ...rekeyStatements(
        { id: use.id, holder, period: use.period, zone: use.zone },
        { period: to, zone: nextZone },
        ctx.now,
      ),
    );
  }
  return statements;
}

/**
 * A holder's terms (ADR 0513): the fields that say whose uses they are, how many, over what,
 * between which dates and in which zone, and the holder fields its conditions compare with. Only
 * the host writes them, or the holder's own extension through a tool only a person with a
 * permission may call (`personsTool`), never any other code of the extension.
 */
export function holderTerms(object: ObjectDefinition): ReadonlySet<string> {
  const def = holderOf(object);
  if (!def) return new Set();
  const out = new Set<string>([def.person, def.uses]);
  if ("field" in def.per) out.add(def.per.field);
  for (const f of [def.from, def.until, def.zone]) if (f) out.add(f);
  for (const target of def.spendsOn) {
    for (const clause of target.when) {
      for (const v of [clause.in, clause.atLeast, clause.below]) {
        if (typeof v === "string") out.add(v);
      }
    }
  }
  return out;
}

/**
 * Refuses a customer creating a holder (ADR 0494): passes and memberships are granted by the host
 * (a paid order, a subscription) or made by staff, never by a customer, whatever a tool allows.
 */
export function assertHolderCreatable(object: ObjectDefinition, by: Mover): void {
  if (holderOf(object) && by === "customer") {
    throw new ForbiddenError(`A customer cannot create a ${object.label.toLowerCase()}`);
  }
}

/** The statements for a holder moving into or out of the Trash: its terms follow the record. */
export async function holderTrash(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<CompiledQuery[]> {
  if (!holderOf(object)) return [];
  return termsSyncStatements(holderStorage(object), { id }, await orgZone(ctx), ctx.now);
}

// --- Spenders ------------------------------------------------------------------------------------

/** A spender's open use: the holder, period and zone it counts in. */
interface OpenUse {
  id: string;
  object: string;
  record: string;
  period: string;
  zone: string;
}

async function openUse(ctx: HandlerContext, spender: RecordRef): Promise<OpenUse | null> {
  const row = await ctx.db
    .selectFrom("core_allowance_use")
    .select(["id", "object_type", "record_id", "period", "zone"])
    .where("spender_type", "=", spender.object)
    .where("spender_id", "=", spender.id)
    .where("returned_at", "is", null)
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        object: row.object_type,
        record: row.record_id,
        period: row.period,
        zone: row.zone,
      }
    : null;
}

/**
 * Refuses moving a spender that holds a use to the Trash: give it back first (move it to a return
 * state), so a use is never lost with a record that can come back. A spender whose object declares
 * no return state can always go: its use is kept, as every use of it is (attendance).
 */
export async function assertSpenderDeletable(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  const def = spenderOf(object);
  if (!def || !def.returnIn.length) return;
  if (await openUse(ctx, { object: object.name, id })) {
    throw new ValidationError(
      `${object.label} holds a use of an allowance: move it to a state that gives the use back before deleting it`,
      { rule: "allowance", object: object.name, record: id },
    );
  }
}

/** Uses this call has queued (or, in a dry run, simulated) per counter, not yet applied. */
const pending = new WeakMap<object, Map<string, number>>();
const pendingKey = (object: string, record: string, period: string, zone: string) =>
  `${object}|${record}|${period}|${zone}`;
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
  terms: StoredTerms;
}

/**
 * The Person's holders that may pay for `spender`: one indexed query of their terms (by Person
 * and object), then each holder's record by id for its conditions. Any state: the reasons are
 * wanted.
 */
async function holdersOf(
  ctx: HandlerContext,
  spender: ObjectDefinition,
  personId: string,
): Promise<Candidate[]> {
  const objects = payingObjects(spender);
  if (!objects.length) return [];
  const rows = (await ctx.db
    .selectFrom("core_allowance")
    .selectAll()
    .where("person_id", "=", personId)
    .where(
      "object_type",
      "in",
      objects.map((o) => o.name),
    )
    .orderBy("object_type")
    .orderBy("record_id")
    .limit(200)
    .execute()) as TermsRow[];
  const out: Candidate[] = [];
  for (const row of rows) {
    const object = objects.find((o) => o.name === row.object_type) as ObjectDefinition;
    const values = row.trashed ? {} : await readValues(ctx, object, row.record_id);
    if (!values) continue;
    out.push({
      object,
      def: holderOf(object) as HolderDefinition,
      id: row.record_id,
      values,
      terms: fromTermsRow(row),
    });
  }
  return out;
}

/** Whether a spender's value meets one condition, given the holder's values. */
function meets(
  clause: HolderDefinition["spendsOn"][number]["when"][number],
  spender: Values,
  holder: Values,
): boolean {
  // A fixed word is what every record of the spender is (ADR 0764): "sessions", never a class.
  const value = clause.field === undefined ? (clause.value ?? null) : spender[clause.field];
  if (clause.in !== undefined) {
    const limit = typeof clause.in === "string" ? holder[clause.in] : clause.in;
    // Empty allows anything, unless the declaration says it allows nothing (ADR 0764).
    if (!present(limit)) return clause.empty !== "none";
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
  if (!terms.live || terms.trashed) return "not_live";
  const atDate = localParts(at, terms.zone).date;
  if ((terms.validFrom && at < terms.validFrom) || (terms.fromDate && atDate < terms.fromDate)) {
    return "not_yet_valid";
  }
  if (
    (terms.validUntil && at >= terms.validUntil) ||
    (terms.untilDate && atDate > terms.untilDate)
  ) {
    return "ended";
  }
  const covers = candidate.def.spendsOn
    .filter((s) => s.object === spender.name)
    .some((s) => s.when.every((clause) => meets(clause, values, candidate.values)));
  return covers ? null : "not_covered";
}

/** A holder's period for `at`: its key, zone and numbers (stored plus what this call queued). */
interface Room {
  period: AllowancePeriod;
  zone: string;
  used: number;
  /** The period's real limit: its stored one, or the terms' for a period not yet counted. */
  uses: number | null;
}

async function roomAt(ctx: HandlerContext, candidate: Candidate, at: string): Promise<Room> {
  const keying = keyingAt(candidate.terms, at);
  const period = periodOf(at, keying.per, keying.zone);
  const row = await ctx.db
    .selectFrom("core_allowance_period")
    .select(["used", "uses"])
    .where("object_type", "=", candidate.object.name)
    .where("record_id", "=", candidate.id)
    .where("period", "=", period.key)
    .where("zone", "=", keying.zone)
    .executeTakeFirst();
  const key = pendingKey(candidate.object.name, candidate.id, period.key, keying.zone);
  return {
    period,
    zone: keying.zone,
    used: (row?.used ?? 0) + pendingOf(ctx, key),
    uses: row ? row.uses : candidate.terms.uses,
  };
}

const hasRoom = (room: Room) => room.uses === null || room.used < room.uses;

const END = "9999-12-31T23:59:59.999Z";

/**
 * The order holders are spent in, when the host chooses (ADR 0494): an unlimited one first (it
 * costs nothing); then the one whose use would lapse first, the end of its period for a week or a
 * month, its end for a total; then by object and id, so the choice is always the same.
 */
function precedence(a: Candidate & { lapse: string }, b: Candidate & { lapse: string }) {
  const unlimited = Number(b.terms.uses === null) - Number(a.terms.uses === null);
  if (unlimited !== 0) return unlimited;
  if (a.lapse !== b.lapse) return a.lapse < b.lapse ? -1 : 1;
  if (a.object.name !== b.object.name) return a.object.name < b.object.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lapseOf(candidate: Candidate, at: string): string {
  const { terms } = candidate;
  const until =
    terms.validUntil ??
    (terms.untilDate ? boundOf(terms.untilDate, "until", "date", terms.zone) : null) ??
    END;
  const keying = keyingAt(candidate.terms, at);
  if (keying.per === "total") return until;
  const end = periodOf(at, keying.per, keying.zone).endsAt;
  return end < until ? end : until;
}

/** What the host fills on a spender, and its time. */
interface SpenderRead {
  values: Values;
  at: string;
}

/**
 * Reads what the spender's copies, time and local values come from. `overrides` gives a related
 * record's values as a write in this batch leaves them (a class being rescheduled).
 */
async function readSpender(
  ctx: HandlerContext,
  object: ObjectDefinition,
  def: SpenderDefinition,
  after: Values,
  options: { needAt: boolean; overrides?: ReadonlyMap<string, Values> },
): Promise<SpenderRead> {
  const filled: Values = {};
  const related = new Map<string, Values | undefined>();
  const through = async (path: string, from: Values): Promise<unknown> => {
    const [rel, target] = path.split(".");
    if (!rel || !target) return from[path];
    const id = from[rel];
    if (typeof id !== "string" || !id) return null;
    if (!related.has(rel)) {
      const override = options.overrides?.get(id);
      if (override) related.set(rel, override);
      else {
        const field = object.fields.find((f) => f.name === rel);
        const to = field?.options?.to ? getObject(field.options.to) : undefined;
        related.set(rel, to ? await readValues(ctx, to, id) : undefined);
      }
    }
    // `<relation>.id`: the related record's own id (ADR 0764), when it exists.
    if (target === "id") return related.get(rel) ? id : null;
    return related.get(rel)?.[target] ?? null;
  };
  for (const [target, source] of Object.entries(def.copy)) {
    filled[target] = (await through(source, after)) ?? null;
  }
  const merged = { ...after, ...filled };
  let at = ctx.now;
  if (def.at) {
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
  if (def.local.weekday || def.local.minute) {
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

/** The relations a spender reads its time and copies through, and an own `at` field. */
function sources(def: SpenderDefinition): { relations: string[]; ownAt: string | null } {
  const relations = [def.at, def.local.zone, ...Object.values(def.copy)]
    .filter((p): p is string => typeof p === "string" && p.includes("."))
    .map((p) => p.split(".")[0] as string);
  const ownAt = def.at && !def.at.includes(".") ? def.at : null;
  const ownZone = def.local.zone && !def.local.zone.includes(".") ? def.local.zone : null;
  return {
    relations: [...new Set(relations)],
    ownAt: ownAt ?? ownZone,
  };
}

/** What a spender's write adds: values the host sets on it, and statements for its batch. */
export interface SpenderOutcome {
  values: Values;
  statements: CompiledQuery[];
}

const NOTHING: SpenderOutcome = Object.freeze({ values: {}, statements: [] }) as SpenderOutcome;

const changedIn = (written: Values, before: Values | null, field: string) =>
  Object.hasOwn(written, field) &&
  JSON.stringify(written[field] ?? null) !== JSON.stringify(before?.[field] ?? null);

/**
 * Chooses the holder that pays and queues its spend (ADR 0494). `named` is the holder the spender
 * names (written now or stored); `prefer` one to try first and fall back from (a re-spend's).
 * Refuses, with the reason, when none can.
 */
async function spendFor(
  ctx: HandlerContext,
  object: ObjectDefinition,
  spender: RecordRef,
  values: Values,
  at: string,
  by: Mover,
  options: { named?: string | null; prefer?: string | null; movedFrom?: string | null },
): Promise<{ holder: string; statements: CompiledQuery[] }> {
  const def = spenderOf(object) as SpenderDefinition;
  const person = values[def.person];
  if (typeof person !== "string" || !person) {
    throw new ValidationError(`${object.label} needs a person before it can spend a use`, {
      rule: "allowance",
      reason: "no_holder",
      field: def.person,
    });
  }
  const alive = await ctx.db
    .selectFrom("core_person")
    .select("id")
    .where("id", "=", person)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!alive) throw refusal({ rule: "allowance", reason: "not_live" });
  const candidates = await holdersOf(ctx, object, person);
  const judged = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      reason: cannotPay(c, object, values, at),
      room: await roomAt(ctx, c, at),
      lapse: lapseOf(c, at),
    })),
  );
  const full = (c: (typeof judged)[number]) =>
    refusal({
      rule: "allowance",
      reason: "no_uses_left",
      object: c.object.name,
      record: c.id,
      period: c.room.period.key,
      uses: c.room.uses ?? 0,
      used: c.room.used,
    });
  let chosen: (typeof judged)[number] | undefined;
  if (options.named) {
    chosen = judged.find((c) => c.id === options.named);
    if (!chosen) throw refusal({ rule: "allowance", reason: await notTheirs(ctx, options.named) });
    if (chosen.reason) {
      throw refusal({
        rule: "allowance",
        reason: chosen.reason,
        object: chosen.object.name,
        record: chosen.id,
      });
    }
    if (!hasRoom(chosen.room)) throw full(chosen);
  } else {
    const ordered = judged.sort(precedence);
    const covering = ordered.filter((c) => c.reason === null);
    if (!covering.length) {
      const first = ordered[0];
      throw refusal(
        first?.reason
          ? { rule: "allowance", reason: first.reason, object: first.object.name, record: first.id }
          : { rule: "allowance", reason: "no_holder" },
      );
    }
    const preferred = covering.find((c) => c.id === options.prefer && hasRoom(c.room));
    chosen = preferred ?? covering.find((c) => hasRoom(c.room));
    // Every holder that covers it is full: refused here, with the first's real numbers, never
    // left to the database (the dry run and the real run then agree).
    if (!chosen) throw full(covering[0] as (typeof covering)[number]);
  }
  const holder = { object: chosen.object.name, id: chosen.id };
  addPending(
    ctx,
    pendingKey(holder.object, holder.id, chosen.room.period.key, chosen.room.zone),
    1,
  );
  const { statements } = spendStatements(
    {
      holder,
      period: chosen.room.period,
      zone: chosen.room.zone,
      spender,
      personId: person,
      at,
      atDate: localParts(at, chosen.terms.zone).date,
      by,
      movedFrom: options.movedFrom ?? null,
    },
    ctx.now,
  );
  return { holder: chosen.id, statements };
}

/** Why a named holder is not among the Person's: someone else's, or no holder at all. */
async function notTheirs(ctx: HandlerContext, id: string): Promise<AllowanceRefusalReason> {
  const row = await ctx.db
    .selectFrom("core_allowance")
    .select("record_id")
    .where("record_id", "=", id)
    .executeTakeFirst();
  return row ? "not_theirs" : "no_holder";
}

/** Gives back an open use in this batch (and in this call's count). */
function giveBack(ctx: HandlerContext, spender: RecordRef, open: OpenUse, by: Mover) {
  addPending(ctx, pendingKey(open.object, open.record, open.period, open.zone), -1);
  return returnStatements(spender, by, ctx.now);
}

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
  options: {
    /** The record this one is being moved into, in this batch (its create names it, ADR 0551). */
    movedInto?: string | undefined;
  } = {},
): Promise<SpenderOutcome> {
  const def = spenderOf(object);
  if (!def || !object.states) return NOTHING;
  const ref = { object: object.name, id };
  const after: Values = { ...(before ?? {}), ...written, ...outcome.values };
  const to = outcome.moved?.id;
  // The moved state gives a use back to be spent again by the record it moved to: it is entered
  // only by making that record (`movedFrom`), in one batch, never by a write of its own (ADR 0551).
  if (def.movedFrom && to === def.movedFrom.state && !options.movedInto) {
    throw new ValidationError(
      `${object.label} is moved by making the new one in its place (naming it in ${def.movedFrom.field}), in one write`,
      { rule: "allowance", reason: "move_needs_target", field: object.states.field },
    );
  }
  const entering = to !== undefined && def.spendIn.includes(to);
  const returning = to !== undefined && def.returnIn.includes(to);
  const { relations, ownAt } = sources(def);
  const repointed =
    relations.some((rel) => changedIn(written, before, rel)) ||
    (ownAt !== null && changedIn(written, before, ownAt));
  const open = before === null ? null : await openUse(ctx, ref);
  const holderWritten = changedIn(written, before, def.holder);
  if (open && !returning) {
    // What a use was spent from, and whose it is, do not change under it (ADR 0493).
    if (holderWritten) {
      throw new ValidationError(
        `${object.label} has spent a use of ${String(before?.[def.holder])}: give it back before naming another`,
        { rule: "allowance", field: def.holder },
      );
    }
    if (changedIn(written, before, def.person)) {
      throw new ValidationError(
        `${object.label} has spent a use of its person's: give it back before changing whose it is`,
        { rule: "allowance", field: def.person },
      );
    }
  }
  // Paid another way (ADR 0506): a record marked so enters its spend states spending nothing,
  // and the mark does not change while it is in one (or holds a use), so it cannot be turned on
  // to skip a spend already owed or off to leave one unpaid.
  const isWaived = (values: Values | null) => {
    const v = def.waived ? values?.[def.waived] : undefined;
    return v === true || v === 1 || v === "1" || v === "true";
  };
  const state = object.states.field;
  if (def.waived && before !== null && isWaived(before) !== isWaived(after)) {
    const inSpend = (values: Values) =>
      typeof values[state] === "string" && def.spendIn.includes(values[state] as string);
    if (open || inSpend(before) || inSpend(after)) {
      throw new ValidationError(
        `Whether ${object.label.toLowerCase()} spends a use is decided when it is made: it cannot change now`,
        { rule: "allowance", reason: "waived_kept", field: def.waived },
      );
    }
  }
  // A record moved from another (ADR 0493): made by staff in a spend state, for the same person.
  // The other is moved in this batch, giving its use back, and this one spends from the same
  // holder; one paid another way passes its mark on, so the move spends nothing (ADR 0551).
  const fromId = def.movedFrom && before === null ? after[def.movedFrom.field] : null;
  const moving = def.movedFrom !== undefined && typeof fromId === "string" && fromId !== "";
  let sourceWaived = false;
  // Who made the source for its customer (a parent for a child, ADR 0540) is the host's to carry
  // to the record it moves to: the move is not a new booking by whoever moved it (ADR 0553).
  const madeByField = object.customer?.guardians?.madeBy;
  let sourceMadeBy: unknown;
  const orderField = object.sellable?.moves?.order;
  let sourceOrder: unknown = null;
  if (def.movedFrom && moving) {
    if (by === "customer") {
      throw new ValidationError(
        `Only staff move a ${object.label.toLowerCase()} to another; cancel it and make a new one`,
        { rule: "allowance", field: def.movedFrom.field },
      );
    }
    if (!entering) {
      throw new ValidationError(
        `A ${object.label.toLowerCase()} moved from another is made in a state that spends`,
        { rule: "allowance", field: def.movedFrom.field },
      );
    }
    const source = await readValues(ctx, object, fromId as string);
    if (!source) throw new NotFoundError(object.name, fromId as string);
    if (source[def.person] !== after[def.person]) {
      throw new ValidationError(`A ${object.label.toLowerCase()} moves to the same person`, {
        rule: "allowance",
        field: def.movedFrom.field,
      });
    }
    sourceWaived = isWaived(source);
    if (madeByField) sourceMadeBy = source[madeByField] ?? null;
    // A drop-in's order moves with it (ADR 0560): what it paid for is now the new record, so a
    // later cancel of that one owes the refund, once, and the old one no longer does.
    if (orderField) sourceOrder = source[orderField] ?? null;
    if (!sourceWaived && isWaived(after)) {
      // Moving a paid one into one paid another way would give its use back for nothing.
      throw new ValidationError(
        `Whether ${object.label.toLowerCase()} spends a use moves with it: it cannot change now`,
        { rule: "allowance", reason: "waived_kept", field: def.waived ?? def.movedFrom.field },
      );
    }
  }
  const spending = entering && !open && !isWaived(after) && !sourceWaived;
  const respending = open !== null && !returning && repointed;
  const fill = before === null || entering || repointed;
  const read = fill
    ? await readSpender(ctx, object, def, after, { needAt: spending || respending })
    : { values: {}, at: ctx.now };
  const values: Values = {
    ...read.values,
    ...(sourceWaived && def.waived ? { [def.waived]: true } : {}),
    ...(madeByField && moving ? { [madeByField]: sourceMadeBy ?? null } : {}),
    ...(orderField && moving && sourceOrder ? { [orderField]: sourceOrder } : {}),
  };
  const statements: CompiledQuery[] = [];
  if (object.sellable?.moves && moving) {
    statements.push(
      CompiledQuery.raw(
        "UPDATE core_order_line SET record_id = ? WHERE object_type = ? AND record_id = ?",
        [id, object.name, fromId as string],
      ),
    );
  }
  const spenderValues = { ...after, ...values };

  if (returning && open) statements.push(...giveBack(ctx, ref, open, by));

  // A holder named on a write that does not spend is checked now (ADR 0494): the Person's own.
  const namedNow =
    holderWritten && present(written[def.holder]) ? String(written[def.holder]) : null;
  if (namedNow && !spending && !(open && returning)) {
    const person = spenderValues[def.person];
    const theirs =
      typeof person === "string" &&
      (await holdersOf(ctx, object, person)).some((c) => c.id === namedNow);
    if (!theirs) throw refusal({ rule: "allowance", reason: await notTheirs(ctx, namedNow) });
  }

  if (respending && open) {
    // What it points at changed under a use: given back, and spent again for the new target in
    // this batch, from the same holder if it still pays, else as the host chooses; refused whole
    // when nothing can (ADR 0493).
    statements.push(...giveBack(ctx, ref, open, by));
    const spent = await spendFor(ctx, object, ref, spenderValues, read.at, by, {
      prefer: open.record,
      movedFrom: open.id,
    });
    statements.push(...spent.statements);
    values[def.holder] = spent.holder;
    return { values, statements };
  }
  let movedFrom: OpenUse | null = null;
  if (def.movedFrom && moving) {
    movedFrom = await openUse(ctx, { object: object.name, id: fromId as string });
    if (!recordUpdate) throw new Error("allowance: the record writer is not set");
    await recordUpdate(
      ctx,
      object,
      fromId as string,
      { [object.states.field]: def.movedFrom.state },
      { by, movedInto: id },
    );
  }
  if (!spending) return { values, statements };

  // The holder it names: written now, or stored on it by an earlier write (checked then), or the
  // moved record's.
  const stored = present(spenderValues[def.holder]) ? String(spenderValues[def.holder]) : null;
  const named = namedNow ?? (movedFrom ? movedFrom.record : stored);
  const spent = await spendFor(ctx, object, ref, spenderValues, read.at, by, {
    named,
    movedFrom: movedFrom?.id ?? null,
  });
  statements.push(...spent.statements);
  values[def.holder] = spent.holder;
  return { values, statements };
}

/**
 * When a record that spenders read their time or copies from changes those fields (a class
 * rescheduled, its type changed), each spender holding a use gives it back and spends again for
 * the record as this write leaves it, in this write's batch, and its copied and local values are
 * written again (ADR 0493). If one cannot be paid any more, the whole write is refused with that
 * spender named: staff move or cancel it first.
 */
export async function followSpenders(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  after: Values,
  changed: readonly string[],
  by: Mover,
): Promise<CompiledQuery[]> {
  const statements: CompiledQuery[] = [];
  for (const spender of listObjects()) {
    const def = spenderOf(spender);
    if (!def || !spender.states) continue;
    const paths = [def.at, def.local.zone, ...Object.values(def.copy)].filter(
      (p): p is string => typeof p === "string" && p.includes("."),
    );
    const rels = new Set<string>();
    for (const path of paths) {
      const [rel, target] = path.split(".") as [string, string];
      const field = spender.fields.find((f) => f.name === rel);
      if (field?.options?.to === object.name && changed.includes(target)) rels.add(rel);
    }
    if (!rels.size) continue;
    for (const rel of rels) {
      const field = spender.fields.find((f) => f.name === rel);
      const column = field ? viewColumnOf(field) : null;
      if (!column) continue;
      const { rows } = await ctx.db.executeQuery<Values>(
        CompiledQuery.raw(
          `SELECT s.* FROM ${spender.source} s JOIN core_allowance_use u ON u.spender_type = ? AND u.spender_id = s.id AND u.returned_at IS NULL WHERE s.${column} = ? ORDER BY s.id LIMIT 500`,
          [spender.name, id],
        ),
      );
      for (const row of rows) {
        const values = rowValues(spender, row);
        const ref = { object: spender.name, id: String(row.id) };
        const open = await openUse(ctx, ref);
        if (!open) continue;
        const read = await readSpender(ctx, spender, def, values, {
          needAt: true,
          overrides: new Map([[id, after]]),
        });
        statements.push(...giveBack(ctx, ref, open, by));
        let spent: { holder: string; statements: CompiledQuery[] };
        try {
          spent = await spendFor(ctx, spender, ref, { ...values, ...read.values }, read.at, by, {
            prefer: open.record,
            movedFrom: open.id,
          });
        } catch (error) {
          if (error instanceof ValidationError) {
            const details = error.details as Record<string, unknown>;
            throw new ValidationError(
              `${spender.label} ${ref.id} could not be paid for after this change (${error.message}): move or cancel it first`,
              { ...details, spender: ref.id },
            );
          }
          throw error;
        }
        statements.push(...spent.statements);
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [name, value] of Object.entries({
          ...read.values,
          [def.holder]: spent.holder,
        })) {
          const storage = fieldStorage(spender.name, name);
          if (!storage?.column || !storage.own) continue;
          const type = FIELD_TYPE_REGISTRY[storage.type];
          sets.push(`${storage.column} = ?`);
          params.push(type.toStorage(value as never));
        }
        const table = objectTableOf(spender.name);
        if (sets.length && table) {
          statements.push(
            CompiledQuery.raw(
              `UPDATE ${table} SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
              [...params, ctx.now, ref.id],
            ),
          );
        }
      }
    }
  }
  return statements;
}
