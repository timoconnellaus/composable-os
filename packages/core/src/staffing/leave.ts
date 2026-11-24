// Leave (stage 58 step 4, ADR 0853): what a request covers, the amounts the host proposes, the
// balance ledger, and what approving leave does to the roster. The operations are
// operations/staffing-leave.ts.
//
// A request is whole local days, or one date with a local start and end time, in the
// organisation's zone; its range as instants is worked out once, when asked, and kept on it. The
// host proposes each date's amount from the person's rostered minutes that day (an hours type) or
// one day each (a days type): a hint the person and the approver may change, never a pay rule.
// The balance is the sum of the ledger (`core_leave_balance_entry`); the host never accrues.
//
// Approved leave is unavailability (ADR 0622's row, naming the request), and it takes the person
// off each covered shift that has not started and offers it to everyone eligible (decision 7),
// through the same statements as `staffing.assign` (the record write) and `staffing.offer`
// (`takeOffShifts`, operations/staffing-leave.ts).
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import type { NotificationLink } from "../notifications/types.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { addLocalDays, parseLocalDate, parseLocalTime, wallClockToInstant } from "../time/local.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { shiftTitle } from "./changes.ts";
import { ELIGIBLE_MAX } from "./eligibility.ts";
import { kindObjectOf, loadShift, type StoredShift } from "./index.ts";
import { actingAccount } from "./rosterers.ts";
import { awayIn, awayRowsOf, claimsOf, clashIn, profilesOf } from "./sets.ts";

/** The most dates one request covers (two months: longer leave is asked for in parts). */
export const MAX_LEAVE_DAYS = 62;
/**
 * The most shifts one approval takes someone off (each is a record write and an offer). A
 * person on more covered shifts than this is refused, whole, with what to do.
 */
export const MAX_TAKEN_OFF = 40;
/** The most an amount may be: a day's minutes (hours type) or one whole day (days type). */
export const MAX_AMOUNT = { hours: 1440, days: 100 } as const;

export type LeaveUnit = "hours" | "days";

/** What a request covers: its dates, and its range as unix seconds (half-open). */
export interface LeaveRange {
  dates: string[];
  starts: number;
  ends: number;
  /** Each date's first and last instant (unix seconds), clipped to the range. */
  days: { date: string; starts: number; ends: number }[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateText = (d: { year: number; month: number; day: number }) =>
  `${String(d.year).padStart(4, "0")}-${pad(d.month)}-${pad(d.day)}`;
const at = (d: { year: number; month: number; day: number }, minutes: number, zone: string) =>
  wallClockToInstant({ ...d, hour: Math.floor(minutes / 60), minute: minutes % 60 }, zone) / 1000;

/**
 * The range of whole local days `startDate`..`endDate`, or of one date from `startTime` to
 * `endTime`, in `zone`. Refuses what is not a real date or time, an end before the start, and more
 * than MAX_LEAVE_DAYS dates.
 */
export function leaveRange(
  zone: string,
  input: { startDate: string; endDate?: string | undefined; startTime?: string; endTime?: string },
): LeaveRange {
  const first = parseLocalDate(input.startDate);
  if (!first) throw new ValidationError(`${input.startDate} is not a date`, { field: "startDate" });
  const endDate = input.endDate ?? input.startDate;
  const last = parseLocalDate(endDate);
  if (!last) throw new ValidationError(`${endDate} is not a date`, { field: "endDate" });
  if (endDate < input.startDate) {
    throw new ValidationError("It must end on or after its first date", { field: "endDate" });
  }
  if ((input.startTime === undefined) !== (input.endTime === undefined)) {
    throw new ValidationError("Part of a day needs a start time and an end time", {
      field: input.startTime === undefined ? "startTime" : "endTime",
    });
  }
  if (input.startTime !== undefined && input.endTime !== undefined) {
    if (endDate !== input.startDate) {
      throw new ValidationError("Part of a day is one date: leave out the end date", {
        field: "endDate",
      });
    }
    const from = parseLocalTime(input.startTime);
    const to = parseLocalTime(input.endTime);
    if (from === null) throw new ValidationError("Not a time", { field: "startTime" });
    if (to === null) throw new ValidationError("Not a time", { field: "endTime" });
    if (!(to > from)) {
      throw new ValidationError("It must end after it starts", { field: "endTime" });
    }
    const starts = at(first, from, zone);
    const ends = at(first, to, zone);
    return {
      dates: [input.startDate],
      starts,
      ends,
      days: [{ date: input.startDate, starts, ends }],
    };
  }
  const days: LeaveRange["days"] = [];
  for (let d = first, n = 0; dateText(d) <= endDate; d = addLocalDays(d, 1), n++) {
    if (n >= MAX_LEAVE_DAYS) {
      throw new ValidationError(`At most ${MAX_LEAVE_DAYS} days in one request`, {
        field: "endDate",
      });
    }
    days.push({ date: dateText(d), starts: at(d, 0, zone), ends: at(addLocalDays(d, 1), 0, zone) });
  }
  return {
    dates: days.map((d) => d.date),
    starts: days[0]?.starts ?? 0,
    ends: days[days.length - 1]?.ends ?? 0,
    days,
  };
}

/** An account's live covered shifts overlapping `starts`..`ends`, from their claims. */
export async function claimsOver(
  db: Kysely<CoreDatabase>,
  account: string,
  starts: number,
  ends: number,
  limit = 1000,
) {
  return db
    .selectFrom("core_staff_time")
    .select(["object_type", "record_id", "starts", "ends"])
    .where("account_id", "=", account)
    .where("ends", ">", starts)
    .where("starts", "<", ends)
    .orderBy("starts")
    .limit(limit)
    .execute();
}

/**
 * The amount the host proposes for each date: for an hours type, the minutes of the person's
 * shifts that day (a shift counts to the date it starts on, as a pay period counts it; part of a
 * day counts only the rostered minutes inside it); for a days type, one day each.
 */
export async function proposedAmounts(
  db: Kysely<CoreDatabase>,
  account: string,
  unit: LeaveUnit,
  range: LeaveRange,
  partDay: boolean,
): Promise<Map<string, number>> {
  const out = new Map(range.dates.map((d) => [d, unit === "days" ? MAX_AMOUNT.days : 0]));
  if (unit === "days") return out;
  for (const c of await claimsOver(db, account, range.starts, range.ends)) {
    const day = partDay
      ? range.days[0]
      : range.days.find((d) => c.starts >= d.starts && c.starts < d.ends);
    if (!day) continue;
    const minutes = partDay
      ? (Math.min(c.ends, day.ends) - Math.max(c.starts, day.starts)) / 60
      : (c.ends - c.starts) / 60;
    out.set(day.date, Math.min((out.get(day.date) ?? 0) + Math.round(minutes), MAX_AMOUNT.hours));
  }
  return out;
}

/** The balance of `account` in `type`: the ledger's sum. */
export async function balanceOf(
  db: Kysely<CoreDatabase>,
  account: string,
  type: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_leave_balance_entry")
    .select(sql<number>`coalesce(sum(amount), 0)`.as("balance"))
    .where("account_id", "=", account)
    .where("type_id", "=", type)
    .executeTakeFirst();
  return Number(row?.balance ?? 0);
}

/** Whether a locked pay period (or one being locked) holds any date of `from`..`to`. */
export async function lockedOver(
  db: Kysely<CoreDatabase>,
  from: string,
  to: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("core_pay_period")
    .select("id")
    .where("state", "in", ["locking", "locked"])
    .where("start_date", "<=", to)
    .where("end_date", ">=", from)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/** The refusal of leave inside a locked pay period (it names no period's totals). */
export function lockedRefusal(): ConflictError {
  return new ConflictError(
    "This leave is inside a locked pay period, so nothing was changed. Whoever handles pay reopens the period first.",
    { rule: "pay_period_locked" },
  );
}

/** A shift as a leave answer names it. */
export interface CoveredShift {
  object: string;
  id: string;
  title: string;
  startsAt: string;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The account's shifts the range covers that have not started: how many (from their claims, one
 * read), and the first `load` of them loaded.
 */
export async function coveredShifts(
  ctx: HandlerContext,
  account: string,
  range: { starts: number; ends: number },
  load = MAX_TAKEN_OFF,
): Promise<{ shifts: StoredShift[]; count: number }> {
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  const claims = (
    await claimsOver(ctx.db, account, Math.max(range.starts, now), range.ends)
  ).filter((c) => c.starts > now);
  const shifts: StoredShift[] = [];
  for (const c of claims.slice(0, load)) {
    const s = await loadShift(ctx, c.object_type, c.record_id);
    if (s && !s.deleted && s.shift.live) shifts.push(s);
  }
  return { shifts, count: claims.length };
}

export function coveredOf(s: StoredShift): CoveredShift {
  return {
    object: s.object.name,
    id: s.id,
    title: shiftTitle(s.object, s.values),
    startsAt: iso(s.shift.starts ?? 0),
  };
}

/**
 * Who each of `shifts` may be offered to (as `eligibleAccounts` decides it for one: qualified for
 * its kind, active, with a profile its person field can name, not away over it, free), read once
 * for all of them, whatever their kinds: the qualified people of every kind (at most ELIGIBLE_MAX
 * a kind, as an offer reads), which kinds are live, who is active, everyone's unavailability and
 * claims over the shifts' whole span (stage 45's sets.ts) and the profiles, in a few set-based
 * reads; then checked in memory. Keyed by object and id; `exclude` is never offered one.
 */
export async function eligibleForShifts(
  ctx: HandlerContext,
  shifts: readonly StoredShift[],
  exclude: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const timed = shifts.filter(
    (s) =>
      kindObjectOf(s.object) &&
      s.shift.kind &&
      s.shift.starts !== null &&
      s.shift.ends !== null &&
      s.shift.ends > s.shift.starts,
  );
  if (!timed.length) return out;
  const kindKey = (object: string, kind: string) => `${object}\u0000${kind}`;
  const kindsByObject = new Map<string, Set<string>>();
  for (const s of timed) {
    const object = kindObjectOf(s.object) as string;
    kindsByObject.set(object, (kindsByObject.get(object) ?? new Set()).add(s.shift.kind as string));
  }
  // Each kind's qualified people (one read per kind object), and which kinds are live (one more).
  const qualified = new Map<string, string[]>();
  const live = new Set<string>();
  for (const [object, kinds] of kindsByObject) {
    const rows = await ctx.db
      .selectFrom("core_staff_qualification")
      .select(["kind_record", "account_id"])
      .where("kind_object", "=", object)
      .where("kind_record", "in", jsonList([...kinds]))
      .orderBy("kind_record")
      .orderBy("account_id")
      .limit(ELIGIBLE_MAX * kinds.size)
      .execute();
    for (const r of rows) {
      const list = qualified.get(kindKey(object, r.kind_record)) ?? [];
      if (list.length < ELIGIBLE_MAX && !exclude.has(r.account_id)) list.push(r.account_id);
      qualified.set(kindKey(object, r.kind_record), list);
    }
    const target = getObject(object);
    if (!target) continue;
    const found = (await ctx.db
      .selectFrom(visibleSource(orgReader(ctx.db), target))
      .select("id")
      .where("id", "in", jsonList([...kinds]))
      .execute()) as { id: string }[];
    for (const r of found) live.add(kindKey(object, r.id));
  }
  const candidates = [...new Set([...qualified.values()].flat())];
  if (!candidates.length) return out;
  const active = new Set<string>();
  for (const part of chunk(candidates)) {
    const rows = await ctx.db
      .selectFrom("core_user")
      .select("id")
      .where("id", "in", jsonList(part))
      .where("kind", "=", "human")
      .where("deactivated_at", "is", null)
      .execute();
    for (const r of rows) active.add(r.id);
  }
  const people = candidates.filter((a) => active.has(a));
  if (!people.length) return out;
  const lo = Math.min(...timed.map((s) => s.shift.starts as number));
  const hi = Math.max(...timed.map((s) => s.shift.ends as number));
  const away = await awayRowsOf(ctx, people, lo, hi);
  const claims = await claimsOf(ctx, people, lo, hi);
  const profiles = new Map<string, Map<string, string>>();
  for (const s of timed) {
    if (!profiles.has(s.object.name)) {
      profiles.set(s.object.name, await profilesOf(ctx, s.object, people));
    }
  }
  for (const s of timed) {
    const key = kindKey(kindObjectOf(s.object) as string, s.shift.kind as string);
    // A kind in the Trash or gone qualifies nobody.
    if (!live.has(key)) continue;
    const named = profiles.get(s.object.name) as Map<string, string>;
    const starts = s.shift.starts as number;
    const ends = s.shift.ends as number;
    const self = { object: s.object.name, id: s.id };
    out.set(
      `${s.object.name}\u0000${s.id}`,
      (qualified.get(key) ?? []).filter(
        (a) =>
          active.has(a) &&
          named.has(a) &&
          !awayIn(away.get(a), starts, ends) &&
          !clashIn(claims.get(a), starts, ends, self),
      ),
    );
  }
  return out;
}

/**
 * One statement writing each notice (in-app, delivered by email as each person's preferences say,
 * as `queueNotice` writes them), for people the caller has already read as active staff: one
 * bound value however many. The caller is never told what it just did. Null when there is none.
 */
export function noticesStatement(
  ctx: HandlerContext,
  notices: readonly {
    to: string;
    title: string;
    body: string;
    link: NotificationLink | null;
  }[],
): CompiledQuery | null {
  const me = actingAccount(ctx);
  const rows = notices
    .filter((n) => n.to && n.to !== me)
    .map((n) => ({
      id: newId("notification"),
      to: n.to,
      title: n.title.slice(0, 200),
      body: n.body,
      link: n.link ? JSON.stringify(n.link) : null,
    }));
  if (!rows.length) return null;
  return CompiledQuery.raw(
    "INSERT OR IGNORE INTO core_notifications (id, user_id, type, title, body, link, source, dedupe_key, human_only, read_at, created_at) SELECT json_extract(value, '$.id'), json_extract(value, '$.to'), 'system.message', json_extract(value, '$.title'), json_extract(value, '$.body'), json_extract(value, '$.link'), ?, NULL, 0, NULL, ? FROM json_each(?)",
    [JSON.stringify({ actor: ctx.actor, userId: me }), ctx.now, JSON.stringify(rows)],
  );
}
