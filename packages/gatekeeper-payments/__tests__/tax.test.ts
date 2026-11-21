// Tax at checkout in the payments gatekeeper (stage 42 section 4, ADR 0479): the taxed checkout's
// input, what Stripe is sent (automatic tax, inclusive, each line's code, the billing address, an
// event's place as a reused tax location), what Stripe's paid session becomes (its tax and each
// line's), and the fake provider's arithmetic. Stripe is never called: fetch is injected.
import { describe, expect, it } from "vitest";
import { FAKE_TAX_REGISTRATIONS, fakeTaxReport, inclusiveTax, taxReportOf } from "../src/fake.js";
import {
  mapStripeEvent,
  STRIPE_TAX_VERSION,
  StripeProvider,
  withStripeTaxLines,
} from "../src/stripe.js";
import type { PaymentsCheckoutTax, PaymentsEvent } from "../src/types.js";
import { parseCheckoutInput } from "../src/validate.js";

const base = {
  orderId: "ord_1",
  amount: 21000,
  currency: "AUD",
  description: "2 x General, VIP",
  returnUrl: "https://shop.example.com/back",
  idempotencyKey: "k",
};
const place = { country: "NZ", region: "Otago", postcode: "9300" };
const tax: PaymentsCheckoutTax = {
  behavior: "inclusive",
  lines: [
    { ref: "orl_a", name: "2 x General", amount: 9000, taxCode: "txcd_50010001", place },
    { ref: "orl_b", name: "VIP", amount: 12000, taxCode: "txcd_50010001", place },
  ],
};

type Recorded = { url: string; headers: Headers; form: URLSearchParams };
function stripe(answer: (r: Recorded) => unknown, cache = new Map<string, string>()) {
  const requests: Recorded[] = [];
  const provider = new StripeProvider({
    secretKey: "sk_test_key",
    webhookSecret: "whsec_x",
    apiBase: "https://stripe.test",
    account: "",
    taxLocations: {
      get: (k) => cache.get(k),
      put: (k, v) => {
        cache.set(k, v);
      },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = {
        url: String(input),
        headers: new Headers(init?.headers),
        form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      };
      requests.push(r);
      return new Response(JSON.stringify(answer(r)));
    }) as typeof fetch,
  });
  return { provider, requests };
}

describe("the taxed checkout's input", () => {
  it("is left exactly as before when no tax is asked for", () => {
    expect(parseCheckoutInput(base)).toEqual(base);
    expect("tax" in parseCheckoutInput(base)).toBe(false);
  });

  it("takes inclusive lines that sum to the amount, with Stripe-shaped codes and places", () => {
    expect(parseCheckoutInput({ ...base, tax }).tax).toEqual(tax);
    const [a, b] = tax.lines;
    const refused = [
      { ...tax, behavior: "exclusive" },
      { ...tax, lines: [{ ...a, amount: 9001 }, b] },
      { ...tax, lines: [{ ...a, taxCode: "GST" }, b] },
      { ...tax, lines: [a, { ...b, ref: "orl_a" }] },
      { ...tax, lines: [{ ...a, place: { country: "nz" } }, b] },
      { ...tax, lines: [{ ...a, price: 1 }, b] },
      { ...tax, lines: [] },
    ];
    for (const bad of refused) {
      expect(() => parseCheckoutInput({ ...base, tax: bad })).toThrow(TypeError);
    }
  });
});

describe("Stripe with tax", () => {
  it("asks for automatic tax, inclusive, each line's code, the billing address and the event's place", async () => {
    const { provider, requests } = stripe((r) =>
      r.url.endsWith("/v1/tax/locations")
        ? { id: "taxloc_1" }
        : { id: "cs_1", url: "https://checkout.stripe.test/c/1" },
    );
    await provider.createCheckout(parseCheckoutInput({ ...base, tax }));
    // One tax location for the one venue, made once (Stripe asks for reuse), then the session.
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/tax/locations",
      "https://stripe.test/v1/checkout/sessions",
    ]);
    const [location, session] = requests;
    expect(Object.fromEntries(location?.form ?? [])).toEqual({
      type: "performance",
      "address[country]": "NZ",
      "address[state]": "Otago",
      "address[postal_code]": "9300",
    });
    expect(location?.headers.get("stripe-version")).toBe(STRIPE_TAX_VERSION);
    expect(session?.headers.get("stripe-version")).toBe(STRIPE_TAX_VERSION);
    const form = Object.fromEntries(session?.form ?? []);
    expect(form).toMatchObject({
      mode: "payment",
      "automatic_tax[enabled]": "true",
      billing_address_collection: "required",
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][unit_amount]": "9000",
      "line_items[0][price_data][tax_behavior]": "inclusive",
      "line_items[0][price_data][product_data][name]": "2 x General",
      "line_items[0][price_data][product_data][tax_details][tax_code]": "txcd_50010001",
      "line_items[0][price_data][product_data][tax_details][performance_location]": "taxloc_1",
      "line_items[0][price_data][product_data][metadata][cos_line]": "orl_a",
      "line_items[0][quantity]": "1",
      "line_items[1][price_data][unit_amount]": "12000",
      "line_items[1][price_data][product_data][tax_details][performance_location]": "taxloc_1",
      "line_items[1][price_data][product_data][metadata][cos_line]": "orl_b",
    });
    // The flat tax_code cannot take an event code (docs.stripe.com/tax/tax-codes): not sent.
    expect(Object.keys(form).some((k) => k.endsWith("[product_data][tax_code]"))).toBe(false);
    // A second checkout for the same venue reuses the location.
    await provider.createCheckout(parseCheckoutInput({ ...base, idempotencyKey: "k2", tax }));
    expect(requests.filter((r) => r.url.endsWith("/v1/tax/locations"))).toHaveLength(1);
  });

  it("sends no tax setting and no version without tax", async () => {
    const { provider, requests } = stripe(() => ({ id: "cs_1", url: "https://x.test" }));
    await provider.createCheckout(parseCheckoutInput(base));
    const keys = [...(requests[0]?.form.keys() ?? [])];
    expect(keys.some((k) => /tax|billing_address/.test(k))).toBe(false);
    expect(requests[0]?.headers.get("stripe-version")).toBeNull();
  });

  const paidSession = (extra: Record<string, unknown>) => ({
    id: "evt_1",
    type: "checkout.session.completed",
    created: 1_900_000_000,
    data: {
      object: {
        id: "cs_1",
        payment_status: "paid",
        client_reference_id: "ord_1",
        amount_total: 21000,
        currency: "aud",
        payment_intent: "pi_1",
        ...extra,
      },
    },
  });

  it("reads Stripe's tax from a taxed session, and each line's from its line items", async () => {
    const event = mapStripeEvent(
      paidSession({
        automatic_tax: { enabled: true, status: "complete" },
        total_details: { amount_tax: 2739 },
        customer_details: { address: { country: "AU" } },
      }),
      "evt_1",
    ) as PaymentsEvent;
    expect(event).toMatchObject({
      kind: "payment",
      tax: { amount: 2739, country: "AU", lines: [] },
    });
    const { provider, requests } = stripe(() => ({
      data: [
        { amount_tax: 1174, price: { product: { metadata: { cos_line: "orl_a" } } } },
        { amount_tax: 1565, price: { product: { metadata: { cos_line: "orl_b" } } } },
      ],
    }));
    const full = await withStripeTaxLines(event, (ref) => provider.taxLines(ref));
    expect(full).toMatchObject({
      tax: {
        amount: 2739,
        lines: [
          { ref: "orl_a", amount: 1174 },
          { ref: "orl_b", amount: 1565 },
        ],
      },
    });
    expect(requests[0]?.url).toBe(
      "https://stripe.test/v1/checkout/sessions/cs_1/line_items?limit=100&expand[]=data.price.product",
    );
    // Untaxed: no tax key at all, as before.
    expect(mapStripeEvent(paidSession({}), "evt_1")).not.toHaveProperty("tax");
    // Taxed but without its amount: not taken, so the delivery fails and Stripe sends it again.
    expect(() =>
      mapStripeEvent(paidSession({ automatic_tax: { enabled: true } }), "evt_1"),
    ).toThrow();
  });
});

describe("the fake provider's tax", () => {
  it("is inside the price, at the registered rate of the line's place, else the buyer's", () => {
    expect(inclusiveTax(9900, 1000)).toBe(900);
    expect(inclusiveTax(9000, 1500)).toBe(1174);
    expect(FAKE_TAX_REGISTRATIONS.US).toBeUndefined();
    const course: PaymentsCheckoutTax = {
      behavior: "inclusive",
      lines: [{ ref: "orl_c", name: "Course", amount: 12000, taxCode: "txcd_20060158" }],
    };
    expect(fakeTaxReport(course, "AU")).toEqual({
      amount: 1091,
      country: "AU",
      lines: [{ ref: "orl_c", amount: 1091 }],
    });
    expect(fakeTaxReport(course, "US").amount).toBe(0);
    // An event's lines are taxed where it is, whoever pays.
    expect(fakeTaxReport(tax, "US")).toEqual({
      amount: 2739,
      country: "NZ",
      lines: [
        { ref: "orl_a", amount: 1174 },
        { ref: "orl_b", amount: 1565 },
      ],
    });
    expect(taxReportOf({ amount: 1, country: "nz", lines: [] })).toBeNull();
    expect(taxReportOf({ amount: 1, country: null, lines: [{ ref: "orl_a", amount: 1 }] })).toEqual(
      { amount: 1, country: null, lines: [{ ref: "orl_a", amount: 1 }] },
    );
  });
});
