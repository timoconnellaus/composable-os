// Restricted fields (stage 54 step 2, ADR 0811): the host's store of the values only a named grant
// reads, `core_restricted_value` (migration 1190). A restricted field is never a registry field
// and has no column in the object's x_* table, so no rec_* view, list, filter, search entry,
// export, dashboard, embedding, summary, timeline or audit change holds it. Here: what the seam
// writes for the record's customer (its author), the redaction of every operation's audited
// input, and what an erase, a purge and a dropped field remove. The author's read is the seam's
// (visibility/records.ts); staff's is `record.readRestricted` (operations/restricted.ts).
import { RESTRICTED_MAX_CHARS } from "@composable-os/sdk";
import { CompiledQuery } from "kysely";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, RestrictedFieldDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";

/** The restricted fields of `object` (none for a core object). */
export function restrictedFieldsOf(
  object: Pick<ObjectDefinition, "restricted"> | undefined,
): readonly RestrictedFieldDefinition[] {
  return object?.restricted ?? [];
}

/** `values` split into what the record code writes and what the restricted store keeps. */
export function splitRestricted(
  object: ObjectDefinition,
  values: Record<string, unknown>,
): { plain: Record<string, unknown>; restricted: Record<string, unknown> } {
  const names = new Set(restrictedFieldsOf(object).map((f) => f.name));
  const plain: Record<string, unknown> = {};
  const restricted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (names.has(name)) restricted[name] = value;
    else plain[name] = value;
  }
  return { plain, restricted };
}

/** The most characters a restricted field of this type holds. */
function maxChars(field: RestrictedFieldDefinition): number {
  return field.fieldType === "text" ? 1000 : RESTRICTED_MAX_CHARS;
}

/**
 * The statements that write `values` (restricted fields of `object`) for record `id`: an upsert
 * per value, a delete for an empty one. A value that is not text of the field's length is refused,
 * naming the field and never the value.
 */
export function restrictedWrites(
  ctx: Pick<HandlerContext, "now">,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
): CompiledQuery[] {
  const statements: CompiledQuery[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = restrictedFieldsOf(object).find((f) => f.name === name);
    if (!field)
      throw new ValidationError(`Unknown field "${name}" on ${object.name}`, { field: name });
    if (value === null || value === undefined || value === "") {
      statements.push(
        CompiledQuery.raw(
          "DELETE FROM core_restricted_value WHERE object_type = ? AND record_id = ? AND field = ?",
          [object.name, id, name],
        ),
      );
      continue;
    }
    if (typeof value !== "string" || value.length > maxChars(field)) {
      throw new ValidationError(
        `${object.name}.${name} must be text of at most ${maxChars(field)} characters`,
        { field: name },
      );
    }
    statements.push(
      CompiledQuery.raw(
        `INSERT INTO core_restricted_value (object_type, record_id, field, value, written_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (object_type, record_id, field)
         DO UPDATE SET value = excluded.value, written_at = excluded.written_at`,
        [object.name, id, name, value, ctx.now],
      ),
    );
  }
  return statements;
}

/**
 * The input keys an audit row of an operation on `input.object` never keeps: the object's
 * restricted fields, wherever they appear in the input (a record write's values, a bulk change, an
 * import's rows). The pipeline adds them to the operation's own `redact`.
 */
export function restrictedInputKeys(input: unknown): string[] {
  const object = (input as { object?: unknown } | null)?.object;
  if (typeof object !== "string") return [];
  return restrictedFieldsOf(getObject(object)).map((f) => f.name);
}

/** One restricted field as the state tables hold it, whatever its status (hidden ones too). */
interface StoredRestricted {
  object: string;
  table: string;
  /** The x_* column of the object's customer field, when it declares one. */
  customerColumn: string | null;
}

/** The objects that have restricted fields, from the state tables (a hidden one's included). */
async function storedRestricted(ctx: HandlerContext): Promise<StoredRestricted[]> {
  const fields = await ctx.db
    .selectFrom("core_extension_fields")
    .select(["object", "local_name", "column_name", "definition"])
    .execute();
  const objects = await ctx.db
    .selectFrom("core_extension_objects")
    .select(["name", "table_name", "definition"])
    .execute();
  const restricted = new Set(
    fields
      .filter((f) => (JSON.parse(f.definition) as { restricted?: unknown }).restricted)
      .map((f) => f.object),
  );
  return objects
    .filter((o) => restricted.has(o.name))
    .map((o) => {
      const customer = (JSON.parse(o.definition) as { customer?: { field?: string } }).customer;
      const column = customer?.field
        ? (fields.find((f) => f.object === o.name && f.local_name === customer.field)
            ?.column_name ?? null)
        : null;
      return { object: o.name, table: o.table_name, customerColumn: column };
    });
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Queues the deletion of every restricted value of a record whose customer (its author) is one of
 * `personIds`, in the Trash or not (ADR 0811): an erased or purged Person's words go with them,
 * whatever becomes of the record. The records are read now, before the batch clears or deletes
 * them, and named by id in one JSON parameter each.
 */
export async function queueEraseRestricted(
  ctx: HandlerContext,
  personIds: readonly string[],
): Promise<number> {
  if (!personIds.length) return 0;
  let count = 0;
  for (const object of await storedRestricted(ctx)) {
    if (!object.customerColumn) continue;
    const found = await ctx.db.executeQuery<{ id: string }>(
      CompiledQuery.raw(
        `SELECT id FROM ${q(object.table)} WHERE ${q(object.customerColumn)} IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(personIds)],
      ),
    );
    const ids = found.rows.map((r) => r.id);
    if (!ids.length) continue;
    count += ids.length;
    ctx.write(
      CompiledQuery.raw(
        "DELETE FROM core_restricted_value WHERE object_type = ? AND record_id IN (SELECT value FROM json_each(?))",
        [object.object, JSON.stringify(ids)],
      ),
    );
  }
  return count;
}
