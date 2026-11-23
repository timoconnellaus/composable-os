// The `checklists` declaration (stage 45 step 4b, ADR 0650): a record its person ticks a checklist
// off on. Its manifest schema and contract checks live here; the host's side (the templates, the
// runs and their ticks, a completed run kept unchanged by the database, who reads how it went) is
// packages/core/src/checklists/.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * A checklist a record's person ticks off (ADR 0650). A business writes a checklist once (its
 * steps, in Settings → Checklists) and picks it on something that happens (a duty); each record
 * that is live with one gets a **run** of it, made by the host a day before it opens, with the
 * steps copied as they were then (a template changed later changes no run already made). Its
 * person ticks it off from when it opens until it closes and a grace period after; someone who
 * rosters may tick for them, with a reason, recorded as theirs for that person. A run marked done
 * never changes, refused by the database for every writer; one not done by its close and grace is
 * closed by the host as missed, and the rosterers are told. How a run went is read only by its
 * person and by those who roster, never by other staff, any rec_* view or an AI.
 *
 * - `template`: the field naming the checklist, of type `checklist`: one of this object's, or
 *   `relation.field` through a relation (one record) to another of this extension's objects (a
 *   duty shift's `duty.checklist`).
 * - `who`: the `user` field holding the staff account who ticks it (the shift's person).
 * - `opens`, `closes`: datetime fields of this object, when it may be ticked (the shift's start and
 *   end).
 * - `live`: the states of the object's `states` in which it applies. A record in any other state,
 *   or in the Trash, at its close is closed as cancelled, not missed.
 *
 * Only shipped packs and the org's own extensions declare it: who ticks what is a staff record.
 */
export interface ChecklistsSpec {
  template: string;
  who: string;
  opens: string;
  closes: string;
  live: readonly string[];
}

const fieldName = z.string().max(40);

export const checklistsManifestSchema = z
  .object({
    template: z.string().max(81),
    who: fieldName,
    opens: fieldName,
    closes: fieldName,
    live: z.array(z.string().min(1).max(100)).min(1).max(20),
  })
  .strict();
export type ChecklistsManifest = z.infer<typeof checklistsManifestSchema>;

/** Reports problems with `objects.<name>.checklists` through `contract`. */
export function checkObjectChecklists(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const declared = object.checklists;
  if (!declared) return;
  const at = `objects.${name}.checklists`;
  const own = (o: ObjectManifest, local: string): FieldManifest | undefined =>
    Object.hasOwn(o.fields, local) ? o.fields[local] : undefined;
  const single = (field: FieldManifest | undefined, types: readonly string[]) =>
    field !== undefined && types.includes(field.type) && !field.many;

  // The template: a checklist field of this object, or of what a relation of it names.
  const [first, second, ...rest] = declared.template.split(".");
  if (first === undefined || rest.length) {
    contract(`${at}.template`, `"${declared.template}" must be a field, or relation.field`);
  } else if (second === undefined) {
    if (!single(own(object, first), ["checklist"])) {
      contract(`${at}.template`, `"${first}" must be a checklist field of ${name}`);
    }
  } else {
    const via = own(object, first);
    const target = via?.type === "relation" && !via.many ? via.to : undefined;
    const local = target?.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    const holder = local && Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    if (!holder || local === name) {
      contract(
        `${at}.template`,
        `"${first}" must be a relation field (one record) to another of this extension's objects`,
      );
    } else if (!single(own(holder, second), ["checklist"])) {
      contract(`${at}.template`, `"${second}" must be a checklist field of ${target as string}`);
    }
  }

  // Who ticks it.
  if (!single(own(object, declared.who), ["user"])) {
    contract(`${at}.who`, `"${declared.who}" must be a user field of ${name}`);
  }

  // When it opens and closes.
  for (const key of ["opens", "closes"] as const) {
    if (!single(own(object, declared[key]), ["datetime"])) {
      contract(`${at}.${key}`, `"${declared[key]}" must be a datetime field of ${name}`);
    }
  }
  if (declared.opens === declared.closes) {
    contract(`${at}.closes`, "A checklist opens and closes at two fields");
  }

  // The states in which it applies.
  const states = object.states;
  if (!states) {
    contract(`${at}.live`, `${name} must declare states: a checklist applies in some of them`);
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
}
