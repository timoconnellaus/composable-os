// Generic reads through the visibility seam (ADR 0402, ADR 0412): a page of the records of any
// object the caller may see, or one of them, with only the fields the caller may see. This is
// what `my.list` and `my.get` are made of. Nothing here knows who the caller is: the seam does.

import { type DocumentSchema, redactDocument } from "@composable-os/sdk";
import { sql } from "kysely";
import { NotFoundError, OperationError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { compileFilter, type Filter } from "../filter.ts";
import { type ListInput, runListQuery } from "../list.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type CapacityView, readCapacity } from "./capacity.ts";
import { type AnyRow, type Reader, type Viewer, visibleObject, visibleSource } from "./index.ts";

/** A record as its caller may see it: only the fields their scope allows. */
export interface VisibleRecord {
  object: string;
  id: string;
  values: Record<string, unknown>;
  /**
   * On a record of a sellable object (ADR 0435): the deployment's currency, which every price
   * of it is in (stage 25: one per deployment), or null until an admin sets one. Absent on any
   * other object.
   */
  currency?: string | null;
}

/**
 * The currency a sellable object's prices are in, for a read that returns them: so no client
 * states a currency of its own beside the host's prices. Undefined for an object that is not
 * sellable. One read of the setting.
 */
async function currencyOf(
  ctx: Reader,
  object: ObjectDefinition,
): Promise<{ currency?: string | null }> {
  if (!getObject(object.name)?.sellable) return {};
  return { currency: await loadOrderCurrency(ctx.db) };
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

/**
 * A row as the caller may see it. For a caller outside the org, a document's `private` parts
 * are removed (ADR 0445): a coach's note is not a member's to read unless it is marked so.
 */
function toRecord(object: ObjectDefinition, row: AnyRow, viewer: Viewer): VisibleRecord {
  const outsider = viewer.principal.kind !== "staff";
  const values: Record<string, unknown> = {};
  for (const field of object.fields) {
    if (field.name === "id") continue;
    const value = fieldValue(field, row);
    const schema = field.options?.document?.schema as DocumentSchema | undefined;
    values[field.name] =
      outsider && field.fieldType === "document"
        ? schema
          ? redactDocument(schema, value)
          : null
        : value;
  }
  return { object: object.name, id: String(row.id), values };
}

/** One page of the caller's records of `object`. Filter and sort see only visible fields. */
export async function listVisible(
  ctx: Reader,
  object: string | ObjectDefinition,
  input: Pick<ListInput, "filter" | "sort" | "cursor" | "limit">,
): Promise<{ items: VisibleRecord[]; nextCursor: string | null; currency?: string | null }> {
  const visible = visibleObject(ctx, object);
  const page = await runListQuery<AnyRow & { id: string }>(ctx, visible, input);
  return {
    items: page.rows.map((row) => toRecord(visible, row, ctx)),
    nextCursor: page.nextCursor,
    ...(await currencyOf(ctx, visible)),
  };
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
  return { ...toRecord(visible, row as AnyRow, ctx), ...(await currencyOf(ctx, visible)) };
}

/** The most rows one count reads (as record.count). */
export const VISIBLE_COUNT_CAP = 10_000;

/** How many of the caller's records of `object` match `filter`, capped. */
export async function countVisible(
  ctx: Reader,
  object: string | ObjectDefinition,
  filter?: Filter,
): Promise<{ count: number; capped: boolean }> {
  const visible = visibleObject(ctx, object);
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const db = ctx.db as any;
  let matching = db.selectFrom(visibleSource(ctx, visible)).select(sql<number>`1`.as("one"));
  if (filter) matching = matching.where(compileFilter(visible, filter, visible.source));
  const row = await db
    .selectFrom(matching.limit(VISIBLE_COUNT_CAP + 1).as("matching"))
    .select(sql<number>`count(*)`.as("n"))
    .executeTakeFirstOrThrow();
  const n = Number(row.n);
  return n > VISIBLE_COUNT_CAP
    ? { count: VISIBLE_COUNT_CAP, capped: true }
    : { count: n, capped: false };
}

/**
 * The record helpers a handler is given as `ctx.records`: reads of what the caller may see, and
 * (set by the pipeline for a customer's call) writes of what they may change.
 */
export interface RecordAccess {
  list(
    object: string,
    input?: Partial<Pick<ListInput, "filter" | "sort" | "cursor" | "limit">>,
  ): Promise<{ items: VisibleRecord[]; nextCursor: string | null; currency?: string | null }>;
  get(object: string, id: string): Promise<VisibleRecord>;
  count(object: string, filter?: Filter): Promise<{ count: number; capped: boolean }>;
  /** A record's places: the real numbers for staff, what the object's `show` allows otherwise. */
  capacity(object: string, id: string): Promise<CapacityView>;
  /** Creates a record that belongs to the caller. Customers only. */
  create(object: string, values: Record<string, unknown>): Promise<{ id: string }>;
  /** Changes one of the caller's own records. Customers only. */
  update(
    object: string,
    id: string,
    values: Record<string, unknown>,
    /** Move only from this state, as `record.update`'s `from` (ADR 0437). */
    options?: { from?: string | undefined },
  ): Promise<void>;
}

/** `ctx.records` over `reader`, with the given writes (none: reads only). */
export function recordAccess(
  reader: Reader,
  writes?: Pick<RecordAccess, "create" | "update">,
): RecordAccess {
  const none = (): never => {
    throw new OperationError(
      "internal",
      "ctx.records writes are for a customer's call; staff use the record operations",
    );
  };
  return {
    list: (object, input = {}) =>
      listVisible(reader, object, { ...input, limit: input.limit ?? 50 }),
    get: (object, id) => getVisible(reader, object, id),
    count: (object, filter) => countVisible(reader, object, filter),
    capacity: (object, id) => readCapacity(reader, object, id),
    create: writes?.create ?? none,
    update: writes?.update ?? none,
  };
}
