// The `states` behaviour (ADR 0425): an object declares a small, fixed state machine and the host
// holds every write to it. Its declaration, its manifest schema and its contract checks live
// here; the host's side is packages/core/src/records/states.ts, on the transition engine it
// shares with `stages`.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * Who may make a move. `staff`: anyone working for the organisation (people, their assistants,
 * MCP clients, automations and extensions acting for them). `customer`: a signed-in customer, on
 * their own record. `host`: platform code only (a payment confirmation, an expiry); no caller of
 * an operation can make it.
 */
export const MOVERS = ["staff", "customer", "host"] as const;
export type Mover = (typeof MOVERS)[number];

/** One allowed move of a state machine. */
export interface StateMove {
  /** The state, or states, the record moves from. */
  from: string | readonly string[];
  /** The state it moves to. */
  to: string;
  /** Who may make it. */
  by: readonly Mover[];
  /** Fields that must have a value to make the move, and cannot be emptied while in `to`. */
  requires?: readonly string[];
  /** The move ends the lifecycle: nothing moves out of `to`. */
  final?: boolean;
}

/**
 * A state machine (ADR 0425). The host enforces it in the record operations and the record CSV
 * import, for every actor, and in the approval queue's dry run:
 *
 * - A record is created in `initial`. Creating it in another state is judged as the move from
 *   `initial` to that state.
 * - A move that is not declared is refused, with details naming the rule, the state and the
 *   field to fix. So is a declared move made by someone its `by` does not list, and a move while
 *   one of its `requires` fields is empty.
 * - Every move is recorded in state history (entered and left times, who) in the same batch as
 *   the write and, when the state field is tracked, posted on the timeline as "Moved to <state>".
 */
export interface StatesSpec {
  /** This object's select field holding the state. Its options are the states. */
  field: string;
  /** The state a new record starts in. */
  initial: string;
  moves: readonly StateMove[];
}

const fieldName = z.string().max(40);
const stateValue = z.string().min(1).max(100);

export const statesManifestSchema = z.object({
  field: fieldName,
  initial: stateValue,
  moves: z
    .array(
      z.object({
        from: z.union([stateValue, z.array(stateValue).min(1).max(50)]),
        to: stateValue,
        by: z.array(z.enum(MOVERS)).min(1).max(MOVERS.length),
        requires: z.array(fieldName).max(50).optional(),
        final: z.boolean().optional(),
      }),
    )
    .max(200),
});
export type StatesManifest = z.infer<typeof statesManifestSchema>;

/** The states a move leaves, as a list. */
export function moveOrigins(move: { from: string | readonly string[] }): readonly string[] {
  return typeof move.from === "string" ? [move.from] : move.from;
}

/** Reports problems with `objects.<name>.states` through `contract`. */
export function checkObjectStates(
  _m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const states = object.states;
  if (!states) return;
  const sp = `objects.${name}.states`;
  if (object.stages) {
    contract(sp, "An object has one lifecycle: declare stages or states, not both");
  }
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const field = fieldOf(states.field);
  if (field?.type !== "select") {
    contract(`${sp}.field`, `"${states.field}" must be a select field of ${name}`);
    return;
  }
  if (field.readOnly) {
    contract(`${sp}.field`, "The state field cannot be read-only: the moves say who may change it");
  }
  if (field.editableOptions) {
    contract(
      `${sp}.field`,
      "The state field cannot have editableOptions: states are fixed in the declaration",
    );
  }
  const values = new Set((field.options ?? []).map((o) => o.value));
  const isState = (value: string) => values.has(value);
  if (!isState(states.initial)) {
    contract(`${sp}.initial`, `"${states.initial}" is not an option of ${states.field}`);
  }
  if (field.default !== undefined && field.default !== states.initial) {
    contract(
      `${sp}.initial`,
      `${states.field}'s default must be the initial state "${states.initial}", or be left out`,
    );
  }

  const seen = new Set<string>();
  const finals = new Set(states.moves.filter((move) => move.final).map((move) => move.to));
  states.moves.forEach((move, i) => {
    const mp = `${sp}.moves.${i}`;
    if (!isState(move.to)) contract(`${mp}.to`, `"${move.to}" is not an option of ${states.field}`);
    if (new Set(move.by).size !== move.by.length) contract(`${mp}.by`, "List each mover once");
    if (finals.has(move.to) && !move.final) {
      contract(
        `${mp}.final`,
        `Another move into "${move.to}" is final; every move into a state must agree`,
      );
    }
    if (move.final && move.to === states.initial) {
      contract(`${mp}.final`, "The initial state cannot be final");
    }
    for (const from of moveOrigins(move)) {
      if (!isState(from)) {
        contract(`${mp}.from`, `"${from}" is not an option of ${states.field}`);
      }
      if (from === move.to) contract(`${mp}.from`, `A move cannot go from "${from}" to itself`);
      if (finals.has(from)) {
        contract(`${mp}.from`, `"${from}" is final: nothing moves out of it`);
      }
      const key = JSON.stringify([from, move.to]);
      if (seen.has(key)) {
        contract(mp, `The move from "${from}" to "${move.to}" is declared twice`);
      }
      seen.add(key);
    }
    for (const local of move.requires ?? []) {
      const required = fieldOf(local);
      if (!required || required.type === "formula" || local === states.field) {
        contract(
          `${mp}.requires`,
          `"${local}" must be a field of ${name} other than a formula or the state field`,
        );
      } else if (required.readOnly && move.by.some((mover) => mover !== "host")) {
        // Only the host writes a read-only field, so only a host move can fill it.
        contract(
          `${mp}.requires`,
          `"${local}" is read-only, so only a move made by the host alone can require it`,
        );
      }
    }
  });
}
