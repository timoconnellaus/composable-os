// A pack role's "mine" reach (stage 39 step 3, ADR 0755): a role may declare, by object, the
// records of its pack that name its holder and lead to that object (`mine: { "jobs.job": {
// through: "jobs.assignment", who: "staff", path: "visit.job", live: [...], within: { from:
// "starts", to: "ends", days: 7 } } }`). While a call carries the limit (the account holds the
// role, or a tool run it started, nested runs included), a record of such an object is reached
// only when a live record of `through` names the account in `who`, falls inside its window, and
// leads to it along `path`: a crew account reaches the jobs on which it has a crew place, from a
// week before the visit to a week after. The limit is held before the operation runs:
//   - record.list: a predicate in the list's own query (`mineWhere`), a subquery from `through`
//     along the path, binding the account, the live states and the window's two ends;
//   - record.get, record.update: the stored record must be reached, else it is not found;
//   - record.create of a limited object or of a `through` object: refused (a new record is
//     reached by nobody yet, and a new `through` record naming the account would widen it);
//   - record.update writing a field that decides the reach (`who`, a path's relation, the live
//     states' field, the window's datetimes), on any object: refused;
//   - a tool runs (its own calls are held in turn), and so do the account's own core operations
//     (`screens.mine`, `ack.*`); every other operation is refused, whatever it names.
// Nobody else is limited, and nothing is cached: the reach follows the records on the next call.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, type RawBuilder, type SqlBool, sql } from "kysely";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { getObject } from "./fields/index.ts";
import type { ObjectDefinition } from "./fields/types.ts";
import { PACK_ROLE_CORE_READS, PACK_ROLE_OWN } from "./pack-roles.ts";
import { viewColumnOf } from "./records/columns.ts";

/** The record operations the limit understands: a list, a get, an update and a create. */
const CHECKED: ReadonlySet<string> = new Set([
  "record.list",
  "record.get",
  "record.update",
  "record.create",
]);

/** Operations that read or write no record of anyone's: the account's own (pack-roles.ts). */
const LIMIT_PASSES: ReadonlySet<string> = new Set([...PACK_ROLE_CORE_READS, ...PACK_ROLE_OWN]);

const DAY_MS = 86_400_000;

/** How the role reaches one object, as its pack declares it (`mine`, ADR 0755). */
export interface MineReach {
  /** `<extension>.<object>` whose records name the holder. */
  readonly through: string;
  /** Its user field naming the holder. */
  readonly who: string;
  /** The relations from `through` to the object reached; empty: `through` itself. */
  readonly path: readonly string[];
  /** Its states field and the states in which it counts; absent: every record counts. */
  readonly live?: { readonly field: string; readonly states: readonly string[] };
  /** A window around its own datetimes, in days either side. */
  readonly within?: { readonly from: string; readonly to?: string; readonly days: number };
}

/** The limit one call carries: the account it is for, and the role's reach by object. */
export interface MineLimit {
  readonly userId: string;
  readonly reach: Readonly<Record<string, MineReach>>;
}

const fieldOf = (object: ObjectDefinition, name: string) =>
  object.fields.find((f) => f.name === name);

const columnOf = (object: ObjectDefinition, name: string): string | null => {
  const field = fieldOf(object, name);
  return field ? viewColumnOf(field) : null;
};

/**
 * The ids of `objectName`'s records the account reaches, as a subquery, or null when the reach
 * names something the registry cannot read (fail closed: nothing). One SELECT: `through`, joined
 * along the path, its last relation's column. Bound: the account, the live states (at most
 * twenty) and the window's two ends.
 */
function reachedIds(limit: MineLimit, objectName: string, now: number): RawBuilder<unknown> | null {
  if (!Object.hasOwn(limit.reach, objectName)) return null;
  const reach = limit.reach[objectName] as MineReach;
  const through = getObject(reach.through);
  if (!through) return null;
  const who = columnOf(through, reach.who);
  const state = reach.live ? columnOf(through, reach.live.field) : null;
  const from = reach.within ? columnOf(through, reach.within.from) : null;
  const to = reach.within?.to ? columnOf(through, reach.within.to) : from;
  if (!who || (reach.live && !state) || (reach.within && (!from || !to))) return null;

  // Walk the path: each step a relation of the object before it.
  const joins: RawBuilder<unknown>[] = [];
  let current = through;
  let selected = sql.ref("m0.id");
  for (const [i, step] of reach.path.entries()) {
    const field = fieldOf(current, step);
    const column = field ? viewColumnOf(field) : null;
    const to = field?.options?.to ? getObject(field.options.to) : undefined;
    if (!column || !to || field?.options?.many) return null;
    selected = sql.ref(`m${i}.${column}`);
    if (i < reach.path.length - 1) {
      // The next object's record must exist and be out of the Trash (its view holds no other).
      joins.push(
        sql` JOIN ${sql.table(to.source)} AS ${sql.raw(`m${i + 1}`)} ON ${sql.ref(`m${i + 1}.id`)} = ${sql.ref(`m${i}.${column}`)}`,
      );
    }
    current = to;
  }
  if (current.name !== objectName) return null;

  const live =
    reach.live && state
      ? sql` AND ${sql.ref(`m0.${state}`)} IN (${sql.join(reach.live.states.map((s) => sql`${s}`))})`
      : sql``;
  const within =
    reach.within && from && to
      ? sql` AND julianday(${sql.ref(`m0.${from}`)}) <= julianday(${new Date(now + reach.within.days * DAY_MS).toISOString()}) AND julianday(COALESCE(${sql.ref(`m0.${to}`)}, ${sql.ref(`m0.${from}`)})) >= julianday(${new Date(now - reach.within.days * DAY_MS).toISOString()})`
      : sql``;
  return sql`SELECT ${selected} FROM ${sql.table(through.source)} AS m0${sql.join(joins, sql``)} WHERE ${sql.ref(`m0.${who}`)} = ${limit.userId}${live}${within}`;
}

/**
 * The predicate a list of `objectName` holds under the limit, over its source aliased `alias`, or
 * undefined when the object is not limited (or there is no limit).
 */
export function mineWhere(
  limit: MineLimit | null | undefined,
  objectName: string,
  alias: string,
  now: number,
): RawBuilder<SqlBool> | undefined {
  if (!limit || !Object.hasOwn(limit.reach, objectName)) return undefined;
  const ids = reachedIds(limit, objectName, now);
  if (!ids) return sql<SqlBool>`1 = 0`;
  return sql<SqlBool>`${sql.ref(`${alias}.id`)} IN (${ids})`;
}

/** Whether the stored record `id` of the limited object is reached. */
async function reachable(
  db: Kysely<CoreDatabase>,
  limit: MineLimit,
  objectName: string,
  id: string,
  now: number,
): Promise<boolean> {
  const object = getObject(objectName);
  const where = mineWhere(limit, objectName, "r", now);
  if (!object || !where) return false;
  const { rows } = await sql<{ found: number }>`
    SELECT 1 AS found FROM ${sql.table(object.source)} AS r WHERE r.id = ${id} AND ${where}
  `.execute(db);
  return rows.length > 0;
}

/** The fields of `objectName` whose change would change what the role reaches. */
function decidingFields(limit: MineLimit, objectName: string): Set<string> {
  const fields = new Set<string>();
  for (const reach of Object.values(limit.reach)) {
    if (reach.through === objectName) {
      fields.add(reach.who);
      if (reach.live) fields.add(reach.live.field);
      if (reach.within) {
        fields.add(reach.within.from);
        if (reach.within.to) fields.add(reach.within.to);
      }
    }
    // Each step of the path is a relation of the object before it.
    let current = getObject(reach.through);
    for (const step of reach.path) {
      if (!current) break;
      if (current.name === objectName) fields.add(step);
      const to = fieldOf(current, step)?.options?.to;
      current = to ? getObject(to) : undefined;
    }
  }
  return fields;
}

/** Whether `objectName` is a `through` object of the limit: its new records would name someone. */
const namesHolders = (limit: MineLimit, objectName: string) =>
  Object.values(limit.reach).some((reach) => reach.through === objectName);

/**
 * Holds `limit` on one call, before it runs (a list's limit is its query's, `mineWhere`): throws
 * not found for a record the account does not reach, and forbidden for a create of a limited or
 * naming object, a change to what decides the reach, or any other operation.
 */
export async function holdRoleMine(
  db: Kysely<CoreDatabase>,
  limit: MineLimit | null | undefined,
  operation: string,
  input: unknown,
  now: number,
): Promise<void> {
  if (!limit) return;
  const refuse = (why: string, details: Record<string, unknown> = {}) =>
    new ForbiddenError(`${operation} is not open to this role: ${why}`, {
      rule: "role_mine",
      operation,
      ...details,
    });
  // Fail closed: under the limit, only the record operations it checks, a tool (its own calls are
  // held in turn), and the account's own core operations run. Anything else, whatever key its
  // input names a record by (`links`, `refs`, a batch, a count), is refused.
  if (!operation.startsWith("x.") && !LIMIT_PASSES.has(operation) && !CHECKED.has(operation)) {
    throw refuse("it reaches only the records that name its holder");
  }
  if (!CHECKED.has(operation)) return;
  const record = (input ?? {}) as Record<string, unknown>;
  const object = record.object;
  if (typeof object !== "string") return;
  const limited = Object.hasOwn(limit.reach, object);
  if (operation === "record.list") return;
  if (operation === "record.create") {
    if (limited || namesHolders(limit, object)) {
      throw refuse(`it creates no ${object} record`, { object });
    }
    return;
  }
  if (operation === "record.get" || operation === "record.update") {
    const id = String(record.id ?? "");
    if (limited && !(await reachable(db, limit, object, id, now))) {
      throw new NotFoundError(object, id);
    }
  }
  if (operation === "record.update") {
    const values = (record.values ?? {}) as Record<string, unknown>;
    const deciding = [...decidingFields(limit, object)].filter((f) => Object.hasOwn(values, f));
    if (deciding.length) {
      throw refuse(`${deciding.join(", ")} of ${object} decide what it reaches`, {
        object,
        fields: deciding,
      });
    }
  }
}
