// Declared uniqueness (stage 31, ADR 0502): an object says that among its live records in some
// states, no two share the values of some fields (one active booking per Person per class). The
// host refuses the second in the database, for every actor, however many write at once.
import { z } from "zod";
import type { ExtensionManifest, ObjectManifest } from "./manifest.ts";

/**
 * One uniqueness rule: no two live records with the same values of `fields` (one to four
 * single-valued fields of this object; a record with any of them empty is not counted) while
 * their state (the object's `states` field) is one of `states`. Left without `states`, every
 * live record counts. The database refuses a second record, or a move back into a counted state,
 * as a conflict (`rule: "unique"`).
 *
 * `fold: true` (stage 59, ADR 0864) makes the rule ignore case and outer spaces: the host keeps
 * the rule's text fields folded on every write, whoever writes (a form, the assistant, MCP, the
 * import): white space trimmed from both ends and the letters in upper case (`foldUniqueText`).
 * So `tm-03 ` and `TM-03` are one value, the code on a sticker. Every field of a folded rule is a
 * `text` field.
 */
export interface UniqueSpec {
  fields: readonly string[];
  states?: readonly string[];
  fold?: boolean;
}

/** A text value of a folded uniqueness rule as the host keeps it (ADR 0864). */
export function foldUniqueText(value: string): string {
  // Invisible format characters (a zero-width space, a joiner, a byte order mark) are no part of
  // a code anyone reads: `TM-03` and `TM-03` followed by a zero-width space are one tag.
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .toUpperCase();
}

export const uniqueManifestSchema = z
  .array(
    z
      .object({
        fields: z.array(z.string().max(40)).min(1).max(4),
        states: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
        fold: z.boolean().optional(),
      })
      .strict(),
  )
  .min(1)
  .max(4);
export type UniqueManifest = z.infer<typeof uniqueManifestSchema>;

const UNIQUE_TYPES = new Set([
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "select",
  "relation",
  "user",
  "email",
  "phone",
  "url",
  "slug",
  "timezone",
]);

/** Reports problems with `objects.<name>.unique` through `contract`. */
export function checkObjectUnique(
  _m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  (object.unique ?? []).forEach((rule, i) => {
    const path = `objects.${name}.unique.${i}`;
    if (new Set(rule.fields).size !== rule.fields.length) {
      contract(`${path}.fields`, "List each field once");
    }
    for (const local of rule.fields) {
      const field = Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
      if (!field || field.many || !UNIQUE_TYPES.has(field.type)) {
        contract(`${path}.fields`, `"${local}" must be a single-valued, stored field of ${name}`);
      } else if (rule.fold && field.type !== "text") {
        contract(
          `${path}.fold`,
          `"${local}" is a ${field.type} field: a rule that folds case and spaces names text fields only`,
        );
      }
    }
    if (rule.states) {
      const states = object.states;
      if (!states) {
        contract(`${path}.states`, `${name} has no states`);
        return;
      }
      const field = Object.hasOwn(object.fields, states.field)
        ? object.fields[states.field]
        : undefined;
      const values = new Set((field?.options ?? []).map((o) => o.value));
      for (const state of rule.states) {
        if (!values.has(state)) contract(`${path}.states`, `"${state}" is not a state of ${name}`);
      }
    }
  });
}
