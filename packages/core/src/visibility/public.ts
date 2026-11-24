// The public scope (stage 27, ADR 0438) and the signed-in scope (stage 41, ADR 0447): what an
// object says the public, or every signed-in customer, may read, and the pure rules the seam
// derives from it. Nothing here reads the database.
//
// An object declares them in the same shape:
//   public: { read: ["name", "startsAt"], when: { field: "status", in: ["on_sale"] } }
//   public: { read: ["name", "price"], when: { via: "event", field: "status", in: ["on_sale"] } }
//   signedIn: { read: ["name", "video", "cues"] }
// The public (and a signed-in customer, on an object that declares no customer) sees a record
// only while `when` holds, and of it only the fields in `read`. `signedIn` is the same for
// signed-in customers only, never the public. Nothing is readable by default: an object that
// declares nothing does not exist for them, and a record that does not meet `when` is not found,
// as one that does not exist.
//
// On a publishable object (stage 28, ADR 0442) the public reads only the published version: the
// source is the object's live view (`pub_x_<ext>_<object>`, extensions/schema.ts), whose rows are
// the live records with a current version and whose content columns are that version's values.
// `when`, if declared, holds beside it. A draft, an unpublished record and a deleted one are not
// in the source, so each is not found exactly as a record that never existed. An object with an
// author (ADR 0810) declares a customer too: the author reads their working copy through it, and
// the public (and any other caller who reads as the public, content.list) the published version.
import { liveViewOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition, PublicDeclaration } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";

/** The two read declarations of this shape. */
export type ReadDeclarationKey = "public" | "signedIn";

/** What is wrong with an object's `public` declaration (empty when nothing is). */
export function publicProblems(object: ObjectDefinition): string[] {
  const problems = readProblems(object, "public");
  // A publishable object with an author declares both (ADR 0810): the author reads the working
  // copy, the public the published version.
  if (object.public && object.customer && !object.publishable) {
    problems.unshift("an object declares customer or public, not both");
  }
  if (object.public && object.publishable) problems.push(...contentProblems(object));
  return problems;
}

/**
 * What the public may read of a publishable object (ADR 0442): its address among the fields, when
 * it has one, and nothing computed from the working copy (a formula, a path of a document that is
 * not content). Without a slug its records are listed only (ADR 0810). With an author (a
 * `customer`) it has no slug, the public never reads whose it is nor, but as published, what the
 * author writes; it declares no customerVia.
 */
function contentProblems(object: ObjectDefinition): string[] {
  const declared = object.public;
  const publishable = object.publishable;
  if (!declared || !publishable) return [];
  const problems: string[] = [];
  if (publishable.slug && !declared.read.includes(publishable.slug)) {
    problems.push(`public.read lists the slug "${publishable.slug}": it is how the public reads`);
  }
  const content = new Set(publishable.content);
  for (const name of declared.read) {
    const field = object.fields.find((f) => f.name === name);
    if (field?.fieldType === "formula") {
      problems.push(`public.read lists "${name}", a formula of the working copy`);
    }
    const path = field?.options?.documentPath;
    if (path && !content.has(path.field)) {
      problems.push(`public.read lists "${name}", a path of a document that is not content`);
    }
  }
  if (object.customerVia) {
    problems.push("a publishable object the public reads declares no customerVia");
  }
  if (object.customer) {
    if (publishable.slug) problems.push("a publishable object with an author has no slug");
    if (declared.read.includes(object.customer.field)) {
      problems.push(`public.read lists "${object.customer.field}", the author`);
    }
    // Read from the working copy, a field the author writes would reach the public unapproved.
    for (const name of declared.read) {
      if (object.customer.write.includes(name) && !content.has(name)) {
        problems.push(`public.read lists "${name}", which the author writes and is not content`);
      }
    }
  }
  return problems;
}

/** What is wrong with an object's `signedIn` declaration (empty when nothing is). */
export function signedInProblems(object: ObjectDefinition): string[] {
  const declared = object.signedIn;
  if (!declared) return [];
  const problems = readProblems(object, "signedIn");
  if (object.public) problems.unshift("an object declares public or signedIn, not both");
  if (object.customer) {
    for (const name of declared.read) {
      if (!object.customer.read.includes(name)) {
        problems.push(`signedIn.read lists "${name}", which customer.read does not`);
      }
    }
  }
  return problems;
}

function readProblems(object: ObjectDefinition, key: ReadDeclarationKey): string[] {
  const declared = object[key];
  if (!declared) return [];
  const problems: string[] = [];
  const field = (o: ObjectDefinition, name: string) => o.fields.find((f) => f.name === name);
  if (new Set(declared.read).size !== declared.read.length) {
    problems.push(`${key}.read lists a field twice`);
  }
  for (const name of declared.read) {
    const f = field(object, name);
    if (!f) problems.push(`${key}.read lists "${name}", which is not a field`);
    else if (!viewColumnOf(f)) problems.push(`${key}.read lists "${name}", which has no column`);
  }
  const condition = resolveCondition(object, declared, key);
  if (typeof condition === "string") problems.push(condition);
  return problems;
}

/** The condition `when` names, resolved to view columns, or why it cannot be. */
export interface Condition {
  /** The column of this object tested, or that points to the record tested. */
  readonly column: string;
  readonly values: readonly string[];
  /** With `via`: the pointed-to object's view and its tested column. */
  readonly via?: { readonly source: string; readonly column: string };
}

export function resolveCondition(
  object: ObjectDefinition,
  declared: PublicDeclaration,
  key: ReadDeclarationKey = "public",
): Condition | null | string {
  const { when } = declared;
  if (!when) return null;
  const fieldOf = (o: ObjectDefinition, name: string) => o.fields.find((f) => f.name === name);
  if (when.via === undefined) {
    const own = fieldOf(object, when.field);
    if (!own || own.fieldType !== "select" || !own.column) {
      return `${key}.when.field "${when.field}" must be a select field`;
    }
    return { column: own.column, values: [...when.in] };
  }
  const via = fieldOf(object, when.via);
  const to = via?.options?.to;
  const target = to ? getObject(to) : undefined;
  if (!via || via.fieldType !== "relation" || via.options?.many || !via.column || !target) {
    return `${key}.when.via "${when.via}" must be a relation to one record`;
  }
  const tested = fieldOf(target, when.field);
  if (!tested || tested.fieldType !== "select" || !tested.column) {
    return `${key}.when.field "${when.field}" must be a select field of ${target.name}`;
  }
  return {
    column: via.column,
    values: [...when.in],
    via: { source: target.source, column: tested.column },
  };
}

/** A valid declaration resolved against the object's fields. */
export interface PublicScope {
  readonly kind: "public";
  /** Which declaration it is: the public's, or every signed-in customer's. */
  readonly from: ReadDeclarationKey;
  /** `id` and the readable fields, in the object's order. */
  readonly fields: readonly FieldDefinition[];
  /** The view columns the source has: `id` and the readable fields' columns. */
  readonly columns: readonly string[];
  /** Null: every live record (no `when`). */
  readonly condition: Condition | null;
  readonly declaration: PublicDeclaration;
  /**
   * The view the rows come from: the object's rec_* view, or for the public's scope on a
   * publishable object its live view, the published versions only (ADR 0442).
   */
  readonly source: string;
}

/** The public scope of `object`, or null when it declares none. */
export function publicScope(object: ObjectDefinition): PublicScope | null {
  return readScope(object, "public");
}

/** What every signed-in customer reads of `object` as a read-only scope, or null. */
export function signedInScope(object: ObjectDefinition): PublicScope | null {
  return readScope(object, "signedIn");
}

function readScope(object: ObjectDefinition, key: ReadDeclarationKey): PublicScope | null {
  const declared = object[key];
  if (!declared) return null;
  const problems = key === "public" ? publicProblems(object) : signedInProblems(object);
  // A declaration that does not hold together shows nothing, and says so to whoever built it.
  if (problems.length) {
    throw new Error(`${object.name}: invalid ${key} declaration: ${problems.join("; ")}`);
  }
  const readable = new Set(["id", ...declared.read]);
  const fields = object.fields.filter((f) => readable.has(f.name));
  const columns = [...new Set(fields.map((f) => viewColumnOf(f) as string))];
  return {
    kind: "public",
    from: key,
    fields,
    columns,
    condition: resolveCondition(object, declared, key) as Condition | null,
    declaration: declared,
    source: key === "public" && object.publishable ? liveViewOf(object.name) : object.source,
  };
}

/**
 * The object as the public sees it: only `id` and the readable fields, so a filter, a sort or a
 * field selection on anything else fails exactly as it does for a field that does not exist.
 */
export function publicObject(object: ObjectDefinition, scope: PublicScope): ObjectDefinition {
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
    ...(scope.from === "public" ? { public: scope.declaration } : { signedIn: scope.declaration }),
  };
}
