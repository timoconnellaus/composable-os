// Card readers and payments in person (stage 50 step 4a, ADR 0774): registering a reader as an
// action a person approves, presenting a payment on it, and the fake reader's page delivering
// signed events, all through the real facet, routes and event Durable Object.

import { env, exports } from "cloudflare:workers";
import type { ActionDescription } from "@composable-os/gatekeeper-interface/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import { type FakeLedgerState, fakeLedger } from "../src/fake.js";
import { signatureHeader } from "../src/signature.js";
import type {
  PaymentsEvent,
  PaymentsPayment,
  PaymentsPresentation,
  PaymentsReader,
  PaymentsReaderChangeReceipt,
  PaymentsRefundReceipt,
} from "../src/types.js";

const BASE = "https://crm.example.com/gatekeeper/payments";
const FAKE_SECRET = "fake-payments-test-secret";

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
}

/** A session with the hook bound; the host's own orders call unless `asHost` is false. */
async function host(asHost = true) {
  const stub = env.TEST_HOST.getByName(unique("host"));
  await stub.open("fake", asHost);
  await stub.bindAndEnable();
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;

const ADDRESS = { country: "AU", line1: "1 Example Street", city: "Exampleton", postcode: "3000" };

function registration(readerId: string, overrides: Record<string, unknown> = {}) {
  return {
    readerId,
    registrationCode: `code-${readerId.replaceAll("_", "-")}`,
    label: "Front desk",
    locationName: "The studio",
    address: ADDRESS,
    ...overrides,
  };
}

/** Registers a reader as the host does: submit, then apply (a person approved it). */
async function registered(h: Host): Promise<PaymentsReader> {
  const readerId = unique("rdr");
  const receipt = (await h.call("registerReader", [
    registration(readerId),
  ])) as PaymentsReaderChangeReceipt;
  await h.apply(receipt.id);
  const readers = (await h.call("listReaders", [])) as PaymentsReader[];
  const reader = readers.find((r) => r.readerId === readerId);
  if (!reader) throw new Error("not registered");
  return reader;
}

function presentInput(orderId: string, readerRef: string, key = `present-${orderId}`) {
  return {
    orderId,
    amount: 450,
    currency: "aud",
    description: "A drink <cold>",
    readerRef,
    idempotencyKey: key,
  };
}

function readerUrl(readerRef: string): string {
  return `${BASE}/fake/reader/${readerRef}`;
}

function atReader(readerRef: string, outcome: string): Promise<Response> {
  return exports.default.fetch(
    new Request(readerUrl(readerRef), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome }).toString(),
      redirect: "manual",
    }),
  );
}

type ReaderEvent = Extract<PaymentsEvent, { kind: "reader" }>;
type PaymentEvent = Extract<PaymentsEvent, { kind: "payment" }>;

async function paymentsFor(h: Host, orderId: string): Promise<PaymentEvent[]> {
  return (await h.recorded()).received.filter(
    (e): e is PaymentEvent => e.kind === "payment" && e.orderId === orderId,
  );
}

async function readerEventsFor(h: Host, readerRef: string): Promise<ReaderEvent[]> {
  return (await h.recorded()).received.filter(
    (e): e is ReaderEvent => e.kind === "reader" && e.readerRef === readerRef,
  );
}

async function ledger(): Promise<FakeLedgerState> {
  return (await fakeLedger(env as never).state()) as FakeLedgerState;
}

describe("registering a card reader", () => {
  it("is an action a person approves: nothing is registered until it is applied", async () => {
    const h = await host();
    const readerId = unique("rdr");
    const receipt = (await h.call("registerReader", [
      registration(readerId),
    ])) as PaymentsReaderChangeReceipt;
    expect(receipt.status).toBe("pending");
    expect((await ledger()).readers.some((r) => r.readerId === readerId)).toBe(false);

    const submissions = (await h.recorded()).submissions as [number, ActionDescription][];
    const description = submissions.find(([id]) => id === receipt.id)?.[1];
    expect(description?.title).toBe("Register card reader Front desk");
    expect(JSON.stringify(description)).toContain("1 Example Street, Exampleton, 3000, AU");
    // The single-use pairing code is the admin's to type, not the approver's to read.
    expect(JSON.stringify(description)).not.toContain("code-");
    expect(await h.autoApprovable()).toEqual([]);

    await h.apply(receipt.id);
    const readers = (await h.call("listReaders", [])) as PaymentsReader[];
    expect(readers.find((r) => r.readerId === readerId)).toEqual({
      provider: "fake",
      ref: expect.stringMatching(/^frd_/),
      readerId,
      label: "Front desk",
      locationRef: expect.stringMatching(/^floc_/),
      status: "online",
      deviceType: "fake_reader",
    });
  });

  it("is refused for any session but the host's own, before anything is submitted", async () => {
    const h = await host(false);
    const before = (await h.recorded()).submissions.length;
    await expect(h.call("registerReader", [registration(unique("rdr"))])).rejects.toThrow(
      /only by the host/,
    );
    await expect(
      h.call("removeReader", [{ readerId: "rdr_1", readerRef: "frd_1", reason: "Broken" }]),
    ).rejects.toThrow(/only by the host/);
    expect((await h.recorded()).submissions.length).toBe(before);
  });

  it("refuses a code already used, and reuses one location per address", async () => {
    const h = await host();
    const first = await registered(h);
    const again = (await h.call("registerReader", [
      registration(unique("rdr"), {
        registrationCode: `code-${first.readerId?.replaceAll("_", "-")}`,
      }),
    ])) as PaymentsReaderChangeReceipt;
    await expect(h.apply(again.id)).rejects.toThrow(/refused.*code has been used/);
    const second = await registered(h);
    expect(second.locationRef).toBe(first.locationRef);
  });

  it("checks its input: known keys, a full address, a single-line label", async () => {
    const h = await host();
    for (const bad of [
      registration("rdr_x", { extra: 1 }),
      registration("rdr_x", { registrationCode: "has spaces" }),
      registration("rdr_x", { label: "two\nlines" }),
      registration("rdr_x", { address: { country: "AU", line1: "1 Example Street" } }),
      registration("rdr_x", { address: { ...ADDRESS, country: "au" } }),
    ]) {
      await expect(h.call("registerReader", [bad])).rejects.toThrow(TypeError);
    }
  });

  it("removes nothing when the provider's reader is not the host's reader of that id", async () => {
    const h = await host();
    const reader = await registered(h);
    const other = await registered(h);
    const receipt = (await h.call("removeReader", [
      { readerId: other.readerId, readerRef: reader.ref, reason: "Replaced" },
    ])) as PaymentsReaderChangeReceipt;
    await expect(h.apply(receipt.id)).rejects.toThrow(/refused.*not reader/);
    const refs = ((await h.call("listReaders", [])) as PaymentsReader[]).map((r) => r.ref);
    expect(refs).toEqual(expect.arrayContaining([reader.ref, other.ref]));
  });

  it("removes a reader as an action; it can take no payment after", async () => {
    const h = await host();
    const reader = await registered(h);
    const receipt = (await h.call("removeReader", [
      { readerId: reader.readerId, readerRef: reader.ref, reason: "Replaced" },
    ])) as PaymentsReaderChangeReceipt;
    expect(receipt.status).toBe("pending");
    await h.apply(receipt.id);
    const readers = (await h.call("listReaders", [])) as PaymentsReader[];
    expect(readers.some((r) => r.ref === reader.ref)).toBe(false);
    await expect(
      h.call("presentPayment", [presentInput(unique("ord"), reader.ref)]),
    ).rejects.toThrow(/no reader has that reference/);
  });
});

describe("a payment on a fake reader", () => {
  it("is paid only when the signed event arrives, as checkoutRef and paymentRef", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    const presented = (await h.call("presentPayment", [
      presentInput(orderId, reader.ref),
    ])) as PaymentsPresentation;
    expect(presented).toEqual({
      provider: "fake",
      ref: expect.stringMatching(/^fpi_/),
      readerRef: reader.ref,
      status: "presented",
    });
    const observed = (await h.recorded()).observations.at(-1);
    expect(observed?.title).toBe(`Put 4.50 AUD for order ${orderId} on a card reader`);
    expect(await paymentsFor(h, orderId)).toEqual([]);
    expect(((await h.call("getPayment", [presented.ref])) as PaymentsPayment).status).toBe("open");

    const page = await exports.default.fetch(new Request(readerUrl(reader.ref)));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("4.50 AUD");
    expect(html).toContain("A drink &lt;cold&gt;");
    for (const outcome of ["tap", "decline", "cancel"]) {
      expect(html).toContain(`name="outcome" value="${outcome}"`);
    }
    expect(html).not.toContain(orderId);
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);

    const tapped = await atReader(reader.ref, "tap");
    expect(tapped.status).toBe(303);
    expect(tapped.headers.get("location")).toBe(`/gatekeeper/payments/fake/reader/${reader.ref}`);
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
    expect((await paymentsFor(h, orderId))[0]).toEqual({
      kind: "payment",
      provider: "fake",
      eventId: `fevt_pay_${presented.ref}`,
      orderId,
      checkoutRef: presented.ref,
      amount: 450,
      currency: "AUD",
      paymentRef: presented.ref,
      occurredAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(
      await (await exports.default.fetch(new Request(readerUrl(reader.ref)))).text(),
    ).toContain("Waiting for a payment");
  });

  it("a decline leaves it unpaid with a reader event, and the same presentation may try again", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    const input = presentInput(orderId, reader.ref);
    const presented = (await h.call("presentPayment", [input])) as PaymentsPresentation;

    expect((await atReader(reader.ref, "decline")).status).toBe(303);
    await vi.waitFor(async () => expect(await readerEventsFor(h, reader.ref)).toHaveLength(1));
    expect((await readerEventsFor(h, reader.ref))[0]).toEqual({
      kind: "reader",
      provider: "fake",
      eventId: expect.stringMatching(/^fevt_reader_/),
      readerRef: reader.ref,
      checkoutRef: presented.ref,
      outcome: "failed",
      failureCode: "card_declined",
      occurredAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(((await h.call("getPayment", [presented.ref])) as PaymentsPayment).status).toBe("open");
    expect(await paymentsFor(h, orderId)).toEqual([]);

    const retried = (await h.call("presentPayment", [input])) as PaymentsPresentation;
    expect(retried).toMatchObject({ ref: presented.ref, status: "presented" });
    await atReader(reader.ref, "tap");
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
  });

  it("a retry after a timeout charges once: the same key is the same payment", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    const input = presentInput(orderId, reader.ref);
    const first = (await h.call("presentPayment", [input])) as PaymentsPresentation;
    // The answer was lost: the host asks again with the same key while it is on the reader.
    const second = (await h.call("presentPayment", [input])) as PaymentsPresentation;
    expect(second).toEqual(first);
    await atReader(reader.ref, "tap");
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
    // And again once it was paid: answered paid, not put on the reader a second time.
    const third = (await h.call("presentPayment", [input])) as PaymentsPresentation;
    expect(third).toMatchObject({ ref: first.ref, status: "paid" });
    const state = await ledger();
    expect(state.checkouts.filter((c) => c.orderId === orderId)).toHaveLength(1);
    expect(state.readers.find((r) => r.ref === reader.ref)?.action).toBeNull();
    // A second tap finds nothing on the reader: no second payment event.
    await atReader(reader.ref, "tap");
    expect(await paymentsFor(h, orderId)).toHaveLength(1);
  });

  it("a key sent again with another order, amount or currency is refused", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    const input = presentInput(orderId, reader.ref);
    await h.call("presentPayment", [input]);
    for (const changed of [
      { ...input, amount: 1 },
      { ...input, orderId: unique("ord") },
      { ...input, currency: "nzd" },
    ]) {
      await expect(h.call("presentPayment", [changed])).rejects.toThrow(/other details/);
    }
    // Paid, the same: never answered "paid" for a payment of another amount.
    await atReader(reader.ref, "tap");
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
    await expect(h.call("presentPayment", [{ ...input, amount: 1 }])).rejects.toThrow(
      /other details/,
    );
  });

  it("one payment at a time on a reader", async () => {
    const h = await host();
    const reader = await registered(h);
    await h.call("presentPayment", [presentInput(unique("ord"), reader.ref)]);
    await expect(
      h.call("presentPayment", [presentInput(unique("ord"), reader.ref)]),
    ).rejects.toThrow(/busy with another payment/);
  });

  it("the host clears the reader: a cancelled reader event, the payment stays unpaid", async () => {
    const h = await host();
    const reader = await registered(h);
    const presented = (await h.call("presentPayment", [
      presentInput(unique("ord"), reader.ref),
    ])) as PaymentsPresentation;
    await h.call("cancelPresented", [reader.ref]);
    await vi.waitFor(async () => expect(await readerEventsFor(h, reader.ref)).toHaveLength(1));
    expect((await readerEventsFor(h, reader.ref))[0]).toMatchObject({
      checkoutRef: presented.ref,
      outcome: "cancelled",
      failureCode: null,
    });
    expect(((await h.call("getPayment", [presented.ref])) as PaymentsPayment).status).toBe("open");
    // The reader is free for the next sale.
    await h.call("presentPayment", [presentInput(unique("ord"), reader.ref)]);
  });

  it("presenting and clearing are the host's own calls only", async () => {
    const h = await host(false);
    await expect(h.call("presentPayment", [presentInput("ord_1", "frd_1")])).rejects.toThrow(
      /only by the host/,
    );
    await expect(h.call("cancelPresented", ["frd_1"])).rejects.toThrow(/only by the host/);
    // The list too: a reader's reference is all the fake reader's public page needs.
    await expect(h.call("listReaders", [])).rejects.toThrow(/only by the host/);
  });

  it("nothing in the reader's form changes the amount; an unknown outcome is refused", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    await h.call("presentPayment", [presentInput(orderId, reader.ref)]);
    const odd = await exports.default.fetch(
      new Request(readerUrl(reader.ref), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "outcome=tap&amount=1",
        redirect: "manual",
      }),
    );
    expect(odd.status).toBe(303);
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
    expect((await paymentsFor(h, orderId))[0]?.amount).toBe(450);
    expect((await atReader(reader.ref, "steal")).status).toBe(400);
    const crossSite = await exports.default.fetch(
      new Request(readerUrl(reader.ref), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://elsewhere.test",
        },
        body: "outcome=tap",
      }),
    );
    expect(crossSite.status).toBe(403);
    expect((await exports.default.fetch(new Request(`${BASE}/fake/reader/frd_nope`))).status).toBe(
      404,
    );
  });

  it("a card-present payment is refunded through the existing refund", async () => {
    const h = await host();
    const reader = await registered(h);
    const orderId = unique("ord");
    const presented = (await h.call("presentPayment", [
      presentInput(orderId, reader.ref),
    ])) as PaymentsPresentation;
    await atReader(reader.ref, "tap");
    await vi.waitFor(async () => expect(await paymentsFor(h, orderId)).toHaveLength(1));
    const receipt = (await h.call("refund", [
      {
        orderId,
        paymentRef: presented.ref,
        amount: 450,
        currency: "AUD",
        reason: "Wrong drink",
        refundId: unique("rf"),
      },
    ])) as PaymentsRefundReceipt;
    await h.apply(receipt.id);
    expect((await ledger()).refunds.filter((r) => r.paymentRef === presented.ref)).toHaveLength(1);
  });
});

describe("the fake reader webhook", () => {
  it("verifies a reader event's signature and refuses a malformed one", async () => {
    const h = await host();
    const readerRef = unique("frd").replaceAll("_", "x");
    const body = (data: Record<string, unknown>) =>
      JSON.stringify({ id: unique("fevt"), type: "reader.action_failed", created: 1, data });
    const post = async (text: string, secret = FAKE_SECRET) =>
      exports.default.fetch(
        new Request(`${BASE}/in/fake`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fake-signature": await signatureHeader(secret, text, Math.floor(Date.now() / 1000)),
          },
          body: text,
        }),
      );
    const good = body({ readerRef, paymentRef: null, outcome: "failed", failureCode: null });
    expect((await post(good, "wrong-secret")).status).toBe(401);
    expect((await post(good)).status).toBe(200);
    await vi.waitFor(async () => expect(await readerEventsFor(h, readerRef)).toHaveLength(1));
    for (const bad of [
      body({ readerRef, paymentRef: null, outcome: "paid", failureCode: null }),
      body({ readerRef, paymentRef: null, outcome: "failed", failureCode: "4242 4242" }),
      body({ paymentRef: null, outcome: "failed", failureCode: null }),
    ]) {
      expect((await post(bad)).status).toBe(401);
    }
  });
});

describe("the served types", () => {
  it("name the reader calls and the reader event", async () => {
    const types = await (await host()).types();
    for (const name of [
      "registerReader(input: PaymentsRegisterReaderInput)",
      "presentPayment(input: PaymentsPresentInput)",
      "cancelPresented(readerRef: string)",
      'kind: "reader"',
      "PaymentsPresentation",
    ]) {
      expect(types).toContain(name);
    }
  });
});
