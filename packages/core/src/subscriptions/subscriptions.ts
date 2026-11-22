// Subscriptions (stage 32a, ADR 0485): the host's own calls to start one, end one at its period's
// end or keep it going, and open the provider's portal. The provider runs the schedule; nothing
// here charges a card or moves a subscription. Its state changes only when the provider's
// verified event says so (events.ts).
//
// Billing follows the payer (ADR 0487): the payer starts it, cancels or resumes it, and opens the
// portal for the card; what it grants follows the holder, who is the payer in 32a.
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { SubscriptionState } from "../fields/subscription.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import {
  callSubscriptionGatekeeper,
  paymentsTarget,
  type SubscriptionCheckoutRequest,
} from "../orders/gateway.ts";
import { resolveBuyer } from "../orders/guests.ts";
import { priceLines } from "../orders/orders.ts";
import {
  isAllowedReturnUrl,
  loadOrderCurrency,
  loadOrderTax,
  loadOrderTaxCodes,
  loadReturnOrigins,
} from "../orders/settings.ts";
import { taxCodeOf } from "../orders/tax.ts";
import { callerOf } from "../records/transitions.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";
import { decideTrial, holdTrialStatement, type NoTrial } from "./trial.ts";

/** States in which a subscription still runs (and so can be ended at its period's end). */
export const RUNNING: ReadonlySet<SubscriptionState> = new Set(["trialing", "active", "past_due"]);

function requireReturnUrl(url: string, origins: readonly string[]): void {
  if (!isAllowedReturnUrl(url, origins)) {
    throw new ValidationError("The return address is not on this deployment's list of sites", {
      field: "returnUrl",
      rule: "return_origin",
    });
  }
}

export interface StartedSubscription {
  subscriptionId: string;
  url: string;
  amount: number;
  currency: string;
  interval: "week" | "month" | "year";
  trialDays: number | null;
  /** Why the plan's trial was not given: a guest (`sign_in`), or the holder had one (`used`). */
  noTrial: NoTrial | null;
  expiresAt: string | null;
}

/**
 * Opens the provider's page to start a subscription to `plan` for the caller (a signed-in
 * customer), a guest by email, or a person staff name by email, and records the checkout in the
 * calling batch. The host prices it from the plan; the subscription exists once the provider's
 * verified event says so.
 */
export async function startSubscription(
  ctx: HandlerContext,
  input: { plan: { object: string; id: string }; returnUrl: string; email?: string | undefined },
): Promise<StartedSubscription> {
  requireReturnUrl(input.returnUrl, await loadReturnOrigins(ctx.db));
  const caller = ctx.principal;
  let personId: string | null;
  let email: string;
  if (caller.kind === "customer") {
    if (input.email !== undefined) {
      throw new ValidationError("You are signed in: the subscription uses your account's address", {
        field: "email",
      });
    }
    const account = await ctx.db
      .selectFrom("core_customer")
      .select("email")
      .where("id", "=", caller.customerId)
      .executeTakeFirst();
    if (!account) throw new NotFoundError("customer", caller.customerId);
    personId = caller.personId;
    email = account.email;
  } else {
    if (!input.email) {
      throw new ValidationError("A subscription needs the payer's email address", {
        field: "email",
      });
    }
    const buyer = await resolveBuyer(ctx, input.email);
    personId = buyer.personId;
    email = buyer.email;
  }
  if (!personId) {
    throw new ConflictError(
      "That address belongs to more than one person here, so a subscription cannot be started " +
        "for it until staff merge them",
      { rule: "payer" },
    );
  }
  const currency = await loadOrderCurrency(ctx.db);
  if (!currency) {
    throw new ConfigError("No currency is set for orders yet, so nothing can be sold");
  }
  const [plan] = await priceLines(
    ctx.db,
    [{ object: input.plan.object, id: input.plan.id, quantity: 1 }],
    currency,
    ctx.now,
    callerOf(ctx),
    { plans: true },
  );
  if (!plan?.recurring) throw new ValidationError("This is not a plan", { rule: "not_for_sale" });
  if (plan.unitPrice <= 0) {
    throw new ValidationError("A plan with nothing to pay cannot be subscribed to", {
      rule: "total",
    });
  }
  // The payer's provider customer, when they have one already: one card and one portal for them.
  // Only for a caller who has proved who they are: a signed-in customer starting their own, or
  // staff. A guest only typed an address; reusing that address's customer would attach the
  // guest's card and invoices to someone else's billing (review of 32a). A guest always gets a
  // new provider customer from the address (ADR 0487 says which one the portal then opens).
  const target = await paymentsTarget(ctx.db);
  const proved = caller.kind === "customer" || caller.kind === "staff";
  const earlier = proved ? await latestCustomerRef(ctx, personId, target.provider) : null;
  // Tax on every period (ADR 0479): only when a human admin turned it on and the plan has a code.
  const taxCode = (await loadOrderTax(ctx.db))
    ? taxCodeOf(getObject(plan.object), await loadOrderTaxCodes(ctx.db))
    : null;
  // One trial per holder per plan object, and only for a holder who proved who they are (ADR
  // 0489): a guest pays from the start. The holder is the payer in 32a (ADR 0487).
  const decision = await decideTrial(
    ctx,
    { holderPersonId: personId, planObject: plan.object, planId: plan.recordId, proved },
    plan.recurring.trialDays,
  );
  if ("open" in decision) {
    // The same holder's page for this plan, with its trial, is still open: that page again, so a
    // second page cannot give a second trial.
    return {
      subscriptionId: decision.open.checkoutId,
      url: decision.open.url,
      amount: plan.unitPrice,
      currency,
      interval: plan.recurring.interval,
      trialDays: plan.recurring.trialDays,
      noTrial: null,
      expiresAt: decision.open.expiresAt,
    };
  }
  const trialDays = decision.give ? plan.recurring.trialDays : null;
  const id = newId("subscription");
  const request: SubscriptionCheckoutRequest = {
    subscriptionId: id,
    amount: plan.unitPrice,
    currency,
    interval: plan.recurring.interval,
    description: plan.title.slice(0, 200) || id,
    returnUrl: input.returnUrl,
    // The address too: the gatekeeper starts a new customer from it if the earlier one is gone.
    ...(earlier ? { customerRef: earlier } : {}),
    customerEmail: email,
    ...(trialDays ? { trialDays } : {}),
    idempotencyKey: id,
    ...(taxCode ? { tax: { behavior: "inclusive" as const, taxCode } } : {}),
  };
  const result = await callSubscriptionGatekeeper(
    ctx.integrations,
    target,
    "createSubscriptionCheckout",
    request,
  );
  const opened = result.value as {
    provider?: unknown;
    ref?: unknown;
    url?: unknown;
    expiresAt?: unknown;
  } | null;
  if (!opened || typeof opened.ref !== "string" || typeof opened.url !== "string") {
    throw new ConfigError("The payments gatekeeper did not open a subscription checkout");
  }
  ctx.write(
    ctx.db.insertInto("core_subscription_checkout").values({
      id,
      provider: target.provider,
      ref: opened.ref,
      // One Person pays and holds in 32a; 32b lets a payer hold for someone else (ADR 0487).
      payer_person_id: personId,
      holder_person_id: personId,
      email,
      placed_as: caller.kind,
      plan_object: plan.object,
      plan_id: plan.recordId,
      plan_title: plan.title,
      amount: plan.unitPrice,
      currency,
      interval: plan.recurring.interval,
      trial_days: trialDays,
      tax_code: taxCode,
      created_at: ctx.now,
    }),
  );
  const expiresAt = typeof opened.expiresAt === "string" ? opened.expiresAt : null;
  if (trialDays) {
    // Held while the page can be completed; refused by the database if another start took it
    // first (the whole batch fails, so nothing of this start is recorded).
    ctx.write(
      holdTrialStatement(ctx, {
        checkoutId: id,
        holderPersonId: personId,
        planObject: plan.object,
        planId: plan.recordId,
        url: opened.url,
        expiresAt,
      }),
    );
  }
  return {
    subscriptionId: id,
    url: opened.url,
    amount: plan.unitPrice,
    currency,
    interval: plan.recurring.interval,
    trialDays,
    noTrial: decision.give ? null : decision.reason,
    expiresAt,
  };
}

/**
 * The subscription `id`, for a change its caller asks: a customer's own (as payer) only, through
 * the seam, so another's is not found; staff any.
 */
export async function subscriptionForChange(
  ctx: HandlerContext,
  id: string,
): Promise<SubscriptionRow> {
  if (ctx.principal.kind !== "staff") await ctx.records.get("subscription", id);
  return loadSubscriptionRow(ctx.db, id);
}

/**
 * Asks the provider to end `row` when its paid period ends. The host's own call: the gatekeeper's
 * cancel action is applied at once. The record shows it once the provider's event arrives.
 */
export async function cancelAtPeriodEnd(
  ctx: HandlerContext,
  row: SubscriptionRow,
  reason: string,
): Promise<void> {
  if (!RUNNING.has(row.state)) {
    throw new ConflictError(`A subscription that is ${row.state} cannot be cancelled`, {
      subscription: row.id,
      state: row.state,
    });
  }
  if (row.cancel_at_period_end === 1 || row.cancel_at !== null) {
    throw new ConflictError(
      row.cancel_at_period_end === 1
        ? "This subscription already ends when its period does"
        : `This subscription is already set to end on ${row.cancel_at?.slice(0, 10)}`,
      { subscription: row.id, cancelAt: row.cancel_at },
    );
  }
  await callSubscriptionGatekeeper(
    ctx.integrations,
    await targetFor(ctx, row),
    "cancelSubscription",
    {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      when: "period_end",
      reason,
    },
  );
}

/** States a subscription can be ended from at once: every one but the final two. */
const ENDABLE: ReadonlySet<SubscriptionState> = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

/**
 * Asks the provider to end `row` now (staff only, `subscriptions:manage`): nothing more is
 * charged, nothing is refunded, and what it gives stops once the provider's event says it ended.
 */
export async function cancelNow(
  ctx: HandlerContext,
  row: SubscriptionRow,
  reason: string,
): Promise<void> {
  if (ctx.principal.kind !== "staff") {
    throw new ValidationError("Only staff end a subscription at once; yours ends with its period", {
      field: "now",
    });
  }
  if (!ENDABLE.has(row.state)) {
    throw new ConflictError(`A subscription that is ${row.state} cannot be ended`, {
      subscription: row.id,
      state: row.state,
    });
  }
  await callSubscriptionGatekeeper(
    ctx.integrations,
    await targetFor(ctx, row),
    "cancelSubscription",
    { subscriptionId: row.id, subscriptionRef: row.provider_ref, when: "now", reason },
  );
}

/** Asks the provider to keep `row` going: undoes its end at the period's end, before it comes. */
export async function resumeSubscription(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  // An end date set at the provider another way (its dashboard) is not undone by setting
  // cancel_at_period_end back, which is all resume asks (Stripe's documented way to stop a
  // pending cancellation); taking a date away changes the period and prorates, which is staff's
  // to decide at the provider. Said to the caller, never reported as asked.
  if (RUNNING.has(row.state) && row.cancel_at_period_end !== 1 && row.cancel_at !== null) {
    throw new ConflictError(
      `This subscription was set at the payment provider to end on ${row.cancel_at.slice(0, 10)}, ` +
        "which cannot be undone here: staff change it in the provider's dashboard",
      { subscription: row.id, cancelAt: row.cancel_at, rule: "provider_end_date" },
    );
  }
  if (!RUNNING.has(row.state) || row.cancel_at_period_end !== 1) {
    throw new ConflictError("This subscription is not set to end", {
      subscription: row.id,
      state: row.state,
    });
  }
  if (row.current_period_end && row.current_period_end <= ctx.now) {
    throw new ConflictError("This subscription's period has ended: start a new one", {
      subscription: row.id,
    });
  }
  await callSubscriptionGatekeeper(
    ctx.integrations,
    await targetFor(ctx, row),
    "resumeSubscription",
    {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
    },
  );
}

/**
 * The provider's customer portal for the signed-in customer, as payer: their card, billing
 * details and past invoices. Refused when they have never had a subscription the provider knows.
 */
export async function openPortal(ctx: HandlerContext, returnUrl: string): Promise<string> {
  const caller = ctx.principal;
  if (caller.kind !== "customer") {
    throw new ValidationError("The billing portal is a customer's own", { rule: "customer" });
  }
  requireReturnUrl(returnUrl, await loadReturnOrigins(ctx.db));
  const target = await paymentsTarget(ctx.db);
  // A payer with two provider customers (two subscriptions started as a guest) gets the newest's
  // portal (ADR 0487).
  const own = await latestCustomerRef(ctx, caller.personId, target.provider);
  if (!own) throw new NotFoundError("subscription", "billing");
  const result = await callSubscriptionGatekeeper(ctx.integrations, target, "openPortal", {
    customerRef: own,
    returnUrl,
  });
  const portal = result.value as { url?: unknown } | null;
  if (!portal || typeof portal.url !== "string") {
    throw new ConfigError("The payments gatekeeper did not open the portal");
  }
  return portal.url;
}

/**
 * The provider customer of `personId`'s most recently started subscription that has one, or
 * null. One Person can have more than one (each subscription a guest starts makes its own); the
 * newest is the one reused and the one the portal opens (ADR 0487).
 */
async function latestCustomerRef(
  ctx: HandlerContext,
  personId: string,
  provider: string,
): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("core_subscription")
    .select("customer_ref")
    .where("payer_person_id", "=", personId)
    .where("provider", "=", provider)
    .where("customer_ref", "is not", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return row?.customer_ref ?? null;
}

/** The payment account a subscription is on: the deployment's, which must be its provider. */
async function targetFor(ctx: HandlerContext, row: SubscriptionRow) {
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    throw new ConfigError(
      `This subscription is with ${row.provider}, and payments now use ${target.provider}`,
    );
  }
  return target;
}
