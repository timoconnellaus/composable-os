// Stage 25, second half (ADRs 0426 to 0428): orders priced by the host, the rule that only a
// verified payment marks an order paid, paying by deposit, and buying without an account.
// Acceptance criteria 3 (prices are the host's), 4 and 5 as far as they live in the host (the
// gatekeeper and the webhook route are the other half), 7 (guest checkout), 9 (currency), 10
// (isolation, with test/audiences-isolation.test.ts) and 12a (deposit).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  chargeFor,
  loadOrderRow,
  onRecordMove,
  toMinorUnits,
} from "../src/index.ts";
import { orderStartInput } from "../src/operations/order.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  createTicketType,
  historyOf,
  IMPORT,
  installBoxOffice,
  orderRow,
  outside,
  POSTER,
  PUBLIC,
  paymentsOf,
  refusal,
  run,
  TICKET_TYPE,
} from "./order-fixtures.ts";

interface OrderOut {
  id: string;
  state: string;
  currency: string;
  total: number;
  paid: number;
  balance: number;
  pay: string;
  deposit: number | null;
  balanceDueAt: string | null;
  expiresAt: string | null;
  token?: string | null;
  personId?: string | null;
  email?: string | null;
  lines: {
    object: string;
    recordId: string;
    title: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
}

let admin: ActingUser;
let member: ActingUser;
let alice: Buyer;
let bob: Buyer;
/** $120.00, no deposit. */
let general: string;
/** $2,999.00 with a $750.00 deposit, balance due next year. */
let camp: string;

const staff = () => context(member);
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

const start = (
  ctx: Parameters<typeof run>[2],
  lines: { object?: string; id: string; quantity?: number }[],
  extra: Record<string, unknown> = {},
) =>
  run<OrderOut>(
    "order.start",
    { lines: lines.map((l) => ({ object: TICKET_TYPE, ...l })), ...extra },
    ctx,
  );

/** Plays the provider: applies a payment as the gatekeeper would hand it over, verified. */
const pay = (orderId: string, amount: number, extra: Record<string, unknown> = {}) =>
  run<{ outcome: string; state?: string }>(
    "fixture.verifiedPayment",
    { orderId, amount, eventId: unique("evt"), ...extra },
    context(admin, { actor: "automation" }),
  );

async function adminNotices(key: string): Promise<number> {
  const row = (await env.DB.prepare(
    "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND dedupe_key LIKE ?",
  )
    .bind(admin.id, `${key}%`)
    .first()) as { n: number };
  return Number(row.n);
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await installBoxOffice(admin);
  alice = await createBuyer(admin, "alice");
  bob = await createBuyer(admin, "bob");
  general = await createTicketType(admin, { name: "General admission", price: 120 });
  camp = await createTicketType(admin, {
    name: "Shared garden suite",
    price: 2999,
    depositAmount: 750,
    balanceDue: NEXT_YEAR,
  });
}, 60_000);

describe("prices are the host's (criterion 3)", () => {
  it("the input has nowhere to put a price, a total or an amount paid", () => {
    const schema = z.toJSONSchema(orderStartInput, { io: "input" }) as {
      properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["email", "lines", "pay"]);
    expect(Object.keys(schema.properties.lines?.items?.properties ?? {}).sort()).toEqual([
      "id",
      "object",
      "quantity",
    ]);
  });

  it("an order sent with a tampered price and total is priced from the records", async () => {
    const order = await run<OrderOut>(
      "order.start",
      {
        lines: [
          { object: TICKET_TYPE, id: general, quantity: 2, unitPrice: 1, price: 0.01, total: 1 },
        ],
        total: 1,
        paid: 24_000,
        state: "paid",
        currency: "USD",
      },
      outside(alice.principal),
    );
    expect(order).toMatchObject({
      state: "pending",
      currency: CURRENCY,
      total: 24_000,
      paid: 0,
      balance: 24_000,
      pay: "full",
      token: null,
    });
    expect(order.lines).toEqual([
      expect.objectContaining({
        object: TICKET_TYPE,
        recordId: general,
        title: "General admission",
        quantity: 2,
        unitPrice: 12_000,
        total: 24_000,
      }),
    ]);
    const stored = await orderRow(order.id);
    expect(stored).toMatchObject({ total: 24_000, paid: 0, state: "pending", currency: CURRENCY });
    expect(stored.person_id).toBe(alice.principal.personId);
    expect(stored.email).toBe(alice.email);
  });

  it("a price change after the order started does not change the order", async () => {
    const id = await createTicketType(admin, { price: 50 });
    const order = await start(outside(alice.principal), [{ id }]);
    await run("record.update", { object: TICKET_TYPE, id, values: { price: 5 } }, staff());
    expect((await orderRow(order.id)).total).toBe(5000);
    expect((await start(outside(alice.principal), [{ id }])).total).toBe(500);
  });

  it("refuses what is not for sale, with one answer for all of it", async () => {
    const poster = await createTicketType(admin, { price: 10 }, POSTER);
    const trashed = await createTicketType(admin, { price: 10 });
    await run("record.delete", { object: TICKET_TYPE, id: trashed }, staff());
    const answers = await Promise.all(
      [
        [{ object: POSTER, id: poster }],
        [{ id: "rec_01GUESSED00000000000000000" }],
        [{ id: trashed }],
        [{ object: "person", id: alice.principal.personId }],
        [{ object: "nope.nope", id: "x" }],
      ].map((lines) => refusal(start(outside(alice.principal), lines))),
    );
    for (const answer of answers) {
      expect(answer).toMatchObject({
        code: "invalid_input",
        message: "This cannot be bought",
        details: { rule: "not_for_sale", line: 0 },
      });
    }
  });

  it("refuses a record with no price, the same record twice, and an order of nothing", async () => {
    const unpriced = await createTicketType(admin, { price: null });
    expect(await refusal(start(staff(), [{ id: unpriced }], { email: alice.email }))).toMatchObject(
      { code: "invalid_input", details: { rule: "no_price" } },
    );
    expect(
      await refusal(start(outside(alice.principal), [{ id: general }, { id: general }])),
    ).toMatchObject({ details: { rule: "duplicate_line", line: 1 } });
    const free = await createTicketType(admin, { price: 0 });
    expect(await refusal(start(outside(alice.principal), [{ id: free }]))).toMatchObject({
      details: { rule: "total" },
    });
  });

  it("a price with more decimals than the currency has is not a price", () => {
    expect(toMinorUnits(120, "AUD")).toBe(12_000);
    expect(toMinorUnits(19.99, "AUD")).toBe(1999);
    expect(toMinorUnits(19.999, "AUD")).toBeNull();
    expect(toMinorUnits(-1, "AUD")).toBeNull();
    expect(toMinorUnits(500, "JPY")).toBe(500);
  });
});

describe("one currency per deployment (criterion 9)", () => {
  it("an order in the deployment's currency succeeds, and a line priced in another is refused", async () => {
    const imported = await createTicketType(admin, { price: 10 }, IMPORT);
    const answer = await refusal(
      start(outside(alice.principal), [{ id: general }, { object: IMPORT, id: imported }]),
    );
    expect(answer).toMatchObject({
      code: "invalid_input",
      details: { rule: "currency", line: 1, currency: "USD" },
    });
  });

  it("only a human admin changes the currency", async () => {
    for (const ctx of [
      context(member),
      context(admin, { actor: "assistant" }),
      context(admin, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "c", sessionId: unique("cap") },
        reason: "test",
      }),
      context(admin, { actor: "automation" }),
    ]) {
      const answer = await refusal(run("order.settings.update", { currency: "USD" }, ctx));
      expect(["forbidden", "denied"]).toContain(answer.code);
    }
    expect(await run("order.settings.get", {}, staff())).toMatchObject({ currency: CURRENCY });
    expect(
      await refusal(run("order.settings.update", { currency: "ZZZ" }, context(admin))),
    ).toMatchObject({ code: "invalid_input" });
  });
});

describe("only a verified payment marks an order paid (criterion 4, host side)", () => {
  it("no caller can move an order to paid, part paid, expired or refunded", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    for (const by of ["staff", "customer"] as const) {
      for (const to of ["paid", "part_paid", "expired"] as const) {
        const answer = await refusal(
          run("fixture.moveOrderAs", { id: order.id, to, by }, context(admin)),
        );
        expect(answer, `${by} → ${to}`).toMatchObject({
          code: "invalid_input",
          details: { rule: "state_move_not_permitted", object: "order", by: ["host"] },
        });
      }
    }
    // The generic record operations do not write an order at all.
    for (const [name, input] of [
      ["record.update", { object: "order", id: order.id, values: { state: "paid" } }],
      ["record.update", { object: "order", id: order.id, values: { paid: 12_000 } }],
      ["record.create", { object: "order", values: { state: "paid", total: 1 } }],
      ["record.delete", { object: "order", id: order.id }],
    ] as const) {
      expect((await refusal(run(name, input, context(admin)))).code).toBe("invalid_input");
    }
    expect(await orderRow(order.id)).toMatchObject({ state: "pending", paid: 0 });
  });

  it("a verified payment of the whole price makes it paid, as the host, in one batch", async () => {
    const order = await start(outside(alice.principal), [{ id: general, quantity: 2 }]);
    expect(await pay(order.id, 24_000)).toEqual({ outcome: "applied", state: "paid" });
    const stored = await orderRow(order.id);
    expect(stored).toMatchObject({ state: "paid", paid: 24_000, version: 1 });
    expect(stored.paid_at).toBeTruthy();
    expect(stored.access_until).toBeTruthy();
    const history = await historyOf(order.id);
    expect(history.map((h) => [h.position_id, h.entered_as])).toEqual([
      ["pending", "host"],
      ["paid", "host"],
    ]);
    // A customer started it: no staff user is named as the author of its first row.
    expect(history[0]?.entered_by).toBeNull();
    expect(await paymentsOf(order.id)).toEqual([
      expect.objectContaining({ amount: 24_000, currency: CURRENCY, outcome: "applied" }),
    ]);
  });

  it("the same event applied twice changes nothing (idempotent by the provider's event id)", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    const eventId = unique("evt");
    expect(await pay(order.id, 12_000, { eventId })).toMatchObject({ outcome: "applied" });
    const before = JSON.stringify([
      await orderRow(order.id),
      await historyOf(order.id),
      await paymentsOf(order.id),
    ]);
    expect(await pay(order.id, 12_000, { eventId })).toEqual({ outcome: "duplicate" });
    expect(
      JSON.stringify([
        await orderRow(order.id),
        await historyOf(order.id),
        await paymentsOf(order.id),
      ]),
    ).toBe(before);
  });

  it("two deliveries of one event at the same moment: one applies", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    const eventId = unique("evt");
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        run(
          "fixture.verifiedPayment",
          { orderId: order.id, amount: 12_000, eventId },
          context(admin),
        ),
      ),
    );
    const applied = results.filter(
      (r) => r.status === "fulfilled" && (r.value as { outcome: string }).outcome === "applied",
    );
    expect(applied).toHaveLength(1);
    expect(await orderRow(order.id)).toMatchObject({ state: "paid", paid: 12_000, version: 1 });
    expect(await paymentsOf(order.id)).toHaveLength(1);
    expect((await historyOf(order.id)).map((h) => h.position_id)).toEqual(["pending", "paid"]);
  });

  it("a different amount or currency leaves it pending and tells staff (criterion 5)", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    const before = await adminNotices("order.payment_mismatch");
    expect(await pay(order.id, 11_999)).toEqual({ outcome: "mismatch" });
    expect(await pay(order.id, 12_001)).toEqual({ outcome: "mismatch" });
    expect(await pay(order.id, 12_000, { currency: "USD" })).toEqual({ outcome: "mismatch" });
    expect(await orderRow(order.id)).toMatchObject({ state: "pending", paid: 0, version: 0 });
    expect((await paymentsOf(order.id)).map((p) => p.outcome)).toEqual([
      "mismatch",
      "mismatch",
      "mismatch",
    ]);
    expect(await adminNotices("order.payment_mismatch")).toBe(before + 3);
    // And the right payment still applies afterwards.
    expect(await pay(order.id, 12_000)).toMatchObject({ outcome: "applied", state: "paid" });
  });

  it("a payment for an order that has closed is recorded as late and never makes it paid", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    await run("order.cancel", { id: order.id }, outside(alice.principal));
    const before = await adminNotices("order.late_payment");
    expect(await pay(order.id, 12_000)).toEqual({ outcome: "late" });
    expect(await orderRow(order.id)).toMatchObject({ state: "cancelled", paid: 0 });
    expect(await adminNotices("order.late_payment")).toBe(before + 1);
    // A second payment on a paid order is late too: nothing is owed.
    const paid = await start(outside(alice.principal), [{ id: general }]);
    await pay(paid.id, 12_000);
    expect(await pay(paid.id, 12_000)).toEqual({ outcome: "late" });
    expect(await orderRow(paid.id)).toMatchObject({ state: "paid", paid: 12_000 });
  });

  it("an order written from a read that is no longer current is refused, not half applied", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    // A raw write that says nothing of the version it read, as a bug would make it.
    await expect(
      env.DB.prepare("UPDATE core_order SET paid = 12000, state = 'paid' WHERE id = ?")
        .bind(order.id)
        .run(),
    ).rejects.toThrow(/core_order_stale/);
    expect(await orderRow(order.id)).toMatchObject({ state: "pending", paid: 0 });
  });
});

describe("paying by deposit (criterion 12a)", () => {
  it("the deposit and the due date come from the records, never from the caller", async () => {
    const order = await run<OrderOut>(
      "order.start",
      {
        lines: [{ object: TICKET_TYPE, id: camp, quantity: 2, deposit: 1 }],
        pay: "deposit",
        deposit: 1,
        balanceDueAt: "2099-01-01T00:00:00Z",
      },
      outside(alice.principal),
    );
    expect(order).toMatchObject({
      state: "pending",
      pay: "deposit",
      total: 599_800,
      deposit: 150_000,
      balanceDueAt: `${NEXT_YEAR}T23:59:59.999Z`,
    });
  });

  it("is refused when a line offers none, and when the balance is already due", async () => {
    expect(
      await refusal(
        start(outside(alice.principal), [{ id: camp }, { id: general }], { pay: "deposit" }),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "deposit_not_offered", line: 1 } });
    const past = await createTicketType(admin, {
      price: 500,
      depositAmount: 100,
      balanceDue: "2020-01-01",
    });
    expect(
      await refusal(start(outside(alice.principal), [{ id: past }], { pay: "deposit" })),
    ).toMatchObject({ details: { rule: "deposit_not_offered" } });
    // Paying in full for the same record is fine.
    expect(await start(outside(alice.principal), [{ id: past }])).toMatchObject({ total: 50_000 });
  });

  it("deposit, a part of the balance, then the rest: part paid, part paid, paid", async () => {
    const order = await start(outside(alice.principal), [{ id: camp }], { pay: "deposit" });
    // The first payment is the deposit, and only the deposit.
    expect(await pay(order.id, 299_900)).toEqual({ outcome: "mismatch" });
    expect(await pay(order.id, 74_999)).toEqual({ outcome: "mismatch" });
    expect(await pay(order.id, 75_000)).toEqual({ outcome: "applied", state: "part_paid" });
    expect(await orderRow(order.id)).toMatchObject({ state: "part_paid", paid: 75_000 });
    // A part-paid order is open: a guest's link would still work, and it has no closing date.
    expect((await orderRow(order.id)).access_until).toBeNull();

    // More than the balance is refused; a part of it is taken.
    expect(await pay(order.id, 224_901)).toEqual({ outcome: "mismatch" });
    expect(await pay(order.id, 100_000)).toEqual({ outcome: "applied", state: "part_paid" });
    const seen = await run<OrderOut>("order.get", { id: order.id }, outside(alice.principal));
    expect(seen).toMatchObject({ state: "part_paid", paid: 175_000, balance: 124_900 });

    expect(await pay(order.id, 124_900)).toEqual({ outcome: "applied", state: "paid" });
    expect(await orderRow(order.id)).toMatchObject({ state: "paid", paid: 299_900, version: 3 });
    expect((await historyOf(order.id)).map((h) => [h.position_id, h.entered_as])).toEqual([
      ["pending", "host"],
      ["part_paid", "host"],
      ["paid", "host"],
    ]);
  });

  it("what a checkout may charge: the deposit, then the balance or a part of it", async () => {
    const order = await start(outside(alice.principal), [{ id: camp }], { pay: "deposit" });
    const pending = await loadOrderRow(db.query, order.id);
    expect(chargeFor(pending, 1000)).toEqual({
      amount: 75_000,
      currency: CURRENCY,
      kind: "deposit",
    });
    expect(() => chargeFor(pending, 1000, 50_000)).toThrow(/not the buyer's to choose/);
    await pay(order.id, 75_000);
    const part = await loadOrderRow(db.query, order.id);
    expect(chargeFor(part, 1000)).toEqual({ amount: 224_900, currency: CURRENCY, kind: "balance" });
    expect(chargeFor(part, 1000, 1000)).toEqual({ amount: 1000, currency: CURRENCY, kind: "part" });
    expect(() => chargeFor(part, 1000, 999)).toThrow(/between 1000 and 224900/);
    expect(() => chargeFor(part, 1000, 224_901)).toThrow(/between/);
    // When less than the minimum is owed, the balance is the least.
    expect(chargeFor({ ...part, paid: 299_500 }, 1000)).toMatchObject({ amount: 400 });
    expect(() => chargeFor({ ...part, state: "paid" }, 1000)).toThrow(/Nothing can be paid/);
    // An order paid in full is charged its total, and nothing else.
    const full = await loadOrderRow(
      db.query,
      (await start(outside(alice.principal), [{ id: general }])).id,
    );
    expect(chargeFor(full, 1000)).toEqual({ amount: 12_000, currency: CURRENCY, kind: "full" });
  });

  it("past the due date nothing moves: it is listed as overdue until staff extend or cancel", async () => {
    const order = await start(outside(alice.principal), [{ id: camp }], { pay: "deposit" });
    await pay(order.id, 75_000);
    const later = () => new Date(`${Number(NEXT_YEAR.slice(0, 4)) + 1}-01-01T00:00:00Z`);
    const overdue = async () =>
      (
        await run<{ items: { id: string }[] }>(
          "order.overdue",
          { limit: 200 },
          context(member, { clock: later }),
        )
      ).items.map((o) => o.id);
    expect(await overdue()).toContain(order.id);
    expect((await run<{ items: { id: string }[] }>("order.overdue", {}, staff())).items).toEqual(
      [],
    );
    expect(await orderRow(order.id)).toMatchObject({ state: "part_paid" });

    // The buyer cannot move the date; staff can, to a date in the future only.
    expect(
      (
        await refusal(
          run(
            "order.extendBalanceDue",
            { id: order.id, balanceDueAt: "2099-01-01T00:00:00Z" },
            outside(alice.principal),
          ),
        )
      ).code,
    ).toBe("unknown_operation");
    expect(
      await refusal(
        run(
          "order.extendBalanceDue",
          { id: order.id, balanceDueAt: "2020-01-01T00:00:00Z" },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
    const extended = await run<OrderOut>(
      "order.extendBalanceDue",
      { id: order.id, balanceDueAt: "2099-01-01T00:00:00+10:00" },
      staff(),
    );
    expect(extended).toMatchObject({
      state: "part_paid",
      balanceDueAt: "2098-12-31T14:00:00.000Z",
    });
    expect(await overdue()).not.toContain(order.id);
  });

  it("a buyer cancels only an order nothing is paid on; staff cancel a part-paid one", async () => {
    const order = await start(outside(alice.principal), [{ id: camp }], { pay: "deposit" });
    await pay(order.id, 75_000);
    expect(
      await refusal(run("order.cancel", { id: order.id }, outside(alice.principal))),
    ).toMatchObject({
      code: "invalid_input",
      details: { rule: "state_move_not_permitted", by: ["staff"] },
    });
    expect(await orderRow(order.id)).toMatchObject({ state: "part_paid" });
    expect(await run<OrderOut>("order.cancel", { id: order.id }, staff())).toMatchObject({
      state: "cancelled",
      paid: 75_000,
    });
    const history = await historyOf(order.id);
    expect(history.at(-1)).toMatchObject({
      position_id: "cancelled",
      entered_as: "staff",
      entered_by: member.id,
    });
    // Cancelled is final.
    expect(await refusal(run("order.cancel", { id: order.id }, staff()))).toMatchObject({
      code: "conflict",
    });
  });
});

describe("a customer's own orders (criterion 10, with the isolation suite)", () => {
  it("a customer moves their order as a customer: the history says so, with no staff author", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    expect(
      await run<OrderOut>("order.cancel", { id: order.id }, outside(alice.principal)),
    ).toMatchObject({ state: "cancelled" });
    expect((await historyOf(order.id)).at(-1)).toMatchObject({
      position_id: "cancelled",
      entered_as: "customer",
      entered_by: null,
    });
  });

  it("sees their own orders and lines, and another's is not there", async () => {
    const mine = await start(outside(alice.principal), [{ id: general }]);
    const theirs = await start(outside(bob.principal), [{ id: general, quantity: 3 }]);
    const got = await run<OrderOut>("order.get", { id: mine.id }, outside(alice.principal));
    expect(got).toMatchObject({ id: mine.id, total: 12_000 });
    expect(got.lines).toHaveLength(1);
    // Nothing staff-only is in a customer's answer.
    expect(got).not.toHaveProperty("email");
    expect(got).not.toHaveProperty("personId");

    const guess = "ord_01GUESSED00000000000000000";
    for (const name of ["order.get", "order.cancel"]) {
      const other = await refusal(run(name, { id: theirs.id }, outside(alice.principal)));
      const none = await refusal(run(name, { id: guess }, outside(alice.principal)));
      expect(other.code).toBe("not_found");
      expect(other.message.replace(theirs.id, "<id>")).toBe(none.message.replace(guess, "<id>"));
    }
    expect(await orderRow(theirs.id)).toMatchObject({ state: "pending" });

    // Through the generic reads too: the seam shows a customer their own orders and lines.
    const page = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
      "my.list",
      { object: "order", limit: 200 },
      outside(alice.principal),
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(Object.keys(page.items[0]?.values ?? {})).not.toContain("email");
    const lines = await run<{ items: { values: Record<string, unknown> }[] }>(
      "my.list",
      { object: "orderLine", limit: 200 },
      outside(alice.principal),
    );
    expect(lines.items.length).toBeGreaterThan(0);
    expect(lines.items.every((line) => line.values.orderId !== theirs.id)).toBe(true);
    // Staff see whose it is.
    expect(await run<OrderOut>("order.get", { id: theirs.id }, staff())).toMatchObject({
      personId: bob.principal.personId,
      email: bob.email,
    });
  });

  it("the public have no orders to read, and no way to cancel one", async () => {
    const order = await start(outside(alice.principal), [{ id: general }]);
    for (const name of ["order.get", "order.cancel", "order.overdue", "order.settings.get"]) {
      expect((await refusal(run(name, { id: order.id }, outside(PUBLIC)))).code).toBe(
        "unknown_operation",
      );
    }
  });
});

describe("buying without an account (criterion 7)", () => {
  it("a guest needs an email address, and a signed-in customer must not send one", async () => {
    expect(await refusal(start(outside(PUBLIC), [{ id: general }]))).toMatchObject({
      code: "invalid_input",
      details: { field: "email" },
    });
    expect(
      await refusal(start(outside(PUBLIC), [{ id: general }], { email: "not an address" })),
    ).toMatchObject({ code: "invalid_input", details: { field: "email" } });
    expect(
      await refusal(start(outside(alice.principal), [{ id: general }], { email: bob.email })),
    ).toMatchObject({ code: "invalid_input", details: { field: "email" } });
  });

  it("no one has the address: a Person is created with it, in the order's own batch", async () => {
    const email = `${unique("Guest")}@Guests.Example`;
    const order = await start(outside(PUBLIC), [{ id: general }], { email });
    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
    // A guest never reads a Person, or the address back.
    expect(order).not.toHaveProperty("personId");
    expect(order).not.toHaveProperty("email");
    const stored = await orderRow(order.id);
    expect(stored).toMatchObject({ email: email.toLowerCase(), placed_as: "public" });
    expect(stored.person_id).toBeTruthy();
    const person = (await env.DB.prepare(
      "SELECT p.id, p.created_by FROM core_person p JOIN core_person_emails e ON e.person_id = p.id WHERE e.email = ?",
    )
      .bind(email.toLowerCase())
      .first()) as { id: string; created_by: string };
    expect(person.id).toBe(stored.person_id);
    // Created for an admin, as at a customer's first sign-in: never for the guest.
    expect(person.created_by).toBeTruthy();
    // The token is not kept, and not in the audit log.
    expect(stored.access_hash).not.toBe(order.token);
    const audit = (await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'order.start' ORDER BY at DESC LIMIT 5",
    ).all()) as { results: { input: string; result: string }[] };
    expect(JSON.stringify(audit.results)).not.toContain(order.token as string);

    // A second order with the same address is the same Person's.
    const again = await start(outside(PUBLIC), [{ id: general }], { email: email.toUpperCase() });
    expect((await orderRow(again.id)).person_id).toBe(person.id);
  });

  it("one person has the address: the order is theirs, and they see it when they sign in", async () => {
    const order = await start(outside(PUBLIC), [{ id: general }], { email: bob.email });
    expect((await orderRow(order.id)).person_id).toBe(bob.principal.personId);
    // Bob, signed in later with that address (verified by a code), has the order.
    expect(
      await run<OrderOut>("order.get", { id: order.id }, outside(bob.principal)),
    ).toMatchObject({ id: order.id, state: "pending" });
    expect((await refusal(run("order.get", { id: order.id }, outside(alice.principal)))).code).toBe(
      "not_found",
    );
  });

  it("several people have the address: the order is no one's yet, staff are told, it can be paid", async () => {
    const email = `${unique("shared")}@guests.example`;
    const first = await run<{ id: string }>(
      "person.create",
      { givenName: "First", emails: [{ email }] },
      context(admin),
    );
    // A second live person with the address cannot be created through the operations (emails are
    // unique), so put one there the way an old import could have left it.
    const second = await run<{ id: string }>(
      "person.create",
      { givenName: "Second", emails: [{ email: `${unique("other")}@guests.example` }] },
      context(admin),
    );
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(email, second.id)
      .run();
    const before = await adminNotices("order.several_people");
    const order = await start(outside(PUBLIC), [{ id: general }], { email });
    expect((await orderRow(order.id)).person_id).toBeNull();
    expect(await adminNotices("order.several_people")).toBe(before + 1);
    expect(await pay(order.id, 12_000)).toMatchObject({ outcome: "applied", state: "paid" });
    // Once staff have merged them, the order is given its person.
    expect(
      await run<OrderOut>("order.setPerson", { id: order.id, personId: first.id }, staff()),
    ).toMatchObject({ personId: first.id });
    expect(
      await refusal(run("order.setPerson", { id: order.id, personId: second.id }, staff())),
    ).toMatchObject({ code: "conflict" });
  });

  it("the token opens that order only, and stops a while after the order closes", async () => {
    const email = `${unique("guest")}@guests.example`;
    const order = await start(outside(PUBLIC), [{ id: general }], { email });
    const other = await start(outside(PUBLIC), [{ id: general, quantity: 2 }], { email });
    const token = order.token as string;
    const seen = await run<OrderOut>("order.view", { id: order.id, token }, outside(PUBLIC));
    expect(seen).toMatchObject({ id: order.id, total: 12_000, state: "pending" });
    expect(seen.lines).toHaveLength(1);
    expect(seen).not.toHaveProperty("email");
    expect(seen).not.toHaveProperty("personId");

    const notFound = async (input: Record<string, unknown>, ctx = outside(PUBLIC)) =>
      (await refusal(run("order.view", input, ctx))).code;
    // Another order with this token, this order with another's token, a made-up token.
    expect(await notFound({ id: other.id, token })).toBe("not_found");
    expect(await notFound({ id: order.id, token: other.token })).toBe("not_found");
    expect(await notFound({ id: order.id, token: "0".repeat(64) })).toBe("not_found");
    expect(await notFound({ id: order.id, token: "' OR 1=1 --" })).toBe("not_found");

    // Paid: it closes, and the link lasts 30 days more.
    await pay(order.id, 12_000);
    const at = (days: number) => () => new Date(Date.now() + days * 86_400_000);
    expect(
      await run<OrderOut>(
        "order.view",
        { id: order.id, token },
        outside(PUBLIC, { clock: at(29) }),
      ),
    ).toMatchObject({ state: "paid" });
    expect(await notFound({ id: order.id, token }, outside(PUBLIC, { clock: at(31) }))).toBe(
      "not_found",
    );
  });

  it("a part-paid guest order keeps its link for as long as it is open", async () => {
    const email = `${unique("guest")}@guests.example`;
    const order = await start(outside(PUBLIC), [{ id: camp }], { email, pay: "deposit" });
    await pay(order.id, 75_000);
    const farOff = () => new Date(Date.now() + 400 * 86_400_000);
    expect(
      await run<OrderOut>(
        "order.view",
        { id: order.id, token: order.token },
        outside(PUBLIC, { clock: farOff }),
      ),
    ).toMatchObject({ state: "part_paid", paid: 75_000, balance: 224_900 });
  });

  it("an erased person's address cannot start an order, with the words a bad address gets", async () => {
    const email = `${unique("erased")}@guests.example`;
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at, erased_by) VALUES (?, 'person', ?, ?)",
    )
      .bind(await erasedAddressHash(email), new Date().toISOString(), admin.id)
      .run();
    const erased = await refusal(start(outside(PUBLIC), [{ id: general }], { email }));
    const bad = await refusal(start(outside(PUBLIC), [{ id: general }], { email: "nope" }));
    expect(erased).toEqual(bad);
    const row = (await env.DB.prepare("SELECT count(*) AS n FROM core_order WHERE email = ?")
      .bind(email)
      .first()) as { n: number };
    expect(row.n).toBe(0);
  });
});

describe("the engine's hook when a record moves (ADR 0426)", () => {
  it("runs in the batch of the write that moves the record, and can refuse it", async () => {
    const seen: string[] = [];
    const remove = onRecordMove("order", (ctx, move) => {
      seen.push(`${move.from?.id ?? "new"}→${move.to.id} by ${move.by}`);
      if (move.to.id === "paid") {
        ctx.write(
          ctx.db.insertInto("core_settings").values({
            key: `hook_saw_${move.id}`,
            value: JSON.stringify(move.after.paid),
            updated_at: ctx.now,
            updated_by: null,
          }),
        );
      }
      if (move.to.id === "cancelled") throw new Error("the hook refuses this cancel");
    });
    try {
      const order = await start(outside(alice.principal), [{ id: general }]);
      await pay(order.id, 12_000);
      expect(seen).toEqual(["new→pending by host", "pending→paid by host"]);
      const row = (await env.DB.prepare("SELECT value FROM core_settings WHERE key = ?")
        .bind(`hook_saw_${order.id}`)
        .first()) as { value: string } | null;
      expect(row?.value).toBe("12000");

      const second = await start(outside(alice.principal), [{ id: general }]);
      await expect(run("order.cancel", { id: second.id }, staff())).rejects.toThrow();
      expect(await orderRow(second.id)).toMatchObject({ state: "pending" });
      expect((await historyOf(second.id)).map((h) => h.position_id)).toEqual(["pending"]);
    } finally {
      remove();
    }
  });
});

describe("erase (ADR 0426)", () => {
  it("a person's orders lose the person, the address and the guest's link, and keep their amounts", async () => {
    const email = `${unique("gone")}@guests.example`;
    const order = await start(outside(PUBLIC), [{ id: general }], { email });
    await pay(order.id, 12_000);
    const personId = (await orderRow(order.id)).person_id as string;
    await run("person.erase", { id: personId }, context(admin));
    const stored = await orderRow(order.id);
    expect(stored).toMatchObject({
      person_id: null,
      email: null,
      access_hash: null,
      total: 12_000,
      paid: 12_000,
      state: "paid",
    });
    expect((await historyOf(order.id)).map((h) => h.position_id)).toEqual(["pending", "paid"]);
    expect(
      (await refusal(run("order.view", { id: order.id, token: order.token }, outside(PUBLIC))))
        .code,
    ).toBe("not_found");
  });
});
