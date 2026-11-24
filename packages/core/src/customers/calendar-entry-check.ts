// A calendar entry's paths against what is installed (stage 62 step 1, ADR 0891). The SDK checks a
// path as far as the declaring extension's own objects go; a path that reaches another extension's
// object (a booking's class type, in Programs) is checked here, against the registry, by the same
// walker and the same rule: every field on the way is one the customer reads.
import {
  CALENDAR_PATH_TYPES,
  type CalendarPathObject,
  type ExtensionManifest,
  manifestPathObject,
  type ObjectManifest,
  walkCalendarPath,
} from "@composable-os/sdk";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";

/** A registry object as the walker sees it. */
export function registryPathObject(object: ObjectDefinition): CalendarPathObject {
  return {
    name: object.name,
    hasCustomer: object.customer !== undefined,
    field(name) {
      const field = object.fields.find((f) => f.name === name);
      if (!field) return undefined;
      return {
        type: field.fieldType ?? field.type,
        many: field.options?.many === true,
        to: field.options?.to,
      };
    },
    readable(from, via) {
      const out = new Set<string>([
        ...(object.public?.read ?? []),
        ...(object.signedIn?.read ?? []),
      ]);
      const v = object.customerVia;
      if (v && from !== null && v.from === from && v.field === via) {
        for (const f of v.read) out.add(f);
      }
      return out;
    },
  };
}

/** Issues for the paths of `m`'s calendar entries that reach another extension's object. */
export function calendarEntryHostIssues(m: ExtensionManifest): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const [name, object] of Object.entries(m.objects)) {
    const entry = object.calendarEntry;
    if (!entry || !object.customer) continue;
    const origin = manifestPathObject(m.id, name, object);
    const read = new Set(object.customer.read);
    // This extension's objects as its manifest has them (it may not be installed yet); every
    // other object as the registry has it.
    const lookup = (target: string) => {
      if (target.startsWith(`${m.id}.`)) {
        const local = target.slice(m.id.length + 1);
        return Object.hasOwn(m.objects, local)
          ? manifestPathObject(m.id, local, m.objects[local] as ObjectManifest)
          : null;
      }
      const other = getObject(target);
      return other ? registryPathObject(other) : null;
    };
    for (const key of ["starts", "ends", "title", "place"] as const) {
      const declared = entry[key];
      if (declared === undefined) continue;
      const result = walkCalendarPath(origin, read, declared, lookup);
      // The SDK reports what stays inside the extension.
      if (result.ok === "deferred" || !result.foreign) continue;
      const at = `objects.${name}.calendarEntry.${key}`;
      if (!result.ok) issues.push({ path: at, message: result.message });
      else if (!(CALENDAR_PATH_TYPES[key] as readonly string[]).includes(result.type)) {
        issues.push({
          path: at,
          message: `"${declared}" must end at a ${CALENDAR_PATH_TYPES[key].join(" or ")} field`,
        });
      }
    }
  }
  return issues;
}
