// Restricted fields (stage 54 step 2, ADR 0811): a text field only people with a named grant
// read. `restricted: "<pack>:<word>"` names one of the pack's restricted permissions (ADR 0625).
// The host keeps the value in a core table of its own (core_restricted_value, migration 1190),
// never in the object's x_* table, so it is in no rec_* view, search entry, export, dashboard,
// embedding, summary or audit row. The record's customer writes it and reads their own; staff
// read it only through one of the pack's tools that names the permission, a person only, every
// read audited (`record.readRestricted`). Its contract checks live here; the host's side is
// packages/core/src/records/restricted.ts.
import type { ExtensionManifest, FieldManifest } from "./manifest.ts";

/** The field types a restricted field may have: words a person writes. */
export const RESTRICTED_FIELD_TYPES = ["text", "longText"] as const;

/** The most characters a restricted value holds (the store's own check, migration 1190). */
export const RESTRICTED_MAX_CHARS = 4000;

/** Whether `field` is declared restricted. */
export function isRestrictedField(field: Pick<FieldManifest, "restricted">): boolean {
  return typeof field.restricted === "string";
}

/**
 * Reports problems with restricted fields through `contract`: each is a text field of one of the
 * pack's own objects, which declares a customer who reads and writes it; it names one of the
 * pack's restricted permissions; nothing else of the object names it (its title, an index, a
 * uniqueness rule, what the public or every signed-in customer reads, a version's content, a
 * seed); and it is on no other object.
 */
export function checkRestrictedFields(
  m: ExtensionManifest,
  contract: (path: string, message: string) => void,
): void {
  const restricted = new Set(m.restricted ?? []);
  for (const [target, fields] of Object.entries(m.fields)) {
    for (const [name, field] of Object.entries(fields)) {
      if (isRestrictedField(field)) {
        contract(
          `fields.${target}.${name}.restricted`,
          "A restricted field is a field of one of this extension's own objects, never one added to another object",
        );
      }
    }
  }
  for (const [objectName, object] of Object.entries(m.objects)) {
    const names = Object.entries(object.fields)
      .filter(([, field]) => isRestrictedField(field))
      .map(([name]) => name);
    if (!names.length) continue;
    const path = `objects.${objectName}`;
    for (const name of names) {
      const field = object.fields[name] as FieldManifest;
      const at = `${path}.fields.${name}`;
      if (!(RESTRICTED_FIELD_TYPES as readonly string[]).includes(field.type)) {
        contract(`${at}.type`, "A restricted field is a text or longText field");
      }
      if (!restricted.has(field.restricted as string)) {
        contract(
          `${at}.restricted`,
          `"${field.restricted}" must be one of this extension's restricted permissions (restricted)`,
        );
      }
      for (const key of [
        "required",
        "readOnly",
        "default",
        "defaultSetting",
        "track",
        "personApproves",
        "renamedFrom",
      ] as const) {
        if (field[key] !== undefined) {
          contract(
            `${at}.${key}`,
            `A restricted field takes no ${key}: its author writes it, and nothing else sees it`,
          );
        }
      }
      const customer = object.customer;
      if (!customer) {
        contract(
          `${at}.restricted`,
          "A restricted field is on an object that declares a customer: its author writes it",
        );
      } else {
        if (customer.field === name) {
          contract(`${at}.restricted`, "The customer field cannot be restricted");
        }
        if (!customer.write.includes(name) || !customer.read.includes(name)) {
          contract(
            `${at}.restricted`,
            "A restricted field is one the customer reads and writes (customer.read and customer.write)",
          );
        }
      }
    }
    const named = (where: string, list: readonly string[] | undefined) => {
      for (const name of names) {
        if (list?.includes(name)) {
          contract(
            `${path}.${where}`,
            `"${name}" is restricted: it is kept out of every list, view and read but its own`,
          );
        }
      }
    };
    named("titleField", [object.titleField]);
    object.indexes?.forEach((index, i) => {
      named(`indexes.${i}`, index);
    });
    object.unique?.forEach((rule, i) => {
      named(`unique.${i}.fields`, rule.fields);
    });
    object.requireOneOf?.forEach((group, i) => {
      named(`requireOneOf.${i}`, group);
    });
    named("public.read", object.public?.read);
    named("signedIn.read", object.signedIn?.read);
    named("customerVia.read", object.customerVia?.read);
    named("publishable.content", object.publishable?.content);
    for (const [fieldName, field] of Object.entries(object.fields)) {
      for (const option of field.options ?? []) {
        named(`fields.${fieldName}.options`, option.requires);
      }
    }
    for (const [key, values] of Object.entries(object.seed ?? {})) {
      named(`seed.${key}`, Object.keys(values));
    }
  }
}
