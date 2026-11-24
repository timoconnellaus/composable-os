// The transition engine (ADR 0425): the one place that decides, for a record with a lifecycle,
// whether a write's move is allowed, which fields it requires and who may make it, and that
// produces the history row for the write's own batch and the names the timeline post uses.
//
// A lifecycle is declared in one of two forms, and the engine does not know which:
//   - `stages` (ADR 0100): positions are records an admin edits (records/stages.ts);
//   - `states` (ADR 0425): positions are a fixed set declared in code (records/states.ts).
// A form is a `Lifecycle`: it places the record (where it was, where the write leaves it, who
// may make that move, what the position requires) and may set values that follow the position.
// Everything else is here, once: the check on who is moving, required fields, history.
//
// The engine runs inside record.create, record.update and the record CSV import (through
// records/lifecycle.ts), so it holds for every actor, and in the approval queue's dry run,
// which runs the same handler with its writes discarded.
import type { Mover } from "@composable-os/sdk";
import { CompiledQuery } from "kysely";
import { ValidationError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import type { Principal } from "../principals.ts";

export type { Mover };

/**
 * Who a call is really for. On the host's own context during a customer's or the public's call
 * `principal` is the org's (the host's reads are org-wide) and `onBehalfOf` is the caller.
 */
export function callerOf(ctx: Pick<HandlerContext, "principal" | "onBehalfOf">): Principal {
  return ctx.onBehalfOf ?? ctx.principal;
}

/**
 * The staff user a move is written down as made by (`entered_by`), or null. A customer's or the
 * public's call has no staff user (`ctx.user` throws there, or is a stand-in), and platform code
 * making a `host` move during such a call is not that caller either: the row then says only who
 * moved it as (`entered_as`).
 */
export function enteredBy(ctx: HandlerContext): string | null {
  return callerOf(ctx).kind === "staff" ? ctx.user.id : null;
}
export const ALL_MOVERS: readonly Mover[] = ["staff", "customer", "host"];

/** A place in a lifecycle: a stage record, or a declared state. */
export interface Position {
  /** The stage record's id, or the state's value. */
  id: string;
  title: string;
  /** Stages: open, won or lost. States: open or final. Stored in history. */
  type: string;
}

/** What every refusal's details carry, whichever form refused. */
export interface TransitionRuleBase {
  rule: string;
  object: string;
  /** The first field to fix (what a UI asks for first). */
  field: string;
  fields: string[];
  labels: string[];
  /** A required-fields refusal: the missing fields only the host sets (ADR 0750), named first. */
  setByHost?: string[];
}

/** A write broke a lifecycle rule. `code` is `invalid_input`; details say what to fix. */
export class TransitionRuleError extends ValidationError {
  override name = "TransitionRuleError";
}

/** One write, as a lifecycle sees it. */
export interface TransitionWrite {
  readonly ctx: HandlerContext;
  readonly object: ObjectDefinition;
  readonly id: string;
  /** The record's values before the write; null on create. */
  readonly before: Record<string, unknown> | null;
  /** The validated values being written. */
  readonly written: Record<string, unknown>;
  /** The record as the write leaves it, including what the lifecycle has set so far. */
  readonly after: Record<string, unknown>;
  /** Who is making the write. */
  readonly by: Mover;
  has(field: string): boolean;
  /** Written with a value other than the one stored (UIs may send unchanged fields). */
  changed(field: string): boolean;
  /** Sets a value on top of the caller's. */
  set(field: string | undefined, value: unknown): void;
  labelOf(field: string): string;
}

/** Where a write leaves a record, as its lifecycle's declaration answers. */
export interface Placement {
  /** The id of the position it was in (null on create, or when it had none). */
  fromId: string | null;
  /** That position, when it can still be read. */
  from: Position | null;
  to: Position;
  /** Who may make the move from `fromId` to `to`. Read only when the position changes. */
  by: readonly Mover[];
  /** Fields that must have a value while the record is in `to`. */
  requires: readonly string[];
  /** History's group (a stage's pipeline), read after the lifecycle's values are set. */
  group(): string | null;
}

/** One form of lifecycle declaration, bound to an object. `P` is what its `place` hands back. */
export interface Lifecycle<P extends Placement = Placement> {
  readonly form: "stages" | "states";
  /** The field holding the position. */
  readonly field: string;
  /**
   * Works out the record's position after the write, setting defaults, and refuses a position
   * the declaration does not allow. Null: the record has no lifecycle to run (nothing to do).
   */
  place(write: TransitionWrite): Promise<P | null>;
  /** Sets the values that follow the position (a stage's status, probability, closed date). */
  follow?(write: TransitionWrite, placement: P, moved: boolean): void;
  /** Builds this form's refusal: the shared details plus its own (`stage` or `state`). */
  refusal(
    write: TransitionWrite,
    refusal: { rule: "required_fields" | "move_not_permitted"; message: string; fields: string[] },
    placement: P,
  ): TransitionRuleError;
}

export interface TransitionOutcome {
  /** Values the lifecycle sets on top of the caller's. */
  values: Record<string, unknown>;
  /** History statements for the operation's batch. */
  history: CompiledQuery[];
  /** Set when the record changed position: the one it entered. */
  moved: Position | null;
  /** The position it left, when it moved and that position can still be read. */
  left: Position | null;
  /** The field holding the position, when the object has a lifecycle. */
  field: string | null;
}

export const NO_TRANSITION: TransitionOutcome = {
  values: {},
  history: [],
  moved: null,
  left: null,
  field: null,
};

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** The details every refusal shares. */
export function ruleBase(
  write: Pick<TransitionWrite, "object" | "labelOf">,
  rule: string,
  fields: string[],
): TransitionRuleBase {
  return {
    rule,
    object: write.object.name,
    field: fields[0] as string,
    fields,
    labels: fields.map(write.labelOf),
  };
}

/**
 * Runs one write through `lifecycle`. `before` is the record's values before (null on create);
 * `written` the validated values being written; `by` who is making the write. Throws a
 * TransitionRuleError when the write breaks a rule. Returns the values to set, the history
 * statements for the batch and the move, for the timeline.
 */
export async function runTransition<P extends Placement>(
  lifecycle: Lifecycle<P>,
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  written: Record<string, unknown>,
  by: Mover,
): Promise<TransitionOutcome> {
  const values: Record<string, unknown> = {};
  const after: Record<string, unknown> = { ...(before ?? {}), ...written };
  const has = (field: string) => Object.hasOwn(written, field);
  const write: TransitionWrite = {
    ctx,
    object,
    id,
    before,
    written,
    after,
    by,
    has,
    changed: (field) =>
      has(field) &&
      JSON.stringify(written[field] ?? null) !== JSON.stringify(before?.[field] ?? null),
    set: (field, value) => {
      if (!field) return;
      values[field] = value;
      after[field] = value;
    },
    labelOf: (field) => object.fields.find((f) => f.name === field)?.label ?? field,
  };

  const placement = await lifecycle.place(write);
  if (!placement) return NO_TRANSITION;
  const { to } = placement;
  const moved = to.id !== placement.fromId;

  // Who may make it.
  if (moved && !placement.by.includes(by)) {
    throw lifecycle.refusal(
      write,
      {
        rule: "move_not_permitted",
        message: notPermittedMessage(object, to, placement.by),
        fields: [lifecycle.field],
      },
      placement,
    );
  }

  lifecycle.follow?.(write, placement, moved);

  // Required fields: everything the position needs when entering it (or creating in it);
  // afterwards only fields this write changes (so an edit cannot empty them).
  const required = [...new Set(placement.requires)].filter((field) =>
    object.fields.some((f) => f.name === field),
  );
  const checked = moved || before === null ? required : required.filter(write.changed);
  const missing = checked.filter((field) => isEmptyValue(after[field]));
  if (missing.length) {
    // A required read-only field is a fact the host sets (ADR 0750: a quote's acceptance, a
    // sign-off). The move cannot supply it, so it is named first, where a UI looks for the field
    // to ask for, and the refusal says the act it records sets it.
    const hostSet = missing.filter((field) => hostFact(object, field));
    const fields = [...hostSet, ...missing.filter((field) => !hostSet.includes(field))];
    const byHand = hostSet.length
      ? `; ${hostSet.map(write.labelOf).join(", ")} ${hostSet.length === 1 ? "is" : "are"} set by the act it records, not by a move`
      : "";
    const refusal = lifecycle.refusal(
      write,
      {
        rule: "required_fields",
        message: `${to.title} needs ${fields.map(write.labelOf).join(", ")}${byHand}`,
        fields,
      },
      placement,
    );
    // The same key on either form's details, so it is added here rather than by each form.
    if (hostSet.length) Object.assign(refusal.details as object, { setByHost: hostSet });
    throw refusal;
  }

  // History: close the current row and open one for the position entered, in the write's batch.
  //
  // A move is made from a current read or not at all (ADR 0437). The close is queued now, before
  // the caller queues the record's own write, and closes the open row only while the record still
  // holds the position this write was judged from. Opening the next row then fails the batch
  // (one open row per record: core_transition_history_current_idx, migration 0420; errors.ts
  // answers it as a conflict, `moved_meanwhile`) when another write moved the record in between:
  // two scanners checking in one ticket, two people moving one deal. Nothing is read for it.
  const history: CompiledQuery[] = [];
  if (moved) {
    if (before !== null) {
      const column = object.fields.find((f) => f.name === lifecycle.field)?.column;
      if (!column) {
        throw new ValidationError(`${object.label} has no column for ${lifecycle.field}`);
      }
      ctx.write(
        CompiledQuery.raw(
          `UPDATE core_transition_history SET left_at = ? WHERE object_type = ? AND record_id = ? AND left_at IS NULL AND EXISTS (SELECT 1 FROM ${object.source} WHERE id = ? AND ${column} IS ?)`,
          [ctx.now, object.name, id, id, storedPosition(before[lifecycle.field])],
        ),
      );
    }
    history.push(
      CompiledQuery.raw(
        "INSERT INTO core_transition_history (id, object_type, record_id, form, position_id, group_id, position_type, entered_at, left_at, entered_by, entered_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        [
          newId("stageHistory"),
          object.name,
          id,
          lifecycle.form,
          to.id,
          placement.group(),
          to.type,
          ctx.now,
          enteredBy(ctx),
          by,
        ],
      ),
    );
  }
  return {
    values,
    history,
    moved: moved ? to : null,
    left: moved ? placement.from : null,
    field: lifecycle.field,
  };
}

/** A field no caller writes: read-only and not computed (a formula has no fact to wait for). */
function hostFact(object: ObjectDefinition, field: string): boolean {
  const definition = object.fields.find((f) => f.name === field);
  return definition?.readOnly === true && definition.fieldType !== "formula";
}

/** A position value as its column stores it (a select's value, a stage relation's id). */
function storedPosition(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value && "id" in value)
    return String((value as { id: unknown }).id);
  return String(value);
}

function notPermittedMessage(object: ObjectDefinition, to: Position, by: readonly Mover[]) {
  if (by.length === 1 && by[0] === "host") {
    return `${object.label} becomes ${to.title} when the platform confirms it; it cannot be set`;
  }
  const who = by.map((mover) => (mover === "host" ? "the platform" : mover)).join(" or ");
  return `Only ${who} can move ${object.label.toLowerCase()} to ${to.title}`;
}

/**
 * What a move puts on the timeline (ADR 0100, ADR 0425): the post reads "Moved to <position>"
 * and its change carries the positions' titles. Undefined when the write did not move.
 */
export function transitionTimeline(outcome: TransitionOutcome):
  | {
      subject: string;
      field: string;
      labels: { before: string | null; after: string | null };
    }
  | undefined {
  if (!outcome.moved || !outcome.field) return undefined;
  return {
    subject: `Moved to ${outcome.moved.title}`,
    field: outcome.field,
    labels: { before: outcome.left?.title ?? null, after: outcome.moved.title },
  };
}
