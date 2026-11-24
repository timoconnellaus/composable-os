// A pack role's "mine" reach (stage 39 step 3, ADR 0755): a role reaches an object's records only
// where a live record of its pack names the holder and leads to them (Jobs' crew: the jobs on
// which the account has a crew place, from a week before the visit to a week after). Its
// declaration, its manifest schema and its contract checks live here; what the role reaches
// through it is the host's (packages/core/src/pack-role-mine.ts).
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest, RoleManifest } from "./manifest.ts";

/**
 * How a role reaches one object's records through the records that name its holder (ADR 0755).
 * Jobs' crew on its jobs: `{ through: "jobs.assignment", who: "staff", path: "visit.job", live:
 * ["booked", "on_the_way", "on_site"], within: { from: "starts", to: "ends", days: 7 } }`.
 */
export interface MineSpec {
  /** The object of this extension (`<id>.<object>`) whose records name the holder. */
  through: string;
  /** A `user` field of `through` (one account, `personApproves`) naming the holder. */
  who: string;
  /**
   * The relations (one record each, each `personApproves`) from `through` to the object reached,
   * dot-separated, at most three: `"visit.job"`. Left out: the object reached is `through` itself.
   */
  path?: string;
  /** The states of `through`'s `states` (its field `personApproves`) in which its record counts; left out: every record. */
  live?: readonly string[];
  /**
   * A window around `through`'s own datetimes (each `personApproves`): its record counts from
   * `days` days before `from` to `days` days after `to` (`from` when left out).
   */
  within?: { from: string; to?: string; days: number };
}

const fieldName = z.string().max(40);

export const mineManifestSchema = z
  .object({
    through: z.string().max(80),
    who: fieldName,
    path: z.string().max(122).optional(),
    live: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    within: z
      .object({ from: fieldName, to: fieldName.optional(), days: z.number().int().min(0).max(366) })
      .strict()
      .optional(),
  })
  .strict();
export type MineManifest = z.infer<typeof mineManifestSchema>;

/** The most relations a path walks: a crew place to its visit to its job to its site. */
export const MINE_PATH_MAX = 3;

/** Reports problems with `roles.<name>.mine` through `contract`. */
export function checkRoleMine(
  m: ExtensionManifest,
  name: string,
  role: RoleManifest,
  contract: (path: string, message: string) => void,
): void {
  const own = (object: string): ObjectManifest | undefined => {
    const local = object.startsWith(`${m.id}.`) ? object.slice(m.id.length + 1) : null;
    return local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
  };
  const fieldOf = (object: ObjectManifest, field: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, field) ? object.fields[field] : undefined;
  // Changing one of these widens whom the role reaches: a person's choice (ADR 0889's lesson).
  const approved = (field: FieldManifest) => field.personApproves === true;
  const PERSON =
    "must be a field a person approves (personApproves): who reaches whose records is a person's to change";
  for (const [object, spec] of Object.entries(role.mine ?? {})) {
    const at = `roles.${name}.mine.${object}`;
    if (!own(object)) {
      contract(at, `"${object}" is not an object of this extension`);
      continue;
    }
    for (const [kind, limits] of [
      ["today", role.today],
      ["looksAfter", role.looksAfter],
    ] as const) {
      if (limits && Object.hasOwn(limits, object)) {
        contract(at, `${object} is limited by ${kind} already: one limit an object`);
      }
    }
    const through = own(spec.through);
    if (!through) {
      contract(`${at}.through`, `"${spec.through}" is not an object of this extension`);
      continue;
    }
    const who = fieldOf(through, spec.who);
    if (who?.type !== "user" || who.many) {
      contract(`${at}.who`, `"${spec.who}" must be a user field (one account) of ${spec.through}`);
    } else if (!approved(who)) {
      contract(`${at}.who`, `"${spec.who}" ${PERSON}`);
    }
    // The path: one-record relations of this extension's objects, ending at the object reached.
    const steps = spec.path ? spec.path.split(".") : [];
    if (steps.length > MINE_PATH_MAX) {
      contract(`${at}.path`, `A path walks at most ${MINE_PATH_MAX} relations`);
    } else {
      let current: ObjectManifest | undefined = through;
      let currentName = spec.through;
      for (const step of steps) {
        const field: FieldManifest | undefined = current ? fieldOf(current, step) : undefined;
        if (field?.type !== "relation" || field.many || !field.to || !own(field.to)) {
          contract(
            `${at}.path`,
            `"${step}" must be a relation field (one record) of ${currentName} to an object of this extension`,
          );
          current = undefined;
          break;
        }
        if (!approved(field)) contract(`${at}.path`, `"${step}" of ${currentName} ${PERSON}`);
        currentName = field.to;
        current = own(field.to);
      }
      if (current && currentName !== object) {
        contract(
          `${at}.path`,
          spec.path
            ? `"${spec.path}" leads to ${currentName}, not ${object}`
            : `Without a path the object reached is ${spec.through} itself: name the relations to ${object}`,
        );
      }
    }
    if (spec.live) {
      const states = through.states;
      const known = new Set(
        states ? (fieldOf(through, states.field)?.options ?? []).map((o) => o.value) : [],
      );
      if (!states) {
        contract(
          `${at}.live`,
          `${spec.through} has no states: leave live out (every record counts)`,
        );
      } else {
        for (const [i, state] of spec.live.entries()) {
          if (!known.has(state)) {
            contract(`${at}.live.${i}`, `"${state}" is not a state of ${spec.through}`);
          }
        }
        // Moving a record back into a live state widens the reach (a cancelled place booked again).
        const field = fieldOf(through, states.field);
        if (field && !approved(field)) {
          contract(`${at}.live`, `"${states.field}" of ${spec.through} ${PERSON}`);
        }
      }
    }
    if (spec.within) {
      for (const key of ["from", "to"] as const) {
        const value = spec.within[key];
        if (value === undefined) continue;
        const field = fieldOf(through, value);
        if (field?.type !== "datetime" || field.many) {
          contract(`${at}.within.${key}`, `"${value}" must be a datetime field of ${spec.through}`);
        } else if (!approved(field)) {
          // Moving the times moves the window: a place twenty days out brought into reach.
          contract(`${at}.within.${key}`, `"${value}" ${PERSON}`);
        }
      }
    }
  }
}
