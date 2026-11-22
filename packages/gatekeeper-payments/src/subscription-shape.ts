// The shapes of a subscription event (stage 32a, ADR 0485), checked wherever one is read from a
// delivery: a fake provider's body, or a Stripe read. Each guard copies only the known keys.

import type {
  PaymentsEvent,
  PaymentsInterval,
  PaymentsInvoice,
  PaymentsProviderName,
  PaymentsSubscription,
  PaymentsSubscriptionStatus,
  PaymentsSubscriptionTrigger,
} from "./types.js";

export const SUBSCRIPTION_STATUSES: readonly PaymentsSubscriptionStatus[] = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
];

export const SUBSCRIPTION_TRIGGERS: readonly PaymentsSubscriptionTrigger[] = [
  "checkout_completed",
  "created",
  "updated",
  "deleted",
  "paused",
  "resumed",
  "trial_will_end",
  "invoice_paid",
  "invoice_payment_failed",
  "invoice_action_required",
  "invoice_finalization_failed",
];

const INTERVALS: readonly PaymentsInterval[] = ["week", "month", "year"];
const REF = /^[A-Za-z0-9_-]{1,255}$/;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const minor = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const refOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" && REF.test(v) ? v : undefined;
const when = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 40) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
};
const word = (v: unknown, max = 60): string | null | undefined =>
  v === null
    ? null
    : typeof v === "string" && /^[a-z_]{1,60}$/.test(v) && v.length <= max
      ? v
      : undefined;

/** A subscription read, or null when anything in it is malformed. */
export function subscriptionOf(
  value: unknown,
  provider: PaymentsProviderName,
): PaymentsSubscription | null {
  const s = obj(value);
  if (!s) return null;
  const ref = refOrNull(s.ref);
  const customerRef = refOrNull(s.customerRef ?? null);
  const subscriptionId = refOrNull(s.subscriptionId ?? null);
  const status = s.status as PaymentsSubscriptionStatus;
  const currency = s.currency;
  const interval = s.interval === null ? null : (s.interval as PaymentsInterval);
  const times = {
    trialEnd: when(s.trialEnd ?? null),
    cancelAt: when(s.cancelAt ?? null),
    currentPeriodStart: when(s.currentPeriodStart ?? null),
    currentPeriodEnd: when(s.currentPeriodEnd ?? null),
    canceledAt: when(s.canceledAt ?? null),
    endedAt: when(s.endedAt ?? null),
  };
  const observedAt = when(s.observedAt);
  const endReason = word(s.endReason ?? null);
  if (
    !ref ||
    customerRef === undefined ||
    subscriptionId === undefined ||
    !SUBSCRIPTION_STATUSES.includes(status) ||
    !minor(s.amount) ||
    typeof currency !== "string" ||
    !/^[A-Za-z]{3}$/.test(currency) ||
    (interval !== null && !INTERVALS.includes(interval)) ||
    typeof s.cancelAtPeriodEnd !== "boolean" ||
    Object.values(times).some((t) => t === undefined) ||
    !observedAt ||
    endReason === undefined
  ) {
    return null;
  }
  return {
    provider,
    ref,
    customerRef,
    subscriptionId,
    status,
    amount: s.amount,
    currency: currency.toUpperCase(),
    interval,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    cancelAt: times.cancelAt as string | null,
    trialEnd: times.trialEnd as string | null,
    currentPeriodStart: times.currentPeriodStart as string | null,
    currentPeriodEnd: times.currentPeriodEnd as string | null,
    canceledAt: times.canceledAt as string | null,
    endedAt: times.endedAt as string | null,
    endReason,
    observedAt,
  };
}

/** An invoice read, or null when anything in it is malformed. */
export function invoiceOf(value: unknown): PaymentsInvoice | null {
  const i = obj(value);
  if (!i) return null;
  const ref = refOrNull(i.ref);
  const paymentRef = refOrNull(i.paymentRef ?? null);
  const status = word(i.status);
  const billingReason = word(i.billingReason ?? null);
  const periodStart = when(i.periodStart ?? null);
  const periodEnd = when(i.periodEnd ?? null);
  const nextAttemptAt = when(i.nextAttemptAt ?? null);
  const currency = i.currency;
  let hostedUrl: string | null = null;
  if (i.hostedUrl !== null && i.hostedUrl !== undefined) {
    if (typeof i.hostedUrl !== "string" || i.hostedUrl.length > 2000) return null;
    try {
      const url = new URL(i.hostedUrl);
      if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    } catch {
      return null;
    }
    hostedUrl = i.hostedUrl;
  }
  let tax: PaymentsInvoice["tax"];
  if (i.tax !== undefined) {
    const t = obj(i.tax);
    const country = t?.country ?? null;
    if (
      !t ||
      !minor(t.amount) ||
      (country !== null && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)))
    ) {
      return null;
    }
    tax = { amount: t.amount, country: country as string | null };
  }
  if (
    !ref ||
    paymentRef === undefined ||
    !status ||
    billingReason === undefined ||
    periodStart === undefined ||
    periodEnd === undefined ||
    nextAttemptAt === undefined ||
    !minor(i.amountPaid) ||
    !minor(i.amountDue) ||
    !minor(i.attemptCount) ||
    typeof currency !== "string" ||
    !/^[A-Za-z]{3}$/.test(currency)
  ) {
    return null;
  }
  return {
    ref,
    status,
    amountPaid: i.amountPaid,
    amountDue: i.amountDue,
    currency: currency.toUpperCase(),
    paymentRef,
    periodStart,
    periodEnd,
    billingReason,
    attemptCount: i.attemptCount,
    nextAttemptAt,
    hostedUrl,
    ...(tax ? { tax } : {}),
  };
}

/** Whether a trigger is about an invoice (and so must carry one). */
export function isInvoiceTrigger(trigger: PaymentsSubscriptionTrigger): boolean {
  return trigger.startsWith("invoice_");
}

/** A subscription event from its parts, or null when they do not make one. */
export function subscriptionEvent(
  provider: PaymentsProviderName,
  eventId: string,
  trigger: unknown,
  subscription: unknown,
  invoice: unknown,
  occurredAt: string,
): Extract<PaymentsEvent, { kind: "subscription" }> | null {
  if (!SUBSCRIPTION_TRIGGERS.includes(trigger as PaymentsSubscriptionTrigger)) return null;
  const t = trigger as PaymentsSubscriptionTrigger;
  const sub = subscriptionOf(subscription, provider);
  if (!sub) return null;
  const inv = invoice === undefined || invoice === null ? undefined : invoiceOf(invoice);
  if (inv === null) return null;
  if (isInvoiceTrigger(t) !== (inv !== undefined)) return null;
  return {
    kind: "subscription",
    provider,
    eventId,
    trigger: t,
    subscription: sub,
    ...(inv ? { invoice: inv } : {}),
    occurredAt,
  };
}
