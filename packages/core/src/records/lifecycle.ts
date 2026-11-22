// A record's lifecycle (ADR 0425): which declaration an object has (`stages` or `states`), run
// through the one transition engine. record.create, record.update and the record CSV import call
// `applyTransition` for every write; so does platform code that makes a `host` move.

import { assertClaimRelationKept, claimantMove } from "../capacity/claimants.ts";
import { ForbiddenError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { type StageCache, stagesLifecycle } from "./stages.ts";
import { statesLifecycle } from "./states.ts";
import {
  callerOf,
  type Lifecycle,
  type Mover,
  NO_TRANSITION,
  type Placement,
  type Position,
  runTransition,
  type TransitionOutcome,
} from "./transitions.ts";

export interface TransitionOptions {
  /**
   * Who is making the write. Callers of an operation are never `host`: only platform code that
   * calls the engine itself passes it, and no operation takes it from its input.
   */
  by: Mover;
  /** Stage reads shared across one operation (an import touches the same few stages). */
  cache?: StageCache | undefined;
}

/**
 * Who a call through an operation moves a record as (ADR 0425, ADR 0426). Everyone who works for
 * the organisation is `staff`: people, the assistant, MCP clients, automations and extensions. A
 * signed-in customer is `customer`, whether their own handler writes or the host writes for them
 * at the seam. The public are no mover: they change no record's position. Nothing answers
 * `host`: see `TransitionOptions.by`.
 */
export function callerMover(ctx: Pick<HandlerContext, "principal" | "onBehalfOf">): Mover {
  const caller = callerOf(ctx);
  if (caller.kind === "staff") return "staff";
  if (caller.kind === "customer") return "customer";
  throw new ForbiddenError("This call cannot move a record");
}

// --- The hook when a record moves (ADR 0426) ------------------------------------------------------

/** A move the engine has allowed, as a hook sees it. */
export interface RecordMove {
  readonly object: ObjectDefinition;
  readonly id: string;
  /** The position left; null when the record was created into `to`, or it cannot be read. */
  readonly from: Position | null;
  readonly to: Position;
  readonly by: Mover;
  /** The record's values before the write (null on create) and as the write leaves it. */
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
}

/**
 * Platform code that acts when a record of one object moves: it queues its own statements with
 * `ctx.write`, so they commit in the batch of the write that made the move, or not at all, and it
 * may throw to refuse the write. It runs for every actor and in the approval queue's dry run.
 */
export type MoveHook = (ctx: HandlerContext, move: RecordMove) => void | Promise<void>;

const moveHooks = new Map<string, MoveHook[]>();

/**
 * Registers a hook for an object's moves. For platform code only, at module load: a behaviour
 * the host enforces (`capacity` confirming and releasing an order's holds, `sellable` granting
 * what a paid line grants). It is not in the SDK or the contract, so no extension can hook a
 * write (ADR 0404). Returns a function that removes the hook (tests).
 */
export function onRecordMove(object: string, hook: MoveHook): () => void {
  const hooks = moveHooks.get(object) ?? [];
  hooks.push(hook);
  moveHooks.set(object, hooks);
  return () => {
    const at = hooks.indexOf(hook);
    if (at >= 0) hooks.splice(at, 1);
  };
}

/**
 * Applies `object`'s lifecycle to a write. `before` is the record's values before (null on
 * create); `written` the validated values being written. Throws a TransitionRuleError when the
 * write breaks a rule; returns the values to set, the history statements for the write's batch
 * and the move. An object without a lifecycle gets an empty outcome.
 */
export async function applyTransition(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  written: Record<string, unknown>,
  options: TransitionOptions,
): Promise<TransitionOutcome> {
  const run = async <P extends Placement>(lifecycle: Lifecycle<P>) => {
    assertClaimRelationKept(object, before, written);
    const outcome = await runTransition(lifecycle, ctx, object, id, before, written, options.by);
    // A capacity claimant's states hold and give back its place (ADR 0501), in this batch.
    if (outcome.moved && object.claims) {
      await claimantMove(ctx, object, id, before, {
        ...(before ?? {}),
        ...written,
        ...outcome.values,
      });
    }
    const hooks = outcome.moved ? moveHooks.get(object.name) : undefined;
    if (outcome.moved && hooks?.length) {
      const move: RecordMove = {
        object,
        id,
        from: outcome.left,
        to: outcome.moved,
        by: options.by,
        before,
        after: { ...(before ?? {}), ...written, ...outcome.values },
      };
      for (const hook of [...hooks]) await hook(ctx, move);
    }
    return outcome;
  };
  if (object.states) return run(statesLifecycle(object, object.states));
  if (object.stages) return run(stagesLifecycle(object, object.stages, options.cache));
  return NO_TRANSITION;
}
