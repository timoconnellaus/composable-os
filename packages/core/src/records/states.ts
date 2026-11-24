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
import { type HandlerContext, personsTool } from "../operation.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import { assertOnFreeTime } from "../staffing/free.ts";
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
import {
  type PathReader,
  pathReader,
  staffOnlyMessage,
  staffOnlySet,
  windowRefusal,
} from "./windows.ts";

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
    | "state_closed"
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
    reader: PathReader,
    rules: RuleSet,
    what: string,
    to: Position,
    from: Position | null,
  ) => {
    const refusal = await customerRefusal(write.ctx, reader, rules, what);
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
      // One reader for every rule below, so each record they read through is read once.
      const reader = pathReader(write.ctx, o, after);
      // Closed to everyone but the host (ADR 0507): no booking into a class that was cancelled
      // or is over, by staff either. Judged on create, and when a write changes what it reads.
      const closedPaths = states.create?.closed;
      if (
        closedPaths &&
        write.by !== "host" &&
        (before === null || ruleSources({ staffOnly: closedPaths }).some((f) => write.changed(f)))
      ) {
        if (await staffOnlySet(reader, closedPaths)) {
          throw refuse(
            write,
            "state_closed",
            `${o.label} cannot be made now: what it is for is closed`,
            [field],
            to,
            from,
          );
        }
        // Read when the write is planned: a cancel committing before this write would leave it
        // on a closed record the cancel never saw. The record each flag is read through must not
        // move before this batch commits (migration 0670, ADR 0550).
        await queueUnmovedGuards(write.ctx, o, after, closedPaths);
      }
      // Nor does a record take a place on what is closed (ADR 0553): a move from a state that
      // holds no place into one that does is refused while the same flags are set, for everyone,
      // the host included (a booking ticked or booked again on a cancelled class).
      const claims = o.claims;
      if (closedPaths && claims && before !== null && toId !== fromId) {
        const holds = (state: string | null) =>
          state !== null && (claims.held.includes(state) || claims.confirmed.includes(state));
        if (holds(toId) && !holds(fromId)) {
          if (await staffOnlySet(reader, closedPaths)) {
            throw refuse(
              write,
              "state_closed",
              `${o.label} cannot take a place now: what it is for is closed`,
              [field],
              to,
              from,
            );
          }
          await queueUnmovedGuards(write.ctx, o, after, closedPaths);
        }
      }
      // A customer creates a record only in its initial state, or in one `create.in` lists for
      // them (ADR 0507): never straight into a later one (a booking made already cancelled).
      if (
        before === null &&
        write.by === "customer" &&
        toId !== states.initial &&
        !states.create?.in?.[toId]?.includes("customer")
      ) {
        throw refuse(
          write,
          "state_move_not_permitted",
          `A customer creates ${o.label.toLowerCase()} in ${position(states.initial).title} only`,
          [field],
          to,
          null,
          { by: [] },
        );
      }
      // A customer's create meets the create rules, whatever state it starts in (ADR 0503).
      if (before === null && write.by === "customer" && states.create) {
        await customerRules(
          write,
          reader,
          states.create,
          `Creating ${o.label.toLowerCase()}`,
          to,
          null,
        );
      }
      // A customer changing what the create rules read (the class it is for, or a field of its
      // own they name) makes it again, in effect: judged as a create of the record as the write
      // leaves it, whatever state it is in. Otherwise waiting on an open class, then pointing the
      // booking at a closed or staff-only one, would get round them.
      if (
        before !== null &&
        write.by === "customer" &&
        states.create &&
        ruleSources(states.create).some((f) => write.changed(f))
      ) {
        await customerRules(
          write,
          reader,
          states.create,
          `Creating ${o.label.toLowerCase()}`,
          to,
          from,
        );
      }
      // A booked shift a customer or the public makes or moves is on a free time (ADR 0763),
      // after the window above, which answers for itself. Staff are warned instead.
      if (write.by === "customer") {
        await assertOnFreeTime(write.ctx, o, write.id, before, { ...after, [field]: toId });
      }
      // A state a record may be created in is not a move from the initial state (ADR 0503).
      const createdIn =
        before === null && toId !== states.initial ? states.create?.in?.[toId] : undefined;
      if (createdIn) {
        return { ...base, by: createdIn, requires: held(toId) };
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
          reader,
          move,
          `Moving ${o.label.toLowerCase()} to ${to.title}`,
          to,
          originPosition,
        );
      }
      // A move named tools may make (ADR 0513): a staff write from inside one of them (a person
      // with the tool's permission called it) may make it too; no other staff write may.
      const tool = write.by === "staff" ? personsTool(write.ctx, o.extension) : null;
      const byTool = tool !== null && (move.tools ?? []).includes(tool);
      // A window that binds staff too (ADR 0507): every staff write, a person's included.
      if (write.by === "staff" && move.bindsStaff && (move.by.includes("staff") || byTool)) {
        await customerRules(
          write,
          reader,
          { window: move.window },
          `Moving ${o.label.toLowerCase()} to ${to.title}`,
          to,
          originPosition,
        );
      }
      return {
        ...base,
        from: originPosition,
        by: byTool ? [...move.by, "staff"] : move.by,
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

/**
 * For each `closed` path read through a relation (`class.closed`), a guard in the write's batch
 * that the related record has made no move since it was read (its state history keeps the number
 * of rows read now). Exported for the waitlist's move in, judged against the same flags.
 */
export async function queueUnmovedGuards(
  ctx: HandlerContext,
  object: ObjectDefinition,
  after: Record<string, unknown>,
  paths: string | readonly string[],
): Promise<void> {
  if (ctx.simulation) return;
  const relations = new Set(
    (typeof paths === "string" ? [paths] : paths)
      .filter((p) => p.includes("."))
      .map((p) => p.split(".")[0] as string),
  );
  for (const relation of relations) {
    const id = after[relation];
    const to = object.fields.find((f) => f.name === relation)?.options?.to;
    if (typeof id !== "string" || !id || !to) continue;
    const row = await ctx.db
      .selectFrom("core_transition_history")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("object_type", "=", to)
      .where("record_id", "=", id)
      .executeTakeFirst();
    ctx.write(guardStatement("unmoved", to, id, Number(row?.n ?? 0)));
  }
}

// --- Windows, staff-only rules and requests (stage 31, ADR 0503) ---------------------------------

/** A move's or a create's customer rules. */
interface RuleSet {
  window?: WindowDefinition | undefined;
  staffOnly?: string | readonly string[] | undefined;
}

/** The record's own fields a rule set reads: each path's first part (a relation, or the field). */
function ruleSources(rules: RuleSet): string[] {
  const paths: string[] = [];
  if (typeof rules.staffOnly === "string") paths.push(rules.staffOnly);
  else if (rules.staffOnly) paths.push(...rules.staffOnly);
  for (const bound of [rules.window?.from, rules.window?.until]) {
    if (bound === undefined) continue;
    if (typeof bound === "string") {
      paths.push(bound);
      continue;
    }
    paths.push(bound.at);
    for (const part of [bound.daysBefore, bound.minutesBefore, bound.zone]) {
      if (typeof part === "string") paths.push(part);
      else if (typeof part === "object" && part.field) paths.push(part.field);
    }
  }
  return [...new Set(paths.map((p) => p.split(".")[0] as string))];
}

/** Why a customer may not make this write now, or null when they may. */
async function customerRefusal(
  ctx: HandlerContext,
  reader: PathReader,
  rules: RuleSet,
  what: string,
): Promise<{
  rule: StateRuleDetails["rule"];
  message: string;
  times: Pick<StateRuleDetails, "opensAt" | "closesAt">;
} | null> {
  if (!rules.window && !rules.staffOnly) return null;
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

/** Whether the write's actor is a person (`human`); a context without one is not. */
function isPerson(ctx: HandlerContext): boolean {
  try {
    return ctx.actor === "human";
  } catch {
    return false;
  }
}

/**
 * Resolves a requested move (`requests`, ADR 0503): when `values` writes a request's name into
 * the state field, returns them with the state the host picks instead, the first of the
 * request's states whose move from where the record is `by` may make now, windows and staff-only
 * rules included. A member asking to "cancel" is cancelled in time or late by the host's clock;
 * so is the AI assistant asking for them (actor `assistant`), while a person on the staff is not
 * bound and gets the first state.
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
    if (!move?.by.includes(by)) continue;
    // A customer, and every staff caller that is not a person (the assistant, an MCP client, an
    // automation, extension code), are resolved by the clock; a person on the staff is not bound
    // (ADR 0507; the assistant alone before it, ADR 0503).
    if (by === "customer" || (by === "staff" && (!isPerson(ctx) || move.bindsStaff))) {
      const refusal = await customerRefusal(
        ctx,
        pathReader(ctx, object, { ...after, [field]: to }),
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

/**
 * The create rules a record made by the host for a caller must still meet (ADR 0560): what it is
 * for is not closed (for everyone), and, unless the caller is staff, the create's window and
 * staff-only rule (as a customer's own create would be judged). `order.startHeld` makes a drop-in
 * booking as the host, in a state only the host may create, so the engine does not judge it as
 * the caller's; this does, with the same code, before anything is written.
 */
export async function assertCreateRules(
  ctx: HandlerContext,
  object: ObjectDefinition,
  after: Record<string, unknown>,
  by: "customer" | "staff",
): Promise<void> {
  const states = object.states;
  if (!states?.create) {
    if (by !== "staff") await assertOnFreeTime(ctx, object, null, null, after);
    return;
  }
  const labelOf = (name: string) => object.fields.find((f) => f.name === name)?.label ?? name;
  const choices = object.fields.find((f) => f.name === states.field)?.options?.choices ?? [];
  const wanted = after[states.field];
  const toId = typeof wanted === "string" && wanted ? wanted : states.initial;
  const state: StateRef = {
    id: toId,
    title: choices.find((c) => c.value === toId)?.label ?? toId,
    final: states.moves.some((m) => m.final && m.to === toId),
  };
  const fail = (
    rule: StateRuleDetails["rule"],
    message: string,
    times: Pick<StateRuleDetails, "opensAt" | "closesAt"> = {},
  ) =>
    new StateRuleError(message, {
      ...ruleBase({ object, labelOf }, rule, [states.field]),
      rule,
      state,
      from: null,
      ...times,
    });
  const reader = pathReader(ctx, object, after);
  if (states.create.closed) {
    if (await staffOnlySet(reader, states.create.closed)) {
      throw fail("state_closed", `${object.label} cannot be made now: what it is for is closed`);
    }
    // As the engine does for every other creator (migration 0670, ADR 0550): what the flag is
    // read through must not move before this batch commits (a class cancelled meanwhile).
    await queueUnmovedGuards(ctx, object, after, states.create.closed);
  }
  if (by === "staff") return;
  const refusal = await customerRefusal(
    ctx,
    reader,
    states.create,
    `Creating ${object.label.toLowerCase()}`,
  );
  if (refusal) throw fail(refusal.rule, refusal.message, refusal.times);
  // A booked shift made for them is on a free time (ADR 0763), as their own create would be.
  await assertOnFreeTime(ctx, object, null, null, { ...after, [states.field]: toId });
}
