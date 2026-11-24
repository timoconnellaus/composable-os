// Stage 34 step 3 (ADR 0694): an order paid another way, the shared second door into paid. Against
// the real host, the box office fixture (tickets granted with places) and the payments
// gatekeeper's test double: a payment a person with `orders:payments` records makes an order paid
// through the same settle path as a verified one (its tickets granted, its places taken), with a
// `recorded` row naming them; every other actor and a member without the permission are refused;
// a reversal by a person moves the order back; refunds go back the way the money came; and the
// database refuses a `voucher` or `stored_value` row (no ledger entry can exist yet), a recorded
// row without who received it, and any edit of the host's rows (criterion 17).
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  type InvocationContext,
  loadOrderRow,
  memoryEventSink,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { CURRENCY, historyOf, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";
import { boxOfficeManifest } from "./sellable-fixtures.ts";

const BOX = extId("paidway");
const EVENT = `${BOX}.event`;
const TICKET_TYPE = `${BOX}.tickettype`;
const RETURN = "https://shop.example.com/thanks";
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;
/** A gym's drop-in: a booking its order moves (`sellable.moves`, ADR 0560). */
const GYM = extId("paidgym");
const KLASS = `${GYM}.class`;
const BOOKING = `${GYM}.booking`;

const gym = () =>
  manifest(GYM, {
    permissions: { operations: ["order.startHeld"] },
    settings: { price: { type: "number", label: "Price" } },
    objects: {
      class: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "number", label: "Price" },
          places: { type: "number", label: "Places", required: true },
        },
        capacity: { places: "places" },
        public: { read: ["name"] },
      },
      booking: {
        label: "Booking",
        plural: "Bookings",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          class: { type: "relation", label: "Class", to: KLASS, required: true },
          person: { type: "relation", label: "Person", to: "person" },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "pending", "expired", "cancelled"].map((value) => ({
              value,
              label: value,
            })),
          },
          paid: { type: "number", label: "Paid", readOnly: true },
          order: { type: "text", label: "Order", readOnly: true },
        },
        states: {
          field: "state",
          initial: "booked",
          create: { in: { pending: ["host"] } },
          moves: [
            { from: "pending", to: "booked", by: ["host"] },
            { from: "pending", to: "expired", by: ["host"], final: true },
            { from: "booked", to: "cancelled", by: ["customer", "staff"], final: true },
          ],
        },
        claims: { on: "class", held: ["pending"], confirmed: ["booked"] },
        customer: { field: "person", read: ["class", "state"], write: ["class"] },
        sellable: {
          price: "paid",
          moves: {
            held: "pending",
            paid: "booked",
            expired: "expired",
            refund: ["cancelled"],
            price: { field: "class.price", setting: "price" },
            title: "class.name",
            order: "order",
          },
        },
      },
    },
  } as never);
const TODAY = new Date().toISOString().slice(0, 10);

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays, providerRefunds } = payments;

let admin: ActingUser;
/** A member granted `orders:payments`: the desk. */
let desk: ActingUser;
/** A member without it. */
let member: ActingUser;

interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  refunded: number;
  token?: string | null;
}
interface Paid {
  paymentId: string;
  order: OrderOut;
}

const staff = (user: ActingUser = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });

const NOT_A_PERSON: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_paid" } },
  { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_p" } },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

/** A ticket type of a new event: $50.00 by default. */
async function ticketType(values: Record<string, unknown> = {}) {
  const event = await create(EVENT, { name: unique("Camp"), places: 100 });
  return create(TICKET_TYPE, { name: unique("Ticket"), price: 50, places: 20, event, ...values });
}

async function buy(id: string, options: { quantity?: number; pay?: string; email?: string } = {}) {
  return run<OrderOut>(
    "order.start",
    {
      lines: [{ object: TICKET_TYPE, id, quantity: options.quantity ?? 1 }],
      email: options.email ?? `${unique("guest")}@buyers.example`,
      pay: options.pay ?? "full",
    },
    guest(),
  );
}

const record = (input: Record<string, unknown>, ctx = staff(desk)) =>
  run<Paid>(
    "order.recordPayment",
    { kind: "transfer", receivedOn: TODAY, reference: "INV 1042", ...input },
    ctx,
  );

async function hostRows(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_order_payment WHERE order_id = ? AND provider = 'host' ORDER BY received_at, amount DESC",
  )
    .bind(orderId)
    .all<Record<string, unknown>>();
  return results;
}

async function granted(orderId: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM core_order_grant WHERE order_id = ?")
    .bind(orderId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function taken(ticketTypeId: string) {
  return env.DB.prepare(
    "SELECT held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(TICKET_TYPE, ticketTypeId)
    .first<{ held: number; taken: number }>();
}

async function told(dedupeKey: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
  )
    .bind(dedupeKey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  admin = await createUser("admin");
  desk = await createUser("member");
  member = await createUser("member");
  await reconcile(boxOfficeManifest(BOX));
  await reconcile(gym());
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"], minPartPayment: 1000 },
    context(admin),
  );
  await run(
    "user.setPermissions",
    { id: desk.id, permissions: ["orders:payments", "orders:refund"] },
    context(admin),
  );
  await payments.connect(admin.id);
}, 60_000);

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
});

describe("a payment recorded by a person (criterion 17)", () => {
  it("makes the order paid as the host, with a recorded row naming them, through the settle path", async () => {
    const id = await ticketType();
    const order = await buy(id, { quantity: 2 });
    expect(await taken(id)).toEqual({ held: 2, taken: 0 });
    const paid = await record({ id: order.id, amount: 10_000, kind: "cash" });
    expect(paid.order).toMatchObject({ state: "paid", paid: 10_000 });
    expect(paid.paymentId).toMatch(/^opy_/);
    const [row] = await hostRows(order.id);
    expect(row).toMatchObject({
      provider: "host",
      event_id: paid.paymentId,
      method: "recorded",
      recorded_kind: "cash",
      recorded_by: desk.id,
      received_on: TODAY,
      reference: "INV 1042",
      amount: 10_000,
      outcome: "applied",
      reverses: null,
    });
    // The move is the host's, and the move hooks ran in its batch: tickets granted, places taken.
    expect((await historyOf(order.id)).at(-1)).toMatchObject({
      position_id: "paid",
      entered_as: "host",
    });
    expect(await granted(order.id)).toBe(2);
    expect(await taken(id)).toEqual({ held: 0, taken: 2 });
    // On the Person's timeline, and admins told (no threshold set: every one).
    const person = (await loadOrderRow(db.query, order.id)).person_id;
    const post = await env.DB.prepare(
      "SELECT a.subject FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id WHERE l.record_id = ? AND a.subject LIKE 'Payment recorded%'",
    )
      .bind(person)
      .first<{ subject: string }>();
    expect(post?.subject).toBe("Payment recorded: 100.00 AUD by cash");
    expect(await told(`order.payment_recorded:${paid.paymentId}`)).toBeGreaterThan(0);
    // The report view has it, by method.
    const view = await env.DB.prepare(
      "SELECT method, recorded_kind, amount FROM rec_order_payment WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(view).toEqual({ method: "recorded", recorded_kind: "cash", amount: 10_000 });
  });

  it("takes any amount up to what is owed, in parts, and refuses more", async () => {
    const order = await buy(await ticketType());
    const over = await refusal(record({ id: order.id, amount: 5_001 }));
    expect(over).toMatchObject({
      code: "invalid_input",
      details: { rule: "overpaid", owed: 5_000 },
    });
    const first = await record({ id: order.id, amount: 2_000 });
    expect(first.order).toMatchObject({ state: "part_paid", paid: 2_000 });
    // Its balance is due now: it shows among the overdue.
    expect((await loadOrderRow(db.query, order.id)).balance_due_at).not.toBeNull();
    expect(await granted(order.id)).toBe(1);
    expect(await refusal(record({ id: order.id, amount: 3_001 }))).toMatchObject({
      details: { rule: "overpaid", owed: 3_000 },
    });
    const rest = await record({ id: order.id, amount: 3_000 });
    expect(rest.order).toMatchObject({ state: "paid", paid: 5_000 });
    expect(await granted(order.id)).toBe(1);
    expect(await refusal(record({ id: order.id, amount: 1 }))).toMatchObject({ code: "conflict" });
  });

  it("is refused for an admin's assistant, an MCP client, an automation, an extension and a member without the permission", async () => {
    const order = await buy(await ticketType());
    for (const extra of NOT_A_PERSON) {
      const refused = await refusal(record({ id: order.id, amount: 5_000 }, staff(admin, extra)));
      expect(refused.code, extra.actor).toBe("forbidden");
    }
    expect((await refusal(record({ id: order.id, amount: 5_000 }, staff(member)))).code).toBe(
      "forbidden",
    );
    expect(await hostRows(order.id)).toEqual([]);
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({ state: "pending", paid: 0 });
  });

  it("refuses a day not yet come, a closed order and one whose discount waits for approval", async () => {
    const order = await buy(await ticketType());
    expect(
      await refusal(record({ id: order.id, amount: 5_000, receivedOn: `${NEXT_YEAR}` })),
    ).toMatchObject({ details: { rule: "received_on" } });
    await run("order.cancel", { id: order.id }, staff());
    expect((await refusal(record({ id: order.id, amount: 5_000 }))).code).toBe("conflict");

    // A person's discount over the limit (nothing, until an admin sets one) waits: so does paying.
    await run("user.setPermissions", { id: member.id, permissions: ["orders:discount"] }, staff());
    const discounted = await buy(await ticketType());
    await expect(
      run("order.adjust", { id: discounted.id, amount: 500, reason: "Regular" }, staff(member)),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect(await refusal(record({ id: discounted.id, amount: 5_000 }))).toMatchObject({
      details: { rule: "discount_waiting" },
    });
    await run("user.setPermissions", { id: member.id, permissions: [] }, staff());
  });

  it("tells admins only over the threshold a human admin set", async () => {
    await run("order.settings.update", { recordedPaymentNotice: 4_000 }, context(admin));
    try {
      const small = await record({
        id: (await buy(await ticketType({ price: 40 }))).id,
        amount: 4_000,
      });
      const large = await record({ id: (await buy(await ticketType())).id, amount: 5_000 });
      expect(await told(`order.payment_recorded:${small.paymentId}`)).toBe(0);
      expect(await told(`order.payment_recorded:${large.paymentId}`)).toBeGreaterThan(0);
      // Only a human admin changes it.
      expect(
        (
          await refusal(
            run(
              "order.settings.update",
              { recordedPaymentNotice: 100_000 },
              staff(admin, {
                actor: "assistant",
                origin: { surface: "assistant", sessionId: "s" },
              }),
            ),
          )
        ).code,
      ).toBe("forbidden");
    } finally {
      await run("order.settings.update", { recordedPaymentNotice: 0 }, context(admin));
    }
  });
});

describe("a reversal (criterion 17)", () => {
  it("undoes a recorded payment with a second row, moving a paid order back to part paid", async () => {
    const id = await ticketType();
    const order = await buy(id);
    const paid = await record({ id: order.id, amount: 5_000 });
    // Not an AI, not without the permission.
    for (const extra of NOT_A_PERSON.slice(0, 2)) {
      expect(
        (
          await refusal(
            run(
              "order.reversePayment",
              { paymentId: paid.paymentId, reason: "Wrong order" },
              staff(admin, extra),
            ),
          )
        ).code,
      ).toBe("forbidden");
    }
    expect(
      (
        await refusal(
          run(
            "order.reversePayment",
            { paymentId: paid.paymentId, reason: "Wrong order" },
            staff(member),
          ),
        )
      ).code,
    ).toBe("forbidden");

    const reversed = await run<Paid>(
      "order.reversePayment",
      { paymentId: paid.paymentId, reason: "Entered on the wrong order" },
      staff(desk),
    );
    expect(reversed.order).toMatchObject({ state: "part_paid", paid: 0, total: 5_000 });
    const rows = await hostRows(order.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      event_id: reversed.paymentId,
      amount: -5_000,
      reverses: paid.paymentId,
      reason: "Entered on the wrong order",
      recorded_by: desk.id,
    });
    // The first row is as it was; the order's history shows the host moved it back.
    expect(rows[0]).toMatchObject({ event_id: paid.paymentId, amount: 5_000 });
    expect((await historyOf(order.id)).at(-1)).toMatchObject({
      position_id: "part_paid",
      entered_as: "host",
    });
    // What it granted stays; the balance is owed, and the right payment makes it paid again.
    expect(await granted(order.id)).toBe(1);
    expect(await taken(id)).toEqual({ held: 0, taken: 1 });
    expect(await told(`order.payment_reversed:${reversed.paymentId}`)).toBeGreaterThan(0);
    expect(
      await refusal(
        run("order.reversePayment", { paymentId: paid.paymentId, reason: "Again" }, staff(desk)),
      ),
    ).toMatchObject({ details: { reason: "reversed" } });
    expect(
      await refusal(
        run("order.reversePayment", { paymentId: reversed.paymentId, reason: "Undo" }, staff(desk)),
      ),
    ).toMatchObject({ details: { rule: "reverse_reversal" } });
    const again = await record({ id: order.id, amount: 5_000, kind: "card_machine" });
    expect(again.order).toMatchObject({ state: "paid", paid: 5_000 });
    expect(await granted(order.id)).toBe(1);
  });

  it("is refused for the provider's payment: that is a refund", async () => {
    const order = await buy(await ticketType());
    await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
    await providerPays(order.id);
    const provider = await env.DB.prepare(
      "SELECT event_id FROM core_order_payment WHERE order_id = ?",
    )
      .bind(order.id)
      .first<{ event_id: string }>();
    expect(
      await refusal(
        run("order.reversePayment", { paymentId: provider?.event_id, reason: "No" }, staff(desk)),
      ),
    ).toMatchObject({ details: { rule: "reverse_method", method: "provider" } });
  });
});

describe("refunds go back the way the money came", () => {
  it("a recorded payment is paid back by a person, never sent; order.refund sends only the provider's", async () => {
    const order = await buy(await ticketType());
    const paid = await record({ id: order.id, amount: 5_000 });
    const sent = gw.refunds.size;
    expect(
      await refusal(run("order.refund", { id: order.id, reason: "Cannot come" }, staff())),
    ).toMatchObject({ details: { rule: "refund_method" } });
    // Not an AI's to record.
    expect(
      (
        await refusal(
          run(
            "order.recordRefund",
            { id: order.id, paymentId: paid.paymentId, kind: "cash", reason: "Cannot come" },
            staff(admin, NOT_A_PERSON[0]),
          ),
        )
      ).code,
    ).toBe("forbidden");
    const part = await run<{ amount: number; order: OrderOut }>(
      "order.recordRefund",
      {
        id: order.id,
        paymentId: paid.paymentId,
        amount: 2_000,
        kind: "transfer",
        reason: "Half back",
      },
      staff(desk),
    );
    expect(part.order).toMatchObject({ state: "paid", refunded: 2_000 });
    // A payment with money paid back on it was received: it is not reversed.
    expect(
      await refusal(
        run("order.reversePayment", { paymentId: paid.paymentId, reason: "Error" }, staff(desk)),
      ),
    ).toMatchObject({ details: { rule: "reverse_refunded" } });
    const rest = await run<{ amount: number; order: OrderOut }>(
      "order.recordRefund",
      { id: order.id, paymentId: paid.paymentId, kind: "cash", reason: "The rest" },
      staff(desk),
    );
    expect(rest).toMatchObject({ amount: 3_000, order: { state: "refunded", refunded: 5_000 } });
    expect(await granted(order.id)).toBe(1);
    const refunds = await env.DB.prepare(
      "SELECT method, recorded_kind, status, amount, requested_by FROM core_order_refund WHERE order_id = ? ORDER BY amount",
    )
      .bind(order.id)
      .all();
    expect(refunds.results).toEqual([
      {
        method: "recorded",
        recorded_kind: "transfer",
        status: "confirmed",
        amount: 2_000,
        requested_by: desk.id,
      },
      {
        method: "recorded",
        recorded_kind: "cash",
        status: "confirmed",
        amount: 3_000,
        requested_by: desk.id,
      },
    ]);
    expect(gw.refunds.size).toBe(sent);
  });

  it("an order paid two ways: the provider's part through the provider, the rest by a person", async () => {
    const id = await ticketType({ price: 1000, depositAmount: 200, balanceDue: NEXT_YEAR });
    const order = await buy(id, { pay: "deposit" });
    await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
    await providerPays(order.id);
    const balance = await record({ id: order.id, amount: 80_000, kind: "transfer" });
    expect(balance.order).toMatchObject({ state: "paid", paid: 100_000 });
    const asked = await run<{ refunds: { amount: number; pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "Cancelled trip" },
      staff(),
    );
    expect(asked.refunds.map((r) => r.amount)).toEqual([20_000]);
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({
      state: "paid",
      refunded: 20_000,
    });
    await run(
      "order.recordRefund",
      { id: order.id, paymentId: balance.paymentId, kind: "transfer", reason: "Cancelled trip" },
      staff(desk),
    );
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({
      state: "refunded",
      refunded: 100_000,
    });
    const methods = await env.DB.prepare(
      "SELECT method, sum(amount) AS amount FROM rec_order_payment WHERE order_id = ? GROUP BY method ORDER BY method",
    )
      .bind(order.id)
      .all();
    expect(methods.results).toEqual([
      { method: "provider", amount: 20_000 },
      { method: "recorded", amount: 80_000 },
    ]);
  });
});

describe("the database's guard on payment rows (criterion 17)", () => {
  const insert = (values: Record<string, unknown>) => {
    const row = {
      provider: "host",
      event_id: unique("opy_x"),
      amount: 100,
      currency: CURRENCY,
      outcome: "applied",
      received_at: new Date().toISOString(),
      ...values,
    };
    const columns = Object.keys(row);
    return env.DB.prepare(
      `INSERT INTO core_order_payment (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
      .bind(...Object.values(row))
      .run();
  };

  it("refuses a voucher or stored value row without its ledger entry, and a recorded one without who", async () => {
    const order = await buy(await ticketType());
    await expect(
      insert({ order_id: order.id, method: "voucher", voucher_id: "v" }),
    ).rejects.toThrow(/core_order_payment_ledger/);
    await expect(
      insert({ order_id: order.id, method: "stored_value", stored_value_id: "s" }),
    ).rejects.toThrow(/core_order_payment_ledger/);
    await expect(
      insert({ order_id: order.id, method: "recorded", recorded_kind: "cash", received_on: TODAY }),
    ).rejects.toThrow(/core_order_payment_recorded/);
    // The host's rows are never the provider's, nor the provider's the host's.
    await expect(insert({ order_id: order.id, method: "provider" })).rejects.toThrow(
      /core_order_payment_method/,
    );
    await expect(
      insert({
        order_id: order.id,
        provider: "fake",
        method: "recorded",
        recorded_kind: "cash",
        recorded_by: admin.id,
        received_on: TODAY,
      }),
    ).rejects.toThrow(/core_order_payment_method/);
    // Nothing made it onto the order.
    expect(await hostRows(order.id)).toEqual([]);
  });

  it("refuses a reversal that does not undo a recorded payment, and any edit of the host's rows", async () => {
    const order = await buy(await ticketType());
    const paid = await record({ id: order.id, amount: 5_000 });
    const recorded = {
      order_id: order.id,
      method: "recorded",
      recorded_kind: "cash",
      recorded_by: admin.id,
      received_on: TODAY,
    };
    await expect(
      insert({ ...recorded, amount: -4_000, reverses: paid.paymentId, reason: "Half" }),
    ).rejects.toThrow(/core_order_payment_reversal/);
    await expect(insert({ ...recorded, amount: -5_000, reverses: paid.paymentId })).rejects.toThrow(
      /core_order_payment_reversal/,
    );
    await expect(insert({ ...recorded, amount: -5_000 })).rejects.toThrow(
      /core_order_payment_amount/,
    );
    await expect(
      env.DB.prepare("UPDATE core_order_payment SET amount = 1 WHERE event_id = ?")
        .bind(paid.paymentId)
        .run(),
    ).rejects.toThrow(/core_order_payment_fixed/);
    await expect(
      env.DB.prepare("UPDATE core_order_payment SET recorded_by = ? WHERE event_id = ?")
        .bind(member.id, paid.paymentId)
        .run(),
    ).rejects.toThrow(/core_order_payment_fixed/);
  });
});

describe("erase", () => {
  it("keeps a recorded payment's amount and kind, and blanks its reference and the audit's copy", async () => {
    const order = await buy(await ticketType());
    const paid = await record({ id: order.id, amount: 5_000, reference: "Payer ref 7731" });
    const person = (await loadOrderRow(db.query, order.id)).person_id;
    const logged = await env.DB.prepare(
      "SELECT id FROM core_audit WHERE operation = 'order.recordPayment' AND json_extract(input, '$.id') = ?",
    )
      .bind(order.id)
      .first<{ id: string }>();
    await run("person.erase", { id: person }, context(admin));
    const [row] = await hostRows(order.id);
    expect(row).toMatchObject({
      event_id: paid.paymentId,
      amount: 5_000,
      recorded_kind: "transfer",
      reference: null,
    });
    const audit = await env.DB.prepare(
      "SELECT a.input, (SELECT count(*) FROM core_audit_redactions r WHERE r.audit_id = a.id) AS redacted FROM core_audit a WHERE a.id = ?",
    )
      .bind(logged?.id)
      .first<{ input: string; redacted: number }>();
    expect(audit?.redacted).toBe(1);
    expect(audit?.input).not.toContain("7731");
  });
});

// --- Review of PR #426 ---------------------------------------------------------------------------

/** A drop-in of a $20.00 class, started by the gym's tool for a visitor. */
async function dropIn() {
  const klass = await create(KLASS, { name: unique("Yoga"), price: 20, places: 10 });
  return run<{ id: string; recordId: string; total: number }>(
    "order.startHeld",
    { object: BOOKING, values: { class: klass }, email: `${unique("v")}@buyers.example` },
    context(admin, {
      actor: "extension",
      origin: { surface: "extension", extensionId: GYM },
      extension: {
        id: GYM,
        permissions: gym().permissions,
        tool: { name: "book", humanOnly: false, permission: null },
      },
    } as never),
  );
}

async function bookingState(id: string) {
  return (await run<{ values: { state: string } }>("record.get", { object: BOOKING, id }, staff()))
    .values.state;
}

async function refundsDue(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT entered, reason FROM core_sellable_refund_due WHERE order_id = ?",
  )
    .bind(orderId)
    .all();
  return results;
}

describe("a drop-in paid another way (review of PR #426)", () => {
  it("is paid in full or not at all: a part payment is refused, the whole books it", async () => {
    const order = await dropIn();
    expect(order.total).toBe(2_000);
    expect(await refusal(record({ id: order.id, amount: 1_000, kind: "cash" }))).toMatchObject({
      details: { rule: "paid_in_full", owed: 2_000 },
    });
    expect(await bookingState(order.recordId)).toBe("pending");
    const paid = await record({ id: order.id, amount: 2_000, kind: "cash" });
    expect(paid.order.state).toBe("paid");
    expect(await bookingState(order.recordId)).toBe("booked");
    expect(await refundsDue(order.id)).toEqual([]);
  });

  it("a reversal waits for the booking to be cancelled, and paying again owes nothing for a booked place", async () => {
    const order = await dropIn();
    const paid = await record({ id: order.id, amount: 2_000, kind: "cash" });
    // Booked: the order cannot move it back, so the reversal is refused (it would leave the
    // place booked with nothing paid, and a later payment told "paid after it was released").
    expect(
      await refusal(
        run("order.reversePayment", { paymentId: paid.paymentId, reason: "Wrong" }, staff(desk)),
      ),
    ).toMatchObject({ details: { rule: "reverse_booked" } });
    expect(await refundsDue(order.id)).toEqual([]);
    // Staff cancel the booking, then reverse, then cancel the order: no place is left booked.
    await run(
      "record.update",
      { object: BOOKING, id: order.recordId, values: { state: "cancelled" } },
      staff(),
    );
    const reversed = await run<Paid>(
      "order.reversePayment",
      { paymentId: paid.paymentId, reason: "Wrong order" },
      staff(desk),
    );
    expect(reversed.order).toMatchObject({ state: "part_paid", paid: 0 });
    const cancelled = await run<OrderOut>("order.cancel", { id: order.id }, staff());
    expect(cancelled.state).toBe("cancelled");
    expect(await bookingState(order.recordId)).toBe("cancelled");
  });

  it("tells admins when the buyer had opened a payment page, whatever the threshold", async () => {
    await run("order.settings.update", { recordedPaymentNotice: 100_000 }, context(admin));
    try {
      const order = await buy(await ticketType());
      await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
      const paid = await record({ id: order.id, amount: 5_000 });
      const notice = await env.DB.prepare(
        "SELECT body FROM core_notifications WHERE dedupe_key = ?",
      )
        .bind(`order.payment_recorded:${paid.paymentId}`)
        .first<{ body: string }>();
      expect(notice?.body).toContain("opened a payment page");
      // Without a page and under the threshold, nobody is told.
      const quiet = await record({ id: (await buy(await ticketType())).id, amount: 5_000 });
      expect(await told(`order.payment_recorded:${quiet.paymentId}`)).toBe(0);
    } finally {
      await run("order.settings.update", { recordedPaymentNotice: 0 }, context(admin));
    }
  });

  it("refuses a day that does not exist, one in the future and one long past", async () => {
    const order = await buy(await ticketType());
    const yearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    for (const receivedOn of ["2026-02-31", "0001-01-01", NEXT_YEAR, yearAgo]) {
      expect(
        await refusal(record({ id: order.id, amount: 5_000, receivedOn })),
        receivedOn,
      ).toMatchObject({ details: { rule: "received_on" } });
    }
    expect(await hostRows(order.id)).toEqual([]);
  });

  it("the host's payment rows and recorded refunds are never deleted, and refunds are reported by method", async () => {
    const order = await buy(await ticketType());
    const paid = await record({ id: order.id, amount: 5_000 });
    await expect(
      env.DB.prepare("DELETE FROM core_order_payment WHERE event_id = ?")
        .bind(paid.paymentId)
        .run(),
    ).rejects.toThrow(/core_order_payment_kept/);
    const back = await run<{ refundId: string }>(
      "order.recordRefund",
      { id: order.id, paymentId: paid.paymentId, kind: "cash", reason: "Changed plans" },
      staff(desk),
    );
    await expect(
      env.DB.prepare("DELETE FROM core_order_refund WHERE id = ?").bind(back.refundId).run(),
    ).rejects.toThrow(/core_order_refund_kept/);
    await expect(
      env.DB.prepare("UPDATE core_order_refund SET amount = 1 WHERE id = ?")
        .bind(back.refundId)
        .run(),
    ).rejects.toThrow(/core_order_refund_fixed/);
    const view = await env.DB.prepare(
      "SELECT method, recorded_kind, amount, status FROM rec_order_refund WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(view).toEqual({
      method: "recorded",
      recorded_kind: "cash",
      amount: 5_000,
      status: "confirmed",
    });
  });
});
