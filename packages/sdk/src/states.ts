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
  /**
   * Tools of this extension that may also make the move for whoever called them (stage 32b,
   * ADR 0513): a move by `["host"]` with `tools: ["voidPass"]` is made by the host and by that
   * tool, and by no other staff write (not `record.update`, not the assistant, not an automation).
   * Each tool must be `humanOnly`, or `personApproves` (ADR 0552: anyone else's call waits for a
   * person's approval), and declare a `permission`, so the move is a person's act with that
   * permission.
   */
  tools?: readonly string[];
  /**
   * Its window binds staff too (ADR 0507), every staff caller, a person included: a cancel that
   * gives a use back is in time for everyone. The host is not bound. A person who must make the
   * move outside it does so through another move only a person's tool makes (`tools`). A move
   * staff alone make may have a window with it (ADR 0551): a coach ticks a name from an hour
   * before the class, not days ahead.
   */
  bindsStaff?: boolean;
}

/**
 * A move the host makes by itself once a moment has passed (ADR 0550): a booking still `booked`
 * 30 minutes after its class ends becomes a `no_show`, if anyone on the class was ticked. The
 * runner's minute cron finds the records due and moves each as the host, from where it was or not
 * at all. Each needs a declared `host` move from each of `from` to `to`.
 */
export interface TimedMove {
  /** The state, or states, the record moves from. */
  from: string | readonly string[];
  to: string;
  /** A datetime field of the record, or `<relation>.<field>` one relation away (`class.endsAt`). */
  at: string;
  /** Minutes after `at` the move is due (0 to 10,080). */
  minutesAfter?: number;
  /**
   * Only while another live record of this object pointing at the same record (through `at`'s
   * relation) is in one of these states: a class whose attendance was taken has someone ticked.
   */
  ifAnyIn?: readonly string[];
  /**
   * Only while each of these fields of the record has a value (stage 49, ADR 0764): an appointment
   * whose coach left is never marked attended for a session nobody gave.
   */
  ifSet?: readonly string[];
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
    /**
     * Fields every create must give a value (stage 49, ADR 0764), whoever makes it, the host
     * included: an appointment is made for a client. Unlike `required`, the field may be emptied
     * later (erasing the Person keeps the record for the business's books, ADR 0320).
     */
    requires?: readonly string[];
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
   * A relation (one record) to another of this extension's objects (ADR 0863, amended): while this
   * record is in a state only tools or the host leave, the record it points to is put in the Trash
   * only by whoever may put this one there (one of the tools that move it out of its state, or a
   * person holding one of their permissions). An open fault holds its item: the item does not
   * leave the register while the fault is open. Never an AI's.
   */
  holds?: string;
  /**
   * A cascade from the record a relation points to (ADR 0507): when that record moves into a
   * state named in `when`, the host moves every live record of this object pointing at it, and in
   * one of `from`, to the state `when` gives, in the same batch, as the host (a class cancelled
   * moves its bookings to `cancelled_by_us`: their places released, their uses given back). Each
   * target needs a `host` move from each of `from`. The parent is another of this extension's
   * objects, or one of an extension this one `requires`, named in full (`ticketing.event`); a
   * parent others draw places from as a pool is followed only by an object that draws none
   * (ADR 0841).
   */
  follows?: {
    relation: string;
    when: Readonly<Record<string, string>>;
    from: readonly string[];
  };
  /** Moves the host makes once a moment has passed (ADR 0550), at most four. */
  after?: readonly TimedMove[];
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
export const windowBoundSchema = z.union([
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
  .object({ from: windowBoundSchema.optional(), until: windowBoundSchema.optional() })
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
        tools: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
        bindsStaff: z.boolean().optional(),
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
      requires: z.array(fieldName).min(1).max(20).optional(),
    })
    .strict()
    .optional(),
  requests: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.array(stateValue).min(1).max(10))
    .refine((r) => Object.keys(r).length <= 10, "At most 10 requests")
    .optional(),
  holds: fieldName.optional(),
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
  after: z
    .array(
      z
        .object({
          from: z.union([stateValue, z.array(stateValue).min(1).max(20)]),
          to: stateValue,
          at: fieldPath,
          minutesAfter: z.number().int().min(0).max(10_080).optional(),
          ifAnyIn: z.array(stateValue).min(1).max(20).optional(),
          ifSet: z.array(fieldName).min(1).max(5).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(4)
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

/**
 * The tools that make a move out of `state` when it is **guarded** (ADR 0863): not final, some move
 * leaves it, and every move leaving it is the host's alone (`by: ["host"]`, with or without
 * `tools`). An empty list when only the host leaves it; null when the state is not guarded. The
 * host's Trash rule and the test host both ask this.
 */
export function guardedStateTools(
  object: {
    states?:
      | {
          moves: readonly {
            from: string | readonly string[];
            to: string;
            by: readonly string[];
            tools?: readonly string[] | undefined;
            final?: boolean | undefined;
          }[];
        }
      | undefined;
  },
  state: unknown,
): readonly string[] | null {
  const states = object.states;
  if (!states || typeof state !== "string") return null;
  if (states.moves.some((m) => m.final && m.to === state)) return null;
  const leaving = states.moves.filter((m) => moveOrigins(m).includes(state));
  if (!leaving.length) return null;
  if (leaving.some((m) => m.by.includes("staff") || m.by.includes("customer"))) return null;
  return [...new Set(leaving.flatMap((m) => m.tools ?? []))];
}

/** Reports problems with `objects.<name>.states` through `contract`. */
export function checkObjectStates(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const states = object.states;
  // A field locked in some states (ADR 0865) names states of this object's own machine.
  for (const [local, f] of Object.entries(object.fields)) {
    if (!f.lockedIn) continue;
    const lp = `objects.${name}.fields.${local}.lockedIn`;
    if (!states) {
      contract(lp, `${name} has no states: a field is locked in states of the object's own`);
      continue;
    }
    if (local === states.field || f.type === "formula") {
      contract(
        lp,
        "The state field and a formula cannot be locked: the moves and the host set them",
      );
    }
    const options = Object.hasOwn(object.fields, states.field)
      ? (object.fields[states.field]?.options ?? [])
      : [];
    const values = new Set(options.map((o) => o.value));
    for (const state of f.lockedIn) {
      if (!values.has(state)) contract(lp, `"${state}" is not a state of ${name}`);
    }
  }
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
  const { checkPath, checkWindow } = windowChecks(m, object, name, contract);
  states.moves.forEach((move, i) => {
    const mp = `${sp}.moves.${i}`;
    // A window binds customers, or staff too with bindsStaff (ADR 0551); staffOnly customers.
    if (move.staffOnly && !move.by.includes("customer")) {
      contract(mp, "staffOnly binds customers: the move must list customer in by");
    }
    if (move.window && !move.by.includes("customer") && !move.bindsStaff) {
      contract(
        mp,
        "A window binds customers: the move must list customer in by, or bind staff (bindsStaff)",
      );
    }
    checkWindow(move.window, `${mp}.window`);
    for (const p of staffOnlyPathsOf(move.staffOnly)) checkPath(p, `${mp}.staffOnly`, "boolean");
    // A move only named tools may make (ADR 0513): each a person's, with a permission.
    for (const tool of move.tools ?? []) {
      const spec = m.tools?.[tool];
      if (!spec) {
        contract(`${mp}.tools`, `"${tool}" is not a tool of this extension`);
      } else if ((!spec.humanOnly && !spec.personApproves) || !spec.permission) {
        contract(
          `${mp}.tools`,
          `"${tool}" must be humanOnly or personApproves and declare a permission: the move is a person's act with it`,
        );
      }
    }
    if (move.bindsStaff && (!move.window || (!move.by.includes("staff") && !move.tools))) {
      contract(`${mp}.bindsStaff`, "bindsStaff needs a window, and staff in by or named tools");
    }
    if (move.tools && move.by.includes("staff")) {
      contract(
        `${mp}.tools`,
        "A move named tools may make is not also open to all staff: drop staff from by",
      );
    }
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
    for (const required of states.create.requires ?? []) {
      if (!fieldOf(required)) {
        contract(`${sp}.create.requires`, `"${required}" is not a field of ${name}`);
      }
    }
  }
  if (states.holds !== undefined) {
    const held = fieldOf(states.holds);
    const to = held?.type === "relation" && !held.many ? held.to : undefined;
    const own = to?.startsWith(`${m.id}.`) ? to.slice(m.id.length + 1) : undefined;
    if (own === undefined || !Object.hasOwn(m.objects, own)) {
      contract(
        `${sp}.holds`,
        `"${states.holds}" must be a relation (one record) of ${name} to another of this extension's objects`,
      );
    } else if (!held?.readOnly) {
      // A hold re-pointed or cleared lets go of what it held (the review of PR #502): only the
      // extension's own code sets it, and the host refuses even that while the record is guarded.
      contract(
        `${sp}.holds`,
        `"${states.holds}" must be readOnly: a relation anyone may re-point or clear holds nothing`,
      );
    }
  }
  if (states.follows) {
    const fp = `${sp}.follows`;
    const f = states.follows;
    const rel = fieldOf(f.relation);
    const to = rel?.type === "relation" && !rel.many ? rel.to : undefined;
    const own = to?.startsWith(`${m.id}.`) ? to.slice(m.id.length + 1) : undefined;
    const target = own !== undefined && Object.hasOwn(m.objects, own) ? m.objects[own] : undefined;
    // A parent in another extension this one requires (ADR 0841): its states are the host's to
    // check, at install and on every upgrade of either extension (core's checkManifest).
    const otherExt = to && own === undefined && to.includes(".") ? to.split(".")[0] : undefined;
    const required = otherExt !== undefined && (m.requires ?? []).includes(otherExt);
    if (!target?.states && !required) {
      contract(
        `${fp}.relation`,
        `"${f.relation}" must be a relation (one record) of ${name} to another of this extension's objects that declares states, or to an object of an extension this one requires`,
      );
    } else {
      // A parent whose places other records draw on as a pool counts claims that are not its
      // own, which the cascade's check at commit cannot read (ADR 0550). A child that draws on
      // it (a member of the pool, or claiming places on the parent or on a member) is refused;
      // one that draws nothing moves no places and may follow it (ADR 0841). A pool is always in
      // the parent's own extension, so a parent in another extension is never drawn on from here.
      if (target && own !== undefined) {
        const localOf = (ref: string | undefined) =>
          ref?.startsWith(`${m.id}.`) ? ref.slice(m.id.length + 1) : ref;
        const poolOf = (other: ObjectManifest | undefined) => {
          const poolField = other?.capacity?.pool;
          return poolField ? localOf(other?.fields[poolField]?.to) : undefined;
        };
        const members = new Set(
          Object.entries(m.objects)
            .filter(([, other]) => poolOf(other) === own)
            .map(([key]) => key),
        );
        const claimsOn = object.claims ? localOf(object.fields[object.claims.on]?.to) : undefined;
        const draws =
          members.has(name) ||
          (claimsOn !== undefined && (claimsOn === own || members.has(claimsOn)));
        if (members.size && draws) {
          contract(
            `${fp}.relation`,
            `${to} is a pool other records draw places from, and ${name} draws places from it: a cascade cannot follow it`,
          );
        }
      }
      const parentStates = target?.states
        ? new Set((target.fields[target.states.field]?.options ?? []).map((o) => o.value))
        : null;
      for (const [when, into] of Object.entries(f.when)) {
        if (parentStates && !parentStates.has(when)) {
          contract(`${fp}.when`, `"${when}" is not a state of ${to ?? f.relation}`);
        }
        for (const from of f.from) {
          if (!isState(from))
            contract(`${fp}.from`, `"${from}" is not an option of ${states.field}`);
          else if (
            !states.moves.some(
              (move) =>
                move.to === into && move.by.includes("host") && moveOrigins(move).includes(from),
            )
          ) {
            contract(`${fp}.when`, `${name} needs a host move from "${from}" to "${into}"`);
          }
        }
      }
    }
  }
  // Timed moves (ADR 0550): a declared host move each, and a moment the sweep reads in SQL.
  (states.after ?? []).forEach((rule, i) => {
    const tp = `${sp}.after.${i}`;
    if (!isState(rule.to)) contract(`${tp}.to`, `"${rule.to}" is not an option of ${states.field}`);
    for (const from of moveOrigins(rule)) {
      if (!isState(from)) {
        contract(`${tp}.from`, `"${from}" is not an option of ${states.field}`);
      } else if (
        !states.moves.some(
          (move) =>
            move.to === rule.to && move.by.includes("host") && moveOrigins(move).includes(from),
        )
      ) {
        contract(`${tp}.from`, `${name} needs a host move from "${from}" to "${rule.to}"`);
      }
    }
    const parts = rule.at.split(".");
    const at = parts.length <= 2 ? resolveFieldPath(m, object, rule.at) : undefined;
    const via = parts.length === 2 ? fieldOf(parts[0] as string) : undefined;
    const ownTarget = via?.type === "relation" && !via.many && via.to?.startsWith(`${m.id}.`);
    if (at?.type !== "datetime" || at.many || (parts.length === 2 && !ownTarget)) {
      contract(
        `${tp}.at`,
        `"${rule.at}" must be a datetime field of ${name}, or <relation>.<field> on another of this extension's objects`,
      );
    }
    for (const f of rule.ifSet ?? []) {
      if (!fieldOf(f)) contract(`${tp}.ifSet`, `"${f}" is not a field of ${name}`);
    }
    if (rule.ifAnyIn) {
      if (parts.length !== 2) {
        contract(`${tp}.ifAnyIn`, "ifAnyIn needs at one relation away: the records it compares");
      }
      for (const state of rule.ifAnyIn) {
        if (!isState(state)) {
          contract(`${tp}.ifAnyIn`, `"${state}" is not an option of ${states.field}`);
        }
      }
    }
  });
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
 * The checks of window paths and numbers (ADRs 0503 and 0505): for a `states` declaration, and
 * for any other declaration that names a moment the same way (a waitlist's cut-off, ADR 0520).
 */
export function windowChecks(
  m: ExtensionManifest,
  object: ObjectManifest,
  name: string,
  contract: (path: string, message: string) => void,
) {
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
  const checkBound = (bound: string | WindowBound, path: string) => {
    const b = typeof bound === "string" ? { at: bound } : bound;
    checkPath(b.at, `${path}.at`, "datetime");
    for (const key of ["daysBefore", "minutesBefore"] as const) {
      checkNumber(b[key], `${path}.${key}`);
    }
    if (b.zone !== undefined) checkPath(b.zone, `${path}.zone`, "timezone");
  };
  const checkWindow = (window: MoveWindow | undefined, path: string) => {
    for (const end of ["from", "until"] as const) {
      const bound = window?.[end];
      if (bound !== undefined) checkBound(bound, `${path}.${end}`);
    }
  };
  return { checkPath, checkNumber, checkBound, checkWindow };
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
