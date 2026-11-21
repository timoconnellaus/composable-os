// The visibility seam (ADR 0244, ADR 0402, ADR 0410): the one place that decides which records a
// caller may read. Every read of a record takes its source from here, so a rule added here holds
// for every list, get, count, export and lookup at once.
//
// This is the seam's first door. Staff have the scope `all`: the plain view, no predicate, the
// same SQL and the same `rows_read` as before the seam (test/visibility-staff-unchanged.test.ts).
// A customer has the rows whose declared customer field is their own Person, and of those only
// the fields the object lists (customer.ts). The public has the rows an object's `public`
// declaration lets them read, and of those only the fields it lists (public.ts, ADR 0438); so
// does a customer on an object that declares no customer. Anyone else, on any other object, has
// nothing: for them the object does not exist.
// Stage 14a adds staff scopes (own, own team), the rewrite of user SQL and search hydration to
// this module. It must extend this seam and not add a second one.
//
// test/visibility-one-seam.test.ts fails when code outside this folder reads a rec_* view or a
// core record table and is not on its list of reads still to be moved.
import type { CoreDatabase } from "@composable-os/db";
import { type AliasedRawBuilder, type Kysely, type RawBuilder, sql } from "kysely";
import { ident } from "../extensions/naming.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { BASE_TABLES, type CoreObjectName, getObject, isCoreObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type Principal, staffPrincipal } from "../principals.ts";
import { type CustomerScope, customerObject, customerScope, unknownObject } from "./customer.ts";
import {
  type Condition,
  type PublicScope,
  publicObject,
  publicScope,
  signedInScope,
} from "./public.ts";
import { customerViaScope, type ViaScope, viaObject } from "./via.ts";

export { type CustomerScope, customerProblems } from "./customer.ts";
export { type PublicScope, publicProblems, signedInProblems } from "./public.ts";
export { customerViaProblems, type ViaScope } from "./via.ts";

/** Who is reading. A handler's context is one. */
export interface Viewer {
  readonly principal: Principal;
}

/** A viewer with a database to read from: what helpers that load records take. */
export interface Reader extends Viewer {
  readonly db: Kysely<CoreDatabase>;
}

/**
 * What a caller may see of one object.
 * - `all`: every row and every field. Staff, until stage 14a restricts an object.
 * - `customer`: the rows whose customer field is the caller's Person, the listed fields only.
 * - `public`: the rows the object's `public` declaration covers, its listed fields only.
 * - `via`: for a customer, the rows one of their own records points to, the fields the object's
 *   `customerVia` lists, and what the public may read of it too (ADR 0439).
 * - `none`: nothing. The object does not exist for this caller.
 */
export type Scope =
  | { readonly kind: "all" }
  | CustomerScope
  | PublicScope
  | ViaScope
  | { readonly kind: "none" };

const NONE: Scope = Object.freeze({ kind: "none" });

/**
 * The caller's scope for `object`. Pure: it reads nothing. `throughOwnRecords: false` leaves out
 * what a customer reads only through their own records (ADR 0439): what they may buy is what
 * they may read as their own or as the public, never a ticket type they hold a ticket of.
 */
export function scopeOf(
  principal: Principal,
  given: ObjectDefinition,
  throughOwnRecords = true,
): Scope {
  // Always the registry's own definition: a narrowed copy (visibleObject) names the same object.
  const object = getObject(given.name) ?? given;
  switch (principal.kind) {
    case "staff":
      return { kind: "all" };
    case "customer":
      // Their own records (with any shared beside them); else, through their own records, the
      // ones those point to (ADR 0439, with what every signed-in customer or the public may read
      // of the object beside them); else what every signed-in customer may read (ADR 0447); else
      // at least what the public may.
      return (
        customerScope(object, principal.personId) ??
        (throughOwnRecords ? customerViaScope(object, principal.personId) : null) ??
        signedInScope(object) ??
        publicScope(object) ??
        NONE
      );
    case "public":
      return publicScope(object) ?? NONE;
    default:
      // A principal this code does not know sees nothing.
      return NONE;
  }
}

/**
 * The object as the caller may see it: for staff the definition itself; for a customer only `id`
 * and the fields the object lists as readable, so a filter or sort on any other field fails as
 * it does for a field that does not exist. Throws the unknown-object error when the caller may
 * see nothing of it, or when there is no such object: the two are one answer.
 */
export function visibleObject(ctx: Viewer, object: string | ObjectDefinition): ObjectDefinition {
  const definition = typeof object === "string" ? getObject(object) : object;
  if (!definition) throw unknownObject(String(object));
  const scope = scopeOf(ctx.principal, definition);
  switch (scope.kind) {
    case "all":
      return definition;
    case "customer":
      return customerObject(definition, scope);
    case "public":
      return publicObject(definition, scope);
    case "via":
      return viaObject(definition, scope);
    case "none":
      throw unknownObject(definition.name);
  }
}

/** The read views of the core objects, and the tables behind them. */
const CORE_SOURCES = {
  person: { view: "rec_person", table: "core_person" },
  organisation: { view: "rec_organisation", table: "core_organisation" },
  activity: { view: "rec_activity", table: "core_activity" },
  task: { view: "rec_task", table: "core_task" },
} as const satisfies Record<
  CoreObjectName,
  { view: keyof CoreDatabase; table: keyof CoreDatabase }
>;

type CoreView<N extends CoreObjectName> = (typeof CORE_SOURCES)[N]["view"];
type CoreTable<N extends CoreObjectName> = (typeof CORE_SOURCES)[N]["table"];

/** A source for `selectFrom(...)`, or to interpolate after FROM or JOIN in a `sql` template. */
export type VisibleSource<Row, Alias extends string> = AliasedRawBuilder<Row, Alias>;

/** Rows of an object the registry knows only at run time (extension objects). */
export type AnyRow = Record<string, unknown>;

function resolve(object: CoreObjectName | ObjectDefinition): ObjectDefinition {
  if (typeof object !== "string") return object;
  const definition = getObject(object);
  if (!definition) throw new Error(`Unknown object ${object}`);
  return definition;
}

/**
 * Door 1: the object's `rec_*` view (live records), filtered for the caller. Use it wherever a
 * record is read: `ctx.db.selectFrom(visibleSource(ctx, "person"))`, or
 * sql`SELECT … FROM ${visibleSource(ctx, object)}`. The source is aliased as the view's own name
 * unless `alias` is given, so column references such as `rec_person.id` keep working.
 *
 * A core object named by a string is typed as its view; an `ObjectDefinition` (any object,
 * including extension objects) gives untyped rows.
 */
export function visibleSource<N extends CoreObjectName>(
  ctx: Viewer,
  object: N,
): VisibleSource<CoreDatabase[CoreView<N>], CoreView<N>>;
export function visibleSource<N extends CoreObjectName, A extends string>(
  ctx: Viewer,
  object: N,
  alias: A,
): VisibleSource<CoreDatabase[CoreView<N>], A>;
export function visibleSource(
  ctx: Viewer,
  object: ObjectDefinition,
  alias?: string,
): VisibleSource<AnyRow, string>;
export function visibleSource(
  ctx: Viewer,
  object: CoreObjectName | ObjectDefinition,
  alias?: string,
): VisibleSource<AnyRow, string> {
  const definition = resolve(object);
  return sourceOf(scopeOf(ctx.principal, definition), definition, alias ?? definition.source);
}

/**
 * The records of `object` a customer or the public may buy: what they may read as their own or
 * as the public, and not what they read only through their own records (ADR 0439). A holder
 * still reads the ticket type of their ticket once its event is no longer on sale; they cannot
 * buy another. Staff: every record, as `visibleSource`.
 */
export function buyableSource(
  ctx: Viewer,
  object: ObjectDefinition,
): VisibleSource<AnyRow, string> {
  const definition = resolve(object);
  return sourceOf(scopeOf(ctx.principal, definition, false), definition, definition.source);
}

/**
 * The predicate of a `via` scope: the records one of the caller's own records points to
 * (ADR 0439). Their own records are the `from` object's rows whose customer column is their
 * Person, exactly as that object's customer scope has them; the person id is a bound parameter.
 */
function reachedWhere(scope: ViaScope): RawBuilder<unknown> {
  const { link } = scope;
  return sql`id IN (SELECT ${sql.ref(link.pointer)} FROM ${sql.table(link.source)} WHERE ${sql.ref(link.owner)} = ${scope.personId} AND ${sql.ref(link.pointer)} IS NOT NULL)`;
}

function sourceOf(
  scope: Scope,
  definition: ObjectDefinition,
  name: string,
): VisibleSource<AnyRow, string> {
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(definition.source)}`.as(name);
    case "customer": {
      // Only the caller's rows, and only the listed columns: a column that is not listed is not
      // in the source at all, so no filter, sort or select can reach it. Registry columns are
      // trusted identifiers (fields/types.ts); the person id is a bound parameter.
      const own = sql`${sql.ref(scope.column)} = ${scope.personId}`;
      if (!scope.shared) {
        const columns = sql.join(scope.columns.map((column) => sql.ref(column)));
        return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${own})`.as(
          name,
        );
      }
      // With records shared with every signed-in customer (ADR 0447): those too, showing only
      // the columns `signedIn.read` lists unless the row is also the caller's own.
      const { shared } = scope;
      const columns = sql.join(
        scope.columns.map((column) =>
          shared.columns.has(column)
            ? sql.ref(column)
            : sql`CASE WHEN ${own} THEN ${sql.ref(column)} END AS ${sql.ref(column)}`,
        ),
      );
      return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${own} OR ${conditionSql(shared.condition)})`.as(
        name,
      );
    }
    case "public": {
      // Only the records meeting `when`, and only the listed columns (ADR 0438).
      const columns = sql.join(scope.columns.map((column) => sql.ref(column)));
      return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${conditionSql(scope.condition)})`.as(
        name,
      );
    }
    case "via": {
      // The records the caller's own records point to, with the fields `customerVia` lists; and,
      // on an object that is public too, the public records with the public's fields. A column
      // only one of the two lists carries its value only on the records that one covers: a
      // column that neither lists is not in the source at all (ADR 0439).
      const reached = reachedWhere(scope);
      const shared = scope.public ? conditionSql(scope.public.condition) : null;
      const columns = sql.join(
        scope.columns.map(({ column, shownOn }) =>
          shownOn === "both" || !shared
            ? sql.ref(column)
            : sql`CASE WHEN ${shownOn === "reached" ? reached : shared} THEN ${sql.ref(column)} END AS ${sql.ref(column)}`,
        ),
      );
      const where = shared ? sql`(${reached}) OR (${shared})` : reached;
      return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${where})`.as(
        name,
      );
    }
    case "none":
      throw unknownObject(definition.name);
  }
}

/** A `when` condition as SQL over the object's view: values bound, columns trusted. */
function conditionSql(condition: Condition | null) {
  if (!condition) return sql`1 = 1`;
  const values = sql.join(condition.values.map((value) => sql`${value}`));
  return condition.via
    ? sql`${sql.ref(condition.column)} IN (SELECT id FROM ${sql.table(condition.via.source)} WHERE ${sql.ref(condition.via.column)} IN (${values}))`
    : sql`${sql.ref(condition.column)} IN (${values})`;
}

/**
 * The ids of the records of `object` that are the caller's own: for a customer, the rows whose
 * customer field is their Person, without what is shared with them (ADR 0447); for staff, every
 * live row. What a customer may change is read from here, never from what they may only read.
 * Anyone else has none.
 */
export function ownedSource(
  ctx: Viewer,
  object: ObjectDefinition,
  alias?: string,
): VisibleSource<AnyRow, string> {
  const scope = scopeOf(ctx.principal, object);
  const name = alias ?? object.source;
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(object.source)}`.as(name);
    case "customer":
      return sql<AnyRow>`(SELECT id FROM ${sql.table(object.source)} WHERE ${sql.ref(scope.column)} = ${scope.personId})`.as(
        name,
      );
    default:
      throw unknownObject(object.name);
  }
}

/**
 * The table behind an object, with its soft-deleted rows: for the loads that need them (a get
 * that may include the Trash, the snapshot before a write). Staff only: a customer and the
 * public are refused. Prefer `visibleSource` for anything that only reads live records.
 */
export function visibleTable<N extends CoreObjectName>(
  ctx: Viewer,
  object: N,
): VisibleSource<CoreDatabase[CoreTable<N>], CoreTable<N>>;
export function visibleTable<N extends CoreObjectName, A extends string>(
  ctx: Viewer,
  object: N,
  alias: A,
): VisibleSource<CoreDatabase[CoreTable<N>], A>;
export function visibleTable(
  ctx: Viewer,
  object: ObjectDefinition,
  alias?: string,
): VisibleSource<AnyRow, string>;
export function visibleTable(
  ctx: Viewer,
  object: CoreObjectName | ObjectDefinition,
  alias?: string,
): VisibleSource<AnyRow, string> {
  const definition = resolve(object);
  const table = isCoreObject(definition.name)
    ? CORE_SOURCES[definition.name].table
    : Object.hasOwn(BASE_TABLES, definition.name)
      ? BASE_TABLES[definition.name as keyof typeof BASE_TABLES]
      : objectTableOf(definition.name);
  if (!table) throw new Error(`${definition.name} has no record table`);
  const scope = scopeOf(ctx.principal, definition);
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(ident(table))}`.as(alias ?? table);
    default:
      // Tables hold the Trash and every column. Only staff read them.
      throw unknownObject(definition.name);
  }
}

/**
 * The reader for work that acts for the whole org and has no caller: scheduled jobs, the
 * automation runner, embedding and digests (ADR 0244: automations act org-wide). Never use it in
 * an operation handler, which always has a caller: pass the handler's context.
 */
export function orgReader(db: Kysely<CoreDatabase>): Reader {
  return { db, principal: ORG_PRINCIPAL };
}

const ORG_PRINCIPAL: Principal = staffPrincipal({ id: "system", role: "admin" });
