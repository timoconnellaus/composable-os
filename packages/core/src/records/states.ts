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
import type { ObjectDefinition, StatesDefinition } from "../fields/types.ts";
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
    | "no_state";
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
    extra: Pick<StateRuleDetails, "by" | "allowed"> = {},
  ) =>
    new StateRuleError(message, {
      ...ruleBase(write, rule, fields),
      rule,
      state: ref(to),
      from: ref(from),
      ...extra,
    });

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
