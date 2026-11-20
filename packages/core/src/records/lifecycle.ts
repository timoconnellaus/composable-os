// A record's lifecycle (ADR 0425): which declaration an object has (`stages` or `states`), run
// through the one transition engine. record.create, record.update and the record CSV import call
// `applyTransition` for every write; so does platform code that makes a `host` move.
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { applyStageBehaviour, type StageCache } from "./stages.ts";
import { statesLifecycle } from "./states.ts";
import { type Mover, runTransition, type TransitionOutcome } from "./transitions.ts";

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
 * Who a call through an operation moves a record as. Everyone who can call a record operation
 * today works for the organisation: people, the assistant, MCP clients, automations and
 * extensions are all `staff`. Stage 22's customer principal is the one that will answer
 * `customer` here. Nothing answers `host`: see `TransitionOptions.by`.
 */
export function callerMover(_ctx: HandlerContext): Mover {
  return "staff";
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
  if (object.states) {
    return runTransition(
      statesLifecycle(object, object.states),
      ctx,
      object,
      id,
      before,
      written,
      options.by,
    );
  }
  const outcome = await applyStageBehaviour(ctx, object, id, before, written, options.cache);
  return { ...outcome, field: object.stages?.field ?? null };
}
