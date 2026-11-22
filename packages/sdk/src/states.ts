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
   * A boolean field (named as a window's `at` is), or several: while any is true, only staff and
   * the host may make the move ("this class type is booked by the gym"). A boolean formula counts
   * too (a class that is not scheduled).
   */
  staffOnly?: string | readonly string[];
}

/**
 * A number a window is worked out from (ADR 0505): a number; a number field named as a window's
 * `at` is; or `{ field?, setting? }`, the field's value and, when it is empty, this extension's
 * setting of that name (its value, or the setting's default). "A class type's own late-cancel
 * time, else the organisation's": `{ field: "class.classType.lateMinutes", setting:
 * "lateMinutes" }`.
 */
export type WindowNumber = number | string | { field?: string; setting?: string };

/**
 * One end of a window (ADR 0503): the moment in the datetime field `at` (a field of the record,
 * or `<relation>.<field>` on the record a relation of one record points to, or two relations
 * away, `<relation>.<relation>.<field>`: ADR 0505), less `daysBefore` whole days at the same
 * local time in `zone` (a timezone field named the same way; the organisation's zone when left
 * out) and then `minutesBefore` minutes. Each of the two is a `WindowNumber`. A string is short
 * for `{ at }`. When any of them has no value the window cannot be worked out, and a customer's
 * move is refused. Every field a path passes through is this extension's own: a field of its
 * objects, or one it adds to another extension's object (`fields: { "programs.classtype": … }`).
 */
export interface WindowBound {
  at: string;
  daysBefore?: WindowNumber;
  minutesBefore?: WindowNumber;
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
   * Rules on every create, whatever state the record is created in (ADR 0503): `in`, the states
   * a record may be created in besides `initial`, each with who may create it there (it is then
   * not judged as a move from `initial`: a booking is created booked or waiting by a customer,
   * pending only by the host); the `window` in which a customer
   * may create one; and `staffOnly`, a boolean field while true only staff and the host create.
   * Named as a move's are.
   */
  create?: {
    in?: Readonly<Record<string, readonly Mover[]>>;
    window?: MoveWindow;
    staffOnly?: string | readonly string[];
    /**
     * Booleans named as `staffOnly` is (ADR 0507): while any is true, nobody but the host creates
     * one, staff included (no booking into a class that was cancelled or is over).
     */
    closed?: string | readonly string[];
  };
  /**
   * Moves a caller asks for by name, resolved by the host (ADR 0503): writing the name (`cancel`)
   * into the state field moves the record to the first of the listed states whose move from where
   * it is the caller may make now, windows included (`["cancelled", "late_cancelled"]`). A name
   * is not a state. A person on the staff is not bound; every other caller (a customer, the
   * assistant, an MCP client, an automation, extension code) is resolved by the clock (ADR 0507).
   */
  requests?: Readonly<Record<string, readonly string[]>>;
  /**
   * A cascade from the record a relation points to (ADR 0507): when that record moves into a
   * state named in `when`, the host moves every live record of this object pointing at it, and in
   * one of `from`, to the state `when` gives, in the same batch, as the host (a class cancelled
   * moves its bookings to `cancelled_by_us`: their places released, their uses given back). Each
   * target needs a `host` move from each of `from`.
   */
  follows?: {
    relation: string;
    when: Readonly<Record<string, string>>;
    from: readonly string[];
  };
}

const fieldName = z.string().max(40);
const stateValue = z.string().min(1).max(100);
const fieldPath = z.string().min(1).max(122);
const windowNumber = (number: z.ZodNumber) =>
  z.union([
    number,
    fieldPath,
    z
      .object({ field: fieldPath.optional(), setting: z.string().min(1).max(40).optional() })
      .strict()
      .refine((n) => n.field !== undefined || n.setting !== undefined, "Name a field or a setting"),
  ]);
const windowBound = z.union([
  fieldPath,
  z
    .object({
      at: fieldPath,
      daysBefore: windowNumber(z.number().int().min(-366).max(366)).optional(),
      minutesBefore: windowNumber(z.number().int().min(-527_040).max(527_040)).optional(),
      zone: fieldPath.optional(),
    })
    .strict(),
]);
const staffOnlyPaths = z.union([fieldPath, z.array(fieldPath).min(1).max(4)]);
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
        staffOnly: staffOnlyPaths.optional(),
      }),
    )
    .max(200),
  create: z
    .object({
      in: z
        .record(stateValue, z.array(z.enum(MOVERS)).min(1).max(MOVERS.length))
        .refine((r) => Object.keys(r).length <= 20, "At most 20 states")
        .optional(),
      window: moveWindow.optional(),
      staffOnly: staffOnlyPaths.optional(),
      closed: staffOnlyPaths.optional(),
    })
    .strict()
    .optional(),
  requests: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.array(stateValue).min(1).max(10))
    .refine((r) => Object.keys(r).length <= 10, "At most 10 requests")
    .optional(),
  follows: z
    .object({
      relation: fieldName,
      when: z
        .record(stateValue, stateValue)
        .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 10, "1 to 10 states"),
      from: z.array(stateValue).min(1).max(20),
    })
    .strict()
    .optional(),
});
export type StatesManifest = z.infer<typeof statesManifestSchema>;

/** A staff-only rule's paths, as a list (ADR 0505). */
export function staffOnlyPathsOf(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : value;
}

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

  // Windows, staff-only rules and requests (ADR 0503; two relations and settings, ADR 0505).
  const checkPath = (at: string, path: string, type: string) => {
    const field = resolveFieldPath(m, object, at);
    // A staff-only rule may read a formula: the host computes it in the view (a boolean one).
    const formulaOk = type === "boolean" && field?.type === "formula";
    if ((field?.type !== type && !formulaOk) || field?.many) {
      contract(
        path,
        `"${at}" must be a ${type} field of ${name}, or <relation>.<field> through up to two relations (one record each), every field on the way declared by this extension`,
      );
    }
  };
  const checkNumber = (value: WindowNumber | undefined, path: string) => {
    if (typeof value === "string") checkPath(value, path, "number");
    else if (typeof value === "object") {
      if (value.field !== undefined) checkPath(value.field, `${path}.field`, "number");
      if (value.setting !== undefined) {
        const settings = m.settings ?? {};
        const setting = Object.hasOwn(settings, value.setting)
          ? settings[value.setting]
          : undefined;
        if (setting?.type !== "number") {
          contract(`${path}.setting`, `"${value.setting}" must be a number setting of ${m.id}`);
        }
      }
    }
  };
  const checkWindow = (window: MoveWindow | undefined, path: string) => {
    for (const end of ["from", "until"] as const) {
      const bound = window?.[end];
      if (bound === undefined) continue;
      const b = typeof bound === "string" ? { at: bound } : bound;
      checkPath(b.at, `${path}.${end}.at`, "datetime");
      for (const key of ["daysBefore", "minutesBefore"] as const) {
        checkNumber(b[key], `${path}.${end}.${key}`);
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
    for (const p of staffOnlyPathsOf(move.staffOnly)) checkPath(p, `${mp}.staffOnly`, "boolean");
  });
  if (states.create) {
    for (const state of Object.keys(states.create.in ?? {})) {
      if (!isState(state))
        contract(`${sp}.create.in`, `"${state}" is not an option of ${states.field}`);
      if (finals.has(state))
        contract(`${sp}.create.in`, `"${state}" is final: nothing is created in it`);
    }
    checkWindow(states.create.window, `${sp}.create.window`);
    for (const p of staffOnlyPathsOf(states.create.staffOnly)) {
      checkPath(p, `${sp}.create.staffOnly`, "boolean");
    }
    for (const p of staffOnlyPathsOf(states.create.closed)) {
      checkPath(p, `${sp}.create.closed`, "boolean");
    }
  }
  if (states.follows) {
    const fp = `${sp}.follows`;
    const f = states.follows;
    const rel = fieldOf(f.relation);
    const target =
      rel?.type === "relation" && !rel.many && rel.to?.startsWith(`${m.id}.`)
        ? m.objects[rel.to.slice(m.id.length + 1)]
        : undefined;
    if (!target?.states) {
      contract(
        `${fp}.relation`,
        `"${f.relation}" must be a relation (one record) of ${name} to another of this extension's objects that declares states`,
      );
    } else {
      const parentStates = new Set(
        (target.fields[target.states.field]?.options ?? []).map((o) => o.value),
      );
      for (const [when, to] of Object.entries(f.when)) {
        if (!parentStates.has(when)) {
          contract(`${fp}.when`, `"${when}" is not a state of ${rel?.to ?? f.relation}`);
        }
        for (const from of f.from) {
          if (!isState(from))
            contract(`${fp}.from`, `"${from}" is not an option of ${states.field}`);
          else if (
            !states.moves.some(
              (move) =>
                move.to === to && move.by.includes("host") && moveOrigins(move).includes(from),
            )
          ) {
            contract(`${fp}.when`, `${name} needs a host move from "${from}" to "${to}"`);
          }
        }
      }
    }
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
 * The field a path names (ADR 0503; two relations from ADR 0505): `field` on the object, or
 * `relation.field` / `relation.relation.field` through relations of one record. Every field on
 * the way is this extension's: a field of one of its objects, or one it adds to another object
 * (`fields: { "programs.classtype": { … } }`). Undefined when the path names no such field.
 */
export function resolveFieldPath(
  m: ExtensionManifest,
  object: ObjectManifest,
  path: string,
): FieldManifest | undefined {
  const parts = path.split(".");
  if (parts.length > 3) return undefined;
  const added = m.fields ?? {};
  /** The fields this extension declares on an object (by its full name), or on `object`. */
  const fieldsOn = (target: string | null): Readonly<Record<string, FieldManifest>> | undefined => {
    if (target === null) return object.fields;
    if (target.startsWith(`${m.id}.`)) {
      const local = target.slice(m.id.length + 1);
      return Object.hasOwn(m.objects, local) ? m.objects[local]?.fields : undefined;
    }
    return Object.hasOwn(added, target) ? added[target] : undefined;
  };
  let on: string | null = null;
  for (const [i, part] of parts.entries()) {
    const fields = fieldsOn(on);
    const field = fields && Object.hasOwn(fields, part) ? fields[part] : undefined;
    if (!field) return undefined;
    if (i === parts.length - 1) return field;
    if (field.type !== "relation" || field.many || !field.to) return undefined;
    on = field.to.includes(".") ? field.to : `${m.id}.${field.to}`;
  }
  return undefined;
}
