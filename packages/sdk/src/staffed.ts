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
 * - `claimBefore`, `claimAfter` (optional, ADR 0760): `kind.field` number paths, minutes kept free
 *   before and after the shift (a service's buffer). They enter the time claim, never the shift's
 *   own times or pay; the kind must be another of this extension's objects, so the host follows a
 *   change of its minutes. Classes declare none: two back to back stay allowed.
 * - `account` (optional, ADR 0760): `"required"`: a live shift whose person is a profile holding
 *   no account is refused, at write and by the database, so no shift with a person escapes the
 *   claim (an appointment). A shift with nobody on it stays allowed (uncovered). Only with
 *   `who.account`: a user field always is the account.
 * - `private` (optional, ADR 0761): the record's title may name a client (an appointment). The
 *   roster shows the shift as its kind to anyone but its person and those who roster, a clash
 *   answer names it by its kind, and it is never offered to others. The feed never shows a title.
 * - `open` (optional, ADRs 0762 and 0763): the shift is booked at free times (an appointment).
 *   The host answers the free start times of a kind (`staffing.free`): its providers' open hours,
 *   less time off, their claims with margins, taken rooms, closures and the client's own shifts,
 *   on the kind's step; and staff writes are warned `outside_hours` and `client_busy`.
 *   - `length`: `kind.field`, the minutes a shift of the kind lasts (a service's length).
 *   - `step` (optional): `kind.field`, the minutes between start times (15, 30 or 60; 30 when
 *     empty), counted from the organisation's local midnight.
 *   - `rooms` (optional): `kind.field`, a relation (many) of the kind to the things this object
 *     `occupies`, in the order they are offered; empty on a kind record, it needs none.
 *   - `client` (optional): a relation field (one record) of this object to a Person: one client's
 *     live shifts of this object do not overlap.
 *   - `closedBy` (optional): another of this extension's objects whose records are date ranges
 *     (`from`, `until`: date fields): nothing is free on their dates.
 *   - `customer` (optional): `true`: a create or move by a customer or the public must be on a
 *     free time, by every door, in the batch that writes it.
 * - `evidence` (optional): what shows a shift was worked, beside its pay line (ADR 0627): another
 *   object of this extension whose records name the shift (`link`, a relation to this object) and
 *   the staff account that marked each (`by`, a user field): a class's bookings, ticked by whoever
 *   took the list. The host reads only that the list was taken, and by whom.
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
  claimBefore?: { field: string };
  claimAfter?: { field: string };
  account?: "required";
  private?: boolean;
  open?: StaffedOpenSpec;
  evidence?: { object: string; link: string; by: string };
}

/** A shift booked at free times (ADRs 0762 and 0763): see `StaffedSpec.open`. */
export interface StaffedOpenSpec {
  length: { field: string };
  step?: { field: string };
  rooms?: { field: string };
  client?: string;
  closedBy?: { object: string; from: string; until: string };
  customer?: true;
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
    claimBefore: z.object({ field: path }).strict().optional(),
    claimAfter: z.object({ field: path }).strict().optional(),
    account: z.literal("required").optional(),
    private: z.boolean().optional(),
    open: z
      .object({
        length: z.object({ field: path }).strict(),
        step: z.object({ field: path }).strict().optional(),
        rooms: z.object({ field: path }).strict().optional(),
        client: fieldName.optional(),
        closedBy: z
          .object({ object: fieldName, from: fieldName, until: fieldName })
          .strict()
          .optional(),
        customer: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    evidence: z.object({ object: fieldName, link: fieldName, by: fieldName }).strict().optional(),
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

  // Minutes kept free around the shift, in its claim (ADR 0760): a number field of its kind, which
  // is another of this extension's objects (the host builds triggers on its table to follow it).
  const kindTarget = kind?.type === "relation" && !kind.many ? kind.to : undefined;
  const kindLocal = kindTarget?.startsWith(`${m.id}.`)
    ? kindTarget.slice(m.id.length + 1)
    : undefined;
  const kindObject =
    kindLocal && kindLocal !== name && Object.hasOwn(m.objects, kindLocal)
      ? m.objects[kindLocal]
      : undefined;
  for (const key of ["claimBefore", "claimAfter"] as const) {
    const declared = staffed[key];
    if (!declared) continue;
    const [via, field, ...rest] = declared.field.split(".");
    if (via !== staffed.kind || !field || rest.length) {
      contract(
        `${at}.${key}.field`,
        `"${declared.field}" must be ${staffed.kind}.<a number field of what it names>`,
      );
    } else if (!kindObject) {
      contract(
        `${at}.${key}.field`,
        `"${staffed.kind}" must name another of this extension's objects for minutes in the claim`,
      );
    } else if (!single(own(kindObject, field), ["number"])) {
      contract(
        `${at}.${key}.field`,
        `"${field}" must be a number field of ${kindTarget as string}`,
      );
    }
  }

  // An account required: only a profile can hold none.
  if (staffed.account === "required" && staffed.who.account === undefined) {
    contract(
      `${at}.account`,
      `"required" needs who.account: "${staffed.who.field}" is a user field, always an account`,
    );
  }

  // Booked at free times (ADRs 0762 and 0763): the kind's length, step and rooms, the client, the
  // closures.
  if (staffed.open) {
    const open = staffed.open;
    // A field of the kind (null once a problem with the path is reported).
    const kindField = (key: "length" | "step" | "rooms"): FieldManifest | undefined | null => {
      const declared = open[key];
      if (!declared) return null;
      const [via, field, ...rest] = declared.field.split(".");
      if (via !== staffed.kind || !field || rest.length) {
        contract(
          `${at}.open.${key}.field`,
          `"${declared.field}" must be ${staffed.kind}.<a field of what it names>`,
        );
        return null;
      }
      if (!kindObject) {
        contract(
          `${at}.open.${key}.field`,
          `"${staffed.kind}" must name another of this extension's objects for free times`,
        );
        return null;
      }
      return own(kindObject, field);
    };
    for (const key of ["length", "step"] as const) {
      const field = kindField(key);
      if (field !== null && !single(field, ["number"])) {
        contract(
          `${at}.open.${key}.field`,
          `"${open[key]?.field}" must be a number field of ${kindTarget as string}`,
        );
      }
    }
    const rooms = kindField("rooms");
    if (rooms !== null) {
      const thingField = object.occupies ? own(object, object.occupies.thing) : undefined;
      if (!thingField) {
        contract(`${at}.open.rooms`, `${name} must declare occupies for the rooms it is booked in`);
      } else if (rooms?.type !== "relation" || !rooms.many || rooms.to !== thingField.to) {
        contract(
          `${at}.open.rooms.field`,
          `"${open.rooms?.field}" must be a relation field (many) of ${kindTarget as string} to ${thingField.to as string}`,
        );
      }
    }
    if (open.client !== undefined) {
      const client = own(object, open.client);
      if (client?.type !== "relation" || client.many || client.to !== "person") {
        contract(
          `${at}.open.client`,
          `"${open.client}" must be a relation field (one record) of ${name} to person`,
        );
      }
    }
    if (open.closedBy) {
      const c = open.closedBy;
      const closure =
        c.object !== name && Object.hasOwn(m.objects, c.object) ? m.objects[c.object] : undefined;
      if (!closure) {
        contract(
          `${at}.open.closedBy.object`,
          `"${c.object}" must be another object of this extension`,
        );
      } else {
        for (const key of ["from", "until"] as const) {
          if (!single(own(closure, c[key]), ["date"])) {
            contract(
              `${at}.open.closedBy.${key}`,
              `"${c[key]}" must be a date field of ${c.object}`,
            );
          }
        }
      }
    }
  }

  // The evidence a shift was worked: another object of this extension naming it, and who marked.
  if (staffed.evidence) {
    const { object: other, link, by } = staffed.evidence;
    const evidence =
      other !== name && Object.hasOwn(m.objects, other) ? m.objects[other] : undefined;
    const linkField = evidence ? own(evidence, link) : undefined;
    if (!evidence) {
      contract(`${at}.evidence.object`, `"${other}" must be another object of this extension`);
    } else if (
      linkField?.type !== "relation" ||
      linkField.many ||
      linkField.to !== `${m.id}.${name}`
    ) {
      contract(
        `${at}.evidence.link`,
        `"${link}" must be a relation field (one record) of ${other} to ${m.id}.${name}`,
      );
    } else if (!single(own(evidence, by), ["user"])) {
      contract(`${at}.evidence.by`, `"${by}" must be a user field of ${other}`);
    }
  }
}
