// The fake provider, for development and tests: a ledger Durable Object standing in for the
// provider's books, a hosted page with Pay and Cancel buttons, and signed webhook deliveries to the
// gatekeeper's own `/in/fake` route. It is on only when PAYMENTS_FAKE_PROVIDER is "true".
//
// It never asks for card details: its page has no card fields, and it stores nothing a customer
// typed.

import { DurableObject } from "cloudflare:workers";
import { ActionApplyError } from "@composable-os/gatekeeper-kit/actions";
import type { CheckoutInput, PaymentProvider, RefundInput, VerifiedWebhook } from "./provider.js";
import { randomId, verifySignatureHeader } from "./signature.js";
import { subscriptionEvent } from "./subscription-shape.js";
import type {
  PaymentsCancelSubscriptionInput,
  PaymentsChangeSubscriptionInput,
  PaymentsCheckoutTax,
  PaymentsEvent,
  PaymentsInterval,
  PaymentsInvoice,
  PaymentsPauseSubscriptionInput,
  PaymentsPayment,
  PaymentsPortalInput,
  PaymentsResumeSubscriptionInput,
  PaymentsSubscription,
  PaymentsSubscriptionCheckoutInput,
  PaymentsSubscriptionStatus,
  PaymentsSubscriptionTrigger,
  PaymentsTaxReport,
  PaymentsUnpauseSubscriptionInput,
  PaymentsVoidUpdateInput,
} from "./types.js";

const CHECKOUT_LIFETIME_MS = 30 * 60 * 1000;

/**
 * The fake provider's tax registrations: the countries where it collects tax, and the rate, in
 * basis points. Everywhere else it collects none, as Stripe Tax collects only where the org has
 * added a registration. Development and tests only: these are not advice on any rate.
 */
export const FAKE_TAX_REGISTRATIONS: Readonly<Record<string, number>> = {
  AU: 1000,
  NZ: 1500,
  GB: 2000,
};
/** Stripe's product tax code for something not taxable; the fake collects nothing on it. */
export const NONTAXABLE_TAX_CODE = "txcd_00000000";
/** The billing countries the fake page offers. */
export const FAKE_BILLING_COUNTRIES = ["AU", "NZ", "GB", "US", "DE"] as const;

/** The tax inside a tax-inclusive `amount` at `basisPoints`, rounded to the minor unit. */
export function inclusiveTax(amount: number, basisPoints: number): number {
  return amount - Math.round((amount * 10_000) / (10_000 + basisPoints));
}

/**
 * What the fake provider calculates for a taxed checkout paid from `country`: each line's tax
 * inside its own amount, at the rate of the country where it is registered, else nothing.
 */
export function fakeTaxReport(tax: PaymentsCheckoutTax, country: string): PaymentsTaxReport {
  // A line with a place (an in-person event) is taxed where the event is, not where the buyer is.
  const where = (line: PaymentsCheckoutTax["lines"][number]) => line.place?.country ?? country;
  const lines = tax.lines.map((line) => ({
    ref: line.ref,
    amount:
      line.taxCode === NONTAXABLE_TAX_CODE
        ? 0
        : inclusiveTax(line.amount, FAKE_TAX_REGISTRATIONS[where(line)] ?? 0),
  }));
  const places = new Set(tax.lines.map(where));
  return {
    amount: lines.reduce((sum, line) => sum + line.amount, 0),
    country: places.size === 1 ? (places.values().next().value as string) : country,
    lines,
  };
}
/** Checkouts and refunds the ledger keeps; the oldest go first. */
const MAX_CHECKOUTS = 1000;
const MAX_REFUNDS = 1000;

export type FakeCheckout = {
  ref: string;
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  status: "open" | "paid";
  paymentRef: string | null;
  idempotencyKey: string;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
  /** What the payment event reported, when a test overrode it. */
  paidAmount: number | null;
  /** The tax the host asked for, only when it asked (absent: a checkout exactly as before tax). */
  tax?: PaymentsCheckoutTax;
  /** Once paid with tax: the billing country given on the page and the tax calculated. */
  billingCountry?: string;
  taxReport?: PaymentsTaxReport;
  /** A subscription checkout (ADR 0485): what the page starts. Absent: one payment. */
  subscription?: FakeSubscriptionCheckout;
};

/** What a subscription checkout starts once the page is submitted. */
export type FakeSubscriptionCheckout = {
  subscriptionId: string;
  interval: PaymentsInterval;
  customerRef: string | null;
  trialDays: number | null;
  trialEnd: string | null;
  taxCode: string | null;
  /** The subscription it started, once submitted. */
  ref: string | null;
};

export type FakeInvoice = {
  ref: string;
  status: "paid" | "open";
  amountPaid: number;
  amountDue: number;
  paymentRef: string | null;
  periodStart: string;
  periodEnd: string;
  billingReason: string;
  attemptCount: number;
  hostedUrl: string | null;
  tax: { amount: number; country: string | null } | null;
};

/** The fake provider's subscription, standing in for Stripe's. */
export type FakeSubscription = {
  ref: string;
  customerRef: string;
  subscriptionId: string;
  status: PaymentsSubscriptionStatus;
  amount: number;
  currency: string;
  interval: PaymentsInterval;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  canceledAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  taxCode: string | null;
  billingCountry: string | null;
  createdAt: string;
  invoices: FakeInvoice[];
  /** Stage 32b (ADR 0530): the payer's card declines every charge until told otherwise. */
  declines?: boolean;
  /** An upgrade waiting on its prorated charge (Stripe's pending update): the price it applies. */
  pendingAmount?: number | null;
  /** A pause (ADR 0531): when it starts (null once it has) and when the provider resumes it. */
  pauseAt?: string | null;
  resumeAt?: string | null;
  /** The unused time of the period paused in, credited on the resumption invoice. */
  pauseCredit?: number;
};

/**
 * What a test or a developer makes the fake provider's schedule do next (no public route: through
 * the ledger's binding only). `renew`: the period ends and the next is charged, or the subscription
 * ends when it was set to. `fail`: the next charge fails. `retry_fail`: the provider's retry fails
 * again. `recover`: a retry pays the open invoice. `action_required`: the next charge needs the
 * payer to confirm it (3D Secure). `give_up`: the retries ran out and the provider cancels.
 * `trial_will_end`: three days before the trial ends.
 */
export type FakeSubscriptionStep =
  | "renew"
  | "fail"
  | "retry_fail"
  | "recover"
  | "action_required"
  | "give_up"
  | "trial_will_end"
  // Stage 32b: the card starts or stops declining; a scheduled pause starts; the pause ends on
  // its date and the provider charges the new period.
  | "card_declines"
  | "card_works"
  | "pause_starts"
  | "pause_ends";

/** The period after `from`, in UTC. */
export function addInterval(from: string, interval: PaymentsInterval): string {
  const at = new Date(from);
  if (interval === "week") at.setUTCDate(at.getUTCDate() + 7);
  else if (interval === "month") at.setUTCMonth(at.getUTCMonth() + 1);
  else at.setUTCFullYear(at.getUTCFullYear() + 1);
  return at.toISOString();
}

export type FakeRefund = {
  refundRef: string;
  paymentRef: string;
  amount: number;
  currency: string;
  orderId: string;
  refundId: string;
  createdAt: string;
  /** For a period's refund credited on its invoice: the tax it gave back. */
  tax?: number;
};

export type FakeLedgerState = {
  checkouts: FakeCheckout[];
  refunds: FakeRefund[];
  subscriptions: FakeSubscription[];
};

/** What `pay()` did. */
export type FakePayResult =
  | { found: false }
  /** A taxed checkout paid without a billing address: nothing was paid. */
  | { found: true; needsAddress: true }
  | {
      found: true;
      checkout: FakeCheckout;
      newlyPaid: boolean;
      needsAddress?: undefined;
      /** A subscription checkout's events, to deliver in this order. */
      deliveries?: FakeWebhookBody[];
    };

export type FakeRefundResult =
  | { ok: true; refund: FakeRefund; created: boolean }
  | { ok: false; reason: string };

const CHECKOUT = "checkout:";
const IDEMPOTENCY = "idem:";
const REFUND = "refund:";
const REFUND_BY_ID = "refund-id:";
const SUBSCRIPTION = "subscription:";
const EVENT_COUNTER = "event-counter";
const CLOCK = "clock";

/** A fake subscription as a read of it at `observedAt`. */
export function fakeSubscriptionRead(
  sub: FakeSubscription,
  observedAt: string,
): PaymentsSubscription {
  return {
    provider: "fake",
    ref: sub.ref,
    customerRef: sub.customerRef,
    subscriptionId: sub.subscriptionId,
    status: sub.status,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelAt: null,
    trialEnd: sub.trialEnd,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    canceledAt: sub.canceledAt,
    endedAt: sub.endedAt,
    endReason: sub.endReason,
    observedAt,
  };
}

export function fakeInvoiceRead(sub: FakeSubscription, invoice: FakeInvoice): PaymentsInvoice {
  return {
    ref: invoice.ref,
    status: invoice.status,
    amountPaid: invoice.amountPaid,
    amountDue: invoice.amountDue,
    currency: sub.currency,
    paymentRef: invoice.paymentRef,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    billingReason: invoice.billingReason,
    attemptCount: invoice.attemptCount,
    nextAttemptAt:
      invoice.status === "open"
        ? new Date(Date.parse(invoice.periodStart) + 3 * 86_400_000).toISOString()
        : null,
    hostedUrl: invoice.hostedUrl,
    ...(invoice.tax ? { tax: invoice.tax } : {}),
  };
}

/** The fake provider's books: one instance, `idFromName("fake")`. */
export class FakePaymentsLedger extends DurableObject<Cloudflare.Env> {
  /** Opens a checkout, or returns the one opened before under the same idempotency key. */
  async createCheckout(input: CheckoutInput): Promise<FakeCheckout> {
    const kv = this.ctx.storage.kv;
    const existingRef = kv.get<string>(IDEMPOTENCY + input.idempotencyKey);
    if (existingRef !== undefined) {
      const existing = kv.get<FakeCheckout>(CHECKOUT + existingRef);
      if (existing) return existing;
    }
    const now = Date.now();
    const ref = randomId("fcs_");
    const checkout: FakeCheckout = {
      ref,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      returnUrl: input.returnUrl,
      status: "open",
      paymentRef: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHECKOUT_LIFETIME_MS).toISOString(),
      paidAmount: null,
      ...(input.tax ? { tax: input.tax } : {}),
    };
    kv.put(CHECKOUT + ref, checkout);
    kv.put(IDEMPOTENCY + input.idempotencyKey, ref);
    this.#prune<FakeCheckout>(CHECKOUT, MAX_CHECKOUTS, (row) =>
      kv.delete(IDEMPOTENCY + row.idempotencyKey),
    );
    return checkout;
  }

  async getCheckout(ref: string): Promise<FakeCheckout | null> {
    return this.ctx.storage.kv.get<FakeCheckout>(CHECKOUT + ref) ?? null;
  }

  /**
   * Marks a checkout paid, once. A second pay changes nothing. A taxed checkout needs the buyer's
   * billing country (Stripe requires the billing address when it calculates tax), and the tax is
   * calculated then, as the provider does it.
   */
  async pay(
    ref: string,
    amountOverride: number | null,
    billingCountry: string | null = null,
  ): Promise<FakePayResult> {
    const kv = this.ctx.storage.kv;
    const checkout = kv.get<FakeCheckout>(CHECKOUT + ref);
    if (!checkout) return { found: false };
    if (checkout.status === "paid") return { found: true, checkout, newlyPaid: false };
    if ((checkout.tax || checkout.subscription?.taxCode) && billingCountry === null) {
      return { found: true, needsAddress: true };
    }
    if (checkout.subscription) return this.#startSubscription(checkout, billingCountry);
    const paid: FakeCheckout = {
      ...checkout,
      status: "paid",
      paymentRef: randomId("fpi_"),
      paidAmount: amountOverride,
      ...(checkout.tax && billingCountry !== null
        ? { billingCountry, taxReport: fakeTaxReport(checkout.tax, billingCountry) }
        : {}),
    };
    kv.put(CHECKOUT + ref, paid);
    return { found: true, checkout: paid, newlyPaid: true };
  }

  /**
   * Records a refund against a paid checkout. Refused when the payment is unknown, the currency
   * differs, or the refunds on that payment would total more than was paid. The same refundId
   * returns the refund recorded before.
   */
  async refund(input: RefundInput): Promise<FakeRefundResult> {
    const kv = this.ctx.storage.kv;
    const priorRef = kv.get<string>(REFUND_BY_ID + input.refundId);
    if (priorRef !== undefined) {
      const prior = kv.get<FakeRefund>(REFUND + priorRef);
      if (prior) return { ok: true, refund: prior, created: false };
    }
    // A subscription period's payment is on its invoice (ADR 0486); any other is a checkout's.
    let paid: number;
    let currency: string;
    let invoiceTax: { amount: number; paid: number } | null = null;
    if (input.invoiceRef !== undefined) {
      const found = this.#subscriptions()
        .flatMap((sub) => sub.invoices.map((invoice) => ({ sub, invoice })))
        .find(({ invoice }) => invoice.ref === input.invoiceRef);
      if (found?.invoice.status !== "paid" || found.invoice.paymentRef !== input.paymentRef) {
        return { ok: false, reason: "no paid invoice has that reference and payment" };
      }
      paid = found.invoice.amountPaid;
      currency = found.sub.currency;
      if (found.invoice.tax) invoiceTax = { amount: found.invoice.tax.amount, paid };
    } else {
      const checkout = [...kv.list<FakeCheckout>({ prefix: CHECKOUT })]
        .map(([, row]) => row)
        .find(
          (row) =>
            row.paymentRef === input.paymentRef && row.status === "paid" && !row.subscription,
        );
      if (!checkout) return { ok: false, reason: "no paid payment has that reference" };
      paid = checkout.paidAmount ?? checkout.amount;
      currency = checkout.currency;
    }
    if (currency !== input.currency) {
      return { ok: false, reason: `the payment was in ${currency}` };
    }
    const refunded = [...kv.list<FakeRefund>({ prefix: REFUND })]
      .map(([, row]) => row)
      .filter((row) => row.paymentRef === input.paymentRef)
      .reduce((sum, row) => sum + row.amount, 0);
    if (refunded + input.amount > paid) {
      return {
        ok: false,
        reason: `that would refund ${refunded + input.amount} of a payment of ${paid} minor units`,
      };
    }
    const refund: FakeRefund = {
      refundRef: randomId("fre_"),
      paymentRef: input.paymentRef,
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      refundId: input.refundId,
      createdAt: new Date().toISOString(),
      // A credit note splits the refund between tax and net in proportion, as Stripe's does.
      ...(invoiceTax
        ? { tax: Math.round((invoiceTax.amount * input.amount) / invoiceTax.paid) }
        : {}),
    };
    kv.put(REFUND + refund.refundRef, refund);
    kv.put(REFUND_BY_ID + input.refundId, refund.refundRef);
    this.#prune<FakeRefund>(REFUND, MAX_REFUNDS, (row) => kv.delete(REFUND_BY_ID + row.refundId));
    return { ok: true, refund, created: true };
  }

  /** Everything the ledger holds, for the dev `/fake/state` route and tests. */
  async state(): Promise<FakeLedgerState> {
    const kv = this.ctx.storage.kv;
    return {
      checkouts: [...kv.list<FakeCheckout>({ prefix: CHECKOUT })].map(([, row]) => row),
      refunds: [...kv.list<FakeRefund>({ prefix: REFUND })].map(([, row]) => row),
      subscriptions: this.#subscriptions(),
    };
  }

  // --- Subscriptions (stage 32a, ADR 0485) ----------------------------------------------------

  /** Opens a subscription checkout, or returns the one opened before under the same key. */
  async createSubscriptionCheckout(
    input: PaymentsSubscriptionCheckoutInput,
  ): Promise<FakeCheckout> {
    const kv = this.ctx.storage.kv;
    const existingRef = kv.get<string>(IDEMPOTENCY + input.idempotencyKey);
    if (existingRef !== undefined) {
      const existing = kv.get<FakeCheckout>(CHECKOUT + existingRef);
      if (existing) return existing;
    }
    const now = Date.now();
    const ref = randomId("fcs_");
    const checkout: FakeCheckout = {
      ref,
      orderId: input.subscriptionId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      returnUrl: input.returnUrl,
      status: "open",
      paymentRef: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHECKOUT_LIFETIME_MS).toISOString(),
      paidAmount: null,
      subscription: {
        subscriptionId: input.subscriptionId,
        interval: input.interval,
        customerRef: input.customerRef ?? null,
        trialDays: input.trialDays ?? null,
        trialEnd: input.trialEnd ?? null,
        taxCode: input.tax?.taxCode ?? null,
        ref: null,
      },
    };
    kv.put(CHECKOUT + ref, checkout);
    kv.put(IDEMPOTENCY + input.idempotencyKey, ref);
    return checkout;
  }

  async getSubscription(ref: string): Promise<FakeSubscription | null> {
    return this.ctx.storage.kv.get<FakeSubscription>(SUBSCRIPTION + ref) ?? null;
  }

  /** Sets a subscription to end at its period's end (or now), or undoes that. */
  async changeSubscription(
    ref: string,
    change: "period_end" | "now" | "resume",
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(ref);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      return { ok: false, reason: "the subscription has ended" };
    }
    const now = this.#tick();
    if (change === "now") {
      Object.assign(sub, {
        status: "canceled",
        canceledAt: now,
        endedAt: now,
        endReason: "cancellation_requested",
      });
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("deleted", sub)] };
    }
    const ending = change === "period_end";
    if (sub.cancelAtPeriodEnd === ending) return { ok: true, deliveries: [] };
    sub.cancelAtPeriodEnd = ending;
    sub.canceledAt = ending ? now : null;
    sub.endReason = ending ? "cancellation_requested" : null;
    this.#putSubscription(sub);
    return { ok: true, deliveries: [this.#delivery("updated", sub)] };
  }

  /**
   * A new price (stage 32b, ADR 0530). `now`: the rest of the period is invoiced at once, prorated
   * on the time left, and the price changes only once that invoice is paid (Stripe's pending
   * update); a decline leaves the old price and an open invoice. `next_period`: the price changes
   * now and is charged from the next invoice, nothing prorated (Stripe's `proration_behavior=none`).
   */
  async changePrice(
    input: PaymentsChangeSubscriptionInput,
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(input.subscriptionRef);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    if (sub.status !== "active") return { ok: false, reason: `the subscription is ${sub.status}` };
    // As Stripe's host-made schedule with a pause still to come refuses it (review of 32b).
    if (sub.pauseAt) return { ok: false, reason: "a pause is scheduled" };
    if (input.currency !== sub.currency || input.interval !== sub.interval) {
      return { ok: false, reason: "the currency and interval stay the subscription's" };
    }
    const now = this.#tick();
    if (input.when === "next_period") {
      sub.amount = input.amount;
      sub.pendingAmount = null;
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("updated", sub)] };
    }
    if (sub.invoices.some((invoice) => invoice.status === "open")) {
      return { ok: false, reason: "an invoice is still open" };
    }
    const start = Date.parse(sub.currentPeriodStart);
    const end = Date.parse(sub.currentPeriodEnd);
    const left = Math.max(0, end - Date.parse(now)) / Math.max(1, end - start);
    const invoice = this.#invoice(sub, "subscription_update");
    invoice.amountDue = Math.max(0, Math.round((input.amount - sub.amount) * left));
    invoice.periodStart = now;
    sub.invoices.push(invoice);
    if (sub.declines) {
      invoice.attemptCount = 1;
      sub.pendingAmount = input.amount;
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("invoice_payment_failed", sub, invoice)] };
    }
    this.#settle(sub, invoice);
    sub.amount = input.amount;
    sub.pendingAmount = null;
    this.#putSubscription(sub);
    return {
      ok: true,
      deliveries: [this.#delivery("updated", sub), this.#delivery("invoice_paid", sub, invoice)],
    };
  }

  /**
   * The provider's pause (stage 32b, ADR 0531): refused on trial, unpaid, paused, incomplete or
   * ended, as Stripe's. Now: `paused` at once, the period cut at the pause and its unused time
   * credited on the resumption invoice. Later: scheduled, nothing changes until `pause_starts`.
   */
  async pause(
    input: PaymentsPauseSubscriptionInput,
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(input.subscriptionRef);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    if (sub.status !== "active" && sub.status !== "past_due") {
      return { ok: false, reason: `a ${sub.status} subscription cannot be paused` };
    }
    if (sub.pauseAt || sub.resumeAt) return { ok: false, reason: "a pause is already scheduled" };
    sub.resumeAt = input.until;
    if (input.from) {
      sub.pauseAt = input.from;
      this.#tick();
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("updated", sub)] };
    }
    this.#startPause(sub);
    this.#putSubscription(sub);
    return { ok: true, deliveries: [this.#delivery("paused", sub)] };
  }

  /** Cancels an upgrade's pending update: voids its open invoice; refused when none is pending. */
  async voidUpdate(
    input: PaymentsVoidUpdateInput,
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(input.subscriptionRef);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    // Nothing pending: nothing left to void (round three).
    if (!sub.pendingAmount) return { ok: true, deliveries: [] };
    const open = sub.invoices.find(
      (invoice) => invoice.status === "open" && invoice.billingReason === "subscription_update",
    );
    if (sub.status !== "active" || !open) {
      return { ok: false, reason: "the pending update is not an active subscription's upgrade" };
    }
    sub.invoices = sub.invoices.filter((invoice) => invoice !== open);
    sub.pendingAmount = null;
    this.#tick();
    this.#putSubscription(sub);
    return { ok: true, deliveries: [this.#delivery("updated", sub)] };
  }

  /** Ends a pause now, or withdraws one that has not started. */
  async unpause(
    input: PaymentsUnpauseSubscriptionInput,
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(input.subscriptionRef);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    if (sub.status !== "paused") {
      if (!sub.pauseAt) return { ok: false, reason: "the subscription is not paused" };
      sub.pauseAt = null;
      sub.resumeAt = null;
      this.#tick();
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("updated", sub)] };
    }
    return { ok: true, deliveries: this.#endPause(sub, this.#tick()) };
  }

  #startPause(sub: FakeSubscription): void {
    const now = this.#tick();
    const start = Date.parse(sub.currentPeriodStart);
    const end = Date.parse(sub.currentPeriodEnd);
    const left = Math.max(0, end - Date.parse(now)) / Math.max(1, end - start);
    sub.pauseCredit = Math.round(sub.amount * left);
    sub.status = "paused";
    sub.pauseAt = null;
    sub.currentPeriodEnd = now;
  }

  /** The pause ends at `at`: a new period from then, charged less the credit for the paused one. */
  #endPause(sub: FakeSubscription, at: string): FakeWebhookBody[] {
    sub.currentPeriodStart = at;
    sub.currentPeriodEnd = addInterval(at, sub.interval);
    sub.resumeAt = null;
    const invoice = this.#invoice(sub, "subscription_cycle");
    invoice.amountDue = Math.max(0, sub.amount - (sub.pauseCredit ?? 0));
    sub.pauseCredit = 0;
    sub.invoices.push(invoice);
    if (sub.declines) {
      // Stripe's resume_on_payment_success: a resumption whose payment fails stays paused.
      invoice.attemptCount = 1;
      invoice.status = "open";
      this.#putSubscription(sub);
      return [this.#delivery("invoice_payment_failed", sub, invoice)];
    }
    this.#settle(sub, invoice);
    this.#putSubscription(sub);
    return [this.#delivery("resumed", sub), this.#delivery("invoice_paid", sub, invoice)];
  }

  /** Moves a subscription's schedule on by one step (tests and development only). */
  async stepSubscription(
    ref: string,
    step: FakeSubscriptionStep,
  ): Promise<{ ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string }> {
    const sub = await this.getSubscription(ref);
    if (!sub) return { ok: false, reason: "no subscription has that reference" };
    if (sub.status === "canceled") return { ok: false, reason: "the subscription has ended" };
    const open = sub.invoices.find((invoice) => invoice.status === "open");
    const out: FakeWebhookBody[] = [];
    if (step === "trial_will_end") {
      if (sub.status !== "trialing") return { ok: false, reason: "not trialing" };
      this.#tick();
      return { ok: true, deliveries: [this.#delivery("trial_will_end", sub)] };
    }
    if (step === "card_declines" || step === "card_works") {
      sub.declines = step === "card_declines";
      this.#putSubscription(sub);
      return { ok: true, deliveries: [] };
    }
    if (step === "pause_starts") {
      if (!sub.pauseAt) return { ok: false, reason: "no pause is scheduled" };
      this.#startPause(sub);
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("paused", sub)] };
    }
    if (step === "pause_ends") {
      if (sub.status !== "paused" || !sub.resumeAt) return { ok: false, reason: "not paused" };
      const at = sub.resumeAt;
      this.#tick();
      return { ok: true, deliveries: this.#endPause(sub, at) };
    }
    if (sub.status === "paused") return { ok: false, reason: "the subscription is paused" };
    if (step === "give_up") {
      const now = this.#tick();
      Object.assign(sub, {
        status: "canceled",
        canceledAt: now,
        endedAt: now,
        endReason: "payment_failed",
      });
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("deleted", sub)] };
    }
    if (step === "retry_fail" || step === "recover") {
      if (!open) return { ok: false, reason: "no invoice is open" };
      this.#tick();
      if (step === "retry_fail") {
        open.attemptCount += 1;
        this.#putSubscription(sub);
        return { ok: true, deliveries: [this.#delivery("invoice_payment_failed", sub, open)] };
      }
      this.#settle(sub, open);
      // An upgrade's pending update applies once its charge is paid.
      if (open.billingReason === "subscription_update" && sub.pendingAmount) {
        sub.amount = sub.pendingAmount;
        sub.pendingAmount = null;
      }
      this.#putSubscription(sub);
      out.push(this.#delivery("updated", sub), this.#delivery("invoice_paid", sub, open));
      return { ok: true, deliveries: out };
    }
    // renew, fail, action_required: the period ends.
    if (open) return { ok: false, reason: "an invoice is still open" };
    const end = sub.currentPeriodEnd;
    this.#tick();
    if (sub.cancelAtPeriodEnd) {
      Object.assign(sub, { status: "canceled", endedAt: end });
      this.#putSubscription(sub);
      return { ok: true, deliveries: [this.#delivery("deleted", sub)] };
    }
    sub.currentPeriodStart = end;
    sub.currentPeriodEnd = addInterval(end, sub.interval);
    const invoice = this.#invoice(sub, "subscription_cycle");
    sub.invoices.push(invoice);
    if (step === "renew" && !sub.declines) {
      this.#settle(sub, invoice);
      this.#putSubscription(sub);
      out.push(this.#delivery("updated", sub), this.#delivery("invoice_paid", sub, invoice));
      return { ok: true, deliveries: out };
    }
    invoice.attemptCount = 1;
    sub.status = "past_due";
    if (step === "action_required") {
      invoice.hostedUrl = `https://fake-provider.invalid/invoice/${invoice.ref}`;
    }
    this.#putSubscription(sub);
    out.push(
      this.#delivery("updated", sub),
      this.#delivery(
        step === "action_required" ? "invoice_action_required" : "invoice_payment_failed",
        sub,
        invoice,
      ),
    );
    return { ok: true, deliveries: out };
  }

  /** The subscription a submitted subscription checkout starts, and the events it sends. */
  #startSubscription(checkout: FakeCheckout, billingCountry: string | null): FakePayResult {
    const plan = checkout.subscription as FakeSubscriptionCheckout;
    const now = this.#tick();
    const trialEnd = plan.trialEnd
      ? plan.trialEnd
      : plan.trialDays
        ? new Date(Date.parse(now) + plan.trialDays * 86_400_000).toISOString()
        : null;
    const sub: FakeSubscription = {
      ref: randomId("fsub_"),
      customerRef: plan.customerRef ?? randomId("fcus_"),
      subscriptionId: plan.subscriptionId,
      status: trialEnd ? "trialing" : "active",
      amount: checkout.amount,
      currency: checkout.currency,
      interval: plan.interval,
      cancelAtPeriodEnd: false,
      trialEnd,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd ?? addInterval(now, plan.interval),
      canceledAt: null,
      endedAt: null,
      endReason: null,
      taxCode: plan.taxCode,
      billingCountry,
      createdAt: now,
      invoices: [],
    };
    // The first invoice: nothing to pay during a trial (Stripe makes one for zero), else the
    // first period, paid on the page.
    const first = this.#invoice(sub, "subscription_create");
    if (trialEnd) {
      first.amountDue = 0;
      first.tax = sub.taxCode ? { amount: 0, country: billingCountry } : null;
      first.status = "paid";
      first.periodEnd = trialEnd;
    } else {
      this.#settle(sub, first);
    }
    sub.invoices.push(first);
    this.#putSubscription(sub);
    const paid: FakeCheckout = {
      ...checkout,
      status: "paid",
      paymentRef: first.paymentRef,
      subscription: { ...plan, ref: sub.ref },
      ...(billingCountry ? { billingCountry } : {}),
    };
    this.ctx.storage.kv.put(CHECKOUT + checkout.ref, paid);
    return {
      found: true,
      checkout: paid,
      newlyPaid: true,
      deliveries: [
        this.#delivery("checkout_completed", sub),
        this.#delivery("invoice_paid", sub, first),
      ],
    };
  }

  /** A new invoice for the subscription's current period, open, asking for its price. */
  #invoice(sub: FakeSubscription, billingReason: string): FakeInvoice {
    return {
      ref: randomId("fin_"),
      status: "open",
      amountPaid: 0,
      amountDue: sub.amount,
      paymentRef: null,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      billingReason,
      attemptCount: 0,
      hostedUrl: null,
      tax: null,
    };
  }

  /** Pays an invoice in full, with the tax the fake calculates, and makes the subscription active. */
  #settle(sub: FakeSubscription, invoice: FakeInvoice): void {
    invoice.status = "paid";
    invoice.amountPaid = invoice.amountDue;
    invoice.attemptCount += 1;
    invoice.paymentRef = randomId("fpi_");
    invoice.hostedUrl = null;
    if (sub.taxCode) {
      const country = sub.billingCountry;
      const rate =
        sub.taxCode === NONTAXABLE_TAX_CODE ? 0 : (FAKE_TAX_REGISTRATIONS[country ?? ""] ?? 0);
      invoice.tax = { amount: inclusiveTax(invoice.amountPaid, rate), country };
    }
    sub.status = "active";
  }

  #delivery(
    trigger: PaymentsSubscriptionTrigger,
    sub: FakeSubscription,
    invoice?: FakeInvoice,
  ): FakeWebhookBody {
    const kv = this.ctx.storage.kv;
    const n = (kv.get<number>(EVENT_COUNTER) ?? 0) + 1;
    kv.put(EVENT_COUNTER, n);
    return {
      id: `fevt_sub_${n}_${sub.ref}`,
      type: "subscription.event",
      created: Math.floor(Date.now() / 1000),
      data: {
        trigger,
        subscription: fakeSubscriptionRead(sub, this.#last()),
        ...(invoice ? { invoice: fakeInvoiceRead(sub, invoice) } : {}),
      },
    };
  }

  #subscriptions(): FakeSubscription[] {
    return [...this.ctx.storage.kv.list<FakeSubscription>({ prefix: SUBSCRIPTION })].map(
      ([, row]) => row,
    );
  }

  #putSubscription(sub: FakeSubscription): void {
    this.ctx.storage.kv.put(SUBSCRIPTION + sub.ref, sub);
  }

  /** The ledger's clock: never goes back, and moves on at every change, so reads are ordered. */
  #tick(): string {
    const kv = this.ctx.storage.kv;
    const at = Math.max(Date.now(), (kv.get<number>(CLOCK) ?? 0) + 1);
    kv.put(CLOCK, at);
    return new Date(at).toISOString();
  }

  #last(): string {
    return new Date(this.ctx.storage.kv.get<number>(CLOCK) ?? Date.now()).toISOString();
  }

  /** Keeps the newest `max` rows under `prefix`, by `createdAt`. */
  #prune<Row extends { createdAt: string }>(
    prefix: string,
    max: number,
    alsoForget: (row: Row) => void,
  ): void {
    const kv = this.ctx.storage.kv;
    const rows = [...kv.list<Row>({ prefix })];
    if (rows.length <= max) return;
    rows.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    for (const [key, row] of rows.slice(0, rows.length - max)) {
      kv.delete(key);
      alsoForget(row);
    }
  }
}

export function fakeLedger(env: Cloudflare.Env): DurableObjectStub<FakePaymentsLedger> {
  return env.FAKE_PAYMENTS.get(env.FAKE_PAYMENTS.idFromName("fake"));
}

/** What the fake provider posts to `/in/fake`. */
export type FakeWebhookBody =
  | {
      id: string;
      type: "payment.succeeded";
      created: number;
      data: {
        orderId: string;
        checkoutRef: string;
        amount: number;
        currency: string;
        paymentRef: string | null;
        /** A taxed checkout's tax, as the provider calculated it. */
        tax?: PaymentsTaxReport;
      };
    }
  | {
      id: string;
      type: "refund.succeeded";
      created: number;
      data: {
        orderId: string | null;
        refundId: string | null;
        refundRef: string;
        paymentRef: string | null;
        amount: number;
        currency: string;
        /** A period's refund credited on its invoice: the tax it gave back. */
        tax?: number;
      };
    }
  | {
      id: string;
      type: "subscription.event";
      created: number;
      data: {
        trigger: PaymentsSubscriptionTrigger;
        subscription: PaymentsSubscription;
        invoice?: PaymentsInvoice;
      };
    };

export type FakeProviderOptions = {
  ledger: DurableObjectStub<FakePaymentsLedger>;
  /** The public base, for the hosted page URL. */
  baseUrl: string;
  webhookSecret: string;
  /** Posts a signed delivery to the gatekeeper's own `/in/fake` route, in process. */
  deliver(body: FakeWebhookBody): Promise<void>;
  /** Runs work after the current call returns (a Durable Object's `ctx.waitUntil`). */
  defer(work: Promise<unknown>): void;
};

export class FakeProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly #options: FakeProviderOptions;

  constructor(options: FakeProviderOptions) {
    this.#options = options;
  }

  async createCheckout(
    input: CheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const checkout = await this.#options.ledger.createCheckout(input);
    return {
      ref: checkout.ref,
      url: fakePayUrl(this.#options.baseUrl, checkout.ref),
      expiresAt: checkout.expiresAt,
    };
  }

  async getPayment(ref: string): Promise<PaymentsPayment> {
    const checkout = await this.#options.ledger.getCheckout(ref);
    if (!checkout) throw new Error("The fake provider has no checkout with that reference.");
    return checkoutToPayment(checkout);
  }

  /** Records the refund, then confirms it by webhook once this call has returned. */
  async refund(
    input: RefundInput,
  ): Promise<{ refundRef: string; status: "pending" | "succeeded" }> {
    const result = await this.#options.ledger.refund(input);
    if (!result.ok) {
      throw new ActionApplyError(
        `The fake provider refused the refund, so nothing was refunded: ${result.reason}.`,
      );
    }
    const { refund } = result;
    if (result.created) {
      const delivery = this.#options.deliver({
        id: `fevt_refund_${refund.refundRef}`,
        type: "refund.succeeded",
        created: Math.floor(Date.now() / 1000),
        data: {
          orderId: refund.orderId,
          refundId: refund.refundId,
          refundRef: refund.refundRef,
          paymentRef: refund.paymentRef,
          amount: refund.amount,
          currency: refund.currency,
          ...(refund.tax !== undefined ? { tax: refund.tax } : {}),
        },
      });
      this.#options.defer(
        delivery.catch(() => console.warn("payments: the fake refund webhook was not accepted")),
      );
    }
    return { refundRef: refund.refundRef, status: "pending" };
  }

  async createSubscriptionCheckout(
    input: PaymentsSubscriptionCheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const checkout = await this.#options.ledger.createSubscriptionCheckout(input);
    return {
      ref: checkout.ref,
      url: fakePayUrl(this.#options.baseUrl, checkout.ref),
      expiresAt: checkout.expiresAt,
    };
  }

  async getSubscription(ref: string): Promise<PaymentsSubscription> {
    const sub = await this.#options.ledger.getSubscription(ref);
    if (!sub) throw new Error("The fake provider has no subscription with that reference.");
    return fakeSubscriptionRead(sub, new Date().toISOString());
  }

  async getSubscriptionCheckout(ref: string): Promise<"open" | "complete" | "expired"> {
    const checkout = await this.#options.ledger.getCheckout(ref);
    if (!checkout?.subscription) {
      throw new Error("The fake provider has no subscription checkout with that reference.");
    }
    if (checkout.status === "paid") return "complete";
    return Date.parse(checkout.expiresAt) < Date.now() ? "expired" : "open";
  }

  async cancelSubscription(input: PaymentsCancelSubscriptionInput): Promise<void> {
    await this.#change(input.subscriptionRef, input.when);
  }

  async resumeSubscription(input: PaymentsResumeSubscriptionInput): Promise<void> {
    await this.#change(input.subscriptionRef, "resume");
  }

  async changeSubscription(input: PaymentsChangeSubscriptionInput): Promise<void> {
    await this.#send(await this.#options.ledger.changePrice(input));
  }

  async pauseSubscription(input: PaymentsPauseSubscriptionInput): Promise<void> {
    await this.#send(await this.#options.ledger.pause(input));
  }

  async unpauseSubscription(input: PaymentsUnpauseSubscriptionInput): Promise<void> {
    await this.#send(await this.#options.ledger.unpause(input));
  }

  async voidPendingUpdate(input: PaymentsVoidUpdateInput): Promise<void> {
    await this.#send(await this.#options.ledger.voidUpdate(input));
  }

  async openPortal(input: PaymentsPortalInput): Promise<{ url: string }> {
    return { url: `${this.#options.baseUrl}/fake/portal/${encodeURIComponent(input.customerRef)}` };
  }

  /** Changes the subscription, then confirms it by webhook once this call has returned. */
  async #change(ref: string, change: "period_end" | "now" | "resume"): Promise<void> {
    await this.#send(await this.#options.ledger.changeSubscription(ref, change));
  }

  /** Throws a refusal as nothing changed; otherwise delivers its events once this call returns. */
  async #send(
    result: { ok: true; deliveries: FakeWebhookBody[] } | { ok: false; reason: string },
  ): Promise<void> {
    if (!result.ok) {
      throw new ActionApplyError(
        `The fake provider refused the change, so nothing changed: ${result.reason}.`,
      );
    }
    const deliveries = result.deliveries;
    const send = async () => {
      for (const body of deliveries) await this.#options.deliver(body);
    };
    this.#options.defer(
      send().catch(() => console.warn("payments: the fake subscription webhook was not accepted")),
    );
  }

  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook> {
    return verifyFakeWebhook(this.#options.webhookSecret, headers, body, nowSeconds);
  }
}

export function fakePayUrl(baseUrl: string, ref: string): string {
  return `${baseUrl}/fake/pay/${ref}`;
}

export function checkoutToPayment(checkout: FakeCheckout): PaymentsPayment {
  const expired = checkout.status === "open" && Date.parse(checkout.expiresAt) < Date.now();
  return {
    provider: "fake",
    ref: checkout.ref,
    status: checkout.status === "paid" ? "paid" : expired ? "expired" : "open",
    orderId: checkout.orderId,
    amount: checkout.amount,
    currency: checkout.currency,
    paymentRef: checkout.paymentRef,
  };
}

function field(data: Record<string, unknown>, name: string): unknown {
  return data[name];
}

function idOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value) ? value : undefined;
}

/** Verifies a fake provider delivery and maps the event it carries. */
export async function verifyFakeWebhook(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const check = await verifySignatureHeader(secret, headers["x-fake-signature"], body, nowSeconds);
  if (!check.ok) return check;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  const event = mapFakeEvent(parsed);
  if (!event) return { ok: false, reason: "malformed body" };
  return { ok: true, eventId: event.eventId, events: [event] };
}

const minor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A tax report as delivered, or null when it is malformed. */
export function taxReportOf(value: unknown): PaymentsTaxReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { amount, country, lines } = value as Record<string, unknown>;
  if (!minor(amount) || !Array.isArray(lines) || lines.length > 100) return null;
  if (country !== null && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))) {
    return null;
  }
  const parsed: PaymentsTaxReport["lines"] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") return null;
    const { ref, amount: lineAmount } = line as Record<string, unknown>;
    const id = idOrNull(ref);
    if (!id || !minor(lineAmount)) return null;
    parsed.push({ ref: id, amount: lineAmount });
  }
  return { amount, country, lines: parsed };
}

/** The PaymentsEvent a fake delivery stands for, or null when it is malformed. */
export function mapFakeEvent(value: unknown): PaymentsEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const eventId = idOrNull(body.id);
  const data = body.data;
  if (!eventId || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  if (body.type === "subscription.event") {
    const created =
      typeof body.created === "number" && Number.isSafeInteger(body.created) && body.created >= 0
        ? body.created * 1000
        : Date.now();
    return subscriptionEvent(
      "fake",
      eventId,
      fields.trigger,
      fields.subscription,
      fields.invoice,
      new Date(created).toISOString(),
    );
  }
  const amount = field(fields, "amount");
  const currency = field(fields, "currency");
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return null;
  const created =
    typeof body.created === "number" && Number.isSafeInteger(body.created) && body.created >= 0
      ? body.created * 1000
      : Date.now();
  const occurredAt = new Date(created).toISOString();
  const paymentRef = idOrNull(field(fields, "paymentRef") ?? null);
  if (paymentRef === undefined) return null;

  if (body.type === "payment.succeeded") {
    const orderId = idOrNull(field(fields, "orderId"));
    const checkoutRef = idOrNull(field(fields, "checkoutRef"));
    if (!orderId || !checkoutRef) return null;
    const tax = field(fields, "tax");
    const report = tax === undefined ? undefined : taxReportOf(tax);
    if (report === null) return null;
    return {
      kind: "payment",
      provider: "fake",
      eventId,
      orderId,
      checkoutRef,
      amount,
      currency: currency.toUpperCase(),
      paymentRef,
      occurredAt,
      ...(report ? { tax: report } : {}),
    };
  }
  if (body.type === "refund.succeeded") {
    const orderId = idOrNull(field(fields, "orderId") ?? null);
    const refundId = idOrNull(field(fields, "refundId") ?? null);
    const refundRef = idOrNull(field(fields, "refundRef"));
    if (orderId === undefined || refundId === undefined || !refundRef) return null;
    const tax = field(fields, "tax");
    if (tax !== undefined && !minor(tax)) return null;
    return {
      ...(tax !== undefined ? { tax: { amount: tax as number } } : {}),
      kind: "refund",
      provider: "fake",
      eventId,
      orderId,
      refundId,
      refundRef,
      paymentRef,
      amount,
      currency: currency.toUpperCase(),
      occurredAt,
    };
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The fake hosted page: self-contained, no external assets, no card fields. */
export function fakePayPage(checkout: FakeCheckout, formattedAmount: string): string {
  const paid = checkout.status === "paid";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake payment page</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; background: #f6f6f4; color: #1d1d1b; }
  main { max-width: 26rem; margin: 0 auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  .amount { font-size: 2rem; font-weight: 600; margin: 0.5rem 0 1rem; }
  .note { color: #666; font-size: 0.85rem; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 6px; border: 1px solid #1d1d1b; cursor: pointer; }
  button.pay { background: #1d1d1b; color: #fff; }
  button.cancel { background: #fff; color: #1d1d1b; }
</style>
</head>
<body>
<main>
  <h1>Fake payment page</h1>
  <p>${escapeHtml(checkout.description)}</p>
  <p class="amount">${escapeHtml(formattedAmount)}${checkout.subscription ? ` every ${escapeHtml(checkout.subscription.interval)}` : ""}</p>
  ${checkout.subscription?.trialEnd || checkout.subscription?.trialDays ? `<p class="note">Nothing is charged until ${escapeHtml(checkout.subscription.trialEnd?.slice(0, 10) ?? `${checkout.subscription.trialDays} days from now`)}.</p>` : ""}
  ${paid ? '<p class="note">This checkout is already paid.</p>' : ""}
  ${checkout.tax || checkout.subscription?.taxCode ? '<p class="note">Prices include tax, worked out from your billing address.</p>' : ""}
  <div class="actions">
    <form method="post">
      <input type="hidden" name="outcome" value="pay">
      ${
        checkout.tax || checkout.subscription?.taxCode
          ? `<label>Billing country <select name="country" required><option value="">Choose…</option>${FAKE_BILLING_COUNTRIES.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></label>`
          : ""
      }
      <button type="submit" class="pay">Pay</button>
    </form>
    <form method="post">
      <input type="hidden" name="outcome" value="cancel">
      <button type="submit" class="cancel">Cancel</button>
    </form>
  </div>
  <p class="note">A development stand-in for a payment provider. No card details are asked for or stored.</p>
</main>
</body>
</html>`;
}
