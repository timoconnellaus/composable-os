// Writes at the visibility seam (ADR 0402, ADR 0412). A caller outside the org changes a record
// only when the seam would show it to them, and only in the fields its object lists as writable.
// The pipeline runs this on every change a customer's or the public's call recorded, before
// anything is committed, so an operation's handler never checks whose record it is.
import { diffRecords } from "../diff.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { RecordChange } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { unknownObject } from "./customer.ts";
import { type AnyRow, type Reader, type Scope, scopeOf, visibleSource } from "./index.ts";

/** Fields the host sets on a new record. A create may carry them; no one chooses them. */
const SET_BY_HOST = new Set(["id", "createdAt", "updatedAt", "createdBy"]);

/**
 * Refuses `changes` unless the caller may make every one of them. Staff may (their permissions
 * and the gate decide). For a customer, each change must be a create or an update of a record
 * whose customer is the caller's own Person, touching only writable fields; the customer field is
 * set on create to the caller and never changed after. The public change nothing.
 *
 * A record the caller may not see is reported as a record that is not there, and a field they
 * may not write as a field that does not exist.
 */
export async function assertVisibleWrites(
  ctx: Reader,
  changes: readonly RecordChange[],
): Promise<void> {
  if (ctx.principal.kind === "staff" || !changes.length) return;
  if (ctx.principal.kind !== "customer") {
    throw new ForbiddenError("This call cannot change records");
  }
  const personId = ctx.principal.personId;
  const existing = new Map<string, string[]>();
  for (const change of changes) {
    const object = getObject(change.object);
    if (!object) throw unknownObject(change.object);
    const scope: Scope = scopeOf(ctx.principal, object);
    if (scope.kind !== "customer") throw unknownObject(change.object);
    if (change.action !== "create" && change.action !== "update") {
      throw new ForbiddenError(`A customer cannot ${change.action} a ${object.name}`);
    }
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const owner = scope.declaration.field;
    for (const [name, values] of Object.entries(diff)) {
      if (name === owner) {
        // Whose record it is: the caller's on create, and never changed after.
        if (change.action !== "create") throw new NotFoundError(object.name, change.id);
        if (values.after !== personId) {
          throw new ValidationError(`A new ${object.name} must belong to its caller`);
        }
        continue;
      }
      if (scope.writable.has(name)) continue;
      if (change.action === "create" && SET_BY_HOST.has(name)) continue;
      // A field they can read but not write is named. Any other is a field that does not exist.
      if (scope.fields.some((field) => field.name === name)) {
        throw new ValidationError(`${object.name}.${name} cannot be changed`, { field: name });
      }
      throw new ValidationError(`Unknown field "${name}" on ${object.name}`, { field: name });
    }
    if (change.action === "create") {
      if (owner !== "id" && diff[owner]?.after !== personId) {
        throw new ValidationError(`A new ${object.name} must belong to its caller`);
      }
      // A person is their own customer: a customer never creates one.
      if (owner === "id") throw new ForbiddenError(`A customer cannot create a ${object.name}`);
    } else {
      existing.set(object.name, [...(existing.get(object.name) ?? []), change.id]);
    }
  }
  // Every record changed must be one the caller can see: one read per object, through door 1.
  for (const [name, ids] of existing) {
    const object = getObject(name);
    if (!object) throw unknownObject(name);
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (ctx.db as any)
      .selectFrom(visibleSource(ctx, object))
      .select("id")
      .where("id", "in", jsonList([...new Set(ids)]))
      .execute()) as AnyRow[];
    const mine = new Set(rows.map((row) => String(row.id)));
    const missing = ids.find((id) => !mine.has(id));
    if (missing) throw new NotFoundError(name, missing);
  }
}
