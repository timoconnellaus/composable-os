// Pay (stage 45 step 6, ADR 0627): who is counted, the pay periods, their totals with evidence, the
// lock, reopening, the export, and the mark that a shift was not worked. Tool-only, as every
// staffing operation (ADR 0621): called from a shipped pack's tool run, acting for the staff
// account the pipeline verified as the tool's caller (`ctx.extension.tool.calledBy`, ADR 0625).
//
// Pay is a person's only (the spec's "What an AI may do"): every pay operation refuses a caller
// who is not a person at the screen (`humanOnly` on the calling tool, and the verified caller a
// person), and one who does not handle pay (`staffing.pays`: Rostering's restricted
// `rostering:pay`, held by admins and by grant). No pay figure (minutes, hours, counts, who is
// counted how) reaches the audit log, a notice, a tool run's record or an error's text: the audit
// rows say which period and who, never what it totals. Marking a shift not worked is a rosterer's
// (a person applies an AI's request), as any roster correction.
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  fingerprintGuards,
  hoursOf,
  lineFromRow,
  lineInserts,
  localDateOf,
  MAX_PERIOD_SHIFTS,
  PAY_BASES,
  type PayConfig,
  type PayLine,
  type PeriodRange,
  payConfig,
  payCsv,
  periodContaining,
  periodFingerprint,
  periodLines,
  periodRange,
  readFingerprint,
  totalsOf,
} from "../staffing/pay.ts";
import { actingAccount, isPayer, staffName } from "../staffing/rosterers.ts";
import {
  assertPersonApplies,
  assertRosterer,
  assertShippedToolRun,
  requireLiveShift,
} from "./staffing.ts";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const accountId = z.string().min(1).max(64);

// --- Who calls -------------------------------------------------------------------------------------

/**
 * A pay call: a shipped pack's tool, a person's own (never an AI acting for one, whatever is
 * granted), who handles pay. Refused otherwise, saying nothing of any period.
 */
async function assertPayCall(ctx: HandlerContext, name: string): Promise<void> {
  await assertShippedToolRun(ctx, name);
  const tool = ctx.extension?.tool;
  if (tool?.humanOnly !== true || tool.calledBy?.actor !== "human") {
    throw new ForbiddenError("Pay is read and changed by a person only, never by an assistant.", {
      rule: "human_only",
    });
  }
  if (!(await isPayer(ctx.db, actingAccount(ctx)))) {
    throw new ForbiddenError("Only someone who handles pay may do this.", { rule: "pay" });
  }
}

async function requireConfig(ctx: HandlerContext): Promise<PayConfig> {
  const config = await payConfig(ctx.db);
  if (!config) {
    throw new ConflictError("No pay periods are set up here: no installed pack declares them.", {
      rule: "pay_period_unset",
    });
  }
  return config;
}

/** The period starting on `start`, from the setting, or the refusal naming the right start. */
function periodStarting(config: PayConfig, start: string): PeriodRange {
  const range = periodContaining(config, start);
  if (!range) {
    throw new ConflictError(
      "Set the date a pay period starts (Settings, Rostering) first: until then nothing is totalled.",
      { rule: "pay_period_unset" },
    );
  }
  if (range.start !== start) {
    throw new ValidationError(
      `${start} is not the first day of a pay period: the period containing it starts ${range.start}.`,
      { field: "start", periodStart: range.start },
    );
  }
  return range;
}

type PeriodRow = import("@composable-os/db").CoreDatabase["core_pay_period"];

async function versionsOf(ctx: HandlerContext, starts: readonly string[]): Promise<PeriodRow[]> {
  if (!starts.length) return [];
  return (await ctx.db
    .selectFrom("core_pay_period")
    .selectAll()
    .where("start_date", "in", jsonList([...starts]))
    .where("state", "!=", "locking")
    .orderBy("start_date")
    .orderBy("version")
    .execute()) as PeriodRow[];
}

const nowSeconds = (ctx: HandlerContext) => Math.floor(Date.parse(ctx.now) / 1000);

// --- Shapes -----------------------------------------------------------------------------------------

const versionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  state: z.enum(["locked", "reopened"]),
  lockedBy: z.string(),
  lockedByName: z.string(),
  lockedAt: z.string(),
  reopenedBy: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
});

const periodSchema = z.object({
  start: z.string(),
  end: z.string(),
  zone: z.string(),
  /** `locked`: a version is locked; `open`: none is (never locked, or reopened). */
  state: z.enum(["open", "locked"]),
  /** The period has ended (it may be locked). */
  ended: z.boolean(),
  versions: z.array(versionSchema),
});

const lineSchema = z.object({
  account: z.string(),
  name: z.string(),
  email: z.string(),
  basis: z.enum(["by_time", "by_class"]),
  object: z.string(),
  id: z.string(),
  kind: z.object({ object: z.string(), id: z.string() }).nullable(),
  kindName: z.string(),
  title: z.string(),
  place: z.string().nullable(),
  localDate: z.string(),
  localStart: z.string(),
  localEnd: z.string(),
  shiftMinutes: z.number().int(),
  beforeMinutes: z.number().int(),
  afterMinutes: z.number().int(),
  countedMinutes: z.number().int(),
  counted: z.boolean(),
  notWorkedReason: z.string().nullable(),
  listTaken: z.boolean().nullable().describe("Null: this kind of shift keeps no list"),
  markedBy: z.string().nullable().describe("Who took its list"),
  flagged: z.boolean().describe("Someone other than its person took its list: review it"),
});

const totalSchema = z.object({
  account: z.string(),
  name: z.string(),
  email: z.string(),
  basis: z.enum(["by_time", "by_class"]),
  kind: z.object({ object: z.string(), id: z.string() }).nullable(),
  kindName: z.string(),
  shifts: z.number().int(),
  minutes: z.number().int(),
  hours: z.string().describe("Minutes ÷ 60, rounded half up to two places"),
  notWorked: z.number().int(),
  flagged: z.number().int(),
});

async function versionOut(ctx: HandlerContext, row: PeriodRow) {
  return {
    id: row.id,
    version: row.version,
    state: row.state as "locked" | "reopened",
    lockedBy: row.locked_by,
    lockedByName: await staffName(ctx.db, row.locked_by),
    lockedAt: row.locked_at,
    reopenedBy: row.reopened_by,
    reopenedAt: row.reopened_at,
    reopenReason: row.reopen_reason,
  };
}

const lineOut = (l: PayLine) => {
  const { starts: _s, ends: _e, ...rest } = l;
  return rest;
};

/**
 * A period's lines: the locked version's (or the one asked for), else worked out from the roster
 * as it stands (a preview).
 */
async function linesFor(
  ctx: HandlerContext,
  range: PeriodRange,
  version: number | undefined,
): Promise<{ lines: PayLine[]; locked: boolean; version: PeriodRow | null; range: PeriodRange }> {
  const versions = await versionsOf(ctx, [range.start]);
  const chosen =
    version !== undefined
      ? versions.find((v) => v.version === version)
      : versions.find((v) => v.state === "locked");
  if (version !== undefined && !chosen) throw new NotFoundError("pay period version", String(version));
  if (chosen) {
    const rows = await ctx.db
      .selectFrom("core_pay_line")
      .selectAll()
      .where("period_id", "=", chosen.id)
      .orderBy("n")
      .limit(MAX_PERIOD_SHIFTS + 1)
      .execute();
    return {
      lines: rows.map(lineFromRow),
      locked: chosen.state === "locked",
      version: chosen,
      range: {
        start: chosen.start_date,
        end: chosen.end_date,
        zone: chosen.zone,
        starts: chosen.starts,
        ends: chosen.ends,
      },
    };
  }
  return { lines: await periodLines(ctx, range), locked: false, version: null, range };
}

/** The period asked for: a stored version's dates when one starts then, else the setting's. */
async function rangeFor(ctx: HandlerContext, start: string): Promise<PeriodRange> {
  const stored = (await versionsOf(ctx, [start])).at(-1);
  if (stored) return periodRange(stored.start_date, stored.end_date, stored.zone);
  return periodStarting(await requireConfig(ctx), start);
}

// --- Who is counted ---------------------------------------------------------------------------------

export const staffingPayBasis = defineOperation({
  name: "staffing.payBasis",
  description:
    "Tool-only (a shipped pack's tool): say how a member of staff is counted for pay from a " +
    "local date on (today when left out): by_time (their hours), by_class (their classes and " +
    "shifts), or not_counted (salaried; the default for everyone). No rates are held. Someone " +
    "who handles pay, a person only. A date inside a locked pay period is refused.",
  input: z.object({
    account: accountId,
    basis: z.enum(PAY_BASES),
    from: localDate.optional().describe("In force from this local date; today when left out"),
  }),
  output: z.object({ account: z.string(), from: z.string(), changed: z.boolean() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  // How someone is counted is pay: the audit row says whose and from when, not how.
  redact: ["basis"],
  auditSummary: (output) => ({ account: output.account, from: output.from }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payBasis");
    const user = await ctx.db
      .selectFrom("core_user")
      .select("id")
      .where("id", "=", input.account)
      .where("kind", "=", "human")
      .executeTakeFirst();
    if (!user) throw new NotFoundError("user", input.account);
    const { timezone } = await loadGeneralSettings(ctx.db);
    const from = input.from ?? localDateOf(nowSeconds(ctx), timezone);
    const existing = await ctx.db
      .selectFrom("core_staff_pay_basis")
      .select("basis")
      .where("account_id", "=", input.account)
      .where("from_date", "=", from)
      .executeTakeFirst();
    if (existing?.basis === input.basis) return { account: input.account, from, changed: false };
    // A locked period's dates keep who was counted (the database refuses it too).
    const locked = await ctx.db
      .selectFrom("core_pay_period")
      .select("end_date")
      .where("state", "=", "locked")
      .where("end_date", ">=", from)
      .executeTakeFirst();
    if (locked) {
      throw new ConflictError(
        `${from} is inside or before a locked pay period, so who is counted cannot change from then. Choose a later date, or reopen the period first.`,
        { rule: "pay_period_locked" },
      );
    }
    const row = { set_by: actingAccount(ctx), set_at: ctx.now };
    ctx.write(
      existing
        ? ctx.db
            .updateTable("core_staff_pay_basis")
            .set({ basis: input.basis, ...row })
            .where("account_id", "=", input.account)
            .where("from_date", "=", from)
        : ctx.db
            .insertInto("core_staff_pay_basis")
            .values({ account_id: input.account, from_date: from, basis: input.basis, ...row }),
    );
    return { account: input.account, from, changed: true };
  },
});

export const staffingPayBases = defineOperation({
  name: "staffing.payBases",
  description:
    "Tool-only (a shipped pack's tool): who is counted for pay and how, by time, by class or not " +
    "counted, today and from which dates; everyone with a basis set (account: one person). " +
    "Someone who handles pay, a person only. Read-only.",
  input: z.object({ account: accountId.optional() }),
  output: z.object({
    today: z.string(),
    items: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        basis: z.enum(PAY_BASES).describe("In force today"),
        history: z.array(
          z.object({
            from: z.string(),
            basis: z.enum(PAY_BASES),
            setBy: z.string(),
            setAt: z.string(),
          }),
        ),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (_output, input) => ({ account: input.account ?? null }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payBases");
    const { timezone } = await loadGeneralSettings(ctx.db);
    const today = localDateOf(nowSeconds(ctx), timezone);
    let query = ctx.db.selectFrom("core_staff_pay_basis").selectAll();
    if (input.account) query = query.where("account_id", "=", input.account);
    const rows = await query.orderBy("account_id").orderBy("from_date").limit(2000).execute();
    const accounts = [...new Set(rows.map((r) => r.account_id))];
    const users = accounts.length
      ? await ctx.db
          .selectFrom("core_user")
          .select(["id", "name", "email"])
          .where("id", "in", jsonList(accounts))
          .execute()
      : [];
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    return {
      today,
      items: accounts.map((account) => {
        const history = rows.filter((r) => r.account_id === account);
        let basis: (typeof PAY_BASES)[number] = "not_counted";
        for (const r of history) if (r.from_date <= today) basis = r.basis;
        return {
          account,
          name: names.get(account) ?? "",
          basis,
          history: history.map((r) => ({
            from: r.from_date,
            basis: r.basis,
            setBy: r.set_by,
            setAt: r.set_at,
          })),
        };
      }),
    };
  },
});

// --- Periods ------------------------------------------------------------------------------------------

export const staffingPayPeriodList = defineOperation({
  name: "staffing.payPeriod.list",
  description:
    "Tool-only (a shipped pack's tool): the pay periods, from the setting (weekly, fortnightly " +
    "by default, or monthly, in the organisation's zone): the current one and the `count` " +
    "before it (6 when left out), each open or locked, with its locked and reopened versions. " +
    "Someone who handles pay, a person only. Read-only.",
  input: z.object({ count: z.number().int().min(1).max(60).optional() }),
  output: z.object({
    setting: z.object({
      period: z.enum(["weekly", "fortnightly", "monthly"]),
      start: z.string().nullable(),
      day: z.number().int(),
      zone: z.string(),
    }),
    /** False until a weekly or fortnightly period has its start date: nothing is totalled. */
    set: z.boolean(),
    periods: z.array(periodSchema),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payPeriod.list");
    const config = await requireConfig(ctx);
    const now = nowSeconds(ctx);
    const today = localDateOf(now, config.zone);
    const current = periodContaining(config, today);
    const setting = { period: config.period, start: config.start, day: config.day, zone: config.zone };
    if (!current) return { setting, set: false, periods: [] };
    const ranges: PeriodRange[] = [current];
    for (let i = 0; i < (input.count ?? 6); i++) {
      const first = ranges[0] as PeriodRange;
      const prev = periodContaining(config, localDateOf(first.starts - 43_200, config.zone));
      if (!prev || prev.start === first.start) break;
      ranges.unshift(prev);
    }
    // Versions locked under another setting, inside this window, are shown too.
    const first = ranges[0] as PeriodRange;
    const stored = (await ctx.db
      .selectFrom("core_pay_period")
      .selectAll()
      .where("state", "!=", "locking")
      .where("end_date", ">=", first.start)
      .where("start_date", "<=", current.end)
      .orderBy("start_date")
      .orderBy("version")
      .execute()) as PeriodRow[];
    for (const row of stored) {
      if (!ranges.some((r) => r.start === row.start_date)) {
        ranges.push(periodRange(row.start_date, row.end_date, row.zone));
      }
    }
    ranges.sort((a, b) => b.start.localeCompare(a.start));
    const periods = [];
    for (const r of ranges) {
      const versions = stored.filter((v) => v.start_date === r.start);
      periods.push({
        start: r.start,
        end: r.end,
        zone: r.zone,
        state: versions.some((v) => v.state === "locked") ? ("locked" as const) : ("open" as const),
        ended: r.ends <= now,
        versions: await Promise.all(versions.map((v) => versionOut(ctx, v))),
      });
    }
    return { setting, set: true, periods };
  },
});

export const staffingPayPeriodTotals = defineOperation({
  name: "staffing.payPeriod.totals",
  description:
    "Tool-only (a shipped pack's tool): one pay period's totals, per counted person and kind of " +
    "work (shifts, and hours as whole minutes), and its lines, one per shift, with the evidence " +
    "beside each (its list taken and by whom, flagged when not by its person). A locked period " +
    "gives its locked lines; an open one is worked out from the roster as it stands (a preview, " +
    "which may still change). Someone who handles pay, a person only. Read-only; audited as a " +
    "read, without its figures.",
  input: z.object({
    start: localDate.describe("The period's first day"),
    version: z.number().int().min(1).optional().describe("A locked or reopened version"),
  }),
  output: z.object({
    period: z.object({
      start: z.string(),
      end: z.string(),
      zone: z.string(),
      locked: z.boolean(),
      preview: z.boolean().describe("Not locked: worked out now, and may still change"),
      version: versionSchema.nullable(),
    }),
    totals: z.array(totalSchema),
    lines: z.array(lineSchema),
    minutes: z.number().int(),
    hours: z.string(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output, input) => ({
    read: "pay totals",
    start: input.start,
    version: output.period.version?.version ?? null,
    locked: output.period.locked,
  }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payPeriod.totals");
    const asked = await rangeFor(ctx, input.start);
    const { lines, locked, version, range } = await linesFor(ctx, asked, input.version);
    const minutes = lines.reduce((sum, l) => sum + l.countedMinutes, 0);
    return {
      period: {
        start: range.start,
        end: range.end,
        zone: range.zone,
        locked,
        preview: version === null,
        version: version ? await versionOut(ctx, version) : null,
      },
      totals: totalsOf(lines),
      lines: lines.map(lineOut),
      minutes,
      hours: hoursOf(minutes),
    };
  },
});

export const staffingPayPeriodLock = defineOperation({
  name: "staffing.payPeriod.lock",
  description:
    "Tool-only (a shipped pack's tool): lock a pay period that has ended: its lines and totals " +
    "are written as the roster stands now (correct it first: reassign, mark not worked) and " +
    "never change; a change to a shift inside it is refused until it is reopened. Locking a " +
    "reopened period again makes a new version and keeps the old. Someone who handles pay, a " +
    "person only. Refused when anything it read changed meanwhile.",
  input: z.object({ start: localDate.describe("The period's first day") }),
  output: z.object({
    id: z.string(),
    start: z.string(),
    end: z.string(),
    version: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  auditSummary: (output) => ({
    period: output.id,
    start: output.start,
    end: output.end,
    version: output.version,
  }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payPeriod.lock");
    const config = await requireConfig(ctx);
    const versions = await versionsOf(ctx, [input.start]);
    if (versions.some((v) => v.state === "locked")) {
      throw new ConflictError("This pay period is already locked.", { rule: "pay_period_held" });
    }
    // A reopened period keeps its dates; a new one takes the setting's.
    const last = versions.at(-1);
    const range = last
      ? periodRange(last.start_date, last.end_date, last.zone)
      : periodStarting(config, input.start);
    if (range.ends > nowSeconds(ctx)) {
      throw new ConflictError(
        `This pay period ends ${range.end}; it can be locked once it has ended.`,
        { rule: "pay_period_open" },
      );
    }
    const overlap = await ctx.db
      .selectFrom("core_pay_period")
      .select("start_date")
      .where("state", "=", "locked")
      .where("starts", "<", range.ends)
      .where("ends", ">", range.starts)
      .executeTakeFirst();
    if (overlap) {
      throw new ConflictError(
        `The locked pay period starting ${overlap.start_date} overlaps this one, so it cannot be locked.`,
        { rule: "pay_period_held" },
      );
    }
    // What the lines are read from, read first and guarded in the batch: a write in between
    // fails the lock whole (roster_changed), so the lines are exactly the roster it locks.
    const fingerprint = periodFingerprint(range);
    const values = await readFingerprint(ctx, fingerprint);
    const lines = await periodLines(ctx, range);
    const id = newId("payPeriod");
    const version = (last?.version ?? 0) + 1;
    ctx.write(...fingerprintGuards(fingerprint, values));
    ctx.write(
      ctx.db.insertInto("core_pay_period").values({
        id,
        start_date: range.start,
        end_date: range.end,
        zone: range.zone,
        starts: range.starts,
        ends: range.ends,
        version,
        state: "locking",
        locked_by: actingAccount(ctx),
        locked_at: ctx.now,
        reopened_by: null,
        reopened_at: null,
        reopen_reason: null,
      }),
      ...lineInserts(id, lines),
      ctx.db.updateTable("core_pay_period").set({ state: "locked" }).where("id", "=", id),
    );
    return { id, start: range.start, end: range.end, version };
  },
});

export const staffingPayPeriodReopen = defineOperation({
  name: "staffing.payPeriod.reopen",
  description:
    "Tool-only (a shipped pack's tool): reopen a locked pay period, with why: its shifts can be " +
    "corrected again, and its locked version is kept as it was. Lock it again for a new version. " +
    "Someone who handles pay, a person only.",
  input: z.object({
    start: localDate.describe("The period's first day"),
    reason: z.string().trim().min(1).max(500),
  }),
  output: z.object({ id: z.string(), start: z.string(), version: z.number().int() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  // Why it was reopened may name a person's hours: kept with the period, not in the audit log.
  redact: ["reason"],
  auditSummary: (output) => ({ period: output.id, start: output.start, version: output.version }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payPeriod.reopen");
    const locked = (await versionsOf(ctx, [input.start])).find((v) => v.state === "locked");
    if (!locked) {
      throw new ConflictError("This pay period is not locked.", { rule: "pay_period_not_locked" });
    }
    ctx.write(
      ctx.db
        .updateTable("core_pay_period")
        .set({
          state: "reopened",
          reopened_by: actingAccount(ctx),
          reopened_at: ctx.now,
          reopen_reason: input.reason,
        })
        .where("id", "=", locked.id)
        .where("state", "=", "locked"),
    );
    return { id: locked.id, start: locked.start_date, version: locked.version };
  },
});

export const staffingPayPeriodExport = defineOperation({
  name: "staffing.payPeriod.export",
  description:
    "Tool-only (a shipped pack's tool): a pay period as a CSV file for payroll: a summary, one " +
    "row per person and kind of work (period start and end, name, staff email, basis, kind, " +
    "shifts, hours as a decimal and in minutes), then one row per shift (date, start, end, " +
    "kind, place, minutes counted, why not worked, the list's evidence). From the locked " +
    "version, or a preview of an open period, marked as such. No rates and no money. Someone " +
    "who handles pay, a person only; audited as a read, without its figures.",
  input: z.object({
    start: localDate.describe("The period's first day"),
    version: z.number().int().min(1).optional().describe("A locked or reopened version"),
  }),
  output: z.object({
    filename: z.string(),
    contentType: z.literal("text/csv"),
    csv: z.string(),
    locked: z.boolean(),
    version: z.number().int().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output, input) => ({
    read: "pay export",
    start: input.start,
    version: output.version,
    locked: output.locked,
  }),
  async handler(input, ctx) {
    await assertPayCall(ctx, "staffing.payPeriod.export");
    const asked = await rangeFor(ctx, input.start);
    const { lines, locked, version, range } = await linesFor(ctx, asked, input.version);
    const suffix = version ? `-v${version.version}` : "-preview";
    return {
      filename: `pay-${range.start}-to-${range.end}${suffix}.csv`,
      contentType: "text/csv" as const,
      csv: payCsv(range, lines, { locked, version: version?.version ?? null }),
      locked,
      version: version?.version ?? null,
    };
  },
});

// --- Not worked ---------------------------------------------------------------------------------------

export const staffingMarkNotWorked = defineOperation({
  name: "staffing.markNotWorked",
  description:
    "Tool-only (a shipped pack's tool): mark a shift that has started as not worked, with why " +
    "(nobody ran the class), so it counts for nothing in its pay period; or clear the mark " +
    "(notWorked false). Someone who rosters; an AI's request waits for a person. A shift inside " +
    "a locked pay period is refused until the period is reopened.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    notWorked: z.boolean().default(true),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({ object: z.string(), id: z.string(), notWorked: z.boolean(), changed: z.boolean() }),
  permission: "records:write",
  risk: "write",
  toolOnly: true,
  mcp: { expose: false },
  redact: ["reason"],
  auditSummary: (output) => output,
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.markNotWorked");
    await assertRosterer(ctx, "mark a shift not worked");
    assertPersonApplies(ctx, "Marking a shift not worked");
    const s = await requireLiveShift(ctx, input.object, input.id);
    if (!getObject(input.object)?.staffed) throw new NotFoundError(input.object, input.id);
    if (!s.shift.live || !s.shift.covered || s.shift.starts === null) {
      throw new ConflictError("Only a live shift with someone on it can be marked not worked.", {
        rule: "shift_not_live",
      });
    }
    if (s.shift.starts > nowSeconds(ctx)) {
      throw new ConflictError(
        "This shift has not started: reassign or cancel it instead of marking it not worked.",
        { rule: "shift_not_started" },
      );
    }
    if (input.notWorked && !input.reason) {
      throw new ValidationError("Say why it was not worked", { field: "reason" });
    }
    const existing = await ctx.db
      .selectFrom("core_staff_not_worked")
      .select(["reason", "starts"])
      .where("object_type", "=", input.object)
      .where("record_id", "=", input.id)
      .executeTakeFirst();
    const at = s.shift.starts;
    const locked = await ctx.db
      .selectFrom("core_pay_period")
      .select("start_date")
      .where("state", "=", "locked")
      .where((eb) =>
        eb.or([
          eb.and([eb("starts", "<=", at), eb("ends", ">", at)]),
          ...(existing
            ? [eb.and([eb("starts", "<=", existing.starts), eb("ends", ">", existing.starts)])]
            : []),
        ]),
      )
      .executeTakeFirst();
    if (locked) {
      throw new ConflictError(
        `This shift is in the locked pay period starting ${locked.start_date}. Reopen it first.`,
        { rule: "pay_period_locked" },
      );
    }
    const base = { object: input.object, id: input.id, notWorked: input.notWorked };
    if (!input.notWorked) {
      if (!existing) return { ...base, changed: false };
      ctx.write(
        ctx.db
          .deleteFrom("core_staff_not_worked")
          .where("object_type", "=", input.object)
          .where("record_id", "=", input.id),
      );
      return { ...base, changed: true };
    }
    const values = {
      starts: at,
      reason: input.reason as string,
      marked_by: actingAccount(ctx),
      marked_at: ctx.now,
    };
    ctx.write(
      existing
        ? ctx.db
            .updateTable("core_staff_not_worked")
            .set(values)
            .where("object_type", "=", input.object)
            .where("record_id", "=", input.id)
        : ctx.db
            .insertInto("core_staff_not_worked")
            .values({ object_type: input.object, record_id: input.id, ...values }),
    );
    return { ...base, changed: true };
  },
});

export const staffingPayOperations = [
  staffingPayBasis,
  staffingPayBases,
  staffingPayPeriodList,
  staffingPayPeriodTotals,
  staffingPayPeriodLock,
  staffingPayPeriodReopen,
  staffingPayPeriodExport,
  staffingMarkNotWorked,
] as const;
