// A customer's own open records, counted (stage 48 step 6, ADR 0713): what deleting their account
// leaves for staff's erase. For each object that declares a customer, how many live rows have the
// caller's own Person in its customer field (never a dependant's, never what is shared with
// them) and are not in a state no move leaves. A record a subscription they pay granted (a
// membership, ADR 0510) follows that subscription and is not counted: deleting ends the
// subscription, or leaves it for staff as a subscription. Counts only: no field of any record
// is read.
//
// One statement per OBJECTS_PER_STATEMENT objects, each object costing two bound variables (the
// Person id, twice); state names and object names are the registry's own, written as literals.
// Each object's count is a column of one row, not a term of a compound SELECT: D1 limits a
// compound's terms (as me.portal's reads, stage 48 step 7 found it with many packs installed).
import { sql } from "kysely";
import { listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { customerScope } from "./customer.ts";
import type { Reader } from "./index.ts";

const OBJECTS_PER_STATEMENT = 40;

/** The states of `object` that no move leaves: a record in one is finished, not open. */
export function finishedStates(object: ObjectDefinition): string[] {
  const states = object.states;
  if (!states) return [];
  const all = new Set<string>([states.initial]);
  const left = new Set<string>();
  for (const move of states.moves) {
    all.add(move.to);
    for (const from of typeof move.from === "string" ? [move.from] : move.from) {
      all.add(from);
      left.add(from);
    }
  }
  return [...all].filter((state) => !left.has(state));
}

export interface OwnOpenRecords {
  object: string;
  /** The object's label, or its plural when there is more than one. */
  label: string;
  count: number;
}

/**
 * The caller's own open records of every object that declares a customer, by object, leaving out
 * the Person itself and objects with none. Empty for anyone but a customer.
 */
export async function countOwnOpenRecords(ctx: Reader): Promise<OwnOpenRecords[]> {
  const principal = ctx.principal;
  if (principal.kind !== "customer") return [];
  const parts: { object: ObjectDefinition; query: ReturnType<typeof sql> }[] = [];
  for (const object of listObjects()) {
    // The Person is its own customer (`id`): not a record they hold.
    if (!object.customer || object.customer.field === "id") continue;
    const scope = customerScope(object, principal.personId);
    if (!scope) continue;
    const stateColumn = object.states
      ? object.fields.find((f) => f.name === object.states?.field)?.column
      : undefined;
    const finished = finishedStates(object);
    const open =
      stateColumn && finished.length
        ? sql`AND (${sql.ref(stateColumn)} IS NULL OR ${sql.ref(stateColumn)} NOT IN (${sql.join(
            finished.map((state) => sql.lit(state)),
          )}))`
        : sql``;
    parts.push({
      object,
      query: sql`SELECT count(*) FROM ${sql.table(
        object.source,
      )} WHERE ${sql.ref(scope.column)} = ${principal.personId} ${open} AND id NOT IN (SELECT g.record_id FROM core_subscription_grant g JOIN core_subscription s ON s.id = g.subscription_id WHERE g.object_type = ${sql.lit(object.name)} AND s.payer_person_id = ${principal.personId})`,
    });
  }
  const out: OwnOpenRecords[] = [];
  for (let i = 0; i < parts.length; i += OBJECTS_PER_STATEMENT) {
    const chunk = parts.slice(i, i + OBJECTS_PER_STATEMENT);
    const result = await sql<Record<string, number>>`SELECT ${sql.join(
      chunk.map((part, n) => sql`(${part.query}) AS ${sql.ref(`c${n}`)}`),
    )}`.execute(ctx.db);
    const row = result.rows[0] ?? {};
    for (const [n, part] of chunk.entries()) {
      const count = Number(row[`c${n}`] ?? 0);
      const object = part.object;
      if (!count) continue;
      out.push({
        object: object.name,
        label: count === 1 ? object.label : (object.plural ?? object.label),
        count,
      });
    }
  }
  return out.sort((a, b) => a.object.localeCompare(b.object));
}
