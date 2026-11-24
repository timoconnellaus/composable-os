// The Stripe provider: Checkout Sessions for payment, Refunds for refunds, and the Stripe webhook
// for confirmation. Plain fetch against the REST API with form-encoded bodies. No Stripe-Version is
// pinned: the account's default API version applies (see README.md).
//
// Nothing here logs: request bodies carry order details and emails, responses carry customer data,
// and the headers carry the secret key.

import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import type {
  CheckoutInput,
  PaymentProvider,
  PendingRead,
  RefundInput,
  SubscriptionCheckoutInput,
  VerifiedWebhook,
} from "./provider.js";
import { verifySignatureHeader } from "./signature.js";
import { SUBSCRIPTION_STATUSES, subscriptionEvent } from "./subscription-shape.js";
import type {
  PaymentsCancelSubscriptionInput,
  PaymentsChangeSubscriptionInput,
  PaymentsEvent,
  PaymentsInvoice,
  PaymentsPauseSubscriptionInput,
  PaymentsPayment,
  PaymentsPortalInput,
  PaymentsResumeSubscriptionInput,
  PaymentsSubscription,
  PaymentsSubscriptionStatus,
  PaymentsSubscriptionTrigger,
  PaymentsTaxPlace,
  PaymentsUnpauseSubscriptionInput,
  PaymentsVoidUpdateInput,
} from "./types.js";

/** Stripe's shortest Checkout Session lifetime is 30 minutes; one more absorbs clock skew. */
const CHECKOUT_LIFETIME_SECONDS = 31 * 60;
const MAX_METADATA_VALUE = 500;
/**
 * The API version sent on the calls that calculate tax, and only on them: Stripe documents tax
 * for events (`tax_details[performance_location]`) as needing `2026-09-30.endive` or later
 * (docs.stripe.com/tax/tax-for-tickets/integration-guide, read 2026-11-22). Every other call keeps
 * the account's default version, as before.
 */
export const STRIPE_TAX_VERSION = "2026-09-30.endive";

/** Where a facet keeps the tax location ids it made, one per address (Stripe asks for reuse). */
export type TaxLocationCache = {
  get(key: string): string | undefined;
  put(key: string, id: string): void;
};

export type StripeOptions = {
  secretKey: string;
  webhookSecret: string;
  /** Default https://api.stripe.com. */
  apiBase: string;
  /** A connected account id, sent as Stripe-Account; empty for the key's own account. */
  account: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** The facet's own storage for tax location ids; without it, one is made per checkout. */
  taxLocations?: TaxLocationCache;
  /** The facet's own storage for the portal configuration's id; without it, one per session. */
  store?: TaxLocationCache;
};

/**
 * The API version sent on every subscription call (stage 32a, ADR 0485): the latest on Stripe's
 * changelog when this was built (docs.stripe.com/changelog, read 2026-11-22). The fields read are
 * where it puts them: a subscription's period on its items, an invoice's subscription under
 * `parent.subscription_details`, its payment under `payments`, its tax in `total_taxes`.
 * Webhook payloads are shaped by the endpoint's own version, so they are not read for these
 * fields: the gatekeeper reads the subscription and invoice again with this version.
 */
export const STRIPE_BILLING_VERSION = "2026-11-18.endive";
const PORTAL_CONFIGURATION_KEY = "portal:configuration:v1";
/** A period's refund made whose credit note is still owed, by the host's refund id. */
const CREDIT_NOTE_OWED = "credit-note-owed:";

type StripeResponse = { status: number; body: Record<string, unknown> };

/** A call that failed in a way that says nothing reached Stripe's books, or the opposite. */
class StripeCallError extends Error {
  constructor(
    message: string,
    /** "refused": Stripe answered 4xx. "retry": rate limited. "unknown": 5xx or network. */
    readonly outcome: "refused" | "retry" | "unknown",
    /** Stripe's error code and the parameter it names, when it says (never its message). */
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(message);
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly #options: StripeOptions;

  constructor(options: StripeOptions) {
    this.#options = options;
  }

  async createCheckout(
    input: CheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS;
    const form = new URLSearchParams();
    form.set("mode", "payment");
    if (input.tax) {
      // Stripe Tax (ADR 0479): one line per share of the amount, each with its product tax code,
      // tax-inclusive, and for an in-person event the place it is held (a performance location).
      // Checkout collects the billing address; `required` makes it always do so.
      form.set("automatic_tax[enabled]", "true");
      form.set("billing_address_collection", "required");
      for (const [i, line] of input.tax.lines.entries()) {
        const p = `line_items[${i}]`;
        form.set(`${p}[price_data][currency]`, input.currency.toLowerCase());
        form.set(`${p}[price_data][unit_amount]`, String(line.amount));
        form.set(`${p}[price_data][tax_behavior]`, "inclusive");
        form.set(`${p}[price_data][product_data][name]`, line.name);
        form.set(`${p}[price_data][product_data][tax_details][tax_code]`, line.taxCode);
        if (line.place) {
          form.set(
            `${p}[price_data][product_data][tax_details][performance_location]`,
            await this.#taxLocation(line.place),
          );
        }
        form.set(`${p}[price_data][product_data][metadata][cos_line]`, line.ref);
        form.set(`${p}[quantity]`, "1");
      }
    } else {
      form.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
      form.set("line_items[0][price_data][unit_amount]", String(input.amount));
      form.set("line_items[0][price_data][product_data][name]", input.description);
      form.set("line_items[0][quantity]", "1");
    }
    form.set("success_url", input.returnUrl);
    form.set("cancel_url", input.returnUrl);
    form.set("client_reference_id", input.orderId);
    form.set("metadata[order_id]", input.orderId);
    form.set("payment_intent_data[metadata][order_id]", input.orderId);
    if (input.customerEmail) form.set("customer_email", input.customerEmail);
    form.set("expires_at", String(expiresAt));
    const { body } = await this.#call(
      "POST",
      "/v1/checkout/sessions",
      form,
      input.idempotencyKey,
      input.tax ? STRIPE_TAX_VERSION : undefined,
    );
    const ref = body.id;
    const url = body.url;
    if (typeof ref !== "string" || typeof url !== "string") {
      throw new Error("Stripe answered the checkout without an id or url.");
    }
    const expires = typeof body.expires_at === "number" ? body.expires_at : expiresAt;
    return { ref, url, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async getPayment(ref: string): Promise<PaymentsPayment> {
    const { body } = await this.#call(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(ref)}`,
      undefined,
      undefined,
    );
    return sessionToPayment(body, ref);
  }

  async refund(
    input: RefundInput,
  ): Promise<{ refundRef: string; status: "pending" | "succeeded" }> {
    // A period's refund already made, whose credit note is still owed (an earlier apply that
    // failed at the credit note): only the credit note is tried again (ADR 0486).
    const owedKey = `${CREDIT_NOTE_OWED}${input.refundId}`;
    const owed = input.invoiceRef ? this.#options.store?.get(owedKey) : undefined;
    if (owed) {
      await this.#creditNote(input, owed);
      this.#options.store?.put(owedKey, "");
      return { refundRef: owed, status: "pending" };
    }
    const form = new URLSearchParams();
    form.set("payment_intent", input.paymentRef);
    form.set("amount", String(input.amount));
    form.set("reason", "requested_by_customer");
    form.set("metadata[order_id]", input.orderId);
    form.set("metadata[cos_refund_id]", input.refundId);
    form.set("metadata[reason]", input.reason.slice(0, MAX_METADATA_VALUE));
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#call("POST", "/v1/refunds", form, input.refundId));
    } catch (error) {
      if (error instanceof StripeCallError) {
        if (error.outcome === "refused") {
          throw new ActionApplyError(
            `Stripe refused the refund, so nothing was refunded: ${error.message}`,
          );
        }
        // Rate limited: Stripe did nothing, and the idempotency key makes a later retry safe.
        if (error.outcome === "retry") throw new Error(`Stripe is busy: ${error.message}`);
        throw new ActionOutcomeUnknownError(
          `Stripe failed while refunding, so the refund may or may not have gone through: ${error.message}`,
        );
      }
      throw new ActionOutcomeUnknownError(
        "The refund request to Stripe failed, so it may or may not have gone through.",
      );
    }
    const refundRef = body.id;
    if (typeof refundRef !== "string") {
      throw new ActionOutcomeUnknownError(
        "Stripe answered the refund without an id, so it may or may not have gone through.",
      );
    }
    if (input.invoiceRef) {
      // Recorded before the credit note is asked for: if it fails, the refund is not made again.
      this.#options.store?.put(owedKey, refundRef);
      await this.#creditNote(input, refundRef);
      this.#options.store?.put(owedKey, "");
    }
    return { refundRef, status: body.status === "succeeded" ? "succeeded" : "pending" };
  }

  /**
   * A subscription period's refund is also credited on its invoice (ADR 0486): a credit note of
   * the refunded amount linked to the refund just made, so the credit note's `total_taxes` says
   * the tax it gave back, which a Refund never does. Stripe Tax already reduces the tax reported
   * for a refund on an invoice's payment; the credit note keeps that reduction even if the
   * refund later fails, and is the record of it.
   */
  async #creditNote(input: RefundInput, refundRef: string): Promise<void> {
    const form = new URLSearchParams();
    form.set("invoice", input.invoiceRef as string);
    form.set("amount", String(input.amount));
    form.set("refunds[0][refund]", refundRef);
    form.set("refunds[0][amount_refunded]", String(input.amount));
    form.set("metadata[order_id]", input.orderId);
    form.set("metadata[cos_refund_id]", input.refundId);
    try {
      await this.#call(
        "POST",
        "/v1/credit_notes",
        form,
        `${input.refundId}-credit-note`,
        STRIPE_BILLING_VERSION,
      );
    } catch (error) {
      // The money has gone back; the invoice's credit note is owed. A plain error keeps the
      // action pending, so applying it again sends only the credit note (its own idempotency key;
      // the refund is remembered above and not made again).
      throw new Error(
        "The refund went through; its credit note on the invoice is still owed and is tried again " +
          `when this is applied again${error instanceof StripeCallError ? ` (${error.message})` : ""}.`,
      );
    }
  }

  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook> {
    return verifyStripeWebhook(this.#options.webhookSecret, headers, body, nowSeconds);
  }

  // --- Subscriptions (stage 32a, ADR 0485) ----------------------------------------------------
  // Every call here sends STRIPE_BILLING_VERSION: the fields read below are where that version
  // puts them (docs.stripe.com/api, read 2026-11-22).

  async createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS;
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    const p = "line_items[0]";
    form.set(`${p}[price_data][currency]`, input.currency.toLowerCase());
    form.set(`${p}[price_data][unit_amount]`, String(input.amount));
    form.set(`${p}[price_data][recurring][interval]`, input.interval);
    form.set(`${p}[price_data][product_data][name]`, input.description);
    form.set(`${p}[quantity]`, "1");
    if (input.tax) {
      // Tax on every invoice, inside the price; the billing address sets the rate.
      form.set(`${p}[price_data][tax_behavior]`, "inclusive");
      form.set(`${p}[price_data][product_data][tax_code]`, input.tax.taxCode);
      form.set("automatic_tax[enabled]", "true");
      form.set("billing_address_collection", "required");
    }
    // The card is taken on the page even when nothing is charged until a trial ends.
    form.set("payment_method_collection", "always");
    form.set("subscription_data[metadata][cos_subscription]", input.subscriptionId);
    form.set("subscription_data[billing_mode][type]", "flexible");
    if (input.trialDays !== undefined) {
      form.set("subscription_data[trial_period_days]", String(input.trialDays));
    }
    if (input.trialEnd !== undefined) {
      form.set(
        "subscription_data[trial_end]",
        String(Math.floor(Date.parse(input.trialEnd) / 1000)),
      );
    }
    if (input.trialDays !== undefined || input.trialEnd !== undefined) {
      // A card gone by the trial's end ends the subscription instead of an unpaid invoice.
      form.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel");
    }
    form.set("metadata[cos_subscription]", input.subscriptionId);
    form.set("success_url", input.returnUrl);
    form.set("cancel_url", input.returnUrl);
    if (input.customerRef) form.set("customer", input.customerRef);
    else if (input.customerEmail) form.set("customer_email", input.customerEmail);
    form.set("expires_at", String(expiresAt));
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#call(
        "POST",
        "/v1/checkout/sessions",
        form,
        input.idempotencyKey,
        STRIPE_BILLING_VERSION,
      ));
    } catch (error) {
      // The payer's earlier provider customer is gone (deleted in Stripe): start with a new one
      // from their email rather than refuse every start from now on.
      const missing =
        error instanceof StripeCallError &&
        error.code === "resource_missing" &&
        (error.param === null || error.param === "customer");
      if (!missing || !input.customerRef || !input.customerEmail) throw error;
      form.delete("customer");
      form.set("customer_email", input.customerEmail);
      ({ body } = await this.#call(
        "POST",
        "/v1/checkout/sessions",
        form,
        `${input.idempotencyKey}:new-customer`,
        STRIPE_BILLING_VERSION,
      ));
    }
    const ref = body.id;
    const url = body.url;
    if (typeof ref !== "string" || typeof url !== "string") {
      throw new Error("Stripe answered the checkout without an id or url.");
    }
    const expires = typeof body.expires_at === "number" ? body.expires_at : expiresAt;
    return { ref, url, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async getSubscription(ref: string): Promise<PaymentsSubscription> {
    const { body } = await this.#call(
      "GET",
      `/v1/subscriptions/${encodeURIComponent(ref)}`,
      undefined,
      undefined,
      STRIPE_BILLING_VERSION,
    );
    const read = stripeSubscriptionRead(body, new Date().toISOString());
    if (!read) throw new Error("Stripe answered the subscription in a shape this cannot read.");
    return read;
  }

  async getSubscriptionCheckout(ref: string): Promise<"open" | "complete" | "expired"> {
    // A Checkout Session's `status`: open, complete or expired (docs.stripe.com/api/checkout/
    // sessions/object). Anything else is not read as an answer.
    const { body } = await this.#call(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(ref)}`,
      undefined,
      undefined,
      STRIPE_BILLING_VERSION,
    );
    const status = (body as { status?: unknown }).status;
    if (status === "open" || status === "complete" || status === "expired") return status;
    throw new Error("Stripe answered the checkout session without a status this can read.");
  }

  async cancelSubscription(input: PaymentsCancelSubscriptionInput): Promise<void> {
    const path = `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`;
    // One key per subscription and `when` (staff's "end it now"), or per ask when the caller
    // gives one (a cooling off's: a member trying again is a new request, not a replay).
    const key = input.askKey
      ? `cos-cancel-${input.subscriptionId}-${input.when}-${input.askKey}`
      : `cos-cancel-${input.subscriptionId}-${input.when}`;
    if (input.when === "now") {
      // Nothing is invoiced or credited for the rest of the period: a refund is its own step.
      const form = new URLSearchParams();
      form.set("cancellation_details[comment]", input.reason.slice(0, MAX_METADATA_VALUE));
      await this.#change("DELETE", path, form, key);
      return;
    }
    const form = new URLSearchParams();
    form.set("cancel_at_period_end", "true");
    form.set("cancellation_details[comment]", input.reason.slice(0, MAX_METADATA_VALUE));
    // A fresh key per press: a cancel undone and asked again is a new request to Stripe.
    await this.#change("POST", path, form, `${key}-${Date.now()}`);
  }

  async resumeSubscription(input: PaymentsResumeSubscriptionInput): Promise<void> {
    const form = new URLSearchParams();
    form.set("cancel_at_period_end", "false");
    await this.#change(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`,
      form,
      `cos-resume-${input.subscriptionId}-${Date.now()}`,
    );
  }

  /**
   * A new price on the subscription's one item (stage 32b, ADR 0530; docs.stripe.com/billing/
   * subscriptions/change-price, pending-updates and prorations, read 2026-11-22).
   * - `now` (an upgrade): a Price is made on the item's own product (a pending update takes
   *   `items[].price`, not `price_data`), then the item is moved to it with
   *   `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete`: the rest of
   *   the period is invoiced at once, and the change applies only once that invoice is paid.
   * - `next_period` (a downgrade): `items[].price_data` on the same product with
   *   `proration_behavior=none`: nothing is credited or charged now, the next invoice is the new
   *   price.
   * The item's id is required (without it Stripe adds a second item), and its quantity is sent
   * as 1 (a price change resets it to 1 anyway).
   */
  async changeSubscription(input: PaymentsChangeSubscriptionInput): Promise<void> {
    // Items changed under an attached schedule may make a phase, and a phase change discards a
    // pending update and voids its invoice (docs.stripe.com/billing/subscriptions/pending-updates):
    // a schedule left by a pause that ran its course is released first; one with a pause still to
    // come refuses the change, nothing changed.
    await this.#releaseFinishedSchedule(input.subscriptionRef, `change-${input.changeId}`);
    const path = `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}`;
    const item = await this.#item(input.subscriptionRef);
    const form = new URLSearchParams();
    form.set("items[0][id]", item.id);
    form.set("items[0][quantity]", "1");
    if (input.when === "now") {
      const price = new URLSearchParams();
      price.set("currency", input.currency.toLowerCase());
      price.set("unit_amount", String(input.amount));
      price.set("product", item.product);
      price.set("recurring[interval]", input.interval);
      if (input.taxed) price.set("tax_behavior", "inclusive");
      price.set("metadata[cos_change]", input.changeId);
      let priceId: string | null = null;
      try {
        const { body } = await this.#call(
          "POST",
          "/v1/prices",
          price,
          `cos-change-price-${input.changeId}`,
          STRIPE_BILLING_VERSION,
        );
        priceId = stringOrNull(body.id);
      } catch (error) {
        // A price alone charges nothing: whatever went wrong, the subscription did not change.
        throw new ActionApplyError(
          `Stripe did not make the new price, so nothing changed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (priceId === null) {
        throw new ActionApplyError("Stripe answered the new price without an id: nothing changed.");
      }
      form.set("items[0][price]", priceId);
      form.set("proration_behavior", "always_invoice");
      form.set("payment_behavior", "pending_if_incomplete");
    } else {
      form.set("items[0][price_data][currency]", input.currency.toLowerCase());
      form.set("items[0][price_data][product]", item.product);
      form.set("items[0][price_data][unit_amount]", String(input.amount));
      form.set("items[0][price_data][recurring][interval]", input.interval);
      if (input.taxed) form.set("items[0][price_data][tax_behavior]", "inclusive");
      form.set("proration_behavior", "none");
    }
    await this.#change("POST", path, form, `cos-change-${input.changeId}`);
  }

  /**
   * The provider's pause, set as a pause schedule so the provider resumes it on its own (stage
   * 32b, ADR 0531; docs.stripe.com/billing/subscriptions/pause and pause/schedules, read
   * 2026-11-22): a schedule is made from the subscription, then given one pause schedule,
   * `pause_at` now or a moment and `resume_at` the moment it ends (the resume's defaults: the
   * billing cycle anchored at the resume, and resumed only once its payment succeeds). Status
   * `paused`, not `pause_collection` (which keeps it active). If the second call is refused, the
   * schedule is released again, so nothing changed.
   */
  async pauseSubscription(input: PaymentsPauseSubscriptionInput): Promise<void> {
    // A schedule left by an earlier pause that ran its course is released first (a subscription
    // holds one schedule); one with a pause still to come refuses this one.
    await this.#releaseFinishedSchedule(input.subscriptionRef, `pause-${input.pauseId}`);
    const made = new URLSearchParams();
    made.set("from_subscription", input.subscriptionRef);
    let scheduleId: string | null = null;
    try {
      const { body } = await this.#call(
        "POST",
        "/v1/subscription_schedules",
        made,
        `cos-pause-schedule-${input.pauseId}`,
        STRIPE_BILLING_VERSION,
      );
      scheduleId = stringOrNull(body.id);
    } catch (error) {
      if (error instanceof StripeCallError && error.outcome === "refused") {
        throw new ActionApplyError(
          `Stripe refused the pause, so nothing changed: ${error.message}`,
        );
      }
      throw new ActionOutcomeUnknownError(
        "The request to Stripe failed, so a schedule may or may not have been attached.",
      );
    }
    if (scheduleId === null) {
      throw new ActionOutcomeUnknownError("Stripe answered the schedule without an id.");
    }
    const form = new URLSearchParams();
    const at = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
    form.set("pause_schedules[0][key]", input.pauseId);
    if (input.from) {
      form.set("pause_schedules[0][pause][pause_at][type]", "timestamp");
      form.set("pause_schedules[0][pause][pause_at][timestamp]", at(input.from));
    } else {
      form.set("pause_schedules[0][pause][pause_at][type]", "now");
    }
    form.set("pause_schedules[0][resume][resume_at][type]", "timestamp");
    form.set("pause_schedules[0][resume][resume_at][timestamp]", at(input.until));
    form.set("metadata[cos_pause]", input.pauseId);
    const path = `/v1/subscription_schedules/${encodeURIComponent(scheduleId)}`;
    try {
      await this.#call("POST", path, form, `cos-pause-${input.pauseId}`, STRIPE_BILLING_VERSION);
    } catch (error) {
      if (error instanceof StripeCallError && error.outcome === "refused") {
        try {
          await this.#change(
            "POST",
            `${path}/release`,
            new URLSearchParams(),
            `cos-pause-release-${input.pauseId}`,
          );
        } catch {
          // The pause was refused, and the schedule made for it may still be attached: not a clean
          // refusal (review of 32b), so the host keeps it open and staff can withdraw it.
          throw new ActionOutcomeUnknownError(
            "Stripe refused the pause, and the schedule made for it could not be released: it may still be attached.",
          );
        }
        throw new ActionApplyError(
          `Stripe refused the pause, so nothing changed: ${error.message}`,
        );
      }
      throw new ActionOutcomeUnknownError(
        "The request to Stripe failed, so the subscription may or may not be paused.",
      );
    }
  }

  /**
   * Ends a pause now, or withdraws one not yet started (stage 32b review; docs.stripe.com/billing/
   * subscriptions/pause/schedules and api/subscriptions/resume, read 2026-11-22). Each step follows
   * a fresh read, so a call that stopped half way is finished by calling again (each attempt has its
   * own idempotency key: the read, not the key, keeps a step from repeating):
   * - paused, by its schedule's pause: the pause schedule is updated with its `key` and
   *   `resume[resume_at][type]=now` (the guide's "start a resume attempt immediately": Stripe starts
   *   the resume during the update, with the schedule's resume settings, resumed only once its
   *   payment succeeds; a failed payment leaves it paused). One call: nothing is released first, so
   *   nothing is left half done;
   * - paused with no schedule (released elsewhere): `POST /v1/subscriptions/:id/resume` with
   *   `billing_cycle_anchor[type]=now` (an object with `type`, as the reference's example sends it)
   *   and `payment_behavior=resume_on_payment_success`;
   * - not paused, with a schedule (a pause not yet started): the pause schedule is cleared
   *   (`pause_schedules=""`, the reference's way to clear it), then the schedule is released; a
   *   release that fails after the clear leaves the pause withdrawn and is ignored.
   * Not paused and no schedule: nothing to end, refused.
   */
  async unpauseSubscription(input: PaymentsUnpauseSubscriptionInput): Promise<void> {
    const ref = encodeURIComponent(input.subscriptionRef);
    const { body } = await this.#read(`/v1/subscriptions/${ref}?expand[]=latest_invoice`);
    const schedule = idOf(body.schedule);
    const attempt = `${input.pauseId}-${crypto.randomUUID()}`;
    if (body.status === "paused") {
      const form = new URLSearchParams();
      if (schedule !== null) {
        form.set("pause_schedules[0][key]", input.pauseId);
        form.set("pause_schedules[0][resume][resume_at][type]", "now");
        await this.#change(
          "POST",
          `/v1/subscription_schedules/${encodeURIComponent(schedule)}`,
          form,
          `cos-unpause-${attempt}`,
        );
        return;
      }
      // A resume already asked and waiting for its payment (an open latest invoice) is not asked
      // again: said, nothing changed (review of 32b).
      const latest = metadataOf(body.latest_invoice);
      if (stringOrNull(latest.status) === "open") {
        throw new ActionApplyError(
          "A resume is waiting for its payment at Stripe, so nothing changed: the payer pays it, or it is voided.",
        );
      }
      form.set("billing_cycle_anchor[type]", "now");
      form.set("payment_behavior", "resume_on_payment_success");
      await this.#change("POST", `/v1/subscriptions/${ref}/resume`, form, `cos-unpause-${attempt}`);
      return;
    }
    if (schedule === null) {
      throw new ActionApplyError(
        "The subscription is not paused and no pause is scheduled: nothing changed.",
      );
    }
    const clear = new URLSearchParams();
    clear.set("pause_schedules", "");
    await this.#change(
      "POST",
      `/v1/subscription_schedules/${encodeURIComponent(schedule)}`,
      clear,
      `cos-unpause-clear-${attempt}`,
    );
    try {
      await this.#change(
        "POST",
        `/v1/subscription_schedules/${encodeURIComponent(schedule)}/release`,
        new URLSearchParams(),
        `cos-unpause-release-${attempt}`,
      );
    } catch {
      // The pause is withdrawn already; a schedule left attached shows as a refusal of a later change.
    }
  }

  /**
   * Cancels an upgrade's pending update (review of 32b): Stripe's way is to void the invoice the
   * update made (docs.stripe.com/billing/subscriptions/pending-updates: "To cancel a pending
   * update, you need to void the invoice the update created", found as the subscription's
   * `latest_invoice`; docs.stripe.com/api/invoices/void: `POST /v1/invoices/:id/void`, finalized
   * invoices only, "This cannot be undone"). With no update pending there is nothing to do (voided or
   * expired already; one paid shows in the read). Refused, nothing changed, when the subscription is
   * not active or its latest invoice is not an open subscription-update invoice.
   */
  async voidPendingUpdate(input: PaymentsVoidUpdateInput): Promise<void> {
    const { body } = await this.#read(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionRef)}?expand[]=latest_invoice`,
    );
    // Nothing pending: the upgrade was voided already or expired (one paid shows in the read), so
    // the withdraw has nothing left to do (round three).
    if (!body.pending_update) return;
    const latest = metadataOf(body.latest_invoice);
    const invoice = stringOrNull(latest.id);
    // Only an active subscription's update invoice: a paused one waiting to resume also has a
    // pending update, whose latest invoice is the resumption invoice (round three).
    if (
      body.status !== "active" ||
      invoice === null ||
      stringOrNull(latest.status) !== "open" ||
      stringOrNull(latest.billing_reason) !== "subscription_update"
    ) {
      throw new ActionApplyError(
        "The pending update at Stripe is not an active subscription's open upgrade invoice, so nothing changed.",
      );
    }
    // A fresh key each attempt: a retry follows this fresh read, never a cached failure.
    await this.#change(
      "POST",
      `/v1/invoices/${encodeURIComponent(invoice)}/void`,
      new URLSearchParams(),
      `cos-void-${input.changeId}-${crypto.randomUUID()}`,
    );
  }

  /**
   * Releases a subscription's schedule when it holds only pauses that have run their course
   * (resumed: `pause_schedules[].resume.status.type` `succeeded`, or no pause left), as the pause
   * guide advises once a resume succeeds. A schedule with a pause still to come, or one this host
   * did not make, refuses what was asked (nothing changed).
   */
  async #releaseFinishedSchedule(subscriptionRef: string, key: string): Promise<void> {
    const { body } = await this.#read(
      `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}?expand[]=schedule`,
    );
    const schedule = metadataOf(body.schedule);
    const scheduleId = idOf(body.schedule);
    if (scheduleId === null) return;
    const pauses = Array.isArray(schedule.pause_schedules) ? schedule.pause_schedules : [];
    const ours = stringOrNull(metadataOf(schedule.metadata).cos_pause) !== null;
    const finished = pauses.every(
      (p) => stringOrNull(metadataOf(metadataOf(metadataOf(p).resume).status).type) === "succeeded",
    );
    if (!ours || !finished || body.status === "paused") {
      throw new ActionApplyError(
        "The subscription has a schedule at Stripe with a pause not over (or one this host did not make), so nothing changed: end or withdraw the pause first.",
      );
    }
    await this.#change(
      "POST",
      `/v1/subscription_schedules/${encodeURIComponent(scheduleId)}/release`,
      new URLSearchParams(),
      `cos-release-${key}`,
    );
  }

  /** The subscription's one item: its id and its product's. */
  async #item(subscriptionRef: string): Promise<{ id: string; product: string }> {
    const { body } = await this.#read(`/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`);
    const items = metadataOf(body.items).data;
    if (!Array.isArray(items) || items.length !== 1) {
      throw new ActionApplyError(
        "The subscription does not have exactly one item: nothing changed.",
      );
    }
    const item = metadataOf(items[0]);
    const id = stringOrNull(item.id);
    const product = idOf(metadataOf(item.price).product);
    if (id === null || product === null) {
      throw new ActionApplyError("The subscription's item could not be read: nothing changed.");
    }
    return { id, product };
  }

  /** A read before a change: any failure is a refusal, since nothing has been sent yet. */
  async #read(path: string): Promise<StripeResponse> {
    try {
      return await this.#call("GET", path, undefined, undefined, STRIPE_BILLING_VERSION);
    } catch (error) {
      throw new ActionApplyError(
        `Stripe could not be read, so nothing changed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async openPortal(input: PaymentsPortalInput): Promise<{ url: string }> {
    const form = new URLSearchParams();
    form.set("customer", input.customerRef);
    form.set("return_url", input.returnUrl);
    form.set("configuration", await this.#portalConfiguration());
    const { body } = await this.#call(
      "POST",
      "/v1/billing_portal/sessions",
      form,
      undefined,
      STRIPE_BILLING_VERSION,
    );
    const url = stringOrNull(body.url);
    if (url === null) throw new Error("Stripe answered the portal session without a url.");
    return { url };
  }

  /**
   * The current subscription (and invoice) a verified event names, read now (ADR 0485). Null when
   * the subscription cannot be read in a shape this understands.
   */
  async readSubscriptionEvent(
    eventId: string,
    read: PendingRead,
  ): Promise<{ event: PaymentsEvent } | { ignored: "foreign" | "unreadable" }> {
    const { body: raw } = await this.#call(
      "GET",
      `/v1/subscriptions/${encodeURIComponent(read.subscriptionRef)}`,
      undefined,
      undefined,
      STRIPE_BILLING_VERSION,
    );
    // Whose it is comes from the read, never the payload: a subscription this host did not start
    // (no `cos_subscription`) is someone else's in the same account, ignored, never retried.
    if (stringOrNull(metadataOf(raw.metadata).cos_subscription) === null) {
      return { ignored: "foreign" };
    }
    // A shape this cannot read (a tiered, metered or decimal price) will not read better on a
    // redelivery: ignored and counted, so Stripe does not retry it until it disables the endpoint.
    const subscription = stripeSubscriptionRead(raw, new Date().toISOString());
    if (!subscription) return { ignored: "unreadable" };
    let invoice: PaymentsInvoice | undefined;
    if (read.invoiceRef) {
      const { body } = await this.#call(
        "GET",
        `/v1/invoices/${encodeURIComponent(read.invoiceRef)}?expand[]=payments`,
        undefined,
        undefined,
        STRIPE_BILLING_VERSION,
      );
      const mapped = stripeInvoiceRead(body);
      if (!mapped) return { ignored: "unreadable" };
      invoice = mapped;
    }
    const event = subscriptionEvent(
      "stripe",
      eventId,
      read.trigger,
      subscription,
      invoice,
      read.occurredAt,
    );
    return event ? { event } : { ignored: "unreadable" };
  }

  /**
   * The portal configuration this gatekeeper uses: the card, billing details and past invoices
   * on; cancelling, plan changes and pauses off, so those go through the host's operations
   * (decision 5). Made once, then reused from the facet's store.
   */
  async #portalConfiguration(): Promise<string> {
    const cached = this.#options.store?.get(PORTAL_CONFIGURATION_KEY);
    if (cached) return cached;
    const form = new URLSearchParams();
    form.set("features[payment_method_update][enabled]", "true");
    form.set("features[invoice_history][enabled]", "true");
    form.set("features[customer_update][enabled]", "true");
    for (const [i, update] of ["address", "email", "name", "tax_id"].entries()) {
      form.set(`features[customer_update][allowed_updates][${i}]`, update);
    }
    form.set("features[subscription_cancel][enabled]", "false");
    form.set("features[subscription_update][enabled]", "false");
    form.set("features[subscription_pause][enabled]", "false");
    form.set("metadata[cos]", "portal-v1");
    const { body } = await this.#call(
      "POST",
      "/v1/billing_portal/configurations",
      form,
      `cos-portal-configuration-v1-${this.#options.account || "own"}`,
      STRIPE_BILLING_VERSION,
    );
    const id = stringOrNull(body.id);
    if (id === null) throw new Error("Stripe answered the portal configuration without an id.");
    this.#options.store?.put(PORTAL_CONFIGURATION_KEY, id);
    return id;
  }

  /** A change to a subscription, with the refund's rules for what a failure means. */
  async #change(
    method: "POST" | "DELETE",
    path: string,
    form: URLSearchParams,
    key: string,
  ): Promise<void> {
    try {
      await this.#call(method, path, form, key, STRIPE_BILLING_VERSION);
    } catch (error) {
      if (error instanceof StripeCallError) {
        if (error.outcome === "refused") {
          throw new ActionApplyError(
            `Stripe refused the change, so nothing changed: ${error.message}`,
          );
        }
        if (error.outcome === "retry") throw new Error(`Stripe is busy: ${error.message}`);
        throw new ActionOutcomeUnknownError(
          `Stripe failed while changing the subscription, so it may or may not have changed: ${error.message}`,
        );
      }
      throw new ActionOutcomeUnknownError(
        "The request to Stripe failed, so the subscription may or may not have changed.",
      );
    }
  }

  /**
   * The tax Stripe calculated on each line of a paid, taxed Checkout Session, by the `cos_line`
   * the checkout gave its product. The session's webhook carries only the total
   * (`total_details.amount_tax`); the lines are read from the session's line items.
   */
  async taxLines(sessionRef: string): Promise<{ ref: string; amount: number }[]> {
    const { body } = await this.#call(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(sessionRef)}/line_items?limit=100&expand[]=data.price.product`,
      undefined,
      undefined,
      STRIPE_TAX_VERSION,
    );
    const data = Array.isArray(body.data) ? body.data : [];
    const lines: { ref: string; amount: number }[] = [];
    for (const item of data) {
      const row = metadataOf(item);
      const product = metadataOf(metadataOf(row.price).product);
      const ref = stringOrNull(metadataOf(product.metadata).cos_line);
      const amount = nonNegativeInteger(row.amount_tax);
      if (ref === null || amount === null) {
        throw new Error("Stripe answered a taxed session's line items without their tax.");
      }
      lines.push({ ref, amount });
    }
    return lines;
  }

  /** The tax location (type `performance`) of an event's address, made once and then reused. */
  async #taxLocation(place: PaymentsTaxPlace): Promise<string> {
    const key = `taxloc:${JSON.stringify([place.country, place.region ?? "", place.postcode ?? "", place.city ?? "", place.line1 ?? ""])}`;
    const cached = this.#options.taxLocations?.get(key);
    if (cached) return cached;
    const form = new URLSearchParams();
    form.set("type", "performance");
    form.set("address[country]", place.country);
    if (place.region) form.set("address[state]", place.region);
    if (place.postcode) form.set("address[postal_code]", place.postcode);
    if (place.city) form.set("address[city]", place.city);
    if (place.line1) form.set("address[line1]", place.line1);
    const { body } = await this.#call(
      "POST",
      "/v1/tax/locations",
      form,
      await idempotencyOf(key),
      STRIPE_TAX_VERSION,
    );
    const id = stringOrNull(body.id);
    if (id === null) throw new Error("Stripe answered the tax location without an id.");
    this.#options.taxLocations?.put(key, id);
    return id;
  }

  async #call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    form: URLSearchParams | undefined,
    idempotencyKey: string | undefined,
    version?: string,
  ): Promise<StripeResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.secretKey}`,
      accept: "application/json",
    };
    if (form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (version) headers["stripe-version"] = version;
    if (this.#options.account) headers["stripe-account"] = this.#options.account;
    const doFetch = this.#options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.#options.apiBase}${path}`, {
        method,
        headers,
        ...(form ? { body: form.toString() } : {}),
      });
    } catch {
      throw new StripeCallError("the request did not complete", "unknown");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // An unreadable body is judged by its status alone.
    }
    if (response.ok) return { status: response.status, body };
    const detail = stripeErrorSummary(response.status, body);
    if (response.status === 429) throw new StripeCallError(detail, "retry");
    if (response.status >= 400 && response.status < 500) {
      const error = metadataOf(body.error);
      throw new StripeCallError(
        detail,
        "refused",
        typeof error.code === "string" ? error.code.slice(0, 60) : null,
        typeof error.param === "string" ? error.param.slice(0, 60) : null,
      );
    }
    throw new StripeCallError(detail, "unknown");
  }
}

/**
 * Stripe's error type and code, never its message: a message can quote the request, which may
 * carry an email address.
 */
function stripeErrorSummary(status: number, body: Record<string, unknown>): string {
  const error = body.error;
  const parts = [`HTTP ${status}`];
  if (error && typeof error === "object") {
    const { type, code } = error as { type?: unknown; code?: unknown };
    if (typeof type === "string") parts.push(type.slice(0, 60));
    if (typeof code === "string") parts.push(code.slice(0, 60));
  }
  return parts.join(", ");
}

/** A stable idempotency key for `text`: the hex SHA-256 of it. */
async function idempotencyOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A field that is an id string, or an expanded object with an id. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return stringOrNull(value);
  if (value && typeof value === "object" && "id" in value) {
    return stringOrNull((value as { id: unknown }).id);
  }
  return null;
}

function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function currencyOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

/** A Checkout Session as a PaymentsPayment. */
export function sessionToPayment(session: Record<string, unknown>, ref: string): PaymentsPayment {
  const status: PaymentsPayment["status"] =
    session.payment_status === "paid" ? "paid" : session.status === "expired" ? "expired" : "open";
  const metadata = metadataOf(session.metadata);
  return {
    provider: "stripe",
    ref: stringOrNull(session.id) ?? ref,
    status,
    orderId: stringOrNull(session.client_reference_id) ?? stringOrNull(metadata.order_id),
    amount: nonNegativeInteger(session.amount_total) ?? 0,
    currency: currencyOf(session.currency) ?? "",
    paymentRef: idOf(session.payment_intent),
  };
}

/** A taxed payment whose tax Stripe did not report: answered 500, so Stripe delivers it again. */
export class StripeTaxReportError extends Error {}

/**
 * Fills in each line's tax on a taxed payment event, from the session's line items. Throws when
 * they cannot be read, so the delivery is answered with an error and Stripe retries it.
 */
export async function withStripeTaxLines(
  event: PaymentsEvent,
  read: (sessionRef: string) => Promise<{ ref: string; amount: number }[]>,
): Promise<PaymentsEvent> {
  if (event.kind !== "payment" || !event.tax) return event;
  const lines = await read(event.checkoutRef);
  return { ...event, tax: { ...event.tax, lines } };
}

/** Verifies a Stripe webhook delivery and maps the event it carries. */
export async function verifyStripeWebhook(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const check = await verifySignatureHeader(secret, headers["stripe-signature"], body, nowSeconds);
  if (!check.ok) return check;
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  const parsed = metadataOf(event);
  const eventId = stringOrNull(parsed.id);
  if (eventId === null || eventId.length > 255) return { ok: false, reason: "malformed body" };
  let mapped: PaymentsEvent | null;
  try {
    mapped = mapStripeEvent(parsed, eventId);
  } catch (error) {
    if (error instanceof StripeTaxReportError) return { ok: false, reason: "retry", retry: true };
    throw error;
  }
  const read = stripeReadFor(parsed);
  return { ok: true, eventId, events: mapped ? [mapped] : [], ...(read ? { reads: [read] } : {}) };
}

const SUBSCRIPTION_EVENT_TRIGGERS: Readonly<Record<string, PaymentsSubscriptionTrigger>> = {
  "customer.subscription.created": "created",
  "customer.subscription.updated": "updated",
  "customer.subscription.deleted": "deleted",
  "customer.subscription.paused": "paused",
  "customer.subscription.resumed": "resumed",
  "customer.subscription.trial_will_end": "trial_will_end",
  "invoice.paid": "invoice_paid",
  "invoice.payment_failed": "invoice_payment_failed",
  "invoice.payment_action_required": "invoice_action_required",
  "invoice.finalization_failed": "invoice_finalization_failed",
};

/**
 * The read a subscription event asks for (ADR 0485), or null for any other event: which
 * subscription (and invoice) to read now. Only the ids are taken from the payload, never its
 * fields, because the payload is shaped by the endpoint's API version. `invoice.payment_succeeded`
 * is not read: `invoice.paid` says the same and also covers an invoice paid another way.
 */
export function stripeReadFor(event: Record<string, unknown>): PendingRead | null {
  const type = typeof event.type === "string" ? event.type : "";
  const object = metadataOf(metadataOf(event.data).object);
  const created = nonNegativeInteger(event.created);
  const occurredAt = new Date(created !== null ? created * 1000 : Date.now()).toISOString();
  if (type === "checkout.session.completed" && object.mode === "subscription") {
    const subscriptionRef = idOf(object.subscription);
    return subscriptionRef
      ? { trigger: "checkout_completed", subscriptionRef, invoiceRef: null, occurredAt }
      : null;
  }
  const trigger = SUBSCRIPTION_EVENT_TRIGGERS[type];
  if (!trigger) return null;
  if (type.startsWith("customer.subscription.")) {
    const subscriptionRef = stringOrNull(object.id);
    return subscriptionRef ? { trigger, subscriptionRef, invoiceRef: null, occurredAt } : null;
  }
  // An invoice: its subscription is under parent.subscription_details since 2025-03-31.basil;
  // older endpoint versions put it at the top. One-off invoices have neither and are ignored.
  const details = metadataOf(metadataOf(object.parent).subscription_details);
  const subscriptionRef = idOf(details.subscription) ?? idOf(object.subscription);
  const invoiceRef = stringOrNull(object.id);
  return subscriptionRef && invoiceRef
    ? { trigger, subscriptionRef, invoiceRef, occurredAt }
    : null;
}

const seconds = (value: unknown): string | null => {
  const n = nonNegativeInteger(value);
  return n === null ? null : new Date(n * 1000).toISOString();
};

/** A Stripe Subscription (read with STRIPE_BILLING_VERSION) as a PaymentsSubscription. */
export function stripeSubscriptionRead(
  body: Record<string, unknown>,
  observedAt: string,
): PaymentsSubscription | null {
  const ref = stringOrNull(body.id);
  const status = body.status as PaymentsSubscriptionStatus;
  if (ref === null || !SUBSCRIPTION_STATUSES.includes(status)) return null;
  const items = metadataOf(body.items).data;
  const item = metadataOf(Array.isArray(items) ? items[0] : undefined);
  const price = metadataOf(item.price);
  const recurring = metadataOf(price.recurring);
  const interval = recurring.interval;
  const amount = nonNegativeInteger(price.unit_amount);
  const currency = currencyOf(price.currency) ?? currencyOf(body.currency);
  if (amount === null || currency === null) return null;
  const reason = stringOrNull(metadataOf(body.cancellation_details).reason);
  return {
    provider: "stripe",
    ref,
    customerRef: idOf(body.customer),
    subscriptionId: stringOrNull(metadataOf(body.metadata).cos_subscription),
    status,
    amount,
    currency,
    interval: interval === "week" || interval === "month" || interval === "year" ? interval : null,
    // `cancel_at_period_end` is deprecated in favour of `cancel_at` but still set and honoured
    // (changelog 2025-05-28.basil), and setting it false is Stripe's documented way to stop a
    // pending cancellation (docs.stripe.com/billing/subscriptions/cancel). A `cancel_at` date set
    // another way (the dashboard, a schedule) is reported apart: the host's resume cannot undo it.
    cancelAtPeriodEnd: body.cancel_at_period_end === true,
    cancelAt: body.cancel_at_period_end === true ? null : seconds(body.cancel_at),
    trialEnd: seconds(body.trial_end),
    // Since 2025-03-31.basil a subscription's period is on its items.
    currentPeriodStart: seconds(item.current_period_start),
    currentPeriodEnd: seconds(item.current_period_end),
    canceledAt: seconds(body.canceled_at),
    endedAt: seconds(body.ended_at),
    endReason: reason && /^[a-z_]{1,60}$/.test(reason) ? reason : null,
    observedAt,
  };
}

/** A Stripe Invoice (read with STRIPE_BILLING_VERSION and `expand[]=payments`). */
export function stripeInvoiceRead(body: Record<string, unknown>): PaymentsInvoice | null {
  const ref = stringOrNull(body.id);
  const status = stringOrNull(body.status);
  const amountPaid = nonNegativeInteger(body.amount_paid);
  const amountDue = nonNegativeInteger(body.amount_due);
  const currency = currencyOf(body.currency);
  if (ref === null || status === null || amountPaid === null || amountDue === null || !currency) {
    return null;
  }
  // The payment the money came in on: `payments` (InvoicePayment) since basil, the paid default.
  const payments = metadataOf(body.payments).data;
  const rows = Array.isArray(payments) ? payments.map(metadataOf) : [];
  const paidRow =
    rows.find((row) => row.status === "paid" && row.is_default === true) ??
    rows.find((row) => row.status === "paid");
  const paymentRef = paidRow ? idOf(metadataOf(paidRow.payment).payment_intent) : null;
  const lines = metadataOf(body.lines).data;
  const period = metadataOf(metadataOf(Array.isArray(lines) ? lines[0] : undefined).period);
  const taxed = metadataOf(body.automatic_tax).enabled === true;
  const taxes = Array.isArray(body.total_taxes) ? body.total_taxes.map(metadataOf) : [];
  let tax: PaymentsInvoice["tax"];
  if (taxed) {
    let sum = 0;
    for (const row of taxes) {
      const amount = nonNegativeInteger(row.amount);
      if (amount === null) return null;
      sum += amount;
    }
    const country = stringOrNull(metadataOf(body.customer_address).country);
    tax = { amount: sum, country: country && /^[A-Z]{2}$/.test(country) ? country : null };
  }
  const hosted = stringOrNull(body.hosted_invoice_url);
  return {
    ref,
    status: /^[a-z_]{1,60}$/.test(status) ? status : "unknown",
    amountPaid,
    amountDue,
    currency,
    paymentRef,
    periodStart: seconds(period.start) ?? seconds(body.period_start),
    periodEnd: seconds(period.end) ?? seconds(body.period_end),
    billingReason: stringOrNull(body.billing_reason),
    attemptCount: nonNegativeInteger(body.attempt_count) ?? 0,
    nextAttemptAt: seconds(body.next_payment_attempt),
    hostedUrl: hosted?.startsWith("https://") && hosted.length <= 2000 ? hosted : null,
    ...(tax ? { tax } : {}),
  };
}

/** The PaymentsEvent a Stripe event stands for, or null for one this gatekeeper ignores. */
export function mapStripeEvent(
  event: Record<string, unknown>,
  eventId: string,
): PaymentsEvent | null {
  const type = event.type;
  const data = metadataOf(event.data);
  const object = metadataOf(data.object);
  const created = nonNegativeInteger(event.created);
  const occurredAt = new Date(created !== null ? created * 1000 : Date.now()).toISOString();
  const metadata = metadataOf(object.metadata);

  // A subscription's checkout is read as the subscription it started (stripeReadFor), never as a
  // payment on an order.
  const paid =
    object.mode !== "subscription" &&
    ((type === "checkout.session.completed" && object.payment_status === "paid") ||
      type === "checkout.session.async_payment_succeeded");
  if (paid) {
    const orderId = stringOrNull(object.client_reference_id) ?? stringOrNull(metadata.order_id);
    const checkoutRef = stringOrNull(object.id);
    const amount = nonNegativeInteger(object.amount_total);
    const currency = currencyOf(object.currency);
    if (orderId === null || checkoutRef === null || amount === null || currency === null) {
      return null;
    }
    // A session opened with automatic tax: Stripe's own figure, `total_details.amount_tax`, and
    // the buyer's country. Each line's tax is read afterwards (StripeProvider.taxLines).
    const taxed = metadataOf(object.automatic_tax).enabled === true;
    const taxAmount = nonNegativeInteger(metadataOf(object.total_details).amount_tax);
    if (taxed && taxAmount === null) {
      throw new StripeTaxReportError("A taxed Checkout Session arrived without its tax amount.");
    }
    const country = stringOrNull(metadataOf(metadataOf(object.customer_details).address).country);
    return {
      ...(taxed
        ? {
            tax: {
              amount: taxAmount as number,
              country: country && /^[A-Z]{2}$/.test(country) ? country : null,
              lines: [],
            },
          }
        : {}),
      kind: "payment",
      provider: "stripe",
      eventId,
      orderId,
      checkoutRef,
      amount,
      currency,
      paymentRef: idOf(object.payment_intent),
      occurredAt,
    };
  }

  if ((type === "refund.created" || type === "refund.updated") && object.status === "succeeded") {
    const refundRef = stringOrNull(object.id);
    const amount = nonNegativeInteger(object.amount);
    const currency = currencyOf(object.currency);
    if (refundRef === null || amount === null || currency === null) return null;
    return {
      kind: "refund",
      provider: "stripe",
      eventId,
      orderId: stringOrNull(metadata.order_id),
      refundId: stringOrNull(metadata.cos_refund_id),
      refundRef,
      paymentRef: idOf(object.payment_intent),
      amount,
      currency,
      occurredAt,
    };
  }

  // A credit note with a refund (ADR 0486): the tax it gave back is its `total_taxes`. It reports
  // that tax against the refund it links to and confirms nothing (the refund's own event does).
  if (type === "credit_note.created") {
    // The payload is shaped by the endpoint's version: `refunds[]` and `total_taxes` since
    // 2025-03-31.basil, `refund` and `tax_amounts` before it.
    const refunds = Array.isArray(object.refunds)
      ? object.refunds.map(metadataOf)
      : object.refund
        ? [{ refund: object.refund, amount_refunded: object.refund_amount }]
        : [];
    const first = refunds[0];
    const refundRef = first ? idOf(first.refund) : null;
    const amount = first ? nonNegativeInteger(first.amount_refunded) : null;
    const currency = currencyOf(object.currency);
    const rawTaxes = Array.isArray(object.total_taxes) ? object.total_taxes : object.tax_amounts;
    const taxes = Array.isArray(rawTaxes) ? rawTaxes.map(metadataOf) : [];
    let tax = 0;
    for (const row of taxes) {
      const part = nonNegativeInteger(row.amount);
      if (part === null) return null;
      tax += part;
    }
    if (refunds.length !== 1 || refundRef === null || !amount || currency === null) return null;
    return {
      kind: "refund",
      provider: "stripe",
      eventId,
      orderId: stringOrNull(metadata.order_id),
      refundId: stringOrNull(metadata.cos_refund_id),
      refundRef,
      paymentRef: null,
      amount,
      currency,
      occurredAt,
      // No tax rows is "not said", never zero: the host keeps a refund's tax unknown then (to
      // check in test mode: whether an amount-only credit note on an automatic-tax invoice comes
      // back with `total_taxes` filled).
      ...(taxes.length > 0 ? { tax: { amount: tax } } : {}),
      creditNote: true,
    };
  }
  return null;
}
