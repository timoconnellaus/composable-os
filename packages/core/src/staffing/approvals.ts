// Who may approve an AI's roster change (stage 45 step 4, the review of PR #284, the owner's
// decision of 2026-11-24; ADRs 0480, 0625 and 0626). The requester's authority never stands in for the approver's:
// - an AI's call of a restricted pack tool (Rostering's `assign`, `qualify`) is approved only by a
//   person who could call that tool themselves (their role or a grant of it, `staffAuthority`);
// - an AI's write of who works a shift (a class's coach, a duty shift's person, a series' regular
//   person, a coach profile's account), its restore of a shift or series with someone on it from
//   the Trash, or of a version that carries who works it (issue #285), is approved only by a person
//   who rosters, where a pack declares who rosters.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { checklistTemplateFields } from "../checklists/index.ts";
import { ForbiddenError } from "../errors.ts";
import { resolveExtensionOperation } from "../extensions/tools.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { loadStaffRights, staffAuthority } from "../pack-roles.ts";
import { movesStartedShiftById, namesSomeoneById, setsRosterFields } from "./index.ts";
import { isRosterer, rosteringDeclared } from "./rosterers.ts";

type Values = Record<string, unknown>;
const isValues = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a call `operation` with `input` says who works shifts. */
export function touchesRoster(operation: string, input: unknown): boolean {
  if (!isValues(input) || typeof input.object !== "string") return false;
  const object = getObject(input.object);
  if (!object) return false;
  switch (operation) {
    case "record.create":
    case "record.update":
    case "recurring.change":
      return isValues(input.values) && setsRosterFields(object, input.values);
    case "record.createMany":
    case "record.import": {
      const records = Array.isArray(input.records) ? input.records : [];
      return records.some((r) =>
        setsRosterFields(
          object,
          isValues(r) && isValues(r.values) ? r.values : isValues(r) ? r : {},
        ),
      );
    }
    // A holder of a checklist (a duty) put in the Trash or back (ADR 0650, the review of PR #298).
    case "record.delete":
    case "record.restore":
      return checklistTemplateFields(object).length > 0;
    // A published version copied back into the working copy (issue #285): whatever of who works it
    // the object's content carries, as `record.update` would write it.
    case "record.restoreVersion":
      return (
        !!object.publishable &&
        setsRosterFields(
          object,
          Object.fromEntries(object.publishable.content.map((f) => [f, null])),
        )
      );
    case "recurring.follow": {
      const who = object.staffed?.who.field;
      if (!who) return false;
      return !Array.isArray(input.fields) || input.fields.includes(who);
    }
    default:
      return false;
  }
}

/**
 * Whether a call moves a shift that has started (a rosterer's, ADR 0627): `record.update` of a
 * staffed object's times, read against the record as it is.
 */
export async function movesStartedShiftCall(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
  now: string,
): Promise<boolean> {
  if (operation !== "record.update" || !isValues(input) || typeof input.object !== "string") {
    return false;
  }
  const object = getObject(input.object);
  if (!object?.staffed || typeof input.id !== "string" || !isValues(input.values)) return false;
  return movesStartedShiftById(db as never, object, input.id, input.values, now);
}

/**
 * Whether a call restores from the Trash a record that says who works shifts (a shift with its
 * person, a series with its regular person: issue #285), read against the record as it is.
 */
export async function restoresSomeoneCall(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
): Promise<boolean> {
  if (operation !== "record.restore" || !isValues(input) || typeof input.object !== "string") {
    return false;
  }
  const object = getObject(input.object);
  if (!object || typeof input.id !== "string") return false;
  return namesSomeoneById(db as never, object, input.id);
}

/** Whether a call `operation` with `input` is a roster change, for its approval (ADRs 0626, 0627). */
export async function rosterChangeCall(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
  now: string,
): Promise<boolean> {
  return (
    touchesRoster(operation, input) ||
    (await movesStartedShiftCall(db, operation, input, now)) ||
    (await restoresSomeoneCall(db, operation, input))
  );
}

/** Refuses an approval of a roster change by anyone who could not make it themselves. */
export async function assertRosterApprover(
  ctx: HandlerContext,
  db: Kysely<CoreDatabase>,
  targets: readonly { id: string; operation: string; input: string | null }[],
): Promise<void> {
  for (const target of targets) {
    const input = target.input ? (JSON.parse(target.input) as unknown) : {};
    const op = target.operation.startsWith("x.")
      ? await resolveExtensionOperation(db, target.operation)
      : undefined;
    const restricted = op?.packRestricted === true;
    const roster =
      (await rosterChangeCall(db, target.operation, input, ctx.now)) &&
      (await rosteringDeclared(db));
    if (!restricted && !roster) continue;
    if (ctx.actor !== "human") {
      throw new ForbiddenError("A roster change is approved by a person, never by an AI actor", {
        actionId: target.id,
        actor: ctx.actor,
      });
    }
    if (restricted && op) {
      const rights = await loadStaffRights(db, ctx.user.id);
      if (staffAuthority(ctx.user, rights, op, input) === null) {
        throw new ForbiddenError(
          `Approving ${target.operation} needs ${(op.packPermissions ?? []).join(" or ")}: whoever approves must be able to do it themselves`,
          { actionId: target.id, permission: (op.packPermissions ?? []).join(" or ") },
        );
      }
    }
    if (roster && !(await isRosterer(db, ctx.user.id))) {
      throw new ForbiddenError(
        "Approving who works a shift needs someone who rosters: whoever approves must be able to do it themselves",
        { actionId: target.id, rule: "rostering" },
      );
    }
  }
}
