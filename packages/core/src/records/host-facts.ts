// Host facts (ADR 0750): read-only fields a stage rule waits on, such as the time a quote was
// accepted. Two things keep "nobody moves a job into Accepted by hand" true beyond one write:
//   - who writes a fact: the host, or the declaring extension through a tool only a person may
//     call or approve (`personsTool`, as for a holder's terms, ADR 0513); never its other code
//     (record.ts, prepareValues);
//   - who changes the stages that wait on it: an admin, in person, or the host. A stage's rules,
//     type, title and order are records, so a member or an AI that could edit them could drop
//     the fact from Accepted, or make a stage of its own called Accepted, and then move the job.
import { ForbiddenError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { callerOf, type Mover } from "./transitions.ts";

/** Fields the stage behaviour keeps itself; never a fact a rule waits on. */
function keptByBehaviour(object: ObjectDefinition): Set<string> {
  const stages = object.stages;
  return new Set(
    [
      stages?.status,
      stages?.closedDate,
      stages?.probability?.field,
      stages?.probability?.overridden,
    ].filter((f): f is string => f !== undefined),
  );
}

/** The stage object `object`'s stages are records of, when installed. */
function stageObjectOf(object: ObjectDefinition): ObjectDefinition | undefined {
  const to = object.stages
    ? object.fields.find((f) => f.name === object.stages?.field)?.options?.to
    : undefined;
  return to ? getObject(to) : undefined;
}

/**
 * The host facts of an object with `stages`: its read-only, non-formula fields that a stage may
 * require (an option of the stage's required fields, or `requiredByType`).
 */
export function stageFacts(object: ObjectDefinition): ReadonlySet<string> {
  const stages = object.stages;
  if (!stages) return new Set();
  const named = new Set<string>(Object.values(stages.requiredByType ?? {}).flat());
  const requiredField = stages.stage.requiredFields;
  const options = requiredField
    ? stageObjectOf(object)?.fields.find((f) => f.name === requiredField)?.options?.choices
    : undefined;
  for (const option of options ?? []) named.add(option.value);
  const kept = keptByBehaviour(object);
  // In the object's field order.
  return new Set(
    object.fields
      .filter(
        (f) => named.has(f.name) && f.readOnly && f.fieldType !== "formula" && !kept.has(f.name),
      )
      .map((f) => f.name),
  );
}

/** The objects whose stages are records of `stageObject` and wait on host facts. */
function gatedBy(stageObject: ObjectDefinition): { object: string; facts: string[] }[] {
  const out: { object: string; facts: string[] }[] = [];
  for (const object of listObjects()) {
    if (!object.stages) continue;
    const to = object.fields.find((f) => f.name === object.stages?.field)?.options?.to;
    if (to !== stageObject.name) continue;
    const facts = [...stageFacts(object)];
    if (facts.length) out.push({ object: object.name, facts });
  }
  return out;
}

/**
 * Refuses a create, update, Trash or restore of a stage record whose stages wait on host facts,
 * unless it is the host's or an admin's own, made in person (not an assistant, MCP client,
 * automation or extension acting for them). Seeds are inserted at install and are not writes.
 */
export function assertMayChangeGatedStages(
  ctx: HandlerContext,
  object: ObjectDefinition,
  by: Mover | undefined,
): void {
  if (by === "host") return;
  const gated = gatedBy(object);
  if (!gated.length) return;
  const caller = callerOf(ctx);
  if (ctx.actor === "human" && caller.kind === "staff" && ctx.user.role === "admin") return;
  throw new ForbiddenError(
    `${object.plural ?? object.label} decide when a record waits on what the platform records, so only an admin changes them, in person`,
    { rule: "stage_settings_admin_only", object: object.name, gates: gated },
  );
}
