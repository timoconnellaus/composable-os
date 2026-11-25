// A record's lifecycle (ADR 0425): which declaration an object has (`stages` or `states`), run
// through the one transition engine. record.create, record.update and the record CSV import call
// `applyTransition` for every write; so does platform code that makes a `host` move.

import { enforceEntry } from "../agreements/enforce.ts";
import { assertClaimRelationKept, claimantMove } from "../capacity/claimants.ts";
import { waitlistMove } from "../capacity/waitlist.ts";
import { ForbiddenError, ValidationError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { watchLow } from "../stock/low.ts";
import { assertStockMovesKept, stockMovesOnMove } from "../stock/moves.ts";
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
  /** The record import (`record.import`, a person's door) is writing it: someone moving over. */
  imported?: boolean | undefined;
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
 * A record an order moves that may be held for a guest (`sellable.moves.guest`, ADR 0560) has no
 * Person while it is held for an unpaid guest order (and when that hold ends in a final state
 * without being paid); in its paid state and every open state its customer field is set, for
 * every writer.
 */
function assertGuestHeld(object: ObjectDefinition, after: Record<string, unknown>): void {
  const moves = object.sellable?.moves;
  const field = object.customer?.field;
  const stateField = object.states?.field;
  if (!moves?.guest || !field || !stateField) return;
  const state = after[stateField];
  const owner = after[field];
  // Where a guest's unpaid hold may end without being anyone's: expired, or a final state the
  // host moves it to (a class cancelled). Everywhere else (paid, and every open state) it is.
  const finals = new Set((object.states?.moves ?? []).filter((m) => m.final).map((m) => m.to));
  const ownerless = state === moves.held || (state !== moves.paid && finals.has(String(state)));
  if (!ownerless && (owner === null || owner === undefined || owner === "")) {
    throw new ValidationError(`${object.label} needs its ${field} outside "${moves.held}"`, {
      field,
      rule: "guest_held",
    });
  }
}

const everyMoveHooks: MoveHook[] = [];

/**
 * Registers a hook for every object's moves: a behaviour declared on objects the registry learns
 * at run time (`sellable.moves`, ADR 0560), which reads the declaration itself and returns at once
 * for an object without it. Platform code only, at module load, as `onRecordMove`.
 */
export function onEveryRecordMove(hook: MoveHook): () => void {
  everyMoveHooks.push(hook);
  return () => {
    const at = everyMoveHooks.indexOf(hook);
    if (at >= 0) everyMoveHooks.splice(at, 1);
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
    assertGuestHeld(object, { ...(before ?? {}), ...written, ...outcome.values });
    // Nobody books without the agreements they need (stage 44 step 3, ADR 0644): a caller's
    // record entering a state its agreement point lists, for every actor on every path; never
    // the host's own moves. The guard rides in this batch.
    await enforceEntry(
      ctx,
      object,
      before,
      { ...(before ?? {}), ...written, ...outcome.values },
      options.by,
      options.imported === true,
    );
    // A capacity claimant's states hold and give back its place (ADR 0501), in this batch.
    // Its waitlist (ADR 0520): a promotion's hold given back before its place is claimed; a
    // join checked, a place given back handed on to whoever waits, after.
    if (outcome.moved && object.claims) {
      const after = { ...(before ?? {}), ...written, ...outcome.values };
      await waitlistMove(ctx, object, id, before, after, options.by, "before");
      await claimantMove(ctx, object, id, before, after);
      await waitlistMove(ctx, object, id, before, after, options.by, "after");
    }
    // A state that moves stock (ADR 0681): its own record's, or its lines', in this batch.
    if (outcome.moved) {
      const after = { ...(before ?? {}), ...written, ...outcome.values };
      await stockMovesOnMove(ctx, object, id, after, outcome.moved.id);
    }
    const hooks = outcome.moved
      ? [...(moveHooks.get(object.name) ?? []), ...everyMoveHooks]
      : undefined;
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
      for (const hook of hooks) await hook(ctx, move);
    }
    return outcome;
  };
  // What moved stock stays as it moved (ADR 0681), for an object with a lifecycle or without (a
  // count's lines).
  await assertStockMovesKept(ctx, object, before, written);
  // A changed reorder level may put a record at or below it, or above (ADR 0681).
  const level = object.stock?.reorderAt;
  if (
    level &&
    before !== null &&
    Object.hasOwn(written, level) &&
    (written[level] ?? null) !== (before[level] ?? null)
  ) {
    watchLow(ctx, object.name, [id]);
  }
  if (object.states) return run(statesLifecycle(object, object.states));
  if (object.stages) return run(stagesLifecycle(object, object.stages, options.cache));
  return NO_TRANSITION;
}
