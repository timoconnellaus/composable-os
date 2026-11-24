// The customer scope (ADR 0402, ADR 0412): what an object says its customer may see, and the
// pure rules the seam derives from it. Nothing here reads the database.
//
// An object declares its customer:
//   customer: { field: "buyer", read: ["status", "total"], write: [] }
// `field` is the relation that says whose record it is (`id` on a Person, who is their own
// customer). A customer sees a record only when that field is their own Person, and of it only
// the fields in `read`. Nothing is visible by default: an object that declares no customer does
// not exist for a customer.
import { ValidationError } from "../errors.ts";
import type { CustomerDeclaration, FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { guardianProblems } from "./guardians.ts";
import { type Condition, resolveCondition, signedInProblems } from "./public.ts";

/** What is wrong with an object's `customer` declaration (empty when nothing is). */
export function customerProblems(object: ObjectDefinition): string[] {
  const declared = object.customer;
  if (!declared) return [];
  const problems: string[] = [];
  const field = (name: string) => object.fields.find((f) => f.name === name);
  // A restricted field (ADR 0811) is no registry field: its author reads and writes it apart.
  const restricted = new Set((object.restricted ?? []).map((f) => f.name));
  const owner = field(declared.field);
  if (!owner?.column) {
    problems.push(`customer.field "${declared.field}" is not a single-valued field`);
  } else if (object.name === "person") {
    if (declared.field !== "id")
      problems.push("a person is their own customer: customer.field is id");
  } else if (
    owner.fieldType !== "relation" ||
    owner.options?.to !== "person" ||
    owner.options.many
  ) {
    problems.push(`customer.field "${declared.field}" must be a relation to one person`);
  }
  for (const [key, names] of [
    ["read", declared.read],
    ["write", declared.write],
  ] as const) {
    if (new Set(names).size !== names.length) problems.push(`customer.${key} lists a field twice`);
    for (const name of names) {
      if (restricted.has(name)) continue;
      const f = field(name);
      if (!f) problems.push(`customer.${key} lists "${name}", which is not a field`);
      else if (!viewColumnOf(f))
        problems.push(`customer.${key} lists "${name}", which has no column`);
    }
  }
  for (const name of declared.write) {
    if (name === declared.field) {
      problems.push("customer.write may not list the customer field: it is always the caller");
    }
    if (name === "id") problems.push("customer.write may not list id");
    if (field(name)?.readOnly) problems.push(`customer.write lists "${name}", which is read-only`);
    if (!declared.read.includes(name)) {
      problems.push(`customer.write lists "${name}", which customer.read does not`);
    }
  }
  problems.push(...guardianProblems(object));
  return problems;
}

/** A valid declaration resolved against the object's fields. */
export interface CustomerScope {
  readonly kind: "customer";
  readonly personId: string;
  /** The view column that holds the customer's Person id. */
  readonly column: string;
  /** `id` and the readable fields, in the object's order. */
  readonly fields: readonly FieldDefinition[];
  /** The view columns a customer's source has: `id` and the readable fields' columns. */
  readonly columns: readonly string[];
  /** Names of the fields the customer may set. */
  readonly writable: ReadonlySet<string>;
  readonly declaration: CustomerDeclaration;
  /**
   * The family link (ADR 0540): the caller's records include a live dependant's (the object's
   * `guardians`), and of those they change only what `dependantsWrite` allows.
   */
  readonly dependants: boolean;
  readonly dependantsWrite: boolean;
  /**
   * Records every signed-in customer reads beside their own (the object's `signedIn`, ADR
   * 0447): the condition they meet (null: every live record) and the view columns shown of
   * them, a subset of `columns`. Read only: a customer writes their own records alone.
   */
  readonly shared?: { readonly condition: Condition | null; readonly columns: ReadonlySet<string> };
}

/** The customer scope of `object` for `personId`, or null when the object declares none. */
export function customerScope(object: ObjectDefinition, personId: string): CustomerScope | null {
  const declared = object.customer;
  if (!declared) return null;
  const problems = customerProblems(object);
  // A declaration that does not hold together shows nothing, and says so to whoever built it.
  if (problems.length) {
    throw new Error(`${object.name}: invalid customer declaration: ${problems.join("; ")}`);
  }
  const owner = object.fields.find((f) => f.name === declared.field) as FieldDefinition;
  const readable = new Set(["id", ...declared.read]);
  const fields = object.fields.filter((f) => readable.has(f.name));
  const columns = [...new Set(fields.map((f) => viewColumnOf(f) as string))];
  const shared = sharedPart(object);
  return {
    kind: "customer",
    personId,
    column: owner.column as string,
    fields,
    columns,
    writable: new Set(declared.write),
    declaration: declared,
    dependants: declared.guardians !== undefined,
    dependantsWrite: declared.guardians?.write === true,
    ...(shared ? { shared } : {}),
  };
}

/** The records of a customer object shared with every signed-in customer, if it declares any. */
function sharedPart(object: ObjectDefinition): CustomerScope["shared"] {
  const declared = object.signedIn;
  if (!declared) return undefined;
  const problems = signedInProblems(object);
  if (problems.length) {
    throw new Error(`${object.name}: invalid signedIn declaration: ${problems.join("; ")}`);
  }
  const readable = new Set(["id", ...declared.read]);
  const columns = new Set(
    object.fields.filter((f) => readable.has(f.name)).map((f) => viewColumnOf(f) as string),
  );
  return {
    condition: resolveCondition(object, declared, "signedIn") as Condition | null,
    columns,
  };
}

/**
 * The object as a customer sees it: only `id` and the readable fields, so a filter, a sort or a
 * field selection on anything else fails exactly as it does for a field that does not exist.
 * Staff-only metadata (owner, stages, timeline links) is dropped.
 */
export function customerObject(object: ObjectDefinition, scope: CustomerScope): ObjectDefinition {
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
    customer: scope.declaration,
  };
}

/** The one answer for an object a caller may not see: the answer an unknown object gets. */
export function unknownObject(name: string): ValidationError {
  return new ValidationError(`Unknown object "${name}"`, { object: name });
}
