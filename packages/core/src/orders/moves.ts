// A paid line moves a record that already exists (stage 31a step 8, `sellable.moves`, ADR 0560):
// a drop-in booking, held while its order is unpaid. Three pieces, all the host's:
//
//   order.startHeld (`startHeld`)   makes the record in its `held` state and starts its order, in
//                                   one batch, as the host, after judging the caller's input as
//                                   the record's own rules would judge them (closed for everyone;
//                                   the create window and staff-only rule unless staff), and
//                                   prices the line from the record's declared path or setting
//
//   the order's move hook           pending -> paid: the record `held` -> `paid`; pending ->
//                                   expired or cancelled: `held` -> `expired`; expired -> paid
//                                   (a late payment staff honour): refused, what it held has gone
//
//   the record's move hook          leaving `held` any other way (a class the gym cancels):
//                                   its unpaid order is cancelled; entering a `refund` state with
//                                   its order paid: a refund is owed (core_sellable_refund_due)
//
// No extension code runs, and nothing here moves money: an owed refund is asked of the payments
// gatekeeper by the minute cron (`order.refundDue`), as the outbound action `payments.refund`,
// which only a person with `orders:refund` approves (ADR 0429).
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { MovesDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";
import { createRecord, updateRecord } from "../operations/record.ts";
import type { Principal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type MoveHook, onEveryRecordMove, onRecordMove } from "../records/lifecycle.ts";
import { assertCreateRules } from "../records/states.ts";
import { pathReader, UNREADABLE } from "../records/windows.ts";
import { isLiveDependant, linkGuardStatement } from "../visibility/guardians.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { hashOrderToken, newOrderToken, resolveBuyer } from "./guests.ts";
import {
  changeOrder,
  createOrder,
  loadOrderRow,
  type OrderRow,
  type PricedLine,
} from "./orders.ts";
import { loadOrderCurrency, toMinorUnits } from "./settings.ts";

/** An object whose records an order moves, with its declaration. */
export function movesOf(object: ObjectDefinition | undefined): MovesDefinition | undefined {
  return object?.sellable?.moves;
}

// --- Starting one -------------------------------------------------------------------------------

export interface StartHeldInput {
  object: string;
  values: Record<string, unknown>;
  /** A customer's live dependant (a child staff linked to them), or for staff any live Person. */
  forPersonId?: string | undefined;
  /** The buyer's address: a guest's, or staff's for whom they start it. */
  email?: string | undefined;
}

export interface StartedHeld {
  row: OrderRow;
  lines: PricedLine[];
  recordId: string;
  token: string | null;
}

const notForSale = () => new ValidationError("This cannot be bought", { rule: "not_for_sale" });

/**
 * Whether `principal` reads the record `id` of `target` (a booking's class): a buyer may point
 * the new record only at what they can see, as a customer's own write may (ADR 0447). One answer
 * for one they cannot see and one that does not exist.
 */
async function buyerSees(
  ctx: HandlerContext,
  principal: Principal,
  target: ObjectDefinition,
  id: string,
): Promise<boolean> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const row = await (ctx.db as any)
      .selectFrom(visibleSource({ principal }, target))
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * A view of the context the host writes the record with: org-wide reads (a class type the public
 * cannot read is still the host's to read for the rules), its change recorded as the host's own
 * (ADR 0428), and an author for the row. Not a spread: on a guest's call the context has members
 * that throw when read.
 */
function hostView(ctx: HandlerContext): HandlerContext {
  if (ctx.principal.kind === "staff") return ctx;
  const caller = ctx.principal;
  return Object.create(ctx, {
    principal: { value: orgReader(ctx.db).principal },
    onBehalfOf: { value: caller },
    actor: { value: "automation" },
    user: {
      value: {
        id: caller.kind === "customer" ? caller.customerId : "public",
        email: "",
        name: caller.kind,
        role: "viewer",
      },
    },
    recordChange: { value: (change: RecordChange) => recordHostChange(ctx, change) },
  }) as HandlerContext;
}

/**
 * Makes a record of an object that declares `sellable.moves` in its held state and starts its
 * order, in the calling operation's batch (ADR 0560). Refuses whatever the record's own rules
 * refuse, before anything is written; the database refuses the rest in the batch (places past
 * the class's, a second live booking for the Person).
 */
export async function startHeld(ctx: HandlerContext, input: StartHeldInput): Promise<StartedHeld> {
  const object = getObject(input.object);
  const moves = movesOf(object);
  const states = object?.states;
  const customer = object?.customer;
  if (!object || !moves || !states || !customer || !object.sellable) throw notForSale();
  const sellable = object.sellable;
  const caller = ctx.principal;

  // What the caller may set: the fields a customer writes, never the state, whose record it is,
  // who made it, or what pays for it (a drop-in holds no allowance).
  const spender =
    object.allowance && object.allowance.kind === "spender" ? object.allowance : undefined;
  const reserved = new Set(
    [
      states.field,
      customer.field,
      customer.guardians?.madeBy,
      spender?.holder,
      spender?.waived,
      sellable.price,
      moves.order,
    ].filter((f): f is string => typeof f === "string"),
  );
  const writable = new Set(customer.write);
  for (const name of Object.keys(input.values)) {
    if (reserved.has(name) || !writable.has(name)) {
      throw new ValidationError(`${object.name}.${name} cannot be set here`, { field: name });
    }
  }
  // A relation may point only at a record the buyer reads (staff read everything).
  if (caller.kind !== "staff") {
    for (const [name, value] of Object.entries(input.values)) {
      const field = object.fields.find((f) => f.name === name);
      const to = field?.fieldType === "relation" ? field.options?.to : undefined;
      if (!to || value === null || value === undefined) continue;
      const target = getObject(to);
      if (!target || typeof value !== "string" || !(await buyerSees(ctx, caller, target, value))) {
        throw new NotFoundError(to, String(value));
      }
    }
  }

  // Who pays (the order's Person) and who it is for (the record's Person).
  let payer: string | null;
  let email: string;
  let token: string | null = null;
  let created = false;
  if (caller.kind === "customer") {
    if (input.email !== undefined) {
      throw new ValidationError("You are signed in: the order uses your account's address", {
        field: "email",
      });
    }
    const account = await ctx.db
      .selectFrom("core_customer")
      .select("email")
      .where("id", "=", caller.customerId)
      .executeTakeFirst();
    if (!account) throw new NotFoundError("customer", caller.customerId);
    payer = caller.personId;
    email = account.email;
  } else {
    if (!input.email) {
      throw new ValidationError("An order needs the buyer's email address", { field: "email" });
    }
    const buyer = await resolveBuyer(ctx, input.email);
    payer = buyer.personId;
    email = buyer.email;
    created = buyer.created;
    if (caller.kind === "public") token = newOrderToken();
  }
  let holder: string | null = payer;
  if (input.forPersonId !== undefined && input.forPersonId !== payer) {
    // A customer acts for a live dependant only, on an object that lets guardians write; a guest
    // for no one else; staff for any live Person. Anyone else is a Person that is not there.
    const ok =
      caller.kind === "customer"
        ? customer.guardians?.write === true &&
          (await isLiveDependant(ctx.db, caller.personId, input.forPersonId))
        : caller.kind === "staff"
          ? Boolean(
              await ctx.db
                .selectFrom("core_person")
                .select("id")
                .where("id", "=", input.forPersonId)
                .where("deleted_at", "is", null)
                .executeTakeFirst(),
            )
          : false;
    if (!ok) throw new NotFoundError("person", input.forPersonId);
    holder = input.forPersonId;
  }
  if (!holder) {
    // The address matched several People (ADR 0428): an order may wait for staff to say whose,
    // a held place may not.
    throw new ValidationError(
      "That address belongs to more than one person here: ask the front desk to book you in",
      { rule: "buyer_unclear", field: "email" },
    );
  }

  const currency = await loadOrderCurrency(ctx.db);
  if (!currency) throw new ConfigError("No currency is set for orders yet, so nothing can be sold");

  const orderId = newId("order");
  const host = hostView(ctx);
  const madeBy = customer.guardians?.madeBy;
  const after: Record<string, unknown> = {
    ...input.values,
    [customer.field]: holder,
    [states.field]: moves.held,
    ...(spender?.waived ? { [spender.waived]: true } : {}),
    ...(madeBy && payer && caller.kind !== "staff" ? { [madeBy]: payer } : {}),
    ...(moves.order ? { [moves.order]: orderId } : {}),
  };
  // The record's own rules, judged as the caller's create would be (staff: only "closed").
  await assertCreateRules(host, object, after, caller.kind === "staff" ? "staff" : "customer");

  // The price of one: the declared path, else the setting, read now (ADR 0505's reader).
  const reader = pathReader(host, object, after);
  let price: unknown = null;
  if (moves.price?.field !== undefined) price = await reader.read(moves.price.field);
  if (price === UNREADABLE) throw notForSale();
  if ((price === null || price === "") && moves.price?.setting !== undefined) {
    price = await reader.setting(moves.price.setting);
  }
  const unitPrice = toMinorUnits(typeof price === "string" ? Number(price) : price, currency);
  if (unitPrice === null || unitPrice <= 0) {
    throw new ValidationError("This has no price yet", { rule: "no_price" });
  }
  const titled = moves.title ? await reader.read(moves.title) : null;
  const title = typeof titled === "string" && titled.trim() ? titled.trim() : object.label;
  // The record holds the price in the major unit, as a sellable's price field does.
  after[sellable.price] = typeof price === "string" ? Number(price) : price;

  // The record, as the host: its held place is claimed in this batch (the database refuses one
  // past the places, and a second live record where the object declares one per Person).
  const recordId = await createRecord(host, object, after, {
    by: "host",
    seamSet: new Set(madeBy ? [madeBy] : []),
    // A guest's Person is made in this same batch, so it cannot be read yet; every reference was
    // judged above (the class through the buyer's own read, the Person as theirs).
    ...(created ? { checkReferences: false } : {}),
  });
  // A guardian's purchase for a child holds to the live link at commit (ADR 0540).
  if (caller.kind === "customer" && holder !== caller.personId) {
    ctx.write(linkGuardStatement(caller.personId, holder));
  }
  const line: PricedLine = {
    id: newId("orderLine"),
    position: 0,
    object: object.name,
    recordId,
    title,
    quantity: 1,
    unitPrice,
    total: unitPrice,
    deposit: null,
  };
  const started = await createOrder(ctx, {
    id: orderId,
    priced: [line],
    lines: [{ object: object.name, id: recordId, quantity: 1 }],
    personId: payer,
    email,
    placedAs: caller.kind,
    pay: "full",
    accessHash: token ? await hashOrderToken(token) : null,
  });
  return { row: started.row, lines: started.lines, recordId, token };
}

// --- What an order's moves do to the record ------------------------------------------------------

/**
 * Records this invocation's order hook is moving itself, so the record's own hook does not cancel
 * the order that is moving it. Keyed by the write queue, which every view of one invocation's
 * context shares.
 */
const movingNow = new WeakMap<object, Set<string>>();
const moving = (ctx: HandlerContext) => {
  const key = ctx.write as unknown as object;
  let set = movingNow.get(key);
  if (!set) {
    set = new Set();
    movingNow.set(key, set);
  }
  return set;
};

/** The record's state as stored, read org-wide; null when it is gone or in the Trash. */
async function storedState(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<string | null> {
  const field = object.states ? object.fields.find((f) => f.name === object.states?.field) : null;
  const column = field ? viewColumnOf(field) : null;
  if (!column) return null;
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = (await (ctx.db as any)
    .selectFrom(visibleSource(orgReader(ctx.db), object))
    .select(column)
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
  const state = row?.[column];
  return typeof state === "string" ? state : null;
}

/** Writes, in this batch, the refund the host owes on `orderId` (one per order). */
function oweRefund(
  ctx: HandlerContext,
  orderId: string,
  object: ObjectDefinition,
  recordId: string,
  entered: string,
  reason: string,
): void {
  ctx.write(
    ctx.db
      .insertInto("core_sellable_refund_due")
      .values({
        id: newId("refundDue"),
        order_id: orderId,
        object_type: object.name,
        record_id: recordId,
        entered,
        reason,
        state: "due",
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) => oc.column("order_id").doNothing()),
  );
}

const orderMoves: MoveHook = async (outer, move) => {
  // On a buyer's own call (order.cancel) the host moves the record, not the buyer.
  const ctx = hostView(outer);
  const from = move.from?.id ?? null;
  const to = move.to.id;
  const paid = to === "paid" || to === "part_paid";
  if (!paid && to !== "expired" && to !== "cancelled") return;
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id", "title"])
    .where("order_id", "=", move.id)
    .execute();
  for (const line of lines) {
    const object = getObject(line.object_type);
    const moves = movesOf(object);
    if (!object?.states || !moves) continue;
    const field = object.states.field;
    if (moving(ctx).has(line.record_id)) continue;
    const state = await storedState(ctx, object, line.record_id);
    if (paid) {
      if (from === "expired") {
        // Honoured late (ADR 0429): the place was given back at expiry and may be someone
        // else's now. Refused whole: staff refund the payment instead.
        throw new ConflictError(
          `What this order held (${line.title}) went back when it expired: refund the payment instead`,
          { order: move.id, rule: "held_gone" },
        );
      }
      if (state === moves.held) {
        moving(ctx).add(line.record_id);
        await updateRecord(ctx, object, line.record_id, { [field]: moves.paid }, { by: "host" });
        continue;
      }
      // Paid, but the record left its held place meanwhile (it should have cancelled the order):
      // the buyer is owed their money, and staff are told. The payment itself is applied.
      oweRefund(
        ctx,
        move.id,
        object,
        line.record_id,
        state ?? "gone",
        "Paid after it was released",
      );
      const plan = await notifyStatements(
        ctx.db,
        {
          to: [{ role: "admin" }],
          type: "system.message",
          title: "A payment arrived for something no longer held",
          body:
            `Order ${move.id} was paid for "${line.title}", which was no longer held for it. Its ` +
            "refund is waiting in Approvals.",
          link: { kind: "record", object: "order", id: move.id },
          dedupeKey: `order.moves_gone:${move.id}`,
          source: { actor: "system" },
        },
        ctx.now,
      );
      ctx.write(...plan.statements);
      continue;
    }
    // Expired, or cancelled with nothing paid: the held place goes back.
    if (from === "pending" && state === moves.held) {
      moving(ctx).add(line.record_id);
      await updateRecord(ctx, object, line.record_id, { [field]: moves.expired }, { by: "host" });
    }
  }
};

/** The order a record was made with (one per record: order.start refuses it). */
async function orderOfRecord(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<OrderRow | null> {
  const line = await ctx.db
    .selectFrom("core_order_line")
    .select("order_id")
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .executeTakeFirst();
  return line ? loadOrderRow(ctx.db, line.order_id) : null;
}

const recordMoves: MoveHook = async (ctx, move) => {
  const moves = movesOf(move.object);
  if (!moves || !move.from) return;
  if (moving(ctx).has(move.id)) return;
  const from = move.from.id;
  const to = move.to.id;
  const leavesHeld = from === moves.held && to !== moves.paid;
  const refunds = from !== moves.held && moves.refund.includes(to);
  if (!leavesHeld && !refunds) return;
  const order = await orderOfRecord(ctx, move.object, move.id);
  if (!order) return;
  if (leavesHeld) {
    // Released another way (its class cancelled): its unpaid order goes too, so the provider's
    // page cannot take money for it; a payment made anyway is a late one staff refund.
    if (order.state === "pending") {
      // This write moves the record itself: the order's hook must not move it again.
      moving(ctx).add(move.id);
      await changeOrder(ctx, order, "cancelled", { cancelled_at: ctx.now }, "host");
    }
    return;
  }
  if (order.state !== "paid") return;
  const label =
    move.object.fields
      .find((f) => f.name === move.object.states?.field)
      ?.options?.choices?.find((c) => c.value === to)?.label ?? to;
  oweRefund(ctx, order.id, move.object, move.id, to, `${move.object.label}: ${label}`);
};

onRecordMove("order", orderMoves);
onEveryRecordMove(recordMoves);
