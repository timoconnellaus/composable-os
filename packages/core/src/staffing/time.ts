// Time entries (stage 58 step 1, ADR 0850): the one record of time a staff member worked, at the
// business or on a job, in core_time_entry (migration 1270). What an entry may be against, the
// shift a start proposes, the reads that name an overlap, a locked pay period and a missing
// finish. The operations are operations/staffing-time.ts; the minute cron's part is
// `finishMissing` here, run from staffing/due.ts.
//
// An entry is against a **shift** (a record of a `staffed` object: one of the person's own live
// shifts, read from its time claim in core_staff_time, so a cancelled shift, one in the Trash or
// someone else's is never theirs), a **`workedOn` record** (a job, in one of its live states and
// out of the Trash), or nothing (other work). The host's clock is the record of a clocked entry:
// its start and finish are `ctx.now`, never a time the request carries. No finish is ever
// invented: an entry left open is marked finish missing and its person told.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely, type Selectable, sql } from "kysely";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { shiftTitle } from "./changes.ts";
import { loadShift } from "./index.ts";
import { whenOf } from "./offers.ts";
import { basisOn, localDateOf, periodRange } from "./pay.ts";
import { queueNotice, timeSettings } from "./rosterers.ts";
import { claimsOf, namesOf, notWorkedOf, SET_ROWS_MAX, timeBasesOf } from "./sets.ts";

/** A start proposes the person's own live shift that starts within this many minutes. */
export const PROPOSE_MINUTES = 60;
/** An open entry with no shift is marked finish missing this many hours after its start. */
export const NO_SHIFT_MISSING_HOURS = 14;
/** The longest one entry may be: a stretch of work, not a week. */
export const ENTRY_MAX_HOURS = 24;
/** The most days one read of entries covers. */
export const RANGE_MAX_DAYS = 62;
/** `approved_by` of an entry the host approved: it matched its shift within the tolerance. */
export const HOST = "host";
/** An entry longer than this many hours is flagged among the differences. */
export const LONG_HOURS = 12;
/** The most open entries one cron tick marks. */
const MISSING_PER_TICK = 50;

/** A stored entry. */
export type StoredEntry = Selectable<CoreDatabase["core_time_entry"]>;

/** What an entry is against. */
export interface AgainstRef {
  object: string;
  id: string;
}

/** What an entry is against, as checked: a shift or a workedOn record, and its title. */
export interface Against extends AgainstRef {
  title: string;
  /** A shift (a staffed record); otherwise a workedOn record. */
  shift: boolean;
  /** A shift's own time, unix seconds. */
  starts: number | null;
  ends: number | null;
}

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;

/** Unix seconds of an ISO instant. */
export const secondsOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A local date `days` days from `date` (YYYY-MM-DD). */
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** An instant in unix seconds as ISO. */
export const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The time claim of a shift (a live, covered shift), with the shift's own time (the claim less
 * its margins, ADR 0760), or undefined.
 */
async function claimOf(
  db: Kysely<CoreDatabase>,
  ref: AgainstRef,
): Promise<{ account_id: string; starts: number; ends: number } | undefined> {
  return (await shiftTimesOf(db, [ref])).get(`${ref.object}\u0000${ref.id}`);
}

/**
 * Each shift's claim, by `object\u0000id`: whose it is and the shift's own time (the claim less
 * its margins), one read per object whatever the number of shifts. A cancelled shift, one in the
 * Trash or with nobody on it has no claim, and is left out.
 */
export async function shiftTimesOf(
  db: Kysely<CoreDatabase>,
  refs: readonly AgainstRef[],
): Promise<Map<string, { account_id: string; starts: number; ends: number }>> {
  const out = new Map<string, { account_id: string; starts: number; ends: number }>();
  const byObject = new Map<string, Set<string>>();
  for (const r of refs) byObject.set(r.object, (byObject.get(r.object) ?? new Set()).add(r.id));
  for (const [object, ids] of byObject) {
    const rows = await db
      .selectFrom("core_staff_time")
      .select(["record_id", "account_id", "starts", "ends", "margin_before", "margin_after"])
      .where("object_type", "=", object)
      .where("record_id", "in", jsonList([...ids]))
      .execute();
    for (const r of rows) {
      out.set(`${object}\u0000${r.record_id}`, {
        account_id: r.account_id,
        starts: r.starts + r.margin_before,
        ends: r.ends - r.margin_after,
      });
    }
  }
  return out;
}

/**
 * What `account` may record time against: one of their own live shifts, or a live record of an
 * object that declares `workedOn`. Refused against someone else's shift, a cancelled one, a record
 * in the Trash or not in a live state, and a record of an object that declares neither.
 */
export async function resolveAgainst(
  ctx: HandlerContext,
  account: string,
  ref: AgainstRef,
): Promise<Against> {
  const object = getObject(ref.object);
  if (!object?.staffed && !object?.workedOn) {
    throw new ValidationError(
      `${ref.object} is not something time is recorded against (it declares neither staffed nor workedOn)`,
      { field: "against", rule: "not_worked_on" },
    );
  }
  if (object.staffed) {
    const s = await loadShift(ctx, ref.object, ref.id);
    if (!s) throw new NotFoundError(ref.object, ref.id);
    // Someone else's shift is refused the same way whatever its state: whether a colleague's
    // shift is cancelled or in the Trash is not the caller's to learn here.
    if (s.shift.account !== account) {
      throw new ForbiddenError("This is not one of your shifts, so no time is recorded on it.", {
        rule: "not_your_shift",
      });
    }
    if (s.deleted) throw new NotFoundError(ref.object, ref.id);
    const claim = await claimOf(ctx.db, ref);
    if (!claim || claim.account_id !== account) {
      throw new ConflictError("This shift is cancelled, so no time is recorded against it.", {
        rule: "shift_not_live",
      });
    }
    return {
      ...ref,
      title: shiftTitle(s.object, s.values),
      shift: true,
      starts: claim.starts,
      ends: claim.ends,
    };
  }
  const declared = object.workedOn as NonNullable<ObjectDefinition["workedOn"]>;
  const table = objectTableOf(object.name);
  const state = column(object, object.states?.field);
  if (!table || !state) throw new NotFoundError(ref.object, ref.id);
  const title = column(object, declared.title);
  const row = (
    await sql<{
      deleted_at: string | null;
      state: string | null;
      title: unknown;
    }>`SELECT deleted_at, ${sql.ref(state)} AS state, ${title ? sql.ref(title) : sql`NULL`} AS title FROM ${sql.table(
      table,
    )} WHERE id = ${ref.id}`.execute(ctx.db)
  ).rows[0];
  if (!row || row.deleted_at) throw new NotFoundError(ref.object, ref.id);
  if (!row.state || !declared.live.includes(row.state)) {
    throw new ConflictError(
      `This ${object.label.toLowerCase()} is not open for time to be recorded against it.`,
      { rule: "not_live" },
    );
  }
  return {
    ...ref,
    title: typeof row.title === "string" && row.title ? row.title : object.label,
    shift: false,
    starts: null,
    ends: null,
  };
}

/**
 * The shift a start proposes when it names none: the person's own live shift under way, or the
 * next one starting within PROPOSE_MINUTES (the earliest), read from their time claims.
 */
export async function proposedShift(
  ctx: HandlerContext,
  account: string,
  now: number,
): Promise<Against | null> {
  const claim = await ctx.db
    .selectFrom("core_staff_time")
    .select(["object_type", "record_id"])
    .where("account_id", "=", account)
    .where("ends", ">", now)
    .where("starts", "<=", now + PROPOSE_MINUTES * 60)
    .orderBy("ends")
    .orderBy("starts")
    .limit(1)
    .executeTakeFirst();
  if (!claim) return null;
  return resolveAgainst(ctx, account, { object: claim.object_type, id: claim.record_id });
}

/** The account's entry overlapping [starts, ends) (ends null: open), other than `except`. */
export async function overlapOf(
  db: Kysely<CoreDatabase>,
  account: string,
  starts: number,
  ends: number | null,
  except?: string,
): Promise<{ id: string; starts: number; ends: number | null } | undefined> {
  return (
    await sql<{ id: string; starts: number; ends: number | null }>`
      SELECT id, starts, ends FROM core_time_entry
      WHERE account_id = ${account} AND id != ${except ?? ""}
        AND ifnull(ends, 9223372036854775807) > ${starts}
        AND starts < ifnull(${ends}, 9223372036854775807)
      ORDER BY starts LIMIT 1`.execute(db)
  ).rows[0];
}

/** Refuses an entry overlapping another of the same person's, naming it. */
export async function assertNoOverlap(
  ctx: HandlerContext,
  account: string,
  starts: number,
  ends: number | null,
  except?: string,
): Promise<void> {
  const other = await overlapOf(ctx.db, account, starts, ends, except);
  if (!other) return;
  const from = await whenOf(ctx, other.starts, null);
  const to = other.ends === null ? "still open" : await whenOf(ctx, other.ends, null);
  throw new ConflictError(
    `This overlaps another of your entries (${from} to ${to}), so nothing was changed.`,
    {
      rule: "time_overlap",
      entry: other.id,
      startsAt: isoOf(other.starts),
      endsAt: other.ends === null ? null : isoOf(other.ends),
    },
  );
}

/** Whether the instant `seconds` is inside a locked (or locking) pay period. */
export async function inLockedPeriod(db: Kysely<CoreDatabase>, seconds: number): Promise<boolean> {
  const row = await db
    .selectFrom("core_pay_period")
    .select("id")
    .where("state", "in", ["locking", "locked"])
    .where("starts", "<=", seconds)
    .where("ends", ">", seconds)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * A statement for the batch right after a guarded write: it fails the batch whole
 * (`core_staff_changed`) unless that write changed exactly one row, so an answer never reports
 * a change that was not made (an entry finished, approved or changed a moment before).
 */
export const changedOne = () =>
  CompiledQuery.raw("INSERT INTO core_staff_guard (expected, actual) VALUES (1, changes())");

/** One entry as the person and the screens read it. */
export interface TimeEntryItem {
  id: string;
  account: string;
  state: "open" | "waiting" | "approved" | "rejected";
  how: "clocked" | "entered" | "by_approver";
  startsAt: string;
  endsAt: string | null;
  breakMinutes: number;
  /** Whole minutes from start to finish, less the break; null while open. */
  minutes: number | null;
  zone: string;
  localDate: string;
  against: { object: string; id: string; title: string; shift: boolean } | null;
  finishMissing: boolean;
  note: string | null;
  rejectedWhy: string | null;
  /** Approved by the host (it matched its shift within the tolerance) or by an approver. */
  approval: { by: "host" | "approver"; at: string } | null;
  /** The times as recorded, kept beside when an approver approved it changed. */
  recorded: { startsAt: string; endsAt: string; breakMinutes: number } | null;
  /** Why an approver reopened it (it waits again). */
  reopenedWhy: string | null;
}

/** Minutes an entry counts: whole minutes from start to finish, less its break. */
export const minutesOf = (starts: number, ends: number | null, breakMinutes: number) =>
  ends === null ? null : Math.floor((ends - starts) / 60) - breakMinutes;

/**
 * The titles of what entries are against, read set-based: one read per object, whatever the
 * number of entries.
 */
export async function againstTitles(
  db: Kysely<CoreDatabase>,
  refs: readonly AgainstRef[],
): Promise<Map<string, { title: string; shift: boolean }>> {
  const out = new Map<string, { title: string; shift: boolean }>();
  const byObject = new Map<string, Set<string>>();
  for (const r of refs) byObject.set(r.object, (byObject.get(r.object) ?? new Set()).add(r.id));
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    const table = object ? objectTableOf(object.name) : undefined;
    if (!object || !table) continue;
    const field = column(object, object.workedOn?.title ?? object.titleField);
    const rows = await sql<{ id: string; title: unknown }>`SELECT id, ${
      field ? sql.ref(field) : sql`NULL`
    } AS title FROM ${sql.table(table)} WHERE id IN ${jsonList([...ids])}`.execute(db);
    const titles = new Map(rows.rows.map((r) => [r.id, r.title]));
    for (const id of ids) {
      const title = titles.get(id);
      out.set(`${name}\u0000${id}`, {
        title: typeof title === "string" && title ? title : object.label,
        shift: Boolean(object.staffed),
      });
    }
  }
  return out;
}

/** Entries as the person and the screens read them, titles read set-based. */
export async function itemsOf(
  db: Kysely<CoreDatabase>,
  rows: readonly StoredEntry[],
): Promise<TimeEntryItem[]> {
  const titles = await againstTitles(
    db,
    rows.flatMap((r) =>
      r.against_object && r.against_record
        ? [{ object: r.against_object, id: r.against_record }]
        : [],
    ),
  );
  return rows.map((r) => {
    const against =
      r.against_object && r.against_record
        ? {
            object: r.against_object,
            id: r.against_record,
            ...(titles.get(`${r.against_object}\u0000${r.against_record}`) ?? {
              title: r.against_object,
              shift: false,
            }),
          }
        : null;
    return {
      id: r.id,
      account: r.account_id,
      state: r.state,
      how: r.how,
      startsAt: isoOf(r.starts),
      endsAt: r.ends === null ? null : isoOf(r.ends),
      breakMinutes: r.break_minutes,
      minutes: minutesOf(r.starts, r.ends, r.break_minutes),
      zone: r.zone,
      localDate: r.local_date,
      against,
      finishMissing: r.finish_missing === 1,
      note: r.note,
      rejectedWhy: r.rejected_why,
      approval:
        r.approved_by && r.approved_at
          ? {
              by: r.approved_by === HOST ? ("host" as const) : ("approver" as const),
              at: r.approved_at,
            }
          : null,
      recorded:
        r.recorded_starts !== null && r.recorded_ends !== null
          ? {
              startsAt: isoOf(r.recorded_starts),
              endsAt: isoOf(r.recorded_ends),
              breakMinutes: r.recorded_break_minutes ?? 0,
            }
          : null,
      reopenedWhy: r.reopened_why,
    };
  });
}

/** An entry's stored row, or null. */
export async function entryById(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<StoredEntry | undefined> {
  return db.selectFrom("core_time_entry").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * The open entries whose finish is missing at `now` (unix seconds): against a shift, from
 * `hours` after the shift's end; otherwise NO_SHIFT_MISSING_HOURS after their start. A shift
 * cancelled meanwhile has no claim: the entry is read as one with no shift. Only entries that
 * started at least an hour ago are looked at (a shift's end is after its entry's start), by the
 * index on open entries.
 */
export async function missingFinishes(
  db: Kysely<CoreDatabase>,
  now: number,
  hours: number,
  limit = MISSING_PER_TICK,
): Promise<{ id: string; account_id: string; starts: number; zone: string }[]> {
  return (
    await sql<{ id: string; account_id: string; starts: number; zone: string }>`
      SELECT e.id, e.account_id, e.starts, e.zone FROM core_time_entry e
      LEFT JOIN core_staff_time c
        ON c.object_type = e.against_object AND c.record_id = e.against_record
      WHERE e.ends IS NULL AND e.finish_missing = 0 AND e.starts <= ${now - 3600}
        AND ((c.ends IS NOT NULL AND c.ends + ${hours * 3600} <= ${now})
          OR (c.ends IS NULL AND e.starts + ${NO_SHIFT_MISSING_HOURS * 3600} <= ${now}))
      ORDER BY e.starts LIMIT ${limit}`.execute(db)
  ).rows;
}

/**
 * The minute cron's part (ADR 0850): each open entry past its finish is marked finish missing,
 * and its person told to enter their finish. No finish is written. Guarded, so an entry finished
 * meanwhile is left as it is.
 */
export async function finishMissing(ctx: HandlerContext, hours: number): Promise<number> {
  const due = await missingFinishes(ctx.db, secondsOf(ctx.now), hours);
  for (const entry of due) {
    ctx.write(
      ctx.db
        .updateTable("core_time_entry")
        .set({ finish_missing: 1, updated_at: ctx.now })
        .where("id", "=", entry.id)
        .where("ends", "is", null)
        .where("finish_missing", "=", 0),
      // An entry finished meanwhile fails the tick whole (nothing marked, nobody told); the next
      // tick reads it again and leaves it.
      changedOne(),
    );
    await queueNotice(ctx, {
      to: [entry.account_id],
      title: "Enter the time you finished",
      body: `You started at ${await whenOf(ctx, entry.starts, entry.zone)} and have not finished. Enter when you finished in My time.`,
      humanOnly: true,
      dedupeKey: `staffing.time.finishMissing.${entry.id}`,
    });
  }
  return due.length;
}

// --- Differences from the roster, and approval on a match (stage 58 step 2, ADR 0851) ----------

/**
 * Minutes from `planned` to `actual`, positive later: any part of a minute counts as a minute
 * (rounded away from zero), so what shows and what matches agree and nothing past the tolerance
 * matches (5 minutes and 1 second late shows as 6).
 */
export const minutesFrom = (planned: number, actual: number) => {
  const seconds = actual - planned;
  return seconds === 0 ? 0 : Math.sign(seconds) * Math.ceil(Math.abs(seconds) / 60);
};

/**
 * Whether an entry matches its shift: it starts and finishes within `tolerance` minutes of the
 * shift's own start and end (early or late), to the second. Exact seconds are kept on the entry;
 * the tolerance decides only what shows as a difference and what the host approves.
 */
export function matchesShift(
  entry: { starts: number; ends: number },
  shift: { starts: number; ends: number },
  tolerance: number,
): boolean {
  return (
    Math.abs(minutesFrom(shift.starts, entry.starts)) <= tolerance &&
    Math.abs(minutesFrom(shift.ends, entry.ends)) <= tolerance
  );
}

/**
 * Whether the host approves a finished entry as it is recorded (decision 5): not held for a
 * person (`held`: an approver's entry for someone, a missing finish entered afterwards, one an
 * approver sent back or reopened), and against one of the person's own live shifts, starting and
 * finishing within the tolerance of it. Time with no shift (a job, other work) always waits for a
 * person. Answers the statement for the write's batch that fails it whole (`core_staff_changed`)
 * unless the shift's claim is still the one matched, or null when the host does not approve.
 */
export async function hostApproves(
  db: Kysely<CoreDatabase>,
  entry: Pick<
    StoredEntry,
    "account_id" | "starts" | "ends" | "how" | "against_object" | "against_record" | "held"
  >,
  tolerance: number,
): Promise<CompiledQuery | null> {
  if (entry.ends === null || entry.how === "by_approver" || entry.held) return null;
  if (!entry.against_object || !entry.against_record) return null;
  if (!getObject(entry.against_object)?.staffed) return null;
  const claim = await claimOf(db, { object: entry.against_object, id: entry.against_record });
  if (!claim || claim.account_id !== entry.account_id) return null;
  if (!matchesShift({ starts: entry.starts, ends: entry.ends }, claim, tolerance)) return null;
  // A shift moved or given to someone else after this read fails the write whole.
  return CompiledQuery.raw(
    "INSERT INTO core_staff_guard (expected, actual) SELECT 1, count(*) FROM core_staff_time WHERE object_type = ? AND record_id = ? AND account_id = ? AND starts + margin_before = ? AND ends - margin_after = ?",
    [entry.against_object, entry.against_record, entry.account_id, claim.starts, claim.ends],
  );
}

/** One line of the differences: an entry beside its shift, or a shift with nothing recorded. */
export interface Difference {
  account: string;
  name: string;
  /** The entry (null for a shift with nothing recorded). */
  entry: TimeEntryItem | null;
  /** The shift as rostered (its own time), or null for time with no live shift of theirs. */
  shift: { object: string; id: string; title: string; startsAt: string; endsAt: string } | null;
  /** Whole minutes the entry started after the shift (negative: before), or null. */
  startMinutes: number | null;
  /** Whole minutes the entry finished after the shift (negative: before), or null. */
  finishMinutes: number | null;
  /** Against its shift and within the tolerance at both ends. */
  matches: boolean;
  /** A past shift of someone counted by time with no entry approved, waiting or open on it. */
  notRecorded: boolean;
  /** An entry against no live shift of theirs: a job, other work, or a shift gone since. */
  unrostered: boolean;
  /** An entry longer than LONG_HOURS. */
  long: boolean;
}

/**
 * The roster beside what was recorded for the local dates `from` to `to` (the organisation's
 * zone): each entry dated in it (of `account` only, when given; of the `states` given, when
 * given), with its difference from its shift, and, unless `notRecorded` is false, each past live
 * covered shift of someone counted by time on its date with no entry approved, waiting or open
 * against it and not marked not worked. Read set-based: a fixed number of reads per hundred
 * people and per object, never per person, date or entry.
 */
export async function differencesOf(
  ctx: HandlerContext,
  options: {
    from: string;
    to: string;
    account?: string;
    states?: readonly StoredEntry["state"][];
    notRecorded?: boolean;
  },
): Promise<{ tolerance: number; zone: string; items: Difference[] }> {
  const { from, to, account } = options;
  const tolerance = (await timeSettings(ctx.db)).matchMinutes;
  const zone = (await loadGeneralSettings(ctx.db)).timezone;
  const range = periodRange(from, to, zone);
  const now = secondsOf(ctx.now);

  let query = ctx.db
    .selectFrom("core_time_entry")
    .selectAll()
    .where("local_date", ">=", from)
    .where("local_date", "<=", to);
  if (account) query = query.where("account_id", "=", account);
  if (options.states) query = query.where("state", "in", [...options.states]);
  const rows = await query
    .orderBy("starts")
    .limit(SET_ROWS_MAX + 1)
    .execute();
  if (rows.length > SET_ROWS_MAX) {
    throw new ValidationError("There is too much recorded in this range: ask for fewer dates.", {
      rule: "too_large",
    });
  }
  const entries = await itemsOf(ctx.db, rows);
  const shiftRefs = rows.flatMap((r) =>
    r.against_object && r.against_record && getObject(r.against_object)?.staffed
      ? [{ object: r.against_object, id: r.against_record }]
      : [],
  );
  const shifts = await shiftTimesOf(ctx.db, shiftRefs);

  const items: Difference[] = rows.map((r, i) => {
    const entry = entries[i] as TimeEntryItem;
    const claim =
      r.against_object && r.against_record
        ? shifts.get(`${r.against_object}\u0000${r.against_record}`)
        : undefined;
    const own = claim && claim.account_id === r.account_id ? claim : undefined;
    const startMinutes = own ? minutesFrom(own.starts, r.starts) : null;
    const finishMinutes = own && r.ends !== null ? minutesFrom(own.ends, r.ends) : null;
    return {
      account: r.account_id,
      name: "",
      entry,
      shift:
        own && r.against_object && r.against_record
          ? {
              object: r.against_object,
              id: r.against_record,
              title: entry.against?.title ?? r.against_object,
              startsAt: isoOf(own.starts),
              endsAt: isoOf(own.ends),
            }
          : null,
      startMinutes,
      finishMinutes,
      matches:
        own !== undefined &&
        r.ends !== null &&
        matchesShift({ starts: r.starts, ends: r.ends }, own, tolerance),
      notRecorded: false,
      unrostered: !own,
      long: r.ends !== null && r.ends - r.starts > LONG_HOURS * 3600,
    };
  });

  if (options.notRecorded !== false) {
    const bases = await timeBasesOf(ctx, to, account);
    const held = await claimsOf(ctx, [...bases.keys()], range.starts, range.ends);
    const candidates: {
      account: string;
      object: string;
      id: string;
      starts: number;
      ends: number;
    }[] = [];
    for (const [who, claims] of held) {
      for (const c of claims) {
        if (c.own.ends > now || c.own.starts < range.starts || c.own.starts >= range.ends) continue;
        if (basisOn(bases.get(who), localDateOf(c.own.starts, zone)) !== "by_time") continue;
        candidates.push({ account: who, object: c.object, id: c.id, ...c.own });
      }
    }
    // What is recorded against them, whatever its date (an entry may start the evening before).
    const recorded = new Set<string>();
    const byObject = new Map<string, string[]>();
    for (const c of candidates) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c.id]);
    for (const [object, ids] of byObject) {
      const found = await ctx.db
        .selectFrom("core_time_entry")
        .select(["against_record", "account_id"])
        .where("against_object", "=", object)
        .where("against_record", "in", jsonList(ids))
        .where("state", "in", ["approved", "waiting", "open"])
        .execute();
      for (const f of found)
        recorded.add(`${f.account_id}\u0000${object}\u0000${f.against_record}`);
    }
    const notWorked = await notWorkedOf(ctx, candidates);
    const missing = candidates.filter(
      (c) =>
        !recorded.has(`${c.account}\u0000${c.object}\u0000${c.id}`) &&
        !notWorked.has(`${c.object}\u0000${c.id}`),
    );
    const titles = await againstTitles(ctx.db, missing);
    for (const c of missing) {
      items.push({
        account: c.account,
        name: "",
        entry: null,
        shift: {
          object: c.object,
          id: c.id,
          title: titles.get(`${c.object}\u0000${c.id}`)?.title ?? c.object,
          startsAt: isoOf(c.starts),
          endsAt: isoOf(c.ends),
        },
        startMinutes: null,
        finishMinutes: null,
        matches: false,
        notRecorded: true,
        unrostered: false,
        long: false,
      });
    }
  }

  const names = await namesOf(
    ctx,
    items.map((d) => d.account),
  );
  for (const d of items) d.name = names.get(d.account) ?? "Someone";
  const at = (d: Difference) => d.entry?.startsAt ?? d.shift?.startsAt ?? "";
  items.sort((a, b) => at(a).localeCompare(at(b)) || a.account.localeCompare(b.account));
  return { tolerance, zone, items };
}
