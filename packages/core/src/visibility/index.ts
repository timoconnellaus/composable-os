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
import { type AliasedRawBuilder, type Kysely, sql } from "kysely";
import { ident } from "../extensions/naming.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { BASE_TABLES, type CoreObjectName, getObject, isCoreObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type Principal, staffPrincipal } from "../principals.ts";
import { type CustomerScope, customerObject, customerScope, unknownObject } from "./customer.ts";
import { type PublicScope, publicObject, publicScope } from "./public.ts";

export { type CustomerScope, customerProblems } from "./customer.ts";
export { type PublicScope, publicProblems } from "./public.ts";

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
 * - `none`: nothing. The object does not exist for this caller.
 */
export type Scope =
  | { readonly kind: "all" }
  | CustomerScope
  | PublicScope
  | { readonly kind: "none" };

const NONE: Scope = Object.freeze({ kind: "none" });

/** The caller's scope for `object`. Pure: it reads nothing. */
export function scopeOf(principal: Principal, given: ObjectDefinition): Scope {
  // Always the registry's own definition: a narrowed copy (visibleObject) names the same object.
  const object = getObject(given.name) ?? given;
  switch (principal.kind) {
    case "staff":
      return { kind: "all" };
    case "customer":
      // A customer reads at least what the public may: an object declares one or the other.
      return customerScope(object, principal.personId) ?? publicScope(object) ?? NONE;
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
  const scope = scopeOf(ctx.principal, definition);
  const name = alias ?? definition.source;
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(definition.source)}`.as(name);
    case "customer": {
      // Only the caller's rows, and only the listed columns: a column that is not listed is not
      // in the source at all, so no filter, sort or select can reach it. Registry columns are
      // trusted identifiers (fields/types.ts); the person id is a bound parameter.
      const columns = sql.join(scope.columns.map((column) => sql.ref(column)));
      return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${sql.ref(scope.column)} = ${scope.personId})`.as(
        name,
      );
    }
    case "public": {
      // Only the records meeting `when`, and only the listed columns. With `via`, the record it
      // points to must meet it: a ticket type while its event is on sale (ADR 0438).
      const columns = sql.join(scope.columns.map((column) => sql.ref(column)));
      const { condition } = scope;
      const values = condition ? sql.join(condition.values.map((value) => sql`${value}`)) : null;
      const where = !condition
        ? sql`1 = 1`
        : condition.via
          ? sql`${sql.ref(condition.column)} IN (SELECT id FROM ${sql.table(condition.via.source)} WHERE ${sql.ref(condition.via.column)} IN (${values}))`
          : sql`${sql.ref(condition.column)} IN (${values})`;
      return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(definition.source)} WHERE ${where})`.as(
        name,
      );
    }
    case "none":
      throw unknownObject(definition.name);
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
