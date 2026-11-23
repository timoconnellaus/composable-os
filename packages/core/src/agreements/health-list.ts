// A pack's declared health-note list (stage 44, ADR 0643): which object's records make a list,
// the list's own object, and the columns the host reads the People from. Read by
// agreement.listHealthNotes and by a pack role's today limits (pack-role-today.ts).
import { getObject } from "../fields/index.ts";
import { viewColumnOf } from "../records/columns.ts";

/**
 * An object's declared health-note list (ADR 0643): the object, the list's own object its `list`
 * relation points to, and the view columns of that relation and of `person`. Null when the object
 * declares none, or a field is not what install checked.
 */
export function healthListOf(name: string) {
  const object = getObject(name);
  const declared = object?.healthNotes;
  if (!object || !declared) return null;
  const list = object.fields.find((f) => f.name === declared.list);
  const who = object.fields.find((f) => f.name === declared.person);
  const to = list?.fieldType === "relation" && !list.options?.many ? list.options?.to : undefined;
  const parent = typeof to === "string" ? getObject(to) : undefined;
  const listColumn = list ? viewColumnOf(list) : null;
  const personColumn =
    who?.fieldType === "relation" && who.options?.to === "person" && !who.options.many
      ? viewColumnOf(who)
      : null;
  if (!parent || !listColumn || !personColumn) return null;
  return { object, parent, listColumn, personColumn };
}
