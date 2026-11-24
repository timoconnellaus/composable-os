// Leave (stage 58 step 4, ADR 0853): types the business sets, requests and their days, approval,
// the balance ledger. Tool-only, as every staffing operation (ADR 0621): called from a shipped
// pack's tool run, acting for the staff account the pipeline verified as the tool's caller
// (`ctx.extension.tool.calledBy`, ADR 0625), never the input.
//
// Who may: a person asks for and cancels their own leave and reads their own requests and
// balances; an approver (whoever rosters, `rostering:manage`, decision 12) reads everyone's,
// approves, declines, cancels approved leave and asks for someone; nobody decides their own
// request (an admin may when nobody else can approve); a pay holder (`rostering:pay`) sets the
// types and the balances. Every call but reading the types and saving one is a person's at the
// screen, never an assistant's or MCP's, whatever is granted (the spec's "What an AI may do"):
// saving a type is applied by a pay holder (an AI may draft its name).
//
// What is kept from the audit log, notices and errors: every note, reason, amount and balance.
// The audit rows say which request or type, whose, and what moved.
import { CompiledQuery } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { isTimezone, loadGeneralSettings } from "../settings.ts";
import { shiftZone } from "../staffing/changes.ts";
import { kindObjectOf, type StoredShift } from "../staffing/index.ts";
import {
  balanceOf,
  type CoveredShift,
  coveredOf,
  coveredShifts,
  eligibleForShifts,
  type LeaveRange,
  type LeaveUnit,
  leaveRange,
  lockedOver,
  lockedRefusal,
  MAX_AMOUNT,
  MAX_LEAVE_DAYS,
  MAX_TAKEN_OFF,
  proposedAmounts,
} from "../staffing/leave.ts";
import { makeOfferStatement, pastCutoff, whenOf } from "../staffing/offers.ts";
import {
  actingAccount,
  isPayer,
  mayRoster,
  queueNotice,
  rosterers,
  rosterNumbers,
  shiftLink,
  staffName,
} from "../staffing/rosterers.ts";
import { updateRecord } from "./record.ts";
import { assertPersonApplies, assertShippedToolRun, requireAccount } from "./staffing.ts";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const localTime = z.string().regex(/^[0-2]\d:[0-5]\d$/, "a time, HH:MM");
const accountId = z.string().min(1).max(64);
const entityId = z.string().min(1).max(64);
const note = z.string().max(500);
const why = z.string().min(1).max(200);

// --- Who calls ------------------------------------------------------------------------------------

/** A person at the screen: the calling tool is `humanOnly` and was called by a person. */
function isPerson(ctx: HandlerContext): boolean {
  const tool = ctx.extension?.tool;
  return tool?.humanOnly === true && tool.calledBy?.actor === "human";
}

/**
 * A leave call: a shipped pack's tool, a person's own at the screen (never an AI acting for one,
 * whatever is granted). Refused otherwise, saying nothing of anyone's leave.
 */
async function assertLeaveCall(ctx: HandlerContext, name: string): Promise<void> {
  await assertShippedToolRun(ctx, name);
  if (!isPerson(ctx)) {
    throw new ForbiddenError(
      "Leave is asked for, decided and read by a person only, never by an assistant.",
      { rule: "human_only" },
    );
  }
}

async function assertApprover(ctx: HandlerContext, what: string): Promise<void> {
  if (!(await mayRoster(ctx))) {
    throw new ForbiddenError(`Only someone who approves leave may ${what}.`, { rule: "rostering" });
  }
}

async function assertPayHolder(ctx: HandlerContext, what: string): Promise<void> {
  if (!(await isPayer(ctx.db, actingAccount(ctx)))) {
    throw new ForbiddenError(`Only someone who handles pay may ${what}.`, { rule: "pay" });
  }
}

/**
 * Nobody decides their own leave (decision 12), except an admin when nobody else may approve: then
 * it is decided by themselves, and the request says so.
 */
async function assertNotOwn(ctx: HandlerContext, account: string): Promise<void> {
  const me = actingAccount(ctx);
  if (account !== me) return;
  const role = await ctx.db
    .selectFrom("core_user")
    .select("role")
    .where("id", "=", me)
    .executeTakeFirst();
  const others = (await rosterers(ctx.db)).filter((r) => r !== me);
  if (role?.role === "admin" && others.length === 0) return;
  throw new ForbiddenError(
    "Nobody decides their own leave: someone else who approves leave does.",
    {
      rule: "own_leave",
    },
  );
}

// --- Shapes ---------------------------------------------------------------------------------------

const typeSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.enum(["hours", "days"]),
  keepsBalance: z.boolean(),
  belowZero: z.enum(["warn", "refuse"]),
  paid: z.boolean(),
  active: z.boolean(),
  position: z.number().int(),
});

const daySchema = z.object({
  date: z.string(),
  /** In the type's unit: minutes for an hours type, hundredths of a day for a days type. */
  asked: z.number().int(),
  approved: z.number().int().nullable(),
});

const requestSchema = z.object({
  id: z.string(),
  account: z.string(),
  name: z.string(),
  type: z.object({ id: z.string(), name: z.string(), unit: z.enum(["hours", "days"]) }),
  startDate: z.string(),
  endDate: z.string(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  zone: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  state: z.enum(["requested", "approved", "declined", "cancelled"]),
  note: z.string().nullable(),
  askedBy: z.string(),
  askedAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  why: z.string().nullable(),
  days: z.array(daySchema),
  /** The days' amounts summed: approved once approved, asked before. */
  total: z.number().int(),
});
type RequestOut = z.infer<typeof requestSchema>;

const coveredSchema = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
});

const leaveWarning = z.object({
  code: z.literal("below_zero"),
  message: z.string(),
});
type LeaveWarning = z.infer<typeof leaveWarning>;

const amountsInput = z
  .array(z.object({ date: localDate, amount: z.number().int().min(0) }))
  .max(MAX_LEAVE_DAYS)
  .optional()
  .describe(
    "Each date's amount, in the type's unit (minutes for an hours type, hundredths of a day for a days type); the host's proposal where left out",
  );

type TypeRow = import("@composable-os/db").CoreDatabase["core_leave_type"];
type StoredType = Omit<TypeRow, "active" | "position"> & { active: number; position: number };
type RequestRow = import("@composable-os/db").CoreDatabase["core_leave_request"];

function typeOut(t: StoredType): z.infer<typeof typeSchema> {
  return {
    id: t.id,
    name: t.name,
    unit: t.unit,
    keepsBalance: t.keeps_balance === 1,
    belowZero: t.below_zero,
    paid: t.paid === 1,
    active: t.active === 1,
    position: t.position,
  };
}

async function loadType(ctx: HandlerContext, id: string): Promise<StoredType> {
  const row = await ctx.db
    .selectFrom("core_leave_type")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("leave type", id);
  return row;
}

async function loadRequest(ctx: HandlerContext, id: string): Promise<RequestRow> {
  const row = await ctx.db
    .selectFrom("core_leave_request")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("leave request", id);
  return row;
}

/** Requests as answers, with their days, types and names, in a few reads however many. */
async function requestsOut(
  ctx: HandlerContext,
  rows: readonly RequestRow[],
  overrides: Map<
    string,
    { state?: RequestRow["state"]; days?: Map<string, number | null> }
  > = new Map(),
): Promise<RequestOut[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const days = await ctx.db
    .selectFrom("core_leave_day")
    .selectAll()
    .where("request_id", "in", jsonList(ids))
    .orderBy("date")
    .execute();
  const types = await ctx.db
    .selectFrom("core_leave_type")
    .selectAll()
    .where("id", "in", jsonList([...new Set(rows.map((r) => r.type_id))]))
    .execute();
  const accounts = [
    ...new Set(rows.flatMap((r) => [r.account_id, r.decided_by].filter((a): a is string => !!a))),
  ];
  const users = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "email"])
    .where("id", "in", jsonList(accounts))
    .execute();
  const names = new Map(users.map((u) => [u.id, u.name || u.email]));
  const typeById = new Map(types.map((t) => [t.id, t]));
  // A note is the person's and the approvers': read only by a person at the screen (every leave
  // call is one), never in a notice or an error.
  const person = isPerson(ctx);
  return rows.map((r) => {
    const over = overrides.get(r.id);
    const mine = days
      .filter((d) => d.request_id === r.id)
      .map((d) => ({
        date: d.date,
        asked: d.asked,
        approved: over?.days?.has(d.date) ? (over.days.get(d.date) ?? null) : d.approved,
      }));
    const state = over?.state ?? r.state;
    const t = typeById.get(r.type_id);
    return {
      id: r.id,
      account: r.account_id,
      name: names.get(r.account_id) ?? "",
      type: { id: r.type_id, name: t?.name ?? "", unit: t?.unit ?? "days" },
      startDate: r.start_date,
      endDate: r.end_date,
      startTime: r.start_time,
      endTime: r.end_time,
      zone: r.zone,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      state,
      note: person ? r.note : null,
      askedBy: r.asked_by,
      askedAt: r.asked_at,
      decidedBy: r.decided_by,
      decidedByName: r.decided_by ? (names.get(r.decided_by) ?? null) : null,
      decidedAt: r.decided_at,
      why: r.why,
      days: mine,
      total: mine.reduce((n, d) => n + (state === "approved" ? (d.approved ?? 0) : d.asked), 0),
    };
  });
}

/** An amount as words a notice may carry: never the amount itself. */
const typeWord = (t: { name: string }) => t.name.toLowerCase();

/** The range a stored request covers, as unix seconds. */
const rangeOf = (r: Pick<RequestRow, "starts_at" | "ends_at">) => ({
  starts: Date.parse(r.starts_at) / 1000,
  ends: Date.parse(r.ends_at) / 1000,
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

// --- Types ----------------------------------------------------------------------------------------

export const staffingLeaveTypes = defineOperation({
  name: "staffing.leave.types",
  description:
    "Tool-only (a shipped pack's tool): the kinds of leave the business offers (none ship), in " +
    "order: each one's name, unit (hours or days), whether it keeps a balance and what a balance " +
    "below zero does (warn or refuse), and whether it is paid. Inactive ones only when asked. " +
    "Anyone on the team reads them. Read-only.",
  input: z.object({ inactive: z.boolean().optional().describe("Include types no longer offered") }),
  output: z.object({ items: z.array(typeSchema) }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.leave.types");
    let query = ctx.db.selectFrom("core_leave_type").selectAll();
    if (!input.inactive) query = query.where("active", "=", 1);
    const rows = await query.orderBy("position").orderBy("name").limit(200).execute();
    return { items: rows.map(typeOut) };
  },
});

export const staffingLeaveSaveType = defineOperation({
  name: "staffing.leave.saveType",
  description:
    "Tool-only (a shipped pack's tool): add a kind of leave (leave out id) or change one. Someone " +
    "who handles pay; an AI's draft waits for them. A type's unit never changes once leave or a " +
    "balance is recorded in it; a type no longer offered is made inactive, never removed. Which " +
    "types a business must offer is for it to confirm with its accountant or lawyer.",
  input: z.object({
    id: entityId.optional(),
    name: z.string().trim().min(1).max(80),
    unit: z.enum(["hours", "days"]),
    keepsBalance: z.boolean(),
    belowZero: z.enum(["warn", "refuse"]).default("warn"),
    paid: z.boolean(),
    active: z.boolean().default(true),
    position: z.number().int().min(0).max(1000).default(0),
  }),
  output: z.object({ type: typeSchema, created: z.boolean() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ type: output.type.id, created: output.created }),
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.leave.saveType");
    assertPersonApplies(ctx, "Saving a leave type");
    await assertPayHolder(ctx, "set the kinds of leave");
    const me = actingAccount(ctx);
    const same = await ctx.db
      .selectFrom("core_leave_type")
      .select("id")
      .where(({ fn, eb }) => eb(fn("lower", ["name"]), "=", input.name.toLowerCase()))
      .executeTakeFirst();
    if (same && same.id !== input.id) {
      throw new ConflictError(`There is already a leave type called ${input.name}.`, {
        rule: "leave_type_name",
      });
    }
    const values = {
      name: input.name,
      unit: input.unit,
      keeps_balance: input.keepsBalance ? 1 : 0,
      below_zero: input.belowZero,
      paid: input.paid ? 1 : 0,
      active: input.active ? 1 : 0,
      position: input.position,
      updated_by: me,
      updated_at: ctx.now,
    };
    if (input.id) {
      const was = await loadType(ctx, input.id);
      ctx.write(ctx.db.updateTable("core_leave_type").set(values).where("id", "=", input.id));
      return {
        type: typeOut({ ...was, ...values }),
        created: false,
      };
    }
    const id = newId("leaveType");
    const row = { id, ...values, created_by: me, created_at: ctx.now };
    ctx.write(ctx.db.insertInto("core_leave_type").values(row));
    return { type: typeOut(row), created: true };
  },
});

// --- Asking -------------------------------------------------------------------------------------

const askInput = {
  type: entityId,
  startDate: localDate,
  endDate: localDate.optional().describe("The last whole day; leave out for one day"),
  startTime: localTime.optional().describe("Part of one day: its local start"),
  endTime: localTime.optional().describe("Part of one day: its local end"),
  amounts: amountsInput,
  note: note.optional().describe("Seen by you and whoever approves leave only"),
  preview: z
    .boolean()
    .optional()
    .describe("Answer the proposed amounts, balance after and shifts covered; write nothing"),
};

const askOutput = z.object({
  /** Null for a preview. */
  request: requestSchema.nullable(),
  proposed: z.array(z.object({ date: z.string(), amount: z.number().int() })),
  /** The balance now and after this leave, in the type's unit; null for a type with none. */
  balance: z.number().int().nullable(),
  balanceAfter: z.number().int().nullable(),
  /** Their shifts it covers that have not started (at most 40 named), and how many. */
  shifts: z.array(coveredSchema),
  shiftCount: z.number().int(),
  warnings: z.array(leaveWarning),
});

interface Asked {
  type: StoredType;
  zone: string;
  range: LeaveRange;
  amounts: Map<string, number>;
  proposed: Map<string, number>;
  total: number;
  balance: number | null;
}

/** The amounts given, checked against the request's dates and the type's unit, over `base`. */
function amountsOver(
  base: Map<string, number>,
  given: readonly { date: string; amount: number }[] | undefined,
  unit: LeaveUnit,
): Map<string, number> {
  const out = new Map(base);
  for (const a of given ?? []) {
    if (!out.has(a.date)) {
      throw new ValidationError(`${a.date} is not a date of this leave`, { field: "amounts" });
    }
    if (a.amount > MAX_AMOUNT[unit]) {
      throw new ValidationError(
        unit === "hours"
          ? "An amount is at most a day's minutes (1440)"
          : "An amount is at most one day (100 hundredths)",
        { field: "amounts" },
      );
    }
    out.set(a.date, a.amount);
  }
  return out;
}

/** What a new request for `account` would be, refused where it may not be asked. */
async function planAsk(
  ctx: HandlerContext,
  account: string,
  input: {
    type: string;
    startDate: string;
    endDate?: string | undefined;
    startTime?: string | undefined;
    endTime?: string | undefined;
    amounts?: { date: string; amount: number }[] | undefined;
  },
): Promise<Asked> {
  const type = await loadType(ctx, input.type);
  if (!type.active) {
    throw new ConflictError(`${type.name} is no longer offered.`, { rule: "leave_type_inactive" });
  }
  const { timezone: zone } = await loadGeneralSettings(ctx.db);
  if (!isTimezone(zone)) throw new ValidationError(`${zone} is not a time zone`);
  const partDay = input.startTime !== undefined || input.endTime !== undefined;
  const range = leaveRange(zone, {
    startDate: input.startDate,
    endDate: input.endDate,
    ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
    ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
  });
  const last = range.dates[range.dates.length - 1] as string;
  if (await lockedOver(ctx.db, input.startDate, last)) throw lockedRefusal();
  // One person's leave never overlaps their own other leave (asked or approved).
  const overlapping = await ctx.db
    .selectFrom("core_leave_request")
    .select("id")
    .where("account_id", "=", account)
    .where("state", "in", ["requested", "approved"])
    .where("end_date", ">=", input.startDate)
    .where("start_date", "<=", last)
    .where("starts_at", "<", iso(range.ends))
    .where("ends_at", ">", iso(range.starts))
    .limit(1)
    .executeTakeFirst();
  if (overlapping) {
    throw new ConflictError(
      "This overlaps leave already asked for or approved. Cancel that first.",
      {
        rule: "leave_overlap",
        request: overlapping.id,
      },
    );
  }
  const proposed = await proposedAmounts(ctx.db, account, type.unit, range, partDay);
  const amounts = amountsOver(proposed, input.amounts, type.unit);
  const total = [...amounts.values()].reduce((n, a) => n + a, 0);
  const balance = type.keeps_balance ? await balanceOf(ctx.db, account, type.id) : null;
  return { type, zone, range, amounts, proposed, total, balance };
}

/**
 * The warning (or, for a type that refuses, the refusal) of a balance this leave takes below 0. A
 * preview is answered with the warning either way, saying it would be refused.
 */
function belowZero(
  type: StoredType,
  balance: number | null,
  total: number,
  preview = false,
): LeaveWarning[] {
  if (balance === null || balance - total >= 0) return [];
  if (type.below_zero === "refuse" && preview) {
    return [
      {
        code: "below_zero",
        message: `This leave would take the ${type.name} balance below zero, which this type does not allow: it would be refused.`,
      },
    ];
  }
  if (type.below_zero === "refuse") {
    throw new ConflictError(
      `This leave would take the ${type.name} balance below zero, which this type does not allow.`,
      { rule: "leave_below_zero" },
    );
  }
  return [
    {
      code: "below_zero",
      message: `This leave takes the ${type.name} balance below zero.`,
    },
  ];
}

/** The statements of a new request and its days, in the caller's batch. */
function writeAsk(
  ctx: HandlerContext,
  account: string,
  plan: Asked,
  input: { startDate: string; startTime?: string | undefined; endTime?: string | undefined },
  noteText: string | undefined,
): RequestRow {
  const id = newId("leaveRequest");
  const row: RequestRow = {
    id,
    account_id: account,
    type_id: plan.type.id,
    start_date: input.startDate,
    end_date: plan.range.dates[plan.range.dates.length - 1] as string,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
    zone: plan.zone,
    starts_at: iso(plan.range.starts),
    ends_at: iso(plan.range.ends),
    state: "requested",
    note: noteText ?? null,
    asked_by: actingAccount(ctx),
    asked_at: ctx.now,
    decided_by: null,
    decided_at: null,
    why: null,
    updated_at: ctx.now,
  };
  ctx.write(ctx.db.insertInto("core_leave_request").values(row));
  // Every day in one statement (one bound value however many days).
  ctx.write(
    CompiledQuery.raw(
      "INSERT INTO core_leave_day (request_id, date, asked, approved) SELECT ?, json_extract(value, '$.date'), json_extract(value, '$.amount'), NULL FROM json_each(?)",
      [id, JSON.stringify([...plan.amounts].map(([date, amount]) => ({ date, amount })))],
    ),
  );
  return row;
}

async function askAnswer(
  ctx: HandlerContext,
  account: string,
  plan: Asked,
  warnings: LeaveWarning[],
  request: RequestOut | null,
): Promise<z.input<typeof askOutput>> {
  const { shifts, count } = await coveredShifts(ctx, account, plan.range);
  return {
    request,
    proposed: [...plan.proposed].map(([date, amount]) => ({ date, amount })),
    balance: plan.balance,
    balanceAfter: plan.balance === null ? null : plan.balance - plan.total,
    shifts: shifts.map(coveredOf),
    shiftCount: count,
    warnings,
  };
}

export const staffingLeaveRequest = defineOperation({
  name: "staffing.leave.request",
  description:
    "Tool-only (a shipped pack's tool): ask for leave of a type the business sets: whole days " +
    "(startDate to endDate), or part of one day (startDate, startTime, endTime), local in the " +
    "organisation's zone. The host proposes each date's amount from your rostered minutes that " +
    "day (an hours type) or one day each (a days type); give amounts to change them. Answers the " +
    "balance after and the shifts it covers; preview writes nothing. Refused into a locked pay " +
    "period, over your own other leave, and below zero for a type that refuses it. Your own, a " +
    "person's own act; whoever approves leave is told.",
  input: z.object(askInput),
  output: askOutput,
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note", "amounts"],
  auditSummary: (output) => ({ request: output.request?.id ?? null }),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.request");
    const me = actingAccount(ctx);
    await requireAccount(ctx, me);
    const plan = await planAsk(ctx, me, input);
    const warnings = belowZero(plan.type, plan.balance, plan.total, input.preview);
    if (input.preview) return askAnswer(ctx, me, plan, warnings, null);
    const row = writeAsk(ctx, me, plan, input, input.note);
    const name = await staffName(ctx.db, me);
    // To the approvers: who and when, never the note or an amount.
    await queueNotice(ctx, {
      to: await rosterers(ctx.db),
      title: `${name} asks for ${typeWord(plan.type)} leave`,
      body: `${name} asks for ${typeWord(plan.type)} leave ${row.start_date === row.end_date ? `on ${row.start_date}` : `from ${row.start_date} to ${row.end_date}`}. Approve or decline it in Time off.`,
      humanOnly: true,
    });
    const days = new Map<string, number | null>([...plan.amounts].map(([d]) => [d, null]));
    const [out] = await requestsOutPlanned(ctx, row, plan.amounts, days);
    return askAnswer(ctx, me, plan, warnings, out ?? null);
  },
});

/** A request just written in this batch, as an answer (its days are not stored yet). */
async function requestsOutPlanned(
  ctx: HandlerContext,
  row: RequestRow,
  asked: Map<string, number>,
  approved: Map<string, number | null>,
): Promise<RequestOut[]> {
  const type = await loadType(ctx, row.type_id);
  const users = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "email"])
    .where("id", "in", jsonList([row.account_id, row.decided_by ?? row.account_id]))
    .execute();
  const names = new Map(users.map((u) => [u.id, u.name || u.email]));
  const days = [...asked].map(([date, n]) => ({
    date,
    asked: n,
    approved: approved.get(date) ?? null,
  }));
  return [
    {
      id: row.id,
      account: row.account_id,
      name: names.get(row.account_id) ?? "",
      type: { id: type.id, name: type.name, unit: type.unit },
      startDate: row.start_date,
      endDate: row.end_date,
      startTime: row.start_time,
      endTime: row.end_time,
      zone: row.zone,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      state: row.state,
      note: row.note,
      askedBy: row.asked_by,
      askedAt: row.asked_at,
      decidedBy: row.decided_by,
      decidedByName: row.decided_by ? (names.get(row.decided_by) ?? null) : null,
      decidedAt: row.decided_at,
      why: row.why,
      days,
      total: days.reduce((n, d) => n + (row.state === "approved" ? (d.approved ?? 0) : d.asked), 0),
    },
  ];
}

// --- Approving ------------------------------------------------------------------------------------

const approveOutput = z.object({
  request: requestSchema,
  warnings: z.array(leaveWarning),
  /** The shifts it took them off: offered to everyone eligible, or with nobody offered. */
  offered: z.array(coveredSchema.extend({ told: z.number().int() })),
  uncovered: z.array(coveredSchema),
});

/** Never taken off silently beyond what one approval does: refused, whole, with what to do. */
function tooManyShifts(): ConflictError {
  return new ConflictError(
    `This leave covers more than ${MAX_TAKEN_OFF} of their shifts, more than one approval takes them off at once. Give some of them to others first, then approve it.`,
    { rule: "leave_too_many_shifts", max: MAX_TAKEN_OFF },
  );
}

/** What approving leave did to the shifts it covers. */
interface TakenOff {
  offered: (CoveredShift & { told: number })[];
  uncovered: CoveredShift[];
}

/**
 * Takes `account` off each of `shifts` (a record write of its person field to nobody, as
 * `staffing.assign` makes) and offers each to everyone eligible (as `staffing.offer` makes for an
 * uncovered shift), in the caller's batch; then tells the rosterers which are offered and which
 * have nobody who could take them. A shift past its offers' cut-off is taken off and not offered.
 */
async function takeOffShifts(
  ctx: HandlerContext,
  account: string,
  shifts: readonly StoredShift[],
): Promise<TakenOff> {
  const answer: TakenOff = { offered: [], uncovered: [] };
  if (!shifts.length) return answer;
  if (shifts.length > MAX_TAKEN_OFF) throw tooManyShifts();
  const { cutoffMinutes } = await rosterNumbers(ctx.db);
  const { timezone } = await loadGeneralSettings(ctx.db);
  // Who may take each, read once for all of them before any is changed (taking the person off
  // changes nobody else's claims or unavailability).
  const open = shifts.filter((s) => !pastCutoff(s.shift.starts, ctx.now, cutoffMinutes));
  const eligible = await eligibleForShifts(ctx, open, new Set([account, actingAccount(ctx)]));
  // Each person told once, with every shift offered to them.
  const toldOf = new Map<string, { line: string; link: ReturnType<typeof shiftLink> }[]>();
  for (const s of shifts) {
    const field = s.object.staffed?.who.field as string;
    await updateRecord(
      ctx,
      getObject(s.object.name) ?? s.object,
      s.id,
      { [field]: null },
      {
        by: "staff",
      },
    );
    const covered = coveredOf(s);
    const told = pastCutoff(s.shift.starts, ctx.now, cutoffMinutes)
      ? []
      : (eligible.get(`${s.object.name}\u0000${s.id}`) ?? []);
    if (!told.length) {
      answer.uncovered.push(covered);
      continue;
    }
    const kindObject = kindObjectOf(s.object);
    ctx.write(
      makeOfferStatement(ctx, {
        object: s.object.name,
        id: s.id,
        from: null,
        to: null,
        starts: s.shift.starts as number,
        kind: kindObject && s.shift.kind ? { object: kindObject, id: s.shift.kind } : null,
      }).statement,
    );
    const line = `${covered.title}, ${await whenOf(ctx, s.shift.starts, shiftZone(s.object, s.values) ?? timezone)}`;
    for (const a of told) {
      toldOf.set(a, [...(toldOf.get(a) ?? []), { line, link: shiftLink(s.object.name, s.id) }]);
    }
    answer.offered.push({ ...covered, told: told.length });
  }
  for (const [a, offers] of toldOf) {
    const first = offers[0] as (typeof offers)[number];
    await queueNotice(ctx, {
      to: [a],
      title:
        offers.length === 1
          ? `Shift offered: ${first.line}`
          : `${offers.length} shifts offered to you`,
      body: [
        offers.length === 1
          ? `Whoever rosters offers ${first.line}.`
          : "Whoever rosters offers these shifts:",
        ...(offers.length === 1 ? [] : offers.slice(0, 20).map((o) => o.line)),
        ...(offers.length > 20 ? [`and ${offers.length - 20} more`] : []),
        `Take one in the app until ${cutoffMinutes} minutes before it starts.`,
      ].join("\n"),
      link: offers.length === 1 ? first.link : null,
    });
  }
  // Stage 45's notice of someone away over their shifts, with what became of each: that they are
  // away, never why, and to people at the screen only.
  const name = await staffName(ctx.db, account);
  const line = async (c: CoveredShift) =>
    `${c.title}, ${await whenOf(ctx, Date.parse(c.startsAt) / 1000, timezone)}`;
  const offered: string[] = [];
  for (const c of answer.offered) offered.push(await line(c));
  const uncovered: string[] = [];
  for (const c of answer.uncovered) uncovered.push(await line(c));
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title: `${name} is on leave: off ${shifts.length} shift${shifts.length === 1 ? "" : "s"}, ${answer.uncovered.length} not offered`,
    body: [
      ...(offered.length ? ["Offered to everyone who can take it:", ...offered] : []),
      ...(uncovered.length ? ["Nobody could be offered it (reassign it):", ...uncovered] : []),
    ].join("\n"),
    humanOnly: true,
  });
  return answer;
}

/**
 * Approves `request` in the caller's batch: the days' approved amounts, the request (guarded by
 * the database: only from `requested`, so two approvals at once apply once), the balance entry
 * (when the type keeps one; refused by the database below zero for a type that refuses it), the
 * unavailability row, and the person taken off each covered shift that has not started.
 */
async function approve(
  ctx: HandlerContext,
  request: RequestRow,
  asked: Map<string, number>,
  given: { date: string; amount: number }[] | undefined,
): Promise<z.input<typeof approveOutput>> {
  const type = await loadType(ctx, request.type_id);
  if (await lockedOver(ctx.db, request.start_date, request.end_date)) throw lockedRefusal();
  const approved = amountsOver(asked, given, type.unit);
  const total = [...approved.values()].reduce((n, a) => n + a, 0);
  const balance = type.keeps_balance ? await balanceOf(ctx.db, request.account_id, type.id) : null;
  const warnings = belowZero(type, balance, total);
  const me = actingAccount(ctx);
  // The days first (their trigger allows it only while the request waits), in one statement.
  ctx.write(
    CompiledQuery.raw(
      "UPDATE core_leave_day SET approved = coalesce((SELECT json_extract(j.value, '$.amount') FROM json_each(?) j WHERE json_extract(j.value, '$.date') = core_leave_day.date), asked) WHERE request_id = ?",
      [JSON.stringify([...approved].map(([date, amount]) => ({ date, amount }))), request.id],
    ),
  );
  ctx.write(
    ctx.db
      .updateTable("core_leave_request")
      .set({ state: "approved", decided_by: me, decided_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", request.id),
  );
  if (type.keeps_balance && total > 0) {
    ctx.write(
      ctx.db.insertInto("core_leave_balance_entry").values({
        id: newId("leaveBalanceEntry"),
        account_id: request.account_id,
        type_id: type.id,
        amount: -total,
        why: "approved",
        request_id: request.id,
        note: null,
        made_by: me,
        made_at: ctx.now,
      }),
    );
  }
  // Stage 45's unavailability, so its warning, eligibility and notice hold unchanged (ADR 0622).
  ctx.write(
    ctx.db.insertInto("core_staff_away").values({
      id: newId("staffAway"),
      account_id: request.account_id,
      kind: "leave",
      note: null,
      starts_at: request.starts_at,
      ends_at: request.ends_at,
      weekdays: null,
      start_time: null,
      end_time: null,
      from_date: null,
      until_date: null,
      zone: request.zone,
      set_by: me,
      set_at: ctx.now,
      leave_request: request.id,
    }),
  );
  const { shifts, count } = await coveredShifts(ctx, request.account_id, rangeOf(request));
  if (count > MAX_TAKEN_OFF) throw tooManyShifts();
  const taken = await takeOffShifts(ctx, request.account_id, shifts);
  await queueNotice(ctx, {
    to: [request.account_id],
    title: `Your ${typeWord(type)} leave is approved`,
    body: `${await staffName(ctx.db, me)} approved your ${typeWord(type)} leave ${request.start_date === request.end_date ? `on ${request.start_date}` : `from ${request.start_date} to ${request.end_date}`}.${shifts.length ? " You are off the shifts it covers." : ""}`,
    humanOnly: true,
  });
  const days = new Map<string, number | null>(approved);
  const [out] = await requestsOutPlanned(
    ctx,
    { ...request, state: "approved", decided_by: me, decided_at: ctx.now, updated_at: ctx.now },
    asked,
    days,
  );
  return {
    request: out as RequestOut,
    warnings,
    offered: taken.offered,
    uncovered: taken.uncovered,
  };
}

/** A request's days as asked, by date. */
async function askedOf(ctx: HandlerContext, request: string): Promise<Map<string, number>> {
  const rows = await ctx.db
    .selectFrom("core_leave_day")
    .select(["date", "asked"])
    .where("request_id", "=", request)
    .orderBy("date")
    .execute();
  return new Map(rows.map((r) => [r.date, r.asked]));
}

function closedRequest(r: RequestRow): ConflictError {
  return new ConflictError(`This leave request is ${r.state}, so it cannot be changed now.`, {
    rule: "leave_closed",
    state: r.state,
  });
}

/** After a race the database decided: the request as it now stands. */
async function explainLeave(error: { details?: unknown }, id: string, ctx: HandlerContext) {
  const rule = (error.details as { rule?: unknown } | undefined)?.rule;
  if (rule !== "leave_closed") return null;
  const row = await ctx.db
    .selectFrom("core_leave_request")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row && row.state !== "requested" ? closedRequest(row) : null;
}

export const staffingLeaveApprove = defineOperation({
  name: "staffing.leave.approve",
  description:
    "Tool-only (a shipped pack's tool): approve a leave request, as asked or with amounts " +
    "changed. Whoever approves leave, never their own. In one batch: the balance entry (for a " +
    "type that keeps one; refused below zero for a type that refuses it, warned otherwise), the " +
    "person away then (stage 45's unavailability), and the person taken off each shift it covers " +
    "that has not started, each offered to everyone eligible. Answers which shifts were offered " +
    "and which have nobody offered; the person and the rosterers are told.",
  input: z.object({ id: entityId, amounts: amountsInput }),
  output: approveOutput,
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["amounts"],
  auditSummary: (output) => ({
    request: output.request.id,
    account: output.request.account,
    shifts: output.offered.length + output.uncovered.length,
  }),
  explainFailure: (error, input, ctx) => explainLeave(error, input.id, ctx),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.approve");
    await assertApprover(ctx, "approve leave");
    const request = await loadRequest(ctx, input.id);
    if (request.state !== "requested") throw closedRequest(request);
    await assertNotOwn(ctx, request.account_id);
    return approve(ctx, request, await askedOf(ctx, request.id), input.amounts);
  },
});

export const staffingLeaveDecline = defineOperation({
  name: "staffing.leave.decline",
  description:
    "Tool-only (a shipped pack's tool): decline a leave request, saying why (seen by them and " +
    "whoever approves leave). Whoever approves leave, never their own. The person is told.",
  input: z.object({ id: entityId, why }),
  output: z.object({ request: requestSchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["why"],
  auditSummary: (output) => ({ request: output.request.id, account: output.request.account }),
  explainFailure: (error, input, ctx) => explainLeave(error, input.id, ctx),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.decline");
    await assertApprover(ctx, "decline leave");
    const request = await loadRequest(ctx, input.id);
    if (request.state !== "requested") throw closedRequest(request);
    await assertNotOwn(ctx, request.account_id);
    const me = actingAccount(ctx);
    ctx.write(
      ctx.db
        .updateTable("core_leave_request")
        .set({
          state: "declined",
          decided_by: me,
          decided_at: ctx.now,
          why: input.why,
          updated_at: ctx.now,
        })
        .where("id", "=", request.id),
    );
    const type = await loadType(ctx, request.type_id);
    await queueNotice(ctx, {
      to: [request.account_id],
      title: `Your ${typeWord(type)} leave was declined`,
      body: `${await staffName(ctx.db, me)} declined your ${typeWord(type)} leave from ${request.start_date}. See why in My time off.`,
      humanOnly: true,
    });
    const [out] = await requestsOut(ctx, [
      { ...request, state: "declined", decided_by: me, decided_at: ctx.now, why: input.why },
    ]);
    return { request: out as RequestOut };
  },
});

/**
 * Cancels an approved request in the caller's batch: the request, its unavailability row removed,
 * and its balance entry reversed. Shifts it took them off are not put back (the rosterers are
 * told and reassign).
 */
async function cancelApproved(ctx: HandlerContext, request: RequestRow, reason: string | null) {
  if (await lockedOver(ctx.db, request.start_date, request.end_date)) throw lockedRefusal();
  const me = actingAccount(ctx);
  ctx.write(
    ctx.db
      .updateTable("core_leave_request")
      .set({ state: "cancelled", why: reason, updated_at: ctx.now })
      .where("id", "=", request.id),
    ctx.db.deleteFrom("core_staff_away").where("leave_request", "=", request.id),
  );
  const entry = await ctx.db
    .selectFrom("core_leave_balance_entry")
    .select(["amount", "type_id"])
    .where("request_id", "=", request.id)
    .where("why", "=", "approved")
    .executeTakeFirst();
  if (entry) {
    ctx.write(
      ctx.db.insertInto("core_leave_balance_entry").values({
        id: newId("leaveBalanceEntry"),
        account_id: request.account_id,
        type_id: entry.type_id,
        amount: -entry.amount,
        why: "cancelled",
        request_id: request.id,
        note: null,
        made_by: me,
        made_at: ctx.now,
      }),
    );
  }
  const type = await loadType(ctx, request.type_id);
  const name = await staffName(ctx.db, request.account_id);
  const when =
    request.start_date === request.end_date
      ? `on ${request.start_date}`
      : `from ${request.start_date} to ${request.end_date}`;
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title: `${name}'s ${typeWord(type)} leave was cancelled`,
    body: `${name}'s approved ${typeWord(type)} leave ${when} was cancelled. Shifts it took them off are not given back: reassign them if needed.`,
    humanOnly: true,
  });
  await queueNotice(ctx, {
    to: [request.account_id],
    title: `Your ${typeWord(type)} leave was cancelled`,
    body: `Your approved ${typeWord(type)} leave ${when} was cancelled by ${await staffName(ctx.db, me)}.`,
    humanOnly: true,
  });
}

export const staffingLeaveCancel = defineOperation({
  name: "staffing.leave.cancel",
  description:
    "Tool-only (a shipped pack's tool): cancel your own leave request: one still waiting, or an " +
    "approved one that has not started (the balance is given back and you are no longer away; " +
    "shifts it took you off are not given back). A person's own act.",
  input: z.object({ id: entityId }),
  output: z.object({ request: requestSchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ request: output.request.id }),
  explainFailure: (error, input, ctx) => explainLeave(error, input.id, ctx),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.cancel");
    const me = actingAccount(ctx);
    const request = await loadRequest(ctx, input.id).catch(() => null);
    // Someone else's is as if it were not there.
    if (!request || request.account_id !== me) throw new NotFoundError("leave request", input.id);
    if (request.state === "requested") {
      ctx.write(
        ctx.db
          .updateTable("core_leave_request")
          .set({ state: "cancelled", decided_by: me, decided_at: ctx.now, updated_at: ctx.now })
          .where("id", "=", request.id),
      );
      const [out] = await requestsOut(ctx, [
        { ...request, state: "cancelled", decided_by: me, decided_at: ctx.now },
      ]);
      return { request: out as RequestOut };
    }
    if (request.state !== "approved") throw closedRequest(request);
    if (Date.parse(request.starts_at) <= Date.parse(ctx.now)) {
      throw new ConflictError(
        "This leave has started, so only whoever approves leave can cancel it now.",
        { rule: "leave_started" },
      );
    }
    await cancelApproved(ctx, request, null);
    const [out] = await requestsOut(
      ctx,
      [request],
      new Map([[request.id, { state: "cancelled" }]]),
    );
    return { request: out as RequestOut };
  },
});

export const staffingLeaveCancelApproved = defineOperation({
  name: "staffing.leave.cancelApproved",
  description:
    "Tool-only (a shipped pack's tool): cancel someone's approved leave, saying why, while its " +
    "pay period is open: the balance is given back and they are no longer away; shifts it took " +
    "them off are not given back (reassign them). Whoever approves leave, never their own. They " +
    "and the rosterers are told.",
  input: z.object({ id: entityId, why }),
  output: z.object({ request: requestSchema }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["why"],
  auditSummary: (output) => ({ request: output.request.id, account: output.request.account }),
  explainFailure: (error, input, ctx) => explainLeave(error, input.id, ctx),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.cancelApproved");
    await assertApprover(ctx, "cancel approved leave");
    const request = await loadRequest(ctx, input.id);
    if (request.state !== "approved") throw closedRequest(request);
    await assertNotOwn(ctx, request.account_id);
    await cancelApproved(ctx, request, input.why);
    const [out] = await requestsOut(
      ctx,
      [{ ...request, why: input.why }],
      new Map([[request.id, { state: "cancelled" }]]),
    );
    return { request: out as RequestOut };
  },
});

export const staffingLeaveRequestFor = defineOperation({
  name: "staffing.leave.requestFor",
  description:
    "Tool-only (a shipped pack's tool): ask for leave for someone else (as staffing.leave.request " +
    "takes it), and with approve, record it already approved in the same step (a sick day phoned " +
    "in), with everything approving does. Whoever approves leave, never for themselves.",
  input: z.object({ account: accountId, ...askInput, approve: z.boolean().optional() }),
  output: askOutput.extend({
    offered: z.array(coveredSchema.extend({ told: z.number().int() })),
    uncovered: z.array(coveredSchema),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["note", "amounts"],
  auditSummary: (output, input) => ({
    request: output.request?.id ?? null,
    account: input.account,
    approved: input.approve === true,
  }),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.requestFor");
    await assertApprover(ctx, "ask for leave for someone else");
    if (input.account === actingAccount(ctx)) {
      throw new ValidationError("Ask for your own leave with staffing.leave.request", {
        field: "account",
      });
    }
    await requireAccount(ctx, input.account);
    const plan = await planAsk(ctx, input.account, input);
    const warnings = belowZero(plan.type, plan.balance, plan.total, input.preview);
    if (input.preview) {
      return {
        ...(await askAnswer(ctx, input.account, plan, warnings, null)),
        offered: [],
        uncovered: [],
      };
    }
    const row = writeAsk(ctx, input.account, plan, input, input.note);
    if (input.approve) {
      const done = await approve(ctx, row, plan.amounts, undefined);
      return {
        ...(await askAnswer(ctx, input.account, plan, done.warnings, done.request)),
        offered: done.offered,
        uncovered: done.uncovered,
      };
    }
    const type = plan.type;
    await queueNotice(ctx, {
      to: [input.account],
      title: `${typeWord(type)} leave was asked for you`.replace(/^./, (c) => c.toUpperCase()),
      body: `${await staffName(ctx.db, actingAccount(ctx))} asked for ${typeWord(type)} leave for you from ${row.start_date}.`,
      humanOnly: true,
    });
    const days = new Map<string, number | null>([...plan.amounts].map(([d]) => [d, null]));
    const [out] = await requestsOutPlanned(ctx, row, plan.amounts, days);
    return {
      ...(await askAnswer(ctx, input.account, plan, warnings, out ?? null)),
      offered: [],
      uncovered: [],
    };
  },
});

// --- Reading requests -----------------------------------------------------------------------------

export const staffingLeaveMine = defineOperation({
  name: "staffing.leave.mine",
  description:
    "Tool-only (a shipped pack's tool): your own leave requests ending on or after `from` (a " +
    "local date; all of them when left out), newest first, with each date's amounts and its " +
    "state. Read-only.",
  input: z.object({ from: localDate.optional() }),
  output: z.object({ items: z.array(requestSchema) }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.mine");
    let query = ctx.db
      .selectFrom("core_leave_request")
      .selectAll()
      .where("account_id", "=", actingAccount(ctx));
    if (input.from) query = query.where("end_date", ">=", input.from);
    const rows = await query.orderBy("start_date", "desc").limit(100).execute();
    return { items: await requestsOut(ctx, rows) };
  },
});

export const staffingLeavePending = defineOperation({
  name: "staffing.leave.pending",
  description:
    "Tool-only (a shipped pack's tool): leave requests waiting for a decision, soonest first (at " +
    "most 50), each with the balance after it and the shifts it covers that have not started " +
    "(three named, and how many). " +
    "Whoever approves leave. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      requestSchema.extend({
        balanceAfter: z.number().int().nullable(),
        shifts: z.array(coveredSchema),
        shiftCount: z.number().int(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output) => ({ requests: output.items.length }),
  async handler(_input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.pending");
    await assertApprover(ctx, "read leave waiting for a decision");
    const rows = await ctx.db
      .selectFrom("core_leave_request")
      .selectAll()
      .where("state", "=", "requested")
      .orderBy("start_date")
      .limit(50)
      .execute();
    const out = await requestsOut(ctx, rows);
    const types = new Map(
      (
        await ctx.db
          .selectFrom("core_leave_type")
          .select(["id", "keeps_balance"])
          .where("id", "in", jsonList([...new Set(rows.map((r) => r.type_id)), ""]))
          .execute()
      ).map((t) => [t.id, t.keeps_balance === 1]),
    );
    const items = [];
    for (const [i, r] of rows.entries()) {
      // Three named, and how many: one claims read and three loads a request.
      const { shifts, count } = await coveredShifts(ctx, r.account_id, rangeOf(r), 3);
      const request = out[i] as RequestOut;
      items.push({
        ...request,
        balanceAfter: types.get(r.type_id)
          ? (await balanceOf(ctx.db, r.account_id, r.type_id)) - request.total
          : null,
        shifts: shifts.map(coveredOf),
        shiftCount: count,
      });
    }
    return { items };
  },
});

// --- Balances -------------------------------------------------------------------------------------

const entrySchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  why: z.enum(["set", "adjust", "approved", "cancelled"]),
  request: z.string().nullable(),
  note: z.string().nullable(),
  by: z.string(),
  byName: z.string(),
  at: z.string(),
});

export const staffingLeaveBalances = defineOperation({
  name: "staffing.leave.balances",
  description:
    "Tool-only (a shipped pack's tool): leave balances, each person's per type that keeps one, as " +
    "the sum of what the business entered and the leave approved (nothing accrues), in the " +
    "type's unit. Your own; whoever approves leave or handles pay reads anyone's, or everyone's " +
    "when account is left out. With account and type, its history too. Read-only.",
  input: z.object({ account: accountId.optional(), type: entityId.optional() }),
  output: z.object({
    items: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        type: z.object({ id: z.string(), name: z.string(), unit: z.enum(["hours", "days"]) }),
        balance: z.number().int(),
      }),
    ),
    history: z.array(entrySchema).nullable(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (_output, input) => ({ account: input.account ?? null, type: input.type ?? null }),
  async handler(input, ctx) {
    await assertLeaveCall(ctx, "staffing.leave.balances");
    const me = actingAccount(ctx);
    const reader = (await mayRoster(ctx)) || (await isPayer(ctx.db, me));
    const account = input.account ?? (reader ? undefined : me);
    if (account !== me && !reader) {
      throw new ForbiddenError("You read only your own leave balances.", { rule: "not_yours" });
    }
    const types = await ctx.db
      .selectFrom("core_leave_type")
      .selectAll()
      .where("keeps_balance", "=", 1)
      .orderBy("position")
      .orderBy("name")
      .execute();
    let sums = ctx.db
      .selectFrom("core_leave_balance_entry")
      .select(({ fn }) => ["account_id", "type_id", fn.sum<number>("amount").as("balance")])
      .groupBy(["account_id", "type_id"]);
    if (account !== undefined) sums = sums.where("account_id", "=", account);
    if (input.type) sums = sums.where("type_id", "=", input.type);
    const rows = await sums.limit(5000).execute();
    const accounts = [
      ...new Set([...rows.map((r) => r.account_id), ...(account ? [account] : [])]),
    ];
    const users = await ctx.db
      .selectFrom("core_user")
      .select(["id", "name", "email"])
      .where("id", "in", jsonList([...accounts, me]))
      .execute();
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    const balance = new Map(
      rows.map((r) => [`${r.account_id}\u0000${r.type_id}`, Number(r.balance)]),
    );
    const items = [];
    for (const a of accounts) {
      for (const t of types) {
        if (input.type && t.id !== input.type) continue;
        const key = `${a}\u0000${t.id}`;
        // Everyone's: only the balances anything was entered for; one person's: every type.
        if (account === undefined && !balance.has(key)) continue;
        items.push({
          account: a,
          name: names.get(a) ?? "",
          type: { id: t.id, name: t.name, unit: t.unit },
          balance: balance.get(key) ?? 0,
        });
      }
    }
    let history: z.input<typeof entrySchema>[] | null = null;
    if (account !== undefined && input.type) {
      const entries = await ctx.db
        .selectFrom("core_leave_balance_entry")
        .selectAll()
        .where("account_id", "=", account)
        .where("type_id", "=", input.type)
        .orderBy("made_at", "desc")
        .orderBy("id", "desc")
        .limit(200)
        .execute();
      const by = await ctx.db
        .selectFrom("core_user")
        .select(["id", "name", "email"])
        .where("id", "in", jsonList([...new Set(entries.map((e) => e.made_by)), ""]))
        .execute();
      const byName = new Map(by.map((u) => [u.id, u.name || u.email]));
      history = entries.map((e) => ({
        id: e.id,
        amount: e.amount,
        why: e.why,
        request: e.request_id,
        note: e.note,
        by: e.made_by,
        byName: byName.get(e.made_by) ?? "",
        at: e.made_at,
      }));
    }
    return { items, history };
  },
});

const balanceWrite = z.object({
  account: z.string(),
  type: z.string(),
  entry: z.string(),
});

async function balanceTarget(ctx: HandlerContext, name: string, account: string, typeId: string) {
  await assertLeaveCall(ctx, name);
  await assertPayHolder(ctx, "set leave balances");
  await requireAccount(ctx, account);
  const type = await loadType(ctx, typeId);
  if (!type.keeps_balance) {
    throw new ConflictError(`${type.name} keeps no balance.`, { rule: "leave_no_balance" });
  }
  return type;
}

async function balanceNotice(ctx: HandlerContext, account: string, type: StoredType, what: string) {
  await queueNotice(ctx, {
    to: [account],
    title: `Your ${typeWord(type)} leave balance was ${what}`,
    body: `${await staffName(ctx.db, actingAccount(ctx))} ${what} your ${typeWord(type)} leave balance. See it in My time off.`,
    humanOnly: true,
  });
}

export const staffingLeaveSetBalance = defineOperation({
  name: "staffing.leave.setBalance",
  description:
    "Tool-only (a shipped pack's tool): set someone's balance of a leave type to an amount (an " +
    "opening balance), in the type's unit (minutes for an hours type, hundredths of a day for a " +
    "days type), with a note. Written as an entry of the ledger; nothing accrues. Someone who " +
    "handles pay, a person at the screen. They are told (never the amount).",
  input: z.object({
    account: accountId,
    type: entityId,
    amount: z.number().int().min(-1_000_000).max(1_000_000),
    note: note.min(1),
  }),
  output: balanceWrite,
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["amount", "note"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const type = await balanceTarget(ctx, "staffing.leave.setBalance", input.account, input.type);
    const id = newId("leaveBalanceEntry");
    // The difference from the sum at commit, worked out in the statement: two sets at once leave
    // the balance at the second's amount, never their sum.
    ctx.write(
      CompiledQuery.raw(
        "INSERT INTO core_leave_balance_entry (id, account_id, type_id, amount, why, request_id, note, made_by, made_at) SELECT ?, ?, ?, ? - coalesce(sum(amount), 0), 'set', NULL, ?, ?, ? FROM core_leave_balance_entry WHERE account_id = ? AND type_id = ?",
        [
          id,
          input.account,
          input.type,
          input.amount,
          input.note,
          actingAccount(ctx),
          ctx.now,
          input.account,
          input.type,
        ],
      ),
    );
    await balanceNotice(ctx, input.account, type, "set");
    return { account: input.account, type: input.type, entry: id };
  },
});

export const staffingLeaveAdjust = defineOperation({
  name: "staffing.leave.adjust",
  description:
    "Tool-only (a shipped pack's tool): add to or take from someone's balance of a leave type (a " +
    "signed amount in the type's unit, say what the business worked out for a fortnight), with a " +
    "note. Written as an entry of the ledger; nothing accrues. Someone who handles pay, a person " +
    "at the screen. They are told (never the amount).",
  input: z.object({
    account: accountId,
    type: entityId,
    amount: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((n) => n !== 0, "an adjustment is not zero"),
    note: note.min(1),
  }),
  output: balanceWrite,
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["amount", "note"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const type = await balanceTarget(ctx, "staffing.leave.adjust", input.account, input.type);
    const id = newId("leaveBalanceEntry");
    ctx.write(
      ctx.db.insertInto("core_leave_balance_entry").values({
        id,
        account_id: input.account,
        type_id: input.type,
        amount: input.amount,
        why: "adjust",
        request_id: null,
        note: input.note,
        made_by: actingAccount(ctx),
        made_at: ctx.now,
      }),
    );
    await balanceNotice(ctx, input.account, type, "adjusted");
    return { account: input.account, type: input.type, entry: id };
  },
});

export const staffingLeaveOperations = [
  staffingLeaveTypes,
  staffingLeaveSaveType,
  staffingLeaveRequest,
  staffingLeaveRequestFor,
  staffingLeaveCancel,
  staffingLeaveMine,
  staffingLeavePending,
  staffingLeaveApprove,
  staffingLeaveDecline,
  staffingLeaveCancelApproved,
  staffingLeaveBalances,
  staffingLeaveSetBalance,
  staffingLeaveAdjust,
] as const;
