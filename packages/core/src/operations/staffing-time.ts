// Time entries (stage 58 step 1, ADR 0850): a staff member starts and finishes the time they work,
// or enters it afterwards, against one of their own shifts, a job (a `workedOn` record) or nothing
// (other work); corrects it before it is approved, or withdraws it. Tool-only, as every staffing
// operation (ADR 0621): called from a shipped pack's tool run (Rostering's, step 5), acting for
// the staff account the pipeline verified as the tool's caller (`ctx.extension.tool.calledBy`).
//
// Recording time is a person's own act: every operation here refuses a call that is not a person
// at the screen (the calling tool `humanOnly`, the verified caller a person), whatever is granted,
// and works only once the business has switched recording on (Rostering's `recordsTime`,
// declared in its `staffing.settings`). A person reads and changes only their own entries. The
// start and finish of a clocked entry are the host's clock (`ctx.now`); a time in the request is
// never read. Approval is step 2: a finished or entered entry waits for an approver.
//
// No note reaches the audit log (redacted) and no entry's times reach a notice to anyone else.
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { actingAccount, timeSettings } from "../staffing/rosterers.ts";
import {
  type Against,
  type AgainstRef,
  addDays,
  assertNoOverlap,
  ENTRY_MAX_HOURS,
  entryById,
  inLockedPeriod,
  isoOf,
  itemsOf,
  proposedShift,
  RANGE_MAX_DAYS,
  resolveAgainst,
  type StoredEntry,
  secondsOf,
} from "../staffing/time.ts";
import { localParts } from "../time/local.ts";
import { assertShippedToolRun, instantOf } from "./staffing.ts";

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a local date and time, YYYY-MM-DDTHH:MM");
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const againstRef = z.object({ object: z.string().min(1).max(81), id: z.string().min(1).max(64) });
const breakMinutes = z.number().int().min(0).max(600);
const note = z.string().max(500);

// --- Who calls ------------------------------------------------------------------------------------

/**
 * A time call: a shipped pack's tool, a person's own (never an AI acting for one, whatever is
 * granted), with recording switched on. Refused otherwise, saying nothing of any entry.
 */
async function assertTimeCall(ctx: HandlerContext, name: string): Promise<void> {
  await assertShippedToolRun(ctx, name);
  const tool = ctx.extension?.tool;
  if (tool?.humanOnly !== true || tool.calledBy?.actor !== "human") {
    throw new ForbiddenError(
      "Time is recorded and read by the person themselves, never by an assistant.",
      { rule: "human_only" },
    );
  }
  if (!(await timeSettings(ctx.db)).recordsTime) {
    throw new ConflictError(
      "Staff do not record their time here: whoever runs the roster switches it on in Rostering's settings.",
      { rule: "time_not_recorded" },
    );
  }
}

/** The caller's own entry, or not found (someone else's is as if it were not there). */
async function ownEntry(ctx: HandlerContext, id: string): Promise<StoredEntry> {
  const row = await entryById(ctx.db, id);
  if (!row || row.account_id !== actingAccount(ctx)) throw new NotFoundError("time entry", id);
  return row;
}

/** An entry inside a locked pay period is never made or changed. */
async function assertPeriodOpen(ctx: HandlerContext, seconds: number): Promise<void> {
  if (await inLockedPeriod(ctx.db, seconds)) {
    throw new ConflictError(
      "This is inside a locked pay period, so nothing was changed. Whoever handles pay reopens the period first.",
      { rule: "pay_period_locked" },
    );
  }
}

/** The organisation's zone, and a zone given for local times (its own, else the organisation's). */
async function zones(ctx: HandlerContext, given?: string): Promise<{ org: string; zone: string }> {
  const org = (await loadGeneralSettings(ctx.db)).timezone;
  const zone = given ?? org;
  if (!isTimezone(zone)) throw new ValidationError(`${zone} is not a time zone`, { field: "zone" });
  return { org, zone };
}

/**
 * Times a person enters afterwards: a start and finish in the past, at most ENTRY_MAX_HOURS
 * apart, starting no more than the setting's days back (by the organisation's local date), and
 * not in a locked pay period; the break shorter than the time.
 */
async function checkEntered(
  ctx: HandlerContext,
  starts: number,
  ends: number,
  breakMins: number,
  org: string,
): Promise<string> {
  if (!(ends > starts)) {
    throw new ValidationError("An entry must finish after it starts", { field: "endsAt" });
  }
  if (ends - starts > ENTRY_MAX_HOURS * 3600) {
    throw new ValidationError(`One entry is at most ${ENTRY_MAX_HOURS} hours: enter two`, {
      field: "endsAt",
    });
  }
  if (ends > secondsOf(ctx.now)) {
    throw new ValidationError(
      "Time entered afterwards has finished: start the clock for time you are working now",
      { field: "endsAt" },
    );
  }
  if (breakMins * 60 >= ends - starts) {
    throw new ValidationError("The break must be shorter than the time worked", {
      field: "breakMinutes",
    });
  }
  const { enterDays } = await timeSettings(ctx.db);
  const today = localParts(Date.parse(ctx.now), org).date;
  const localDateOfStart = localParts(starts * 1000, org).date;
  if (localDateOfStart < addDays(today, -enterDays)) {
    throw new ValidationError(
      `Time is entered up to ${enterDays} days back. For earlier time, ask whoever rosters.`,
      { field: "startsAt", rule: "time_too_old", enterDays },
    );
  }
  await assertPeriodOpen(ctx, starts);
  return localDateOfStart;
}

/** What an entry is against: `undefined` keeps it, null is other work, a ref is checked. */
async function againstOf(
  ctx: HandlerContext,
  ref: AgainstRef | null | undefined,
): Promise<Against | null | undefined> {
  if (ref === undefined || ref === null) return ref;
  return resolveAgainst(ctx, actingAccount(ctx), ref);
}

// --- Shapes ---------------------------------------------------------------------------------------

const entrySchema = z.object({
  id: z.string(),
  account: z.string(),
  state: z.enum(["open", "waiting", "approved", "rejected"]),
  how: z.enum(["clocked", "entered", "by_approver"]),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  breakMinutes: z.number().int(),
  minutes: z.number().int().nullable().describe("Whole minutes worked less the break"),
  zone: z.string(),
  localDate: z.string(),
  against: z
    .object({ object: z.string(), id: z.string(), title: z.string(), shift: z.boolean() })
    .nullable()
    .describe("A shift, a job, or null for other work"),
  finishMissing: z.boolean(),
  note: z.string().nullable(),
  rejectedWhy: z.string().nullable(),
});

const proposalSchema = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

const proposalOf = (a: Against | null) =>
  a && a.starts !== null && a.ends !== null
    ? {
        object: a.object,
        id: a.id,
        title: a.title,
        startsAt: isoOf(a.starts),
        endsAt: isoOf(a.ends),
      }
    : null;

async function itemOf(ctx: HandlerContext, id: string, row: StoredEntry) {
  const [item] = await itemsOf(ctx.db, [{ ...row, id }]);
  return item as z.infer<typeof entrySchema>;
}

/** A stored row from what is about to be written (the answer is read before the batch commits). */
function rowOf(values: Partial<StoredEntry> & Pick<StoredEntry, "id">, base?: StoredEntry) {
  return {
    account_id: "",
    starts: 0,
    ends: null,
    break_minutes: 0,
    zone: "UTC",
    local_date: "",
    against_object: null,
    against_record: null,
    how: "entered",
    how_why: null,
    state: "waiting",
    finish_missing: 0,
    recorded_starts: null,
    recorded_ends: null,
    recorded_break_minutes: null,
    approved_by: null,
    approved_at: null,
    rejected_why: null,
    note: null,
    start_key: null,
    made_by: "",
    created_at: "",
    updated_at: "",
    ...base,
    ...values,
  } as StoredEntry;
}

// --- Start and finish ------------------------------------------------------------------------------

export const staffingTimeClockIn = defineOperation({
  name: "staffing.time.clockIn",
  description:
    "Tool-only (a shipped pack's tool): start recording the time you work, now (the host's " +
    "clock; no time is taken from the request). against: one of your own shifts, a job (a " +
    "record that declares workedOn) or null for other work; left out, your own shift under way " +
    "or starting within 60 minutes is proposed (the answer says so, to show 'not this shift'). " +
    "One open entry at a time. key: an idempotency key, so a start retried on a weak " +
    "connection makes one entry. A person's own act, never an assistant's. Returns the entry.",
  input: z.object({
    against: againstRef.nullable().optional(),
    key: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{16,128}$/, "16 to 128 letters, digits and . _ : -")
      .optional()
      .describe("An idempotency key: the same key returns the entry it made"),
    note: note.optional(),
  }),
  output: z.object({
    id: z.string(),
    entry: entrySchema,
    /** The shift was proposed by the host (no `against` given). */
    proposed: z.boolean(),
    /** A retry: the key had already made this entry. */
    replayed: z.boolean(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note"],
  auditSummary: (output) => ({ id: output.id, replayed: output.replayed }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.clockIn");
    const account = actingAccount(ctx);
    if (input.key) {
      const made = await ctx.db
        .selectFrom("core_time_entry")
        .selectAll()
        .where("account_id", "=", account)
        .where("start_key", "=", input.key)
        .executeTakeFirst();
      if (made) {
        return {
          id: made.id,
          entry: await itemOf(ctx, made.id, made),
          proposed: false,
          replayed: true,
        };
      }
    }
    const open = await ctx.db
      .selectFrom("core_time_entry")
      .select("id")
      .where("account_id", "=", account)
      .where("ends", "is", null)
      .executeTakeFirst();
    if (open) {
      throw new ConflictError("You have already started: finish that entry first.", {
        rule: "time_open",
        entry: open.id,
      });
    }
    const now = secondsOf(ctx.now);
    const proposed = input.against === undefined;
    const against = proposed
      ? await proposedShift(ctx, account, now)
      : await againstOf(ctx, input.against);
    if (against?.shift && against.ends !== null && against.ends <= now) {
      throw new ValidationError(
        "This shift is over: enter the time you worked on it instead of starting the clock",
        { field: "against" },
      );
    }
    await assertNoOverlap(ctx, account, now, null);
    await assertPeriodOpen(ctx, now);
    const { org } = await zones(ctx);
    const id = newId("timeEntry");
    const values = {
      id,
      account_id: account,
      starts: now,
      ends: null,
      break_minutes: 0,
      zone: org,
      local_date: localParts(now * 1000, org).date,
      against_object: against?.object ?? null,
      against_record: against?.id ?? null,
      how: "clocked" as const,
      state: "open" as const,
      note: input.note ?? null,
      start_key: input.key ?? null,
      made_by: account,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_time_entry").values(values));
    return {
      id,
      entry: await itemOf(ctx, id, rowOf(values)),
      proposed: proposed && against !== null,
      replayed: false,
    };
  },
});

export const staffingTimeClockOut = defineOperation({
  name: "staffing.time.clockOut",
  description:
    "Tool-only (a shipped pack's tool): finish the entry you started, now (the host's clock), " +
    "with the unpaid break minutes you took. It then waits for an approver. For an entry whose " +
    "finish is missing (you forgot), enter the time you finished with staffing.time.edit " +
    "instead. A person's own act. Returns the entry.",
  input: z.object({
    breakMinutes: breakMinutes.optional(),
    note: note.optional(),
  }),
  output: z.object({ id: z.string(), entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note"],
  auditSummary: (output) => ({ id: output.id }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.clockOut");
    const account = actingAccount(ctx);
    const open = await ctx.db
      .selectFrom("core_time_entry")
      .selectAll()
      .where("account_id", "=", account)
      .where("ends", "is", null)
      .executeTakeFirst();
    if (!open) {
      throw new ConflictError("You have not started, so there is nothing to finish.", {
        rule: "time_not_open",
      });
    }
    const now = secondsOf(ctx.now);
    if (open.finish_missing === 1) {
      throw new ConflictError(
        "This entry's finish is missing: enter the time you really finished instead.",
        { rule: "finish_missing", entry: open.id },
      );
    }
    if (!(now > open.starts)) {
      throw new ValidationError("An entry must finish after it starts", { field: "now" });
    }
    const breakMins = input.breakMinutes ?? 0;
    if (breakMins * 60 >= now - open.starts) {
      throw new ValidationError("The break must be shorter than the time worked", {
        field: "breakMinutes",
      });
    }
    const changes = {
      ends: now,
      break_minutes: breakMins,
      state: "waiting" as const,
      ...(input.note !== undefined ? { note: input.note || null } : {}),
      updated_at: ctx.now,
    };
    // Guarded: an entry finished or withdrawn meanwhile is left as it is.
    ctx.write(
      ctx.db
        .updateTable("core_time_entry")
        .set(changes)
        .where("id", "=", open.id)
        .where("ends", "is", null),
    );
    return {
      id: open.id,
      entry: await itemOf(ctx, open.id, rowOf({ ...changes, id: open.id }, open)),
    };
  },
});

// --- Entered afterwards, corrected, withdrawn -----------------------------------------------------

export const staffingTimeEnter = defineOperation({
  name: "staffing.time.enter",
  description:
    "Tool-only (a shipped pack's tool): enter time you worked afterwards (you forgot, or had no " +
    "signal on a site): startsAt and endsAt, local date-times in zone (the organisation's if left " +
    "out), the unpaid break minutes, and what it was against (one of your own shifts, a job, or " +
    "null for other work). Up to the setting's days back (14 by default), never in a locked pay " +
    "period, never overlapping another of your entries. It waits for an approver. A person's " +
    "own act. Returns the entry.",
  input: z.object({
    startsAt: localDateTime,
    endsAt: localDateTime,
    zone: z.string().min(1).max(64).optional(),
    breakMinutes: breakMinutes.optional(),
    against: againstRef.nullable().optional(),
    note: note.optional(),
  }),
  output: z.object({ id: z.string(), entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note"],
  auditSummary: (output) => ({ id: output.id }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.enter");
    const account = actingAccount(ctx);
    const { org, zone } = await zones(ctx, input.zone);
    const starts = instantOf(input.startsAt, zone);
    const ends = instantOf(input.endsAt, zone);
    const breakMins = input.breakMinutes ?? 0;
    const date = await checkEntered(ctx, starts, ends, breakMins, org);
    const against = await againstOf(ctx, input.against ?? null);
    await assertNoOverlap(ctx, account, starts, ends);
    const id = newId("timeEntry");
    const values = {
      id,
      account_id: account,
      starts,
      ends,
      break_minutes: breakMins,
      zone,
      local_date: date,
      against_object: against?.object ?? null,
      against_record: against?.id ?? null,
      how: "entered" as const,
      state: "waiting" as const,
      note: input.note || null,
      made_by: account,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_time_entry").values(values));
    return { id, entry: await itemOf(ctx, id, rowOf(values)) };
  },
});

export const staffingTimeEdit = defineOperation({
  name: "staffing.time.edit",
  description:
    "Tool-only (a shipped pack's tool): correct one of your own entries before it is approved " +
    "(open, waiting or rejected): what it was against (null: other work), the break minutes, " +
    "the note, and for a finished entry its startsAt and endsAt (local date-times in zone). For " +
    "an open entry whose finish is missing, endsAt enters the time you finished. A rejected " +
    "entry corrected waits for an approver again. Changing a clocked entry's times makes it " +
    "entered. A person's own act. Returns the entry.",
  input: z.object({
    id: z.string().min(1).max(64),
    startsAt: localDateTime.optional(),
    endsAt: localDateTime.optional(),
    zone: z.string().min(1).max(64).optional(),
    breakMinutes: breakMinutes.optional(),
    against: againstRef.nullable().optional(),
    note: note.nullable().optional(),
  }),
  output: z.object({ id: z.string(), entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note"],
  auditSummary: (output) => ({ id: output.id }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.edit");
    const entry = await ownEntry(ctx, input.id);
    if (entry.state === "approved") {
      throw new ConflictError(
        "This entry is approved, so it is no longer yours to change. Ask whoever approved it.",
        { rule: "time_approved" },
      );
    }
    const account = entry.account_id;
    const { org, zone } = await zones(ctx, input.zone ?? entry.zone);
    // Times: an open entry takes a finish only when it is missing (otherwise it is finished by
    // the clock), and keeps the host's start; a finished one takes either.
    if (entry.ends === null) {
      if (input.startsAt !== undefined) {
        throw new ValidationError("An open entry's start is the time you started the clock", {
          field: "startsAt",
        });
      }
      if (input.endsAt !== undefined && entry.finish_missing !== 1) {
        throw new ValidationError("Finish an open entry by stopping the clock", {
          field: "endsAt",
        });
      }
    }
    const starts = input.startsAt !== undefined ? instantOf(input.startsAt, zone) : entry.starts;
    const ends = input.endsAt !== undefined ? instantOf(input.endsAt, zone) : entry.ends;
    const breakMins = input.breakMinutes ?? entry.break_minutes;
    const timesChanged = starts !== entry.starts || ends !== entry.ends;
    let date = entry.local_date;
    if (ends !== null) {
      await assertPeriodOpen(ctx, entry.starts);
      if (timesChanged || breakMins !== entry.break_minutes) {
        date = await checkEntered(ctx, starts, ends, breakMins, org);
      }
    } else {
      await assertPeriodOpen(ctx, entry.starts);
    }
    const against = await againstOf(ctx, input.against);
    if (timesChanged) await assertNoOverlap(ctx, account, starts, ends, entry.id);
    const finished = ends !== null;
    const changes = {
      starts,
      ends,
      break_minutes: breakMins,
      zone: timesChanged && input.startsAt !== undefined ? zone : entry.zone,
      local_date: date,
      ...(against !== undefined
        ? { against_object: against?.object ?? null, against_record: against?.id ?? null }
        : {}),
      // Times the person typed are not the host's clock.
      ...(timesChanged && entry.how === "clocked" ? { how: "entered" as const } : {}),
      state: finished ? ("waiting" as const) : ("open" as const),
      finish_missing: finished ? 0 : entry.finish_missing,
      ...(entry.state === "rejected" ? { rejected_why: null } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
      updated_at: ctx.now,
    };
    // Guarded: an entry approved or changed meanwhile is left as it is.
    ctx.write(
      ctx.db
        .updateTable("core_time_entry")
        .set(changes)
        .where("id", "=", entry.id)
        .where("state", "=", entry.state)
        .where("updated_at", "=", entry.updated_at),
    );
    return {
      id: entry.id,
      entry: await itemOf(ctx, entry.id, rowOf({ ...changes, id: entry.id }, entry)),
    };
  },
});

export const staffingTimeWithdraw = defineOperation({
  name: "staffing.time.withdraw",
  description:
    "Tool-only (a shipped pack's tool): withdraw one of your own entries before it is approved " +
    "(waiting or rejected): it is removed. An open entry is finished first. Never in a locked " +
    "pay period. A person's own act. Returns its id.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.withdraw");
    const entry = await ownEntry(ctx, input.id);
    if (entry.state !== "waiting" && entry.state !== "rejected") {
      throw new ConflictError(
        entry.state === "open"
          ? "This entry is still open: finish it first, then withdraw it."
          : "This entry is approved, so it is no longer yours to withdraw.",
        { rule: entry.state === "open" ? "time_open" : "time_approved" },
      );
    }
    await assertPeriodOpen(ctx, entry.starts);
    ctx.write(
      ctx.db
        .deleteFrom("core_time_entry")
        .where("id", "=", entry.id)
        .where("state", "in", ["waiting", "rejected"]),
    );
    return { id: entry.id };
  },
});

// --- My time --------------------------------------------------------------------------------------

export const staffingTimeMine = defineOperation({
  name: "staffing.time.mine",
  description:
    "Tool-only (a shipped pack's tool): your own time: the entry you have open, the shift a " +
    "start would propose now, and your entries from `from` to `to` (local dates of their start, " +
    "default the last 14 days; at most 62 days). Yours only. Read-only.",
  input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  output: z.object({
    open: entrySchema.nullable(),
    proposed: proposalSchema.nullable(),
    items: z.array(entrySchema),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.mine");
    const account = actingAccount(ctx);
    const { org } = await zones(ctx);
    const today = localParts(Date.parse(ctx.now), org).date;
    const to = input.to ?? today;
    const from = input.from ?? addDays(to, -13);
    if (to < from) throw new ValidationError("`to` is on or after `from`", { field: "to" });
    if (addDays(from, RANGE_MAX_DAYS - 1) < to) {
      throw new ValidationError(`At most ${RANGE_MAX_DAYS} days at a time`, { field: "to" });
    }
    const rows = await ctx.db
      .selectFrom("core_time_entry")
      .selectAll()
      .where("account_id", "=", account)
      .where("local_date", ">=", from)
      .where("local_date", "<=", to)
      .orderBy("starts")
      .limit(1000)
      .execute();
    const open = await ctx.db
      .selectFrom("core_time_entry")
      .selectAll()
      .where("account_id", "=", account)
      .where("ends", "is", null)
      .executeTakeFirst();
    const items = await itemsOf(ctx.db, open ? [open, ...rows] : rows);
    const proposed = open ? null : await proposedShift(ctx, account, secondsOf(ctx.now));
    return {
      open: open ? (items[0] ?? null) : null,
      proposed: proposalOf(proposed),
      items: open ? items.slice(1) : items,
    };
  },
});

export const staffingTimeOperations = [
  staffingTimeClockIn,
  staffingTimeClockOut,
  staffingTimeEnter,
  staffingTimeEdit,
  staffingTimeWithdraw,
  staffingTimeMine,
] as const;
