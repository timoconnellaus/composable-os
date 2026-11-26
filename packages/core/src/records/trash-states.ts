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
//     or other code) who holds the permission of one of those tools, as calling it would ask. A
//     state the host alone leaves (no tool) is never put in the Trash by a record write.
//   - The host's own removals (a series' record no longer in its rule, `trashRecordAsHost`) are
//     not record writes and are not held here. Erase and merge clear and re-point fields; they
//     put no extension record in the Trash.
import { moveOrigins } from "@composable-os/sdk";
import { sql } from "kysely";
import { ForbiddenError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type HandlerContext, personsTool } from "../operation.ts";
import { loadStaffRights, parseGrants } from "../pack-roles.ts";

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

/** Whether the calling person holds the permission one of `tools` of `extension` asks for. */
async function personHoldsOneOf(
  ctx: HandlerContext,
  extension: string,
  tools: readonly string[],
): Promise<boolean> {
  const row = await sql<{ tools: string | null; restricted: string | null }>`
    SELECT json_extract(manifest, '$.tools') AS tools,
      json_extract(manifest, '$.restricted') AS restricted
    FROM core_extensions WHERE id = ${extension} AND status = 'active'
  `
    .execute(ctx.db)
    .then((r) => r.rows[0]);
  if (!row?.tools) return false;
  let declared: Record<string, { permission?: string | string[] }> = {};
  try {
    declared = JSON.parse(row.tools) as typeof declared;
  } catch {
    return false; // A manifest that does not parse opens nothing (fail closed).
  }
  const restricted = new Set(parseGrants(row.restricted));
  const rights = await loadStaffRights(ctx.db, ctx.user.id);
  const grants = new Set([...rights.grants, ...(ctx.permissionGrants ?? [])]);
  for (const tool of tools) {
    const permission = declared[tool]?.permission;
    const permissions = permission === undefined ? [] : [permission].flat();
    for (const p of permissions) {
      if (grants.has(p)) return true;
      // A pack role holds only what its role and grants say; a restricted permission is an
      // admin's and a grant's (ADR 0625); any other pack permission every admin and member holds.
      if (rights.packRole) {
        if (rights.packRole.permissions.includes(p) && !restricted.has(p)) return true;
        continue;
      }
      if (ctx.user.role === "admin") return true;
      if (!restricted.has(p) && ctx.user.role === "member") return true;
    }
  }
  return false;
}

/** Refuses to put a record in the Trash while its state is one only tools or the host may leave. */
export async function assertTrashLeavesState(
  ctx: HandlerContext,
  object: ObjectDefinition,
  state: unknown,
): Promise<void> {
  const tools = guardedStateTools(object, state);
  if (tools === null) return;
  // A customer never makes a move only tools or the host make, so never this one either.
  const forCustomer = ctx.onBehalfOf !== undefined && ctx.onBehalfOf.kind !== "staff";
  if (!forCustomer) {
    const own = personsTool(ctx, object.extension);
    if (own && tools.includes(own)) return;
    if (
      ctx.actor === "human" &&
      tools.length > 0 &&
      object.extension &&
      (await personHoldsOneOf(ctx, object.extension, tools))
    ) {
      return;
    }
  }
  const field = object.states?.field;
  const label =
    object.fields
      .find((f) => f.name === field)
      ?.options?.choices?.find((o) => o.value === state)
      ?.label?.toLowerCase() ?? String(state);
  const what = object.label;
  throw new ForbiddenError(
    tools.length
      ? `${what} is ${label}, a state only ${tools.join(" or ")} moves it out of: only a person who may use ${tools.length > 1 ? "one of them" : "it"} can put it in the Trash. Move it out of ${label} first, or ask such a person.`
      : `${what} is ${label}, a state only the host moves it out of: it cannot be put in the Trash while it is ${label}.`,
    { rule: "state_trash", object: object.name, state, tools: [...tools] },
  );
}
