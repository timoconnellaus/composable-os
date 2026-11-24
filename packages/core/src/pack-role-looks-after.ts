// A pack role limited to the People its holder looks after (ADR 0889): a role may declare, by
// object, the relation to the Person its records are about (`looksAfter: { "programs.session":
// "person" }`). Its holder looks after a Person when a live record of one of the role's pack's
// objects that declares a `team` names the account in one of its staff fields (ADR 0831: a
// client's assignment naming their coach). While a call carries the limit (the account holds the
// role, or a tool run it started, nested runs included), a record of such an object is reached
// only when it is about one of those People. The limit is held before the operation runs:
//   - record.list: a predicate in the list's own query (`looksAfterWhere`), a subquery over the
//     team's records with the account as one bound value, however many People it looks after;
//   - record.get, record.update: the stored record is checked, else it is not found; an update
//     that points the record at another Person must point it at one they look after;
//   - record.create: the new record's Person must be one they look after, else not found;
//   - a tool runs (its own calls are held in turn), and so do the account's own core operations
//     (`screens.mine`, `ack.*`) and the staff reads of published versions (`content.staffGet`,
//     `content.staffList`, `content.search`, ADR 0701) of an object the limit does not name;
//   - every other operation is refused, whatever it names, so one that
//     names records under another key (an activity's links, a task's refs, a batch) cannot pass.
// Nobody else is limited, and nothing is cached: ending the record ends the reach on the next call.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, type RawBuilder, type SqlBool, sql } from "kysely";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { getObject } from "./fields/index.ts";
import { PACK_ROLE_CORE_READS, PACK_ROLE_OWN, PACK_ROLE_STAFF_READS } from "./pack-roles.ts";
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

/** One object whose records say who looks after whom (`team`, ADR 0831), as the role's pack has it. */
export interface LooksAfterTeam {
  /** `<extension>.<object>`. */
  readonly object: string;
  /** Its relation to the Person. */
  readonly person: string;
  /** Its user fields naming who looks after them. */
  readonly staff: readonly string[];
  /** Its states field and the states in which it counts; absent: every record counts. */
  readonly live?: { readonly field: string; readonly states: readonly string[] };
}

/** What a pack role declares: the teams of its pack, and the objects it reaches through them. */
export interface LooksAfter {
  readonly teams: readonly LooksAfterTeam[];
  /** By object: its relation (one record) to the Person. */
  readonly reach: Readonly<Record<string, string>>;
}

/** The limit one call carries: the account whose People, and the role's declaration. */
export interface LooksAfterLimit extends LooksAfter {
  readonly userId: string;
}

const columnOf = (objectName: string, fieldName: string): string | null => {
  const field = getObject(objectName)?.fields.find((f) => f.name === fieldName);
  return field ? viewColumnOf(field) : null;
};

/**
 * The People `limit.userId` looks after, as a subquery of person ids, or null when no team can be
 * read (fail closed: nobody). One SELECT per team, joined by UNION; the account is a bound value
 * in each, and a live state list is at most twenty more.
 */
function peopleQuery(limit: LooksAfterLimit): RawBuilder<unknown> | null {
  const parts: RawBuilder<unknown>[] = [];
  for (const [i, team] of limit.teams.entries()) {
    const t = `la${i}`;
    const object = getObject(team.object);
    const person = columnOf(team.object, team.person);
    const staff = team.staff.map((f) => columnOf(team.object, f));
    const state = team.live ? columnOf(team.object, team.live.field) : null;
    if (!object || !person || staff.some((c) => !c) || (team.live && !state)) return null;
    const named = sql.join(
      (staff as string[]).map((c) => sql`${sql.ref(`${t}.${c}`)} = ${limit.userId}`),
      sql` OR `,
    );
    const live =
      team.live && state
        ? sql` AND ${sql.ref(`${t}.${state}`)} IN (${sql.join(team.live.states.map((s) => sql`${s}`))})`
        : sql``;
    parts.push(
      sql`SELECT ${sql.ref(`${t}.${person}`)} FROM ${sql.table(object.source)} AS ${sql.raw(t)} WHERE ${sql.ref(`${t}.${person}`)} IS NOT NULL AND (${named})${live}`,
    );
  }
  if (!parts.length) return null;
  return sql.join(parts, sql` UNION `);
}

/**
 * The predicate a list of `objectName` holds under the limit, over its source aliased `alias`, or
 * undefined when the object is not limited (or there is no limit).
 */
export function looksAfterWhere(
  limit: LooksAfterLimit | null | undefined,
  objectName: string,
  alias: string,
): RawBuilder<SqlBool> | undefined {
  if (!limit || !Object.hasOwn(limit.reach, objectName)) return undefined;
  const relation = columnOf(objectName, limit.reach[objectName] as string);
  const people = peopleQuery(limit);
  if (!relation || !people) return sql<SqlBool>`1 = 0`;
  return sql<SqlBool>`${sql.ref(`${alias}.${relation}`)} IN (${people})`;
}

/** Whether `personId` is one of the People the account looks after. */
async function looksAfterPerson(
  db: Kysely<CoreDatabase>,
  limit: LooksAfterLimit,
  personId: unknown,
): Promise<boolean> {
  const people = peopleQuery(limit);
  if (!people || typeof personId !== "string" || !personId) return false;
  const { rows } = await sql<{ found: number }>`
    SELECT 1 AS found WHERE ${personId} IN (${people})
  `.execute(db);
  return rows.length > 0;
}

/** Whether the stored record `id` of the limited object is about one of the account's People. */
async function reachable(
  db: Kysely<CoreDatabase>,
  limit: LooksAfterLimit,
  objectName: string,
  id: string,
): Promise<boolean> {
  const object = getObject(objectName);
  const where = looksAfterWhere(limit, objectName, "r");
  if (!object || !where) return false;
  const { rows } = await sql<{ found: number }>`
    SELECT 1 AS found FROM ${sql.table(object.source)} AS r WHERE r.id = ${id} AND ${where}
  `.execute(db);
  return rows.length > 0;
}

/**
 * Holds `limit` on one call, before it runs (a list's limit is its query's, `looksAfterWhere`):
 * throws not found for a record about someone else, and forbidden for any other operation naming
 * a limited object.
 */
export async function holdRoleLooksAfter(
  db: Kysely<CoreDatabase>,
  limit: LooksAfterLimit | null | undefined,
  operation: string,
  input: unknown,
): Promise<void> {
  if (!limit) return;
  // A published version every staff account reads (ADR 0701): of an object whose records the
  // limit is about, refused (fail closed); of any other, it reads no one's record.
  if (PACK_ROLE_STAFF_READS.includes(operation)) {
    const object = (input as { object?: unknown } | null)?.object;
    if (typeof object === "string" && !Object.hasOwn(limit.reach, object)) return;
    throw new ForbiddenError(
      `${operation} is not open to this role: it reaches the records of the people its holder looks after only`,
      { rule: "role_looks_after", operation },
    );
  }
  // Fail closed: under the limit, only the record operations it checks, a tool (its own calls are
  // held in turn), and the account's own core operations run. Anything else, whatever key its input
  // names a record by (`links`, `refs`, a batch), is refused.
  if (!operation.startsWith("x.") && !LIMIT_PASSES.has(operation)) {
    if (!CHECKED.has(operation)) {
      throw new ForbiddenError(
        `${operation} is not open to this role: it reaches the records of the people its holder looks after only`,
        { rule: "role_looks_after", operation },
      );
    }
  }
  if (!CHECKED.has(operation)) return;
  const record = (input ?? {}) as Record<string, unknown>;
  const object = record.object;
  if (typeof object !== "string" || !Object.hasOwn(limit.reach, object)) return;
  const relation = limit.reach[object] as string;
  const values = (record.values ?? {}) as Record<string, unknown>;
  if (operation === "record.list") return;
  if (operation === "record.get" || operation === "record.update") {
    const id = String(record.id ?? "");
    if (!(await reachable(db, limit, object, id))) throw new NotFoundError(object, id);
    if (
      operation === "record.update" &&
      Object.hasOwn(values, relation) &&
      !(await looksAfterPerson(db, limit, values[relation]))
    ) {
      throw new NotFoundError("person", String(values[relation] ?? ""));
    }
    return;
  }
  // record.create
  if (!(await looksAfterPerson(db, limit, values[relation]))) {
    throw new NotFoundError("person", String(values[relation] ?? ""));
  }
}
