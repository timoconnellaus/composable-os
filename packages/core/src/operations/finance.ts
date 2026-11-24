// Finance (stage 52, ADRs 0790, 0791 and 0794): the months the business closes, closing and
// reopening them, and the finance settings. Core, staff only (none is open to customers or the
// public, ADR 0402):
//
//   finance.periods          staff (finance:read)                  the current month and 24 before
//   finance.report           staff (finance:read)                  Sales, Tax or Refunds: closed or preview
//   finance.entries          staff (finance:read)                  a closed version's book entries, paged
//   finance.export           staff (finance:read, a person)        one report as a CSV file
//   finance.close            staff (finance:close, a person)       close an ended month
//   finance.reopen           staff (finance:close, a person)       reopen a closed month, with why
//   finance.settings.get     staff (finance:read)                  the year's first month, …
//   finance.settings.update  staff (settings:manage, a person)     change them
//
// Closing, reopening and the settings are a person's at the screen (`actors: ["human"]`): an AI
// may read figures for an account that holds `finance:read`, and never closes, reopens or changes
// anything here, whatever is granted (decision 7). No figure reaches the audit log or an error's
// text: the audit rows say which month and version.
import { CompiledQuery } from "kysely";
import { z } from "zod";
import { ConflictError, ValidationError } from "../errors.ts";
import { closePlan, periodBook, readGuards } from "../finance/close.ts";
import { addMonths } from "../finance/day.ts";
import { reportCsv, reportFilename } from "../finance/files.ts";
import {
  anyVersion,
  FINANCE_SETTINGS,
  financeClock,
  isClosed,
  laterClosed,
  loadFinanceSettings,
  type PeriodRow,
  rangeFrom,
  rangeOf,
  versionsOf,
} from "../finance/periods.ts";
import { BUILT_REPORTS, ENTRIES_PAGE, readEntries, readReport } from "../finance/reports.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month, YYYY-MM")
  .describe("The month, YYYY-MM");

/** How many months before the current one `finance.periods` lists. */
export const PERIODS_LISTED = 24;

const versionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  state: z.enum(["closed", "reopened"]),
  closedBy: z.string(),
  closedByName: z.string().nullable(),
  closedAt: z.string(),
  entries: z.number().int(),
  reopenedBy: z.string().nullable(),
  reopenedByName: z.string().nullable(),
  reopenedAt: z.string().nullable(),
});

const periodSchema = z.object({
  month: z.string(),
  start: z.string(),
  end: z.string(),
  zone: z.string(),
  state: z.enum(["open", "closed"]).describe("closed: its latest version is closed"),
  ended: z.boolean(),
  closable: z.boolean().describe("It has ended, is open, and the month before it is closed"),
  versions: z.array(versionSchema),
});

async function namesOf(ctx: HandlerContext, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name"])
    .where("id", "in", unique)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

function versionOut(row: PeriodRow, names: Map<string, string>) {
  return {
    id: row.id,
    version: row.version,
    state: row.state as "closed" | "reopened",
    closedBy: row.closed_by,
    closedByName: names.get(row.closed_by) ?? null,
    closedAt: row.closed_at,
    entries: row.entry_count,
    reopenedBy: row.reopened_by,
    reopenedByName: row.reopened_by ? (names.get(row.reopened_by) ?? null) : null,
    reopenedAt: row.reopened_at,
  };
}

export const financePeriods = defineOperation({
  name: "finance.periods",
  description:
    "List the business's finance months: the current month and up to 24 before it (none before " +
    "the first month finance counts), each with its local dates and zone, whether it is open or " +
    "closed, whether it has ended and can be closed now, and its versions (who closed it and " +
    "when; who reopened it). States and versions only, no figures. Needs finance:read.",
  input: z.object({}),
  output: z.object({
    zone: z.string(),
    firstMonth: z.string(),
    currentMonth: z.string(),
    periods: z.array(periodSchema),
  }),
  permission: "finance:read",
  risk: "read",
  mcp: { title: "Finance months" },
  async handler(_input, ctx) {
    const clock = await financeClock(ctx.db, ctx.now);
    const months: string[] = [];
    for (let i = 0; i <= PERIODS_LISTED; i++) {
      const m = addMonths(clock.currentMonth, -i);
      if (m < clock.firstMonth) break;
      months.push(m);
    }
    const all = await versionsOf(ctx.db, [
      ...months,
      addMonths(months.at(-1) ?? clock.currentMonth, -1),
    ]);
    const names = await namesOf(
      ctx,
      all.flatMap((r) => [r.closed_by, ...(r.reopened_by ? [r.reopened_by] : [])]),
    );
    const periods = [];
    for (const m of months) {
      const range = rangeFrom(all, m, clock.zone);
      const versions = all.filter((r) => r.month === m);
      const closed = isClosed(versions);
      const ended = range.ends <= clock.now;
      const before = all.filter((r) => r.month === addMonths(m, -1));
      periods.push({
        month: m,
        start: range.start,
        end: range.end,
        zone: range.zone,
        state: closed ? ("closed" as const) : ("open" as const),
        ended,
        closable: !closed && ended && (m === clock.firstMonth || isClosed(before)),
        versions: versions.map((v) => versionOut(v, names)),
      });
    }
    return {
      zone: clock.zone,
      firstMonth: clock.firstMonth,
      currentMonth: clock.currentMonth,
      periods,
    };
  },
});

export const financeClose = defineOperation({
  name: "finance.close",
  description:
    "Close a month's finance figures: its book entries and report rows are written as the host's " +
    "figures stand now and never change. A month is closed once it has ended and the month " +
    "before it is closed; closing a reopened month writes its next version and keeps the old. " +
    "Payments and refunds that arrive later are never refused: they are counted in the first open " +
    "month, marked as belonging to this one. A person only, with finance:close. Refused when " +
    "anything it read changed meanwhile (try again).",
  input: z.object({ month }),
  output: z.object({
    id: z.string(),
    month: z.string(),
    version: z.number().int(),
    entries: z.number().int(),
  }),
  permission: "finance:close",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({ month: output.month, version: output.version, period: output.id }),
  // A reopen of the month before, or another close, landed between the read and the batch.
  async explainFailure(error, input, ctx) {
    if ((error.details as { rule?: unknown } | undefined)?.rule !== "finance_order") return null;
    const before = addMonths(input.month, -1);
    if (!isClosed(await versionsOf(ctx.db, [before]))) {
      return new ConflictError(`Close ${before} first: it was reopened a moment before.`, {
        rule: "finance_previous_open",
        month: before,
      });
    }
    return null;
  },
  async handler(input, ctx) {
    const clock = await financeClock(ctx.db, ctx.now);
    if (input.month < clock.firstMonth) {
      throw new ConflictError(
        `Finance counts from ${clock.firstMonth}, so ${input.month} cannot be closed.`,
        { rule: "finance_before_start", firstMonth: clock.firstMonth },
      );
    }
    const before = addMonths(input.month, -1);
    const versions = await versionsOf(ctx.db, [before, input.month]);
    const own = versions.filter((v) => v.month === input.month);
    if (isClosed(own)) {
      throw new ConflictError(`${input.month} is already closed.`, {
        rule: "finance_period_closed",
      });
    }
    const range = await rangeOf(ctx.db, input.month, clock.zone);
    if (range.ends > clock.now) {
      throw new ConflictError(
        `${input.month} ends ${range.end}; it can be closed once it has ended.`,
        {
          rule: "finance_period_open",
        },
      );
    }
    if (input.month !== clock.firstMonth && !isClosed(versions.filter((v) => v.month === before))) {
      throw new ConflictError(`Close ${before} first: months are closed in order.`, {
        rule: "finance_previous_open",
        month: before,
      });
    }
    // What the figures come from, read first and guarded in the batch: a write in between fails
    // the close whole (finance_changed).
    const book = await periodBook(ctx, range);
    const guardValues = await readGuards(ctx.db, book.guards);
    const id = newId("financePeriod");
    const version = (own.at(-1)?.version ?? 0) + 1;
    const plan = await closePlan(ctx, {
      id,
      month: input.month,
      range,
      version,
      by: ctx.user.id,
      book,
      guardValues,
    });
    ctx.write(...plan.statements);
    return { id, month: input.month, version, entries: plan.entries.length };
  },
});

export const financeReopen = defineOperation({
  name: "finance.reopen",
  description:
    "Reopen a closed month, with why: its closed version and files are kept as they were, and " +
    "closing it again writes the next version. Every later closed month must be reopened first. " +
    "A person only, with finance:close.",
  input: z.object({ month, reason: z.string().trim().min(1).max(500) }),
  output: z.object({ id: z.string(), month: z.string(), version: z.number().int() }),
  permission: "finance:close",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // Why it was reopened may name a person or a figure: kept with the version, not in the audit log.
  redact: ["reason"],
  auditSummary: (output) => ({ month: output.month, version: output.version, period: output.id }),
  // Another reopen or a later close landed between the read and the batch: say which.
  async explainFailure(error, input, ctx) {
    const rule = (error.details as { rule?: unknown } | undefined)?.rule;
    if (rule !== "finance_changed" && rule !== "finance_order") return null;
    if (!isClosed(await versionsOf(ctx.db, [input.month]))) {
      return new ConflictError(
        `${input.month} is not closed: someone reopened it a moment before.`,
        {
          rule: "finance_period_not_closed",
        },
      );
    }
    const later = await laterClosed(ctx.db, input.month);
    return later
      ? new ConflictError(`Reopen ${later} first: it was closed a moment before.`, {
          rule: "finance_later_closed",
          month: later,
        })
      : null;
  },
  async handler(input, ctx) {
    const closed = (await versionsOf(ctx.db, [input.month])).at(-1);
    if (closed?.state !== "closed") {
      throw new ConflictError(`${input.month} is not closed.`, {
        rule: "finance_period_not_closed",
      });
    }
    const later = await laterClosed(ctx.db, input.month);
    if (later) {
      throw new ConflictError(
        `Reopen ${later} first: a month is reopened only while no later month is closed.`,
        {
          rule: "finance_later_closed",
          month: later,
        },
      );
    }
    ctx.write(
      // Still closed when the batch runs (two reopens at once, the review of PR #337): the second
      // fails whole and is told the month is not closed.
      CompiledQuery.raw(
        "INSERT INTO core_finance_guard (expected, actual) SELECT 1, (SELECT count(*) FROM core_finance_period WHERE id = ? AND state = 'closed')",
        [closed.id],
      ),
      ctx.db
        .updateTable("core_finance_period")
        .set({
          state: "reopened",
          reopened_by: ctx.user.id,
          reopened_at: ctx.now,
          reopen_reason: input.reason,
        })
        .where("id", "=", closed.id)
        .where("state", "=", "closed"),
    );
    return { id: closed.id, month: input.month, version: closed.version };
  },
});

const settingsSchema = z.object({
  yearStartMonth: z.number().int().min(1).max(12),
  firstPeriod: z.string().nullable(),
  categoryLabels: z.record(z.string(), z.string()),
});

export const financeSettingsGet = defineOperation({
  name: "finance.settings.get",
  description:
    "Read the finance settings: the financial year's first month (1 to 12, used only to add " +
    "months into a year), the first month finance counts (the month it was installed unless an " +
    "admin picked an earlier one), and the labels given to sales categories. Needs finance:read.",
  input: z.object({}),
  output: settingsSchema.extend({ firstMonth: z.string() }),
  permission: "finance:read",
  risk: "read",
  async handler(_input, ctx) {
    const [settings, clock] = await Promise.all([
      loadFinanceSettings(ctx.db),
      financeClock(ctx.db, ctx.now),
    ]);
    const { installedAt: _installed, ...rest } = settings;
    return { ...rest, firstMonth: clock.firstMonth };
  },
});

export const financeSettingsUpdate = defineOperation({
  name: "finance.settings.update",
  description:
    "Change the finance settings: the financial year's first month, an earlier first month to " +
    "count from (only before any month is closed), and labels for sales categories (a category " +
    "key to its label; an empty label removes it). Leave a setting out to keep it. A human admin " +
    "in the app only.",
  input: z.object({
    yearStartMonth: z.number().int().min(1).max(12).optional(),
    firstPeriod: month
      .refine((m) => m >= "2000-01", "a month from 2000-01 on")
      .nullable()
      .optional()
      .describe("Null: the month finance was installed"),
    categoryLabels: z
      .record(
        z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .max(60),
        z.string().trim().max(60),
      )
      .refine((r) => Object.keys(r).length <= 100, "at most 100 categories")
      .optional(),
  }),
  output: settingsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async explainFailure(error, _input, ctx) {
    if ((error.details as { rule?: unknown } | undefined)?.rule !== "finance_changed") return null;
    return (await anyVersion(ctx.db))
      ? new ConflictError(
          "A month was closed a moment before, so the first month finance counts from is fixed.",
          { rule: "finance_started" },
        )
      : null;
  },
  async handler(input, ctx) {
    const current = await loadFinanceSettings(ctx.db);
    const { installedAt: _installed, ...before } = current;
    const next = { ...before };
    if (input.yearStartMonth !== undefined) next.yearStartMonth = input.yearStartMonth;
    if (input.firstPeriod !== undefined && input.firstPeriod !== before.firstPeriod) {
      if (await anyVersion(ctx.db)) {
        throw new ConflictError(
          "A month has been closed, so the first month finance counts from is fixed.",
          { rule: "finance_started" },
        );
      }
      const clock = await financeClock(ctx.db, ctx.now);
      if (input.firstPeriod !== null && input.firstPeriod > clock.installedMonth) {
        throw new ValidationError(
          `The first month can only be ${clock.installedMonth}, when finance was installed, or earlier.`,
          { field: "firstPeriod" },
        );
      }
      next.firstPeriod = input.firstPeriod;
    }
    if (input.categoryLabels) {
      const labels = { ...before.categoryLabels };
      for (const [key, label] of Object.entries(input.categoryLabels)) {
        if (label) labels[key] = label;
        else delete labels[key];
      }
      if (Object.keys(labels).length > 100) {
        throw new ValidationError("At most 100 categories have labels.", {
          field: "categoryLabels",
        });
      }
      next.categoryLabels = labels;
    }
    const value = JSON.stringify(next);
    if (next.firstPeriod !== before.firstPeriod) {
      // Still nothing closed when the batch runs (the review of PR #337): a first close landing
      // between the read and the batch fails this whole.
      ctx.write(
        CompiledQuery.raw(
          "INSERT INTO core_finance_guard (expected, actual) SELECT 0, (SELECT count(*) FROM core_finance_period)",
          [],
        ),
      );
    }
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: FINANCE_SETTINGS, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: FINANCE_SETTINGS,
      action: "update",
      before,
      after: next,
    });
    return next;
  },
});

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");

const reportInput = z.object({
  report: z
    .enum(BUILT_REPORTS)
    .describe("sales (by kind of sale and item, and by day), tax (by code and country) or refunds"),
  month: month.optional().describe("A month: its closed version, or a preview while it is open"),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("A month's closed (or since reopened) version; left out, its latest closed one"),
  start: localDate.optional().describe("A span of days to preview instead of a month: its first"),
  end: localDate.optional().describe("The span's last day, included (at most 366 days)"),
});

const reportOutput = z.object({
  report: z.enum(BUILT_REPORTS),
  month: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  zone: z.string(),
  preview: z.boolean().describe("Worked out now, not closed: it may still change"),
  version: z.number().int().nullable(),
  reopened: z.boolean(),
  closedAt: z.string().nullable(),
  closedByName: z.string().nullable(),
  currency: z.string().nullable(),
  notes: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  totals: z.record(z.string(), z.number()),
});

export const financeReport = defineOperation({
  name: "finance.report",
  description:
    "One finance report for a month (its closed version as it was closed, or a preview while it " +
    "is open) or a preview of any span of days: sales (per kind of sale and item, and by day: " +
    "sold, discounts, refunded, net, the tax inside and net of tax), tax (per tax code and " +
    "country, refunds' tax as reported or estimated, untaxed sales beside) or refunds (each " +
    "refund confirmed: date, order, items, amount, tax given back, who asked and approved, the " +
    "customer's name). Amounts are integers in the currency's minor units, on the business's " +
    "days in its own time zone. Each row lists the orders it came from. Needs finance:read.",
  input: reportInput,
  output: reportOutput,
  permission: "finance:read",
  risk: "read",
  mcp: { title: "Finance report" },
  // Who read which report of which month: never a figure.
  auditReads: true,
  auditSummary: (output) => ({
    read: "finance report",
    report: output.report,
    month: output.month,
    start: output.start,
    end: output.end,
    version: output.version,
    preview: output.preview,
  }),
  async handler(input, ctx) {
    return readReport(ctx, input);
  },
});

export const financeEntries = defineOperation({
  name: "finance.entries",
  description:
    "A closed month's book entries and their lines, the figures for the books (what Accounting " +
    "sync reads): one day summary per business day money moved, and late entries for what " +
    "arrived for a closed month. Each entry has a key that is the same in every version, a " +
    "fingerprint of its lines, and lines with a heading, a side (debit or credit) and an amount " +
    "in minor units; its debits equal its credits. Only closed versions (a preview has none). " +
    "Paged: pass `next` as `after`. Needs finance:read.",
  input: z.object({
    month,
    version: z.number().int().min(1).optional().describe("Left out: the latest closed version"),
    after: z.number().int().min(0).optional().describe("The `next` of the page before"),
    limit: z.number().int().min(1).max(ENTRIES_PAGE).optional(),
  }),
  output: z.object({
    month: z.string(),
    version: z.number().int(),
    state: z.enum(["closed", "reopened"]),
    closedAt: z.string(),
    entries: z.array(
      z.object({
        n: z.number().int(),
        key: z.string(),
        kind: z.string(),
        date: z.string(),
        period: z.string(),
        version: z.number().int(),
        belongsTo: z.string().nullable(),
        fingerprint: z.string(),
        lines: z.array(
          z.object({
            heading: z.string(),
            side: z.string(),
            amount: z.number().int(),
            taxCode: z.string().nullable(),
            taxCountry: z.string().nullable(),
            method: z.string().nullable(),
            category: z.string().nullable(),
          }),
        ),
      }),
    ),
    next: z.number().int().nullable(),
  }),
  permission: "finance:read",
  risk: "read",
  mcp: { title: "Finance book entries" },
  auditReads: true,
  auditSummary: (output) => ({
    read: "finance entries",
    month: output.month,
    version: output.version,
    entries: output.entries.length,
  }),
  async handler(input, ctx) {
    return readEntries(ctx, input);
  },
});

export const financeExport = defineOperation({
  name: "finance.export",
  description:
    "Download one finance report as a CSV file for the business's accountant: a closed " +
    "version's (the same every time), or a preview of an open month or a span of days, marked " +
    "so on its first row. Amounts in minor units with a decimal column beside them. A person " +
    "only, with finance:read; audited without its figures.",
  input: reportInput,
  output: z.object({
    filename: z.string(),
    contentType: z.literal("text/csv"),
    csv: z.string(),
    preview: z.boolean(),
    version: z.number().int().nullable(),
  }),
  permission: "finance:read",
  risk: "read",
  // A file leaves the host: a person's act at the screen, never an AI's (decision 7).
  actors: ["human"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output, input) => ({
    read: "finance export",
    report: input.report,
    month: input.month ?? null,
    start: input.start ?? null,
    end: input.end ?? null,
    version: output.version,
    preview: output.preview,
  }),
  async handler(input, ctx) {
    const view = await readReport(ctx, input);
    return {
      filename: reportFilename(view),
      contentType: "text/csv" as const,
      csv: reportCsv(view),
      preview: view.preview,
      version: view.version,
    };
  },
});

export const financeOperations = [
  financePeriods,
  financeReport,
  financeEntries,
  financeExport,
  financeClose,
  financeReopen,
  financeSettingsGet,
  financeSettingsUpdate,
] as const;
