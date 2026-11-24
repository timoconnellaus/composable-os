// Differences from the roster and approval of time entries (stage 58 step 2, ADR 0851). An
// approver (whoever rosters, `rostering:manage`, decision 12) reads what waits and the
// differences, approves an entry as it is or changed (the recorded times kept beside), rejects it
// saying why, reopens an approved one while its pay period is open, and enters time for someone
// (it waits, and is never approved by the host). Nobody approves, rejects or reopens their own
// entry, except an admin when nobody else may approve. A person reads their own waiting entries
// and differences. Entries that match their shift within the tolerance are approved by the host
// as they are finished or entered (operations/staffing-time.ts, `hostApproves`).
//
// Tool-only, as every staffing operation (ADR 0621), and a person's at the screen: the calling
// tool `humanOnly` and the verified caller a person, never an assistant or MCP, whatever is
// granted. No note, reason or time reaches the audit log (redacted; summaries name the entries);
// the person is told when their time is rejected or approved changed, never why in the notice.
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { isTimezone } from "../settings.ts";
import { whenOf } from "../staffing/offers.ts";
import {
  actingAccount,
  mayRoster,
  queueNotice,
  rosterers,
  staffName,
} from "../staffing/rosterers.ts";
import {
  addDays,
  changedOne,
  type Difference,
  differencesOf,
  ENTRY_MAX_HOURS,
  isoOf,
  overlapOf,
  RANGE_MAX_DAYS,
  resolveAgainst,
  type StoredEntry,
  secondsOf,
} from "../staffing/time.ts";
import { localParts } from "../time/local.ts";
import { instantOf, requireAccount } from "./staffing.ts";
import {
  assertPeriodOpen,
  assertTimeCall,
  checkEntered,
  entrySchema,
  itemOf,
  rowOf,
  unchanged,
  zones,
} from "./staffing-time.ts";

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a local date and time, YYYY-MM-DDTHH:MM");
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const entityId = z.string().min(1).max(64);
const why = z.string().min(1).max(200);
const againstRef = z.object({ object: z.string().min(1).max(81), id: z.string().min(1).max(64) });
/** The most entries one approval covers. */
export const APPROVE_MAX = 100;

// --- Who calls ------------------------------------------------------------------------------------

async function assertApprover(ctx: HandlerContext, what: string): Promise<void> {
  if (!(await mayRoster(ctx))) {
    throw new ForbiddenError(`Only someone who approves time may ${what}.`, { rule: "rostering" });
  }
}

/**
 * Nobody decides their own time (decision 12), except an admin when nobody else may approve: then
 * it is approved by themselves, and the entry says so.
 */
async function assertNotOwn(ctx: HandlerContext, accounts: Iterable<string>): Promise<void> {
  const me = actingAccount(ctx);
  if (![...accounts].includes(me)) return;
  const role = await ctx.db
    .selectFrom("core_user")
    .select("role")
    .where("id", "=", me)
    .executeTakeFirst();
  const others = (await rosterers(ctx.db)).filter((r) => r !== me);
  if (role?.role === "admin" && others.length === 0) return;
  throw new ForbiddenError("Nobody approves their own time: someone else who approves time does.", {
    rule: "own_time",
  });
}

/** Whose time a read covers: anyone's (or one person's) for an approver, the caller's otherwise. */
async function readerOf(ctx: HandlerContext, account: string | undefined) {
  const me = actingAccount(ctx);
  if (await mayRoster(ctx)) return account;
  if (account !== undefined && account !== me) {
    throw new ForbiddenError("You read your own time only.", { rule: "rostering" });
  }
  return me;
}

/** A read's local dates: `to` defaults to today, `from` to RANGE_MAX_DAYS before it. */
async function rangeOf(ctx: HandlerContext, input: { from?: string; to?: string }) {
  const { org } = await zones(ctx);
  const to = input.to ?? localParts(Date.parse(ctx.now), org).date;
  const from = input.from ?? addDays(to, -(RANGE_MAX_DAYS - 1));
  if (to < from) throw new ValidationError("`to` is on or after `from`", { field: "to" });
  if (addDays(from, RANGE_MAX_DAYS - 1) < to) {
    throw new ValidationError(`At most ${RANGE_MAX_DAYS} days at a time`, { field: "to" });
  }
  return { from, to };
}

/** Refuses an entry of `account` overlapping another of theirs, naming it. */
async function assertFree(
  ctx: HandlerContext,
  account: string,
  starts: number,
  ends: number,
  except?: string,
): Promise<void> {
  const other = await overlapOf(ctx.db, account, starts, ends, except);
  if (!other) return;
  throw new ConflictError(
    `This overlaps another of their entries (${await whenOf(ctx, other.starts, null)}), so nothing was changed.`,
    {
      rule: "time_overlap",
      entry: other.id,
      startsAt: isoOf(other.starts),
      endsAt: other.ends === null ? null : isoOf(other.ends),
    },
  );
}

/** The entries `ids`, every one of them, or not found. */
async function entriesOf(ctx: HandlerContext, ids: readonly string[]): Promise<StoredEntry[]> {
  const rows = await ctx.db
    .selectFrom("core_time_entry")
    .selectAll()
    .where("id", "in", jsonList([...ids]))
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundError("time entry", id);
    return row;
  });
}

/** Refuses deciding an entry that is not waiting, saying what it is. */
function assertWaiting(entry: StoredEntry): void {
  if (entry.state === "waiting") return;
  const finishMissing = entry.state === "open" && entry.finish_missing === 1;
  throw new ConflictError(
    finishMissing
      ? "This entry's finish is missing: the person enters it before it can be approved."
      : entry.state === "open"
        ? "This entry is still open: it is approved once it is finished."
        : entry.state === "approved"
          ? "This entry is already approved: reopen it first."
          : "This entry was sent back: the person corrects it first.",
    {
      rule: finishMissing ? "finish_missing" : "time_not_waiting",
      entry: entry.id,
      state: entry.state,
    },
  );
}

/** The locked (or locking) pay periods over `lo`..`hi` (unix seconds), read once. */
async function lockedOver(ctx: HandlerContext, lo: number, hi: number) {
  const periods = await ctx.db
    .selectFrom("core_pay_period")
    .select(["starts", "ends"])
    .where("state", "in", ["locking", "locked"])
    .where("ends", ">", lo)
    .where("starts", "<=", hi)
    .execute();
  return (seconds: number) => periods.some((p) => p.starts <= seconds && p.ends > seconds);
}

function lockedRefusal(): ConflictError {
  return new ConflictError(
    "This is inside a locked pay period, so nothing was changed. Whoever handles pay reopens the period first.",
    { rule: "pay_period_locked" },
  );
}

// --- Shapes ---------------------------------------------------------------------------------------

const differenceSchema = z.object({
  account: z.string(),
  name: z.string(),
  entry: entrySchema.nullable().describe("null for a shift with nothing recorded"),
  shift: z
    .object({
      object: z.string(),
      id: z.string(),
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
    })
    .nullable()
    .describe("The shift as rostered, or null for time with no live shift of theirs"),
  startMinutes: z
    .number()
    .int()
    .nullable()
    .describe("Whole minutes it started after the shift (negative: before)"),
  finishMinutes: z
    .number()
    .int()
    .nullable()
    .describe("Whole minutes it finished after the shift (negative: before)"),
  matches: z.boolean().describe("Within the tolerance at both ends"),
  notRecorded: z.boolean().describe("A past shift of someone counted by time with no entry"),
  unrostered: z.boolean().describe("An entry with no live shift of theirs: a job or other work"),
  long: z.boolean().describe("An entry over 12 hours"),
});

const differencesOutput = z.object({
  from: z.string(),
  to: z.string(),
  /** The tolerance in minutes (Rostering's setting, 5 by default). */
  tolerance: z.number().int(),
  items: z.array(differenceSchema),
});

const out = (from: string, to: string, d: { tolerance: number; items: Difference[] }) => ({
  from,
  to,
  tolerance: d.tolerance,
  items: d.items as z.infer<typeof differenceSchema>[],
});

// --- Reads ----------------------------------------------------------------------------------------

export const staffingTimeWaiting = defineOperation({
  name: "staffing.time.waiting",
  description:
    "Tool-only (a shipped pack's tool): time entries waiting for an approver, dated from `from` " +
    "to `to` (local dates, default the last 62 days; at most 62), each beside its shift: minutes " +
    "started and finished early or late, within the tolerance or not, unrostered (a job, other " +
    "work), over 12 hours. An approver reads everyone's (or one account's); anyone else reads " +
    "their own only. A person at the screen. Read-only.",
  input: z.object({
    from: localDate.optional(),
    to: localDate.optional(),
    account: entityId.optional(),
  }),
  output: differencesOutput,
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output) => ({ entries: output.items.length }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.waiting");
    const account = await readerOf(ctx, input.account);
    const { from, to } = await rangeOf(ctx, input);
    const found = await differencesOf(ctx, {
      from,
      to,
      ...(account ? { account } : {}),
      states: ["waiting"],
      notRecorded: false,
    });
    return out(from, to, found);
  },
});

export const staffingTimeDifferences = defineOperation({
  name: "staffing.time.differences",
  description:
    "Tool-only (a shipped pack's tool): the roster beside what was recorded, from `from` to `to` " +
    "(local dates of each start, at most 62 days): each entry with the minutes it started and " +
    "finished early or late against its shift and whether that is within the tolerance; " +
    "unrostered entries (a job, other work); entries over 12 hours; and each past shift of " +
    "someone counted by time with nothing recorded on it (not recorded). An approver reads " +
    "everyone's (or one account's); anyone else reads their own only. Nothing about why. A " +
    "person at the screen. Read-only.",
  input: z.object({ from: localDate, to: localDate, account: entityId.optional() }),
  output: differencesOutput,
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output) => ({ items: output.items.length }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.differences");
    const account = await readerOf(ctx, input.account);
    const { from, to } = await rangeOf(ctx, input);
    const found = await differencesOf(ctx, { from, to, ...(account ? { account } : {}) });
    return out(from, to, found);
  },
});

// --- Approve, reject, reopen ----------------------------------------------------------------------

const changeInput = z.object({
  id: entityId,
  startsAt: localDateTime.optional(),
  endsAt: localDateTime.optional(),
  zone: z.string().min(1).max(64).optional(),
  breakMinutes: z.number().int().min(0).max(600).optional(),
});

export const staffingTimeApprove = defineOperation({
  name: "staffing.time.approve",
  description:
    "Tool-only (a shipped pack's tool): approve time entries that wait (ids, up to 100), as they " +
    "are or, for those named in `changes`, changed: startsAt and endsAt (local date-times in " +
    "zone, the entry's own if left out) and the break minutes. The times as recorded are kept " +
    "beside the approved ones. Whoever approves time, never their own entries. All or none: an " +
    "entry changed meanwhile fails the whole call. The person is told when their time was " +
    "approved changed. Returns the approved entries.",
  input: z.object({
    ids: z.array(entityId).min(1).max(APPROVE_MAX),
    changes: z.array(changeInput).max(APPROVE_MAX).optional(),
  }),
  output: z.object({ approved: z.array(entrySchema) }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["changes"],
  auditSummary: (output) => ({
    entries: output.approved.map((e) => e.id),
    changed: output.approved.filter((e) => e.recorded !== null).length,
  }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.approve");
    await assertApprover(ctx, "approve time");
    const ids = [...new Set(input.ids)];
    const changes = new Map<string, z.infer<typeof changeInput>>();
    for (const c of input.changes ?? []) {
      if (!ids.includes(c.id)) {
        throw new ValidationError("A change names an entry that is not being approved", {
          field: "changes",
        });
      }
      if (changes.has(c.id)) {
        throw new ValidationError("One change an entry", { field: "changes" });
      }
      changes.set(c.id, c);
    }
    const entries = await entriesOf(ctx, ids);
    for (const e of entries) assertWaiting(e);
    await assertNotOwn(
      ctx,
      entries.map((e) => e.account_id),
    );
    const { org } = await zones(ctx);
    const me = actingAccount(ctx);
    const now = secondsOf(ctx.now);

    // The new times of each entry changed, checked as entered time is, less the days back (an
    // approver corrects what was recorded, however long ago, until the period is locked).
    const planned = new Map<string, Partial<StoredEntry>>();
    for (const e of entries) {
      const c = changes.get(e.id);
      if (!c || e.ends === null) continue;
      const checked = c.zone ?? e.zone;
      if (!isTimezone(checked)) {
        throw new ValidationError(`${checked} is not a time zone`, { field: "zone" });
      }
      const starts = c.startsAt !== undefined ? instantOf(c.startsAt, checked) : e.starts;
      const ends = c.endsAt !== undefined ? instantOf(c.endsAt, checked) : e.ends;
      const breakMins = c.breakMinutes ?? e.break_minutes;
      if (starts === e.starts && ends === e.ends && breakMins === e.break_minutes) continue;
      if (!(ends > starts)) {
        throw new ValidationError("An entry must finish after it starts", { field: "changes" });
      }
      if (ends - starts > ENTRY_MAX_HOURS * 3600) {
        throw new ValidationError(`One entry is at most ${ENTRY_MAX_HOURS} hours`, {
          field: "changes",
        });
      }
      if (ends > now) {
        throw new ValidationError("An approved entry has finished", { field: "changes" });
      }
      if (breakMins * 60 >= ends - starts) {
        throw new ValidationError("The break must be shorter than the time worked", {
          field: "changes",
        });
      }
      if (starts !== e.starts || ends !== e.ends) {
        await assertFree(ctx, e.account_id, starts, ends, e.id);
      }
      planned.set(e.id, {
        starts,
        ends,
        break_minutes: breakMins,
        zone: checked,
        local_date: localParts(starts * 1000, org).date,
        // The first times recorded stay beside, however often it is approved changed.
        recorded_starts: e.recorded_starts ?? e.starts,
        recorded_ends: e.recorded_ends ?? e.ends,
        recorded_break_minutes: e.recorded_break_minutes ?? e.break_minutes,
      });
    }

    const instants = entries.flatMap((e) => [e.starts, planned.get(e.id)?.starts ?? e.starts]);
    const locked = await lockedOver(ctx, Math.min(...instants), Math.max(...instants));
    if (instants.some(locked)) throw lockedRefusal();

    const approved = [];
    for (const e of entries) {
      const set = {
        ...planned.get(e.id),
        state: "approved" as const,
        approved_by: me,
        approved_at: ctx.now,
        reopened_why: null,
        updated_at: ctx.now,
      };
      // Guarded on the entry exactly as it was read: one corrected, withdrawn or decided a moment
      // before fails the whole approval rather than approve what the approver did not see.
      ctx.write(
        ctx.db
          .updateTable("core_time_entry")
          .set(set)
          .where((eb) => unchanged(eb, e)),
        changedOne(),
      );
      approved.push(await itemOf(ctx, e.id, rowOf({ ...set, id: e.id }, e)));
    }

    // The person is told once when their time was approved changed (not why, not the times).
    const changedFor = new Map<string, number>();
    for (const e of entries) {
      if (planned.has(e.id)) changedFor.set(e.account_id, (changedFor.get(e.account_id) ?? 0) + 1);
    }
    if (changedFor.size) {
      const name = await staffName(ctx.db, me);
      for (const [account, n] of changedFor) {
        await queueNotice(ctx, {
          to: [account],
          title: "Your recorded time was approved with changes",
          body: `${name} approved ${n === 1 ? "an entry" : `${n} entries`} of yours with changed times. See them in My time.`,
          humanOnly: true,
        });
      }
    }
    return { approved };
  },
});

export const staffingTimeReject = defineOperation({
  name: "staffing.time.reject",
  description:
    "Tool-only (a shipped pack's tool): send back a time entry that waits, saying why (seen by " +
    "the person and whoever approves time). The person is told, corrects it and it waits again. " +
    "Whoever approves time, never their own entries. Returns the entry.",
  input: z.object({ id: entityId, why }),
  output: z.object({ entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["why"],
  auditSummary: (output) => ({ entry: output.entry.id, account: output.entry.account }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.reject");
    await assertApprover(ctx, "send back time");
    const [entry] = (await entriesOf(ctx, [input.id])) as [StoredEntry];
    assertWaiting(entry);
    await assertNotOwn(ctx, [entry.account_id]);
    await assertPeriodOpen(ctx, entry.starts);
    const set = {
      state: "rejected" as const,
      rejected_why: input.why,
      reopened_why: null,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_time_entry")
        .set(set)
        .where((eb) => unchanged(eb, entry)),
      changedOne(),
    );
    await queueNotice(ctx, {
      to: [entry.account_id],
      title: "Your recorded time was sent back",
      body: `${await staffName(ctx.db, actingAccount(ctx))} sent back your time from ${await whenOf(ctx, entry.starts, entry.zone)}. See why and correct it in My time.`,
      humanOnly: true,
    });
    return { entry: await itemOf(ctx, entry.id, rowOf({ ...set, id: entry.id }, entry)) };
  },
});

export const staffingTimeReopen = defineOperation({
  name: "staffing.time.reopen",
  description:
    "Tool-only (a shipped pack's tool): reopen an approved time entry, saying why, while its pay " +
    "period is open: it waits again (the host does not approve it on a match while reopened). " +
    "Whoever approves time, never their own entries. Returns the entry.",
  input: z.object({ id: entityId, why }),
  output: z.object({ entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["why"],
  auditSummary: (output) => ({ entry: output.entry.id, account: output.entry.account }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.reopen");
    await assertApprover(ctx, "reopen time");
    const [entry] = (await entriesOf(ctx, [input.id])) as [StoredEntry];
    if (entry.state !== "approved") {
      throw new ConflictError("Only an approved entry is reopened.", {
        rule: "time_not_approved",
        entry: entry.id,
        state: entry.state,
      });
    }
    await assertNotOwn(ctx, [entry.account_id]);
    await assertPeriodOpen(ctx, entry.starts);
    const set = {
      state: "waiting" as const,
      approved_by: null,
      approved_at: null,
      reopened_why: input.why,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_time_entry")
        .set(set)
        .where((eb) => unchanged(eb, entry)),
      changedOne(),
    );
    return { entry: await itemOf(ctx, entry.id, rowOf({ ...set, id: entry.id }, entry)) };
  },
});

// --- Entered for someone --------------------------------------------------------------------------

export const staffingTimeEnterFor = defineOperation({
  name: "staffing.time.enterFor",
  description:
    "Tool-only (a shipped pack's tool): enter time someone else worked (they forgot, or have no " +
    "phone), saying why: account, startsAt and endsAt (local date-times in zone, the " +
    "organisation's if left out), the unpaid break minutes, and what it was against (one of " +
    "their shifts, a job, or null for other work). Up to the setting's days back, never in a " +
    "locked pay period. It waits, never approved by the host on a match; whoever entered it may " +
    "approve it (it is not their own time). Whoever approves time. Returns the entry.",
  input: z.object({
    account: entityId,
    startsAt: localDateTime,
    endsAt: localDateTime,
    zone: z.string().min(1).max(64).optional(),
    breakMinutes: z.number().int().min(0).max(600).optional(),
    against: againstRef.nullable().optional(),
    note: z.string().max(500).optional(),
    why,
  }),
  output: z.object({ id: z.string(), entry: entrySchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note", "why"],
  auditSummary: (output) => ({ id: output.id, account: output.entry.account }),
  async handler(input, ctx) {
    await assertTimeCall(ctx, "staffing.time.enterFor");
    await assertApprover(ctx, "enter time for someone else");
    const me = actingAccount(ctx);
    if (input.account === me) {
      throw new ValidationError("Enter your own time with staffing.time.enter", {
        field: "account",
        rule: "own_time",
      });
    }
    await requireAccount(ctx, input.account);
    const { org, zone } = await zones(ctx, input.zone);
    const starts = instantOf(input.startsAt, zone);
    const ends = instantOf(input.endsAt, zone);
    const breakMins = input.breakMinutes ?? 0;
    const date = await checkEntered(ctx, starts, ends, breakMins, org);
    const against = input.against ? await resolveAgainst(ctx, input.account, input.against) : null;
    await assertFree(ctx, input.account, starts, ends);
    const id = newId("timeEntry");
    const values = {
      id,
      account_id: input.account,
      starts,
      ends,
      break_minutes: breakMins,
      zone,
      local_date: date,
      against_object: against?.object ?? null,
      against_record: against?.id ?? null,
      how: "by_approver" as const,
      how_why: input.why,
      state: "waiting" as const,
      note: input.note || null,
      made_by: me,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_time_entry").values(values));
    return { id, entry: await itemOf(ctx, id, rowOf(values)) };
  },
});

export const staffingTimeApproveOperations = [
  staffingTimeWaiting,
  staffingTimeDifferences,
  staffingTimeApprove,
  staffingTimeReject,
  staffingTimeReopen,
  staffingTimeEnterFor,
] as const;
