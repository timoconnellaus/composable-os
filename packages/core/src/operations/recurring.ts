// The `recurring` behaviour's operations (stage 31, ADR 0500): the minute cron's run of one
// series, and staff changing a series whose records have places taken, with the count confirmed.
import type { CrmDb } from "@composable-os/db";
import { z } from "zod";
import type { EventSink } from "../automations/types.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { defineOperation } from "../operation.ts";
import { generateSeries, requireSeriesObject } from "../recurring/index.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadRecord, updateRecord } from "./record.ts";

const objectName = z.string().min(1).max(81);
const recordId = z.string().min(1).max(64);

export const recurringGenerate = defineOperation({
  name: "recurring.generate",
  description:
    "Platform use only: make one series' records that are due, up to its horizon, as the host " +
    "(the minute cron). Dates already made, in a closure or past are not made. Returns how many " +
    "were made and whether more are due.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ made: z.number().int(), more: z.boolean() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({ made: output.made }),
  async handler(input, ctx) {
    const object = requireSeriesObject(input.object);
    return generateSeries(ctx, object, input.id);
  },
});

export const recurringChange = defineOperation({
  name: "recurring.change",
  description:
    "Change a series of a recurring schedule (a timetable line) when the change moves or " +
    "cancels future records that have places taken: record.update refuses that change and " +
    "says how many (rule recurring_confirm, count). Pass the same values and confirm with that " +
    "count; the records nobody edited move to the new time, and dates no longer in the series " +
    "are cancelled. Refused again if the count has changed. Returns the series.",
  input: z.object({
    object: objectName,
    id: recordId,
    values: z.record(z.string(), z.unknown()),
    confirm: z
      .number()
      .int()
      .min(1)
      .describe("How many records with places taken the change moves or cancels."),
  }),
  output: z.object({ id: z.string(), values: z.record(z.string(), z.unknown()) }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const object = requireSeriesObject(input.object);
    await updateRecord(ctx, object, input.id, input.values, { recurringConfirm: input.confirm });
    return ctx.afterCommit(async () => {
      const record = await loadRecord(ctx, object, input.id);
      return { id: input.id, values: record?.values ?? {} };
    });
  },
});

export const recurringOperations = [recurringGenerate, recurringChange];

export interface RecurringDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** The most series one tick runs; the rest wait for the next. Default 20. */
  maxSeries?: number;
}

/**
 * The minute cron's recurring step (ADR 0500): runs every series whose time has come, each in
 * its own batch through `recurring.generate` (SYSTEM_USER, origin `system`). With nothing due it
 * is one indexed read. A series that fails (another run made its dates a moment before) is
 * logged and tried again on the next tick.
 */
export async function runRecurringDue(
  db: CrmDb,
  { floor, clock, events, maxSeries = 20 }: RecurringDueOptions = {},
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
  for (const row of due) {
    try {
      const result = (await invoke(
        "recurring.generate",
        { object: row.object_type, id: row.record_id },
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
      // Tried again in an hour, not every minute: a series that cannot make its records (a
      // field its records need is empty) does not fill the log.
      await db.query
        .updateTable("core_recurrence_series")
        .set({ next_run_at: new Date(Date.parse(now) + 3_600_000).toISOString(), updated_at: now })
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
