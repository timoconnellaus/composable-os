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
import { NotFoundError, ValidationError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { GrantDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { createRecord, updateRecord } from "../operations/record.ts";
import { viewColumnOf } from "../records/columns.ts";
import { jsonList } from "../records/common.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import type { MarkSource } from "../routine-mail/marks.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, wallClockToIso } from "../time/local.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { viewRow } from "./sellable.ts";
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
export function grantFieldValue(
  object: ObjectDefinition,
  row: AnyRow | undefined,
  name: string,
): unknown {
  const field = object.fields.find((f) => f.name === name);
  const column = field ? viewColumnOf(field) : null;
  if (!field || !column || !row) return null;
  const raw = row[column] ?? null;
  if (field.fieldType === "formula") return formulaFromStorage(field.options?.resultType, raw);
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY | undefined;
  return type && FIELD_TYPE_REGISTRY[type] ? FIELD_TYPE_REGISTRY[type].fromStorage(raw) : raw;
}

/** An order's grant rows' record ids, by object. */
function idsByObject(rows: readonly { object_type: string; record_id: string }[]) {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const ids = out.get(row.object_type);
    if (ids) ids.push(row.record_id);
    else out.set(row.object_type, [row.record_id]);
  }
  return out;
}

/** The bought record's row, read org-wide as the host (its price was read the same way). */
export async function readGrantItem(
  ctx: HandlerContext,
  item: ObjectDefinition,
  id: string,
): Promise<AnyRow | undefined> {
  return viewRow(ctx.db, visibleSource(orgReader(ctx.db), item), id);
}

/**
 * The `from` and `until` values of what is granted now (ADR 0511): `from` is now; `until` is now
 * plus the item's days, as local days in the organisation's zone (a datetime: the same time of
 * day; a date: the day before, since a date includes its whole day). No days: no `until`.
 */
export async function validFrom(
  ctx: HandlerContext,
  granted: ObjectDefinition,
  valid: NonNullable<GrantDefinition["valid"]>,
  itemValue: (field: string) => unknown,
): Promise<Record<string, unknown>> {
  const zone = (await loadGeneralSettings(ctx.db)).timezone || "UTC";
  const typeOf = (field: string) => granted.fields.find((f) => f.name === field)?.fieldType;
  const local = localParts(ctx.now, zone);
  const out: Record<string, unknown> = {};
  if (valid.from) out[valid.from] = typeOf(valid.from) === "date" ? local.date : ctx.now;
  const raw = valid.days ? itemValue(valid.days.slice("item.".length)) : null;
  const days = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  if (valid.until && days) {
    if (typeOf(valid.until) === "date") {
      const d = addLocalDays(local, days - 1);
      out[valid.until] =
        `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    } else {
      out[valid.until] = wallClockToIso(
        {
          ...addLocalDays(local, days),
          hour: local.hour,
          minute: local.minute,
          second: local.second,
        },
        zone,
      );
    }
  }
  return out;
}

/**
 * What a paid line would grant, given by hand by a person's tool (a pass, ADR 0513): the record
 * bought is named by the grant's `item` field; its dates are the host's (`grants.valid`, from now
 * for the item's days, whatever the tool sent); and when the item is sold once per Person (an
 * intro offer) the Person's one is used now, with who gave it, or the write is refused when they
 * have had theirs. Returns the values to create the record with.
 */
export async function handGrantValues(
  ctx: HandlerContext,
  granted: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const item = listObjects().find((o) => o.sellable?.grants?.object === granted.name);
  const grants = item?.sellable?.grants;
  if (!item || !grants) return values;
  const sourceField = (source: string) =>
    Object.entries(grants.set).find(([, s]) => s === source)?.[0];
  const itemField = sourceField("item");
  const itemId = itemField ? values[itemField] : undefined;
  if (typeof itemId !== "string" || !itemId) {
    throw new ValidationError(`${granted.label} given by hand names its ${item.label}`, {
      field: itemField ?? null,
    });
  }
  const itemRow = await readGrantItem(ctx, item, itemId);
  if (!itemRow) throw new NotFoundError(item.name, itemId);
  const out = { ...values };
  if (grants.valid) {
    const valid = await validFrom(ctx, granted, grants.valid, (field) =>
      grantFieldValue(item, itemRow, field),
    );
    for (const key of [grants.valid.from, grants.valid.until]) {
      if (key) out[key] = valid[key] ?? null;
    }
  }
  const once = item.sellable?.onePerPerson;
  if (once && grantFieldValue(item, itemRow, once) === true) {
    const personField = sourceField("order.person");
    const personId = personField ? out[personField] : undefined;
    if (typeof personId !== "string" || !personId) {
      throw new ValidationError("This is one per person: name the person it is given to", {
        rule: "once_per_person",
        reason: "no_person",
      });
    }
    const had = await ctx.db
      .selectFrom("core_sellable_once")
      .select("state")
      .where("person_id", "=", personId)
      .where("object_type", "=", item.name)
      .where("state", "in", ["held", "used"])
      .executeTakeFirst();
    if (had) {
      throw new ValidationError(
        had.state === "used"
          ? "This is one per person, and this person has had theirs"
          : "This is one per person, and an order for this person's is waiting to be paid",
        { rule: "once_per_person", reason: had.state },
      );
    }
    // Refused by the unique index if another write took it a moment before. Checked for this
    // Person only, not for those sharing a folded address (ADR 0692): giving one by hand is a
    // person's deliberate act (a family sharing one mailbox), and it still counts for the others.
    ctx.write(
      ctx.db.insertInto("core_sellable_once").values({
        id: newId("sellableOnce"),
        person_id: personId,
        object_type: item.name,
        record_id: itemId,
        order_id: null,
        state: "used",
        source: "by_hand",
        // The person who called the tool, or the staff caller when platform code gives it.
        given_by:
          ctx.extension?.tool?.startedBy ??
          (ctx.principal.kind === "staff" ? ctx.principal.userId : null),
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
  }
  return out;
}

async function grant(
  ctx: HandlerContext,
  orderId: string,
  order: Record<string, unknown>,
  from: string | null,
) {
  // Lines sold once per Person whose hold a person merge gave up (orders/merge.ts): the survivor
  // already had theirs, so the line grants nothing and staff are told to refund it.
  const onceRows = await ctx.db
    .selectFrom("core_sellable_once")
    .select(["object_type", "state"])
    .where("order_id", "=", orderId)
    .execute();
  const lostOnce = (object: string) =>
    from === "pending" &&
    onceRows.some((r) => r.object_type === object && r.state === "released") &&
    !onceRows.some((r) => r.object_type === object && r.state !== "released");
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
    if (lostOnce(item.name)) {
      await tellStaffOnce(ctx, orderId, line.title);
      continue;
    }
    const granted = getObject(grants.object);
    if (!granted?.states) {
      // The contract check refuses this; a registry out of step grants nothing rather than
      // refusing the payment.
      console.error(`sellable ${item.name}: granted object ${grants.object} has no states`);
      continue;
    }
    const sources = Object.values(grants.set);
    // A delivery taken now, in person, has nothing to pack (ADR 0682): only post and collect
    // grant what staff send or hand over (a shipment). The kind is the order's, as it started.
    if (item.sellable?.delivery) {
      const delivery = await ctx.db
        .selectFrom("core_order_delivery")
        .select("kind")
        .where("line_id", "=", line.id)
        .executeTakeFirst();
      if (!delivery || delivery.kind === "here") continue;
    }
    const itemRow =
      sources.some((s) => s.startsWith("item.")) || grants.valid?.days
        ? await readGrantItem(ctx, item, line.record_id)
        : undefined;
    // When it is valid (ADR 0511): from now, for the item's days, in the organisation's zone.
    const valid = grants.valid
      ? await validFrom(ctx, granted, grants.valid, (field) =>
          grantFieldValue(item, itemRow, field),
        )
      : {};
    const from = (source: string): unknown => {
      if (source === "item") return line.record_id;
      if (source.startsWith("item.")) return grantFieldValue(item, itemRow, source.slice(5));
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
      const values: Record<string, unknown> = { ...valid };
      for (const [target, source] of Object.entries(grants.set)) {
        if (source === "code") {
          code = newGrantCode();
          values[target] = code;
        } else {
          values[target] = from(source);
        }
      }
      // Who stands behind the granted record's values (ADR 0590): what it copies from the item
      // carries the item's marks; the code is the host's own unguessable value, not anyone's words.
      const copied: Record<string, MarkSource[]> = {};
      const generated: string[] = [];
      for (const [target, source] of Object.entries(grants.set)) {
        if (source === "code") generated.push(target);
        else if (source.startsWith("item.")) {
          const field = source.slice(5);
          copied[target] = [
            { object: line.object_type, id: line.record_id, field, value: values[target] },
          ];
        } else if (source === "line.title" && item.titleField) {
          copied[target] = [
            {
              object: line.object_type,
              id: line.record_id,
              field: item.titleField,
              value: line.title,
            },
          ];
        }
      }
      // As the host: it may set the read-only code, and the values are the host's own, so
      // their references were checked when the item and the order were written.
      const id = await createRecord(ctx, granted, values, {
        by: "host",
        checkReferences: false,
        copied,
        generated,
      });
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
  const byObject = idsByObject(rows);
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    const states = object?.states;
    const voidState = grantFor(name)?.void;
    const field = states ? object.fields.find((f) => f.name === states.field) : undefined;
    const column = field ? viewColumnOf(field) : null;
    if (!object || !states || !voidState || !column) continue;
    const finals = new Set(states.moves.filter((m) => m.final).map((m) => m.to));
    // One read for the object's records: their state now. One in the Trash is left alone.
    const current = await ctx.db
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select(["id", column])
      .where("id", "in", jsonList(ids))
      .execute();
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

/**
 * An order that belonged to no one has its Person now (`order.setPerson`): what it granted with a
 * field set from `order.person` (a ticket's holder) is theirs too. Queued as the host, in the
 * calling operation's batch. A record in the Trash is left alone.
 */
export async function grantsFollowPerson(
  ctx: HandlerContext,
  orderId: string,
  personId: string,
): Promise<void> {
  const rows = await ctx.db
    .selectFrom("core_order_grant")
    .select(["object_type", "record_id"])
    .where("order_id", "=", orderId)
    .execute();
  const byObject = idsByObject(rows);
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    const set = grantFor(name)?.set ?? {};
    const fields = Object.keys(set).filter((field) => set[field] === "order.person");
    if (!object || !fields.length) continue;
    const live = await ctx.db
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select("id")
      .where("id", "in", jsonList(ids))
      .execute();
    const values = Object.fromEntries(fields.map((field) => [field, personId]));
    for (const { id } of live) await updateRecord(ctx, object, String(id), values, { by: "host" });
  }
}

/** Staff are told a paid line sold once per Person granted nothing: refund it (ADR 0512). */
async function tellStaffOnce(ctx: HandlerContext, orderId: string, title: string): Promise<void> {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: "A one-per-person purchase granted nothing",
      body:
        `Order ${orderId} was paid for "${title}", which is one per person, and its person (merged ` +
        "with another since it was started) has had theirs. Nothing was granted for it: refund it.",
      link: { kind: "record", object: "order", id: orderId },
      dedupeKey: `order.once_lost:${orderId}`,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

const orderGrants: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  if ((to === "paid" || to === "part_paid") && (from === "pending" || from === "expired")) {
    // An invoice's order paid again after its payments were reversed (ADR 0733) granted at its
    // first payment, and what it granted stayed: it grants once.
    if (from === "pending" && move.after.invoiceId) {
      const before = await ctx.db
        .selectFrom("core_order_grant")
        .select("order_id")
        .where("order_id", "=", move.id)
        .limit(1)
        .executeTakeFirst();
      if (before) return;
    }
    await grant(ctx, move.id, move.after, from);
    return;
  }
  if (to === "refunded" || to === "cancelled") await voidGrants(ctx, move.id);
};

onRecordMove("order", orderGrants);
