// What a customer reads of a record their own record points to (stage 27 follow-up, ADR 0439),
// and the pure rules the seam derives from it. Nothing here reads the database.
//
// An object declares it:
//   customerVia: { from: "ticketing.ticket", field: "event", read: ["name", "startsAt", "venue"] }
// A signed-in customer then sees a record of the object only while one of their own records of
// `from` (an object that declares a customer, whose customer field is the caller's Person) points
// to it through `field`, and of it only the fields in `read`. A ticket's holder reads its event's
// name and date whatever state the event is in: ended, or no longer on sale. Nothing by default:
// an object that declares nothing is read this way by no one.
//
// An object may also declare `public` or `signedIn` (ADR 0447). A customer then reads both: the fields in `read` of the
// records their own records point to, and that declaration's fields of the records it covers. A column
// that only one of the two lists is shown only on the records that one covers.
import { getObject } from "../fields/index.ts";
import type { CustomerViaDeclaration, FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type PublicScope, publicScope, signedInScope } from "./public.ts";

/** What is wrong with an object's `customerVia` declaration (empty when nothing is). */
export function customerViaProblems(object: ObjectDefinition): string[] {
  const declared = object.customerVia;
  if (!declared) return [];
  const problems: string[] = [];
  if (object.customer) {
    problems.push("an object that declares a customer cannot also declare customerVia");
  }
  if (new Set(declared.read).size !== declared.read.length) {
    problems.push("customerVia.read lists a field twice");
  }
  for (const name of declared.read) {
    const f = object.fields.find((field) => field.name === name);
    if (!f) problems.push(`customerVia.read lists "${name}", which is not a field`);
    else if (!viewColumnOf(f)) {
      problems.push(`customerVia.read lists "${name}", which has no column`);
    }
  }
  const link = resolveLink(object, declared);
  if (typeof link === "string") problems.push(link);
  return problems;
}

/** How the caller's own records point here: the `from` view, its pointer and its owner column. */
interface Link {
  readonly source: string;
  readonly pointer: string;
  readonly owner: string;
}

function resolveLink(object: ObjectDefinition, declared: CustomerViaDeclaration): Link | string {
  const from = getObject(declared.from);
  if (!from || from.name === object.name || !object.extension) {
    return `customerVia.from "${declared.from}" must be another object of the same extension`;
  }
  if (from.extension !== object.extension) {
    return `customerVia.from "${declared.from}" must be an object of the same extension`;
  }
  const owner = from.customer
    ? from.fields.find((field) => field.name === from.customer?.field)
    : undefined;
  if (!from.customer || !owner?.column) {
    return `customerVia.from "${declared.from}" must declare a customer`;
  }
  const pointer = from.fields.find((field) => field.name === declared.field);
  if (
    !pointer?.column ||
    pointer.fieldType !== "relation" ||
    pointer.options?.many ||
    pointer.options?.to !== object.name
  ) {
    return `customerVia.field "${declared.field}" must be a relation of ${from.name} to one ${object.name}`;
  }
  if (!from.customer.read.includes(declared.field)) {
    return `customerVia.field "${declared.field}" must be one the customer of ${from.name} may read`;
  }
  return { source: from.source, pointer: pointer.column, owner: owner.column };
}

/** Which records a column of the source shows its value on. */
export type ShownOn = "both" | "reached" | "public";

/** A valid declaration resolved against the object's fields, for one customer. */
export interface ViaScope {
  readonly kind: "via";
  readonly personId: string;
  /** `id` and every field the customer may read here, in the object's order. */
  readonly fields: readonly FieldDefinition[];
  /** The source's columns, each with the records it shows its value on. */
  readonly columns: readonly { readonly column: string; readonly shownOn: ShownOn }[];
  /** How the caller's own records point here. */
  readonly link: Link;
  /** What every signed-in customer or the public may read of the object too, when declared. */
  readonly public: PublicScope | null;
  readonly declaration: CustomerViaDeclaration;
}

/** The scope `customerVia` gives `personId` on `object`, or null when it declares none. */
export function customerViaScope(object: ObjectDefinition, personId: string): ViaScope | null {
  const declared = object.customerVia;
  if (!declared) return null;
  const problems = customerViaProblems(object);
  // A declaration that does not hold together shows nothing, and says so to whoever built it.
  if (problems.length) {
    throw new Error(`${object.name}: invalid customerVia declaration: ${problems.join("; ")}`);
  }
  // What every signed-in customer (ADR 0447) or the public may read of it: one or the other.
  const shared = signedInScope(object) ?? publicScope(object);
  const reached = new Set(["id", ...declared.read]);
  const open = new Set(shared ? ["id", ...shared.declaration.read] : []);
  const fields = object.fields.filter((f) => reached.has(f.name) || open.has(f.name));
  const columns = new Map<string, ShownOn>();
  for (const field of fields) {
    const column = viewColumnOf(field) as string;
    const shownOn: ShownOn =
      !shared || (reached.has(field.name) && open.has(field.name))
        ? "both"
        : reached.has(field.name)
          ? "reached"
          : "public";
    const before = columns.get(column);
    columns.set(column, before && before !== shownOn ? "both" : shownOn);
  }
  return {
    kind: "via",
    personId,
    fields,
    columns: [...columns].map(([column, shownOn]) => ({ column, shownOn })),
    link: resolveLink(object, declared) as Link,
    public: shared,
    declaration: declared,
  };
}

/**
 * The object as the customer sees it here: only `id` and the readable fields, so a filter, a
 * sort or a field selection on anything else fails exactly as it does for a field that does not
 * exist.
 */
export function viaObject(object: ObjectDefinition, scope: ViaScope): ObjectDefinition {
  const names = new Set(scope.fields.map((f) => f.name));
  const sort = names.has(object.defaultSort.field)
    ? object.defaultSort
    : ({ field: "id", direction: "asc" } as const);
  return {
    name: object.name,
    label: object.label,
    source: object.source,
    fields: scope.fields,
    defaultSort: sort,
    ...(object.plural ? { plural: object.plural } : {}),
    ...(object.extension ? { extension: object.extension } : {}),
    ...(object.titleField && names.has(object.titleField) ? { titleField: object.titleField } : {}),
    customerVia: scope.declaration,
  };
}
