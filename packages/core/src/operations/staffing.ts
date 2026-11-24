// The `staffed` behaviour's operations (stage 45, ADRs 0621 to 0626). The host's staffing
// operations are tool-only: called from a shipped pack's tool run (the Rostering pack's, step 4),
// for the staff account the pipeline verified as the tool's caller (`ctx.extension.tool.calledBy`,
// never the input), never from a person, MCP or an assistant directly. Who may roster is the
// rosterers' permission (`rostering:manage`, held by admins and by grant, ADR 0625), decided in
// staffing/rosterers.ts.
//
// What an AI may do (the spec's table): read the roster, a shift's warnings and who is qualified;
// propose a roster change (`assign`, `qualify`), which a person applies (the calling tool is
// `personApproves` or `humanOnly`); never offer, take or withdraw a shift, or say someone is away
// (the calling tool must be `humanOnly`: a person's own act). The host refuses anything else here,
// whatever tool calls it.
import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { z } from "zod";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type OperationError,
  UnknownOperationError,
  ValidationError,
} from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { GateFloor } from "../gate.ts";
import { newId } from "../ids.ts";
import { invoke } from "../invoke.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { shiftTitle, shiftZone } from "../staffing/changes.ts";
import { staffingDue, staffingWorkDue, uncoveredShifts } from "../staffing/due.ts";
import { eligibilityOf, eligibleAccounts } from "../staffing/eligibility.ts";
import {
  checkShift,
  doubleBooked,
  kindObjectOf,
  loadShift,
  noteTaking,
  regularOverlaps,
  type StoredShift,
  warningsOf,
} from "../staffing/index.ts";
import {
  endOfferStatement,
  makeOfferStatement,
  offerById,
  openOfferOn,
  pastCutoff,
  takeOfferStatement,
  whenOf,
} from "../staffing/offers.ts";
import {
  actingAccount,
  DEFAULT_UNCOVERED_DAYS,
  mayRoster,
  queueNotice,
  rosterers,
  rosterNumbers,
  shiftLink,
  staffName,
  toolCaller,
} from "../staffing/rosterers.ts";
import { rosterRange } from "../staffing/week.ts";
import { addLocalDays, parseLocalDate, parseLocalTime, wallClockToInstant } from "../time/local.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadRecord, staffWarningSchema, updateRecord } from "./record.ts";

// --- Who calls ------------------------------------------------------------------------------------

/**
 * Refuses anyone but a shipped pack's tool run, as an operation that does not exist. The pipeline
 * refuses a call from outside a tool run (`toolOnly`); this also refuses a runtime extension's,
 * and a run not called for a staff account (an automation's, another extension's code): the
 * roster's operations are about the person who called the tool (ADR 0625).
 */
export async function assertShippedToolRun(ctx: HandlerContext, name: string): Promise<void> {
  const caller = ctx.extension;
  if (ctx.actor !== "extension" || !caller?.tool) throw new UnknownOperationError(name);
  const row = await ctx.db
    .selectFrom("core_extensions")
    .select(["source", "status"])
    .where("id", "=", caller.id)
    .executeTakeFirst();
  if (row?.source !== "shipped" || row.status !== "active") throw new UnknownOperationError(name);
  if (!toolCaller(ctx)) {
    throw new ForbiddenError(`${name} is called from a tool a member of staff calls.`, {
      rule: "staff_caller",
    });
  }
}

/**
 * For a caller who is not a person at the screen (an assistant, MCP): a filter dropping the
 * `unavailable` warnings, so an AI learns clashes and qualifications but never who is away (ADR
 * 0629). Null for a person, who sees them all.
 */
export function withoutAway(
  ctx: HandlerContext,
): (<W extends { code: string }>(warnings: W[]) => W[]) | null {
  if (ctx.extension?.tool?.calledBy?.actor === "human") return null;
  return (warnings) => warnings.filter((w) => w.code !== "unavailable");
}

/** A person's own act (offer, take, withdraw, away): the calling tool lets only a person call it. */
function assertPersonsOwnAct(ctx: HandlerContext, what: string): void {
  if (ctx.extension?.tool?.humanOnly !== true) {
    throw new ForbiddenError(
      `${what} is a person's own act: only a person can do it, never an assistant or an automation.`,
      { rule: "human_only" },
    );
  }
}

/** A roster change a person applies: an AI's call of the calling tool waits for a person. */
export function assertPersonApplies(ctx: HandlerContext, what: string): void {
  const tool = ctx.extension?.tool;
  if (tool?.humanOnly !== true && tool?.personApproves !== true) {
    throw new ForbiddenError(`${what} is applied by a person: the calling tool must ask one.`, {
      rule: "person_applies",
    });
  }
}

export async function assertRosterer(ctx: HandlerContext, what: string): Promise<void> {
  if (!(await mayRoster(ctx))) {
    throw new ForbiddenError(`Only someone who rosters may ${what}.`, { rule: "rostering" });
  }
}

// --- Shapes ---------------------------------------------------------------------------------------

const objectName = z.string().min(1).max(81);
const recordId = z.string().min(1).max(64);
const accountId = z.string().min(1).max(64);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a local date and time, YYYY-MM-DDTHH:MM");
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const localTime = z.string().regex(/^[0-2]\d:[0-5]\d$/, "a time, HH:MM");

const otherShift = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

const shiftSummary = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
type ShiftSummary = z.infer<typeof shiftSummary>;

const offerSchema = z.object({
  id: z.string(),
  shift: shiftSummary,
  /** The shift's person when offered; null for an uncovered shift a rosterer offered. */
  from: z.string().nullable(),
  fromName: z.string().nullable(),
  /** The one person it is offered to, or null for everyone eligible. */
  to: z.string().nullable(),
  state: z.enum(["open", "taken", "withdrawn", "cancelled", "lapsed"]),
  madeAt: z.string(),
  takenBy: z.string().nullable(),
  takenAt: z.string().nullable(),
  /** Offers close this many minutes before the shift starts. */
  closesAt: z.string().nullable(),
});

const iso = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

function summary(s: StoredShift): ShiftSummary {
  return {
    object: s.object.name,
    id: s.id,
    title: shiftTitle(s.object, s.values),
    startsAt: iso(s.shift.starts),
    endsAt: iso(s.shift.ends),
  };
}

type OfferRow = NonNullable<Awaited<ReturnType<typeof offerById>>>;

async function offerOut(ctx: HandlerContext, offer: OfferRow, s: StoredShift | null) {
  const { cutoffMinutes } = await rosterNumbers(ctx.db);
  return {
    id: offer.id,
    shift: s
      ? summary(s)
      : { object: offer.object_type, id: offer.record_id, title: "", startsAt: null, endsAt: null },
    from: offer.from_account,
    fromName: offer.from_account ? await staffName(ctx.db, offer.from_account) : null,
    to: offer.to_account,
    state: offer.state,
    madeAt: offer.made_at,
    takenBy: offer.taken_by,
    takenAt: offer.taken_at,
    closesAt: s && s.shift.starts !== null ? iso(s.shift.starts - cutoffMinutes * 60) : null,
  };
}

/** A shift's kind of work as an offer keeps it, or null. */
function kindOf(s: StoredShift): { object: string; id: string } | null {
  const object = kindObjectOf(s.object);
  return object && s.shift.kind ? { object, id: s.shift.kind } : null;
}

/** Whether anyone but `from` is qualified for the shift's kind (active staff), from that alone. */
async function anyoneQualified(
  ctx: HandlerContext,
  s: StoredShift,
  from: string | null,
): Promise<boolean> {
  const kindObject = kindObjectOf(s.object);
  if (!kindObject || !s.shift.kind) return false;
  let query = ctx.db
    .selectFrom("core_staff_qualification as q")
    .innerJoin("core_user as u", "u.id", "q.account_id")
    .select("q.account_id")
    .where("q.kind_object", "=", kindObject)
    .where("q.kind_record", "=", s.shift.kind)
    .where("u.deactivated_at", "is", null);
  if (from) query = query.where("q.account_id", "!=", from);
  return Boolean(await query.limit(1).executeTakeFirst());
}

/** A live shift that is not in the Trash, or the refusal. */
export async function requireLiveShift(ctx: HandlerContext, object: string, id: string) {
  const s = await loadShift(ctx, object, id);
  if (!s || s.deleted) {
    if (!getObject(object)?.staffed) {
      throw new ValidationError(`${object} is not a shift (it declares no staffed)`, {
        field: "object",
      });
    }
    throw new NotFoundError(object, id);
  }
  return s;
}

function assertLive(s: StoredShift): void {
  if (!s.shift.live) {
    throw new ConflictError("This shift is cancelled or over, so it cannot be offered or taken.", {
      rule: "shift_not_live",
    });
  }
}

async function assertBeforeCutoff(ctx: HandlerContext, s: StoredShift): Promise<void> {
  const { cutoffMinutes } = await rosterNumbers(ctx.db);
  if (pastCutoff(s.shift.starts, ctx.now, cutoffMinutes)) {
    throw new ConflictError(
      `Offers close ${cutoffMinutes} minutes before a shift starts, so this one is closed. Whoever rosters reassigns it now.`,
      { rule: "offer_cutoff", cutoffMinutes },
    );
  }
}

/** A staff account (a person, not deactivated), or not found. */
export async function requireAccount(ctx: HandlerContext, account: string): Promise<void> {
  const row = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", account)
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("user", account);
}

// --- staffing.check (step 2) ----------------------------------------------------------------------

export const staffingCheck = defineOperation({
  name: "staffing.check",
  description:
    "Tool-only (a shipped pack's tool): the dry run of putting someone on a shift. For a record " +
    "of an object that declares `staffed`, as it is or with `account` as its person (null: " +
    "nobody), answers the warnings the write would be made with (unavailable, not_qualified, " +
    "uncovered) and the other shift it would clash with (a clash is refused as double_booked). " +
    "Writes nothing.",
  input: z.object({
    object: objectName,
    id: recordId,
    account: accountId
      .nullable()
      .optional()
      .describe("A staff account to check as the shift's person; null for nobody"),
  }),
  output: z.object({
    warnings: z.array(staffWarningSchema),
    clash: otherShift.nullable(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.check");
    const object = getObject(input.object);
    if (!object?.staffed) {
      throw new ValidationError(`${input.object} is not a shift (it declares no staffed)`, {
        field: "object",
      });
    }
    const record = await loadRecord(ctx, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    const answer = await checkShift(ctx, object, input.id, record.values, input.account);
    // Who is away is a person's to read (ADR 0629): an assistant learns clashes and qualifications.
    const forAi = withoutAway(ctx);
    return forAi ? { ...answer, warnings: forAi(answer.warnings) } : answer;
  },
});

// --- Qualifications -------------------------------------------------------------------------------

/** A kind object some staffed object's shifts are of (a class type, a duty), or the refusal. */
export function requireKindObject(name: string): void {
  if (!listObjects().some((o) => kindObjectOf(o) === name)) {
    throw new ValidationError(`${name} is not a kind of work any shift is of`, {
      field: "kind.object",
    });
  }
}

export const staffingQualify = defineOperation({
  name: "staffing.qualify",
  description:
    "Tool-only (a shipped pack's tool): say whether a staff account may do a kind of work (a " +
    "class type, a duty). Only someone who rosters; an AI's request waits for a person. A " +
    "qualified person may take an offered shift of that kind without anybody approving; " +
    "rostering someone not qualified is made with a not_qualified warning. Returns whether it " +
    "changed anything.",
  input: z.object({
    account: accountId,
    kind: z.object({ object: objectName, id: recordId }),
    qualified: z.boolean().default(true),
  }),
  output: z.object({
    account: z.string(),
    kind: z.object({ object: z.string(), id: z.string() }),
    qualified: z.boolean(),
    changed: z.boolean(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.qualify");
    await assertRosterer(ctx, "say who is qualified");
    assertPersonApplies(ctx, "Saying who is qualified");
    requireKindObject(input.kind.object);
    await requireAccount(ctx, input.account);
    const kindObject = getObject(input.kind.object);
    const table = objectTableOf(input.kind.object);
    if (!kindObject || !table) throw new NotFoundError(input.kind.object, input.kind.id);
    const kind = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} WHERE id = ${
      input.kind.id
    } AND deleted_at IS NULL`.execute(ctx.db);
    if (!kind.rows[0]) throw new NotFoundError(input.kind.object, input.kind.id);
    const existing = await ctx.db
      .selectFrom("core_staff_qualification")
      .select("account_id")
      .where("account_id", "=", input.account)
      .where("kind_object", "=", input.kind.object)
      .where("kind_record", "=", input.kind.id)
      .executeTakeFirst();
    const changed = Boolean(existing) !== input.qualified;
    if (changed && input.qualified) {
      ctx.write(
        ctx.db.insertInto("core_staff_qualification").values({
          account_id: input.account,
          kind_object: input.kind.object,
          kind_record: input.kind.id,
          set_by: actingAccount(ctx),
          set_at: ctx.now,
        }),
      );
    } else if (changed) {
      ctx.write(
        ctx.db
          .deleteFrom("core_staff_qualification")
          .where("account_id", "=", input.account)
          .where("kind_object", "=", input.kind.object)
          .where("kind_record", "=", input.kind.id),
      );
    }
    return { account: input.account, kind: input.kind, qualified: input.qualified, changed };
  },
});

export const staffingQualifications = defineOperation({
  name: "staffing.qualifications",
  description:
    "Tool-only (a shipped pack's tool): who may do which kind of work. Someone who rosters reads " +
    "anyone's (all of them when account is left out); anyone else reads only their own. Read-only.",
  input: z.object({
    account: accountId.optional(),
    kindObject: objectName.optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        kind: z.object({ object: z.string(), id: z.string(), name: z.string() }),
        setBy: z.string(),
        setAt: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.qualifications");
    const account = input.account ?? ((await mayRoster(ctx)) ? undefined : actingAccount(ctx));
    if (account !== undefined && account !== actingAccount(ctx)) {
      await assertRosterer(ctx, "read someone else's qualifications");
    }
    let query = ctx.db.selectFrom("core_staff_qualification").selectAll();
    if (account !== undefined) query = query.where("account_id", "=", account);
    if (input.kindObject) query = query.where("kind_object", "=", input.kindObject);
    const rows = await query.orderBy("account_id").limit(500).execute();
    const names = new Map<string, string>();
    const users = rows.length
      ? await ctx.db
          .selectFrom("core_user")
          .select(["id", "name", "email"])
          .where("id", "in", jsonList([...new Set(rows.map((r) => r.account_id))]))
          .execute()
      : [];
    for (const u of users) names.set(u.id, u.name || u.email);
    const kindNames = new Map<string, string>();
    for (const kind of new Set(rows.map((r) => r.kind_object))) {
      const object = getObject(kind);
      const table = objectTableOf(kind);
      const title = object?.fields.find((f) => f.name === object.titleField)?.column;
      if (!object || !table || !title) continue;
      const ids = rows.filter((r) => r.kind_object === kind).map((r) => r.kind_record);
      const found = await sql<{ id: string; title: string | null }>`SELECT id, ${sql.ref(
        title,
      )} AS title FROM ${sql.table(table)} WHERE id IN ${jsonList(ids)}`.execute(ctx.db);
      for (const r of found.rows) kindNames.set(`${kind}\u0000${r.id}`, r.title ?? object.label);
    }
    return {
      items: rows.map((r) => ({
        account: r.account_id,
        name: names.get(r.account_id) ?? "",
        kind: {
          object: r.kind_object,
          id: r.kind_record,
          name: kindNames.get(`${r.kind_object}\u0000${r.kind_record}`) ?? "",
        },
        setBy: r.set_by,
        setAt: r.set_at,
      })),
    };
  },
});

// --- Unavailability -------------------------------------------------------------------------------

const awaySchema = z.object({
  id: z.string(),
  account: z.string(),
  name: z.string(),
  kind: z.enum(["leave", "regular", "other"]),
  note: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  weekdays: z.array(z.string()),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  fromDate: z.string().nullable(),
  untilDate: z.string().nullable(),
  zone: z.string(),
});

/** A local `YYYY-MM-DDTHH:MM` in `zone` as unix seconds. */
export function instantOf(local: string, zone: string): number {
  const [date, time] = local.split("T") as [string, string];
  const d = parseLocalDate(date);
  const minutes = parseLocalTime(time);
  if (!d || minutes === null) throw new ValidationError(`${local} is not a real date and time`);
  return (
    wallClockToInstant({ ...d, hour: Math.floor(minutes / 60), minute: minutes % 60 }, zone) / 1000
  );
}

/** Whose unavailability a call is about: the caller's own, or anyone's for a rosterer. */
async function awayAccount(
  ctx: HandlerContext,
  account: string | undefined,
  what: string,
): Promise<string> {
  const target = account ?? actingAccount(ctx);
  if (target !== actingAccount(ctx)) await assertRosterer(ctx, what);
  return target;
}

export const staffingAway = defineOperation({
  name: "staffing.away",
  description:
    "Tool-only (a shipped pack's tool): say when someone cannot work: leave or another one-off " +
    "time (startsAt and endsAt, local date-times in zone), or a regular time off (weekdays, a " +
    "local startTime and endTime, from fromDate until untilDate). Their own, or anyone's for " +
    "someone who rosters; a person's own act, never an assistant's. Nobody approves it. Shifts " +
    "they are already on stay theirs, with an unavailable warning: the answer lists them (to " +
    "offer in one step) and the rosterers are told. Only they and rosterers ever see it.",
  input: z.object({
    account: accountId.optional().describe("Whose; leave out for your own"),
    kind: z.enum(["leave", "other", "regular"]),
    note: z.string().max(500).optional(),
    startsAt: localDateTime.optional(),
    endsAt: localDateTime.optional(),
    weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
    startTime: localTime.optional(),
    endTime: localTime.optional(),
    fromDate: localDate.optional(),
    untilDate: localDate.optional(),
    zone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("IANA zone; the organisation's if left out"),
  }),
  output: z.object({
    id: z.string(),
    /** Their shifts from now on that it overlaps (at most 100), and how many in all. */
    shifts: z.array(shiftSummary),
    count: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  // The note never reaches the audit log (an admin's MCP client reads it): only they and
  // rosterers, through this pack's person-only screens, see it.
  redact: ["note"],
  auditSummary: (output) => ({ id: output.id, shifts: output.count }),
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.away");
    assertPersonsOwnAct(ctx, "Saying someone is away");
    const account = await awayAccount(ctx, input.account, "say someone else is away");
    await requireAccount(ctx, account);
    const zone = input.zone ?? (await loadGeneralSettings(ctx.db)).timezone;
    if (!isTimezone(zone))
      throw new ValidationError(`${zone} is not a time zone`, { field: "zone" });
    const id = newId("staffAway");
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    let rule: Parameters<typeof regularOverlaps>[0] | null = null;
    let range: { starts: number; ends: number } | null = null;
    if (input.kind === "regular") {
      if (!input.weekdays || !input.startTime || !input.endTime || !input.fromDate) {
        throw new ValidationError(
          "A regular time off needs weekdays, a start time, an end time and a first date",
          { field: "weekdays" },
        );
      }
      if (input.startsAt || input.endsAt) {
        throw new ValidationError("A regular time off has no one-off start or end", {
          field: "startsAt",
        });
      }
      if (input.untilDate && input.untilDate < input.fromDate) {
        throw new ValidationError("It must end on or after its first date", { field: "untilDate" });
      }
      rule = {
        weekdays: input.weekdays.join(","),
        start_time: input.startTime,
        end_time: input.endTime,
        from_date: input.fromDate,
        until_date: input.untilDate ?? null,
        zone,
      };
      ctx.write(
        ctx.db.insertInto("core_staff_away").values({
          id,
          account_id: account,
          kind: "regular",
          note: input.note ?? null,
          starts_at: null,
          ends_at: null,
          ...rule,
          set_by: actingAccount(ctx),
          set_at: ctx.now,
        }),
      );
    } else {
      if (!input.startsAt || !input.endsAt) {
        throw new ValidationError("Leave needs a start and an end", { field: "startsAt" });
      }
      if (input.weekdays || input.startTime || input.endTime) {
        throw new ValidationError("Leave has no weekdays or times of day", { field: "weekdays" });
      }
      range = { starts: instantOf(input.startsAt, zone), ends: instantOf(input.endsAt, zone) };
      if (!(range.ends > range.starts)) {
        throw new ValidationError("It must end after it starts", { field: "endsAt" });
      }
      ctx.write(
        ctx.db.insertInto("core_staff_away").values({
          id,
          account_id: account,
          kind: input.kind,
          note: input.note ?? null,
          starts_at: iso(range.starts),
          ends_at: iso(range.ends),
          weekdays: null,
          start_time: null,
          end_time: null,
          from_date: input.fromDate ?? null,
          until_date: input.untilDate ?? null,
          zone,
          set_by: actingAccount(ctx),
          set_at: ctx.now,
        }),
      );
    }
    // Their shifts from now on that it covers, from their claims (indexed by account and end).
    // A claim is widened by its margins (ADR 0760): read as a wider range, then kept by the
    // shift's own time.
    let claims = ctx.db
      .selectFrom("core_staff_time")
      .select(["object_type", "record_id", "starts", "ends", "margin_before", "margin_after"])
      .where("account_id", "=", account)
      .where("ends", ">", range ? Math.max(now, range.starts) : now);
    if (range) claims = claims.where("starts", "<", range.ends);
    const rows = (await claims.orderBy("starts").limit(1000).execute())
      .map((c) => ({ ...c, starts: c.starts + c.margin_before, ends: c.ends - c.margin_after }))
      .filter(
        (c) =>
          c.ends > (range ? Math.max(now, range.starts) : now) &&
          (!range || c.starts < range.ends) &&
          (!rule || regularOverlaps(rule, c.starts, c.ends)),
      );
    const shifts: ShiftSummary[] = [];
    for (const c of rows.slice(0, 100)) {
      const s = await loadShift(ctx, c.object_type, c.record_id);
      if (s) shifts.push(summary(s));
    }
    if (rows.length) {
      const name = await staffName(ctx.db, account);
      const when = range
        ? `from ${input.startsAt?.replace("T", " ")} to ${input.endsAt?.replace("T", " ")}`
        : `every ${input.weekdays?.join(", ")} ${input.startTime} to ${input.endTime} from ${input.fromDate}${input.untilDate ? ` until ${input.untilDate}` : ""}`;
      // About someone's availability: the rosterers only, and never to an AI acting for them.
      await queueNotice(ctx, {
        to: await rosterers(ctx.db),
        title: `${name} is away and is on ${rows.length} shift${rows.length === 1 ? "" : "s"}`,
        body: [
          `${name} is away ${when} and is on:`,
          ...shifts.slice(0, 20).map((s) => `${s.title}, ${s.startsAt}`),
          ...(rows.length > 20 ? [`and ${rows.length - 20} more`] : []),
        ].join("\n"),
        humanOnly: true,
      });
    }
    return { id, shifts, count: rows.length };
  },
});

export const staffingBack = defineOperation({
  name: "staffing.back",
  description:
    "Tool-only (a shipped pack's tool): remove a time someone said they cannot work (they are " +
    "back, or it was wrong). Their own, or anyone's for someone who rosters; a person's own act. " +
    "Returns its id.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.back");
    assertPersonsOwnAct(ctx, "Saying someone is back");
    const row = await ctx.db
      .selectFrom("core_staff_away")
      .select(["id", "account_id"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    // Someone else's is as if it were not there: other staff never learn that someone is away.
    if (!row || (row.account_id !== actingAccount(ctx) && !(await mayRoster(ctx)))) {
      throw new NotFoundError("unavailability", input.id);
    }
    ctx.write(ctx.db.deleteFrom("core_staff_away").where("id", "=", input.id));
    return { id: input.id };
  },
});

export const staffingAwayList = defineOperation({
  name: "staffing.awayList",
  description:
    "Tool-only (a shipped pack's tool): times people said they cannot work, with their notes (to " +
    "a person only: an assistant reading its person's own gets no notes), overlapping from..to " +
    "(local dates; default from today). Your own; someone who rosters reads anyone's, or " +
    "everyone's when account is left out, as a person. Nobody else ever sees it. Read-only.",
  input: z.object({
    account: accountId.optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  }),
  output: z.object({ items: z.array(awaySchema) }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.awayList");
    const account = input.account ?? ((await mayRoster(ctx)) ? undefined : actingAccount(ctx));
    if (account !== actingAccount(ctx)) {
      await assertRosterer(ctx, "read someone else's time off");
      // Other people's leave, with its notes, is read by a person, never by an assistant acting for
      // a rosterer (as the notice of leave over shifts is person-only).
      assertPersonsOwnAct(ctx, "Reading other people's time off");
    }
    const from = input.from ?? ctx.now.slice(0, 10);
    let query = ctx.db.selectFrom("core_staff_away").selectAll();
    if (account !== undefined) query = query.where("account_id", "=", account);
    query = query.where((eb) =>
      eb.or([
        eb.and([eb("kind", "!=", "regular"), eb("ends_at", ">=", from)]),
        eb.and([
          eb("kind", "=", "regular"),
          eb.or([eb("until_date", "is", null), eb("until_date", ">=", from)]),
        ]),
      ]),
    );
    if (input.to) {
      const to = input.to;
      query = query.where((eb) =>
        eb.or([
          eb.and([eb("kind", "!=", "regular"), eb("starts_at", "<=", `${to}T23:59:59.999Z`)]),
          eb.and([eb("kind", "=", "regular"), eb("from_date", "<=", to)]),
        ]),
      );
    }
    const rows = await query.orderBy("account_id").limit(500).execute();
    const users = rows.length
      ? await ctx.db
          .selectFrom("core_user")
          .select(["id", "name", "email"])
          .where("id", "in", jsonList([...new Set(rows.map((r) => r.account_id))]))
          .execute()
      : [];
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    // A note about someone's leave never reaches an AI, even one acting for that person: only a
    // person at the screen reads it (ADR 0626).
    const person = ctx.extension?.tool?.calledBy?.actor === "human";
    return {
      items: rows.map((r) => ({
        id: r.id,
        account: r.account_id,
        name: names.get(r.account_id) ?? "",
        kind: r.kind,
        note: person ? r.note : null,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        weekdays: r.weekdays ? r.weekdays.split(",") : [],
        startTime: r.start_time,
        endTime: r.end_time,
        fromDate: r.from_date,
        untilDate: r.until_date,
        zone: r.zone,
      })),
    };
  },
});

// --- Offers and takes -----------------------------------------------------------------------------

export const staffingOffer = defineOperation({
  name: "staffing.offer",
  description:
    "Tool-only (a shipped pack's tool): offer a shift for someone else to take, to everyone " +
    "eligible (qualified for its kind, free and available) or to one named person. The shift's " +
    "person offers their own; someone who rosters may offer anyone's, and an uncovered one. A " +
    "person's own act. Until it is taken the shift stays its person's. Offers close at the " +
    "cut-off (the Rostering setting, 60 minutes before the shift starts by default). Eligible " +
    "people are told.",
  input: z.object({
    object: objectName,
    id: recordId,
    to: accountId.optional().describe("Offer it to this person only"),
  }),
  output: z.object({
    offer: offerSchema,
    /** How many people were told (only someone who rosters sees it). */
    told: z.number().int().nullable(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ offer: output.offer.id, shift: output.offer.shift.id }),
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.offer");
    assertPersonsOwnAct(ctx, "Offering a shift");
    const s = await requireLiveShift(ctx, input.object, input.id);
    // A shift whose title may name a client (an appointment, ADR 0761) is never offered: the
    // offer would show it to others, and a client chose their provider. A rosterer reassigns it.
    if (s.object.staffed?.private) {
      throw new ConflictError(
        `A ${s.object.label.toLowerCase()} is not offered to others. Whoever rosters gives it to someone else.`,
        { rule: "offer_private" },
      );
    }
    assertLive(s);
    await assertBeforeCutoff(ctx, s);
    const mine = s.shift.account !== null && s.shift.account === actingAccount(ctx);
    if (!mine && !(await mayRoster(ctx))) {
      throw new ForbiddenError("Only the shift's person, or someone who rosters, may offer it.", {
        rule: "not_yours",
      });
    }
    if (await openOfferOn(ctx.db, s.object.name, s.id)) {
      throw new ConflictError("This shift is already offered.", { rule: "offer_open" });
    }
    const from = s.shift.account;
    let told: string[];
    if (input.to) {
      if (input.to === from) {
        throw new ValidationError("A shift is not offered to its own person", { field: "to" });
      }
      const e = await eligibilityOf(ctx, s, input.to);
      if (!e.active) throw new NotFoundError("user", input.to);
      // Never whether they are away: only they and rosterers learn that, at the take.
      if (!e.qualified) {
        throw new ConflictError(
          `${await staffName(ctx.db, input.to)} is not marked as qualified for this kind of work, so they could not take it.`,
          { rule: "not_qualified" },
        );
      }
      if (!e.person) {
        throw new ConflictError(
          `${await staffName(ctx.db, input.to)} has no profile this shift can name.`,
          { rule: "no_profile" },
        );
      }
      if (e.clash) {
        const claim = { account: input.to, starts: s.shift.starts ?? 0, ends: s.shift.ends ?? 0 };
        throw await doubleBooked(ctx, s.object.name, s.id, claim, e.clash);
      }
      told = [input.to];
    } else {
      // An offer nobody could ever take is refused, from qualifications alone (before anyone's
      // leave or shifts are looked at, so it says nothing about either).
      if (!(await anyoneQualified(ctx, s, from))) {
        throw new ConflictError(
          s.shift.kind
            ? "Nobody else is marked as qualified for this kind of work, so nobody could take it. Whoever rosters can mark people qualified, or reassign it."
            : "This shift has no kind of work set, so nobody could take it. Whoever rosters reassigns it.",
          { rule: "nobody_qualified" },
        );
      }
      told = await eligibleAccounts(ctx, s, new Set([from ?? "", actingAccount(ctx)]));
    }
    const made = makeOfferStatement(ctx, {
      object: s.object.name,
      id: s.id,
      from,
      to: input.to ?? null,
      starts: s.shift.starts as number,
      kind: kindOf(s),
    });
    ctx.write(made.statement);
    const title = shiftTitle(s.object, s.values);
    const when = await whenOf(ctx, s.shift.starts, shiftZone(s.object, s.values));
    const by = from ? await staffName(ctx.db, from) : "Whoever rosters";
    await queueNotice(ctx, {
      to: told,
      title: `Shift offered: ${title}, ${when}`,
      body: `${by} offers ${title}, ${when}. Take it in the app until ${(await rosterNumbers(ctx.db)).cutoffMinutes} minutes before it starts.`,
      link: shiftLink(s.object.name, s.id),
    });
    const offer = {
      id: made.id,
      object_type: s.object.name,
      record_id: s.id,
      from_account: from,
      made_by: actingAccount(ctx),
      to_account: input.to ?? null,
      starts: s.shift.starts as number,
      kind_object: kindOf(s)?.object ?? null,
      kind_record: kindOf(s)?.id ?? null,
      state: "open" as const,
      made_at: ctx.now,
      taken_by: null,
      taken_at: null,
      ended_at: null,
      ended_by: null,
      why: null,
    };
    return {
      offer: await offerOut(ctx, offer, s),
      told: (await mayRoster(ctx)) ? told.length : null,
    };
  },
});

export const staffingWithdraw = defineOperation({
  name: "staffing.withdraw",
  description:
    "Tool-only (a shipped pack's tool): withdraw an open offer of a shift. Whoever made it, or " +
    "someone who rosters; a person's own act. The shift stays its person's. Returns the offer.",
  input: z.object({ offer: z.string().min(1).max(64) }),
  output: z.object({ offer: offerSchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.withdraw");
    assertPersonsOwnAct(ctx, "Withdrawing an offer");
    const offer = await offerById(ctx.db, input.offer);
    if (!offer) throw new NotFoundError("offer", input.offer);
    const own = offer.from_account === actingAccount(ctx) || offer.made_by === actingAccount(ctx);
    if (!own && !(await mayRoster(ctx))) {
      throw new ForbiddenError(
        "Only whoever offered it, or someone who rosters, may withdraw it.",
        {
          rule: "not_yours",
        },
      );
    }
    if (offer.state !== "open") throw await closedOffer(ctx, offer);
    const by = await staffName(ctx.db, actingAccount(ctx));
    ctx.write(endOfferStatement(ctx, offer.id, "withdrawn", `Withdrawn by ${by}.`));
    const s = await loadShift(ctx, offer.object_type, offer.record_id);
    if (offer.from_account && offer.from_account !== actingAccount(ctx)) {
      const title = s ? shiftTitle(s.object, s.values) : "your shift";
      await queueNotice(ctx, {
        to: [offer.from_account],
        title: `Your offer was withdrawn: ${title}`,
        body: `${by} withdrew your offer of ${title}. The shift is still yours.`,
        link: shiftLink(offer.object_type, offer.record_id),
      });
    }
    return {
      offer: await offerOut(
        ctx,
        { ...offer, state: "withdrawn", ended_at: ctx.now, ended_by: actingAccount(ctx) },
        s,
      ),
    };
  },
});

/** The answer to a move of an offer that is no longer open: who took it, or what became of it. */
async function closedOffer(ctx: HandlerContext, offer: OfferRow): Promise<ConflictError> {
  if (offer.state === "taken" && offer.taken_by) {
    const name =
      offer.taken_by === actingAccount(ctx) ? "You" : await staffName(ctx.db, offer.taken_by);
    return new ConflictError(`${name} took this shift${name === "You" ? "" : " already"}.`, {
      rule: "offer_taken",
      takenBy: offer.taken_by,
      takenAt: offer.taken_at,
    });
  }
  return new ConflictError(`This offer was ${offer.state}, so it cannot be taken now.`, {
    rule: "offer_closed",
    state: offer.state,
  });
}

export const staffingTake = defineOperation({
  name: "staffing.take",
  description:
    "Tool-only (a shipped pack's tool): take an offered shift. Nobody approves it, because the " +
    "taker must be qualified for its kind (refused otherwise), free (refused as double_booked) " +
    "and taking it before the cut-off; someone away then is told and confirms with " +
    "confirmUnavailable. A person's own act. Exactly one of several takes at once wins; the " +
    "others are told who took it. The shift becomes the taker's, its offerer and the rosterers " +
    "are told.",
  input: z.object({
    offer: z.string().min(1).max(64),
    confirmUnavailable: z
      .boolean()
      .optional()
      .describe("You said you are not available then and take it anyway"),
  }),
  output: z.object({
    offer: z.string(),
    shift: shiftSummary,
    warnings: z.array(staffWarningSchema),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ offer: output.offer, shift: output.shift.id }),
  async explainFailure(error: OperationError, input, ctx) {
    const rule = (error.details as { rule?: unknown } | undefined)?.rule;
    if (rule !== "offer_closed") return null;
    const offer = await offerById(ctx.db, input.offer);
    return offer && offer.state !== "open" ? closedOffer(ctx, offer) : null;
  },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.take");
    assertPersonsOwnAct(ctx, "Taking a shift");
    const offer = await offerById(ctx.db, input.offer);
    if (!offer) throw new NotFoundError("offer", input.offer);
    if (offer.state !== "open") throw await closedOffer(ctx, offer);
    if (offer.from_account === actingAccount(ctx)) {
      throw new ConflictError("This is your own offer: withdraw it instead.", {
        rule: "own_offer",
      });
    }
    if (offer.to_account && offer.to_account !== actingAccount(ctx)) {
      throw new ForbiddenError("This shift is offered to someone else.", {
        rule: "offered_to_someone_else",
      });
    }
    const s = await requireLiveShift(ctx, offer.object_type, offer.record_id);
    // The shift is still the offerer's (or still has nobody, for an uncovered one): a take never
    // removes someone who did not offer it. Every write that changes the shift's person cancels its
    // open offer in its own batch; this refuses what got past (ADR 0623).
    if (s.shift.account !== offer.from_account || (!offer.from_account && s.shift.covered)) {
      throw new ConflictError(
        "This shift has changed hands since it was offered, so the offer no longer stands.",
        { rule: "offer_stale" },
      );
    }
    assertLive(s);
    await assertBeforeCutoff(ctx, s);
    const e = await eligibilityOf(ctx, s, actingAccount(ctx));
    if (!e.active) throw new ForbiddenError("This account cannot take shifts.");
    // Decision 5: nobody approves a take *because* the taker is qualified, so it is held to that.
    if (!e.qualified) {
      throw new ForbiddenError(
        "You are not marked as qualified for this kind of work, so you cannot take it. Whoever rosters can put you on it.",
        { rule: "not_qualified" },
      );
    }
    if (!e.person) {
      throw new ConflictError(
        "You have no profile this shift can name. Whoever rosters can add one.",
        {
          rule: "no_profile",
        },
      );
    }
    if (e.clash) {
      const claim = {
        account: actingAccount(ctx),
        starts: s.shift.starts ?? 0,
        ends: s.shift.ends ?? 0,
      };
      throw await doubleBooked(ctx, s.object.name, s.id, claim, e.clash);
    }
    if (e.away && !input.confirmUnavailable) {
      throw new ConflictError(
        "You said you are not available then. Take it anyway? Confirm to go ahead.",
        { rule: "unavailable_confirm" },
      );
    }
    // One batch: the offer moves out of open (the database refuses it if another take landed
    // first, failing all of this), then the person is written as an exception to its pattern,
    // its time claim moves with it (refused if it overlaps another of theirs), and the audit row.
    noteTaking(ctx, offer.id);
    ctx.write(takeOfferStatement(ctx, offer.id));
    const field = s.object.staffed?.who.field as string;
    await updateRecord(ctx, s.object, s.id, { [field]: e.person }, { by: "staff" });
    const title = shiftTitle(s.object, s.values);
    const when = await whenOf(ctx, s.shift.starts, shiftZone(s.object, s.values));
    const taker = await staffName(ctx.db, actingAccount(ctx));
    const link = shiftLink(s.object.name, s.id);
    const giver = offer.from_account ? await staffName(ctx.db, offer.from_account) : null;
    if (offer.from_account) {
      await queueNotice(ctx, {
        to: [offer.from_account],
        title: `${taker} took your shift: ${title}`,
        body: `${taker} took ${title}, ${when}. It is no longer yours.`,
        link,
      });
    }
    // The manager is told, not asked (decision 5).
    await queueNotice(ctx, {
      to: (await rosterers(ctx.db)).filter((r) => r !== offer.from_account),
      title: `${taker} took a shift: ${title}, ${when}`,
      body: giver
        ? `${taker} took ${title}, ${when}, from ${giver}.`
        : `${taker} took ${title}, ${when}, which had nobody on it.`,
      link,
    });
    return {
      offer: offer.id,
      shift: summary(s),
      warnings: warningsOf(ctx, s.object.name, s.id),
    };
  },
});

export const staffingOffers = defineOperation({
  name: "staffing.offers",
  description:
    "Tool-only (a shipped pack's tool): the open offers you could take now (qualified, free, " +
    "before the cut-off; `unavailable` says you said you are away then), and your own open " +
    "offers. Read-only.",
  input: z.object({}),
  output: z.object({
    open: z.array(offerSchema.extend({ unavailable: z.boolean() })),
    mine: z.array(offerSchema),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    await assertShippedToolRun(ctx, "staffing.offers");
    const me = actingAccount(ctx);
    // Filtered before the limit, by the offer's own columns: still before the cut-off, open to me,
    // not mine, of a kind I am qualified for; the soonest first. However many offers I cannot take
    // are open, the ones I can are not hidden behind them.
    const { cutoffMinutes } = await rosterNumbers(ctx.db);
    const closes = Math.floor(Date.parse(ctx.now) / 1000) + cutoffMinutes * 60;
    const rows = await ctx.db
      .selectFrom("core_staff_offer as o")
      .selectAll("o")
      .where("o.state", "=", "open")
      .where("o.starts", ">", closes)
      .where((eb) => eb.or([eb("o.to_account", "is", null), eb("o.to_account", "=", me)]))
      .where((eb) => eb.or([eb("o.from_account", "is", null), eb("o.from_account", "!=", me)]))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("core_staff_qualification as q")
            .select("q.account_id")
            .where("q.account_id", "=", me)
            .whereRef("q.kind_object", "=", "o.kind_object")
            .whereRef("q.kind_record", "=", "o.kind_record"),
        ),
      )
      .orderBy("o.starts")
      .limit(50)
      .execute();
    const open = [];
    for (const offer of rows) {
      const s = await loadShift(ctx, offer.object_type, offer.record_id);
      if (!s || s.deleted || !s.shift.live || pastCutoff(s.shift.starts, ctx.now, cutoffMinutes)) {
        continue;
      }
      const e = await eligibilityOf(ctx, s, me);
      if (!e.active || !e.qualified || !e.person || e.clash) continue;
      open.push({ ...(await offerOut(ctx, offer, s)), unavailable: e.away });
    }
    const own = await ctx.db
      .selectFrom("core_staff_offer")
      .selectAll()
      .where("state", "=", "open")
      .where("from_account", "=", me)
      .orderBy("made_at")
      .limit(50)
      .execute();
    const mine = [];
    for (const offer of own) {
      mine.push(
        await offerOut(ctx, offer, await loadShift(ctx, offer.object_type, offer.record_id)),
      );
    }
    return { open, mine };
  },
});

// --- The roster read (step 4) ---------------------------------------------------------------------

/** The most days one roster read covers (guess, the spec's). */
const WEEK_MAX_DAYS = 62;

const rosterShiftSchema = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  kind: z.object({ object: z.string(), id: z.string(), name: z.string() }).nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  zone: z.string().nullable(),
  place: z.string().nullable(),
  uncovered: z.boolean().describe("Nobody is on it"),
  noAccount: z
    .boolean()
    .describe("Its person has no staff account (a visiting coach): covered, on nobody's roster"),
  account: z.string().nullable(),
  name: z.string().nullable(),
  mine: z.boolean().describe("Its person is the reader"),
  offer: z
    .object({ id: z.string(), to: z.string().nullable(), from: z.string().nullable() })
    .nullable(),
  warnings: z
    .array(staffWarningSchema)
    .nullable()
    .describe("Someone who rosters only (null otherwise): unavailable, not_qualified, uncovered"),
  checklist: z
    .object({
      name: z.string(),
      state: z
        .enum(["not_started", "in_progress", "done", "missed", "cancelled"])
        .nullable()
        .describe("Its person and those who roster only, at the screen (null otherwise)"),
    })
    .nullable()
    .describe("Its checklist, if it has one"),
});

export const staffingWeek = defineOperation({
  name: "staffing.week",
  description:
    "Tool-only (a shipped pack's tool): the roster, every live shift of every kind (classes, " +
    "duty shifts) from `from` to `to` (local dates in the organisation's zone, both included; at " +
    `most ${WEEK_MAX_DAYS} days), in order of start: its kind, title, times, place, who is on it ` +
    "(and whether it is you), whether it has nobody on it, and its open offer (`truncated` when " +
    "more than 1,000 of one kind fall in the range). `mine` keeps " +
    "your own shifts, `account` one person's. Someone who rosters also gets each shift's " +
    "warnings. A shift whose title may name a client (an appointment) shows its kind as its " +
    "title, except to its own person and those who roster. Never a class's bookings, places or " +
    "list, nor any member. Read-only.",
  input: z.object({
    from: localDate,
    to: localDate,
    mine: z.boolean().optional().describe("Only your own shifts"),
    account: accountId.optional().describe("Only this person's shifts"),
  }),
  output: z.object({
    shifts: z.array(rosterShiftSchema),
    zone: z.string(),
    days: z
      .array(z.object({ date: z.string(), hours: z.number() }))
      .describe(
        "Each local date in the range and how many hours it has in the zone: 23 or 25 on a clock change",
      ),
    truncated: z
      .boolean()
      .describe("More shifts than one answer holds (1,000 of a kind): ask for fewer days"),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.week");
    const from = parseLocalDate(input.from);
    const to = parseLocalDate(input.to);
    if (!from) throw new ValidationError(`${input.from} is not a date`, { field: "from" });
    if (!to) throw new ValidationError(`${input.to} is not a date`, { field: "to" });
    if (input.to < input.from) {
      throw new ValidationError("It must end on or after its first date", { field: "to" });
    }
    const days =
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
        86_400_000 +
      1;
    if (days > WEEK_MAX_DAYS) {
      throw new ValidationError(`At most ${WEEK_MAX_DAYS} days at a time`, { field: "to" });
    }
    const { timezone } = await loadGeneralSettings(ctx.db);
    const start = wallClockToInstant({ ...from, hour: 0, minute: 0 }, timezone) / 1000;
    const end = wallClockToInstant({ ...addLocalDays(to, 1), hour: 0, minute: 0 }, timezone) / 1000;
    const rosterer = await mayRoster(ctx);
    const { shifts, truncated } = await rosterRange(
      ctx,
      { from: start, to: end, account: input.mine ? actingAccount(ctx) : input.account },
      actingAccount(ctx),
      {
        warnings: rosterer,
        // A private shift's client (ADR 0761): its own person and those who roster only.
        clients: rosterer,
        uncoveredDays: (await rosterNumbers(ctx.db)).uncoveredDays,
        // How a checklist is going is a person's to read at the screen (ADR 0650): a rosterer's
        // every shift's, anyone else their own; never an AI's.
        checklists:
          ctx.extension?.tool?.calledBy?.actor !== "human" ? "none" : rosterer ? "all" : "own",
      },
    );
    // Each day's length in the zone, from the host's clock: a screen never works it out from the
    // device's own zone (a clock change makes a 23- or 25-hour day).
    const dayList: { date: string; hours: number }[] = [];
    for (let day = from, n = 0; n < days; day = addLocalDays(day, 1), n++) {
      const begins = wallClockToInstant({ ...day, hour: 0, minute: 0 }, timezone);
      const next = wallClockToInstant({ ...addLocalDays(day, 1), hour: 0, minute: 0 }, timezone);
      const date = `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
      dayList.push({ date, hours: (next - begins) / 3_600_000 });
    }
    // Who is away is a person's to read (ADR 0629): an assistant acting for a rosterer gets the
    // shifts' other warnings, never `unavailable`.
    const forAi = withoutAway(ctx);
    return {
      shifts: forAi
        ? shifts.map((s) => ({ ...s, warnings: s.warnings ? forAi(s.warnings) : null }))
        : shifts,
      zone: timezone,
      days: dayList,
      truncated,
    };
  },
});

// --- Rosterers' writes and reads ------------------------------------------------------------------

export const staffingAssign = defineOperation({
  name: "staffing.assign",
  description:
    "Tool-only (a shipped pack's tool): put a staff account on a shift, or nobody (null). " +
    "Someone who rosters; an AI's request waits for a person, who sees the warnings first " +
    "(staffing.check). Made with its warnings (unavailable, not_qualified, uncovered), refused " +
    "as double_booked. A shift of a series keeps it as its own (the series' later changes leave " +
    "it). Its open offer is cancelled; the people on and off it are told.",
  input: z.object({ object: objectName, id: recordId, account: accountId.nullable() }),
  output: z.object({ shift: shiftSummary, warnings: z.array(staffWarningSchema) }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.assign");
    await assertRosterer(ctx, "put people on shifts");
    assertPersonApplies(ctx, "Putting someone on a shift");
    const s = await requireLiveShift(ctx, input.object, input.id);
    let value: string | null = null;
    if (input.account !== null) {
      await requireAccount(ctx, input.account);
      const e = await eligibilityOf(ctx, s, input.account);
      if (!e.person) {
        throw new ConflictError(
          `${await staffName(ctx.db, input.account)} has no profile this shift can name.`,
          { rule: "no_profile" },
        );
      }
      value = e.person;
    }
    const field = s.object.staffed?.who.field as string;
    await updateRecord(ctx, s.object, s.id, { [field]: value }, { by: "staff" });
    return { shift: summary(s), warnings: warningsOf(ctx, s.object.name, s.id) };
  },
});

export const staffingUncovered = defineOperation({
  name: "staffing.uncovered",
  description:
    "Tool-only (a shipped pack's tool): live shifts with nobody on them from now for `days` days " +
    `(default the uncovered window, a Rostering setting: ${DEFAULT_UNCOVERED_DAYS} days unless ` +
    "changed; at most 62), and whether each is offered. Someone who rosters. Read-only.",
  input: z.object({ days: z.number().int().min(1).max(62).optional() }),
  output: z.object({ items: z.array(shiftSummary.extend({ offered: z.boolean() })) }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.uncovered");
    await assertRosterer(ctx, "read the uncovered shifts");
    const now = Math.floor(Date.parse(ctx.now) / 1000);
    const days = input.days ?? (await rosterNumbers(ctx.db)).uncoveredDays;
    const shifts = await uncoveredShifts(ctx, now, now + days * 86_400);
    const offered = new Set(
      (
        await ctx.db
          .selectFrom("core_staff_offer")
          .select(["object_type", "record_id"])
          .where("state", "=", "open")
          .limit(1000)
          .execute()
      ).map((r) => `${r.object_type}\u0000${r.record_id}`),
    );
    return {
      items: shifts.map((s) => ({ ...s, offered: offered.has(`${s.object}\u0000${s.id}`) })),
    };
  },
});

// --- The minute cron ------------------------------------------------------------------------------

export const staffingDueOperation = defineOperation({
  name: "staffing.due",
  description:
    "Platform use only (the minute cron, as the host): open offers past their cut-off lapse and " +
    "their offerers and the rosterers are told; once a day the rosterers hear of every shift " +
    "with nobody on it in the uncovered window. Returns what it did.",
  input: z.object({}),
  output: z.object({
    lapsed: z.number().int(),
    cancelled: z.number().int(),
    uncovered: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  // The host's own step: never queued for review under an approval floor on automation writes.
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") throw new UnknownOperationError("staffing.due");
    return staffingDue(ctx);
  },
});

/** The minute cron's roster step (ADRs 0623 and 0624): one `staffing.due`, as the host. */
export async function runStaffingDue(
  db: CrmDb,
  { floor, clock }: { floor?: GateFloor; clock?: () => Date } = {},
): Promise<{ lapsed: number; cancelled: number; uncovered: number }> {
  const now = (clock?.() ?? new Date()).toISOString();
  if (!(await staffingWorkDue(db.query, now))) return { lapsed: 0, cancelled: 0, uncovered: 0 };
  return (await invoke(
    "staffing.due",
    {},
    {
      actor: "automation",
      user: SYSTEM_USER,
      origin: { surface: "system", automationId: "system.staffing" },
      db,
      ...(floor ? { floor } : {}),
      ...(clock ? { clock } : {}),
    },
  )) as { lapsed: number; cancelled: number; uncovered: number };
}

export const staffingOperations = [
  staffingCheck,
  staffingWeek,
  staffingQualify,
  staffingQualifications,
  staffingAway,
  staffingBack,
  staffingAwayList,
  staffingOffer,
  staffingWithdraw,
  staffingTake,
  staffingOffers,
  staffingAssign,
  staffingUncovered,
  staffingDueOperation,
] as const;
