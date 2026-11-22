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
  /**
   * When a customer may make it (stage 31, ADR 0503): from `from` (inclusive) until `until`
   * (exclusive), by the host's clock in the write. Staff and the host are not bound.
   */
  window?: MoveWindow;
  /**
   * A boolean field (named as a window's `at` is): while it is true, only staff and the host may
   * make the move ("this class type is booked by the gym").
   */
  staffOnly?: string;
}

/**
 * One end of a window (ADR 0503): the moment in the datetime field `at` (a field of the record,
 * or `<relation>.<field>` on the record a relation of one record points to), less `daysBefore`
 * whole days at the same local time in `zone` (a timezone field named the same way; the
 * organisation's zone when left out) and then `minutesBefore` minutes. Each of the two is a
 * number, or a number field named as `at` is. A string is short for `{ at }`. When any of them
 * has no value the window cannot be worked out, and a customer's move is refused.
 */
export interface WindowBound {
  at: string;
  daysBefore?: number | string;
  minutesBefore?: number | string;
  zone?: string;
}

/** A window on a move or a create (ADR 0503). */
export interface MoveWindow {
  from?: string | WindowBound;
  until?: string | WindowBound;
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
  /**
   * Rules on every create, whatever state the record is created in (ADR 0503): the `window` in
   * which a customer may create one, and `staffOnly`, a boolean field while true only staff and
   * the host create. Named as a move's are.
   */
  create?: { window?: MoveWindow; staffOnly?: string };
  /**
   * Moves a caller asks for by name, resolved by the host (ADR 0503): writing the name (`cancel`)
   * into the state field moves the record to the first of the listed states whose move from where
   * it is the caller may make now, windows included (`["cancelled", "late_cancelled"]`). A name
   * is not a state.
   */
  requests?: Readonly<Record<string, readonly string[]>>;
}

const fieldName = z.string().max(40);
const stateValue = z.string().min(1).max(100);
const fieldPath = z.string().min(1).max(81);
const windowBound = z.union([
  fieldPath,
  z
    .object({
      at: fieldPath,
      daysBefore: z.union([z.number().int().min(-366).max(366), fieldPath]).optional(),
      minutesBefore: z.union([z.number().int().min(-527_040).max(527_040), fieldPath]).optional(),
      zone: fieldPath.optional(),
    })
    .strict(),
]);
const moveWindow = z
  .object({ from: windowBound.optional(), until: windowBound.optional() })
  .strict()
  .refine((w) => w.from !== undefined || w.until !== undefined, "A window needs from or until");

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
        window: moveWindow.optional(),
        staffOnly: fieldPath.optional(),
      }),
    )
    .max(200),
  create: z
    .object({ window: moveWindow.optional(), staffOnly: fieldPath.optional() })
    .strict()
    .optional(),
  requests: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.array(stateValue).min(1).max(10))
    .refine((r) => Object.keys(r).length <= 10, "At most 10 requests")
    .optional(),
});
export type StatesManifest = z.infer<typeof statesManifestSchema>;

/** The states a move leaves, as a list. */
export function moveOrigins(move: { from: string | readonly string[] }): readonly string[] {
  return typeof move.from === "string" ? [move.from] : move.from;
}

/** Reports problems with `objects.<name>.states` through `contract`. */
export function checkObjectStates(
  m: ExtensionManifest,
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

  // Windows, staff-only rules and requests (ADR 0503).
  const checkPath = (at: string, path: string, type: string) => {
    const field = resolveFieldPath(m, object, at);
    if (field?.type !== type || field.many) {
      contract(
        path,
        `"${at}" must be a ${type} field of ${name}, or <relation>.<field> through a relation (one record) to another of this extension's objects`,
      );
    }
  };
  const checkWindow = (window: MoveWindow | undefined, path: string) => {
    for (const end of ["from", "until"] as const) {
      const bound = window?.[end];
      if (bound === undefined) continue;
      const b = typeof bound === "string" ? { at: bound } : bound;
      checkPath(b.at, `${path}.${end}.at`, "datetime");
      for (const key of ["daysBefore", "minutesBefore"] as const) {
        const value = b[key];
        if (typeof value === "string") checkPath(value, `${path}.${end}.${key}`, "number");
      }
      if (b.zone !== undefined) checkPath(b.zone, `${path}.${end}.zone`, "timezone");
    }
  };
  states.moves.forEach((move, i) => {
    const mp = `${sp}.moves.${i}`;
    if ((move.window || move.staffOnly) && !move.by.includes("customer")) {
      contract(mp, "A window or staffOnly binds customers: the move must list customer in by");
    }
    checkWindow(move.window, `${mp}.window`);
    if (move.staffOnly) checkPath(move.staffOnly, `${mp}.staffOnly`, "boolean");
  });
  if (states.create) {
    checkWindow(states.create.window, `${sp}.create.window`);
    if (states.create.staffOnly) checkPath(states.create.staffOnly, `${sp}.create.staffOnly`, "boolean");
  }
  for (const [request, targets] of Object.entries(states.requests ?? {})) {
    const rp = `${sp}.requests.${request}`;
    if (isState(request)) contract(rp, `"${request}" is a state; a request needs its own name`);
    if (new Set(targets).size !== targets.length) contract(rp, "List each state once");
    for (const to of targets) {
      if (!isState(to)) contract(rp, `"${to}" is not an option of ${states.field}`);
      else if (!states.moves.some((move) => move.to === to)) {
        contract(rp, `No move goes to "${to}"`);
      }
    }
  }
}

/**
 * The field a path names (ADR 0503): `field` on the object, or `relation.field` on the object a
 * relation of one record points to, within the same extension.
 */
export function resolveFieldPath(
  m: ExtensionManifest,
  object: ObjectManifest,
  path: string,
): FieldManifest | undefined {
  const own = (o: ObjectManifest, local: string) =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const parts = path.split(".");
  if (parts.length === 1) return own(object, path);
  if (parts.length !== 2) return undefined;
  const [relation, local] = parts as [string, string];
  const via = own(object, relation);
  const to = via?.type === "relation" && !via.many ? via.to : undefined;
  const target = to?.startsWith(`${m.id}.`) ? to.slice(m.id.length + 1) : undefined;
  const targetObject =
    target !== undefined && Object.hasOwn(m.objects, target) ? m.objects[target] : undefined;
  return targetObject ? own(targetObject, local) : undefined;
}
