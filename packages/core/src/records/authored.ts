// Publishable with an author (stage 54, ADR 0810): a publishable object that declares a customer,
// the record's author (a review's writer). The fields the author writes (`customer.write`) are
// theirs alone, so what a person publishes is always the author's words: staff, the assistant,
// MCP clients, automations and the extension's own code are refused them on every path that
// writes a record (record.create, record.update, record.createMany, imports, a restored version).
// Staff still publish, unpublish and move the record's states, which are not the author's fields.
//
// The author's own writes come through the visibility seam (a customer's tool, `my.update`), and
// the host's own (platform code writing as the host) are reviewed core code: both pass here.
import { ForbiddenError } from "../errors.ts";
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

const NONE: ReadonlySet<string> = new Set();

/**
 * Refuses a write of `field` of `object` unless it is the author's own (a call from outside the
 * org, which the seam holds to the caller's own records) or the host's. Anyone on the staff side
 * is refused, whatever their role, actor or grant.
 */
export function assertAuthorWrite(
  ctx: Pick<HandlerContext, "principal" | "onBehalfOf">,
  object: ObjectDefinition,
  field: string,
  byHost: boolean,
): void {
  if (byHost || !authorFields(object).has(field)) return;
  if (callerOf(ctx).kind !== "staff") return;
  throw new ForbiddenError(
    `${object.name}.${field} is its author's: only they change it, and staff publish it as written`,
    { field, reason: "author_only" },
  );
}
