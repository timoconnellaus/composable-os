// Tax at checkout in the host (stage 42 section 4, ADR 0479), against the payments gatekeeper's
// test double: when the checkout asks the provider for tax (only with the human admin's setting
// on and a declared product tax code), what goes to the provider for each payment, and that what
// the provider says the tax was is stored as it said it, on the payment, the order and its lines,
// never worked out by the host. The real gatekeeper's fake provider is driven end to end in
// apps/runner/test/payments-tax.test.ts.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  memoryEventSink,
  type PaymentsEvent,
  splitInProportion,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { CURRENCY, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SHOP = extId("taxshop");
/** An online course: declares Stripe's on-demand course code. */
const COURSE = `${SHOP}.course`;
/** An in-person event's seat: admission code, taxed where its event is. */
const SEAT = `${SHOP}.seat`;
const EVENT = `${SHOP}.event`;
/** For sale and declaring no tax code (as the box office fixture's ticket type). */
const PLAIN = `${SHOP}.plain`;
const RETURN = "https://shop.example.com/thanks";
const COURSE_CODE = "txcd_20060158";
const ADMISSION = "txcd_50010001";
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

type SentLine = {
  ref: string;
  name: string;
  amount: number;
  taxCode: string;
  place?: Record<string, string>;
};
type Sent = {
  ref: string;
  orderId: string;
  amount: number;
  currency: string;
  tax?: { behavior: string; lines: SentLine[] };
};
interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  taxAmount: number;
  token?: string | null;
  lines: { id: string; total: number; taxAmount: number }[];
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let member: ActingUser;
let course: string;
let seat: string;
let plain: string;
let event: string;

const staff = (user: ActingUser = admin, extra: Record<string, unknown> = {}) =>
  context(user, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

async function setTax(values: { tax?: boolean; taxCodes?: Record<string, string> }) {
  await run("order.settings.update", values, context(admin));
}

async function buy(lines: { object: string; id: string; quantity?: number }[], pay = "full") {
  const order = await run<OrderOut>(
    "order.start",
    { lines, email: `${unique("guest")}@buyers.example`, pay },
    guest(),
  );
  return order;
}

async function checkout(order: OrderOut, amount?: number): Promise<Sent> {
  await run(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN, ...(amount ? { amount } : {}) },
    guest(),
  );
  return gw.checkouts.filter((c) => c.orderId === order.id).at(-1) as Sent;
}

/** Plays the provider: it verified a payment of `sent`, with the tax it says it calculated. */
function providerPays(sent: Sent, tax?: unknown) {
  return payments.deliver({
    kind: "payment",
    provider: "fake",
    eventId: `fevt_${unique("e")}`,
    orderId: sent.orderId,
    checkoutRef: sent.ref,
    amount: sent.amount,
    currency: CURRENCY,
    paymentRef: `fpi_${unique("p")}`,
    occurredAt: new Date().toISOString(),
    ...(tax ? { tax } : {}),
  } as PaymentsEvent);
}

/** A tax report giving each sent line `amounts[i]` of tax. */
function report(sent: Sent, amounts: number[], country: string | null = "AU") {
  const lines = (sent.tax?.lines ?? []).map((line, i) => ({
    ref: line.ref,
    amount: amounts[i] ?? 0,
  }));
  return { amount: lines.reduce((s, l) => s + l.amount, 0), country, lines };
}

const order = (id: string) => run<OrderOut>("order.get", { id }, staff());

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(SHOP, {
      objects: {
        course: {
          label: "Course",
          plural: "Courses",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price", tax: { code: COURSE_CODE } },
          public: { read: ["name", "price"] },
        },
        event: {
          label: "Event",
          plural: "Events",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            taxCountry: { type: "text", label: "Country" },
            taxRegion: { type: "text", label: "Region" },
            taxPostcode: { type: "text", label: "Postcode" },
          },
        },
        seat: {
          label: "Seat",
          plural: "Seats",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
            balanceDue: { type: "date", label: "Balance due" },
            event: { type: "relation", label: "Event", to: EVENT },
          },
          sellable: {
            price: "price",
            deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
            tax: {
              code: ADMISSION,
              place: {
                via: "event",
                country: "taxCountry",
                region: "taxRegion",
                postcode: "taxPostcode",
              },
            },
          },
          public: { read: ["name", "price", "depositAmount", "balanceDue"] },
        },
        plain: {
          label: "Plain",
          plural: "Plains",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"], minPartPayment: 1000 },
    context(admin),
  );
  course = await create(COURSE, { name: "Mobility course", price: 99 });
  plain = await create(PLAIN, { name: "Poster", price: 20 });
  event = await create(EVENT, {
    name: "Camp",
    taxCountry: "nz",
    taxRegion: "Otago",
    taxPostcode: "9300",
  });
  seat = await create(SEAT, {
    name: "Camp seat",
    price: 1000,
    depositAmount: 300,
    balanceDue: NEXT_YEAR,
    event,
  });
  await payments.connect(admin.id);
});

beforeEach(async () => {
  events = memoryEventSink();
  await setTax({ tax: false, taxCodes: {} });
});

describe("the setting (criterion 12)", () => {
  it("is off until a human admin turns it on, and only a human admin changes it or a code", async () => {
    const settings = await run<{
      tax: boolean;
      taxObjects: { object: string; declared: string; code: string; place: boolean }[];
    }>("order.settings.get", {}, staff());
    expect(settings.tax).toBe(false);
    expect(settings.taxObjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: COURSE, declared: COURSE_CODE, code: COURSE_CODE }),
        expect.objectContaining({ object: SEAT, declared: ADMISSION, place: true }),
      ]),
    );
    expect(settings.taxObjects.some((o) => o.object === PLAIN)).toBe(false);
    for (const input of [{ tax: true }, { taxCodes: { [COURSE]: "txcd_20060258" } }]) {
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
        const answer = await refusal(run("order.settings.update", input, ctx));
        expect(["forbidden", "denied"]).toContain(answer.code);
      }
    }
    expect((await run<{ tax: boolean }>("order.settings.get", {}, staff())).tax).toBe(false);
    // A code only for an object that declares one, and only in Stripe's shape.
    expect(
      await refusal(
        run("order.settings.update", { taxCodes: { [PLAIN]: ADMISSION } }, context(admin)),
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await refusal(
        run("order.settings.update", { taxCodes: { [COURSE]: "GST" } }, context(admin)),
      ),
    ).toMatchObject({ code: "invalid_input" });
    // The change is audited, as every order setting is.
    await setTax({ tax: true });
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_audit_changes WHERE object_type = 'settings' AND record_id = 'order_tax'",
    ).first<{ n: number }>();
    expect(audit?.n).toBeGreaterThan(0);
  });
});

describe("tax off, or no tax code (criterion 12)", () => {
  it("sends the checkout exactly as before", async () => {
    for (const [on, object, id] of [
      [false, COURSE, course],
      [true, PLAIN, plain],
    ] as const) {
      await setTax({ tax: on });
      const placed = await buy([{ object, id }]);
      const sent = await checkout(placed);
      expect(Object.keys(sent).sort()).toEqual([
        "amount",
        "currency",
        "customerEmail",
        "description",
        "idempotencyKey",
        "orderId",
        "ref",
        "returnUrl",
      ]);
      expect((await providerPays(sent)).result.outcome).toBe("applied");
      const paid = await order(placed.id);
      expect(paid).toMatchObject({ state: "paid", taxAmount: 0, taxCountry: null });
      // A provider that reports tax on a checkout that asked for none is not believed.
      const again = await buy([{ object, id }]);
      const second = await checkout(again);
      expect(
        (await providerPays(second, { amount: 5, country: "AU", lines: [] })).result.outcome,
      ).toBe("mismatch");
    }
  });
});

describe("tax on, for a course (criterion 11)", () => {
  it("asks for automatic tax, inclusive, at the line's code; stores the provider's figure", async () => {
    await setTax({ tax: true });
    const placed = await buy([{ object: COURSE, id: course }]);
    expect(placed.total).toBe(9900);
    const sent = await checkout(placed);
    expect(sent.amount).toBe(9900);
    expect(sent.tax).toEqual({
      behavior: "inclusive",
      lines: [
        { ref: placed.lines[0]?.id, name: "Mobility course", amount: 9900, taxCode: COURSE_CODE },
      ],
    });
    // A figure no calculation here would give: it is the provider's, stored as it said it.
    const { result } = await providerPays(sent, report(sent, [901]));
    expect(result.outcome).toBe("applied");
    const paid = await order(placed.id);
    expect(paid).toMatchObject({
      state: "paid",
      total: 9900,
      paid: 9900,
      taxAmount: 901,
      taxCountry: "AU",
    });
    expect(paid.lines[0]).toMatchObject({ total: 9900, taxAmount: 901 });
    const payment = await env.DB.prepare(
      "SELECT amount, tax_amount, tax_country FROM core_order_payment WHERE order_id = ?",
    )
      .bind(placed.id)
      .first();
    expect(payment).toEqual({ amount: 9900, tax_amount: 901, tax_country: "AU" });
    const view = await env.DB.prepare("SELECT tax_amount, net FROM rec_order WHERE id = ?")
      .bind(placed.id)
      .first();
    expect(view).toEqual({ tax_amount: 901, net: 9900 - 901 });
    const line = await env.DB.prepare(
      "SELECT tax_amount, tax_code FROM rec_order_line WHERE order_id = ?",
    )
      .bind(placed.id)
      .first();
    expect(line).toEqual({ tax_amount: 901, tax_code: COURSE_CODE });
  });

  it("sends an admin's code over the pack's", async () => {
    await setTax({ tax: true, taxCodes: { [COURSE]: "txcd_20060258" } });
    const sent = await checkout(await buy([{ object: COURSE, id: course }]));
    expect(sent.tax?.lines[0]?.taxCode).toBe("txcd_20060258");
  });

  it("moves nothing when the provider's tax does not fit what was asked", async () => {
    await setTax({ tax: true });
    for (const tax of [
      undefined, // a taxed checkout reported without tax
      (sent: Sent) => ({ ...report(sent, [100]), amount: 99 }), // lines that do not sum
      (sent: Sent) => report(sent, [9901]), // more tax than the line
      (_sent: Sent) => ({ amount: 10, country: "AU", lines: [{ ref: "orl_other", amount: 10 }] }),
    ]) {
      const placed = await buy([{ object: COURSE, id: course }]);
      const sent = await checkout(placed);
      const { result } = await providerPays(sent, tax?.(sent));
      expect(result.outcome).toBe("mismatch");
      expect(await order(placed.id)).toMatchObject({ state: "pending", paid: 0, taxAmount: 0 });
    }
  });

  it("still moves nothing when the amount paid is not the order's, whatever the tax", async () => {
    await setTax({ tax: true });
    const placed = await buy([{ object: COURSE, id: course }]);
    const sent = await checkout(placed);
    const { result } = await providerPays({ ...sent, amount: sent.amount - 1 }, report(sent, [900]));
    expect(result.outcome).toBe("mismatch");
    expect(await order(placed.id)).toMatchObject({ state: "pending", paid: 0, taxAmount: 0 });
  });

  it("refuses an order mixing lines with a code and lines without one", async () => {
    await setTax({ tax: true });
    const placed = await buy([
      { object: COURSE, id: course },
      { object: PLAIN, id: plain },
    ]);
    const answer = await refusal(
      run("order.checkout", { id: placed.id, token: placed.token, returnUrl: RETURN }, guest()),
    );
    expect(answer).toMatchObject({ code: "invalid_input", details: { rule: "tax_mixed" } });
  });
});

describe("tax on, for an event's seats (criterion 12a, host side)", () => {
  it("sends each line's code and the event's place, and stores the tax per line", async () => {
    await setTax({ tax: true });
    const other = await create(SEAT, { name: "Day seat", price: 250, event });
    const placed = await buy([
      { object: SEAT, id: seat, quantity: 2 },
      { object: SEAT, id: other },
    ]);
    const sent = await checkout(placed);
    const place = { country: "NZ", region: "Otago", postcode: "9300" };
    expect(sent.tax?.lines).toEqual([
      {
        ref: placed.lines[0]?.id,
        name: "2 x Camp seat",
        amount: 200000,
        taxCode: ADMISSION,
        place,
      },
      { ref: placed.lines[1]?.id, name: "Day seat", amount: 25000, taxCode: ADMISSION, place },
    ]);
    await providerPays(sent, report(sent, [26087, 3261], "NZ"));
    const paid = await order(placed.id);
    expect(paid).toMatchObject({
      state: "paid",
      total: 225000,
      taxAmount: 29348,
      taxCountry: "NZ",
    });
    expect(paid.lines.map((l) => l.taxAmount)).toEqual([26087, 3261]);
  });

  it("refuses to sell a seat whose event has no country for tax", async () => {
    await setTax({ tax: true });
    const nowhere = await create(EVENT, { name: "Somewhere" });
    const lost = await create(SEAT, { name: "Lost seat", price: 10, event: nowhere });
    const placed = await buy([{ object: SEAT, id: lost }]);
    const answer = await refusal(
      run("order.checkout", { id: placed.id, token: placed.token, returnUrl: RETURN }, guest()),
    );
    expect(answer).toMatchObject({ code: "invalid_input", details: { rule: "tax_place" } });
  });
});

describe("deposits and refunds (criteria 12b and 12c, host side)", () => {
  it("taxes each payment on its own amount, and records a refund's tax only as the provider said", async () => {
    await setTax({ tax: true });
    const placed = await buy([{ object: SEAT, id: seat }], "deposit");
    const deposit = await checkout(placed);
    expect(deposit.amount).toBe(30000);
    expect(deposit.tax?.lines[0]).toMatchObject({ amount: 30000, name: "Deposit: Camp seat" });
    const first = await providerPays(deposit, report(deposit, [3913], "NZ"));
    const part = await checkout(placed, 40000);
    expect(part.tax?.lines[0]).toMatchObject({
      amount: 40000,
      name: "Towards the balance: Camp seat",
    });
    await providerPays(part, report(part, [5217], "NZ"));
    const rest = await checkout(placed);
    expect(rest.amount).toBe(30000);
    await providerPays(rest, report(rest, [3913], "NZ"));
    const paid = await order(placed.id);
    expect(paid).toMatchObject({
      state: "paid",
      total: 100000,
      paid: 100000,
      taxAmount: 3913 + 5217 + 3913,
    });

    // A refund of the deposit's payment: the provider's figure when it gives one, up to that
    // payment's own tax; none when it gives none (Stripe's Refund carries no tax).
    const asked = await run<{ refunds: { pendingActionId: string; paymentRef: string }[] }>(
      "order.refund",
      { id: placed.id, reason: "Moved", amount: 1000 },
      staff(),
    );
    const action = asked.refunds[0]?.pendingActionId as string;
    await run("approval.approve", { actionIds: [action] }, staff());
    const request = [...gw.refunds.values()].at(-1) as { refundId: string; paymentRef: string };
    expect(request.paymentRef).not.toBe(first.event.paymentRef);
    const refunded = (tax?: number, amount = 500) =>
      payments.deliver({
        kind: "refund",
        provider: "fake",
        eventId: `fevt_${unique("r")}`,
        orderId: placed.id,
        refundId: null,
        refundRef: `fre_${unique("f")}`,
        paymentRef: request.paymentRef,
        amount,
        currency: CURRENCY,
        occurredAt: new Date().toISOString(),
        ...(tax !== undefined ? { tax: { amount: tax } } : {}),
      } as PaymentsEvent);
    await refunded(65);
    await refunded(undefined);
    // More than this payment's tax still held (3913 - 65), though less than the order's: not believed.
    await refunded(3900, 5000);
    const rows = await env.DB.prepare(
      "SELECT amount, tax_amount FROM core_order_refund WHERE order_id = ? AND status = 'confirmed' ORDER BY confirmed_at, rowid",
    )
      .bind(placed.id)
      .all();
    expect(rows.results).toEqual([
      { amount: 500, tax_amount: 65 },
      { amount: 500, tax_amount: null },
      { amount: 5000, tax_amount: null },
    ]);
    const after = await env.DB.prepare("SELECT tax_refunded, refunded FROM core_order WHERE id = ?")
      .bind(placed.id)
      .first();
    expect(after).toEqual({ tax_refunded: 65, refunded: 6000 });
  });

  it("does not believe a refund's tax larger than its payment's", async () => {
    await setTax({ tax: true });
    const placed = await buy([{ object: COURSE, id: course }]);
    const sent = await checkout(placed);
    const paid = await providerPays(sent, report(sent, [900]));
    await payments.deliver({
      kind: "refund",
      provider: "fake",
      eventId: `fevt_${unique("r")}`,
      orderId: placed.id,
      refundId: null,
      refundRef: `fre_${unique("f")}`,
      paymentRef: (paid.event as { paymentRef: string }).paymentRef,
      amount: 9900,
      currency: CURRENCY,
      occurredAt: new Date().toISOString(),
      tax: { amount: 901 },
    } as PaymentsEvent);
    const row = await env.DB.prepare("SELECT state, tax_refunded FROM core_order WHERE id = ?")
      .bind(placed.id)
      .first();
    expect(row).toEqual({ state: "refunded", tax_refunded: 0 });
  });
});

describe("splitting a payment over lines", () => {
  it("is in proportion, in whole units, and sums to the payment", () => {
    expect(splitInProportion(1000, [2000, 250])).toEqual([889, 111]);
    expect(splitInProportion(1, [1, 1])).toEqual([1, 0]);
    expect(splitInProportion(30000, [100000])).toEqual([30000]);
    const shares = splitInProportion(12345, [333, 333, 334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(12345);
  });
});
