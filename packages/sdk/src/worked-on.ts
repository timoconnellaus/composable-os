// The `workedOn` declaration (stage 58 step 1, ADR 0850): a record time can be recorded against (a
// job). Its manifest schema and contract checks live here; the host's side (the time entries,
// refused by the database when one person's overlap) is packages/core/src/staffing/time.ts.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * Time can be recorded against this record (ADR 0850): a job a tradesperson spends three hours
 * on. A staff member's **time entry** is the one record of time worked; an entry against a shift
 * (a `staffed` record) is against the roster, an entry against a `workedOn` record is against the
 * job, and an entry against neither is other work. The record keeps no hours of its own: its
 * time is the entries against it, read through the host (the same entries pay counts), never a
 * second "time spent" record, and never in a `rec_*` view.
 *
 * - `live`: the states of the object's `states` in which time may be recorded against it. A
 *   record in any other state, or in the Trash, takes no new time.
 * - `title`: a field of this object, shown on the entry, the timesheet and the export.
 * - `kind` (optional): a relation (one record) of this object, shown as the export's kind.
 * - `place` (optional): a field, or `relation.field`, shown beside the entry.
 * - `readers`: a permission of this extension's tools: who reads the time recorded against a
 *   record (person, date, minutes and state; never a note).
 * - `partOf` (optional), on a `staffed` object only (a scheduled visit to a site): a relation (one
 *   record) to another of this extension's objects that declares `workedOn` (the job); time
 *   recorded against the visit also counts to it.
 *
 * Only shipped packs and the org's own extensions declare it: time worked feeds pay.
 */
export interface WorkedOnSpec {
  live: readonly string[];
  title: string;
  kind?: string;
  place?: string;
  readers: string;
  partOf?: string;
}

const fieldName = z.string().max(40);

export const workedOnManifestSchema = z
  .object({
    live: z.array(z.string().min(1).max(100)).min(1).max(20),
    title: fieldName,
    kind: fieldName.optional(),
    place: z.string().max(81).optional(),
    readers: z.string().max(80),
    partOf: fieldName.optional(),
  })
  .strict();
export type WorkedOnManifest = z.infer<typeof workedOnManifestSchema>;

/** Reports problems with `objects.<name>.workedOn` through `contract`. */
export function checkObjectWorkedOn(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const declared = object.workedOn;
  if (!declared) return;
  const at = `objects.${name}.workedOn`;
  const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;

  // The states in which time may be recorded against it.
  const states = object.states;
  if (!states) {
    contract(`${at}.live`, `${name} must declare states: time is recorded in some of them`);
  } else {
    const field = own(object, states.field);
    const values = new Set((field?.options ?? []).map((o) => o.value));
    for (const state of declared.live) {
      if (!values.has(state)) contract(`${at}.live`, `"${state}" is not a state of ${name}`);
    }
    if (new Set(declared.live).size !== declared.live.length) {
      contract(`${at}.live`, "List each state once");
    }
  }

  // What it is called, of what kind, and where.
  const title = own(object, declared.title);
  if (!title || title.many) {
    contract(`${at}.title`, `"${declared.title}" must be a field (one value) of ${name}`);
  }
  if (declared.kind !== undefined) {
    const kind = own(object, declared.kind);
    if (kind?.type !== "relation" || kind.many) {
      contract(`${at}.kind`, `"${declared.kind}" must be a relation field (one record) of ${name}`);
    }
  }
  if (declared.place !== undefined) {
    const [first, second, ...rest] = declared.place.split(".");
    const field = first === undefined ? undefined : own(object, first);
    if (!field || rest.length || (second !== undefined && field.type !== "relation")) {
      contract(
        `${at}.place`,
        `"${declared.place}" must be a field of ${name}, or a relation of it and a field of what it names`,
      );
    }
  }

  // Who reads its time: a permission this extension's tools declare.
  const permissions = new Set(
    Object.values(m.tools).flatMap((t) =>
      t.permission === undefined
        ? []
        : typeof t.permission === "string"
          ? [t.permission]
          : t.permission,
    ),
  );
  if (!declared.readers.startsWith(`${m.id}:`) || !permissions.has(declared.readers)) {
    contract(
      `${at}.readers`,
      `"${declared.readers}" must be a permission of this extension's tools (${m.id}:<word>)`,
    );
  }

  // What a staffed visit's time also counts to.
  if (declared.partOf !== undefined) {
    if (!object.staffed) {
      contract(`${at}.partOf`, `Only a shift (an object that declares staffed) is part of a job`);
    }
    const via = own(object, declared.partOf);
    const target = via?.type === "relation" && !via.many ? via.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    const job = local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    if (!job || local === name || !job.workedOn || job.workedOn.partOf !== undefined) {
      contract(
        `${at}.partOf`,
        `"${declared.partOf}" must be a relation field (one record) to another of this extension's objects that declares workedOn`,
      );
    }
  }
}
