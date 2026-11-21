// What a paid line grants (stage 27, the sellable behaviour, ADR 0435): a hook on the order's
// moves, in the batch of the write that makes the move (ADR 0426). No extension code runs here:
// the grant is the sellable object's declaration, read from the field registry.
//
//   to `paid` or `part_paid` from `pending`   for each line whose object grants something, one
//   or `expired` (the first payment, or a     record of the granted object per unit, created by
//   late one staff honour)                    the host with its fields set from the line, the
//                                             item and the order, and a core_order_grant row
//                                             for each, with its code when the grant has one
//   to `refunded` or `cancelled`              what the order granted moves to the declared void
//                                             state, as the host
//
// `part_paid` → `paid` grants nothing more: the place was the buyer's from the first payment.
// A paid batch is the payment's own: if a grant fails, the payment is not applied and is tried
// again, so the declaration's checks (packages/sdk/src/sellable.ts) keep a grant from failing.

import { moveOrigins } from "@composable-os/sdk";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { GrantDefinition, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { createRecord, updateRecord } from "../operations/record.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { currencyDecimals } from "./settings.ts";

/** Crockford's base32: no I, L, O or U, so a code read aloud or typed is not misread. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 26 characters of 5 random bits: 130 bits, not guessable. */
export const GRANT_CODE_LENGTH = 26;

/** A new unguessable code for a granted record (a ticket's). */
export function newGrantCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GRANT_CODE_LENGTH));
  // 256 is a multiple of 32, so the low five bits of a random byte are uniform.
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

interface LineRow {
  id: string;
  object_type: string;
  record_id: string;
  title: string;
  quantity: number;
  unit_price: number;
}

/** A field's value as a record holds it, read from a row of the object's view. */
function fieldValue(object: ObjectDefinition, row: AnyRow | undefined, name: string): unknown {
  const field = object.fields.find((f) => f.name === name);
  const column = field ? viewColumnOf(field) : null;
  if (!field || !column || !row) return null;
  const raw = row[column] ?? null;
  if (field.fieldType === "formula") return formulaFromStorage(field.options?.resultType, raw);
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY | undefined;
  return type && FIELD_TYPE_REGISTRY[type] ? FIELD_TYPE_REGISTRY[type].fromStorage(raw) : raw;
}

/** The bought record's row, read org-wide as the host (its price was read the same way). */
async function readItem(
  ctx: HandlerContext,
  item: ObjectDefinition,
  id: string,
): Promise<AnyRow | undefined> {
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  return (await (ctx.db as any)
    .selectFrom(visibleSource(orgReader(ctx.db), item))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
}

async function grant(ctx: HandlerContext, orderId: string, order: Record<string, unknown>) {
  const lines = (await ctx.db
    .selectFrom("core_order_line")
    .select(["id", "object_type", "record_id", "title", "quantity", "unit_price"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute()) as LineRow[];
  const currency = typeof order.currency === "string" ? order.currency : "";
  for (const line of lines) {
    const item = getObject(line.object_type);
    const grants = item?.sellable?.grants;
    if (!item || !grants) continue;
    const granted = getObject(grants.object);
    if (!granted?.states) {
      // The contract check refuses this; a registry out of step grants nothing rather than
      // refusing the payment.
      console.error(`sellable ${item.name}: granted object ${grants.object} has no states`);
      continue;
    }
    const sources = Object.values(grants.set);
    const itemRow = sources.some((s) => s.startsWith("item."))
      ? await readItem(ctx, item, line.record_id)
      : undefined;
    const from = (source: string): unknown => {
      if (source === "item") return line.record_id;
      if (source.startsWith("item.")) return fieldValue(item, itemRow, source.slice(5));
      if (source === "order") return orderId;
      if (source === "order.person") return order.personId ?? null;
      if (source === "order.email") return order.email ?? null;
      if (source === "line") return line.id;
      if (source === "line.title") return line.title;
      if (source === "line.unitPrice") return line.unit_price / 10 ** currencyDecimals(currency);
      return null;
    };
    for (let unit = 0; unit < line.quantity; unit += 1) {
      let code: string | null = null;
      const values: Record<string, unknown> = {};
      for (const [target, source] of Object.entries(grants.set)) {
        if (source === "code") {
          code = newGrantCode();
          values[target] = code;
        } else {
          values[target] = from(source);
        }
      }
      // As the host: it may set the read-only code, and the values are the host's own, so
      // their references were checked when the item and the order were written.
      const id = await createRecord(ctx, granted, values, { by: "host", checkReferences: false });
      ctx.write(
        ctx.db.insertInto("core_order_grant").values({
          object_type: granted.name,
          record_id: id,
          order_id: orderId,
          line_id: line.id,
          code,
          created_at: ctx.now,
        }),
      );
    }
  }
}

/** The grant declaration whose granted object is `object`, for its void state. */
function grantFor(object: string): GrantDefinition | undefined {
  for (const candidate of listObjects()) {
    const grants = candidate.sellable?.grants;
    if (grants?.object === object) return grants;
  }
  return undefined;
}

async function voidGrants(ctx: HandlerContext, orderId: string) {
  const rows = await ctx.db
    .selectFrom("core_order_grant")
    .select(["object_type", "record_id"])
    .where("order_id", "=", orderId)
    .execute();
  if (!rows.length) return;
  const byObject = new Map<string, string[]>();
  for (const row of rows) {
    byObject.set(row.object_type, [...(byObject.get(row.object_type) ?? []), row.record_id]);
  }
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    const states = object?.states;
    const voidState = grantFor(name)?.void;
    const field = states ? object.fields.find((f) => f.name === states.field) : undefined;
    const column = field ? viewColumnOf(field) : null;
    if (!object || !states || !voidState || !column) continue;
    const finals = new Set(states.moves.filter((m) => m.final).map((m) => m.to));
    // One read for the object's records: their state now. One in the Trash is left alone.
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const current = (await (ctx.db as any)
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select(["id", column])
      .where("id", "in", ids)
      .execute()) as AnyRow[];
    for (const row of current) {
      const state = row[column];
      if (typeof state !== "string" || state === voidState || finals.has(state)) continue;
      const allowed = states.moves.some(
        (m) => m.to === voidState && moveOrigins(m).includes(state) && m.by.includes("host"),
      );
      if (!allowed) continue;
      await updateRecord(
        ctx,
        object,
        String(row.id),
        { [states.field]: voidState },
        { by: "host" },
      );
    }
  }
}

const orderGrants: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  if ((to === "paid" || to === "part_paid") && (from === "pending" || from === "expired")) {
    await grant(ctx, move.id, move.after);
    return;
  }
  if (to === "refunded" || to === "cancelled") await voidGrants(ctx, move.id);
};

onRecordMove("order", orderGrants);
