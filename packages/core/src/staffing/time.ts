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
import { type Kysely, type Selectable, sql } from "kysely";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { shiftTitle } from "./changes.ts";
import { loadShift } from "./index.ts";
import { whenOf } from "./offers.ts";
import { queueNotice } from "./rosterers.ts";

/** A start proposes the person's own live shift that starts within this many minutes. */
export const PROPOSE_MINUTES = 60;
/** An open entry with no shift is marked finish missing this many hours after its start. */
export const NO_SHIFT_MISSING_HOURS = 14;
/** The longest one entry may be: a stretch of work, not a week. */
export const ENTRY_MAX_HOURS = 24;
/** The most days one read of entries covers. */
export const RANGE_MAX_DAYS = 62;
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

/** The time claim of one of `account`'s shifts (a live, covered shift of theirs), or null. */
async function claimOf(
  db: Kysely<CoreDatabase>,
  ref: AgainstRef,
): Promise<{ account_id: string; starts: number; ends: number } | undefined> {
  return db
    .selectFrom("core_staff_time")
    .select(["account_id", "starts", "ends"])
    .where("object_type", "=", ref.object)
    .where("record_id", "=", ref.id)
    .executeTakeFirst();
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
    if (!s || s.deleted) throw new NotFoundError(ref.object, ref.id);
    const claim = await claimOf(ctx.db, ref);
    if (!claim || claim.account_id !== account) {
      if (!s.shift.live) {
        throw new ConflictError("This shift is cancelled, so no time is recorded against it.", {
          rule: "shift_not_live",
        });
      }
      throw new ForbiddenError("This is not one of your shifts, so no time is recorded on it.", {
        rule: "not_your_shift",
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
