// The provider-neutral interface every payment provider implements, and the configuration that
// says which providers this deployment offers. The host never sees a provider's keys: they live in
// this Worker's secrets only.

import { stripTrailingSlashes } from "@composable-os/gatekeeper-interface/gatekeeper";
import type {
  PaymentsCancelSubscriptionInput,
  PaymentsChangeSubscriptionInput,
  PaymentsCheckoutInput,
  PaymentsCustomerEmailInput,
  PaymentsEvent,
  PaymentsListPayoutsInput,
  PaymentsPauseSubscriptionInput,
  PaymentsPayment,
  PaymentsPayoutLinePage,
  PaymentsPayoutLinesInput,
  PaymentsPayoutPage,
  PaymentsPortalInput,
  PaymentsPresentation,
  PaymentsPresentInput,
  PaymentsProviderName,
  PaymentsReader,
  PaymentsRefundInput,
  PaymentsRegisterReaderInput,
  PaymentsRemoveReaderInput,
  PaymentsResumeSubscriptionInput,
  PaymentsSubscription,
  PaymentsSubscriptionCheckoutInput,
  PaymentsSubscriptionTrigger,
  PaymentsUnpauseSubscriptionInput,
  PaymentsVoidUpdateInput,
} from "./types.js";

export type CheckoutInput = PaymentsCheckoutInput;
export type RefundInput = PaymentsRefundInput;
export type SubscriptionCheckoutInput = PaymentsSubscriptionCheckoutInput;

/**
 * A verified subscription event whose content the gatekeeper reads from the provider before it is
 * stored (ADR 0485): the event names what happened; the read says what is true now.
 */
export type PendingRead = {
  trigger: PaymentsSubscriptionTrigger;
  subscriptionRef: string;
  invoiceRef: string | null;
  occurredAt: string;
};

/** What a verified webhook delivery carries. */
export type VerifiedWebhook =
  | { ok: true; events: PaymentsEvent[]; eventId: string; reads?: PendingRead[] }
  /** `retry`: verified, but not yet readable in full; answered 500 so the provider sends it again. */
  | { ok: false; reason: string; retry?: boolean };

export interface PaymentProvider {
  readonly name: PaymentsProviderName;
  createCheckout(
    input: CheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }>;
  getPayment(ref: string): Promise<PaymentsPayment>;
  /**
   * Sends a refund. Throws `ActionApplyError` when the provider refused it before refunding
   * anything, and `ActionOutcomeUnknownError` when it may have gone through.
   */
  refund(input: RefundInput): Promise<{ refundRef: string; status: "pending" | "succeeded" }>;
  /** Opens the provider's page that takes the card and starts a subscription (ADR 0485). */
  createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }>;
  /** Reads one subscription now. */
  getSubscription(ref: string): Promise<PaymentsSubscription>;
  /** Whether a subscription checkout's page is still open, was submitted, or has expired. */
  getSubscriptionCheckout(ref: string): Promise<"open" | "complete" | "expired">;
  /**
   * Ends a subscription at its period's end or now. Throws `ActionApplyError` when the provider
   * refused before changing anything, `ActionOutcomeUnknownError` when it may have changed it.
   */
  cancelSubscription(input: PaymentsCancelSubscriptionInput): Promise<void>;
  /** Undoes a cancellation at the period's end. Throws as `cancelSubscription` does. */
  resumeSubscription(input: PaymentsResumeSubscriptionInput): Promise<void>;
  /**
   * A new price (stage 32b, ADR 0530): now, applied only once its prorated charge is paid, or from
   * the next invoice with nothing prorated. Throws as `cancelSubscription` does.
   */
  changeSubscription(input: PaymentsChangeSubscriptionInput): Promise<void>;
  /** The provider's own pause, from now or a moment, until a moment (ADR 0531). */
  pauseSubscription(input: PaymentsPauseSubscriptionInput): Promise<void>;
  /** Ends a pause now, or withdraws one that has not started. */
  unpauseSubscription(input: PaymentsUnpauseSubscriptionInput): Promise<void>;
  /** Cancels an upgrade's pending update (voids its open invoice). Refused when none is pending. */
  voidPendingUpdate(input: PaymentsVoidUpdateInput): Promise<void>;
  /** Opens the customer portal for one customer: card, billing details and invoices only. */
  openPortal(input: PaymentsPortalInput): Promise<{ url: string }>;
  /**
   * Gives one customer a new email address (stage 48, ADR 0712). Throws as `cancelSubscription`
   * does.
   */
  updateCustomerEmail(input: PaymentsCustomerEmailInput): Promise<void>;
  /**
   * Registers a card reader to the account at its address (stage 50, ADR 0774). Throws
   * `ActionApplyError` when the provider refused it (a wrong or used code) and registered nothing.
   */
  registerReader(input: PaymentsRegisterReaderInput): Promise<PaymentsReader>;
  /** The account's readers, at most 100. */
  listReaders(): Promise<PaymentsReader[]>;
  /** Takes a reader off the account; one already gone is not an error. Throws as `refund` does. */
  removeReader(input: PaymentsRemoveReaderInput): Promise<void>;
  /**
   * A card-present payment of `amount` on the reader, the order id in its metadata. The same
   * idempotency key makes no second payment: a retry re-presents the same one, or answers `paid`.
   */
  presentPayment(input: PaymentsPresentInput): Promise<Omit<PaymentsPresentation, "provider">>;
  /** Clears the payment on the reader, if any. */
  cancelPresented(readerRef: string): Promise<void>;
  /**
   * Payouts arriving on or after `since`, a page at a time (stage 52 step 4, ADR 0793). Read only;
   * the bank destination is never read. Answers `unavailable` (never throws) when the account's
   * key may not read payouts; throws on anything else (a network failure, a 5xx).
   */
  listPayouts(input: PaymentsListPayoutsInput): Promise<PaymentsPayoutPage>;
  /** One payout's lines, a page at a time. As `listPayouts`. */
  payoutLines(input: PaymentsPayoutLinesInput): Promise<PaymentsPayoutLinePage>;
  /** Verifies a webhook delivery; returns the typed events it carries (possibly none), or a rejection reason. */
  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook>;
}

type Env = Cloudflare.Env;

/** The fake provider's signing secret when FAKE_WEBHOOK_SECRET is empty. Not a secret. */
export const DEFAULT_FAKE_WEBHOOK_SECRET = "fake-payments-dev-secret";

/** Reads a var as a plain string: `wrangler types` types each var as its committed literal. */
function stringVar(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The public base the routes are served under, without a trailing slash. */
export function baseUrl(env: Env): string {
  return stripTrailingSlashes(
    stringVar(env.BASE_URL) || "http://localhost:5173/gatekeeper/payments",
  );
}

export function stripeApiBase(env: Env): string {
  return stripTrailingSlashes(stringVar(env.STRIPE_API_BASE) || "https://api.stripe.com");
}

export function stripeAccount(env: Env): string {
  return stringVar(env.STRIPE_ACCOUNT);
}

export function stripeSecretKey(env: Env): string {
  return stringVar(env.STRIPE_SECRET_KEY);
}

export function stripeWebhookSecret(env: Env): string {
  return stringVar(env.STRIPE_WEBHOOK_SECRET);
}

/**
 * Whether the fake provider is on: asked for (PAYMENTS_FAKE_PROVIDER=true), and either given its
 * own signing secret (FAKE_WEBHOOK_SECRET) or served on this machine only (a localhost base, as
 * the CRM's dev server and e2e run it). The default secret is public, so with it anyone who can
 * reach the webhook could report a fake payment or a paid subscription period; a deployment
 * reachable from elsewhere (a staging host) must set a secret of its own (ADR 0485).
 */
export function fakeEnabled(env: FakeEnv): boolean {
  return stringVar(env.PAYMENTS_FAKE_PROVIDER) === "true" && fakeSecretOrLocal(env);
}

/** The environment the fake's switch reads. */
export type FakeEnv = Pick<Env, "PAYMENTS_FAKE_PROVIDER"> & {
  FAKE_WEBHOOK_SECRET?: string | undefined;
  BASE_URL?: string | undefined;
};

function fakeSecretOrLocal(env: FakeEnv): boolean {
  if (stringVar(env.FAKE_WEBHOOK_SECRET) !== "") return true;
  const base = stringVar(env.BASE_URL) || "http://localhost:5173/gatekeeper/payments";
  try {
    const { protocol, hostname } = new URL(base);
    return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function fakeWebhookSecret(env: Env): string {
  return stringVar(env.FAKE_WEBHOOK_SECRET) || DEFAULT_FAKE_WEBHOOK_SECRET;
}

/** The environment the availability check reads, so a test can pass a hand-made one. */
export type AvailabilityEnv = FakeEnv & {
  STRIPE_SECRET_KEY?: string | undefined;
};

/** Why `provider` cannot be used in this deployment, or undefined when it can. */
export function unavailableReason(
  env: AvailabilityEnv,
  provider: PaymentsProviderName,
): string | undefined {
  if (provider === "fake") {
    if (stringVar(env.PAYMENTS_FAKE_PROVIDER) !== "true") {
      return (
        "The fake payment provider is off in this deployment. It is for development and tests " +
        "only, and is turned on with PAYMENTS_FAKE_PROVIDER=true."
      );
    }
    return fakeSecretOrLocal(env)
      ? undefined
      : "The fake payment provider needs its own signing secret here: the FAKE_WEBHOOK_SECRET " +
          "secret of cos-gatekeeper-payments, which cos deploy generates for an environment " +
          "marked live: false. Without one it runs only on localhost.";
  }
  return stringVar(env.STRIPE_SECRET_KEY)
    ? undefined
    : "Stripe is not set up in this deployment: an administrator must set the STRIPE_SECRET_KEY " +
        "secret on cos-gatekeeper-payments.";
}

/** Throws the reason `provider` cannot be used, if any. */
export function assertProviderAvailable(
  env: AvailabilityEnv,
  provider: PaymentsProviderName,
): void {
  const reason = unavailableReason(env, provider);
  if (reason !== undefined) throw new Error(reason);
}

export const PROVIDER_TITLES: Record<PaymentsProviderName, string> = {
  stripe: "Stripe",
  fake: "Fake provider (development)",
};
