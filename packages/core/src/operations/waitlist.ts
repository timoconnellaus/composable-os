// The waitlist's operations (stage 31a step 5, ADR 0520). A place given back before the cut-off is
// handed to the waitlist in the batch that gives it back (capacity/waitlist.ts); these move it on:
//
//   waitlist.promote    the host moves one waiter into the class, from a current read (ADR 0437):
//                       from waiting or not at all, before the cut-off, taking the waitlist's hold
//                       and spending what the move spends, in one batch
//   waitlist.passOver   the host notes that a waiter could not be moved in (their spend was
//                       refused) and why; they stay waiting, in their place
//   waitlist.release    the host gives back the waitlist's holds nobody took (read at `before`)
//   waitlist.position   a waiter's place in the queue: staff any, a customer their own
//
// The first three are the minute cron's (`runWaitlistDue`), as the host: automation actor only,
// never on MCP, never a customer's. Nothing a person, an assistant or a pack sends reaches them
// with another record than one the cron read as waiting.
import type { CrmDb } from "@composable-os/db";
import { z } from "zod";
import type { EventSink } from "../automations/types.ts";
import {
  beforeCutoff,
  releaseHoldsStatements,
  requireWaitlist,
  WAITLIST_FOR,
  waitersOn,
  waitlistPosition,
} from "../capacity/waitlist.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { invoke } from "../invoke.ts";
import { defineOperation } from "../operation.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadRecord, updateRecord } from "./record.ts";

const objectName = z.string().min(1).max(81);
const recordId = z.string().min(1).max(64);

/**
 * The host's own steps are the platform's, never a pack automation's (which also runs as the
 * `automation` actor): only a call whose origin the host set as `system` (the minute cron) may
 * move a waitlist. A pack listing these operations still cannot jump a waiter ahead (ADR 0520).
 */
function assertSystem(ctx: { origin: { surface: string } }, name: string): void {
  if (ctx.origin.surface !== "system") {
    throw new ForbiddenError(`${name} is the host's own step: only the platform calls it`, {
      rule: "waitlist",
      reason: "host_only",
    });
  }
}

export const waitlistPromote = defineOperation({
  name: "waitlist.promote",
  description:
    "Platform use only (the minute cron, as the host): move one waiter of a waitlist into the " +
    "place the waitlist holds for it, from waiting or not at all, before the cut-off. Spends " +
    "what the move spends. Refused when the record is no longer waiting, the cut-off has " +
    "passed (rule waitlist, reason closed), there is no place (rule capacity) or the spend is " +
    "refused (rule allowance).",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ id: z.string(), promoted: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({ promoted: output.id }),
  async handler(input, ctx) {
    assertSystem(ctx, "waitlist.promote");
    const t = requireWaitlist(input.object);
    const stored = await loadRecord(ctx, t.object, input.id);
    if (!stored) throw new NotFoundError(t.object.name, input.id);
    const field = t.object.states?.field as string;
    if (stored.values[field] !== t.waitlist.state) {
      throw new ConflictError(`${t.object.label} is no longer waiting`, {
        rule: "waitlist",
        reason: "moved_meanwhile",
      });
    }
    if (!(await beforeCutoff(ctx, t, stored.values))) {
      throw new ConflictError(
        "The waitlist has closed: nobody is moved in this close to the start",
        {
          rule: "waitlist",
          reason: "closed",
        },
      );
    }
    await updateRecord(
      ctx,
      t.object,
      input.id,
      {
        [field]: t.waitlist.promote,
        ...(t.waitlist.promotedAt ? { [t.waitlist.promotedAt]: ctx.now } : {}),
      },
      { by: "host", from: t.waitlist.state },
    );
    return { id: input.id, promoted: true as const };
  },
});

export const waitlistPassOver = defineOperation({
  name: "waitlist.passOver",
  description:
    "Platform use only (the minute cron, as the host): note on a waiter that it could not be " +
    "moved in when a place was free, and why (its spend was refused). It stays waiting.",
  input: z.object({
    object: objectName,
    id: recordId,
    reason: z.string().min(1).max(200),
  }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    assertSystem(ctx, "waitlist.passOver");
    const t = requireWaitlist(input.object);
    const stored = await loadRecord(ctx, t.object, input.id);
    if (!stored) throw new NotFoundError(t.object.name, input.id);
    if (stored.values[t.object.states?.field as string] !== t.waitlist.state) {
      throw new ConflictError(`${t.object.label} is no longer waiting`, {
        rule: "waitlist",
        reason: "moved_meanwhile",
      });
    }
    const values: Record<string, unknown> = {};
    if (t.waitlist.passedOverAt) values[t.waitlist.passedOverAt] = ctx.now;
    if (t.waitlist.passedOverReason) values[t.waitlist.passedOverReason] = input.reason;
    if (Object.keys(values).length) {
      await updateRecord(ctx, t.object, input.id, values, { by: "host" });
    }
    return { id: input.id };
  },
});

export const waitlistRelease = defineOperation({
  name: "waitlist.release",
  description:
    "Platform use only (the minute cron, as the host): give back to everyone the places a " +
    "waitlist holds on one record (a class) that were held at or before `before` and that " +
    "nobody waiting could take, or that the cut-off has reached.",
  input: z.object({
    object: objectName.describe("The claimant object whose waitlist it is"),
    on: recordId.describe("The record whose places are held"),
    before: z.string().datetime(),
  }),
  output: z.object({ on: z.string() }),
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    assertSystem(ctx, "waitlist.release");
    const t = requireWaitlist(input.object);
    ctx.write(...releaseHoldsStatements(t, input.on, ctx.now, { before: input.before }));
    return { on: input.on };
  },
});

export const waitlistPositionOperation = defineOperation({
  name: "waitlist.position",
  description:
    "Where a waiting record (a booking on a class's waitlist) stands: its position (1 is next) " +
    "and how many are waiting. Staff any; a signed-in customer only their own record (anyone " +
    "else's is not found). Never who the others are. Null position when it is not waiting.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({
    position: z.number().int().nullable(),
    waiting: z.number().int().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const t = requireWaitlist(input.object);
    // The seam decides whether the caller may see it: a customer's own only.
    await ctx.records.get(t.object.name, input.id).catch(() => {
      throw new NotFoundError(t.object.name, input.id);
    });
    const at = await waitlistPosition(ctx.db, t, input.id);
    return { position: at?.position ?? null, waiting: at?.waiting ?? null };
  },
});

export const waitlistOperations = [
  waitlistPromote,
  waitlistPassOver,
  waitlistRelease,
  waitlistPositionOperation,
] as const;

export interface WaitlistDueOptions {
  floor?: GateFloor;
  clock?: () => Date;
  events?: EventSink;
  /** The most records (classes) with waitlist holds one tick looks at. Default 50. */
  maxRecords?: number;
  /** The most waiters tried per record per tick. Default 50. */
  maxWaiters?: number;
}

export interface WaitlistDueResult {
  records: number;
  promoted: number;
  passedOver: number;
  released: number;
  failed: number;
}

/** A refusal's rule and reason, from an operation error's details. */
function refusalOf(error: unknown): { code?: string; rule?: string; reason?: string } {
  const e = error as { code?: unknown; details?: { rule?: unknown; reason?: unknown } };
  return {
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.details?.rule === "string" ? { rule: e.details.rule } : {}),
    ...(typeof e.details?.reason === "string" ? { reason: e.details.reason } : {}),
  };
}

/**
 * The minute cron's waitlist step (ADR 0520): for each record (a class) whose waitlist holds
 * places, read who waits (first first), and promote them one batch each until the holds are
 * taken. A waiter whose spend is refused is passed over and noted; one who left meanwhile is
 * skipped. Holds nobody could take, and every hold from the cut-off on, are given back to
 * everyone, except holds made after this read (a place freed meanwhile waits for the next tick).
 * With nothing held it is one indexed read.
 */
export async function runWaitlistDue(
  db: CrmDb,
  { floor, clock, events, maxRecords = 50, maxWaiters = 50 }: WaitlistDueOptions = {},
): Promise<WaitlistDueResult> {
  const result: WaitlistDueResult = {
    records: 0,
    promoted: 0,
    passedOver: 0,
    released: 0,
    failed: 0,
  };
  const held = await db.query
    .selectFrom("core_capacity_claim")
    .select(["object_type", "record_id", "for_id"])
    .select((eb) => [eb.fn.countAll<number>().as("holds"), eb.fn.max("created_at").as("latest")])
    .where("for_type", "=", WAITLIST_FOR)
    .where("state", "=", "held")
    .groupBy(["object_type", "record_id", "for_id"])
    .orderBy("latest")
    .limit(maxRecords)
    .execute();
  const ctx = {
    actor: "automation" as const,
    user: SYSTEM_USER,
    origin: { surface: "system" as const, automationId: "system.waitlist" },
    db,
    ...(floor ? { floor } : {}),
    ...(clock ? { clock } : {}),
    ...(events ? { events } : {}),
  };
  for (const row of held) {
    result.records += 1;
    const object = row.for_id;
    let t: ReturnType<typeof requireWaitlist>;
    try {
      t = requireWaitlist(object);
    } catch {
      // The object no longer declares a waitlist (the reconciler refuses that while holds live).
      result.failed += 1;
      continue;
    }
    const holds = Number(row.holds);
    const before = String(row.latest);
    let promoted = 0;
    let giveBack = true;
    for (const id of await waitersOn(db.query, t, row.record_id, maxWaiters)) {
      if (promoted >= holds) break;
      try {
        await invoke("waitlist.promote", { object, id }, ctx);
        promoted += 1;
        result.promoted += 1;
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal.rule === "allowance" && refusal.reason !== "spent_meanwhile") {
          // Nothing they hold can pay for it now: passed over, still waiting (decision 7).
          await invoke(
            "waitlist.passOver",
            { object, id, reason: refusal.reason ?? "no_holder" },
            ctx,
          ).catch(() => undefined);
          result.passedOver += 1;
          continue;
        }
        // They left (or were moved in by another run) between the read and the write.
        if (
          refusal.code === "conflict" &&
          (refusal.reason === "moved_meanwhile" || refusal.reason === "not_in_position")
        ) {
          continue;
        }
        if (refusal.rule === "waitlist" && refusal.reason === "closed") break;
        // No place (another promotion took the hold), a spend raced, or something unexpected:
        // nothing is given back, and the next tick reads again.
        giveBack = false;
        if (refusal.rule !== "capacity" && refusal.reason !== "spent_meanwhile") {
          result.failed += 1;
          console.error("waitlist: a waiter could not be promoted", {
            object,
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
    }
    if (giveBack && promoted < holds) {
      try {
        await invoke("waitlist.release", { object, on: row.record_id, before }, ctx);
        result.released += holds - promoted;
      } catch (error) {
        result.failed += 1;
        console.error("waitlist: holds could not be given back", {
          object,
          on: row.record_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}
