// The payments gatekeeper as the host sees it (stage 25, ADR 0429): the org connection that takes
// money, and the three calls the host makes on it. Core never imports the gatekeeper's package:
// the shapes here are the session's (packages/gatekeeper-payments/src/types.d.ts), as JSON.
//
// - Opening a checkout and sending the confirmation email are the host's own calls
//   (`callAsHost`): no person or agent asked for them, they move no money, and the host composed
//   what they say.
// - A refund is the caller's call (`call`, as the person or agent asking): the gatekeeper submits
//   it as the outbound action `payments.refund`, which waits for a person with `orders:refund`.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ConfigError } from "../errors.ts";
import type {
  IntegrationCaller,
  IntegrationCallResult,
  IntegrationRuntime,
} from "../integrations/runtime.ts";
import type { CheckoutTax } from "./tax.ts";

/** The vendor of the payments gatekeeper (`GATEKEEPER_PAYMENTS`, `/gatekeeper/payments/*`). */
export const PAYMENTS_VENDOR = "payments";
export const PAYMENTS_RESOURCE_PATTERN = "payments://merchant/:provider";
/** The outbound action kind of a refund. Never auto-applied; approved only by a person. */
export const REFUND_ACTION_KIND = "payments.refund";

export type PaymentsProviderName = "stripe" | "fake";

/** A bound payment account: the org connection and its `payments://merchant/<provider>` facet. */
export interface PaymentsTarget {
  connectionId: string;
  /** The bound resource's key on the connection. */
  resource: string;
  provider: PaymentsProviderName;
}

export interface CheckoutRequest {
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  customerEmail?: string | undefined;
  idempotencyKey: string;
  /** Tax at checkout (ADR 0479): absent, the request is exactly as before tax existed. */
  tax?: CheckoutTax;
}

/** The tax the provider calculated on a payment (gatekeeper PaymentsTaxReport). */
export interface PaymentsTaxReport {
  amount: number;
  country: string | null;
  lines: { ref: string; amount: number }[];
}

export interface ProviderCheckout {
  provider: PaymentsProviderName;
  ref: string;
  url: string;
  expiresAt: string | null;
}

export interface RefundRequest {
  orderId: string;
  paymentRef: string;
  amount: number;
  currency: string;
  reason: string;
  refundId: string;
  /** A subscription period's invoice: the refund is credited on it (ADR 0486). */
  invoiceRef?: string;
}

/** A subscription as the gatekeeper read it (gatekeeper PaymentsSubscription). */
export interface ProviderSubscription {
  provider: PaymentsProviderName;
  ref: string;
  customerRef: string | null;
  subscriptionId: string | null;
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "unpaid"
    | "paused"
    | "canceled";
  amount: number;
  currency: string;
  interval: "week" | "month" | "year" | null;
  cancelAtPeriodEnd: boolean;
  /** A date it ends on set at the provider another way (its dashboard); resume does not undo it. */
  cancelAt: string | null;
  trialEnd: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  observedAt: string;
}

/** One invoice of a subscription (gatekeeper PaymentsInvoice). */
export interface ProviderInvoice {
  ref: string;
  status: string;
  amountPaid: number;
  amountDue: number;
  currency: string;
  paymentRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  billingReason: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  hostedUrl: string | null;
  tax?: { amount: number; country: string | null };
}

export type SubscriptionTrigger =
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

/** What the host asks the gatekeeper for to start a subscription (ADR 0485). */
export interface SubscriptionCheckoutRequest {
  subscriptionId: string;
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  description: string;
  returnUrl: string;
  customerEmail?: string;
  customerRef?: string;
  trialDays?: number;
  trialEnd?: string;
  idempotencyKey: string;
  tax?: { behavior: "inclusive"; taxCode: string };
}

/** A verified event, as the gatekeeper delivers it to the host's hook. */
export type PaymentsEvent =
  | {
      kind: "payment";
      provider: PaymentsProviderName;
      eventId: string;
      orderId: string;
      checkoutRef: string;
      amount: number;
      currency: string;
      paymentRef: string | null;
      occurredAt: string;
      tax?: PaymentsTaxReport;
    }
  | {
      kind: "refund";
      provider: PaymentsProviderName;
      eventId: string;
      orderId: string | null;
      refundId: string | null;
      refundRef: string;
      paymentRef: string | null;
      amount: number;
      currency: string;
      occurredAt: string;
      tax?: { amount: number };
      /** A credit note's report of the tax refund `refundRef` gave back; it confirms nothing. */
      creditNote?: boolean;
    }
  | {
      kind: "subscription";
      provider: PaymentsProviderName;
      eventId: string;
      trigger: SubscriptionTrigger;
      /** A current read of the subscription, made when the event arrived (ADR 0485). */
      subscription: ProviderSubscription;
      invoice?: ProviderInvoice;
      occurredAt: string;
    };

const notConnected = () =>
  new ConfigError(
    "Payments are not connected: an admin connects a payment account in Settings → Integrations",
  );

/**
 * The deployment's payment account: the first active org connection of the payments gatekeeper
 * with a payment account bound. Refuses when there is none.
 */
export async function paymentsTarget(db: Kysely<CoreDatabase>): Promise<PaymentsTarget> {
  const rows = await db
    .selectFrom("core_integration_connection")
    .select(["id", "resources", "status", "scope"])
    .where("vendor", "=", PAYMENTS_VENDOR)
    .where("scope", "=", "org")
    .where("status", "=", "active")
    .orderBy("created_at")
    .execute();
  for (const row of rows) {
    let resources: { key?: unknown; url?: unknown; pattern?: unknown }[] = [];
    try {
      const parsed = JSON.parse(row.resources) as unknown;
      if (Array.isArray(parsed)) resources = parsed as typeof resources;
    } catch {}
    for (const bound of resources) {
      if (bound.pattern !== PAYMENTS_RESOURCE_PATTERN || typeof bound.key !== "string") continue;
      const provider = typeof bound.url === "string" ? providerOfUrl(bound.url) : null;
      if (provider) return { connectionId: row.id, resource: bound.key, provider };
    }
  }
  throw notConnected();
}

export function providerOfUrl(url: string): PaymentsProviderName | null {
  const match = /^payments:\/\/merchant\/(stripe|fake)$/.exec(url);
  return match ? (match[1] as PaymentsProviderName) : null;
}

function requireHostCalls(integrations: IntegrationRuntime | undefined) {
  const call = integrations?.callAsHost;
  if (!integrations || !call) {
    throw new ConfigError("Payments need the integration host, which is not reachable here");
  }
  return call.bind(integrations);
}

/** Opens the provider's hosted page for one payment. The host's own call. */
export async function openProviderCheckout(
  integrations: IntegrationRuntime | undefined,
  target: PaymentsTarget,
  request: CheckoutRequest,
): Promise<ProviderCheckout> {
  const call = requireHostCalls(integrations);
  const result = await call({
    connectionId: target.connectionId,
    resource: target.resource,
    method: "createCheckout",
    args: [request],
    purpose: "orders",
  });
  const value = result.value as Partial<ProviderCheckout> | null;
  if (!value || typeof value.ref !== "string" || typeof value.url !== "string") {
    throw new ConfigError("The payments gatekeeper did not open a checkout");
  }
  return {
    provider: value.provider === "stripe" ? "stripe" : target.provider,
    ref: value.ref,
    url: value.url,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
  };
}

/**
 * Asks the gatekeeper for a refund, as `caller`. The gatekeeper submits it as a
 * `payments.refund` outbound action: the result's `pending` holds the action waiting for approval.
 */
export async function requestProviderRefund(
  integrations: IntegrationRuntime | undefined,
  target: PaymentsTarget,
  caller: IntegrationCaller,
  request: RefundRequest,
): Promise<IntegrationCallResult> {
  if (!integrations) {
    throw new ConfigError("Payments need the integration host, which is not reachable here");
  }
  return integrations.call({
    connectionId: target.connectionId,
    resource: target.resource,
    method: "refund",
    args: [request],
    caller,
  });
}

/**
 * A subscription call the host makes for itself (ADR 0485): opening the provider's page, asking
 * it to end a subscription at its period's end or undo that, or opening its portal. Each is made
 * only after the host's operation has established the caller may (their own subscription).
 * Cancel and resume are the gatekeeper's outbound actions, which the host's own call applies at
 * once; the subscription's state changes only when the provider's verified event says so.
 */
export async function callSubscriptionGatekeeper(
  integrations: IntegrationRuntime | undefined,
  target: PaymentsTarget,
  method:
    | "createSubscriptionCheckout"
    | "getSubscriptionCheckout"
    | "cancelSubscription"
    | "resumeSubscription"
    | "changeSubscription"
    | "pauseSubscription"
    | "unpauseSubscription"
    | "voidPendingUpdate"
    | "getSubscription"
    | "openPortal",
  request: unknown,
): Promise<IntegrationCallResult> {
  const call = requireHostCalls(integrations);
  return call({
    connectionId: target.connectionId,
    resource: target.resource,
    method,
    args: [request],
    purpose: "orders",
  });
}

/** Sends one email the host composed (a confirmation), through an email channel target. */
export async function sendHostEmail(
  integrations: IntegrationRuntime | undefined,
  target: { connectionId: string; resource: string },
  message: {
    to: string;
    subject: string;
    text: string;
    /** A send retried after a crash sends nothing twice (ADR 0574). */
    idempotencyKey?: string;
  },
): Promise<IntegrationCallResult> {
  const call = requireHostCalls(integrations);
  return call({
    connectionId: target.connectionId,
    resource: target.resource,
    method: "send",
    args: [
      {
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      },
    ],
    purpose: "orders",
  });
}
