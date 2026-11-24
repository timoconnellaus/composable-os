// The `staffed` behaviour (stage 45 step 2, ADRs 0621 and 0622): a record that is a shift, a time
// someone works, and the host's rules over it.
//
// - **The time claim** (ADR 0621). Every live, covered shift whose person has a staff account
//   holds one row in core_staff_time, and the database refuses a second that overlaps one
//   account's time (migration 0811). The claims are kept by triggers the reconciler builds on the
//   staffed object's table (staffing/sql.ts), so every statement that writes a shift writes its
//   claim, whatever wrote it. What is here only reads before the write: it names the other shift
//   in the common case (the trigger's refusal is generic), keeps what this batch queued, makes a
//   series' generation leave a clashing date uncovered rather than fail, and refuses a series
//   change that would double-book someone on any date, naming the dates.
// - **Warnings** (ADR 0622): a write is made with its warnings, never refused for them. A person
//   away over the shift (`unavailable`), not qualified for its kind (`not_qualified`), or a live
//   shift left with nobody on it within the uncovered window (`uncovered`). The write's answer and
//   its audit row carry them; `staffing.check` gives the same answer before the write.
import { CompiledQuery, type Kysely, sql } from "kysely";
import {
  checklistTemplateFields,
  checklistViaFields,
  holdersCarryChecklist,
} from "../checklists/index.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition, StaffedDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Mover } from "../records/transitions.ts";
import {
  isoWeekday,
  localParts,
  parseLocalTime,
  wallClockOf,
  wallClockToInstant,
} from "../time/local.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { shiftRemoved, shiftWritten } from "./changes.ts";
import { kindObjectOf } from "./kinds.ts";
import {
  actingAccount,
  assertMayRoster,
  mayRoster,
  queueNotice,
  rosterers,
  rosterNumbers,
  shiftLink,
} from "./rosterers.ts";
import { literal, type StaffedTables, selectClaims } from "./sql.ts";

/** One account's claim on a span of time: unix seconds, half-open. */
export interface Claim {
  account: string;
  starts: number;
  ends: number;
}

/** What a shift's values give. */
export interface Shift {
  /** It has a person (a coach profile, or a user), with an account or not. */
  covered: boolean;
  /** The staff account working it, when it has one. */
  account: string | null;
  starts: number | null;
  ends: number | null;
  /** In a live state (the caller knows whether it is in the Trash). */
  live: boolean;
  /** The kind record (a class type), when it has one. */
  kind: string | null;
}

/** A warning a write is made with (ADR 0622). */
export interface StaffWarning {
  code: "unavailable" | "not_qualified" | "uncovered";
  object: string;
  id: string;
  account: string | null;
  message: string;
}

/** The other shift a write would clash with. */
export interface Clash {
  object: string;
  id: string;
  starts: number;
  ends: number;
}

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

const key = (object: string, id: string) => `${object}\u0000${id}`;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const secondsOf = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- What one batch queued ------------------------------------------------------------------------

interface StaffBatch {
  /** Claims this batch wrote (a claim) or released (null), by record. */
  claims: Map<string, Claim | null>;
  /** Warnings each write in this batch was made with, by record. */
  warnings: Map<string, StaffWarning[]>;
  /** The offer this batch takes (ADR 0623): its write of the person is the take's. */
  taking: string | null;
}

const batches = new WeakMap<object, StaffBatch>();

/** What this batch has queued (keyed on the context's `write`, shared by the whole batch). */
function batchOf(ctx: { write: object }): StaffBatch {
  let state = batches.get(ctx.write);
  if (!state) {
    state = { claims: new Map(), warnings: new Map(), taking: null };
    batches.set(ctx.write, state);
  }
  return state;
}

/** Notes that this batch takes `offer` (ADR 0623): the person's write that follows is the take's. */
export function noteTaking(ctx: { write: object }, offer: string): void {
  batchOf(ctx).taking = offer;
}

/** The warnings the writes of this batch to `object`'s record `id` were made with. */
export function warningsOf(ctx: { write: object }, object: string, id: string): StaffWarning[] {
  return batchOf(ctx).warnings.get(key(object, id)) ?? [];
}

// --- Reading a shift ------------------------------------------------------------------------------

/** The account of a coach profile (or another holder): its user field, in or out of the Trash. */
async function holderAccount(
  ctx: HandlerContext,
  def: StaffedDefinition,
  holderId: string,
): Promise<string | null> {
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
  if (!table || !column) return null;
  const row = await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(`${column} as account`)
    .where("id", "=", holderId)
    .executeTakeFirst();
  return text(row?.account);
}

/** The shift a staffed object's values describe. */
export async function shiftOf(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Shift | null> {
  const def = object.staffed;
  if (!def) return null;
  const who = text(values[def.who.field]);
  const account = who === null ? null : def.who.account ? await holderAccount(ctx, def, who) : who;
  const stateField = object.states?.field;
  const state = stateField ? values[stateField] : null;
  return {
    covered: who !== null,
    account,
    starts: secondsOf(values[def.starts]),
    ends: secondsOf(values[def.ends]),
    live: typeof state === "string" && def.live.includes(state),
    kind: text(values[def.kind]),
  };
}

/** The claim a shift holds, exactly as the triggers derive it (staffing/sql.ts), or null. */
export function claimOf(shift: Shift | null): Claim | null {
  if (!shift?.live || !shift.account || shift.starts === null || shift.ends === null) return null;
  if (!(shift.ends > shift.starts)) return null;
  return { account: shift.account, starts: shift.starts, ends: shift.ends };
}

/**
 * Another shift of the claim's account overlapping it, as held now with what this batch queued
 * (a claim written or released earlier in the batch counts as written), or null.
 */
export async function clashWith(
  ctx: HandlerContext,
  object: string,
  id: string | null,
  claim: Claim,
): Promise<Clash | null> {
  const self = id === null ? null : key(object, id);
  const queued = batchOf(ctx).claims;
  const held = await ctx.db
    .selectFrom("core_staff_time")
    .select(["object_type", "record_id", "starts", "ends"])
    .where("account_id", "=", claim.account)
    .where("starts", "<", claim.ends)
    .where("ends", ">", claim.starts)
    .limit(200)
    .execute();
  for (const row of held) {
    const k = key(row.object_type, row.record_id);
    if (k === self || queued.has(k)) continue;
    return { object: row.object_type, id: row.record_id, starts: row.starts, ends: row.ends };
  }
  for (const [k, other] of queued) {
    if (k === self || !other || other.account !== claim.account) continue;
    if (other.starts < claim.ends && other.ends > claim.starts) {
      const [o, r] = k.split("\u0000") as [string, string];
      return { object: o, id: r, starts: other.starts, ends: other.ends };
    }
  }
  return null;
}

/** A record's title, for naming it in an answer. */
async function titleOf(
  ctx: HandlerContext,
  objectName: string,
  id: string,
): Promise<string | null> {
  const object = getObject(objectName);
  const table = objectTableOf(objectName);
  const column = object?.fields.find((f) => f.name === object.titleField)?.column;
  if (!table || !column) return null;
  const row = await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(`${column} as title`)
    .where("id", "=", id)
    .executeTakeFirst();
  return text(row?.title);
}

async function nameOf(ctx: HandlerContext, account: string): Promise<string> {
  const row = await ctx.db
    .selectFrom("core_user")
    .select(["name", "email"])
    .where("id", "=", account)
    .executeTakeFirst();
  return row?.name || row?.email || "This person";
}

/** The other shift, as an answer names it. */
export async function described(ctx: HandlerContext, clash: Clash) {
  const label = getObject(clash.object)?.label ?? "shift";
  const title = await titleOf(ctx, clash.object, clash.id);
  return {
    object: clash.object,
    id: clash.id,
    title: title ?? label,
    startsAt: iso(clash.starts),
    endsAt: iso(clash.ends),
  };
}

/** The refusal of a write that would put one account on two overlapping shifts. */
export async function doubleBooked(
  ctx: HandlerContext,
  object: string,
  id: string | null,
  claim: Claim,
  clash: Clash,
): Promise<ConflictError> {
  const other = await described(ctx, clash);
  const name = await nameOf(ctx, claim.account);
  return new ConflictError(
    `${name} is already on another shift at that time: ${other.title}, ${other.startsAt} to ${other.endsAt}. Nothing was changed.`,
    {
      rule: "double_booked",
      account: claim.account,
      shift: { object, id },
      other,
    },
  );
}

// --- Who may say who works (the review of PR #284, ADR 0626) ---------------------------------------

/**
 * The fields of `object` that say who works shifts: a staffed object's person; a series' field that
 * is some staffed object's pattern (its regular person); and a holder's account (a coach profile's
 * user, which puts that account on every shift naming the profile), the last only once it exists.
 */
function rosterFields(object: ObjectDefinition, creating: boolean): string[] {
  const fields: string[] = [];
  if (object.staffed) fields.push(object.staffed.who.field);
  for (const o of listObjects()) {
    const def = o.staffed;
    if (!def) continue;
    const link = def.pattern ? o.fields.find((f) => f.name === def.pattern?.link) : undefined;
    if (def.pattern && link?.options?.to === object.name) fields.push(def.pattern.who);
    if (!creating && def.who.account && def.who.object === object.name) {
      fields.push(def.who.account);
    }
  }
  return [...new Set(fields)];
}

/**
 * The fields of a kind object (a class type) holding a staffed object's set-up and pack-down
 * minutes (`staffed.payBefore`, `payAfter`): its own field, or one the staffed object's extension
 * adds to it (`bookings.rosterBeforeMinutes`). They change what pay totals (ADR 0627).
 */
export function payMinuteFields(object: ObjectDefinition): string[] {
  const out: string[] = [];
  for (const o of listObjects()) {
    const def = o.staffed;
    if (!def || kindObjectOf(o) !== object.name) continue;
    const ext = o.name.split(".")[0];
    for (const path of [def.payBefore, def.payAfter]) {
      const local = path?.field.split(".")[1];
      if (!local) continue;
      const field =
        object.fields.find((f) => f.name === local) ??
        object.fields.find((f) => f.name === `${ext}.${local}`);
      if (field) out.push(field.name);
    }
  }
  return [...new Set(out)];
}

/**
 * Whether a write of `object` moves a shift that has started (or moves one to before `now`): before
 * a lock, only rosterers change a started shift's times (the owner's decision of 2026-11-24).
 */
function movesStartedShift(
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  now: string,
): boolean {
  const def = object.staffed;
  if (!def || before === null) return false;
  const moved = [def.starts, def.ends].some(
    (f) => Object.hasOwn(after, f) && !same(before[f], after[f]),
  );
  if (!moved) return false;
  const at = Date.parse(now);
  const old = Date.parse(String(before[def.starts] ?? ""));
  const next = Date.parse(String(after[def.starts] ?? before[def.starts] ?? ""));
  return (Number.isFinite(old) && old <= at) || (Number.isFinite(next) && next <= at);
}

/**
 * A caller's write that sets or changes who works a shift, a pattern's person or a holder's account
 * is a rosterer's (the owner's decision of 2026-11-24: a class's coach included), by every path that writes a record (create, update, createMany, import, a
 * version restored, a series changed): refused otherwise, where a pack declares who rosters. The
 * host's own writes (a take, a series' generation, a leaver taken off) are not the caller's.
 * Creating a shift or a pattern with nobody on it stays open to whoever may write the object.
 */
export async function assertRosterWrite(
  ctx: HandlerContext,
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  by: Mover | undefined,
): Promise<void> {
  if (by === "host" || batchOf(ctx).taking) return;
  const changes = (fields: readonly string[]) =>
    fields.filter((f) =>
      before === null
        ? after[f] !== undefined && after[f] !== null && after[f] !== ""
        : Object.hasOwn(after, f) && !same(before[f], after[f]),
    );
  if (changes(rosterFields(object, before === null)).length) {
    await assertMayRoster(ctx, `say who works a ${object.label.toLowerCase()}`);
  }
  // What pay is totalled from, before a lock (the review of PR #287, ADR 0627): a kind's set-up
  // and pack-down minutes, and the times of a shift that has started (a future one stays open to
  // whoever may write it).
  if (changes(payMinuteFields(object)).length) {
    await assertMayRoster(ctx, "change the set-up and pack-down minutes pay counts");
  }
  // Which checklist staff tick off on a kind of work (a duty's `checklist`, ADR 0650, the review of
  // PR #298): a rosterer's, or a member could make a checklist disappear before it is missed.
  if (changes(checklistTemplateFields(object)).length) {
    await assertMayRoster(ctx, "change which checklist is ticked off");
  }
  // ...and so is moving a record to another holder of a checklist, or off one (a shift's duty).
  if (before !== null) {
    for (const via of checklistViaFields(object)) {
      if (!changes([via.field]).length) continue;
      if (await holdersCarryChecklist(ctx.db, via.holder, [before[via.field], after[via.field]])) {
        await assertMayRoster(ctx, "change which checklist is ticked off");
      }
    }
  }
  if (movesStartedShift(object, before, after, ctx.now)) {
    await assertMayRoster(
      ctx,
      `change the times of a ${object.label.toLowerCase()} that has started`,
    );
  }
}

/**
 * A record restored from the Trash that says who works shifts (a shift with its person, a series
 * with its regular person, which the series then generates from): the caller's to say (ADR 0626).
 */
export async function assertRosterRestore(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  const fields = rosterFields(object, true);
  const table = objectTableOf(object.name);
  if (!fields.length || !table) return;
  const columns = fields
    .map((f) => object.fields.find((x) => x.name === f)?.column)
    .filter((c): c is string => !!c);
  if (!columns.length) return;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(columns.map((c, i) => `${c} as f${i}`))
    .where("id", "=", id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (row && columns.some((_, i) => text(row[`f${i}`]) !== null)) {
    await assertMayRoster(ctx, `restore a ${object.label.toLowerCase()} with someone on it`);
  }
}

/** Whether `values` (a write of `object`) would set who works shifts: for an approval (ADR 0626). */
export function setsRosterFields(object: ObjectDefinition, values: Record<string, unknown>) {
  return [
    ...rosterFields(object, false),
    ...payMinuteFields(object),
    ...checklistTemplateFields(object),
    ...checklistViaFields(object).map((v) => v.field),
  ].some((f) => Object.hasOwn(values, f));
}

/**
 * Whether an update of `object`'s record `id` with `values` moves a shift that has started (for
 * an approval: a rosterer's to approve, ADR 0627). Reads the record as it is.
 */
export async function movesStartedShiftById(
  db: AnyDb,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
  now: string,
): Promise<boolean> {
  const def = object.staffed;
  const table = objectTableOf(object.name);
  const column = (f: string) => object.fields.find((x) => x.name === f)?.column;
  const startsCol = def ? column(def.starts) : undefined;
  if (!def || !table || !startsCol) return false;
  if (!Object.hasOwn(values, def.starts) && !Object.hasOwn(values, def.ends)) return false;
  const row = (await db
    .selectFrom(table)
    .select(`${startsCol} as starts`)
    .where("id", "=", id)
    .executeTakeFirst()) as { starts?: unknown } | undefined;
  return movesStartedShift(object, { [def.starts]: row?.starts ?? null }, values, now);
}

/** Notes a claim written (or released, null) by this batch, for the batch's later reads. */
export function noteClaim(
  ctx: { write: object },
  object: string,
  id: string,
  claim: Claim | null,
): void {
  batchOf(ctx).claims.set(key(object, id), claim);
}

// --- Writes (operations/record.ts and recurring call these) --------------------------------------

/**
 * A staffed record written (created, updated, restored): refused as `double_booked` when its claim
 * would overlap another of its account's, naming the other shift; otherwise the claim is noted for
 * the batch and the write's warnings worked out. `before` is null for a create or a restore. The
 * trigger makes the claim itself, and refuses a race this read cannot see.
 */
export async function staffedWritten(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  options: {
    /** Who writes: the host's own writes (a series' generation and changes) tell nobody. */
    by?: Mover | undefined;
    /** A restore from the Trash: checked, and tells nobody. */
    restore?: boolean;
  } = {},
): Promise<void> {
  if (!object.staffed) return;
  const shift = (await shiftOf(ctx, object, after)) as Shift;
  // A live shift ends after it starts (the trigger refuses it too): one that does not would claim
  // nothing, and could sit inside another of its person's shifts.
  if (shift.live && shift.starts !== null && shift.ends !== null && shift.ends <= shift.starts) {
    const field = object.staffed.ends;
    throw new ValidationError(
      `${object.label}: ${object.fields.find((f) => f.name === field)?.label ?? field} must be after its start`,
      { field, rule: "staffed_time" },
    );
  }
  const claim = claimOf(shift);
  if (claim) {
    const clash = await clashWith(ctx, object.name, id, claim);
    if (clash) throw await doubleBooked(ctx, object.name, id, claim, clash);
  }
  noteClaim(ctx, object.name, id, claim);
  const changes = changesStaffing(object, before, after);
  const warnings = changes ? await warningsFor(ctx, object, id, shift) : [];
  batchOf(ctx).warnings.set(key(object.name, id), warnings);
  // Its open offer and who is told (ADRs 0623 and 0624), in this write's batch.
  if (changes && !options.restore) {
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    await shiftWritten(ctx, {
      object,
      id,
      before,
      after,
      beforeShift: before ? await shiftOf(ctx, object, before) : null,
      shift,
      by: options.by,
      taking: batchOf(ctx).taking,
      // Only an uncovered shift asks (the window is the Rostering pack's setting, ADR 0626).
      inWindow:
        !shift.covered &&
        shift.starts !== null &&
        shift.starts >= now &&
        shift.starts < now + (await rosterNumbers(ctx.db)).uncoveredDays * 86_400,
    });
  }
}

/**
 * A staffed record sent to the Trash (or removed): it claims nothing now, its open offer is
 * cancelled, and its person is told.
 */
export async function staffedReleased(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  if (!object.staffed) return;
  noteClaim(ctx, object.name, id, null);
  const values = await storedShiftValues(ctx, object, id, true);
  // A series no longer making that date removes it as the host: its person hears too, in the one
  // summary of the series' change (ADR 0624).
  await shiftRemoved(ctx, object, id, values, values ? await shiftOf(ctx, object, values) : null);
}

/** The stored values a staffed record's claim reads, in or out of the Trash (a restore). */
async function storedShiftValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  described = false,
): Promise<Record<string, unknown> | null> {
  const def = object.staffed;
  const table = objectTableOf(object.name);
  if (!def || !table) return null;
  const fields = [
    ...new Set(
      [
        def.who.field,
        def.starts,
        def.ends,
        def.kind,
        object.states?.field,
        ...(described ? [object.titleField, def.zone] : []),
      ].filter((f): f is string => typeof f === "string"),
    ),
  ];
  const columns = fields.map((f) => object.fields.find((x) => x.name === f)?.column);
  if (columns.some((c) => !c)) return null;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(columns.map((c, i) => `${c} as f${i}`))
    .where("id", "=", id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.fromEntries(fields.map((f, i) => [f, row[`f${i}`] ?? null]));
}

/** A staffed record restored from the Trash: refused as `double_booked` if its time is taken. */
export async function staffedRestored(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  if (!object.staffed) return;
  const values = await storedShiftValues(ctx, object, id);
  if (values) await staffedWritten(ctx, object, id, null, values, { restore: true });
}

/** A shift as stored, with what it is and whether it is in the Trash (the offers read it). */
export interface StoredShift {
  object: ObjectDefinition;
  id: string;
  values: Record<string, unknown>;
  shift: Shift;
  deleted: boolean;
}

/** A staffed record's shift as stored now, or null when there is no such record. */
export async function loadShift(
  ctx: HandlerContext,
  objectName: string,
  id: string,
): Promise<StoredShift | null> {
  const object = getObject(objectName);
  const table = object ? objectTableOf(object.name) : undefined;
  if (!object?.staffed || !table) return null;
  const values = await storedShiftValues(ctx, object, id, true);
  if (!values) return null;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(table)
    .select("deleted_at")
    .where("id", "=", id)
    .executeTakeFirst()) as { deleted_at: string | null } | undefined;
  return {
    object,
    id,
    values,
    shift: (await shiftOf(ctx, object, values)) as Shift,
    deleted: Boolean(row?.deleted_at),
  };
}

/** The value of a shift's person field that puts `account` on it, or null (no profile for it). */
export async function personValueFor(
  ctx: HandlerContext,
  object: ObjectDefinition,
  account: string,
): Promise<string | null> {
  const def = object.staffed;
  if (!def) return null;
  if (!def.who.account) return account;
  const holder = def.who.object ? getObject(def.who.object) : undefined;
  const table = holder ? objectTableOf(holder.name) : undefined;
  const column = holder?.fields.find((f) => f.name === def.who.account)?.column;
  if (!table || !column) return null;
  const row = (await (ctx.db as AnyDb)
    .selectFrom(table)
    .select("id")
    .where(column, "=", account)
    .where("deleted_at", "is", null)
    .orderBy("id")
    .executeTakeFirst()) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The tables and columns of a staffed object as installed (the triggers' SQL reads them). */
function tablesOf(object: ObjectDefinition): StaffedTables | null {
  const def = object.staffed;
  const table = objectTableOf(object.name);
  const column = (name: string | undefined) =>
    name ? object.fields.find((f) => f.name === name)?.column : undefined;
  const who = column(def?.who.field);
  const starts = column(def?.starts);
  const ends = column(def?.ends);
  const state = column(object.states?.field);
  if (!def || !table || !who || !starts || !ends || !state) return null;
  let account: StaffedTables["account"];
  if (def.who.account) {
    const holder = def.who.object ? getObject(def.who.object) : undefined;
    const holderTable = holder ? objectTableOf(holder.name) : undefined;
    const holderColumn = holder?.fields.find((f) => f.name === def.who.account)?.column;
    if (!holderTable || !holderColumn) return null;
    account = { table: holderTable, column: holderColumn };
  }
  return { object: object.name, table, who, account, starts, ends, state, live: def.live };
}

/**
 * A record that holds the account of other objects' shifts (a coach profile) written: a new
 * account takes over every live shift that names it, past ones included. Checked set-based, in at
 * most three reads however many shifts the profile has (ADR 0621): its shifts against the new
 * account's other claims, then its shifts against each other (they claimed nobody's time while the
 * profile had no account). The trigger on the profile writes the claims, and refuses a race.
 */
export async function holderWritten(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  for (const staffed of listObjects()) {
    const def = staffed.staffed;
    if (!def?.who.account || def.who.object !== object.name) continue;
    if (same(before[def.who.account], after[def.who.account])) continue;
    const account = text(after[def.who.account]);
    const t = tablesOf(staffed);
    if (!t) continue;
    // Its shifts are someone else's now: their open offers were the old person's to make, so they
    // are cancelled, at commit (an offer made meanwhile too), and their offerers told (ADR 0623).
    await holderOffersCancelled(ctx, staffed, t, id);
    if (!account) continue;
    const mine = selectClaims(t, `r.${t.who} = ${literal(id)}`, literal(account));
    const outside = await sql
      .raw<{
        shift: string;
        object_type: string;
        record_id: string;
        starts: number;
        ends: number;
        s_starts: number;
        s_ends: number;
      }>(
        `WITH s AS MATERIALIZED (${mine}) SELECT s.record_id AS shift, s.starts AS s_starts, ` +
          "s.ends AS s_ends, c.object_type, c.record_id, c.starts, c.ends FROM s " +
          "JOIN core_staff_time c ON c.account_id = s.account_id AND c.ends > s.starts " +
          "AND c.starts < s.ends AND NOT (c.object_type = s.object_type AND c.record_id = s.record_id) " +
          "ORDER BY s.starts LIMIT 1",
      )
      .execute(ctx.db);
    const hit = outside.rows[0];
    if (hit) {
      throw await doubleBooked(
        ctx,
        staffed.name,
        hit.shift,
        { account, starts: hit.s_starts, ends: hit.s_ends },
        { object: hit.object_type, id: hit.record_id, starts: hit.starts, ends: hit.ends },
      );
    }
    const inside = await sql
      .raw<{
        a: string;
        a_starts: number;
        a_ends: number;
        b: string;
        b_starts: number;
        b_ends: number;
      }>(
        `WITH s AS MATERIALIZED (${mine}), ` +
          "w AS (SELECT s.*, MAX(ends) OVER (ORDER BY starts, record_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end FROM s), " +
          "f AS (SELECT * FROM w WHERE prev_end > starts ORDER BY starts LIMIT 1) " +
          "SELECT f.record_id AS a, f.starts AS a_starts, f.ends AS a_ends, b.record_id AS b, " +
          "b.starts AS b_starts, b.ends AS b_ends FROM f JOIN s b ON b.ends > f.starts " +
          "AND b.starts <= f.starts AND b.record_id != f.record_id ORDER BY b.starts LIMIT 1",
      )
      .execute(ctx.db);
    const pair = inside.rows[0];
    if (pair) {
      throw await doubleBooked(
        ctx,
        staffed.name,
        pair.a,
        { account, starts: pair.a_starts, ends: pair.a_ends },
        { object: staffed.name, id: pair.b, starts: pair.b_starts, ends: pair.b_ends },
      );
    }
  }
}

/** The open offers of the shifts a holder (a coach profile) names, cancelled with its account. */
async function holderOffersCancelled(
  ctx: HandlerContext,
  staffed: ObjectDefinition,
  t: StaffedTables,
  holderId: string,
): Promise<void> {
  const why = "The shift's coach profile was given to another account, so the offer was cancelled.";
  const shifts = `SELECT r.id FROM ${t.table} r WHERE r.${t.who} = ${literal(holderId)}`;
  ctx.write(
    CompiledQuery.raw(
      `UPDATE core_staff_offer SET state = 'cancelled', ended_at = ?, ended_by = ?, why = ? WHERE state = 'open' AND object_type = ? AND record_id IN (${shifts})`,
      [ctx.now, actingAccount(ctx), why, staffed.name],
    ),
  );
  const open = await sql
    .raw<{ from_account: string | null; made_by: string; record_id: string }>(
      `SELECT from_account, made_by, record_id FROM core_staff_offer WHERE state = 'open' AND object_type = ${literal(staffed.name)} AND record_id IN (${shifts}) LIMIT 50`,
    )
    .execute(ctx.db);
  for (const offer of open.rows) {
    await queueNotice(ctx, {
      to: [offer.from_account ?? offer.made_by],
      title: "Your offer was cancelled",
      body: why,
      link: shiftLink(staffed.name, offer.record_id),
    });
  }
}

/**
 * A record holding the account of other objects' shifts (a coach profile) sent to the Trash: refused
 * while a live shift that has not ended names it (ADR 0621), answering how many, so a person
 * reassigns those or leaves them with nobody first. With only past shifts it may go; their claims
 * stay (they were worked).
 */
export async function assertHolderTrashable(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  for (const staffed of listObjects()) {
    const def = staffed.staffed;
    if (!def?.who.account || def.who.object !== object.name) continue;
    const t = tablesOf(staffed);
    if (!t) continue;
    const row = await sql
      .raw<{ n: number }>(
        `SELECT count(*) AS n FROM ${t.table} r WHERE r.${t.who} = ${literal(id)} ` +
          `AND r.deleted_at IS NULL AND r.${t.state} IN (${t.live.map(literal).join(", ")}) ` +
          `AND (strftime('%s', r.${t.ends}) IS NULL OR CAST(strftime('%s', r.${t.ends}) AS INTEGER) > ${now})`,
      )
      .execute(ctx.db);
    const n = Number(row.rows[0]?.n ?? 0);
    if (n > 0) {
      throw new ConflictError(
        `${object.label} is on ${n} ${(staffed.plural ?? "shifts").toLowerCase()} that have not ended. Give them to someone else, or leave them with nobody, before deleting it.`,
        { rule: "staffed_holder", object: staffed.name, count: n },
      );
    }
  }
}

/**
 * The clash a record a series is about to make would have (ADR 0621): the host's generation never
 * fails on one. Returns the clash, or null; the caller makes the record uncovered instead.
 */
export async function generationClash(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Clash | null> {
  const claim = claimOf(await shiftOf(ctx, object, values));
  return claim ? clashWith(ctx, object.name, null, claim) : null;
}

/**
 * Whether the person a record's values name has a deactivated account (ADR 0624): the host's
 * generation makes such a date with nobody on it, whatever its series still names.
 */
export async function personDeactivated(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<boolean> {
  const shift = await shiftOf(ctx, object, values);
  if (!shift?.account) return false;
  const row = await ctx.db
    .selectFrom("core_user")
    .select("deactivated_at")
    .where("id", "=", shift.account)
    .executeTakeFirst();
  return Boolean(row?.deactivated_at);
}

/**
 * A date the host's generation left with nobody on it because its pattern person was already on
 * another shift then (ADR 0621): the rosterers are told the date and why (ADR 0624).
 */
export async function patternNotApplied(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  date: string,
  values: Record<string, unknown>,
  clash: Clash,
): Promise<void> {
  const claim = claimOf(await shiftOf(ctx, object, values));
  const name = claim ? await nameOf(ctx, claim.account) : "Its regular person";
  const other = await described(ctx, clash);
  const title = (object.titleField ? text(values[object.titleField]) : null) ?? object.label;
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title: `A shift has nobody on it: ${title} on ${date}`,
    body: `${name} is already on ${other.title} at that time, so ${title} on ${date} was made with nobody on it.`,
    link: shiftLink(object.name, id),
  });
}

/**
 * A series change's planned writes to its records (ADR 0621): refused whole when any would put its
 * person on two overlapping shifts, naming every such date, so the rosterer settles those first.
 * Each plan's claim is noted as it is checked, so two of the plans cannot pass each other.
 */
export async function assertPlansStaffFree(
  ctx: HandlerContext,
  object: ObjectDefinition,
  plans: readonly { id: string; date: string; after: Record<string, unknown> }[],
): Promise<void> {
  if (!object.staffed || !plans.length) return;
  const clashes: { date: string; id: string; other: Awaited<ReturnType<typeof described>> }[] = [];
  let account: string | null = null;
  for (const plan of plans) {
    const claim = claimOf(await shiftOf(ctx, object, plan.after));
    if (!claim) continue;
    const clash = await clashWith(ctx, object.name, plan.id, claim);
    if (clash) {
      account = claim.account;
      clashes.push({ date: plan.date, id: plan.id, other: await described(ctx, clash) });
      continue;
    }
    noteClaim(ctx, object.name, plan.id, claim);
  }
  if (!clashes.length) return;
  const name = account ? await nameOf(ctx, account) : "Someone";
  throw new ConflictError(
    `${name} would be on two shifts at once on ${clashes.map((c) => c.date).join(", ")}. Nothing was changed: settle those dates first.`,
    { rule: "double_booked", account, dates: clashes.map((c) => c.date), clashes },
  );
}

// --- Warnings (ADR 0622) --------------------------------------------------------------------------

/** Whether a write changes who works the shift, when, on what, or whether it is live. */
function changesStaffing(
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): boolean {
  const def = object.staffed as StaffedDefinition;
  if (before === null) return true;
  const fields = [def.who.field, def.starts, def.ends, def.kind, object.states?.field];
  return fields.some((f) => f !== undefined && !same(before[f], after[f]));
}

export { kindObjectOf } from "./kinds.ts";

/**
 * Whether `account` may do the kind of work `kind` names: a live kind record, and qualified. Not
 * strict (a write's warning), a business with no qualification at all for the kind's object is
 * not warned (ADR 0622); strict (a take, ADR 0623), only a qualification row counts.
 */
export async function qualified(
  ctx: HandlerContext,
  object: ObjectDefinition,
  account: string,
  kind: string,
  strict = false,
): Promise<boolean> {
  const def = object.staffed as StaffedDefinition;
  const kindObject = object.fields.find((f) => f.name === def.kind)?.options?.to;
  if (!kindObject) return false;
  const row = await ctx.db
    .selectFrom("core_staff_qualification")
    .select("kind_record")
    .where("account_id", "=", account)
    .where("kind_object", "=", kindObject)
    .where("kind_record", "=", kind)
    .executeTakeFirst();
  if (!row) {
    if (strict) return false;
    // A business that has not set qualifications up for this kind of work (no row at all for its
    // object) is not warned: nobody is marked, so the warning would say nothing (ADR 0622).
    const any = await ctx.db
      .selectFrom("core_staff_qualification")
      .select("kind_record")
      .where("kind_object", "=", kindObject)
      .limit(1)
      .executeTakeFirst();
    return !any;
  }
  // A kind record in the Trash, or gone, qualifies nobody (restored, its qualifications return).
  const target = getObject(kindObject);
  if (!target) return false;
  const live = await ctx.db
    .selectFrom(visibleSource(orgReader(ctx.db), target))
    .select("id")
    .where("id", "=", kind)
    .executeTakeFirst();
  return Boolean(live);
}

/** One of an account's unavailabilities overlapping `starts`..`ends` (unix seconds), or null. */
export async function awayOver(
  ctx: HandlerContext,
  account: string,
  starts: number,
  ends: number,
): Promise<{ id: string; kind: string } | null> {
  // Only what can still overlap: one-off times ending after the shift starts, regular rules not
  // ended before its first local date (two days early, for any zone). Past leave is not read.
  const firstDate = plusDays(iso(starts).slice(0, 10), -2);
  const rows = await ctx.db
    .selectFrom("core_staff_away")
    .selectAll()
    .where("account_id", "=", account)
    .where((eb) =>
      eb.or([
        eb.and([eb("kind", "!=", "regular"), eb("ends_at", ">", iso(starts))]),
        eb.and([
          eb("kind", "=", "regular"),
          eb.or([eb("until_date", "is", null), eb("until_date", ">=", firstDate)]),
        ]),
      ]),
    )
    .limit(500)
    .execute();
  for (const row of rows) {
    if (row.kind !== "regular") {
      const from = secondsOf(row.starts_at);
      const until = secondsOf(row.ends_at);
      if (from !== null && until !== null && from < ends && until > starts) {
        return { id: row.id, kind: row.kind };
      }
      continue;
    }
    if (regularOverlaps(row, starts, ends)) return { id: row.id, kind: row.kind };
  }
  return null;
}

const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Adds `days` to a `YYYY-MM-DD` date. */
function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Whether a regular unavailability (weekdays, a local start and end, from and until dates, a zone)
 * overlaps `starts`..`ends`, by wall clock in its zone: every local date the shift touches (and
 * the day before, for an overnight rule) is checked, so 13:00 is 13:00 across a clock change.
 */
export function regularOverlaps(
  rule: {
    weekdays: string | null;
    start_time: string | null;
    end_time: string | null;
    from_date: string | null;
    until_date: string | null;
    zone: string;
  },
  starts: number,
  ends: number,
): boolean {
  const days = new Set(
    (rule.weekdays ?? "")
      .split(",")
      .map((d) => WEEKDAY_NAMES.indexOf(d.trim()) + 1)
      .filter((d) => d > 0),
  );
  const from = parseLocalTime(rule.start_time ?? "");
  const until = parseLocalTime(rule.end_time ?? "");
  if (!days.size || from === null || until === null) return false;
  const first = plusDays(localParts(starts * 1000, rule.zone).date, -1);
  const last = localParts(Math.max(starts, ends - 1) * 1000, rule.zone).date;
  for (let date = first; date <= last; date = plusDays(date, 1)) {
    if (!days.has(isoWeekday(date))) continue;
    if (rule.from_date && date < rule.from_date) continue;
    if (rule.until_date && date > rule.until_date) continue;
    const a = wallClockToInstant(wallClockOf(date, from), rule.zone) / 1000;
    const b =
      wallClockToInstant(wallClockOf(until > from ? date : plusDays(date, 1), until), rule.zone) /
      1000;
    if (a < ends && b > starts) return true;
  }
  return false;
}

/**
 * The warnings a live shift is made with (ADR 0622): nobody on it within the uncovered window; its
 * person away over it; its person not qualified for its kind. A shift that is not live, and a
 * person with no account (a visiting coach), have none of the last two.
 */
export async function warningsFor(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  shift: Shift,
): Promise<StaffWarning[]> {
  if (!shift.live) return [];
  const warn = (code: StaffWarning["code"], message: string): StaffWarning => ({
    code,
    object: object.name,
    id,
    account: shift.account,
    message,
  });
  const label = object.label.toLowerCase();
  const out: StaffWarning[] = [];
  if (!shift.covered) {
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    const window = now + (await rosterNumbers(ctx.db)).uncoveredDays * 86_400;
    if (shift.starts !== null && shift.starts >= now && shift.starts < window) {
      out.push(warn("uncovered", `This ${label} has nobody on it.`));
    }
    return out;
  }
  if (!shift.account) return out;
  const name = await nameOf(ctx, shift.account);
  // Whether someone is away is told only to them and to whoever may roster (admins, and anyone
  // granted the rosterers' permission, ADR 0625). Other staff never learn it, not even from a
  // write's answer. In a pack tool's run, "who" is the account the tool was called for.
  const mayKnow = actingAccount(ctx) === shift.account || (await mayRoster(ctx));
  if (mayKnow && shift.starts !== null && shift.ends !== null && shift.ends > shift.starts) {
    if (await awayOver(ctx, shift.account, shift.starts, shift.ends)) {
      out.push(warn("unavailable", `${name} said they are not available then.`));
    }
  }
  if (shift.kind && !(await qualified(ctx, object, shift.account, shift.kind))) {
    out.push(
      warn("not_qualified", `${name} is not marked as qualified for this kind of ${label}.`),
    );
  }
  return out;
}

/**
 * What a staffed record would be made with (`staffing.check`, ADR 0622): its warnings and any
 * clash, as it is or with `account` as its person (null: nobody). Writes nothing.
 */
export async function checkShift(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
  account?: string | null,
): Promise<{ warnings: StaffWarning[]; clash: Awaited<ReturnType<typeof described>> | null }> {
  const stored = (await shiftOf(ctx, object, values)) as Shift;
  const shift: Shift =
    account === undefined ? stored : { ...stored, covered: account !== null, account };
  const claim = claimOf(shift);
  const clash = claim ? await clashWith(ctx, object.name, id, claim) : null;
  return {
    warnings: await warningsFor(ctx, object, id, shift),
    clash: clash ? await described(ctx, clash) : null,
  };
}
