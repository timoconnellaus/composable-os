// A record in a state only tools or the host may leave stays out of the Trash (stage 59, ADR
// 0863). Putting a record in the Trash takes it out of its lifecycle as surely as a move does: an
// item out of service that anyone could Trash (and make again, in service, with the same tag) is
// one only a manager could put back by a move. So the Trash is held to the same hands as the moves
// out of the state:
//
//   - A state is **guarded** when it is not final, some move leaves it, and every move leaving it
//     is made by the host alone (`by: ["host"]`, with or without `tools`, ADR 0513). A state staff
//     or a customer may leave by a record write is not guarded, nor a final one.
//   - A record in a guarded state is put in the Trash by a record write only from inside one of the
//     tools that make a move out of it (`personsTool`: a person's act, called by one or approved by
//     one), or by a person (the `human` actor, never the assistant, an MCP client, an automation
//     or other code) who could call one of those tools (`personMayCall`, the pipeline's own check).
//     A state the host alone leaves (no tool) is never put in the Trash by a record write.
//   - A record in a guarded state may **hold** the record a relation of it points to
//     (`states.holds`, ADR 0863 amended): that record is then put in the Trash only by whoever may
//     put the holding one there. An open fault holds its item.
//   - The Trash write is tied to the state it was judged in: the batch fails (`conflict`) if the
//     record moved after it was read (the `unmoved` guard, migration 0670).
//   - The host's own removals (a series' record no longer in its rule, `trashRecordAsHost`) are
//     not record writes and are not held here. Erase and merge clear and re-point fields; they
//     put no extension record in the Trash.
import { moveOrigins } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { ForbiddenError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type HandlerContext, personsTool } from "../operation.ts";
import { loadStaffRights, personMayCall } from "../pack-roles.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";

/**
 * The tools that make a move out of `state` when it is guarded (an empty list when only the host
 * leaves it), or null when the state is not guarded and the Trash is open as before.
 */
export function guardedStateTools(
  object: Pick<ObjectDefinition, "states">,
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

/** Every guarded state of the object (those `guardedStateTools` answers a list for). */
export function guardedStates(object: Pick<ObjectDefinition, "states" | "fields">): string[] {
  const states = object.states;
  if (!states) return [];
  const values = new Set<string>([states.initial]);
  for (const move of states.moves) {
    values.add(move.to);
    for (const from of moveOrigins(move)) values.add(from);
  }
  return [...values].filter((state) => guardedStateTools(object, state) !== null);
}

/**
 * Whether the call may take a record of `object` out of a guarded state whose leaving tools are
 * `tools`: from inside one of them, or a person who could call one of them, as the pipeline would
 * judge that call (the tool's audience, actors, pack role, grants and restriction).
 */
async function mayLeave(
  ctx: HandlerContext,
  object: ObjectDefinition,
  tools: readonly string[],
): Promise<boolean> {
  // A customer never makes a move only tools or the host make, so never this one either.
  if (ctx.onBehalfOf !== undefined && ctx.onBehalfOf.kind !== "staff") return false;
  const own = personsTool(ctx, object.extension);
  if (own && tools.includes(own)) return true;
  if (ctx.actor !== "human" || !tools.length || !object.extension) return false;
  // Read late: the tool operations are built from the installed manifests (extensions/tools.ts),
  // whose module imports the record code this rule is part of.
  const { resolveExtensionOperation } = await import("../extensions/tools.ts");
  const rights = await loadStaffRights(ctx.db, ctx.user.id);
  for (const tool of tools) {
    const op = await resolveExtensionOperation(ctx.db, `x.${object.extension}.${tool}`);
    if (op && personMayCall(op, ctx.user, rights)) return true;
  }
  return false;
}

function stateLabel(object: ObjectDefinition, state: unknown): string {
  const field = object.states?.field;
  return (
    object.fields
      .find((f) => f.name === field)
      ?.options?.choices?.find((o) => o.value === state)
      ?.label?.toLowerCase() ?? String(state)
  );
}

function refusal(object: ObjectDefinition, state: unknown, tools: readonly string[]) {
  const label = stateLabel(object, state);
  return tools.length
    ? `${object.label} is ${label}, a state only ${tools.join(" or ")} moves it out of: only a person who may use ${tools.length > 1 ? "one of them" : "it"} can put it in the Trash. Move it out of ${label} first, or ask such a person.`
    : `${object.label} is ${label}, a state only the host moves it out of: it cannot be put in the Trash while it is ${label}.`;
}

/**
 * Refuses to put a record in the Trash while its state is one only tools or the host may leave,
 * or while a record holding it (`states.holds`) is in such a state, unless the caller may take
 * that record out of it; and ties the Trash to the state it was judged in.
 */
export async function assertTrashLeavesState(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  state: unknown,
): Promise<void> {
  const tools = guardedStateTools(object, state);
  if (tools !== null && !(await mayLeave(ctx, object, tools))) {
    throw new ForbiddenError(refusal(object, state, tools), {
      rule: "state_trash",
      object: object.name,
      state,
      tools: [...tools],
    });
  }
  // A record held by another in a guarded state (an item its open faults hold).
  for (const holder of listObjects()) {
    const relation = holder.states?.holds;
    const field = relation ? holder.fields.find((f) => f.name === relation) : undefined;
    if (!relation || !field?.column || field.options?.to !== object.name) continue;
    const stateField = holder.fields.find((f) => f.name === holder.states?.field);
    const guarded = guardedStates(holder);
    if (!stateField?.column || !guarded.length) continue;
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    const found = (await (ctx.db as Kysely<any>)
      .selectFrom(visibleSource(orgReader(ctx.db), holder))
      .select(["id", `${stateField.column} as state`])
      .where(field.column, "=", id)
      .where(stateField.column, "in", guarded)
      .limit(1)
      .executeTakeFirst()) as { id: string; state: string } | undefined;
    if (!found) continue;
    const leaving = guardedStateTools(holder, found.state) ?? [];
    if (await mayLeave(ctx, holder, leaving)) continue;
    throw new ForbiddenError(
      `${object.label} has a ${holder.label.toLowerCase()} that is ${stateLabel(holder, found.state)}: only a person who may use ${leaving.join(" or ") || "the host's moves"} can put it in the Trash. Close the ${holder.label.toLowerCase()} first, or ask such a person.`,
      {
        rule: "state_trash",
        reason: "held",
        object: object.name,
        heldBy: holder.name,
        record: found.id,
        tools: [...leaving],
      },
    );
  }
  // Judged in the state it was read in: a move landing before the commit fails the batch.
  if (object.states) {
    const row = await ctx.db
      .selectFrom("core_transition_history")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("object_type", "=", object.name)
      .where("record_id", "=", id)
      .executeTakeFirst();
    ctx.write(guardStatement("unmoved", object.name, id, Number(row?.n ?? 0)));
  }
}
