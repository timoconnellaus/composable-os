// The `occupies` behaviour (stage 49 step 2, ADR 0765): a record that takes a thing (a room, a
// chair, a hall) for its time. Its declaration, its manifest schema and its contract checks live
// here; the host's side (the claim, refused by the database) is packages/core/src/occupies/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * A claim on a thing (ADR 0765): while the record is live it takes the thing its `thing` field
 * names for its time, and the host refuses, in the database, a second live record of any object
 * on the same thing at an overlapping time, for every actor and however many write at once
 * (`conflict`, `rule: "room_taken"`, naming no other record). One occupant at a time: this is not
 * a capacity.
 *
 * - `thing`: a relation field of this object (one record, or many: one claim per thing) to another
 *   of this extension's objects.
 * - `starts`, `ends`: required datetime fields of this object. Ranges are half-open: 09:00 to 10:00 and
 *   10:00 to 11:00 do not clash.
 * - `live`: the states of the object's `states` in which the record takes its thing. A record in
 *   any other state, or in the Trash, claims nothing.
 * - `before`, `after` (optional): minutes the claim starts earlier and ends later than the record
 *   (a gap kept free): a number field of this object, or `relation.field`, a number field of the
 *   record a relation of this object names (a service's buffer).
 * - `only` (optional): a boolean field of the thing. Only things with it set are claimed (a room
 *   marked "one booking at a time"); without it, every thing named is.
 *
 * Two keys only say how the room calendar (`rooms.week`, `rooms.check`, ADR 0844) shows a claim;
 * the claim itself is the same with or without them:
 *
 * - `provisional` (optional): those of `live` in which the claim is shown as provisional (a hire
 *   held before its deposit). A provisional claim refuses a clash as a firm one does.
 * - `title` (optional): what the calendar shows for the record: a field of this object, or
 *   `relation.field`, a field of the record a relation of this object names (an appointment's
 *   service, never its client). Left out, or empty on a record, the calendar shows the object's
 *   label. Never a field that names a person.
 */
export interface OccupiesSpec {
  thing: string;
  starts: string;
  ends: string;
  live: readonly string[];
  before?: { field: string };
  after?: { field: string };
  only?: string;
  provisional?: readonly string[];
  title?: string;
}

/** Field types a calendar title may be read from: text a staff member typed or chose. */
const TITLE_TYPES = ["text", "select"] as const;

const fieldName = z.string().max(40);
const path = z.string().max(81);

export const occupiesManifestSchema = z
  .object({
    thing: fieldName,
    starts: fieldName,
    ends: fieldName,
    live: z.array(z.string().min(1).max(100)).min(1).max(20),
    before: z.object({ field: path }).strict().optional(),
    after: z.object({ field: path }).strict().optional(),
    only: fieldName.optional(),
    provisional: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    title: path.optional(),
  })
  .strict();
export type OccupiesManifest = z.infer<typeof occupiesManifestSchema>;

/** Reports problems with `objects.<name>.occupies` through `contract`. */
export function checkObjectOccupies(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const occupies = object.occupies;
  if (!occupies) return;
  const at = `objects.${name}.occupies`;
  const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const single = (field: FieldManifest | undefined, types: readonly string[]) =>
    field !== undefined && types.includes(field.type) && !field.many;
  // Another object of this extension a relation field names (the reconciler builds triggers on
  // its table, so it is this extension's own).
  const named = (field: FieldManifest | undefined) => {
    const target = field?.type === "relation" ? field.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    return local && local !== name && Object.hasOwn(m.objects, local)
      ? (m.objects[local] as ObjectManifest)
      : undefined;
  };

  // The thing.
  const thing = named(own(object, occupies.thing));
  if (!thing) {
    contract(
      `${at}.thing`,
      `"${occupies.thing}" must be a relation field of ${name} to another of this extension's objects`,
    );
  } else if (occupies.only !== undefined && !single(own(thing, occupies.only), ["boolean"])) {
    contract(
      `${at}.only`,
      `"${occupies.only}" must be a boolean field of ${own(object, occupies.thing)?.to as string}`,
    );
  }

  // The time: required, or a live record with no end would sit in the room claiming nothing.
  for (const key of ["starts", "ends"] as const) {
    const field = own(object, occupies[key]);
    if (!single(field, ["datetime"])) {
      contract(`${at}.${key}`, `"${occupies[key]}" must be a datetime field of ${name}`);
    } else if (!field?.required) {
      contract(
        `${at}.${key}`,
        `"${occupies[key]}" must be required: a record with no time would take its ${occupies.thing} claiming nothing`,
      );
    }
  }
  if (occupies.starts === occupies.ends) {
    contract(`${at}.ends`, "A record's start and end are two fields");
  }

  // The states in which it takes its thing.
  const states = object.states;
  if (!states) {
    contract(`${at}.live`, `${name} must declare states: a record takes its thing in some of them`);
  } else {
    const field = own(object, states.field);
    const values = new Set((field?.options ?? []).map((o) => o.value));
    for (const state of occupies.live) {
      if (!values.has(state)) contract(`${at}.live`, `"${state}" is not a state of ${name}`);
    }
    if (new Set(occupies.live).size !== occupies.live.length) {
      contract(`${at}.live`, "List each state once");
    }
  }

  // The states shown as provisional: some of the live ones.
  if (occupies.provisional) {
    for (const state of occupies.provisional) {
      if (!occupies.live.includes(state)) {
        contract(
          `${at}.provisional`,
          `"${state}" is not one of live: only a state that takes the ${occupies.thing} is provisional`,
        );
      }
    }
    if (new Set(occupies.provisional).size !== occupies.provisional.length) {
      contract(`${at}.provisional`, "List each state once");
    }
  }

  // The calendar's title: a text or choice of this object, or of what one of its relations names
  // (an appointment's service). A relation to a Person or an account is never one: the calendar
  // shows no names.
  if (occupies.title !== undefined) {
    const [first, second, ...rest] = occupies.title.split(".");
    const field = first === undefined ? undefined : own(object, first);
    let ok = false;
    if (!rest.length && second === undefined) ok = single(field, TITLE_TYPES);
    else if (!rest.length && second !== undefined && single(field, ["relation"])) {
      const source = named(field);
      ok = source !== undefined && single(own(source, second), TITLE_TYPES);
    }
    if (!ok) {
      contract(
        `${at}.title`,
        `"${occupies.title}" must be a text or select field of ${name}, or a relation of it (one record, to another of this extension's objects) and a text or select field of what it names`,
      );
    }
  }

  // The margins: a number field of this object, or of the record one of its relations names.
  for (const key of ["before", "after"] as const) {
    const declared = occupies[key];
    if (!declared) continue;
    const [first, second, ...rest] = declared.field.split(".");
    const field = first === undefined ? undefined : own(object, first);
    let ok = false;
    if (!rest.length && second === undefined) ok = single(field, ["number"]);
    else if (!rest.length && second !== undefined && single(field, ["relation"])) {
      const source = named(field);
      ok = source !== undefined && single(own(source, second), ["number"]);
    }
    if (!ok) {
      contract(
        `${at}.${key}.field`,
        `"${declared.field}" must be a number field of ${name}, or a relation of it (one record, to another of this extension's objects) and a number field of what it names`,
      );
    }
  }
}
