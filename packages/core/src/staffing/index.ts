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
import type { Kysely } from "kysely";
import { ConflictError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition, StaffedDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import {
  isoWeekday,
  localParts,
  parseLocalTime,
  wallClockOf,
  wallClockToInstant,
} from "../time/local.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";

/** How far ahead an uncovered live shift is warned about (days). Rostering's setting, step 4. */
export const UNCOVERED_WINDOW_DAYS = 14;

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
}

const batches = new WeakMap<object, StaffBatch>();

/** What this batch has queued (keyed on the context's `write`, shared by the whole batch). */
function batchOf(ctx: { write: object }): StaffBatch {
  let state = batches.get(ctx.write);
  if (!state) {
    state = { claims: new Map(), warnings: new Map() };
    batches.set(ctx.write, state);
  }
  return state;
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
async function described(ctx: HandlerContext, clash: Clash) {
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

/** Notes a claim written (or released, null) by this batch, for the batch's later reads. */
function noteClaim(ctx: { write: object }, object: string, id: string, claim: Claim | null) {
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
): Promise<void> {
  if (!object.staffed) return;
  const shift = (await shiftOf(ctx, object, after)) as Shift;
  const claim = claimOf(shift);
  if (claim) {
    const clash = await clashWith(ctx, object.name, id, claim);
    if (clash) throw await doubleBooked(ctx, object.name, id, claim, clash);
  }
  noteClaim(ctx, object.name, id, claim);
  const warnings = changesStaffing(object, before, after)
    ? await warningsFor(ctx, object, id, shift)
    : [];
  batchOf(ctx).warnings.set(key(object.name, id), warnings);
}

/** A staffed record sent to the Trash (or removed): it claims nothing now. */
export function staffedReleased(ctx: { write: object }, object: ObjectDefinition, id: string) {
  if (object.staffed) noteClaim(ctx, object.name, id, null);
}

/** The stored values a staffed record's claim reads, in or out of the Trash (a restore). */
async function storedShiftValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<Record<string, unknown> | null> {
  const def = object.staffed;
  const table = objectTableOf(object.name);
  if (!def || !table) return null;
  const fields = [def.who.field, def.starts, def.ends, def.kind, object.states?.field].filter(
    (f): f is string => typeof f === "string",
  );
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
  if (values) await staffedWritten(ctx, object, id, null, values);
}

/**
 * A record that holds the account of other objects' shifts (a coach profile) written: a new
 * account takes over every live shift that names it, so each is checked as a write of its own.
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
    const table = objectTableOf(staffed.name);
    const whoColumn = staffed.fields.find((f) => f.name === def.who.field)?.column;
    if (!table || !whoColumn) continue;
    const rows = (await (ctx.db as AnyDb)
      .selectFrom(table)
      .select("id")
      .where(whoColumn, "=", id)
      .where("deleted_at", "is", null)
      .execute()) as { id: string }[];
    for (const row of rows) {
      const values = await storedShiftValues(ctx, staffed, row.id);
      if (!values) continue;
      const shift = (await shiftOf(ctx, staffed, values)) as Shift;
      const claim = claimOf({ ...shift, account });
      if (claim) {
        const clash = await clashWith(ctx, staffed.name, row.id, claim);
        if (clash) throw await doubleBooked(ctx, staffed.name, row.id, claim, clash);
      }
      noteClaim(ctx, staffed.name, row.id, claim);
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

/** Whether `account` may do the kind of work `kind` names: a live kind record, and qualified. */
async function qualified(
  ctx: HandlerContext,
  object: ObjectDefinition,
  account: string,
  kind: string,
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
  if (!row) return false;
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
  const rows = await ctx.db
    .selectFrom("core_staff_away")
    .selectAll()
    .where("account_id", "=", account)
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
    const window = now + UNCOVERED_WINDOW_DAYS * 86_400;
    if (shift.starts !== null && shift.starts >= now && shift.starts < window) {
      out.push(warn("uncovered", `This ${label} has nobody on it.`));
    }
    return out;
  }
  if (!shift.account) return out;
  const name = await nameOf(ctx, shift.account);
  if (shift.starts !== null && shift.ends !== null && shift.ends > shift.starts) {
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
