// The `agreements` behaviour (stage 44, ADR 0641): an object marks an agreement point, a place a
// business may need a person to have agreed to its documents first (buying a membership, making a
// booking). The pack names the point; the business attaches its own documents to it in the admin.
// Nothing is needed anywhere until a person publishes a document and attaches it. Its declaration,
// its manifest schema and its contract checks live here; the host's side is
// packages/core/src/agreements/.
import { z } from "zod";
import type { ExtensionManifest, ObjectManifest } from "./manifest.ts";
import { moveOrigins } from "./states.ts";

/** Kinds of agreement document a business writes (`care` is the platform's own, stage 43). */
export const AGREEMENT_KINDS = ["terms", "waiver", "health", "guardian", "other"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

/** A point's name: a lowercase word, shared by objects that mean the same place. */
export const AGREEMENT_POINT_RE = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * An agreement point (ADR 0641).
 *
 * - `point`: the point's name. Objects may share one (a membership plan and a pass type are both
 *   "buying a membership or a pass").
 * - `label`: what the admin shows when attaching documents.
 * - `suggests`: kinds of document the admin offers first. A suggestion, never a requirement.
 * - `enter` and `person`: for a record a caller makes (a booking), the states whose entry is checked
 *   and the relation to the Person it is for. Left out, the point is checked where the object is
 *   bought (a `sellable` object).
 *
 * In stage 44 step 1 the declaration is inert: it is checked and listed, and documents can be
 * attached to it; the host asks it from step 3.
 */
export interface AgreementsSpec {
  point: string;
  label: string;
  suggests?: readonly AgreementKind[];
  enter?: readonly string[];
  person?: string;
}

export const agreementsManifestSchema = z.object({
  point: z.string().max(40),
  label: z.string().min(1).max(80),
  suggests: z.array(z.enum(AGREEMENT_KINDS)).max(AGREEMENT_KINDS.length).optional(),
  enter: z.array(z.string().max(40)).min(1).max(20).optional(),
  person: z.string().max(40).optional(),
});
export type AgreementsManifest = z.infer<typeof agreementsManifestSchema>;

/** The states an object's `states` declaration names. */
function stateNames(object: ObjectManifest): Set<string> {
  const states = object.states;
  if (!states) return new Set();
  return new Set([
    states.initial,
    ...states.moves.flatMap((move) => [...moveOrigins(move), move.to]),
  ]);
}

/** The contract checks of an object's `agreements` declaration. */
export function checkObjectAgreements(
  _m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const declared = object.agreements;
  if (!declared) return;
  const path = `objects.${name}.agreements`;
  if (!AGREEMENT_POINT_RE.test(declared.point)) {
    contract(`${path}.point`, "point must be a lowercase word (letters, digits, _), 2 to 40 long");
  }
  if (declared.suggests && new Set(declared.suggests).size !== declared.suggests.length) {
    contract(`${path}.suggests`, "suggests lists each kind once");
  }
  if (!declared.enter) {
    if (declared.person !== undefined) {
      contract(`${path}.person`, "person is for a point checked when a record enters a state");
    }
    if (!object.sellable) {
      contract(
        path,
        `${name} is not sellable: a point on it needs enter (the states whose entry is checked) and person`,
      );
    }
    return;
  }
  const states = stateNames(object);
  if (!object.states) {
    contract(`${path}.enter`, `enter names states, and ${name} declares none`);
  } else {
    for (const [i, state] of declared.enter.entries()) {
      if (!states.has(state))
        contract(`${path}.enter.${i}`, `"${state}" is not a state of ${name}`);
    }
  }
  const person = declared.person;
  const field =
    person !== undefined && Object.hasOwn(object.fields, person)
      ? object.fields[person]
      : undefined;
  if (field?.type !== "relation" || field.many || field.to !== "person") {
    contract(`${path}.person`, `person must be a relation field (one record) to person`);
  }
}

/**
 * A health-note list (stage 44, ADR 0643): records of this object make a list a person on the
 * staff reads (a class's bookings), and the host may mark, beside each Person on it, a yes on
 * their current health form, nothing else. `list` is the relation to the list's own record (the
 * class), `person` the relation to the Person. The host reads the People itself; pack code names
 * only the list's record (`agreement.listHealthNotes`), inside a tool a person called.
 */
export interface HealthNotesSpec {
  list: string;
  person: string;
}

export const healthNotesManifestSchema = z.object({
  list: z.string().max(40),
  person: z.string().max(40),
});
export type HealthNotesManifest = z.infer<typeof healthNotesManifestSchema>;

/** The contract checks of an object's `healthNotes` declaration. */
export function checkObjectHealthNotes(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const declared = object.healthNotes;
  if (!declared) return;
  const path = `objects.${name}.healthNotes`;
  const one = (field: string) =>
    Object.hasOwn(object.fields, field) ? object.fields[field] : undefined;
  const list = one(declared.list);
  const self = `${m.id}.${name}`;
  if (
    list?.type !== "relation" ||
    list.many ||
    list.to === "person" ||
    list.to === self ||
    list.to === name
  ) {
    contract(`${path}.list`, "list must be a relation field (one record) to another object");
  }
  const person = one(declared.person);
  if (person?.type !== "relation" || person.many || person.to !== "person") {
    contract(`${path}.person`, "person must be a relation field (one record) to person");
  }
}
