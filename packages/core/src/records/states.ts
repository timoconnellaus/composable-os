// The `states` behaviour (ADR 0425): a fixed state machine an object declares in code. The
// states are the options of a select field; the declaration names the initial state and the
// allowed moves, and for each move who may make it, the fields it requires and whether it ends
// the lifecycle. This file is the declaration's side of the transition engine
// (records/transitions.ts), which checks who is moving and the required fields, and writes
// history.
//
// What it answers for a write:
//   - a record with no state is in the initial state; a write that leaves the state empty sets it;
//   - creating a record in another state is judged as the move from the initial state to it;
//   - a move that is not declared is refused, as is any move out of a final state;
//   - the move's `by` and `requires` go to the engine;
//   - while a record stays in a state, the fields every move into that state requires cannot be
//     emptied.
import { moveOrigins } from "@composable-os/sdk";
import type { ObjectDefinition, StatesDefinition, WindowDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import {
  ALL_MOVERS,
  type Lifecycle,
  type Mover,
  type Placement,
  type Position,
  ruleBase,
  type TransitionRuleBase,
  TransitionRuleError,
  type TransitionWrite,
} from "./transitions.ts";
import { pathReader, staffOnlyMessage, staffOnlySet, windowRefusal } from "./windows.ts";

/** A state as refusals name it: its value, its option label, and whether it is final. */
export interface StateRef {
  id: string;
  title: string;
  final: boolean;
}

/** Details of a refused write: which rule, which state, and which fields to fix. */
export interface StateRuleDetails extends TransitionRuleBase {
  rule:
    | "state_move_not_declared"
    | "state_move_not_permitted"
    | "state_final"
    | "state_required_fields"
    | "state_window_not_open"
    | "state_window_closed"
    | "state_window_unknown"
    | "state_staff_only"
    | "state_request_refused"
    | "no_state";
  /** A window's refusals: when it opens and closes (ISO instants), where they apply. */
  opensAt?: string;
  closesAt?: string;
  /** The state the write would enter. Null when it would leave the record without one. */
  state: StateRef | null;
  /** The state it would leave. Null on create into the initial state. */
  from: StateRef | null;
  /** `state_move_not_permitted`: who may make the move. */
  by?: Mover[];
  /** `state_move_not_declared` and `state_final`: the states a move from `from` may enter. */
  allowed?: string[];
}

/** A write broke a state rule. `code` is `invalid_input`; details say what to fix. */
export class StateRuleError extends TransitionRuleError {
  override name = "StateRuleError";
  constructor(message: string, details: StateRuleDetails) {
    super(message, details);
  }
}

const ref = (position: Position | null): StateRef | null =>
  position ? { id: position.id, title: position.title, final: position.type === "final" } : null;

/** `object`'s state machine as the engine runs it. */
export function statesLifecycle(object: ObjectDefinition, states: StatesDefinition): Lifecycle {
  const field = states.field;
  const choices = object.fields.find((f) => f.name === field)?.options?.choices ?? [];
  const finals = new Set(states.moves.filter((move) => move.final).map((move) => move.to));
  const position = (value: string): Position => ({
    id: value,
    title: choices.find((choice) => choice.value === value)?.label ?? value,
    type: finals.has(value) ? "final" : "open",
  });
  const moveBetween = (from: string, to: string) =>
    states.moves.find((move) => move.to === to && moveOrigins(move).includes(from));
  const reachable = (from: string) => [
    ...new Set(
      states.moves.filter((move) => moveOrigins(move).includes(from)).map((move) => move.to),
    ),
  ];
  /** Fields a record in `state` keeps: those every move into it requires. */
  const held = (state: string): string[] => {
    const into = states.moves.filter((move) => move.to === state);
    const [first, ...rest] = into.map((move) => move.requires ?? []);
    return (first ?? []).filter((name) => rest.every((list) => list.includes(name)));
  };
  const refuse = (
    write: TransitionWrite,
    rule: StateRuleDetails["rule"],
    message: string,
    fields: string[],
    to: Position | null,
    from: Position | null,
    extra: Pick<StateRuleDetails, "by" | "allowed" | "opensAt" | "closesAt"> = {},
  ) =>
    new StateRuleError(message, {
      ...ruleBase(write, rule, fields),
      rule,
      state: ref(to),
      from: ref(from),
      ...extra,
    });
  /** A customer's write outside a window or a staff-only rule is refused (ADR 0503). */
  const customerRules = async (
    write: TransitionWrite,
    rules: RuleSet,
    what: string,
    to: Position,
    from: Position | null,
  ) => {
    const refusal = await customerRefusal(write.ctx, write.object, write.after, rules, what);
    if (refusal) {
      throw refuse(write, refusal.rule, refusal.message, [field], to, from, refusal.times);
    }
  };

  return {
    form: "states",
    field,
    async place(write): Promise<Placement> {
      const { before, after, object: o } = write;
      const stored = before?.[field];
      const fromId = typeof stored === "string" && stored !== "" ? stored : null;
      const from = fromId ? position(fromId) : null;
      const wanted = after[field];
      let toId = typeof wanted === "string" && wanted !== "" ? wanted : null;
      if (toId === null) {
        if (fromId !== null) {
          throw refuse(write, "no_state", `${o.label} must have a state`, [field], null, from);
        }
        toId = states.initial;
        write.set(field, toId);
      }
      const to = position(toId);
      const base = { fromId, from, to, group: () => null };
      // A customer's create meets the create rules, whatever state it starts in (ADR 0503).
      if (before === null && write.by === "customer" && states.create) {
        await customerRules(write, states.create, `Creating ${o.label.toLowerCase()}`, to, null);
      }
      // Staying where it is: nothing to allow, and what the state holds stays filled.
      if (toId === fromId) return { ...base, by: ALL_MOVERS, requires: held(toId) };
      // A record with no state yet (a new one) stands in the initial state.
      const origin = fromId ?? states.initial;
      if (toId === origin) return { ...base, by: ALL_MOVERS, requires: [] };
      const originPosition = position(origin);
      if (finals.has(origin)) {
        throw refuse(
          write,
          "state_final",
          `${o.label} is ${originPosition.title}, which is final: it cannot move to ${to.title}`,
          [field],
          to,
          originPosition,
          { allowed: [] },
        );
      }
      const move = moveBetween(origin, toId);
      if (!move) {
        throw refuse(
          write,
          "state_move_not_declared",
          `${o.label} cannot move from ${originPosition.title} to ${to.title}`,
          [field],
          to,
          originPosition,
          { allowed: reachable(origin) },
        );
      }
      // A customer's move meets its window and staff-only rule (ADR 0503); staff and the host
      // are not bound. A customer the move does not list is refused by the engine as before.
      if (write.by === "customer" && move.by.includes("customer")) {
        await customerRules(
          write,
          move,
          `Moving ${o.label.toLowerCase()} to ${to.title}`,
          to,
          originPosition,
        );
      }
      return {
        ...base,
        from: originPosition,
        by: move.by,
        requires: move.requires ?? [],
      };
    },
    refusal(write, refusal, placement) {
      const rule = `state_${refusal.rule}` as StateRuleDetails["rule"];
      return refuse(
        write,
        rule,
        refusal.message,
        refusal.fields,
        placement.to,
        placement.from,
        refusal.rule === "move_not_permitted" ? { by: [...placement.by] } : {},
      );
    },
  };
}

// --- Windows, staff-only rules and requests (stage 31, ADR 0503) ---------------------------------

/** A move's or a create's customer rules. */
interface RuleSet {
  window?: WindowDefinition | undefined;
  staffOnly?: string | undefined;
}

/** Why a customer may not make this write now, or null when they may. */
async function customerRefusal(
  ctx: HandlerContext,
  object: ObjectDefinition,
  after: Record<string, unknown>,
  rules: RuleSet,
  what: string,
): Promise<{
  rule: StateRuleDetails["rule"];
  message: string;
  times: Pick<StateRuleDetails, "opensAt" | "closesAt">;
} | null> {
  if (!rules.window && !rules.staffOnly) return null;
  const reader = pathReader(ctx, object, after);
  if (await staffOnlySet(reader, rules.staffOnly)) {
    return { rule: "state_staff_only", message: staffOnlyMessage(what), times: {} };
  }
  const refusal = await windowRefusal(ctx, reader, rules.window, what);
  if (!refusal) return null;
  return {
    rule: `state_${refusal.rule}`,
    message: refusal.message,
    times: {
      ...(refusal.opensAt ? { opensAt: refusal.opensAt } : {}),
      ...(refusal.closesAt ? { closesAt: refusal.closesAt } : {}),
    },
  };
}

/**
 * Resolves a requested move (`requests`, ADR 0503): when `values` writes a request's name into
 * the state field, returns them with the state the host picks instead, the first of the
 * request's states whose move from where the record is `by` may make now, windows and staff-only
 * rules included. A member asking to "cancel" is cancelled in time or late by the host's clock.
 * Values that ask for no request come back as they are. Refused when no listed state may be
 * entered. The record operations call it before validating, so a request is never stored; a
 * pack's dry run calls it to say which state a request would enter.
 */
export async function resolveStateRequest(
  ctx: HandlerContext,
  object: ObjectDefinition,
  before: Record<string, unknown> | null,
  values: Record<string, unknown>,
  by: Mover,
): Promise<Record<string, unknown>> {
  const states = object.states;
  const field = states?.field;
  const requests = states?.requests;
  if (!states || !field || !requests) return values;
  const asked = values[field];
  if (typeof asked !== "string" || !Object.hasOwn(requests, asked)) return values;
  const stored = before?.[field];
  const origin = typeof stored === "string" && stored !== "" ? stored : states.initial;
  const after = { ...(before ?? {}), ...values };
  const labelOf = (name: string) => object.fields.find((f) => f.name === name)?.label ?? name;
  const choices = object.fields.find((f) => f.name === field)?.options?.choices ?? [];
  const title = (value: string) => choices.find((c) => c.value === value)?.label ?? value;
  let refused: { rule: StateRuleDetails["rule"]; message: string; times: object } | null = null;
  for (const to of requests[asked] ?? []) {
    const move = states.moves.find((m) => m.to === to && moveOrigins(m).includes(origin));
    if (!move || !move.by.includes(by)) continue;
    if (by === "customer") {
      const refusal = await customerRefusal(
        ctx,
        object,
        { ...after, [field]: to },
        move,
        `Moving ${object.label.toLowerCase()} to ${title(to)}`,
      );
      if (refusal) {
        refused ??= refusal;
        continue;
      }
    }
    return { ...values, [field]: to };
  }
  const state = { id: origin, title: title(origin), final: false };
  throw new StateRuleError(
    refused?.message ?? `${object.label} cannot be moved by "${asked}" from ${title(origin)}`,
    {
      ...ruleBase({ object, labelOf }, refused?.rule ?? "state_request_refused", [field]),
      rule: refused?.rule ?? "state_request_refused",
      state: null,
      from: state,
      ...(refused?.times ?? {}),
    },
  );
}
