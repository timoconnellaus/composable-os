// Generic reads through the visibility seam (ADR 0402, ADR 0412): a page of the records of any
// object the caller may see, or one of them, with only the fields the caller may see. This is
// what `my.list` and `my.get` are made of. Nothing here knows who the caller is: the seam does.
import { NotFoundError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { type ListInput, runListQuery } from "../list.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type AnyRow, type Reader, visibleObject, visibleSource } from "./index.ts";

/** A record as its caller may see it: only the fields their scope allows. */
export interface VisibleRecord {
  object: string;
  id: string;
  values: Record<string, unknown>;
}

function fieldValue(field: FieldDefinition, row: AnyRow): unknown {
  const column = viewColumnOf(field);
  const raw = column ? (row[column] ?? null) : null;
  if (!field.extension || !field.fieldType) return raw;
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
  return type === "formula"
    ? formulaFromStorage(field.options?.resultType, raw)
    : FIELD_TYPE_REGISTRY[type].fromStorage(raw as never);
}

function toRecord(object: ObjectDefinition, row: AnyRow): VisibleRecord {
  const values: Record<string, unknown> = {};
  for (const field of object.fields) {
    if (field.name !== "id") values[field.name] = fieldValue(field, row);
  }
  return { object: object.name, id: String(row.id), values };
}

/** One page of the caller's records of `object`. Filter and sort see only visible fields. */
export async function listVisible(
  ctx: Reader,
  object: string | ObjectDefinition,
  input: Pick<ListInput, "filter" | "sort" | "cursor" | "limit">,
): Promise<{ items: VisibleRecord[]; nextCursor: string | null }> {
  const visible = visibleObject(ctx, object);
  const page = await runListQuery<AnyRow & { id: string }>(ctx, visible, input);
  return { items: page.rows.map((row) => toRecord(visible, row)), nextCursor: page.nextCursor };
}

/** One of the caller's records. A record they may not see is a record that is not there. */
export async function getVisible(
  ctx: Reader,
  object: string | ObjectDefinition,
  id: string,
): Promise<VisibleRecord> {
  const visible = visibleObject(ctx, object);
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = await (ctx.db as any)
    .selectFrom(visibleSource(ctx, visible))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError(visible.name, id);
  return toRecord(visible, row as AnyRow);
}
