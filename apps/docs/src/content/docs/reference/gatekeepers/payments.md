---
title: "payments"
description: "Gatekeeper Worker for payments: opens the provider's hosted checkout, submits refunds as approval-queue actions and delivers verified payment events to a bound hook."
editUrl: false
---

Gatekeeper Worker for payments: opens the provider's hosted checkout, submits refunds as approval-queue actions and delivers verified payment events to a bound hook.

|  |  |
| --- | --- |
| Package | `@composable-os/gatekeeper-payments` |
| Host module | none: a library or contract other gatekeepers use |
| Deployed as a Worker | yes |
| Source | [packages/gatekeeper-payments](https://github.com/timoconnellaus/composable-os/tree/main/packages/gatekeeper-payments) |

## The contract

The types extension code sees (`packages/gatekeeper-payments/src/types.d.ts`):

```ts
// The agent- and host-facing types of the payments gatekeeper, served by getTypeScriptTypes().
// Self-contained: no imports.

/** The payment provider a payment account uses. */
export type PaymentsProviderName = "stripe" | "fake";

/** What `createCheckout()` takes. */
export interface PaymentsCheckoutInput {
  /** The host's order id (e.g. `ord_…`): 1 to 64 characters of `[A-Za-z0-9_-]`. */
  orderId: string;
  /** A positive safe integer, in the currency's minor unit (cents for AUD). */
  amount: number;
  /** ISO 4217, three letters. Reported in upper case. */
  currency: string;
  /** 1 to 200 characters, shown on the provider's page. */
  description: string;
  /**
   * Where the provider's page sends the customer back, paid or not: an absolute https URL, or
   * http://localhost or http://127.0.0.1 on any port. At most 2000 characters.
   */
  returnUrl: string;
  /** Prefills the customer's email on the provider's page. */
  customerEmail?: string;
  /** 1 to 200 characters. The same key opens no second checkout. */
  idempotencyKey: string;
  /**
   * Asks the provider to calculate tax inside the amount (Stripe Tax). Left out, the checkout is
   * one line of `amount` with no tax settings, exactly as without tax. Given, the provider's page
   * requires the buyer's billing address, because the buyer's location sets the rate.
   */
  tax?: PaymentsCheckoutTax;
}

/** Tax at checkout: the lines the amount is made of, each with its product tax code. */
export interface PaymentsCheckoutTax {
  /**
   * Prices are tax-inclusive: what the buyer pays is the amount, and the provider works out the
   * tax inside it. The only behaviour offered.
   */
  behavior: "inclusive";
  /** 1 to 50 lines whose amounts sum to the checkout's amount. */
  lines: PaymentsTaxLine[];
}

/** One line of a taxed checkout: a share of the amount, at its own product tax code. */
export interface PaymentsTaxLine {
  /** The host's id for the line (an order line id): 1 to 64 characters of `[A-Za-z0-9_-]`. */
  ref: string;
  /** 1 to 200 characters, shown on the provider's page. */
  name: string;
  /** A positive safe integer, minor units, tax included. */
  amount: number;
  /** The provider's product tax code: `txcd_` and eight digits (Stripe's list). */
  taxCode: string;
  /**
   * Where the service is supplied, for admission to an in-person event: the provider taxes the
   * line where the event is, not where the buyer lives (Stripe: a performance location).
   */
  place?: PaymentsTaxPlace;
}

/** An event's address for tax. */
export interface PaymentsTaxPlace {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** A state, province or region, 1 to 100 characters. */
  region?: string;
  /** 1 to 20 characters. */
  postcode?: string;
  /** 1 to 100 characters. */
  city?: string;
  /** The street address, 1 to 200 characters. */
  line1?: string;
}

/** The tax the provider calculated on a payment. Never recalculated by the host. */
export interface PaymentsTaxReport {
  /** The tax inside the payment's amount, minor units. Zero where the org collects none. */
  amount: number;
  /** The country the tax was charged for (ISO 3166-1 alpha-2, upper case), or null. */
  country: string | null;
  /** Each line's tax, by the `ref` the checkout sent. */
  lines: { ref: string; amount: number }[];
}

/** An open checkout on the provider's hosted page. */
export interface PaymentsCheckout {
  provider: PaymentsProviderName;
  /** The provider's checkout reference (a Stripe Checkout Session id). */
  ref: string;
  /** The provider's hosted page to send the customer to. */
  url: string;
  /** When the checkout stops accepting payment, ISO 8601, if the provider says. */
  expiresAt: string | null;
}

/** One checkout as the provider reports it. */
export interface PaymentsPayment {
  provider: PaymentsProviderName;
  ref: string;
  status: "open" | "paid" | "expired";
  orderId: string | null;
  /** Minor units. */
  amount: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** The provider's payment reference (a Stripe PaymentIntent id) once paid, else null. */
  paymentRef: string | null;
}

/** What `refund()` takes. */
export interface PaymentsRefundInput {
  orderId: string;
  /** The provider's payment reference the refund goes back to (a Stripe PaymentIntent id). */
  paymentRef: string;
  /** A positive safe integer, minor units. */
  amount: number;
  currency: string;
  /** 1 to 500 characters: staff's words, shown to the approver. */
  reason: string;
  /** The host's id for this refund (1 to 64 characters), sent as metadata and idempotency key. */
  refundId: string;
  /**
   * A subscription period's invoice the payment paid (`in_…`). Given, the refund is also credited
   * on that invoice (a credit note), so the provider's tax report gives back the tax with it and
   * says how much (ADR 0486).
   */
  invoiceRef?: string;
}

/** How often a subscription is charged. */
export type PaymentsInterval = "week" | "month" | "year";

/**
 * What `createSubscriptionCheckout()` takes (stage 32a, ADR 0485): the provider's own page, which
 * takes the card and starts a subscription the provider then charges every period. The host prices
 * it from the plan; the provider runs the schedule.
 */
export interface PaymentsSubscriptionCheckoutInput {
  /** The host's id for the subscription (`sbs_…`), carried on the provider's subscription. */
  subscriptionId: string;
  /** The price of one period, a positive safe integer of minor units, tax included. */
  amount: number;
  /** ISO 4217, three letters. */
  currency: string;
  interval: PaymentsInterval;
  /** The plan's title, 1 to 200 characters, shown on the provider's page and invoices. */
  description: string;
  /** As for a checkout: https, or http on localhost. */
  returnUrl: string;
  /** Prefills the payer's email when no provider customer is named. */
  customerEmail?: string;
  /** The provider's customer to bill, when the payer already has one (`cus_…`). */
  customerRef?: string;
  /**
   * A free first period of this many days (1 to 730), with the card taken first. The provider's
   * first charge is when it ends. Not with `trialEnd`.
   */
  trialDays?: number;
  /**
   * Free until this moment (ISO 8601), with the card taken first: a continuation's paid-up date.
   * At least 48 hours ahead (Stripe's rule for Checkout). Not with `trialDays`.
   */
  trialEnd?: string;
  /** 1 to 200 characters. The same key opens no second checkout. */
  idempotencyKey: string;
  /** Tax on every period, inside the price (Stripe Tax). Left out, nothing about tax is sent. */
  tax?: { behavior: "inclusive"; taxCode: string };
}

/** A subscription's state as the provider has it. */
export type PaymentsSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "canceled";

/** A subscription as the provider reported it when it was read. Times ISO 8601. */
export interface PaymentsSubscription {
  provider: PaymentsProviderName;
  /** The provider's subscription reference (`sub_…`). */
  ref: string;
  /** The provider's customer, the payer (`cus_…`). */
  customerRef: string | null;
  /** The host's id the checkout gave it, or null when it carries none. */
  subscriptionId: string | null;
  status: PaymentsSubscriptionStatus;
  /** One period's price, minor units. */
  amount: number;
  currency: string;
  interval: PaymentsInterval | null;
  /** Whether it is set to end when the current period ends (`cancel_at_period_end`). */
  cancelAtPeriodEnd: boolean;
  /**
   * A date it is set to end on, set some other way (Stripe's `cancel_at`, from its dashboard or a
   * schedule), or null. Resuming undoes only `cancelAtPeriodEnd`.
   */
  cancelAt: string | null;
  trialEnd: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  endedAt: string | null;
  /** Why it ended or is ending, in the provider's words (`cancellation_requested`, `payment_failed`, …). */
  endReason: string | null;
  /** When the gatekeeper read it: later reads supersede earlier ones. */
  observedAt: string;
}

/** One invoice of a subscription, as the provider reported it. */
export interface PaymentsInvoice {
  /** The provider's invoice reference (`in_…`). */
  ref: string;
  status: string;
  /** What was paid on it, minor units (zero for a trial's invoice). */
  amountPaid: number;
  /** What it asks for, minor units. */
  amountDue: number;
  currency: string;
  /** The payment the money came in on (a Stripe PaymentIntent), for a refund; null when none. */
  paymentRef: string | null;
  /** The period it pays for. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Why it was made: `subscription_create`, `subscription_cycle`, … */
  billingReason: string | null;
  /** How many times the provider has tried to collect it. */
  attemptCount: number;
  /** When the provider tries again, or null when it will not. */
  nextAttemptAt: string | null;
  /** The provider's page where the payer can pay or confirm it (3D Secure). */
  hostedUrl: string | null;
  /** The provider's tax inside `amountPaid`, when it calculated tax on the invoice. */
  tax?: { amount: number; country: string | null };
}

/** What `cancelSubscription()` takes. */
export interface PaymentsCancelSubscriptionInput {
  /** The host's id, for the approver and the provider's records. */
  subscriptionId: string;
  /** The provider's subscription reference. */
  subscriptionRef: string;
  /** `period_end`: it ends when the paid period does. `now`: it ends at once, nothing refunded. */
  when: "period_end" | "now";
  /** 1 to 500 characters, shown to the approver. */
  reason: string;
  /**
   * A caller's key for this one ask (a cooling off's ask, stage 44 step 7): each new key is a new
   * request to the provider, the same key a retry of it. Left out, one key per subscription and
   * `when` (staff's "end it now").
   */
  askKey?: string;
}

/** What `resumeSubscription()` takes: undo a cancellation at the period's end before it happens. */
export interface PaymentsResumeSubscriptionInput {
  subscriptionId: string;
  subscriptionRef: string;
}

/**
 * What `changeSubscription()` takes (stage 32b, ADR 0530): a new price for the subscription's one
 * item, from the plan the host priced. The interval and currency stay the subscription's.
 */
export interface PaymentsChangeSubscriptionInput {
  subscriptionId: string;
  subscriptionRef: string;
  /** The host's id for this change (`sbc_…`): one change is sent once, whatever retries. */
  changeId: string;
  /** The new price of one period, a positive safe integer of minor units, tax included. */
  amount: number;
  currency: string;
  interval: PaymentsInterval;
  /** The new plan's title, 1 to 200 characters, for the approver. */
  description: string;
  /**
   * `now`: an upgrade. The rest of the period is charged at once, prorated, and the change is
   * applied only once that charge is paid (a pending update); a charge that fails changes
   * nothing. `next_period`: a downgrade. Nothing is prorated or refunded; the new price is
   * charged from the next invoice.
   */
  when: "now" | "next_period";
  /** Whether the subscription was opened with tax: the new price is then tax-inclusive. */
  taxed: boolean;
  /** 1 to 500 characters, shown to the approver. */
  reason: string;
}

/**
 * What `pauseSubscription()` takes (stage 32b, ADR 0531): the provider's own pause (status
 * `paused`: no invoices, no access), from a moment (or now) until a moment, when the provider
 * resumes it and charges a new period. Never `pause_collection`, which keeps it active.
 */
export interface PaymentsPauseSubscriptionInput {
  subscriptionId: string;
  subscriptionRef: string;
  /** The host's id for this pause (`sbc_…`). */
  pauseId: string;
  /** When it starts (ISO 8601, ahead of now), or null: now. */
  from: string | null;
  /** When the provider resumes it (ISO 8601): after `from`, at most 366 days after it. */
  until: string;
  reason: string;
}

/** What `unpauseSubscription()` takes: end a pause now (or withdraw one not yet started). */
export interface PaymentsUnpauseSubscriptionInput {
  subscriptionId: string;
  subscriptionRef: string;
  pauseId: string;
  reason: string;
}

/** What `voidPendingUpdate()` takes: cancel an upgrade not yet paid (its pending update). */
export interface PaymentsVoidUpdateInput {
  subscriptionId: string;
  subscriptionRef: string;
  /** The host's id of the upgrade withdrawn (`sbc_…`). */
  changeId: string;
  reason: string;
}

/** A submitted change to a subscription: `pending` until the host applies it. */
export interface PaymentsSubscriptionChangeReceipt {
  status: "pending" | "sent";
  /** The action id in the approval queue. */
  id: number;
}

/** What `openPortal()` takes. */
export interface PaymentsPortalInput {
  /** The payer's provider customer. */
  customerRef: string;
  /** Where the portal's "back" link goes: https, or http on localhost. */
  returnUrl: string;
}

/** The provider's customer portal for one customer: card, billing details and invoices only. */
export interface PaymentsPortal {
  url: string;
}

/** A submitted refund: `pending` until the host applies it. */
export interface PaymentsRefundReceipt {
  status: "pending" | "sent";
  /** The action id in the approval queue. */
  id: number;
}

// --- In-person payments (stage 50, ADR 0774) ---------------------------------------------------
// A card reader belongs to the business's own payment account, at a location (an address the
// provider requires). The reader is driven from the server: the host asks for an amount on a named
// reader, the buyer taps or inserts their card, and the provider's webhook reports the payment.
// Card details never reach the host or this gatekeeper.

/** Where a reader is: the address the provider registers it at. */
export interface PaymentsReaderAddress {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** The street address, 1 to 200 characters. */
  line1: string;
  /** 1 to 100 characters. */
  city: string;
  /** 1 to 20 characters. */
  postcode: string;
  /** A state, province or region, 1 to 100 characters, where the country has them. */
  region?: string;
}

/**
 * What `registerReader()` takes: the code the reader shows, typed by an admin, the label it goes by
 * ("Front desk") and where it is. The host's own call only; submitted as an action a person
 * approves.
 */
export interface PaymentsRegisterReaderInput {
  /** The host's id for the reader (1 to 64 characters of `[A-Za-z0-9_-]`): one registration each. */
  readerId: string;
  /** The pairing code the reader shows, 1 to 100 characters of `[A-Za-z0-9-]`. */
  registrationCode: string;
  /** 1 to 64 characters, a single line. */
  label: string;
  /** The place's name at the provider (the business's), 1 to 100 characters. */
  locationName: string;
  address: PaymentsReaderAddress;
}

/** What `removeReader()` takes. The host's own call only; submitted as an action. */
export interface PaymentsRemoveReaderInput {
  readerId: string;
  /** The provider's reader reference (`tmr_…`). */
  readerRef: string;
  /** 1 to 500 characters, shown to the approver. */
  reason: string;
}

/** A reader as the provider has it. */
export interface PaymentsReader {
  provider: PaymentsProviderName;
  /** The provider's reader reference (`tmr_…`). */
  ref: string;
  /** The host's id the registration gave it, or null for a reader registered another way. */
  readerId: string | null;
  label: string;
  /** The provider's location reference, or null. */
  locationRef: string | null;
  /** Whether the provider can reach it now, when it says. */
  status: "online" | "offline" | null;
  /** The provider's device type, when it says. */
  deviceType: string | null;
}

/** A submitted reader registration or removal: `pending` until the host applies it. */
export interface PaymentsReaderChangeReceipt {
  status: "pending" | "sent";
  /** The action id in the approval queue. */
  id: number;
}

/**
 * What `presentPayment()` takes: one card-present payment of the order's amount, handed to a
 * reader. The host's own call only.
 */
export interface PaymentsPresentInput {
  /** The host's order id, carried in the payment's metadata (informational: the host matches on `ref`). */
  orderId: string;
  /** A positive safe integer, minor units. */
  amount: number;
  currency: string;
  /** 1 to 200 characters, on the provider's records. */
  description: string;
  /** The provider's reader reference. */
  readerRef: string;
  /**
   * 1 to 200 characters, one per presentation: the same key makes no second payment, so a retry
   * after a timeout charges once (Stripe keeps a key 24 hours). Sent again with another order,
   * amount or currency, it is refused.
   */
  idempotencyKey: string;
}

/** A payment presented on a reader. */
export interface PaymentsPresentation {
  provider: PaymentsProviderName;
  /**
   * The provider's payment reference (a Stripe PaymentIntent id). The payment event reports it as
   * both `checkoutRef` and `paymentRef`; a reader event names it as `checkoutRef`.
   */
  ref: string;
  readerRef: string;
  /** `presented`: on the reader, waiting for the card. `paid`: an earlier try with this key was paid. */
  status: "presented" | "paid";
}

/** A verified event from the provider. Currencies are upper case, times ISO 8601. */
export type PaymentsEvent =
  | {
      kind: "payment";
      provider: PaymentsProviderName;
      /** The provider's event id; a redelivery repeats it. */
      eventId: string;
      orderId: string;
      checkoutRef: string;
      /** What the provider says was paid, minor units. */
      amount: number;
      currency: string;
      paymentRef: string | null;
      occurredAt: string;
      /** Present only when the checkout asked for tax: what the provider calculated. */
      tax?: PaymentsTaxReport;
    }
  | {
      kind: "refund";
      provider: PaymentsProviderName;
      eventId: string;
      orderId: string | null;
      /** The host's refund id, when the refund carried one. */
      refundId: string | null;
      refundRef: string;
      paymentRef: string | null;
      amount: number;
      currency: string;
      occurredAt: string;
      /** The tax this refund gave back, when the provider's refund event says. */
      tax?: { amount: number };
      /**
       * True when the event is a credit note's report of a refund (ADR 0486): it says the tax the
       * refund `refundRef` gave back, and confirms nothing; the refund's own event does that.
       */
      creditNote?: boolean;
    }
  | {
      /**
       * A reader's action did not take the payment (stage 50, ADR 0774): the card was declined, the
       * buyer or the host cancelled it, or the reader failed. Nothing was paid; the host matches it
       * on `checkoutRef`, the reference `presentPayment()` returned, never on metadata.
       */
      kind: "reader";
      provider: PaymentsProviderName;
      eventId: string;
      readerRef: string;
      /** The presented payment's reference, when the provider names it. */
      checkoutRef: string | null;
      /** `cancelled`: cancelled on the reader or by `cancelPresented()`. `failed`: anything else. */
      outcome: "failed" | "cancelled";
      /** The provider's code (`card_declined`, …), or null. Never card details. */
      failureCode: string | null;
      occurredAt: string;
    }
  | {
      /**
       * Something happened to a subscription (stage 32a, ADR 0485). `subscription` is a current
       * read made when the event arrived, not the event's own copy: events may arrive in any
       * order, and the latest read wins.
       */
      kind: "subscription";
      provider: PaymentsProviderName;
      eventId: string;
      /** What the provider said happened. */
      trigger: PaymentsSubscriptionTrigger;
      subscription: PaymentsSubscription;
      /** For an invoice trigger: the invoice, as read when the event arrived. */
      invoice?: PaymentsInvoice;
      occurredAt: string;
    };

/** What a subscription event says happened. */
export type PaymentsSubscriptionTrigger =
  | "checkout_completed"
  | "created"
  | "updated"
  | "deleted"
  | "paused"
  | "resumed"
  | "trial_will_end"
  | "invoice_paid"
  | "invoice_payment_failed"
  | "invoice_action_required"
  | "invoice_finalization_failed";

/** The hook a session subscribes. */
export interface PaymentsEventHook {
  receiveEvent(event: PaymentsEvent): Promise<void>;
}

/** The session a payment account grants. */
/** What `getSubscriptionCheckout()` answers. */
export interface PaymentsSubscriptionCheckoutStatus {
  ref: string;
  status: "open" | "complete" | "expired";
}

export interface PaymentsSession {
  provider(): Promise<PaymentsProviderName>;
  /** Opens the provider's hosted payment page. Records an observation first. No approval: it moves no money. */
  createCheckout(input: PaymentsCheckoutInput): Promise<PaymentsCheckout>;
  /** Reads one checkout. Records an observation first. */
  getPayment(ref: string): Promise<PaymentsPayment>;
  /** Submits a refund as an outbound action `payments.refund` (never auto-approvable). Nothing is sent until the host applies it. */
  refund(input: PaymentsRefundInput): Promise<PaymentsRefundReceipt>;
  /**
   * Opens the provider's hosted page that takes the card and starts a subscription. Records an
   * observation first. No approval: nothing is charged until the provider's schedule says so.
   */
  createSubscriptionCheckout(input: PaymentsSubscriptionCheckoutInput): Promise<PaymentsCheckout>;
  /** Reads one subscription now. Records an observation first. */
  getSubscription(ref: string): Promise<PaymentsSubscription>;
  /**
   * Reads a subscription checkout's page now (stage 32a review, ADR 0489): still `open`, `complete`
   * (submitted: a subscription was started) or `expired` (can never be). Records an observation.
   */
  getSubscriptionCheckout(ref: string): Promise<PaymentsSubscriptionCheckoutStatus>;
  /**
   * Submits a cancellation as the outbound action `payments.subscription.cancel`. Nothing is sent
   * until it is applied; the subscription's state follows from the provider's verified event.
   */
  cancelSubscription(
    input: PaymentsCancelSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt>;
  /** Submits `payments.subscription.resume`: undoes a cancellation at the period's end. */
  resumeSubscription(
    input: PaymentsResumeSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt>;
  /**
   * Submits `payments.subscription.change` (never auto-approvable): a new price, now (an upgrade,
   * applied only once its prorated charge is paid) or from the next period (a downgrade). The
   * host's own call only (as `openPortal`): any other session is refused. So are the two below.
   */
  changeSubscription(
    input: PaymentsChangeSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt>;
  /** Submits `payments.subscription.pause` (never auto-approvable): the provider's pause. */
  pauseSubscription(
    input: PaymentsPauseSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt>;
  /** Submits `payments.subscription.unpause`: ends a pause now, or withdraws one not started. */
  unpauseSubscription(
    input: PaymentsUnpauseSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt>;
  /**
   * Submits `payments.subscription.void_update`: cancels an upgrade's pending update by voiding the
   * open invoice it made. The host's own call only.
   */
  voidPendingUpdate(input: PaymentsVoidUpdateInput): Promise<PaymentsSubscriptionChangeReceipt>;
  /**
   * Opens the provider's customer portal for one customer, with only the card, billing details and
   * past invoices on (no cancelling or plan changes there). Records an observation first.
   */
  openPortal(input: PaymentsPortalInput): Promise<PaymentsPortal>;
  /**
   * Submits `payments.reader.register` (never auto-approvable): registers a card reader to the
   * payment account at its address. It moves no money but adds a device that can take it. The
   * host's own call only, as every reader call below is: any other session is refused.
   */
  registerReader(input: PaymentsRegisterReaderInput): Promise<PaymentsReaderChangeReceipt>;
  /**
   * Submits `payments.reader.remove` (never auto-approvable): takes a reader off the account. The
   * provider's reader must be the host's reader of `readerId`, or nothing is removed.
   */
  removeReader(input: PaymentsRemoveReaderInput): Promise<PaymentsReaderChangeReceipt>;
  /** The account's readers, at most 100. Records an observation first. The host's own call only. */
  listReaders(): Promise<PaymentsReader[]>;
  /**
   * Puts a payment of the order's amount on a reader. Records an observation first. No approval:
   * no money moves until the buyer's card does. Refused while the reader has another payment on it.
   */
  presentPayment(input: PaymentsPresentInput): Promise<PaymentsPresentation>;
  /** Clears whatever payment is on the reader; it stays unpaid. Records an observation first. */
  cancelPresented(readerRef: string): Promise<void>;
  /** Asks the host to bind a hook that receives every verified payment, refund and subscription event. */
  subscribe(hook: PaymentsEventHook): Promise<void>;
}
```
