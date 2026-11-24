// Stage 52 step 3 (ADR 0796) through the order code itself, against the payments gatekeeper's test
// double: an order of two lines at two tax codes is started, checked out with tax and paid by a
// payment the provider verified with its own tax figures (orders/payments.ts stores them on the
// payment and the lines); the month's Sales and Tax then carry exactly those figures, each line's
// share of the payment and of its tax. The hand-worked month is in
// finance-day-summaries.test.ts.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { localMonthAt } from "../src/finance/day.ts";
import { type ActingUser, memoryEventSink, type PaymentsEvent } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { CURRENCY, outside, PUBLIC, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SHOP = extId("finshop");
const COURSE = `${SHOP}.course`;
const KIT = `${SHOP}.kit`;
const COURSE_CODE = "txcd_20060158";
const KIT_CODE = "txcd_99999999";
const ZONE = "Australia/Sydney";

type Sent = {
  ref: string;
  orderId: string;
  amount: number;
  tax?: { lines: { ref: string; amount: number }[] };
};

let events = memoryEventSink();
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let course: string;
let kit: string;

beforeAll(async () => {
  admin = await createUser("admin");
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE))
    .run();
  const sellable = (code: string, category: { key: string; label: string }) => ({
    titleField: "name",
    fields: {
      name: { type: "text" as const, label: "Name", required: true },
      price: { type: "currency" as const, label: "Price", currency: CURRENCY },
    },
    sellable: { price: "price", tax: { code }, finance: { category } },
    public: { read: ["name", "price"] },
  });
  await reconcile(
    manifest(SHOP, {
      objects: {
        course: {
          label: "Course",
          plural: "Courses",
          ...sellable(COURSE_CODE, { key: "courses", label: "Courses" }),
        },
        kit: {
          label: "Kit",
          plural: "Kits",
          ...sellable(KIT_CODE, { key: "goods", label: "Goods" }),
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"], tax: true },
    context(admin),
  );
  course = (
    (await run(
      "record.create",
      { object: COURSE, values: { name: "Mobility", price: 90 } },
      context(admin),
    )) as {
      id: string;
    }
  ).id;
  kit = (
    (await run(
      "record.create",
      { object: KIT, values: { name: "Band set", price: 30 } },
      context(admin),
    )) as {
      id: string;
    }
  ).id;
  await payments.connect(admin.id);
});

describe("a payment the provider verified, in the month's reports", () => {
  it("each line's share of the money and of the provider's tax lands on its category and code", async () => {
    events = memoryEventSink();
    const guest = () => outside(PUBLIC, { integrations: runtime, events });
    const placed = await run<{ id: string; token: string }>(
      "order.start",
      {
        lines: [
          { object: COURSE, id: course },
          { object: KIT, id: kit },
        ],
        email: `${unique("guest")}@buyers.example`,
        pay: "full",
      },
      guest(),
    );
    await run(
      "order.checkout",
      { id: placed.id, token: placed.token, returnUrl: "https://shop.example.com/thanks" },
      guest(),
    );
    const sent = gw.checkouts.filter((c) => c.orderId === placed.id).at(-1) as Sent;
    expect(sent.amount).toBe(12000);
    const taxLines = (sent.tax?.lines ?? []).map((l, i) => ({
      ref: l.ref,
      amount: i === 0 ? 818 : 273,
    }));
    const delivered = await payments.deliver({
      kind: "payment",
      provider: "fake",
      eventId: `fevt_${unique("e")}`,
      orderId: placed.id,
      checkoutRef: sent.ref,
      amount: sent.amount,
      currency: CURRENCY,
      paymentRef: `fpi_${unique("p")}`,
      occurredAt: new Date().toISOString(),
      tax: { amount: 1091, country: "AU", lines: taxLines },
    } as PaymentsEvent);
    expect(delivered.result.outcome).toBe("applied");

    const month = localMonthAt(Math.floor(Date.now() / 1000), ZONE);
    const sales = (await run("finance.report", { report: "sales", month }, context(admin))) as {
      rows: Record<string, unknown>[];
    };
    const item = (title: string) =>
      sales.rows.find((r) => r.type === "item" && r.title === title) as Record<string, unknown>;
    expect(item("Mobility")).toMatchObject({
      category: "courses",
      sold: 9000,
      tax: 818,
      netOfTax: 8182,
    });
    expect(item("Band set")).toMatchObject({
      category: "goods",
      sold: 3000,
      tax: 273,
      netOfTax: 2727,
    });
    const tax = (await run("finance.report", { report: "tax", month }, context(admin))) as {
      rows: Record<string, unknown>[];
    };
    expect(tax.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxCode: COURSE_CODE,
          taxCountry: "AU",
          sold: 9000,
          taxOnSales: 818,
        }),
        expect.objectContaining({
          taxCode: KIT_CODE,
          taxCountry: "AU",
          sold: 3000,
          taxOnSales: 273,
        }),
      ]),
    );
  });
});
