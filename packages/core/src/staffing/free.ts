// Free times and the customer's check (stage 49 step 4, ADRs 0762 and 0763): the start times at
// which a shift that is booked (`staffed.open`, an appointment) can be made now, worked out at
// read time and never stored, so nothing goes stale.
//
// A start time is free for a provider when their open hours (for the kind) cover the whole shift,
// they are not away over it, its claim with the kind's margins overlaps none of theirs, an allowed
// room is free (the first, in the kind's order), no closure covers its dates, the client has no
// live shift of the object overlapping it and, for a customer or the public, it is inside the
// create rules' window. Worked in the organisation's zone by wall clock: start times sit on the
// kind's step counted from local midnight, across a clock change and overnight hours. Only
// qualified providers are read. The answer says which times are free and for whom, never why
// one is not.
//
// Bounded: at most 31 days and 20 providers a call, in a fixed number of reads however many
// times, claims or hours there are (a statement count holds it, staffing-free.test.ts).
// The database still decides a race: the claims' triggers refuse whichever batch commits second.
import { CompiledQuery, type Kysely, sql } from "kysely";
import { addDaysToDate } from "../automations/cron.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { fieldStorage, objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, StaffedOpenDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { pathReader, staffOnlySet, windowJudge } from "../records/windows.ts";
import { loadGeneralSettings } from "../settings.ts";
import { localParts, wallClockOf, wallClockToInstant } from "../time/local.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { type KindRef, openRanges, type Range } from "./hours.ts";
import { queuedClaims } from "./index.ts";
import { kindObjectOf } from "./kinds.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

/** The longest range one call reads: 31 days of start times. */
export const FREE_MAX_DAYS = 31;
/** The most providers one call reads. */
export const FREE_MAX_PROVIDERS = 20;
/** Minutes between start times when the kind gives none. */
export const DEFAULT_STEP_MINUTES = 30;

/** Someone who gives the kind of work: the shift's person value (a coach profile) and account. */
export interface Provider {
  who: string;
  account: string;
}

/** A free start time: the shift's own time, who is free then, and the rooms free for it. */
export interface FreeTime {
  starts: number;
  ends: number;
  providers: Provider[];
  /** The allowed rooms free then, in the kind's order; empty when the kind needs none. */
  rooms: string[];
}

export interface FreeQuery {
  object: ObjectDefinition;
  kind: string;
  /** Start times from `from` (inclusive) to `to` (exclusive), unix seconds. */
  from: number;
  to: number;
  /** Only these providers (the shift's person values); left out, every qualified one. */
  providers?: readonly string[] | undefined;
  /** The client: their own live shifts of the object are not free for them. */
  client?: string | null | undefined;
  /** A record of the object being moved: its own claims do not count against it. */
  exclude?: string | null | undefined;
  /** Judge the object's create rules (window, staff-only flag) as a customer's create is. */
  customerRules: boolean;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const secondsOf = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const key = (object: string, id: string) => `${object}\u0000${id}`;
/** Minutes as the claim's triggers read them: a whole number from 0 to 1,440, as seconds. */
const marginSecondsOf = (value: unknown) => {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) ? Math.max(0, Math.min(1440, n)) * 60 : 0;
};
const ids = (value: unknown): string[] => {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = [value];
    }
  }
  return Array.isArray(list) ? [...new Set(list.filter((v): v is string => !!text(v)))] : [];
};

/**
 * Open intervals of start times that are not free, sorted and merged so a lookup is a binary
 * search. A start `s` is blocked by (l, r) when l < s < r.
 */
function merged(intervals: Range[]): Range[] {
  const sorted = intervals.filter((i) => i.ends > i.starts).sort((a, b) => a.starts - b.starts);
  const out: Range[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.starts < last.ends) last.ends = Math.max(last.ends, i.ends);
    else out.push({ ...i });
  }
  return out;
}

/** Whether `s` lies inside one of the merged open intervals. */
function blocked(list: readonly Range[], s: number): boolean {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Range).starts < s) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && s < (list[found] as Range).ends;
}

/** Whether the merged open-hours ranges hold the whole of `s`..`s + length`. */
function covered(ranges: readonly Range[], s: number, length: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid] as Range).starts <= s) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && s + length <= (ranges[found] as Range).ends;
}

/** A field's column on an object, from the registry. */
const columnOf = (object: ObjectDefinition | undefined, field: string | undefined) =>
  field ? object?.fields.find((f) => f.name === field)?.column : undefined;
/** The kind's field a `kind.field` path names. */
const kindLocal = (path: { field: string } | undefined) => path?.field.split(".")[1];

/** What a kind record says about its shifts: length, step, rooms and margins, in seconds. */
interface KindFacts {
  length: number;
  step: number;
  rooms: string[] | null;
  claimBefore: number;
  claimAfter: number;
  roomBefore: number;
  roomAfter: number;
}

/** The kind record's facts, read once, org-wide (the caller's reach to it is the operation's). */
async function kindFacts(
  ctx: HandlerContext,
  object: ObjectDefinition,
  open: StaffedOpenDefinition,
  kind: string,
): Promise<KindFacts | null> {
  const def = object.staffed;
  const kindName = kindObjectOf(object);
  const target = kindName ? getObject(kindName) : undefined;
  if (!def || !target) return null;
  const wanted: Record<string, string | undefined> = {
    length: kindLocal(open.length),
    step: kindLocal(open.step),
    rooms: kindLocal(open.rooms),
    claimBefore: kindLocal(def.claimBefore),
    claimAfter: kindLocal(def.claimAfter),
    // The room's margins, when read through the kind (a service's buffer).
    roomBefore:
      object.occupies?.before?.via === def.kind ? object.occupies.before.field : undefined,
    roomAfter: object.occupies?.after?.via === def.kind ? object.occupies.after.field : undefined,
  };
  const selected = Object.entries(wanted).flatMap(([as, field]) => {
    // A list (the rooms) is a JSON column the registry reads through `related`.
    const column = columnOf(target, field) ?? (field && fieldStorage(target.name, field)?.column);
    return column ? [`${column} as ${as}`] : [];
  });
  const row = (await (ctx.db as AnyDb)
    .selectFrom(visibleSource(orgReader(ctx.db), target))
    .select(["id", ...selected])
    .where("id", "=", kind)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!row) return null;
  const minutes = Number(row.length);
  const step = Math.trunc(Number(row.step));
  return {
    length: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0,
    step: (Number.isFinite(step) && step >= 5 && step <= 1440 ? step : DEFAULT_STEP_MINUTES) * 60,
    rooms: open.rooms ? ids(row.rooms) : null,
    claimBefore: marginSecondsOf(row.claimBefore),
    claimAfter: marginSecondsOf(row.claimAfter),
    roomBefore: marginSecondsOf(row.roomBefore),
    roomAfter: marginSecondsOf(row.roomAfter),
  };
}

/** The qualified providers of a kind, at most 20, in order of their person value. */
async function providersOf(
  ctx: HandlerContext,
  object: ObjectDefinition,
  kindObject: string,
  kind: string,
  only: readonly string[] | undefined,
): Promise<Provider[]> {
  const def = object.staffed;
  if (!def || (only && !only.length)) return [];
  const filter = only ? JSON.stringify([...new Set(only)].slice(0, FREE_MAX_PROVIDERS)) : null;
  let rows: { who: string; account: string }[];
  if (def.who.account) {
    const holder = def.who.object ? getObject(def.who.object) : undefined;
    const table = holder ? objectTableOf(holder.name) : undefined;
    const column = columnOf(holder, def.who.account);
    if (!table || !column) return [];
    rows = (
      await sql<{ who: string; account: string }>`
        SELECT h.id AS who, h.${sql.ref(column)} AS account FROM ${sql.table(table)} h
        JOIN core_staff_qualification q ON q.account_id = h.${sql.ref(column)}
          AND q.kind_object = ${kindObject} AND q.kind_record = ${kind}
        JOIN core_user u ON u.id = h.${sql.ref(column)} AND u.deactivated_at IS NULL
        WHERE h.deleted_at IS NULL
          AND (${filter} IS NULL OR h.id IN (SELECT value FROM json_each(${filter ?? "[]"})))
        ORDER BY h.id LIMIT ${FREE_MAX_PROVIDERS}`.execute(ctx.db)
    ).rows;
  } else {
    rows = (
      await sql<{ who: string; account: string }>`
        SELECT q.account_id AS who, q.account_id AS account FROM core_staff_qualification q
        JOIN core_user u ON u.id = q.account_id AND u.deactivated_at IS NULL
        WHERE q.kind_object = ${kindObject} AND q.kind_record = ${kind}
          AND (${filter} IS NULL OR q.account_id IN (SELECT value FROM json_each(${filter ?? "[]"})))
        ORDER BY q.account_id LIMIT ${FREE_MAX_PROVIDERS}`.execute(ctx.db)
    ).rows;
  }
  // One profile per account: two profiles of one person are one person's time.
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.account) && seen.add(r.account));
}

/** The org's local midnight starting `date`, unix seconds. */
const midnight = (date: string, zone: string) =>
  wallClockToInstant(wallClockOf(date, 0), zone) / 1000;

/**
 * The start times on the step, from `from` to `to`, by the org's wall clock: each a whole number
 * of steps after its local midnight, so a clock change keeps 09:00 and 09:30 where they are.
 */
function grid(from: number, to: number, step: number, zone: string): number[] {
  const out: number[] = [];
  const align = (t: number) => {
    const parts = localParts(t * 1000, zone);
    const into = (parts.minuteOfDay * 60 + parts.second) % step;
    return into === 0 ? t : t + (step - into);
  };
  for (let s = align(from); s < to; s = align(s + step)) out.push(s);
  return out;
}

/** The free start times a query asks for (see the top of this file). Reads only; writes nothing. */
export async function freeTimes(ctx: HandlerContext, query: FreeQuery): Promise<FreeTime[]> {
  const { object } = query;
  const def = object.staffed;
  const open = def?.open;
  const kindObject = kindObjectOf(object);
  const table = objectTableOf(object.name);
  if (!def || !open || !kindObject || !table) return [];
  const facts = await kindFacts(ctx, object, open, query.kind);
  if (!facts) throw new NotFoundError(kindObject, query.kind);
  const { length, step } = facts;
  if (!length) return [];
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  // Never a time that has started.
  const from = Math.max(query.from, now + 1);
  const to = Math.min(query.to, query.from + FREE_MAX_DAYS * 86_400);
  if (!(to > from)) return [];
  const providers = await providersOf(ctx, object, kindObject, query.kind, query.providers);
  if (!providers.length) return [];
  const accounts = JSON.stringify(providers.map((p) => p.account));
  const zone = (await loadGeneralSettings(ctx.db)).timezone;
  // What a shift starting in from..to can touch, margins included.
  const lo = from - Math.max(facts.claimBefore, facts.roomBefore);
  const hi = to + length + Math.max(facts.claimAfter, facts.roomAfter);
  const firstDate = addDaysToDate(localParts(lo * 1000, zone).date, -2);
  const lastDate = localParts(hi * 1000, zone).date;

  // The customer's create rules: nothing is free for them when only staff book it.
  const states = object.states;
  const rules = query.customerRules ? states?.create : undefined;
  const values: Record<string, unknown> = {
    [def.kind]: query.kind,
    ...(def.zone ? { [def.zone]: zone } : {}),
    ...(states ? { [states.field]: states.initial } : {}),
  };
  // Read org-wide, as the engine reads a customer's own create (a service's staff-only flag is
  // not the public's to read, yet it binds them).
  const host = Object.create(ctx, {
    principal: { value: orgReader(ctx.db).principal },
  }) as HandlerContext;
  const reader = pathReader(host, object, values);
  if (rules?.staffOnly && (await staffOnlySet(reader, rules.staffOnly))) return [];

  const [hours, away, claims] = await Promise.all([
    sql<{
      account_id: string;
      kind: "weekly" | "extra";
      weekdays: string | null;
      start_time: string | null;
      end_time: string | null;
      from_date: string | null;
      until_date: string | null;
      starts_at: string | null;
      ends_at: string | null;
      zone: string;
      only_for: string | null;
    }>`SELECT account_id, kind, weekdays, start_time, end_time, from_date, until_date, starts_at,
        ends_at, zone, only_for FROM core_staff_hours
      WHERE account_id IN (SELECT value FROM json_each(${accounts}))`.execute(ctx.db),
    // Only time off that can still overlap: one-off ranges ending after the earliest start,
    // regular rules not ended before its first local date.
    sql<{
      account_id: string;
      kind: string;
      weekdays: string | null;
      start_time: string | null;
      end_time: string | null;
      from_date: string | null;
      until_date: string | null;
      starts_at: string | null;
      ends_at: string | null;
      zone: string;
    }>`SELECT account_id, kind, weekdays, start_time, end_time, from_date, until_date, starts_at,
        ends_at, zone FROM core_staff_away
      WHERE account_id IN (SELECT value FROM json_each(${accounts}))
        AND ((kind != 'regular' AND ends_at > ${iso(from)} AND starts_at < ${iso(to + length)})
          OR (kind = 'regular' AND (until_date IS NULL OR until_date >= ${firstDate})))`.execute(
      ctx.db,
    ),
    sql<{
      account_id: string;
      object_type: string;
      record_id: string;
      starts: number;
      ends: number;
    }>`
      SELECT account_id, object_type, record_id, starts, ends FROM core_staff_time
      WHERE account_id IN (SELECT value FROM json_each(${accounts}))
        AND starts < ${hi} AND ends > ${lo}`.execute(ctx.db),
  ]);

  // Shared by every provider: closures, the client's own shifts, then the rooms.
  const shared: Range[] = [];
  const closure = open.closedBy ? getObject(open.closedBy.object) : undefined;
  const fromCol = columnOf(closure, open.closedBy?.from);
  const untilCol = columnOf(closure, open.closedBy?.until);
  if (closure && fromCol && untilCol) {
    const rows = (await (ctx.db as AnyDb)
      .selectFrom(visibleSource(orgReader(ctx.db), closure))
      .select([`${fromCol} as from`, `${untilCol} as until`])
      .where(fromCol, "<=", lastDate)
      .where(untilCol, ">=", firstDate)
      .execute()) as { from: string | null; until: string | null }[];
    for (const r of rows) {
      if (!r.from || !r.until || r.until < r.from) continue;
      // Closed from its first local midnight to the one after its last date.
      shared.push({
        starts: midnight(r.from, zone) - length,
        ends: midnight(addDaysToDate(r.until, 1), zone),
      });
    }
  }
  const clientCol = columnOf(object, open.client);
  const startsCol = columnOf(object, def.starts);
  const endsCol = columnOf(object, def.ends);
  const stateCol = columnOf(object, states?.field);
  if (query.client && clientCol && startsCol && endsCol && stateCol) {
    const s = sql.raw(`CAST(strftime('%s', ${startsCol}) AS INTEGER)`);
    const e = sql.raw(`CAST(strftime('%s', ${endsCol}) AS INTEGER)`);
    const rows = await sql<{ starts: number; ends: number }>`
      SELECT ${s} AS starts, ${e} AS ends FROM ${sql.table(table)}
      WHERE ${sql.ref(clientCol)} = ${query.client} AND deleted_at IS NULL
        AND ${sql.ref(stateCol)} IN (SELECT value FROM json_each(${JSON.stringify(def.live)}))
        AND id != ${query.exclude ?? ""} AND ${s} < ${to + length} AND ${e} > ${from}`.execute(
      ctx.db,
    );
    for (const r of rows.rows) shared.push({ starts: r.starts - length, ends: r.ends });
  }
  const closed = merged(shared);

  // Rooms: the kind's, in order. One that is not claimed (not marked one booking at a time) is
  // always free; one in the Trash or gone is never offered.
  let rooms: { id: string; taken: Range[] | null }[] | null = null;
  if (facts.rooms?.length && object.occupies) {
    const occupies = object.occupies;
    const thing = getObject(occupies.thingObject);
    const onlyCol = columnOf(thing, occupies.only);
    const roomIds = JSON.stringify(facts.rooms);
    const found = thing
      ? ((await (ctx.db as AnyDb)
          .selectFrom(visibleSource(orgReader(ctx.db), thing))
          .select(["id", ...(onlyCol ? [`${onlyCol} as only`] : [])])
          .where("id", "in", sql<string>`(SELECT value FROM json_each(${roomIds}))`)
          .execute()) as { id: string; only?: unknown }[])
      : [];
    const claimed = new Set(
      found.filter((r) => !occupies.only || r.only === 1 || r.only === true).map((r) => r.id),
    );
    const held = claimed.size
      ? (
          await sql<{ thing_record: string; starts: number; ends: number }>`
            SELECT thing_record, starts, ends FROM core_thing_time
            WHERE thing_object = ${occupies.thingObject}
              AND thing_record IN (SELECT value FROM json_each(${JSON.stringify([...claimed])}))
              AND starts < ${hi} AND ends > ${lo}
              AND NOT (object_type = ${object.name} AND record_id = ${query.exclude ?? ""})`.execute(
            ctx.db,
          )
        ).rows
      : [];
    const there = new Set(found.map((r) => r.id));
    rooms = facts.rooms
      .filter((id) => there.has(id))
      .map((id) => ({
        id,
        taken: claimed.has(id)
          ? merged(
              held
                .filter((h) => h.thing_record === id)
                .map((h) => ({
                  starts: h.starts - length - facts.roomAfter,
                  ends: h.ends + facts.roomBefore,
                })),
            )
          : null,
      }));
    if (!rooms.length) return [];
  }

  // Each provider's open hours for the kind, and the start times their own time blocks.
  const kindRef: KindRef = { object: kindObject, id: query.kind };
  const queued = queuedClaims(ctx);
  const self = query.exclude ? key(object.name, query.exclude) : null;
  const plans = providers.map((p) => {
    const ranges = openRanges(
      hours.rows.filter((r) => r.account_id === p.account),
      from,
      to + length,
      kindRef,
    );
    const busy: Range[] = [];
    // Time off, read as open hours are (wall clock, overnight), then as start times it blocks.
    const offs = away.rows
      .filter((r) => r.account_id === p.account)
      .map((r) =>
        r.kind === "regular"
          ? { ...r, kind: "weekly" as const, only_for: null }
          : { ...r, kind: "extra" as const, only_for: null },
      );
    for (const r of openRanges(offs, from, to + length)) {
      busy.push({ starts: r.starts - length, ends: r.ends });
    }
    // Claims, margins included, against this one's claim with its margins.
    const blocks = (starts: number, ends: number) =>
      busy.push({
        starts: starts - length - facts.claimAfter,
        ends: ends + facts.claimBefore,
      });
    for (const c of claims.rows) {
      if (c.account_id !== p.account) continue;
      const k = key(c.object_type, c.record_id);
      if (k === self || queued.has(k)) continue;
      blocks(c.starts, c.ends);
    }
    for (const [k, c] of queued) {
      if (k === self || !c || c.account !== p.account) continue;
      blocks(c.starts, c.ends);
    }
    return { provider: p, ranges, busy: merged(busy) };
  });

  // The customer's window, its numbers read once for every start time.
  const inWindow = rules?.window
    ? await windowJudge(host, reader, rules.window, def.starts)
    : () => true;

  const out: FreeTime[] = [];
  for (const s of grid(from, to, step, zone)) {
    if (blocked(closed, s)) continue;
    const free = plans.filter((p) => covered(p.ranges, s, length) && !blocked(p.busy, s));
    if (!free.length) continue;
    const roomsFree = rooms
      ? rooms.filter((r) => r.taken === null || !blocked(r.taken, s)).map((r) => r.id)
      : [];
    if (rooms && !roomsFree.length) continue;
    if (!inWindow(s * 1000)) continue;
    out.push({
      starts: s,
      ends: s + length,
      providers: free.map((p) => p.provider),
      rooms: roomsFree,
    });
  }
  return out;
}

// --- The customer's check (ADR 0763) -------------------------------------------------------------

/** A refusal of a customer's write that is not on a free time; it never says why. */
function notFree(message: string, field?: string): ConflictError {
  return new ConflictError(message, { rule: "not_free_time", ...(field ? { field } : {}) });
}

/**
 * Whether a write of `object` asks the customer's check: a create, or a change of who, when,
 * what, the room or the client, or a move into a live state.
 */
function asksCheck(
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): boolean {
  const def = object.staffed;
  if (!def?.open?.customer) return false;
  const stateField = object.states?.field;
  const live = (values: Record<string, unknown> | null) =>
    !!values && !!stateField && def.live.includes(values[stateField] as string);
  if (!live(after)) return false;
  if (before === null || !live(before)) return true;
  const same = (f: string | undefined) =>
    !f || JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null);
  return ![
    def.who.field,
    def.starts,
    def.ends,
    def.kind,
    def.open.client,
    object.occupies?.thing,
  ].every(same);
}

/**
 * A customer's or the public's create or move of a booked shift (`staffed.open.customer`) must be
 * on a time `freeTimes` answers (ADR 0763): its provider free then, its length the kind's, and its
 * room one of the kind's free then. Judged in the batch that writes it, by every door (a pack's
 * tool, a customer's record write, the typed client, a held record the host makes for them);
 * the database's triggers still decide a race. Staff are warned instead (`outside_hours`,
 * `client_busy`, beside `unavailable` and `not_qualified`). The create rules' window is the
 * transition engine's own (ADR 0503), judged there with its own answer.
 */
export async function assertOnFreeTime(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  const def = object.staffed;
  const open = def?.open;
  if (!def || !open || !asksCheck(object, before, after)) return;
  const who = text(after[def.who.field]);
  const kind = text(after[def.kind]);
  const starts = secondsOf(after[def.starts]);
  const ends = secondsOf(after[def.ends]);
  if (!who || !kind || starts === null || ends === null) {
    const field = !who ? def.who.field : !kind ? def.kind : def.starts;
    throw new ValidationError(`${object.label}: choose who, what and a free time`, {
      field,
      rule: "not_free_time",
    });
  }
  const [time] = await freeTimes(ctx, {
    object,
    kind,
    from: starts,
    to: starts + 1,
    providers: [who],
    client: open.client ? text(after[open.client]) : null,
    exclude: id,
    customerRules: false,
  });
  if (!time || time.starts !== starts || !time.providers.length) {
    throw notFree("That time is not free. Nothing was changed: choose another free time.");
  }
  if (ends !== time.ends) {
    throw notFree(
      `${object.label}: a free time is ${(time.ends - time.starts) / 60} minutes long`,
      def.ends,
    );
  }
  // The room: exactly one of the kind's, free then; none at all when the kind needs none (a
  // customer never takes a room the service does not use, the review of PR #430).
  const thing = object.occupies?.thing;
  if (thing) {
    const chosen = ids(after[thing]);
    const ok = time.rooms.length
      ? chosen.length === 1 && time.rooms.includes(chosen[0] as string)
      : chosen.length === 0;
    if (!ok) throw notFree("That room is not free then. Nothing was changed.", thing);
  }
  // The client's other bookings, again inside the batch: the read above cannot see one another
  // batch commits meanwhile (migration 1092).
  const client = open.client ? text(after[open.client]) : null;
  if (client && !ctx.simulation) ctx.write(clientGuard(object, id, client, starts, ends));
}

/**
 * The statement that fails the batch when the client holds another live shift of `object`
 * overlapping `starts`..`ends` once the batch runs (migration 1092): one client's bookings racing
 * each other commit one at most.
 */
function clientGuard(
  object: ObjectDefinition,
  id: string | null,
  client: string,
  starts: number,
  ends: number,
): CompiledQuery {
  const def = object.staffed as NonNullable<ObjectDefinition["staffed"]>;
  const table = objectTableOf(object.name) as string;
  const col = (f: string | undefined) => columnOf(object, f) as string;
  const s = `CAST(strftime('%s', ${col(def.starts)}) AS INTEGER)`;
  const e = `CAST(strftime('%s', ${col(def.ends)}) AS INTEGER)`;
  return CompiledQuery.raw(
    `INSERT INTO core_client_guard (object_type, record_id, clashes) SELECT ?, ?, count(*) FROM ${table} ` +
      `WHERE ${col(def.open?.client)} = ? AND deleted_at IS NULL AND ${col(object.states?.field)} IN (SELECT value FROM json_each(?)) ` +
      `AND id != ? AND ${s} < ? AND ${e} > ?`,
    [object.name, id ?? "", client, JSON.stringify(def.live), id ?? "", ends, starts],
  );
}

// --- The room the host chooses (stage 49 step 5, ADR 0764) ----------------------------------------

/**
 * The room a new booked shift (`staffed.open.rooms`, an appointment) takes when its writer named
 * none: the first of its kind's rooms free for its time with the room's margins, in the kind's
 * order (a room not marked one booking at a time is always free). Undefined when the host has
 * nothing to choose: a room was named, the kind needs none, or the record is not live or has no
 * time yet. When every room the kind may use is taken it is refused (`conflict`, `rule:
 * "room_taken"`), as the claim's trigger would refuse it, naming no other record. The trigger
 * still decides a race.
 */
export async function hostRoomFor(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<string | undefined> {
  const def = object.staffed;
  const open = def?.open;
  const occupies = object.occupies;
  if (!def || !open?.rooms || !occupies) return undefined;
  if (ids(values[occupies.thing]).length) return undefined;
  const stateField = object.states?.field;
  // A create that names no state starts in the initial one.
  const state = stateField ? (text(values[stateField]) ?? object.states?.initial) : null;
  if (typeof state !== "string" || !occupies.live.includes(state)) return undefined;
  const kind = text(values[def.kind]);
  const starts = secondsOf(values[def.starts]);
  const ends = secondsOf(values[def.ends]);
  if (!kind || starts === null || ends === null || !(ends > starts)) return undefined;
  const facts = await kindFacts(ctx, object, open, kind);
  if (!facts?.rooms?.length) return undefined;
  const thing = getObject(occupies.thingObject);
  const onlyCol = columnOf(thing, occupies.only);
  const found = thing
    ? ((await (ctx.db as AnyDb)
        .selectFrom(visibleSource(orgReader(ctx.db), thing))
        .select(["id", ...(onlyCol ? [`${onlyCol} as only`] : [])])
        .where(
          "id",
          "in",
          sql<string>`(SELECT value FROM json_each(${JSON.stringify(facts.rooms)}))`,
        )
        .execute()) as { id: string; only?: unknown }[])
    : [];
  const there = new Set(found.map((r) => r.id));
  const claimed = found
    .filter((r) => !occupies.only || r.only === 1 || r.only === true)
    .map((r) => r.id);
  const from = starts - facts.roomBefore;
  const to = ends + facts.roomAfter;
  const held = new Set(
    claimed.length
      ? (
          await sql<{ thing_record: string }>`
            SELECT DISTINCT thing_record FROM core_thing_time
            WHERE thing_object = ${occupies.thingObject}
              AND thing_record IN (SELECT value FROM json_each(${JSON.stringify(claimed)}))
              AND starts < ${to} AND ends > ${from}`.execute(ctx.db)
        ).rows.map((r) => r.thing_record)
      : [],
  );
  const free = facts.rooms.find((id) => there.has(id) && !held.has(id));
  if (free) return free;
  throw new ConflictError(
    `No ${(thing?.label ?? "room").toLowerCase()} this ${object.label.toLowerCase()} may use is free then. Nothing was changed: choose another time.`,
    { rule: "room_taken", field: occupies.thing },
  );
}
