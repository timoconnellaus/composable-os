// Publishable with an author (stage 54, ADR 0810): a publishable object that declares a customer,
// the record's author (a review's writer). The fields the author writes (`customer.write`) are
// theirs alone, so what a person publishes is always the author's words: staff, the assistant,
// MCP clients, automations and the extension's own code are refused them on every path that
// writes a record (record.create, record.update, record.createMany, imports, a restored version).
// Staff still publish, unpublish and move the record's states, which are not the author's fields.
// Whose it is (the customer field) is theirs too: set by the seam when the author makes it, and
// moved only by the host (a person merge); staff who could point it at someone else would take a
// review from its author, who could then no longer withdraw it (the review of #367).
//
// The author's own writes come through the visibility seam (a customer's tool, `my.update`), and
// the host's own (platform code writing as the host) are reviewed core code: both pass here.
import { ForbiddenError, ValidationError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { callerOf } from "./transitions.ts";

/**
 * The fields only the author writes: `customer.write` of a publishable object, but its state
 * field, which the author moves (withdrawing) and staff move too; else none.
 */
export function authorFields(object: ObjectDefinition): ReadonlySet<string> {
  if (!object.publishable || !object.customer) return NONE;
  const state = object.states?.field;
  return new Set(object.customer.write.filter((name) => name !== state));
}

/** The fields no one on the staff side writes: the author's, and whose the record is. */
export function staffRefusedFields(object: ObjectDefinition): ReadonlySet<string> {
  if (!object.publishable || !object.customer) return NONE;
  return new Set([...authorFields(object), object.customer.field]);
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Refuses a write of `field` of `object`, one of the author's or whose the record is, unless it
 * is the author's own (a call from outside the org, which the seam holds to the caller's own
 * records and their writable fields) or the host's. Anyone on the staff side
 * is refused, whatever their role, actor or grant.
 */
export function assertAuthorWrite(
  ctx: Pick<HandlerContext, "principal" | "onBehalfOf">,
  object: ObjectDefinition,
  field: string,
  byHost: boolean,
): void {
  if (byHost || !staffRefusedFields(object).has(field)) return;
  if (callerOf(ctx).kind !== "staff") return;
  throw new ForbiddenError(
    field === object.customer?.field
      ? `${object.name}.${field} is whose it is: set when its author makes it, and never changed by staff`
      : `${object.name}.${field} is its author's: only they change it, and staff publish it as written`,
    { field, reason: "author_only" },
  );
}

/**
 * Refuses a change of an author's field of a record in a final state (a withdrawn review): the
 * author writes while the record is open, and what was withdrawn is never written again, by its
 * author either. The host's own writes pass.
 */
export function assertAuthorOpen(
  object: ObjectDefinition,
  before: Record<string, unknown>,
  written: readonly string[],
  byHost: boolean,
): void {
  const field = object.states?.field;
  if (byHost || !field) return;
  const finals = new Set(object.states?.moves.filter((m) => m.final).map((m) => m.to));
  const state = before[field];
  if (typeof state !== "string" || !finals.has(state)) return;
  const authors = authorFields(object);
  const name = written.find((f) => authors.has(f));
  if (name === undefined) return;
  throw new ValidationError(
    `This ${object.label.toLowerCase()} is ${state}: its ${name} is not changed any more`,
    { field: name, reason: "final_state", state },
  );
}
