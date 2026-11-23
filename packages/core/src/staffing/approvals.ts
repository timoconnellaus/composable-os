// Who may approve an AI's roster change (stage 45 step 4, the review of PR #284; ADRs 0480,
// 0625 and 0626). The requester's authority never stands in for the approver's:
// - an AI's call of a restricted pack tool (Rostering's `assign`, `qualify`) is approved only by a
//   person who could call that tool themselves (their role or a grant of it, `staffAuthority`);
// - an AI's write of who works a shift (a class's coach, a duty shift's person, a series' regular
//   person, a coach profile's account) is approved only by a person who rosters, where a pack
//   declares who rosters.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ForbiddenError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { resolveExtensionOperation } from "../extensions/tools.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { loadStaffRights, staffAuthority } from "../pack-roles.ts";
import { movesStartedShiftById, setsRosterFields } from "./index.ts";
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
 * Whether a call cancels, trashes or removes a record whose checklist has opened (a rosterer's,
 * ADR 0650): `record.update` moving it out of its live states, or `record.delete`, once it has
 * started. Read against the record as it is.
 */
export async function endsStartedChecklistCall(
  db: Kysely<CoreDatabase>,
  operation: string,
  input: unknown,
  now: string,
): Promise<boolean> {
  if (operation !== "record.update" && operation !== "record.delete") return false;
  if (!isValues(input) || typeof input.object !== "string" || typeof input.id !== "string") {
    return false;
  }
  const object = getObject(input.object);
  const def = object?.checklists;
  const table = object ? objectTableOf(object.name) : undefined;
  const column = (f: string | undefined) => object?.fields.find((x) => x.name === f)?.column;
  const opensCol = column(def?.opens);
  const stateCol = column(object?.states?.field);
  if (!object || !def || !table || !opensCol || !stateCol) return false;
  if (operation === "record.update") {
    const values = isValues(input.values) ? input.values : {};
    const field = object.states?.field ?? "";
    if (!Object.hasOwn(values, field) || def.live.includes(String(values[field]))) return false;
  }
  const row = (await (db as unknown as Kysely<Record<string, Record<string, unknown>>>)
    .selectFrom(table)
    .select([`${opensCol} as opens`, `${stateCol} as state`])
    .where("id", "=", input.id)
    .executeTakeFirst()) as { opens?: unknown; state?: unknown } | undefined;
  const opens = Date.parse(String(row?.opens ?? ""));
  return (
    def.live.includes(String(row?.state ?? "")) &&
    Number.isFinite(opens) &&
    opens <= Date.parse(now)
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
      (touchesRoster(target.operation, input) ||
        (await movesStartedShiftCall(db, target.operation, input, ctx.now)) ||
        (await endsStartedChecklistCall(db, target.operation, input, ctx.now))) &&
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
