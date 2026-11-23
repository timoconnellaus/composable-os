// The kind of work a shift is of (stage 45, ADR 0622): the object its `kind` relation points to.
import type { ObjectDefinition } from "../fields/types.ts";

/** The object a staffed object's kinds are records of (a class type), or null. */
export function kindObjectOf(object: ObjectDefinition): string | null {
  const def = object.staffed;
  return (def && object.fields.find((f) => f.name === def.kind)?.options?.to) || null;
}
