// Payout reads (stage 52 step 4, ADR 0793): the host's own read of what the provider sent to the
// bank and what each payout settled, through the real facet. The fake provider pays out each
// payment and refund once, with its fee; a payout of lines that do not sum to it, a dispute, an
// adjustment and a charge the host never saw are a test's to make. Stripe's payouts and balance
// transactions are mapped without the bank account, and a key that may not read them answers
// `unavailable` instead of failing.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fakeLedger } from "../src/fake.js";
import { StripeProvider, stripePayoutLineRead, stripePayoutRead } from "../src/stripe.js";
import type { PaymentsPayoutLinePage, PaymentsPayoutPage } from "../src/types.js";

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
}

async function host(asHost = true) {
  const stub = env.TEST_HOST.getByName(unique("host"));
  await stub.open("fake", asHost);
  return stub;
}

/** A paid checkout in the fake ledger, as the hosted page leaves it. */
async function paid(amount: number, currency = "AUD") {
  const ledger = fakeLedger(env);
  const checkout = await ledger.createCheckout({
    orderId: unique("ord"),
    amount,
    currency,
    description: "A class",
    returnUrl: "https://crm.example.com/back",
    idempotencyKey: unique("idem"),
  });
  const result = await ledger.pay(checkout.ref, null);
  if (!result.found || result.needsAddress) throw new Error("not paid");
  return result.checkout.paymentRef as string;
}

describe("the fake provider's payouts", () => {
  it("pays out each payment and refund once, with its fee, and lists them a page at a time", async () => {
    const ledger = fakeLedger(env);
    await ledger.configurePayoutReads({ auto: false, pageSize: 2, reads: "ok" });
    const a = await paid(10_000);
    const b = await paid(2_000);
    const refunded = await ledger.refund({
      orderId: "ord_r",
      paymentRef: b,
      amount: 500,
      currency: "AUD",
      reason: "x",
      refundId: unique("rfd"),
    });
    if (!refunded.ok) throw new Error(refunded.reason);
    const payout = await ledger.makePayout({
      currency: "AUD",
      arrivalDate: "2026-04-15",
      extra: [{ kind: "payment", amount: 400, fee: 37, paymentRef: "fpi_made_at_the_provider" }],
    });
    if (!payout) throw new Error("no payout");
    expect(payout.lines.map((l) => [l.kind, l.amount, l.fee, l.paymentRef])).toEqual([
      ["payment", 10_000, 205, a],
      ["payment", 2_000, 65, b],
      ["refund", -500, 0, b],
      ["payment", 400, 37, "fpi_made_at_the_provider"],
    ]);
    expect(payout.amount).toBe(10_000 - 205 + 2_000 - 65 - 500 + 400 - 37);
    // Paid out once: the next payout settles none of them again.
    expect(await ledger.makePayout({ currency: "AUD" })).toBeNull();

    const h = await host();
    const first = (await h.call("listPayouts", [{ since: "2026-04-01" }])) as PaymentsPayoutPage;
    if (first.unavailable) throw new Error("unavailable");
    expect(first.payouts.map((p) => p.ref)).toContain(payout.ref);
    const lines: Exclude<PaymentsPayoutLinePage, { unavailable: true }>[] = [];
    let after: string | null = null;
    do {
      const page = (await h.call("payoutLines", [
        { payoutRef: payout.ref, after },
      ])) as PaymentsPayoutLinePage;
      if (page.unavailable) throw new Error("unavailable");
      lines.push(page);
      after = page.next;
    } while (after);
    expect(lines.map((p) => p.lines.length)).toEqual([2, 2]);
    // Nothing a payout carries says where the bank account is.
    expect(JSON.stringify([first, lines])).not.toMatch(/destination|bank_account|account_number/);
    const { observations } = await h.recorded();
    expect(observations.some((o) => o.title === "Read payouts")).toBe(true);
  });

  it("is the host's own read only", async () => {
    const h = await host(false);
    await expect(h.call("listPayouts", [{ since: "2026-04-01" }])).rejects.toThrow(
      /only by the host/,
    );
    await expect(h.call("payoutLines", [{ payoutRef: "fpo_x" }])).rejects.toThrow(
      /only by the host/,
    );
  });

  it("answers a refusal as unavailable, and fails as a provider fails", async () => {
    const ledger = fakeLedger(env);
    const h = await host();
    await ledger.configurePayoutReads({ reads: "unavailable" });
    expect(await h.call("listPayouts", [{ since: "2026-04-01" }])).toMatchObject({
      unavailable: true,
    });
    await ledger.configurePayoutReads({ reads: "error" });
    await expect(h.call("listPayouts", [{ since: "2026-04-01" }])).rejects.toThrow();
    await ledger.configurePayoutReads({ reads: "ok" });
  });

  it("refuses inputs that are not a day or a reference", async () => {
    const h = await host();
    await expect(h.call("listPayouts", [{ since: "April" }])).rejects.toThrow(/since/);
    await expect(h.call("payoutLines", [{ payoutRef: "fpo x" }])).rejects.toThrow(/payoutRef/);
    await expect(h.call("listPayouts", [{ since: "2026-04-01", more: 1 }])).rejects.toThrow();
  });
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stripe(answer: (url: string) => Response) {
  const urls: string[] = [];
  const provider = new StripeProvider({
    secretKey: "sk_test_key",
    webhookSecret: "whsec_x",
    apiBase: "https://stripe.test",
    account: "",
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return answer(String(input));
    }) as typeof fetch,
  });
  return { provider, urls };
}

describe("Stripe's payouts", () => {
  it("maps a payout without its bank account, and only an automatic one as itemised", () => {
    const payout = stripePayoutRead({
      id: "po_1",
      amount: 16553,
      currency: "nzd",
      arrival_date: Date.UTC(2026, 3, 15) / 1000,
      created: Date.UTC(2026, 3, 13) / 1000,
      status: "paid",
      automatic: true,
      destination: "ba_secret",
    });
    expect(payout).toEqual({
      provider: "stripe",
      ref: "po_1",
      amount: 16553,
      currency: "NZD",
      arrivalDate: "2026-04-15",
      status: "paid",
      createdAt: "2026-04-13T00:00:00.000Z",
      itemised: true,
    });
    expect(
      stripePayoutRead({
        id: "po_2",
        amount: 1,
        currency: "nzd",
        arrival_date: 1,
        created: 1,
        status: "paid",
        automatic: false,
      })?.itemised,
    ).toBe(false);
    expect(stripePayoutRead({ id: "po_3" })).toBeNull();
  });

  it("maps balance transactions by reporting category, the payment intent from the source", () => {
    const base = { currency: "nzd", created: 1_776_000_000 };
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_1",
        amount: 11000,
        fee: 223,
        reporting_category: "charge",
        source: { id: "ch_1", payment_intent: "pi_1", billing_details: { email: "a@b.test" } },
      }),
    ).toEqual({
      ref: "txn_1",
      kind: "payment",
      amount: 11000,
      fee: 223,
      currency: "NZD",
      paymentRef: "pi_1",
      refundRef: null,
      occurredAt: new Date(1_776_000_000_000).toISOString(),
    });
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_2",
        amount: -2000,
        fee: 0,
        reporting_category: "refund",
        source: { id: "re_1", payment_intent: "pi_1" },
      }),
    ).toMatchObject({ kind: "refund", paymentRef: "pi_1", refundRef: "re_1" });
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_3",
        amount: -1000,
        fee: 1500,
        reporting_category: "dispute",
        source: { id: "dp_1", payment_intent: "pi_1" },
      }),
    ).toMatchObject({ kind: "dispute", paymentRef: "pi_1", refundRef: null });
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_4",
        amount: -500,
        fee: 0,
        reporting_category: "fee",
      }),
    ).toMatchObject({ kind: "fee" });
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_5",
        amount: 50,
        fee: 0,
        reporting_category: "payout_reversal",
      }),
    ).toMatchObject({ kind: "adjustment", paymentRef: null });
    // The payout's own balance transaction is not one of its lines.
    expect(
      stripePayoutLineRead({
        ...base,
        id: "txn_6",
        amount: -16553,
        fee: 0,
        reporting_category: "payout",
      }),
    ).toBeNull();
    // Nothing of a charge's billing details is passed on.
    expect(
      JSON.stringify(
        stripePayoutLineRead({
          ...base,
          id: "txn_7",
          amount: 1,
          fee: 0,
          reporting_category: "charge",
          source: { id: "ch_2", payment_intent: "pi_2", billing_details: { email: "a@b.test" } },
        }),
      ),
    ).not.toContain("a@b.test");
  });

  it("lists payouts and lines a page at a time, expanding only the source", async () => {
    const { provider, urls } = stripe((url) =>
      url.includes("/v1/payouts")
        ? ok({
            data: [
              {
                id: "po_1",
                amount: 1,
                currency: "aud",
                arrival_date: 1,
                created: 1,
                status: "paid",
                automatic: true,
              },
            ],
            has_more: true,
          })
        : ok({ data: [], has_more: false }),
    );
    const page = await provider.listPayouts({ since: "2026-04-01", after: "po_0" });
    expect(page).toMatchObject({ next: "po_1" });
    const lines = await provider.payoutLines({ payoutRef: "po_1", after: null });
    expect(lines).toEqual({ lines: [], next: null });
    const [list, txns] = urls.map((u) => new URL(u));
    expect(list?.pathname).toBe("/v1/payouts");
    expect(list?.searchParams.get("arrival_date[gte]")).toBe(String(Date.UTC(2026, 3, 1) / 1000));
    expect(list?.searchParams.get("starting_after")).toBe("po_0");
    expect(txns?.pathname).toBe("/v1/balance_transactions");
    expect(txns?.searchParams.get("payout")).toBe("po_1");
    expect(txns?.searchParams.getAll("expand[]")).toEqual(["data.source"]);
    expect(urls.join(" ")).not.toMatch(/destination/);
  });

  it("answers a key that may not read payouts as unavailable; anything else throws", async () => {
    const refused = stripe(
      () =>
        new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 403 }),
    );
    expect(await refused.provider.listPayouts({ since: "2026-04-01" })).toMatchObject({
      unavailable: true,
    });
    expect(await refused.provider.payoutLines({ payoutRef: "po_1" })).toMatchObject({
      unavailable: true,
    });
    const down = stripe(() => new Response("{}", { status: 503 }));
    await expect(down.provider.listPayouts({ since: "2026-04-01" })).rejects.toThrow();
  });
});
