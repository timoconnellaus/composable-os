// A paid line moves a record that already exists (stage 31a step 8, `sellable.moves`, ADR 0560):
// a drop-in booking, held while its order is unpaid. Three pieces, all the host's:
//
//   order.startHeld (`startHeld`)   makes the record in its `held` state and starts its order, in
//                                   one batch, as the host, after judging the caller's input as
//                                   the record's own rules would judge them (closed for everyone;
//                                   the create window and staff-only rule unless staff), and
//                                   prices the line from the record's declared path or setting
//
//   the order's move hook           pending -> paid: the record `held` -> `paid` (a guest's given
//                                   its Person then, or refunded as a second place); pending ->
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

import type { GuestAcceptance } from "../agreements/enforce.ts";
import { normaliseCustomerEmail, sameEmailPeople } from "../customers/accounts.ts";
import {
  ConfigError,
  ConflictError,
  NotFoundError,
  UnknownOperationError,
  ValidationError,
} from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { MovesDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";
import { createRecord, updateRecord } from "../operations/record.ts";
import type { Principal } from "../principals.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type MoveHook, onEveryRecordMove, onRecordMove } from "../records/lifecycle.ts";
import { assertCreateRules } from "../records/states.ts";
import { boundMoment, pathReader, UNREADABLE } from "../records/windows.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import { erasedAddresses } from "../sync/ingest.ts";
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
  /** A visitor's acceptances, carried in the buying call (stage 44 step 3). */
  agreements?: readonly GuestAcceptance[] | undefined;
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

/** The share of a class's places guests may hold unpaid when the setting is empty. */
export const DEFAULT_HOLD_PERCENT = 50;

/**
 * Makes a record of an object that declares `sellable.moves` in its held state and starts its
 * order, in the calling operation's batch (ADR 0560). Refuses whatever the record's own rules
 * refuse, before anything is written; the database refuses the rest in the batch (places past
 * the class's, a second live booking for a signed-in Person, a class cancelled meanwhile, more
 * unpaid guest holds than the class may carry).
 *
 * A guest (the public) is matched to no Person here: their record is held with no Person and
 * their order with none, so the answer is the same whatever the address matches, and their hold
 * is nobody's own and blocks nobody's own booking. The Person is found when the payment is
 * verified (`settleGuest`).
 */
export async function startHeld(ctx: HandlerContext, input: StartHeldInput): Promise<StartedHeld> {
  const object = getObject(input.object);
  const moves = movesOf(object);
  const states = object?.states;
  const customer = object?.customer;
  if (!object || !moves || !states || !customer || !object.sellable) throw notForSale();
  const sellable = object.sellable;
  const caller = ctx.principal;
  // For everyone a pack's tool only (ADR 0560): the pipeline holds customers and the public to it,
  // and here staff, the assistant and MCP too.
  if (caller.kind === "staff" && !ctx.extension) {
    throw new UnknownOperationError("order.startHeld");
  }
  if (caller.kind === "public" && !moves.guest) throw notForSale();

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
  } else if (caller.kind === "public") {
    // A guest: the address is checked as an address, never matched to a Person (ADR 0428).
    if (input.forPersonId !== undefined) throw new NotFoundError("person", input.forPersonId);
    const address = input.email ? normaliseCustomerEmail(input.email) : null;
    if (!input.email) {
      throw new ValidationError("An order needs the buyer's email address", { field: "email" });
    }
    if (!address || (await erasedAddresses(ctx.db, [address])).size > 0) {
      throw new ValidationError("That email address cannot be used", { field: "email" });
    }
    // No per-address limit: addresses cost nothing to vary. The per-class cap, counted in the
    // batch, is the guard (ADR 0560); the edge limits calls per client address.
    payer = null;
    email = address;
    token = newOrderToken();
  } else {
    if (!input.email) {
      throw new ValidationError("An order needs the buyer's email address", { field: "email" });
    }
    const buyer = await resolveBuyer(ctx, input.email);
    payer = buyer.personId;
    email = buyer.email;
    created = buyer.created;
  }
  let holder: string | null = payer;
  if (input.forPersonId !== undefined && input.forPersonId !== payer) {
    // A customer acts for a live dependant only, on an object that lets guardians write; staff
    // for any live Person. Anyone else is a Person that is not there.
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
  if (!holder && caller.kind !== "public") {
    // Staff naming an address several People share: an order may wait for staff to say whose,
    // a held place for a known caller may not.
    throw new ValidationError("That address belongs to more than one person: name the person", {
      rule: "buyer_unclear",
      field: "email",
    });
  }

  const currency = await loadOrderCurrency(ctx.db);
  if (!currency) throw new ConfigError("No currency is set for orders yet, so nothing can be sold");

  const orderId = newId("order");
  const host = hostView(ctx);
  const madeBy = customer.guardians?.madeBy;
  const after: Record<string, unknown> = {
    ...input.values,
    ...(holder ? { [customer.field]: holder } : {}),
    [states.field]: moves.held,
    ...(spender?.waived ? { [spender.waived]: true } : {}),
    ...(madeBy && payer && caller.kind === "customer" ? { [madeBy]: payer } : {}),
    ...(moves.order ? { [moves.order]: orderId } : {}),
  };
  // The record's own rules, judged as the caller's create would be (staff: only "closed"), with
  // the guard that what they are read through does not move before this batch commits.
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
    // A Person staff's address made in this same batch cannot be read yet; every reference was
    // judged above.
    ...(created ? { checkReferences: false } : {}),
  });
  // At most so many unpaid guest holds on what it claims (migration 0690): counted in the batch,
  // after this one's claim, so two guests at once cannot both pass the last one.
  if (caller.kind === "public" && moves.holdCap && object.claims) {
    const on = after[object.claims.on];
    const target = object.fields.find((f) => f.name === object.claims?.on)?.options?.to;
    if (typeof on === "string" && target) {
      const capacity = await ctx.db
        .selectFrom("core_capacity")
        .select("places")
        .where("object_type", "=", target)
        .where("record_id", "=", on)
        .executeTakeFirst();
      const raw = await reader.setting(moves.holdCap.setting);
      const percent =
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_HOLD_PERCENT;
      const places = Number(capacity?.places ?? 0);
      const cap = Math.max(1, Math.ceil((places * percent) / 100));
      // Signed-in members' own unpaid holds are not the guests': the trigger counts every unpaid
      // hold, so they are added to what it may count (read now; a member's hold made at the same
      // moment may count against guests once).
      const ownerField = customer.field;
      const stateField = states.field;
      const columnOf = (name: string) => {
        const f = object.fields.find((x) => x.name === name);
        return f ? viewColumnOf(f) : null;
      };
      const onColumn = columnOf(object.claims.on);
      const ownerColumn = columnOf(ownerField);
      const stateColumn = columnOf(stateField);
      let members = 0;
      if (onColumn && ownerColumn && stateColumn) {
        // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
        const counted = (await (ctx.db as any)
          .selectFrom(visibleSource(orgReader(ctx.db), object))
          .select((eb: { fn: { countAll: () => { as: (a: string) => unknown } } }) =>
            eb.fn.countAll().as("n"),
          )
          .where(onColumn, "=", on)
          .where(stateColumn, "=", moves.held)
          .where(ownerColumn, "is not", null)
          .executeTakeFirst()) as { n?: number } | undefined;
        members = Number(counted?.n ?? 0);
      }
      ctx.write(guardStatement("held_cap", target, on, cap + members));
    }
  }
  // A guardian's purchase for a child holds to the live link at commit (ADR 0540).
  if (caller.kind === "customer" && holder && holder !== caller.personId) {
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
    // Who it is for: the booking's Person (a child a guardian buys for), not only who pays.
    participantId: holder,
    email,
    placedAs: caller.kind,
    pay: "full",
    accessHash: token ? await hashOrderToken(token) : null,
    agreements: input.agreements,
  });
  return { row: started.row, lines: started.lines, recordId, token };
}

// --- What an order's moves do to the record ------------------------------------------------------

/**
 * Records being moved by the hooks below in the write now being planned, so the record's own hook
 * does not cancel the order that is moving it, nor the order's hook move it again. Keyed by the
 * write queue (every view of one invocation's context shares it), each id added for the one call
 * that moves it and removed after. Two writes racing on one record are kept apart by the
 * database, not by this: the transition history's unique current row fails the later batch.
 */
const movingNow = new WeakMap<object, Set<string>>();
async function whileMoving<T>(ctx: HandlerContext, id: string, run: () => Promise<T>): Promise<T> {
  const key = ctx.write as unknown as object;
  let set = movingNow.get(key);
  if (!set) {
    set = new Set();
    movingNow.set(key, set);
  }
  set.add(id);
  try {
    return await run();
  } finally {
    set.delete(id);
  }
}
const isMoving = (ctx: HandlerContext, id: string) =>
  movingNow.get(ctx.write as unknown as object)?.has(id) === true;

/** The record's stored values by registry name, read org-wide; null when gone or in the Trash. */
async function storedValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<Record<string, unknown> | null> {
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const row = (await (ctx.db as any)
    .selectFrom(visibleSource(orgReader(ctx.db), object))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
  if (!row) return null;
  const values: Record<string, unknown> = {};
  for (const field of object.fields) {
    const column = viewColumnOf(field);
    if (column && Object.hasOwn(row, column)) values[field.name] = row[column];
  }
  return values;
}

/**
 * Writes, in this batch, the refund the host owes on `orderId`: of the whole order (one per
 * order), or of one payment alone (`payment`: one per payment, ADR 0560).
 */
function oweRefund(
  ctx: HandlerContext,
  orderId: string,
  object: { name: string },
  recordId: string,
  entered: string,
  reason: string,
  payment?: { paymentRef: string; amount: number },
): void {
  ctx.write(
    ctx.db
      .insertInto("core_sellable_refund_due")
      .values({
        id: newId("refundDue"),
        order_id: orderId,
        object_type: object.name,
        record_id: recordId,
        ...(payment ? { payment_ref: payment.paymentRef, amount: payment.amount } : {}),
        entered,
        reason,
        state: "due",
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) => oc.doNothing()),
  );
}

async function tellAdmins(ctx: HandlerContext, orderId: string, title: string, body: string) {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: { kind: "record", object: "order", id: orderId },
      dedupeKey: `order.moves:${orderId}:${title}:${ctx.now}`,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/**
 * A payment on an order that was no longer pending (ADR 0429), whose line moves a record: a
 * second payment on a paid order, or one after the order closed (its place went back). Exactly
 * that payment is owed back, on its own (the refund waits for a person, as every refund); the
 * paid order's first payment is never touched by it. In the payment's batch. Without the
 * provider's reference nothing can be refunded by the host: false, and staff refund it.
 */
export async function oweLateRefund(
  ctx: HandlerContext,
  orderId: string,
  payment: { paymentRef: string | null; amount: number; orderState: string },
): Promise<boolean> {
  if (!payment.paymentRef) return false;
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id"])
    .where("order_id", "=", orderId)
    .execute();
  const moved = lines.find((line) => movesOf(getObject(line.object_type)));
  if (!moved) return false;
  oweRefund(
    ctx,
    orderId,
    { name: moved.object_type },
    moved.record_id,
    payment.orderState === "paid" ? "duplicate_payment" : "late",
    payment.orderState === "paid"
      ? "Paid twice"
      : payment.orderState === "refunded"
        ? "Paid again after it was refunded"
        : "Paid after its place went back",
    { paymentRef: payment.paymentRef, amount: payment.amount },
  );
  return true;
}

/**
 * The Person a paid guest's address is theirs by (ADR 0428's rule), or null when it cannot be
 * any: an erased address, one only a Person in the Trash has, or no admin to make one for. Never
 * fails the payment's batch.
 */
async function matchGuest(
  ctx: HandlerContext,
  email: string,
): Promise<{ personId: string | null; created: boolean } | null> {
  if ((await erasedAddresses(ctx.db, [email])).size > 0) return null;
  const trashed = await ctx.db
    .selectFrom("core_person_emails as e")
    .innerJoin("core_person as p", "p.id", "e.person_id")
    .select("p.id")
    .where("e.email", "=", email)
    .where("p.deleted_at", "is not", null)
    .executeTakeFirst();
  if (trashed && (await sameEmailPeople(ctx.db, email)).length === 0) return null;
  try {
    return await resolveBuyer(ctx, email);
  } catch (error) {
    // No admin to create the Person for. Anything else (a database error) fails the payment's
    // batch, and the verified event is applied again.
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** A paid guest record nobody can have: its place back (`expired`), its money owed back. */
async function release(
  ctx: HandlerContext,
  object: ObjectDefinition,
  moves: MovesDefinition,
  orderId: string,
  recordId: string,
  why: string,
): Promise<void> {
  const field = object.states?.field;
  if (!field) return;
  await whileMoving(ctx, recordId, () =>
    updateRecord(ctx, object, recordId, { [field]: moves.expired }, { by: "host" }),
  );
  oweRefund(ctx, orderId, object, recordId, why, "Paid, and could not be given to anyone");
}

/**
 * How many paid guest records still held for no one are read per tick. The set holds only those
 * (each needs an address several People share, not yet settled), and each leaves it when it is
 * settled or released, so it is read whole in practice; at most UNSETTLED_RELEASES are released.
 */
export const UNSETTLED_SCAN = 1000;
export const UNSETTLED_RELEASES = 20;

/**
 * Paid guest records still held for no one (the several People an address matched, not yet
 * settled by staff): the records themselves, still held and ownerless, of paid orders, so one
 * released or settled leaves the set and nothing else (another pack's guest orders) is in it.
 * The minute cron then releases each one that is due in a call of its own.
 */
export async function unsettledGuests(
  db: HandlerContext["db"],
  limit = UNSETTLED_SCAN,
): Promise<{ object: string; recordId: string; orderId: string }[]> {
  const out: { object: string; recordId: string; orderId: string }[] = [];
  for (const object of listObjects()) {
    const moves = movesOf(object);
    const states = object.states;
    const ownerField = object.customer?.field;
    if (!moves?.guest || !states || !ownerField) continue;
    const column = (name: string) => {
      const field = object.fields.find((f) => f.name === name);
      return field ? viewColumnOf(field) : null;
    };
    const stateColumn = column(states.field);
    const ownerColumn = column(ownerField);
    if (!stateColumn || !ownerColumn) continue;
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (db as any)
      .selectFrom(visibleSource(orgReader(db), object, "r"))
      // biome-ignore lint/suspicious/noExplicitAny: the join is on a registry-driven view.
      .innerJoin("core_order_line as l", (join: any) =>
        join.onRef("l.record_id", "=", "r.id").on("l.object_type", "=", object.name),
      )
      .innerJoin("core_order as o", "o.id", "l.order_id")
      .select(["r.id as record_id", "o.id as order_id"])
      .where(`r.${stateColumn}`, "=", moves.held)
      .where(`r.${ownerColumn}`, "is", null)
      .where("o.state", "=", "paid")
      .orderBy("o.paid_at")
      .limit(limit - out.length)
      .execute()) as { record_id: string; order_id: string }[];
    for (const row of rows) {
      out.push({ object: object.name, recordId: row.record_id, orderId: row.order_id });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One paid guest record still held for no one, released and owed back if booking for it has
 * closed (staff did not say whose in time), admins told. In the calling operation's own batch, so
 * a conflict (staff settling it at the same moment) affects this record only. True if released.
 */
export async function releaseUnsettledGuest(
  ctx: HandlerContext,
  objectName: string,
  recordId: string,
): Promise<boolean> {
  const object = getObject(objectName);
  const moves = movesOf(object);
  const states = object?.states;
  const ownerField = object?.customer?.field;
  const until = states?.create?.window?.until;
  if (!object || !moves?.guest || !states || !ownerField || until === undefined) return false;
  const values = await storedValues(ctx, object, recordId);
  if (!values || values[states.field] !== moves.held || values[ownerField]) return false;
  const order = await orderOfRecord(ctx, object, recordId);
  if (!order || order.state !== "paid" || order.person_id) return false;
  const closes = await boundMoment(ctx, pathReader(ctx, object, values), until);
  if (closes !== null && Date.parse(ctx.now) < closes) return false;
  await release(ctx, object, moves, order.id, recordId, "unsettled");
  await tellAdmins(
    ctx,
    order.id,
    "A paid drop-in was released: nobody said whose it was",
    `Order ${order.id} was paid with an address several People share, and its Person was not ` +
      "set before booking closed. Its place went back and its refund is waiting in Approvals.",
  );
  return true;
}

/**
 * The record paid for gets its Person and moves to `paid`, or, when that Person already has a live
 * record where the object declares one per Person (they booked the class themselves), it is not
 * kept as a second one: it goes to `expired` (its place back), the refund is owed, and staff are
 * told. In the payment's (or order.setPerson's) batch.
 */
async function settle(
  ctx: HandlerContext,
  object: ObjectDefinition,
  moves: MovesDefinition,
  orderId: string,
  recordId: string,
  values: Record<string, unknown>,
  personId: string | null,
  /** The Person was made in this same batch (no one had the address): not readable yet. */
  made = false,
): Promise<void> {
  const states = object.states;
  const ownerField = object.customer?.field;
  if (!states || !ownerField) return;
  const owner = personId ?? (values[ownerField] as string | null | undefined) ?? null;
  if (owner && !values[ownerField]) {
    const clash = await liveTwin(ctx, object, recordId, { ...values, [ownerField]: owner });
    if (clash) {
      await whileMoving(ctx, recordId, () =>
        updateRecord(ctx, object, recordId, { [states.field]: moves.expired }, { by: "host" }),
      );
      oweRefund(ctx, orderId, object, recordId, "duplicate", "They already had a place on it");
      await tellAdmins(
        ctx,
        orderId,
        "A paid drop-in was a second booking",
        `Order ${orderId} paid for a place its buyer already had: it was not kept, and its ` +
          "refund is waiting in Approvals.",
      );
      return;
    }
  }
  await whileMoving(ctx, recordId, () =>
    updateRecord(
      ctx,
      object,
      recordId,
      {
        ...(owner && !values[ownerField] ? { [ownerField]: owner } : {}),
        [states.field]: moves.paid,
      },
      { by: "host", ...(made ? { checkReferences: false } : {}) },
    ),
  );
}

/** Another live record with the same values where the object declares one per Person. */
async function liveTwin(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const ownerField = object.customer?.field;
  for (const rule of object.unique ?? []) {
    if (!ownerField || !rule.fields.includes(ownerField)) continue;
    const stateField = object.states?.field;
    const columnOf = (name: string) => {
      const field = object.fields.find((f) => f.name === name);
      return field ? viewColumnOf(field) : null;
    };
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    let q = (ctx.db as any)
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select("id")
      .where("id", "!=", id);
    for (const name of rule.fields) {
      const column = columnOf(name);
      if (!column) return false;
      q = q.where(column, "=", values[name] ?? null);
    }
    const stateColumn = stateField ? columnOf(stateField) : null;
    if (stateColumn && rule.states?.length) q = q.where(stateColumn, "in", [...rule.states]);
    if (await q.executeTakeFirst()) return true;
  }
  return false;
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
    if (isMoving(ctx, line.record_id)) continue;
    const values = await storedValues(ctx, object, line.record_id);
    const state = values?.[field] ?? null;
    if (paid) {
      if (from === "expired") {
        // Honoured late (ADR 0429): the place was given back at expiry and may be someone
        // else's now. Refused whole: its refund is already owed.
        throw new ConflictError(
          `What this order held (${line.title}) went back when it expired: refund the payment instead`,
          { order: move.id, rule: "held_gone" },
        );
      }
      if (state === moves.held && values) {
        const ownerField = object.customer?.field;
        let personId: string | null = null;
        let made = false;
        if (ownerField && !values[ownerField]) {
          // A guest's (ADR 0560): the address is matched to a Person now, by the rule a guest's
          // order uses (ADR 0428): one is theirs, none makes one, several wait for staff.
          const order = move.after as { personId?: string | null; email?: string | null };
          personId = order.personId ?? null;
          if (!personId) {
            // No address left (erased meanwhile, with the order's contact) matches no one.
            const buyer = order.email ? await matchGuest(ctx, order.email) : null;
            if (!buyer) {
              // Erased meanwhile, held by a Person in the Trash, or nobody to make one for: the
              // payment stands, the place goes back and its money is owed back.
              await release(ctx, object, moves, move.id, line.record_id, "unmatched");
              await tellAdmins(
                ctx,
                move.id,
                "A paid drop-in could not be given to anyone",
                `Order ${move.id} was paid, and its address cannot be matched to a Person on file ` +
                  "(erased, in the Trash, or no admin to create one for). Its place went back and " +
                  "its refund is waiting in Approvals.",
              );
              continue;
            }
            personId = buyer.personId;
            made = buyer.created;
            if (personId) {
              ctx.write(
                ctx.db
                  .updateTable("core_order")
                  .set({ person_id: personId })
                  .where("id", "=", move.id)
                  .where("person_id", "is", null),
              );
            }
          }
          // Several People have the address: paid, still held, until staff say whose
          // (order.setPerson, then `movesFollowPerson`).
          if (!personId) continue;
        }
        await settle(ctx, object, moves, move.id, line.record_id, values, personId, made);
        continue;
      }
      // Paid, but the record left its held place meanwhile: the buyer is owed their money, and
      // staff are told. The payment itself is applied.
      oweRefund(
        ctx,
        move.id,
        object,
        line.record_id,
        String(state ?? "gone"),
        "Paid after it was released",
      );
      await tellAdmins(
        ctx,
        move.id,
        "A payment arrived for something no longer held",
        `Order ${move.id} was paid for "${line.title}", which was no longer held for it. Its ` +
          "refund is waiting in Approvals.",
      );
      continue;
    }
    // Expired, or cancelled with nothing paid: the held place goes back.
    if (from === "pending" && state === moves.held) {
      await whileMoving(ctx, line.record_id, () =>
        updateRecord(ctx, object, line.record_id, { [field]: moves.expired }, { by: "host" }),
      );
    }
  }
};

/**
 * An order that belonged to no one has its Person now (`order.setPerson`, staff, after merging the
 * People an address matched): a paid guest record still held for it is theirs and moves to
 * `paid`, or is refunded when they already have a place. In that operation's batch.
 */
export async function movesFollowPerson(
  ctx: HandlerContext,
  orderId: string,
  personId: string,
): Promise<void> {
  const order = await loadOrderRow(ctx.db, orderId);
  if (order.state !== "paid") return;
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id"])
    .where("order_id", "=", orderId)
    .execute();
  for (const line of lines) {
    const object = getObject(line.object_type);
    const moves = movesOf(object);
    const ownerField = object?.customer?.field;
    if (!object?.states || !moves || !ownerField) continue;
    const values = await storedValues(ctx, object, line.record_id);
    if (!values || values[object.states.field] !== moves.held || values[ownerField]) continue;
    await settle(ctx, object, moves, orderId, line.record_id, values, personId);
  }
}

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
  if (isMoving(ctx, move.id)) return;
  const from = move.from.id;
  const to = move.to.id;
  const leavesHeld = from === moves.held && to !== moves.paid;
  const refunds = from !== moves.held && moves.refund.includes(to);
  if (!leavesHeld && !refunds) return;
  const order = await orderOfRecord(ctx, move.object, move.id);
  if (!order) return;
  const label =
    move.object.fields
      .find((f) => f.name === move.object.states?.field)
      ?.options?.choices?.find((c) => c.value === to)?.label ?? to;
  if (leavesHeld) {
    // Released another way (its class cancelled): its unpaid order goes too, so the provider's
    // page cannot take money for it; a payment made anyway is a late one, owed back.
    if (order.state === "pending") {
      // This write moves the record itself: the order's hook must not move it again.
      await whileMoving(ctx, move.id, () =>
        changeOrder(ctx, order, "cancelled", { cancelled_at: ctx.now }, "host"),
      );
    } else if (order.state === "paid") {
      // Paid and still held (waiting for staff to say whose): the money is owed back.
      oweRefund(ctx, order.id, move.object, move.id, to, `${move.object.label}: ${label}`);
    }
    return;
  }
  if (order.state !== "paid") return;
  oweRefund(ctx, order.id, move.object, move.id, to, `${move.object.label}: ${label}`);
};

onRecordMove("order", orderMoves);
onEveryRecordMove(recordMoves);
