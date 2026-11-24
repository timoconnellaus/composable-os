// A shipped pack's team (stage 56, ADR 0831; built with Programs' coach role, ADR 0889): the staff
// named on a live record about a Person look after that Person while the record is live. Its
// declaration, its manifest schema and its contract checks live here; what a pack role reaches
// through it (`looksAfter`) is the host's (packages/core/src/pack-role-looks-after.ts).
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * Who on the staff looks after the Person a record is about (ADR 0831): the accounts in its
 * `staff` user fields, while the record is in one of the `live` states of the object's `states`
 * (every record not in the Trash, when the object has no states). A client's program names their
 * coach: `{ person: "person", staff: ["coach"], live: ["generating", "active"] }`.
 *
 * It gives nothing by itself. A pack role that declares `looksAfter` reaches its objects' records
 * only for the People its holder looks after this way (ADR 0889). Only shipped packs and the
 * org's own extensions declare it: who reaches whose records is access.
 */
export interface TeamSpec {
  /** A relation (one record) to `person`: whom the record is about. */
  person: string;
  /** `user` fields of this object (one account each, each `personApproves`): who looks after them. */
  staff: readonly string[];
  /** The states of the object's `states` in which the record counts. */
  live?: readonly string[];
}

const fieldName = z.string().max(40);

export const teamManifestSchema = z
  .object({
    person: fieldName,
    staff: z.array(fieldName).min(1).max(4),
    live: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  })
  .strict();
export type TeamManifest = z.infer<typeof teamManifestSchema>;

/** Reports problems with `objects.<name>.team` through `contract`. */
export function checkObjectTeam(
  _m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const team = object.team;
  if (!team) return;
  const at = `objects.${name}.team`;
  const own = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const person = own(team.person);
  if (person?.type !== "relation" || person.to !== "person" || person.many) {
    contract(`${at}.person`, `"${team.person}" must be a relation field (one record) to person`);
  }
  for (const [i, field] of team.staff.entries()) {
    const staff = own(field);
    if (staff?.type !== "user" || staff.many) {
      contract(`${at}.staff.${i}`, `"${field}" must be a user field of ${name}`);
    } else if (staff.personApproves !== true) {
      // Naming someone in it opens a pack role's reach to the Person (ADR 0889): a person's
      // choice, never the assistant's, an automation's or code's on its own.
      contract(
        `${at}.staff.${i}`,
        `"${field}" must be a field a person approves (personApproves): who reaches whose records is a person's to change`,
      );
    }
  }
  if (new Set(team.staff).size !== team.staff.length) {
    contract(`${at}.staff`, "Name each field once");
  }
  if (team.live) {
    const states = object.states;
    const known = new Set(
      states ? (own(states.field)?.options ?? []).map((option) => option.value) : [],
    );
    if (!states) {
      contract(`${at}.live`, `${name} has no states: leave live out (every record counts)`);
    } else {
      for (const [i, state] of team.live.entries()) {
        if (!known.has(state)) contract(`${at}.live.${i}`, `"${state}" is not a state of ${name}`);
      }
    }
  }
}
