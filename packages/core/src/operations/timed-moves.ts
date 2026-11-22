// Timed moves (stage 31a step 7, ADR 0550): a `states` declaration may name moves the host makes
// by itself once a moment has passed (`states.after`): a booking still booked 30 minutes after its
// class ends becomes a no-show, but only when someone on that class was ticked (`ifAnyIn`), so a
// coach who forgot the list does not make the whole class no-shows.
//
//   state.after       the host makes one record's timed move, from where it was or not at all
//                     (ADR 0437), after checking again that it is due
//   runTimedMovesDue  the minute cron: finds the records due, oldest moment first, and calls
//                     state.after for each, one batch each
//
// state.after is the minute cron's only, as the host: the automation actor, never on MCP, refused
// from any origin but `system`, and never queued for approval from it (`hostStep`, ADR 0520).
import type { CrmDb } from "@composable-os/db";
import { CompiledQuery } from "kysely";
import { z } from "zod";
import type { EventSink } from "../automations/types.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadRecord, updateRecord } from "./record.ts";

/** The most pages one rule reads in a tick, paging past records that keep failing. */
const MAX_PAGES = 10;

/** How far back the sweep looks: a moment older than this is no longer acted on. */
export const TIMED_MOVE_LOOKBACK_DAYS = 14;

type TimedRule = NonNullable<NonNullable<ObjectDefinition["states"]>["after"]>[number];

const origins = (rule: TimedRule): readonly string[] =>
  typeof rule.from === "string" ? [rule.from] : rule.from;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** What a rule's SQL reads: the record's columns and, one relation away, the moment's. */
interface RulePlan {
  object: ObjectDefinition;
  rule: TimedRule;
  index: number;
  stateColumn: string;
  /** The moment's own record: the object itself, or the one the relation points to. */
  atSource: string;
  atColumn: string;
  /** The relation's column on the record, when the moment is one relation away. */
  relationColumn: string | null;
}

function planOf(object: ObjectDefinition, index: number): RulePlan | null {
  const rule = object.states?.after?.[index];
  const stateField = object.states?.field;
  if (!rule || !stateField) return null;
  const column = (o: ObjectDefinition, name: string) => {
    const field = o.fields.find((f) => f.name === name);
    return field ? viewColumnOf(field) : null;
  };
  const stateColumn = column(object, stateField);
  if (!stateColumn) return null;
  const parts = rule.at.split(".");
  if (parts.length === 1) {
    const atColumn = column(object, rule.at);
    return atColumn
      ? {
          object,
          rule,
          index,
          stateColumn,
          atSource: object.source,
          atColumn,
          relationColumn: null,
        }
      : null;
  }
  const [relation, field] = parts as [string, string];
  const rel = object.fields.find((f) => f.name === relation);
  const target = rel?.options?.to ? getObject(rel.options.to) : undefined;
  const relationColumn = rel ? viewColumnOf(rel) : null;
  const atColumn = target ? column(target, field) : null;
  if (!target || !relationColumn || !atColumn) return null;
  return {
    object,
    rule,
    index,
    stateColumn,
    atSource: target.source,
    atColumn,
    relationColumn,
  };
}

/**
 * The SQL that finds a rule's records due at `now` (or, with `id`, whether that one is): in one of
 * its `from` states, the moment (plus `minutesAfter`) passed and no older than the lookback, and,
 * with `ifAnyIn`, another live record on the same related record in one of those states.
 */
function dueQuery(
  plan: RulePlan,
  now: number,
  limit: number,
  id?: string,
  offset = 0,
): CompiledQuery {
  const minutes = plan.rule.minutesAfter ?? 0;
  const latest = new Date(now - minutes * 60_000).toISOString();
  const earliest = new Date(
    now - minutes * 60_000 - TIMED_MOVE_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  const states = origins(plan.rule);
  const r = ident(plan.object.source);
  const at = plan.relationColumn
    ? `JOIN ${ident(plan.atSource)} a ON a.id = r.${ident(plan.relationColumn)}`
    : "";
  const moment = plan.relationColumn ? `a.${ident(plan.atColumn)}` : `r.${ident(plan.atColumn)}`;
  const params: unknown[] = [...states];
  let sql = `SELECT r.id AS id, r.${ident(plan.stateColumn)} AS state FROM ${r} r ${at} WHERE r.${ident(plan.stateColumn)} IN (${states.map(() => "?").join(", ")}) AND ${moment} IS NOT NULL AND julianday(${moment}) <= julianday(?) AND julianday(${moment}) > julianday(?)`;
  params.push(latest, earliest);
  if (plan.rule.ifAnyIn?.length && plan.relationColumn) {
    const rel = ident(plan.relationColumn);
    sql += ` AND EXISTS (SELECT 1 FROM ${r} s WHERE s.${rel} = r.${rel} AND s.id != r.id AND s.${ident(plan.stateColumn)} IN (${plan.rule.ifAnyIn.map(() => "?").join(", ")}))`;
    params.push(...plan.rule.ifAnyIn);
  }
  if (id !== undefined) {
    sql += " AND r.id = ?";
    params.push(id);
  }
  sql += ` ORDER BY julianday(${moment}), r.id LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return CompiledQuery.raw(sql, params);
}

export const stateAfter = defineOperation({
  name: "state.after",
  description:
    "Platform use only (the minute cron, as the host): make one record's timed move (a " +
    "declaration's `states.after`, such as a booking still booked after its class becoming a " +
    "no-show), from the state it was read in or not at all, once it is due.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    rule: z.number().int().min(0).max(3).describe("Which of the object's timed moves"),
    from: z.string().min(1).max(100).describe("The state it was read in"),
  }),
  output: z.object({ id: z.string(), state: z.string() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  hostStep: true,
  mcp: { expose: false },
  auditSummary: (output) => ({ moved: output.id, to: output.state }),
  async handler(input, ctx) {
    // The host's own step, never a pack automation's (which also runs as the automation actor).
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError("state.after is the host's own step: only the platform calls it", {
        rule: "timed_move",
        reason: "host_only",
      });
    }
    const object = getObject(input.object);
    const plan = object ? planOf(object, input.rule) : null;
    if (!object || !plan || !object.states) {
      throw new ValidationError(`${input.object} has no such timed move`, { field: "rule" });
    }
    if (!origins(plan.rule).includes(input.from)) {
      throw new ValidationError(`The timed move does not leave ${input.from}`, { field: "from" });
    }
    const stored = await loadRecord(ctx, object, input.id);
    if (!stored) throw new NotFoundError(object.name, input.id);
    // Due now, as this read sees it (the sweep read it a moment ago): or not at all.
    const { rows } = await ctx.db.executeQuery(dueQuery(plan, Date.parse(ctx.now), 1, input.id));
    if (!rows.length) {
      throw new ConflictError(`${object.label} is no longer due to move`, {
        rule: "timed_move",
        reason: "not_due",
      });
    }
    await updateRecord(
      ctx,
      object,
      input.id,
      { [object.states.field]: plan.rule.to },
      { by: "host", from: input.from },
    );
    return { id: input.id, state: plan.rule.to };
  },
});

export const timedMoveOperations = [stateAfter] as const;

export interface TimedMovesDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** The most records one page of a rule reads. Default 100. */
  maxRecords?: number;
  /** The most records one tick tries, across every rule. Default 500; the rest next tick. */
  maxPerTick?: number;
}

export interface TimedMovesDueResult {
  moved: number;
  failed: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The minute cron's timed moves (ADR 0550): for every object declaring `states.after`, the
 * records due, oldest moment first, each moved as the host in its own batch. A record that moved
 * meanwhile, or is no longer due, is skipped; anything else (a deny included) is logged and
 * counted, and the next is tried. With nothing declared it reads nothing.
 */
export async function runTimedMovesDue(
  db: CrmDb,
  { floor, clock, events, maxRecords = 100, maxPerTick = 500 }: TimedMovesDueOptions = {},
): Promise<TimedMovesDueResult> {
  const result: TimedMovesDueResult = { moved: 0, failed: 0 };
  const plans: RulePlan[] = [];
  for (const object of listObjects()) {
    const rules = object.states?.after ?? [];
    for (let i = 0; i < rules.length; i++) {
      const plan = planOf(object, i);
      if (plan) plans.push(plan);
    }
  }
  if (!plans.length) return result;
  const ctx = {
    actor: "automation" as const,
    user: SYSTEM_USER,
    origin: { surface: "system" as const, automationId: "system.timed-moves" },
    db,
    ...(floor ? { floor } : {}),
    ...(clock ? { clock } : {}),
    ...(events ? { events } : {}),
  };
  const now = (clock?.() ?? new Date()).getTime();
  // One budget for the whole tick, and the rule that goes first turns each minute, so a rule
  // whose records keep failing cannot take every tick from the rules after it.
  let budget = maxPerTick;
  const first = Math.floor(now / 60_000) % plans.length;
  const ordered = [...plans.slice(first), ...plans.slice(0, first)];
  for (const plan of ordered) {
    if (budget <= 0) break;
    // Records that keep failing stay first in the order: page past them, so they never starve
    // the ones behind (a moved record drops out of the read, a failed one stays; ADR 0550).
    let skip = 0;
    for (let page = 0; page < MAX_PAGES && budget > 0; page++) {
      const asked = Math.min(maxRecords, budget);
      let rows: { id: string; state: string }[];
      try {
        rows = (
          await db.query.executeQuery<{ id: string; state: string }>(
            dueQuery(plan, now, asked, undefined, skip),
          )
        ).rows;
      } catch (error) {
        result.failed += 1;
        console.error("timed moves: the records due could not be read", {
          object: plan.object.name,
          rule: plan.index,
          error: messageOf(error),
        });
        break;
      }
      // Records this page left where they were (failed, or refused as no longer due): the next
      // page reads past them.
      let leftHere = 0;
      for (const row of rows) {
        budget -= 1;
        try {
          await invoke(
            "state.after",
            {
              object: plan.object.name,
              id: String(row.id),
              rule: plan.index,
              from: String(row.state),
            },
            ctx,
          );
          result.moved += 1;
        } catch (error) {
          const e = error as { code?: unknown; details?: { reason?: unknown } };
          const reason = e.details?.reason;
          // Moved by someone else meanwhile, or no longer due: nothing to do.
          if (
            e.code === "conflict" &&
            (reason === "not_due" || reason === "moved_meanwhile" || reason === "not_in_position")
          ) {
            leftHere += 1;
            continue;
          }
          result.failed += 1;
          leftHere += 1;
          console.error("timed moves: a record could not be moved", {
            object: plan.object.name,
            id: row.id,
            rule: plan.index,
            error: messageOf(error),
          });
        }
      }
      if (rows.length < asked || leftHere === 0) break;
      skip += leftHere;
    }
  }
  return result;
}

/** For tests: the records a rule finds due at `at` (ids, oldest moment first). */
export async function timedMovesDue(
  ctx: Pick<HandlerContext, "db">,
  objectName: string,
  rule: number,
  at: Date,
): Promise<string[]> {
  const object = getObject(objectName);
  const plan = object ? planOf(object, rule) : null;
  if (!plan) return [];
  const { rows } = await ctx.db.executeQuery<{ id: string }>(dueQuery(plan, at.getTime(), 500));
  return rows.map((r) => String(r.id));
}
