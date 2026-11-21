// Slugs (stage 28, ADR 0442): a record's address in its object. The host keeps a slug field
// unique among the object's live records (the reconciler's unique index refuses a second one,
// whatever wrote it; this module says so in words first), makes one from the title when a record
// is created without one, and keeps the old address of a published record whose slug changes as
// a redirect, so a link to it still finds it.
//
// Only staff write slugs: an object with one declares no customer (a publishable object may not),
// and the uniqueness read is the table's, which the seam gives staff only.
import { SLUG_MAX, SLUG_RE, slugify } from "@composable-os/sdk";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { fieldStorage } from "../extensions/schema.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { visibleTable } from "../visibility/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

/** The object's own slug fields. */
export function slugFields(object: ObjectDefinition): FieldDefinition[] {
  return object.fields.filter(
    (f) =>
      f.fieldType === "slug" &&
      f.extension !== undefined &&
      f.extension === object.extension &&
      fieldStorage(object.name, f.name)?.own === true,
  );
}

const empty = (value: unknown) => value === undefined || value === null || value === "";

/** The column of a slug field in the object's table. */
function columnOf(object: ObjectDefinition, field: FieldDefinition): string {
  const column = fieldStorage(object.name, field.name)?.column;
  if (!column) throw new Error(`${object.name}.${field.name} has no column`);
  return column;
}

/** Live records of `object` holding `slug` in `field`, other than `except`. */
async function holders(
  ctx: HandlerContext,
  object: ObjectDefinition,
  field: FieldDefinition,
  slug: string,
  except: string | null,
): Promise<string[]> {
  const column = columnOf(object, field);
  let query = (ctx.db as AnyDb)
    .selectFrom(visibleTable(ctx, object, "t"))
    .select("t.id")
    .where("t.deleted_at", "is", null)
    .where(sql.ref(`t.${column}`), "=", slug);
  if (except) query = query.where("t.id", "<>", except);
  const rows = await query.limit(1).execute();
  return rows.map((r) => String(r.id));
}

/** A free slug from `base`: itself, or `base-2`, `base-3`, … among the live records. */
async function freeSlug(
  ctx: HandlerContext,
  object: ObjectDefinition,
  field: FieldDefinition,
  base: string,
): Promise<string> {
  const column = columnOf(object, field);
  const rows = await (ctx.db as AnyDb)
    .selectFrom(visibleTable(ctx, object, "t"))
    .select(sql.ref(`t.${column}`).as("slug"))
    .where("t.deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb(sql.ref(`t.${column}`), "=", base),
        // `base` is letters, digits and hyphens: nothing LIKE treats as a wildcard.
        eb(sql.ref(`t.${column}`), "like", `${base}-%`),
      ]),
    )
    .execute();
  const taken = new Set(rows.map((r) => String(r.slug)));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ValidationError(`No free address for "${base}"`, { reason: "slug_taken" });
}

/**
 * A new record's slugs: a slug left empty is made from the title (or the object's name when the
 * title gives none); one given must not be any other live record's.
 */
export async function slugsForCreate(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fields = slugFields(object);
  if (!fields.length) return values;
  const out = { ...values };
  for (const field of fields) {
    const given = out[field.name];
    if (empty(given)) {
      const title = object.titleField ? out[object.titleField] : undefined;
      const local = object.name.split(".").pop() ?? "record";
      const base = slugify(typeof title === "string" ? title : "") || slugify(local) || "record";
      out[field.name] = await freeSlug(ctx, object, field, base);
      continue;
    }
    await assertFree(ctx, object, field, given, null);
  }
  return out;
}

/** An update's slugs: one changed must not be any other live record's. */
export async function assertSlugsFree(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  for (const field of slugFields(object)) {
    if (!Object.hasOwn(values, field.name) || empty(values[field.name])) continue;
    await assertFree(ctx, object, field, values[field.name], id);
  }
}

async function assertFree(
  ctx: HandlerContext,
  object: ObjectDefinition,
  field: FieldDefinition,
  value: unknown,
  except: string | null,
): Promise<void> {
  // A malformed one is refused by the field's own check, with its rule.
  if (typeof value !== "string" || value.length > SLUG_MAX || !SLUG_RE.test(value)) return;
  if ((await holders(ctx, object, field, value, except)).length) {
    throw new ValidationError(
      `${object.name}.${field.name}: "${value}" is another ${object.label.toLowerCase()}'s address`,
      { field: field.name, reason: "slug_taken", slug: value },
    );
  }
}

/**
 * The redirects a write of the object's publishable slug makes (ADR 0442): the slug a record now
 * holds is nobody's redirect, and the slug a record that has been published leaves behind
 * points to it. `before` is null on a create.
 */
export async function redirectWrites(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<CompiledQuery[]> {
  const field = object.publishable?.slug;
  if (!field) return [];
  const old = before?.[field];
  const now = after[field];
  if (before && old === now) return [];
  const writes: CompiledQuery[] = [];
  if (typeof now === "string" && now) {
    writes.push(
      CompiledQuery.raw("DELETE FROM core_slug_redirect WHERE object_type = ? AND slug = ?", [
        object.name,
        now,
      ]),
    );
  }
  if (typeof old === "string" && old && before && (await everPublished(ctx, object.name, id))) {
    writes.push(
      CompiledQuery.raw(
        "INSERT INTO core_slug_redirect (object_type, slug, record_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (object_type, slug) DO UPDATE SET record_id = excluded.record_id, created_at = excluded.created_at",
        [object.name, old, id, ctx.now],
      ),
    );
  }
  return writes;
}

async function everPublished(ctx: HandlerContext, object: string, id: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("core_publish_version")
    .select("version")
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
