// Stage 32b (ADRs 0530, 0531): a plan change and a pause at the gatekeeper. Through the fake
// provider end to end: an upgrade charged now, prorated, applied only once paid; a downgrade from
// the next period with nothing prorated; a pause from now or later until a date, ended early; and
// none of them reaching the provider until the action is applied (an agent's session waits for a
// person). The Stripe provider's requests against recorded shapes (no real Stripe).
import { env, exports } from "cloudflare:workers";
import type { ActionDescription } from "@composable-os/gatekeeper-interface/gatekeeper";
import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import { type FakeLedgerState, fakeLedger } from "../src/fake.js";
import { advanceFakeSubscription } from "../src/routes.js";
import { StripeProvider } from "../src/stripe.js";
import type {
  PaymentsCheckout,
  PaymentsEvent,
  PaymentsSubscriptionChangeReceipt,
} from "../src/types.js";

const RETURN_URL = "https://gym.example.com/account";
const DAY = 86_400_000;

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
}

/** A session; the host's own orders call by default (plan changes and pauses are the host's only). */
async function host(asHost = true) {
  const stub = env.TEST_HOST.getByName(unique("host"));
  await stub.open("fake", asHost);
  await stub.bindAndEnable();
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
type SubscriptionEvent = Extract<PaymentsEvent, { kind: "subscription" }>;

async function eventsFor(h: Host, id: string): Promise<SubscriptionEvent[]> {
  return (await h.recorded()).received.filter(
    (e): e is SubscriptionEvent =>
      e.kind === "subscription" && e.subscription.subscriptionId === id,
  );
}

async function ledgerSubscription(id: string) {
  const state = (await fakeLedger(env as never).state()) as FakeLedgerState;
  const sub = state.subscriptions.find((s) => s.subscriptionId === id);
  if (!sub) throw new Error("no fake subscription");
  return sub;
}

async function started(h: Host, id: string) {
  const checkout = (await h.call("createSubscriptionCheckout", [
    {
      subscriptionId: id,
      amount: 3000,
      currency: "aud",
      interval: "month",
      description: "Three a week",
      returnUrl: RETURN_URL,
      customerEmail: "member@gym.test",
      idempotencyKey: `sub-${id}`,
    },
  ])) as PaymentsCheckout;
  const answer = await exports.default.fetch(
    new Request(checkout.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "pay" }).toString(),
      redirect: "manual",
    }),
  );
  expect(answer.status).toBe(303);
  await vi.waitFor(async () => expect((await eventsFor(h, id)).length).toBeGreaterThanOrEqual(2));
  return ledgerSubscription(id);
}

function change(id: string, ref: string, overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: id,
    subscriptionRef: ref,
    changeId: unique("sbc"),
    amount: 6000,
    currency: "AUD",
    interval: "month",
    description: "Unlimited",
    when: "now",
    taxed: false,
    reason: "Wants more classes",
    ...overrides,
  };
}

async function submitted(h: Host, receipt: PaymentsSubscriptionChangeReceipt) {
  const { submissions } = await h.recorded();
  return submissions.find(([action]) => action === receipt.id)?.[1] as
    | ActionDescription
    | undefined;
}

describe("a plan change at the fake provider", () => {
  it("is refused to any session but the host's, and sends nothing until it is applied", async () => {
    // Code Mode, an extension's tool, MCP, the assistant: refused before anything is queued.
    const other = await host(false);
    const otherId = unique("sbs");
    const otherSub = await started(other, otherId);
    await expect(other.call("changeSubscription", [change(otherId, otherSub.ref)])).rejects.toThrow(
      /only by the host/,
    );
    await expect(
      other.call("unpauseSubscription", [
        { subscriptionId: otherId, subscriptionRef: otherSub.ref, pauseId: "sbc_1", reason: "x" },
      ]),
    ).rejects.toThrow(/only by the host/);
    expect((await ledgerSubscription(otherId)).amount).toBe(3000);

    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const receipt = (await h.call("changeSubscription", [
      change(id, sub.ref),
    ])) as PaymentsSubscriptionChangeReceipt;
    expect(receipt.status).toBe("pending");
    const action = await submitted(h, receipt);
    expect(action?.actionKind?.tag).toBe("payments.subscription.change");
    expect(action?.autoApprovable).toBe(false);
    expect(action?.description).toContain("prorated");
    // The provider has not been asked: same price, no new invoice, no event.
    const before = await ledgerSubscription(id);
    expect(before.amount).toBe(3000);
    expect(before.invoices).toHaveLength(1);
    expect(await eventsFor(h, id)).toHaveLength(2);
    // The same for a pause.
    const pause = (await h.call("pauseSubscription", [
      {
        subscriptionId: id,
        subscriptionRef: sub.ref,
        pauseId: unique("sbc"),
        from: null,
        until: new Date(Date.now() + 14 * DAY).toISOString(),
        reason: "Injury",
      },
    ])) as PaymentsSubscriptionChangeReceipt;
    expect(pause.status).toBe("pending");
    expect((await submitted(h, pause))?.autoApprovable).toBe(false);
    expect((await ledgerSubscription(id)).status).toBe("active");
  });

  it("upgrades now, charging the rest of the period prorated, applied once paid", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const receipt = (await h.call("changeSubscription", [
      change(id, sub.ref),
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(4));
    const [updated, paid] = (await eventsFor(h, id)).slice(2);
    expect(updated?.subscription.amount).toBe(6000);
    expect(paid?.trigger).toBe("invoice_paid");
    expect(paid?.invoice?.billingReason).toBe("subscription_update");
    // Nearly a whole month was left: nearly the whole difference, never more.
    expect(paid?.invoice?.amountPaid).toBeGreaterThan(2900);
    expect(paid?.invoice?.amountPaid).toBeLessThanOrEqual(3000);
    // The next renewal is the new price.
    await advanceFakeSubscription(env as never, sub.ref, "renew");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(6));
    // The renewal's invoice, whichever of its two events was recorded last.
    const renewal = (await eventsFor(h, id)).slice(4).find((e) => e.trigger === "invoice_paid");
    expect(renewal?.invoice?.amountPaid).toBe(6000);
  });

  it("leaves the old price when the upgrade's charge is declined, until it is paid", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    await advanceFakeSubscription(env as never, sub.ref, "card_declines");
    const receipt = (await h.call("changeSubscription", [
      change(id, sub.ref),
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(3));
    const failed = (await eventsFor(h, id))[2];
    expect(failed?.trigger).toBe("invoice_payment_failed");
    expect(failed?.subscription).toMatchObject({ status: "active", amount: 3000 });
    await advanceFakeSubscription(env as never, sub.ref, "card_works");
    await advanceFakeSubscription(env as never, sub.ref, "recover");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(5));
    expect((await eventsFor(h, id))[3]?.subscription.amount).toBe(6000);
  });

  it("downgrades from the next period, with nothing prorated", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const receipt = (await h.call("changeSubscription", [
      change(id, sub.ref, { amount: 2000, when: "next_period", description: "Two a week" }),
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(3));
    expect((await eventsFor(h, id))[2]?.subscription.amount).toBe(2000);
    expect((await ledgerSubscription(id)).invoices).toHaveLength(1);
    await advanceFakeSubscription(env as never, sub.ref, "renew");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(5));
    expect(
      (await eventsFor(h, id)).slice(3).find((e) => e.trigger === "invoice_paid")?.invoice
        ?.amountPaid,
    ).toBe(2000);
  });
});

describe("a pause at the fake provider", () => {
  it("pauses now, credits the unused time, and resumes on its date with a new period", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const until = new Date(Date.now() + 21 * DAY).toISOString();
    const receipt = (await h.call("pauseSubscription", [
      {
        subscriptionId: id,
        subscriptionRef: sub.ref,
        pauseId: unique("sbc"),
        from: null,
        until,
        reason: "Travel",
      },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(3));
    expect((await eventsFor(h, id))[2]).toMatchObject({
      trigger: "paused",
      subscription: { status: "paused" },
    });
    // No renewal while paused.
    await expect(advanceFakeSubscription(env as never, sub.ref, "renew")).rejects.toThrow(/paused/);
    await advanceFakeSubscription(env as never, sub.ref, "pause_ends");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(5));
    const [resumed, paid] = (await eventsFor(h, id)).slice(3);
    expect(resumed?.trigger).toBe("resumed");
    expect(resumed?.subscription.currentPeriodStart).toBe(until);
    // The new period less the unused time of the one paused in: nearly nothing was used.
    expect(paid?.invoice?.amountPaid).toBeLessThan(200);
  });

  it("schedules a pause for later and withdraws it, and refuses one on trial", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const from = new Date(Date.now() + 3 * DAY).toISOString();
    const pauseId = unique("sbc");
    const scheduled = (await h.call("pauseSubscription", [
      {
        subscriptionId: id,
        subscriptionRef: sub.ref,
        pauseId,
        from,
        until: new Date(Date.parse(from) + 7 * DAY).toISOString(),
        reason: "Holiday",
      },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(scheduled.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(3));
    expect((await eventsFor(h, id))[2]?.subscription.status).toBe("active");
    expect((await ledgerSubscription(id)).pauseAt).toBe(from);
    const withdrawn = (await h.call("unpauseSubscription", [
      { subscriptionId: id, subscriptionRef: sub.ref, pauseId, reason: "Not going" },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(withdrawn.id);
    await vi.waitFor(async () => expect((await ledgerSubscription(id)).pauseAt).toBeNull());
    await expect(advanceFakeSubscription(env as never, sub.ref, "pause_starts")).rejects.toThrow();
  });

  it("refuses malformed pauses and changes before anything is queued", async () => {
    const h = await host();
    const id = unique("sbs");
    const base = { subscriptionId: id, subscriptionRef: "fsub_x", pauseId: "sbc_1", reason: "x" };
    const count = async () => (await h.recorded()).submissions.length;
    const before = await count();
    await expect(
      h.call("pauseSubscription", [
        { ...base, from: null, until: new Date(Date.now() - DAY).toISOString() },
      ]),
    ).rejects.toThrow();
    await expect(
      h.call("pauseSubscription", [
        { ...base, from: null, until: new Date(Date.now() + 400 * DAY).toISOString() },
      ]),
    ).rejects.toThrow(/at most/);
    await expect(
      h.call("changeSubscription", [change(id, "fsub_x", { when: "later" })]),
    ).rejects.toThrow();
    await expect(
      h.call("changeSubscription", [change(id, "fsub_x", { amount: 0 })]),
    ).rejects.toThrow();
    expect(await count()).toBe(before);
  });
});

// --- Stripe, against recorded shapes ----------------------------------------------------------

type Recorded = { url: string; method: string; form: URLSearchParams; key: string | null };
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stripe(answer: (r: Recorded) => Response) {
  const requests: Recorded[] = [];
  const provider = new StripeProvider({
    secretKey: "sk_test_key",
    webhookSecret: "whsec_x",
    apiBase: "https://stripe.test",
    account: "",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const recorded: Recorded = {
        url: String(input),
        method: init?.method ?? "GET",
        form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
        key: headers.get("idempotency-key"),
      };
      requests.push(recorded);
      return answer(recorded);
    }) as typeof fetch,
  });
  return { provider, requests };
}

const SUB = {
  id: "sub_1",
  status: "active",
  schedule: null,
  items: { data: [{ id: "si_1", price: { id: "price_old", product: "prod_1" } }] },
};

describe("the Stripe provider's plan changes and pauses", () => {
  const input = {
    subscriptionId: "sbs_1",
    subscriptionRef: "sub_1",
    changeId: "sbc_1",
    amount: 6000,
    currency: "AUD",
    interval: "month" as const,
    description: "Unlimited",
    taxed: true,
    reason: "More",
  };

  it("upgrades with a new price on the item's product, as a pending update invoiced now", async () => {
    const { provider, requests } = stripe((r) =>
      ok(r.url.endsWith("/v1/prices") ? { id: "price_new" } : SUB),
    );
    await provider.changeSubscription({ ...input, when: "now" });
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "https://stripe.test/v1/subscriptions/sub_1?expand[]=schedule"],
      ["GET", "https://stripe.test/v1/subscriptions/sub_1"],
      ["POST", "https://stripe.test/v1/prices"],
      ["POST", "https://stripe.test/v1/subscriptions/sub_1"],
    ]);
    expect(Object.fromEntries(requests[2]?.form ?? [])).toMatchObject({
      currency: "aud",
      unit_amount: "6000",
      product: "prod_1",
      "recurring[interval]": "month",
      tax_behavior: "inclusive",
    });
    expect(Object.fromEntries(requests[3]?.form ?? [])).toEqual({
      "items[0][id]": "si_1",
      "items[0][quantity]": "1",
      "items[0][price]": "price_new",
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    expect(requests[3]?.key).toBe("cos-change-sbc_1");
  });

  it("downgrades with inline price data and no proration", async () => {
    const { provider, requests } = stripe(() => ok(SUB));
    await provider.changeSubscription({
      ...input,
      amount: 2000,
      when: "next_period",
      taxed: false,
    });
    expect(Object.fromEntries(requests[2]?.form ?? [])).toEqual({
      "items[0][id]": "si_1",
      "items[0][quantity]": "1",
      "items[0][price_data][currency]": "aud",
      "items[0][price_data][product]": "prod_1",
      "items[0][price_data][unit_amount]": "2000",
      "items[0][price_data][recurring][interval]": "month",
      proration_behavior: "none",
    });
  });

  it("refuses a subscription of more than one item, and a refused price changes nothing", async () => {
    const two = stripe(() =>
      ok({ ...SUB, items: { data: [SUB.items.data[0], { id: "si_2", price: { product: "p" } }] } }),
    );
    await expect(two.provider.changeSubscription({ ...input, when: "now" })).rejects.toBeInstanceOf(
      ActionApplyError,
    );
    const refused = stripe((r) =>
      r.url.endsWith("/v1/prices") ? new Response("{}", { status: 400 }) : ok(SUB),
    );
    await expect(
      refused.provider.changeSubscription({ ...input, when: "now" }),
    ).rejects.toBeInstanceOf(ActionApplyError);
    expect(refused.requests).toHaveLength(3);
  });

  it("pauses through a pause schedule, releasing it when the pause is refused", async () => {
    const at = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
    const until = "2030-02-01T00:00:00.000Z";
    const { provider, requests } = stripe(() => ok({ id: "sub_sched_1" }));
    await provider.pauseSubscription({
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      pauseId: "sbc_2",
      from: null,
      until,
      reason: "Injury",
    });
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/subscriptions/sub_1?expand[]=schedule",
      "https://stripe.test/v1/subscription_schedules",
      "https://stripe.test/v1/subscription_schedules/sub_sched_1",
    ]);
    expect(requests[1]?.form.get("from_subscription")).toBe("sub_1");
    expect(Object.fromEntries(requests[2]?.form ?? [])).toMatchObject({
      "pause_schedules[0][pause][pause_at][type]": "now",
      "pause_schedules[0][resume][resume_at][type]": "timestamp",
      "pause_schedules[0][resume][resume_at][timestamp]": at(until),
    });

    const refusing = stripe((r) =>
      r.url.endsWith("/sub_sched_1")
        ? new Response("{}", { status: 400 })
        : ok({ id: "sub_sched_1" }),
    );
    await expect(
      refusing.provider.pauseSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        pauseId: "sbc_3",
        from: "2030-01-10T00:00:00.000Z",
        until,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ActionApplyError);
    expect(refusing.requests.at(-1)?.url).toBe(
      "https://stripe.test/v1/subscription_schedules/sub_sched_1/release",
    );
  });

  it("ends a running pause in one call, by moving its scheduled resume to now", async () => {
    const { provider, requests } = stripe((r) =>
      ok(r.method === "GET" ? { ...SUB, status: "paused", schedule: "sub_sched_1" } : {}),
    );
    const unpause = {
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      pauseId: "sbc_2",
      reason: "x",
    };
    await provider.unpauseSubscription(unpause);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "https://stripe.test/v1/subscriptions/sub_1?expand[]=latest_invoice"],
      ["POST", "https://stripe.test/v1/subscription_schedules/sub_sched_1"],
    ]);
    expect(Object.fromEntries(requests[1]?.form ?? [])).toEqual({
      "pause_schedules[0][key]": "sbc_2",
      "pause_schedules[0][resume][resume_at][type]": "now",
    });
    // A paused one with no schedule resumes directly, anchored now, once paid.
    const bare = stripe((r) => ok(r.method === "GET" ? { ...SUB, status: "paused" } : {}));
    await bare.provider.unpauseSubscription(unpause);
    expect(bare.requests[1]?.url).toBe("https://stripe.test/v1/subscriptions/sub_1/resume");
    expect(Object.fromEntries(bare.requests[1]?.form ?? [])).toEqual({
      "billing_cycle_anchor[type]": "now",
      payment_behavior: "resume_on_payment_success",
    });
  });

  it("a refused or unknown end of a pause says so, and calling again finishes it with a new key", async () => {
    let fail: "refused" | "unknown" | null = "refused";
    const { provider, requests } = stripe((r) => {
      if (r.method === "GET") return ok({ ...SUB, status: "paused", schedule: "sub_sched_1" });
      if (fail === "refused") return new Response("{}", { status: 400 });
      if (fail === "unknown") return new Response("{}", { status: 502 });
      return ok({});
    });
    const unpause = {
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      pauseId: "sbc_2",
      reason: "x",
    };
    await expect(provider.unpauseSubscription(unpause)).rejects.toBeInstanceOf(ActionApplyError);
    fail = "unknown";
    await expect(provider.unpauseSubscription(unpause)).rejects.toBeInstanceOf(
      ActionOutcomeUnknownError,
    );
    fail = null;
    await provider.unpauseSubscription(unpause);
    const keys = requests.filter((r) => r.method === "POST").map((r) => r.key);
    expect(new Set(keys).size).toBe(3);
  });

  it("withdraws a pause not yet started by clearing its pause schedule, then releasing", async () => {
    const { provider, requests } = stripe((r) =>
      r.url.endsWith("/release")
        ? new Response("{}", { status: 400 })
        : ok(r.method === "GET" ? { ...SUB, status: "active", schedule: "sub_sched_1" } : {}),
    );
    await provider.unpauseSubscription({
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      pauseId: "sbc_2",
      reason: "Not going",
    });
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/subscriptions/sub_1?expand[]=latest_invoice",
      "https://stripe.test/v1/subscription_schedules/sub_sched_1",
      "https://stripe.test/v1/subscription_schedules/sub_sched_1/release",
    ]);
    expect(requests[1]?.form.get("pause_schedules")).toBe("");
    const none = stripe(() => ok({ ...SUB, status: "active", schedule: null }));
    await expect(
      none.provider.unpauseSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        pauseId: "sbc_2",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ActionApplyError);
  });

  it("a pause whose second call has an unknown outcome says so, and is not released", async () => {
    const { provider, requests } = stripe((r) =>
      r.url.endsWith("/sub_sched_1")
        ? new Response("{}", { status: 502 })
        : ok({ id: "sub_sched_1" }),
    );
    await expect(
      provider.pauseSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        pauseId: "sbc_3",
        from: null,
        until: "2030-02-01T00:00:00.000Z",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    expect(requests.some((r) => r.url.endsWith("/release"))).toBe(false);
  });

  it("an upgrade or downgrade with a pause schedule attached: a finished one is released first, one to come refuses", async () => {
    const finished = {
      id: "sub_sched_1",
      metadata: { cos_pause: "sbc_p" },
      pause_schedules: [{ key: "sbc_p", resume: { status: { type: "succeeded" } } }],
    };
    for (const when of ["now", "next_period"] as const) {
      const { provider, requests } = stripe((r) =>
        ok(
          r.url.endsWith("/v1/prices")
            ? { id: "price_new" }
            : r.url.includes("expand[]=schedule")
              ? { ...SUB, schedule: finished }
              : SUB,
        ),
      );
      await provider.changeSubscription({ ...input, when });
      expect(requests[1]?.url).toBe(
        "https://stripe.test/v1/subscription_schedules/sub_sched_1/release",
      );
      expect(requests.at(-1)?.url).toBe("https://stripe.test/v1/subscriptions/sub_1");
    }
    const toCome = {
      ...finished,
      pause_schedules: [{ key: "sbc_p", resume: { status: { type: "scheduled" } } }],
    };
    const refusing = stripe((r) =>
      ok(r.url.includes("expand[]=schedule") ? { ...SUB, schedule: toCome } : SUB),
    );
    await expect(
      refusing.provider.changeSubscription({ ...input, when: "next_period" }),
    ).rejects.toThrow(/pause not over/);
    expect(refusing.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    // A schedule this host did not make is never released.
    const foreign = stripe((r) =>
      ok(
        r.url.includes("expand[]=schedule")
          ? { ...SUB, schedule: { id: "sub_sched_9", pause_schedules: [] } }
          : SUB,
      ),
    );
    await expect(
      foreign.provider.changeSubscription({ ...input, when: "now" }),
    ).rejects.toBeInstanceOf(ActionApplyError);
  });

  it("withdraws an upgrade by voiding the invoice its pending update made", async () => {
    const pending = {
      ...SUB,
      pending_update: { expires_at: 1_900_000_000 },
      latest_invoice: { id: "in_up", status: "open" },
    };
    const { provider, requests } = stripe((r) => ok(r.method === "GET" ? pending : {}));
    const voiding = {
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      changeId: "sbc_1",
      reason: "x",
    };
    await provider.voidPendingUpdate(voiding);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "https://stripe.test/v1/subscriptions/sub_1?expand[]=latest_invoice"],
      ["POST", "https://stripe.test/v1/invoices/in_up/void"],
    ]);
    // Nothing pending (paid and applied, or expired): refused, nothing changed.
    const none = stripe(() =>
      ok({ ...SUB, pending_update: null, latest_invoice: { id: "in_1", status: "paid" } }),
    );
    await expect(none.provider.voidPendingUpdate(voiding)).rejects.toBeInstanceOf(ActionApplyError);
  });

  it("does not ask a resume again while one waits for its payment", async () => {
    const { provider, requests } = stripe((r) =>
      ok(
        r.method === "GET"
          ? {
              ...SUB,
              status: "paused",
              schedule: null,
              latest_invoice: { id: "in_r", status: "open" },
            }
          : {},
      ),
    );
    await expect(
      provider.unpauseSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        pauseId: "sbc_2",
        reason: "x",
      }),
    ).rejects.toThrow(/waiting for its payment/);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("a refused pause whose schedule cannot be released is an unknown outcome, not a refusal", async () => {
    const { provider } = stripe((r) =>
      r.url.endsWith("/sub_sched_1") || r.url.endsWith("/release")
        ? new Response("{}", { status: 400 })
        : ok({ id: "sub_sched_1" }),
    );
    await expect(
      provider.pauseSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        pauseId: "sbc_4",
        from: null,
        until: "2030-02-01T00:00:00.000Z",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
  });
});

describe("what the gatekeeper says came of an action, and voiding at the fake provider", () => {
  it("tags an apply failure with its outcome, which RPC carries as the message", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    // Refused at the fake (no such subscription): nothing changed.
    const refused = (await h.call("changeSubscription", [
      change(id, "fsub_missing"),
    ])) as PaymentsSubscriptionChangeReceipt;
    await expect(h.apply(refused.id)).rejects.toThrow(/^\[apply-outcome:refused\] /);
    // A pending upgrade voided: the fake's price stays, its open invoice gone.
    await advanceFakeSubscription(env as never, sub.ref, "card_declines");
    const up = (await h.call("changeSubscription", [
      change(id, sub.ref),
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(up.id);
    await vi.waitFor(async () => expect((await ledgerSubscription(id)).pendingAmount).toBe(6000));
    const voided = (await h.call("voidPendingUpdate", [
      { subscriptionId: id, subscriptionRef: sub.ref, changeId: "sbc_1", reason: "Withdrawn" },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(voided.id);
    const after = await ledgerSubscription(id);
    expect(after.pendingAmount).toBeNull();
    expect(after.amount).toBe(3000);
    expect(after.invoices.some((i) => i.status === "open")).toBe(false);
    const again = (await h.call("voidPendingUpdate", [
      { subscriptionId: id, subscriptionRef: sub.ref, changeId: "sbc_1", reason: "Withdrawn" },
    ])) as PaymentsSubscriptionChangeReceipt;
    await expect(h.apply(again.id)).rejects.toThrow(/^\[apply-outcome:refused\] /);
    // Not the host's own call: refused before anything is queued.
    const other = await host(false);
    await expect(
      other.call("voidPendingUpdate", [
        { subscriptionId: id, subscriptionRef: sub.ref, changeId: "sbc_1", reason: "x" },
      ]),
    ).rejects.toThrow(/only by the host/);
  });

  it("refuses a plan change while a pause is scheduled at the fake provider", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const from = new Date(Date.now() + 3 * DAY).toISOString();
    const paused = (await h.call("pauseSubscription", [
      {
        subscriptionId: id,
        subscriptionRef: sub.ref,
        pauseId: unique("sbc"),
        from,
        until: new Date(Date.parse(from) + 7 * DAY).toISOString(),
        reason: "x",
      },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(paused.id);
    const up = (await h.call("changeSubscription", [
      change(id, sub.ref),
    ])) as PaymentsSubscriptionChangeReceipt;
    await expect(h.apply(up.id)).rejects.toThrow(/apply-outcome:refused.*pause is scheduled/);
  });
});
