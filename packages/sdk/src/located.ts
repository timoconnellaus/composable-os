// Located records and agreeing relations (stage 64 step 2, ADR 0911): an object whose records
// each belong to one location (`located`), and two relations of a record that must name the same
// location (`agree`). Their declarations, manifest schemas and contract checks live here; the
// host's side (the fill, the zone default, the refusals in the database) is
// packages/core/src/locations/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * Which location a record is at (ADR 0911). One declaration per object, by one of:
 *
 * - `field`: a required relation field of this object to one `location` (a room, a series, a
 *   class, a duty shift). With one open location the host fills it on a new record, and the
 *   reconciler fills it on records that existed before the field (with the main location).
 * - `path`: `relation.field`, a required relation of this object to one record of another of this
 *   extension's objects, and that object's relation to one `location` (a booking's
 *   `class.location`). The record is at the location its related record is at.
 *
 * A located record's empty `timezone` field takes its location's zone, not the organisation's.
 * A new record (or one moved) at a closed location is refused (`location_closed`). Packs never
 * filter by location in their own code: this declaration is what the host reads.
 */
export interface LocatedSpec {
  field?: string;
  path?: string;
}

/**
 * Two sides of a record that must name the same location (ADR 0911), each a relation field of
 * this object to one `location`, or `relation.field` as in `located.path`: a class's own
 * location and its room's (`{ a: "location", b: "room.location" }`). The host refuses, in the
 * database and for every writer, a live record whose two sides name different locations
 * (`location_mismatch`), and a change to the related record (the room's location) that would
 * leave a live record disagreeing: a room's location is fixed while a live record uses it.
 */
export interface AgreeSpec {
  a: string;
  b: string;
}

const side = z.string().min(1).max(81);

export const locatedManifestSchema = z
  .object({ field: z.string().max(40).optional(), path: side.optional() })
  .strict();
export type LocatedManifest = z.infer<typeof locatedManifestSchema>;

export const agreeManifestSchema = z
  .array(z.object({ a: side, b: side }).strict())
  .min(1)
  .max(4);
export type AgreeManifest = z.infer<typeof agreeManifestSchema>;

/** The base record a located field relates to. */
export const LOCATION_OBJECT = "location";

const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
  Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;

/** A relation field to one location. */
const toOneLocation = (field: FieldManifest | undefined): boolean =>
  field?.type === "relation" && field.to === LOCATION_OBJECT && !field.many;

/**
 * Whether `path` reaches one location from `object`: a relation field of its own to one
 * location, or (`relation.field`) a relation to one record of another of this extension's objects
 * and that object's relation to one location. A path is at most one relation away: the host reads
 * it in one statement, and builds its triggers on that object's table (its own extension's).
 */
export function reachesLocation(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  path: string,
): boolean {
  const parts = path.split(".");
  if (parts.length === 1) return toOneLocation(own(object, parts[0] as string));
  if (parts.length !== 2) return false;
  const [first, second] = parts as [string, string];
  const via = own(object, first);
  if (via?.type !== "relation" || via.many || !via.to?.startsWith(`${m.id}.`)) return false;
  const local = via.to.slice(m.id.length + 1);
  if (local === name || !Object.hasOwn(m.objects, local)) return false;
  return toOneLocation(own(m.objects[local] as ObjectManifest, second));
}

/** Reports problems with `objects.<name>.located` and `objects.<name>.agree` through `contract`. */
export function checkObjectLocated(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const located = object.located;
  if (located) {
    const at = `objects.${name}.located`;
    if (located.field !== undefined && located.path !== undefined) {
      contract(at, `${name} is located once: declare \`field\` or \`path\`, not both`);
    } else if (located.field === undefined && located.path === undefined) {
      contract(at, "Declare `field` (a relation to one location) or `path` (`relation.field`)");
    } else if (located.field !== undefined) {
      const field = own(object, located.field);
      if (!toOneLocation(field)) {
        contract(
          `${at}.field`,
          `"${located.field}" must be a relation field of ${name} to one location`,
        );
      } else if (!field?.required) {
        contract(
          `${at}.field`,
          `"${located.field}" must be required: every ${name} is at a location (the host fills it while there is one)`,
        );
      }
    } else if (located.path !== undefined) {
      if (!located.path.includes(".") || !reachesLocation(m, name, object, located.path)) {
        contract(
          `${at}.path`,
          `"${located.path}" must be relation.field: a relation of ${name} to one of this extension's objects, and its relation to one location`,
        );
      } else if (!own(object, located.path.split(".")[0] as string)?.required) {
        contract(
          `${at}.path`,
          `"${located.path.split(".")[0]}" must be required: every ${name} is at a location, through it`,
        );
      }
    }
  }
  (object.agree ?? []).forEach((rule, i) => {
    const at = `objects.${name}.agree.${i}`;
    if (rule.a === rule.b) contract(at, "The two sides of an agree rule are two different paths");
    for (const key of ["a", "b"] as const) {
      if (!reachesLocation(m, name, object, rule[key])) {
        contract(
          `${at}.${key}`,
          `"${rule[key]}" must reach a location: a relation field of ${name} to one location, or relation.field ending at one`,
        );
      }
    }
  });
}
