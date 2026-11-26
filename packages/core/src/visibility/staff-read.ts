// Staff read (stage 38 step 2, ADR 0701): what every staff account reads of a publishable object
// that declares `staffRead`: the current published version, never the working copy. The seam's
// door for `content.staffGet` and `content.staffList` (operations/content.ts).
//
// The source is the object's live view (`pub_x_<ext>_<object>`, ADR 0442): one row per live record
// with a current version, its content columns that version's values. Of it only `id`, the content
// fields, the slug and the two published values (version and when) are in the source, so a
// filter, a sort or a field selection on anything else (a "must read", an owner, another
// extension's field, a formula of the working copy) fails as an unknown field does. A draft, an
// unpublished record and a deleted one are not in the source: not found, as a record that never
// existed. Only a staff caller has it; for anyone else the object does not exist.
//
// Names (stage 38 step 6, ADR 0708): an object may declare `publishable.staffNames`, single
// relation content fields to another object of its own pack (a procedure's section). A record is
// then given, beside its values, each related record's title (`names`), read from that object's
// live row: the one thing of it a staff reader is told, so a pack-role account, which reads
// nothing of the grouping object itself, need not ask for it.
import { sql } from "kysely";
import { liveViewOf, objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, PublishableDefinition } from "../fields/types.ts";
import { type ListInput, pageQuery } from "../list.ts";
import { viewColumnOf } from "../records/columns.ts";
import { jsonList } from "../records/common.ts";
import { unknownObject } from "./customer.ts";
import type { AnyRow, Reader, VisibleSource } from "./index.ts";
import { toRecord, type VisibleRecord } from "./records.ts";

/** A publishable object that declares staff read. */
export type StaffReadObject = ObjectDefinition & {
  publishable: PublishableDefinition & { staffRead: true };
};

/** The registry's object `name` when it declares staff read; null otherwise. */
export function staffReadObject(name: string): StaffReadObject | null {
  const object = getObject(name);
  if (!object?.publishable?.staffRead) return null;
  return object as StaffReadObject;
}

/** The published values every row carries beside the content (ADR 0446's fields). */
const PUBLISHED = ["publishedVersion", "publishedAt"] as const;

/** The fields a staff reader is given: id, the content fields, the slug and the published values. */
function readFields(object: StaffReadObject) {
  const names = new Set<string>([
    "id",
    ...object.publishable.content,
    ...(object.publishable.slug ? [object.publishable.slug] : []),
    ...PUBLISHED,
  ]);
  return object.fields.filter((f) => names.has(f.name) && viewColumnOf(f));
}

/**
 * The object as a staff reader sees it: only the fields `readFields` gives, so a filter or a sort
 * on anything else is an unknown field. Its default sort is the object's when it is one of them,
 * else newest published first.
 */
export function staffReadView(object: StaffReadObject): ObjectDefinition {
  const fields = readFields(object);
  const names = new Set(fields.map((f) => f.name));
  return {
    name: object.name,
    label: object.label,
    source: object.source,
    fields,
    defaultSort: names.has(object.defaultSort.field)
      ? object.defaultSort
      : { field: "publishedAt", direction: "desc" },
    ...(object.plural ? { plural: object.plural } : {}),
    ...(object.extension ? { extension: object.extension } : {}),
    ...(object.titleField && names.has(object.titleField) ? { titleField: object.titleField } : {}),
    publishable: object.publishable,
  };
}

/** The live view, with only the columns a staff reader is given. Staff only. */
export function staffReadSource(
  reader: Reader,
  object: StaffReadObject,
): VisibleSource<AnyRow, string> {
  if (reader.principal.kind !== "staff") throw unknownObject(object.name);
  const columns = sql.join(
    [...new Set(readFields(object).map((f) => viewColumnOf(f) as string))].map((c) => sql.ref(c)),
  );
  return sql<AnyRow>`(SELECT ${columns} FROM ${sql.table(liveViewOf(object.name))})`.as(
    object.source,
  );
}

/** A record as a staff reader is given it: its content and slug, the version and when. */
export interface PublishedRecord extends VisibleRecord {
  version: number;
  publishedAt: string;
  /** For each `staffNames` field naming a live record: that record's title. */
  names?: Record<string, string>;
}

/**
 * The titles of the records the `staffNames` fields of `records` name: one read per field, live
 * records only, the title field only. Each record is given `names` when the object declares any.
 */
async function withNames(
  reader: Reader,
  object: StaffReadObject,
  records: PublishedRecord[],
): Promise<PublishedRecord[]> {
  const fields = object.publishable.staffNames ?? [];
  if (!fields.length || !records.length) return records;
  const titles = new Map<string, Map<string, string>>();
  for (const name of fields) {
    const field = object.fields.find((f) => f.name === name);
    const to = field?.options?.to;
    const target = to ? getObject(to) : undefined;
    // The contract allows only a single relation to another object of the same pack; held again.
    if (!field || field.options?.many || !target || target.extension !== object.extension) continue;
    const table = objectTableOf(target.name);
    const column = target.fields.find((f) => f.name === target.titleField)?.column;
    if (!table || !column) continue;
    const ids = [
      ...new Set(
        records
          .map((r) => r.values[name])
          .filter((v): v is string => typeof v === "string" && v !== ""),
      ),
    ];
    if (!ids.length) continue;
    const rows = await sql<{ id: string; title: unknown }>`SELECT id, ${sql.ref(column)} AS title
      FROM ${sql.table(table)} WHERE id IN ${jsonList(ids)} AND deleted_at IS NULL`.execute(
      reader.db,
    );
    titles.set(
      name,
      new Map(
        rows.rows
          .filter((r) => typeof r.title === "string" && r.title !== "")
          .map((r) => [r.id, r.title as string]),
      ),
    );
  }
  return records.map((record) => {
    const names: Record<string, string> = {};
    for (const [name, byId] of titles) {
      const id = record.values[name];
      const title = typeof id === "string" ? byId.get(id) : undefined;
      if (title !== undefined) names[name] = title;
    }
    return { ...record, names };
  });
}

function published(view: ObjectDefinition, row: AnyRow, reader: Reader): PublishedRecord {
  const record = toRecord(view, row, reader);
  const { publishedVersion, publishedAt, ...values } = record.values;
  return {
    object: record.object,
    id: record.id,
    values,
    version: Number(publishedVersion),
    publishedAt: String(publishedAt),
  };
}

/** One published record by id or by slug (`by`), or null when none is published there. */
export async function getPublished(
  reader: Reader,
  object: StaffReadObject,
  by: { id: string } | { slug: string },
): Promise<PublishedRecord | null> {
  const view = staffReadView(object);
  const slugField = object.fields.find((f) => f.name === object.publishable.slug);
  const column = "id" in by ? "id" : slugField ? viewColumnOf(slugField) : null;
  if (!column) return null;
  const value = "id" in by ? by.id : by.slug;
  const row = await sql<AnyRow>`
    SELECT * FROM ${staffReadSource(reader, object)} WHERE ${sql.ref(column)} = ${value} LIMIT 1
  `.execute(reader.db);
  const found = row.rows[0];
  if (!found) return null;
  const [record] = await withNames(reader, object, [published(view, found, reader)]);
  return record ?? null;
}

/** One page of the published records, filtered and sorted on the fields a staff reader is given. */
export async function listPublished(
  reader: Reader,
  object: StaffReadObject,
  input: Pick<ListInput, "filter" | "sort" | "cursor" | "limit">,
): Promise<{ items: PublishedRecord[]; nextCursor: string | null }> {
  const view = staffReadView(object);
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const query = (reader.db as any).selectFrom(staffReadSource(reader, object)).selectAll();
  const page = await pageQuery<unknown, never, AnyRow & { id: string }>(query, view, input);
  return {
    items: await withNames(
      reader,
      object,
      page.rows.map((row) => published(view, row, reader)),
    ),
    nextCursor: page.nextCursor,
  };
}
