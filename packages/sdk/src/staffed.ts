// The `staffed` behaviour (stage 45 step 2, ADR 0621): a record that is a shift, a time someone
// works. Its declaration, its manifest schema and its contract checks live here; the host's side
// (the time claim, refused by the database, and the warnings) is packages/core/src/staffing/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * A shift (ADR 0621): a time, a kind of work, and at most one staff account working it. The host
 * keeps a **time claim** for every live, covered shift and refuses, in the database, a second
 * shift that overlaps one account's time, for every actor and however many write at once
 * (`conflict`, `rule: "double_booked"`). It answers a write with **warnings** it does not refuse:
 * the person is away, not qualified for the kind, or the shift is left with no one.
 *
 * - `who`: the person. `{ field: "staff" }` is a `user` field of this object (the staff account
 *   itself). `{ field: "coach", account: "user" }` is a relation (one record) to another of this
 *   extension's objects whose `user` field holds the account (a class's coach profile); a profile
 *   with no account covers the shift for members but claims no one's time.
 * - `starts`, `ends`: datetime fields of this object, the shift's own time. Ranges are half-open:
 *   06:00 to 07:00 and 07:00 to 08:00 do not clash.
 * - `zone`: a timezone field (optional), the shift's local zone.
 * - `kind`: a relation (one record) to what qualifications are for (a class type, a duty).
 * - `live`: the states of the object's `states` in which the record is a shift. A record in any
 *   other state, or in the Trash, claims nothing.
 * - `place` (optional): a field, or `relation.field`, shown on the roster and in the feed.
 * - `pattern` (optional): the series field that is the shift's regular person (`link` is the
 *   series' `recurring.link` on this object, `who` the series field copied onto `who.field`).
 * - `payBefore`, `payAfter` (optional): `kind.field` number paths, minutes counted for pay only
 *   (preparation and pack-down); they never enter the time claim.
 *
 * Only shipped packs and the org's own extensions declare it: who works when feeds pay.
 */
export interface StaffedSpec {
  who: { field: string; account?: string };
  starts: string;
  ends: string;
  zone?: string;
  kind: string;
  live: readonly string[];
  place?: string;
  pattern?: { link: string; who: string };
  payBefore?: { field: string };
  payAfter?: { field: string };
}

const fieldName = z.string().max(40);
const path = z.string().max(81);

export const staffedManifestSchema = z
  .object({
    who: z.object({ field: fieldName, account: fieldName.optional() }).strict(),
    starts: fieldName,
    ends: fieldName,
    zone: fieldName.optional(),
    kind: fieldName,
    live: z.array(z.string().min(1).max(100)).min(1).max(20),
    place: path.optional(),
    pattern: z.object({ link: fieldName, who: fieldName }).strict().optional(),
    payBefore: z.object({ field: path }).strict().optional(),
    payAfter: z.object({ field: path }).strict().optional(),
  })
  .strict();
export type StaffedManifest = z.infer<typeof staffedManifestSchema>;

/** Reports problems with `objects.<name>.staffed` through `contract`. */
export function checkObjectStaffed(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const staffed = object.staffed;
  if (!staffed) return;
  const at = `objects.${name}.staffed`;
  const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const single = (field: FieldManifest | undefined, types: readonly string[]) =>
    field !== undefined && types.includes(field.type) && !field.many;

  // The person.
  const who = own(object, staffed.who.field);
  if (staffed.who.account === undefined) {
    if (!single(who, ["user"])) {
      contract(`${at}.who.field`, `"${staffed.who.field}" must be a user field of ${name}`);
    }
  } else {
    const target = who?.type === "relation" && !who.many ? who.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    const holder = local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    if (!holder || local === name) {
      contract(
        `${at}.who.field`,
        `"${staffed.who.field}" must be a relation field (one record) to another of this extension's objects`,
      );
    } else if (!single(own(holder, staffed.who.account), ["user"])) {
      contract(
        `${at}.who.account`,
        `"${staffed.who.account}" must be a user field of ${target as string}`,
      );
    }
  }
  // The time and the zone.
  for (const key of ["starts", "ends"] as const) {
    if (!single(own(object, staffed[key]), ["datetime"])) {
      contract(`${at}.${key}`, `"${staffed[key]}" must be a datetime field of ${name}`);
    }
  }
  if (staffed.starts === staffed.ends) {
    contract(`${at}.ends`, "A shift's start and end are two fields");
  }
  if (staffed.zone !== undefined && !single(own(object, staffed.zone), ["timezone"])) {
    contract(`${at}.zone`, `"${staffed.zone}" must be a timezone field of ${name}`);
  }

  // The kind.
  const kind = own(object, staffed.kind);
  if (kind?.type !== "relation" || kind.many) {
    contract(`${at}.kind`, `"${staffed.kind}" must be a relation field (one record) of ${name}`);
  }

  // The states in which it is a shift.
  const states = object.states;
  if (!states) {
    contract(`${at}.live`, `${name} must declare states: a shift is live in some of them`);
  } else {
    const field = own(object, states.field);
    const values = new Set((field?.options ?? []).map((o) => o.value));
    for (const state of staffed.live) {
      if (!values.has(state)) contract(`${at}.live`, `"${state}" is not a state of ${name}`);
    }
    if (new Set(staffed.live).size !== staffed.live.length) {
      contract(`${at}.live`, "List each state once");
    }
  }

  // Where it is.
  if (staffed.place !== undefined) {
    const [first, second, ...rest] = staffed.place.split(".");
    const field = first === undefined ? undefined : own(object, first);
    if (!field || rest.length || (second !== undefined && field.type !== "relation")) {
      contract(
        `${at}.place`,
        `"${staffed.place}" must be a field of ${name}, or a relation of it and a field of what it names`,
      );
    }
  }

  // The pattern: a series of this extension making these records, copying its person onto them.
  if (staffed.pattern) {
    const series = Object.entries(m.objects).find(
      ([, o]) => o.recurring?.generates === name && o.recurring.link === staffed.pattern?.link,
    );
    if (!series) {
      contract(
        `${at}.pattern.link`,
        `"${staffed.pattern.link}" must be the link of a series of this extension that makes ${name}`,
      );
    } else if (series[1].recurring?.copy?.[staffed.who.field] !== staffed.pattern.who) {
      contract(
        `${at}.pattern.who`,
        `${series[0]} must copy "${staffed.pattern.who}" onto "${staffed.who.field}"`,
      );
    }
  }

  // Minutes for pay only, read from the kind.
  for (const key of ["payBefore", "payAfter"] as const) {
    const declared = staffed[key];
    if (!declared) continue;
    const [via, field, ...rest] = declared.field.split(".");
    if (via !== staffed.kind || !field || rest.length) {
      contract(
        `${at}.${key}.field`,
        `"${declared.field}" must be ${staffed.kind}.<a number field of what it names>`,
      );
    }
  }
}
