// The `recurring` behaviour's operations (stage 31, ADR 0500): the minute cron's run of one
// series, and staff changing a series whose records have places taken, with the count confirmed.
import type { CrmDb } from "@composable-os/db";
import { z } from "zod";
import type { EventSink } from "../automations/types.ts";
import { NotFoundError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { defineOperation } from "../operation.ts";
import {
  exceptionsOf,
  followSeries,
  generateSeries,
  RECURRING_MAX_PER_RUN,
  RECURRING_MAX_PER_TICK,
  requireClosureObject,
  requireSeriesObject,
} from "../recurring/index.ts";
import { SYSTEM_USER } from "../users.ts";
import { createRecord, loadRecord, requireExtensionObject, updateRecord } from "./record.ts";

const objectName = z.string().min(1).max(81);
const recordId = z.string().min(1).max(64);

export const recurringGenerate = defineOperation({
  name: "recurring.generate",
  description:
    "Platform use only: make one series' records that are due, up to its horizon, as the host " +
    "(the minute cron). Dates already made, in a closure or past are not made. Returns how many " +
    "were made and whether more are due.",
  input: z.object({
    object: objectName,
    id: recordId,
    limit: z.number().int().min(1).max(RECURRING_MAX_PER_RUN).default(RECURRING_MAX_PER_RUN),
  }),
  output: z.object({ made: z.number().int(), more: z.boolean() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({ made: output.made }),
  async handler(input, ctx) {
    const object = requireSeriesObject(input.object);
    return generateSeries(ctx, object, input.id, input.limit);
  },
});

export const recurringChange = defineOperation({
  name: "recurring.change",
  description:
    "Change a series of a recurring schedule (a timetable line) when the change moves or " +
    "cancels future records that have places taken: record.update refuses that change and " +
    "says how many (rule recurring_confirm, count). Pass the same values and confirm with that " +
    "count; the records nobody edited move to the new time, and dates no longer in the series " +
    "are cancelled. With from (a local date), the change applies to records from that date on; " +
    "earlier ones keep the series as it was. Refused again if the count has changed. Returns " +
    "the series.",
  input: z.object({
    object: objectName,
    id: recordId,
    values: z.record(z.string(), z.unknown()),
    confirm: z
      .number()
      .int()
      .min(1)
      .describe("How many records with places taken the change moves or cancels."),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The local date (YYYY-MM-DD) the change applies from; default today."),
  }),
  output: z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const object = requireSeriesObject(input.object);
    await updateRecord(ctx, object, input.id, input.values, {
      recurringConfirm: input.confirm,
      recurringFrom: input.from,
    });
    return ctx.afterCommit(async () => {
      const record = await loadRecord(ctx, object, input.id);
      return { id: input.id, values: record?.values ?? {} };
    });
  },
});

export const recurringClose = defineOperation({
  name: "recurring.close",
  description:
    "Add a closure (a date range, such as holidays) to a recurring schedule, or change one's " +
    "dates, when it cancels future records that have places taken: record.create and " +
    "record.update refuse that and say how many (rule recurring_confirm, count). Pass the same " +
    "values and confirm with that count; every record it newly covers is cancelled. Omit id to " +
    "add one. Returns the closure.",
  input: z.object({
    object: objectName,
    id: recordId.optional(),
    values: z.record(z.string(), z.unknown()),
    confirm: z
      .number()
      .int()
      .min(1)
      .describe("How many records with places taken the closure cancels."),
  }),
  output: z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const object = requireClosureObject(input.object);
    const id =
      input.id ??
      (await createRecord(ctx, object, input.values, { recurringConfirm: input.confirm }));
    if (input.id) {
      await updateRecord(ctx, object, input.id, input.values, { recurringConfirm: input.confirm });
    }
    return ctx.afterCommit(async () => {
      const record = await loadRecord(ctx, object, id);
      return { id, values: record?.values ?? {} };
    });
  },
});

export const recurringExceptions = defineOperation({
  name: "recurring.exceptions",
  description:
    "Read what a record made by a recurring schedule (a class from its timetable line) keeps as " +
    "its own instead of following its series: the fields changed by hand on it (a coach swapped " +
    "for that date), with who changed each and when, and whether it is detached from its series " +
    "whole (its time or state was changed by hand). A later change to the series still reaches " +
    "every other field of it. A one-off record answers generated false.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({
    generated: z.boolean(),
    series: z.object({ object: z.string(), id: z.string(), date: z.string() }).nullable(),
    detached: z.boolean(),
    fields: z.array(z.object({ field: z.string(), setBy: z.string(), setAt: z.string() })),
  }),
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const record = await loadRecord(ctx, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    return exceptionsOf(ctx, object, input.id);
  },
});

export const recurringFollow = defineOperation({
  name: "recurring.follow",
  description:
    "Make fields of a record made by a recurring schedule (a class) follow its series again: " +
    "each named field (default every field the series sets: its coach, room, places) takes the " +
    "series' value now and follows later changes to it. A record detached from its series whole " +
    "follows it again too, provided its time is still the series' for its date (refused with " +
    "rule recurring_moved otherwise); the fields not named that differ from the series stay its " +
    "own. Refused for a past, cancelled or finished record. Returns the fields that follow the " +
    "series and those kept.",
  input: z.object({
    object: objectName,
    id: recordId,
    fields: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(50)
      .optional()
      .describe(
        "The fields to follow the series again (at least one); leave it out for every field the series sets.",
      ),
  }),
  output: z.object({
    followed: z.array(z.string()),
    kept: z.array(z.string()),
    reattached: z.boolean(),
  }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const record = await loadRecord(ctx, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    return followSeries(ctx, object, input.id, input.fields);
  },
});

export const recurringOperations = [
  recurringGenerate,
  recurringChange,
  recurringClose,
  recurringExceptions,
  recurringFollow,
];

export interface RecurringDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** The most series one tick runs; the rest wait for the next. Default 20. */
  maxSeries?: number;
  /** The most records one tick makes across every series (default RECURRING_MAX_PER_TICK). */
  maxRecords?: number;
}

/**
 * The minute cron's recurring step (ADR 0500): runs every series whose time has come, each in
 * its own batch through `recurring.generate` (SYSTEM_USER, origin `system`). With nothing due it
 * is one indexed read. A series that fails (another run made its dates a moment before) is
 * logged and tried again on the next tick.
 */
export async function runRecurringDue(
  db: CrmDb,
  {
    floor,
    clock,
    events,
    maxSeries = 20,
    maxRecords = RECURRING_MAX_PER_TICK,
  }: RecurringDueOptions = {},
): Promise<{ series: number; made: number; failed: number }> {
  const now = (clock?.() ?? new Date()).toISOString();
  const due = await db.query
    .selectFrom("core_recurrence_series")
    .select(["object_type", "record_id"])
    .where("next_run_at", "<=", now)
    .orderBy("next_run_at")
    .limit(maxSeries)
    .execute();
  let made = 0;
  let failed = 0;
  // Oldest due first: a series with more to make is due again "now", behind every series that
  // was due before it, so one large timetable cannot starve the rest.
  for (const row of due) {
    const limit = Math.min(RECURRING_MAX_PER_RUN, maxRecords - made);
    if (limit < 1) break;
    try {
      const result = (await invoke(
        "recurring.generate",
        { object: row.object_type, id: row.record_id, limit },
        {
          actor: "automation",
          user: SYSTEM_USER,
          origin: { surface: "system", automationId: "system.recurring" },
          db,
          ...(floor ? { floor } : {}),
          ...(clock ? { clock } : {}),
          ...(events ? { events } : {}),
        },
      )) as { made: number };
      made += result.made;
    } catch (error) {
      failed += 1;
      // A conflict (the series changed, or another run made its dates, meanwhile) is tried again
      // on the next tick. Anything else in an hour, not every minute: a series that cannot make
      // its records (a field its records need is empty) does not fill the log.
      const conflict = (error as { code?: unknown }).code === "conflict";
      if (!conflict)
        await db.query
          .updateTable("core_recurrence_series")
          .set({
            next_run_at: new Date(Date.parse(now) + 3_600_000).toISOString(),
            updated_at: now,
          })
          .where("object_type", "=", row.object_type)
          .where("record_id", "=", row.record_id)
          .execute();
      console.error("recurring: a series could not run", {
        object: row.object_type,
        id: row.record_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { series: due.length, made, failed };
}
