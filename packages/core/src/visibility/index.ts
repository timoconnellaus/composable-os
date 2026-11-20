// The visibility seam (ADR 0244, ADR 0402, ADR 0410): the one place that decides which records a
// caller may read. Every read of a record takes its source from here, so a rule added here holds
// for every list, get, count, export and lookup at once.
//
// This is the seam's first door. Staff have the scope `all`: the plain view, no predicate, the
// same SQL and the same `rows_read` as before the seam (test/visibility-staff-unchanged.test.ts).
// Stage 14a adds staff scopes (own, own team), the rewrite of user SQL and search hydration to
// this module. It must extend this seam and not add a second one.
//
// test/visibility-one-seam.test.ts fails when code outside this folder reads a rec_* view or a
// core record table and is not on its list of reads still to be moved.
import type { CoreDatabase } from "@composable-os/db";
import { type AliasedRawBuilder, type Kysely, sql } from "kysely";
import { ident } from "../extensions/naming.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { type CoreObjectName, getObject, isCoreObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type Principal, staffPrincipal } from "../principals.ts";

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
 */
export type Scope = { readonly kind: "all" };

/** The caller's scope for `object`. Pure: it reads nothing. */
export function scopeOf(principal: Principal, _object: ObjectDefinition): Scope {
  switch (principal.kind) {
    case "staff":
      return { kind: "all" };
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
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(definition.source)}`.as(alias ?? definition.source);
  }
}

/**
 * The table behind an object, with its soft-deleted rows: for the loads that need them (a get
 * that may include the Trash, the snapshot before a write). Filtered for the caller like
 * `visibleSource`. Prefer `visibleSource` for anything that only reads live records.
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
    : objectTableOf(definition.name);
  if (!table) throw new Error(`${definition.name} has no record table`);
  const scope = scopeOf(ctx.principal, definition);
  switch (scope.kind) {
    case "all":
      return sql<AnyRow>`${sql.table(ident(table))}`.as(alias ?? table);
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
