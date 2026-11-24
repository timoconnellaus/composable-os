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
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { addLocalDays, parseLocalDate, parseLocalTime, wallClockToInstant } from "../time/local.ts";
import { shiftTitle } from "./changes.ts";
import { ELIGIBLE_MAX } from "./eligibility.ts";
import { kindObjectOf, loadShift, type StoredShift } from "./index.ts";
import { awayIn, awayRowsOf, claimsOf, clashIn, profilesOf, qualifiedOf } from "./sets.ts";

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
 * for all of them: per kind its qualified people, then their accounts, profiles, unavailability
 * and claims over the shifts' whole span in a few set-based reads (stage 45's sets.ts), checked
 * in memory. Keyed by object and id; `exclude` is never offered one.
 */
export async function eligibleForShifts(
  ctx: HandlerContext,
  shifts: readonly StoredShift[],
  exclude: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const timed = shifts.filter(
    (s) => s.shift.starts !== null && s.shift.ends !== null && s.shift.ends > s.shift.starts,
  );
  const groups = new Map<string, { kindObject: string; kind: string; shifts: StoredShift[] }>();
  for (const s of timed) {
    const kindObject = kindObjectOf(s.object);
    if (!kindObject || !s.shift.kind) continue;
    const key = `${kindObject}\u0000${s.shift.kind}`;
    const group = groups.get(key) ?? { kindObject, kind: s.shift.kind, shifts: [] };
    group.shifts.push(s);
    groups.set(key, group);
  }
  for (const { kindObject, kind, shifts: mine } of groups.values()) {
    const rows = await ctx.db
      .selectFrom("core_staff_qualification")
      .select("account_id")
      .where("kind_object", "=", kindObject)
      .where("kind_record", "=", kind)
      .orderBy("account_id")
      .limit(ELIGIBLE_MAX)
      .execute();
    const candidates = rows.map((r) => r.account_id).filter((a) => !exclude.has(a));
    if (!candidates.length) continue;
    const active = new Set(
      (
        await ctx.db
          .selectFrom("core_user")
          .select("id")
          .where("id", "in", jsonList(candidates))
          .where("kind", "=", "human")
          .where("deactivated_at", "is", null)
          .execute()
      ).map((r) => r.id),
    );
    // A kind in the Trash or gone qualifies nobody.
    const { strict } = await qualifiedOf(ctx, kindObject, kind, [...active]);
    const people = candidates.filter((a) => active.has(a) && strict.has(a));
    if (!people.length) continue;
    const lo = Math.min(...mine.map((s) => s.shift.starts as number));
    const hi = Math.max(...mine.map((s) => s.shift.ends as number));
    const away = await awayRowsOf(ctx, people, lo, hi);
    const claims = await claimsOf(ctx, people, lo, hi);
    const profiles = new Map<string, Map<string, string>>();
    for (const s of mine) {
      if (!profiles.has(s.object.name)) {
        profiles.set(s.object.name, await profilesOf(ctx, s.object, people));
      }
      const named = profiles.get(s.object.name) as Map<string, string>;
      const starts = s.shift.starts as number;
      const ends = s.shift.ends as number;
      const self = { object: s.object.name, id: s.id };
      out.set(
        `${s.object.name}\u0000${s.id}`,
        people.filter(
          (a) =>
            named.has(a) &&
            !awayIn(away.get(a), starts, ends) &&
            !clashIn(claims.get(a), starts, ends, self),
        ),
      );
    }
  }
  return out;
}
