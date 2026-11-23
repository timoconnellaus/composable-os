// A test double of the payments gatekeeper for the host's order tests (stage 25, ADR 0429; the
// real gatekeeper and its fake provider are driven end to end in apps/runner/test/payments.test.ts):
// it opens checkouts, sends the confirmation email, submits refunds to the approval queue exactly
// as the integration host submits one, and plays the provider delivering verified events.
import { env } from "cloudflare:workers";
import type { CrmDb } from "@composable-os/db";
import {
  applyStoredPaymentEvent,
  type IntegrationRuntime,
  type memoryEventSink,
  type PaymentsEvent,
  recordPaymentEvent,
  submitOutbound,
} from "../src/index.ts";
import { db, unique } from "./helpers.ts";
import { CURRENCY } from "./order-fixtures.ts";

export interface Gateway {
  checkouts: { ref: string; orderId: string; amount: number; currency: string }[];
  emails: { to: string[]; subject: string; text: string }[];
  refunds: Map<number, { orderId: string; paymentRef: string; amount: number; refundId: string }>;
  applied: number[];
  action: number;
  /** Subscription checkouts the host opened (stage 32a), with the ref the double gave each. */
  subscriptions: ({
    ref: string;
    subscriptionId: string;
    amount: number;
    currency: string;
  } & Record<string, unknown>)[];
  /** Cancel, resume and portal calls the host made. */
  changes: { method: string; request: Record<string, unknown> }[];
  /** Each subscription page's status at the provider (stage 32a review); `error`: not answered. */
  pages: Map<string, "open" | "complete" | "expired" | "error">;
  /** The pages the host asked about. */
  statusAsks: string[];
  /** What the next subscription checkout reports as its expiry (a test may make it malformed). */
  nextExpiresAt: unknown;
  /**
   * Stage 32b: how the next plan change, pause or unpause goes at the gatekeeper: applied (the
   * default), refused with nothing changed, an unknown outcome, or the call itself failing.
   */
  nextChange: "applied" | "refused" | "unknown" | "throw";
  /** Stage 44 step 7: how the next cancelSubscription goes at the gatekeeper (as nextChange). */
  nextCancel: "applied" | "refused" | "unknown" | "throw";
  /** Stage 32b second review: what the provider's subscription reads as (getSubscription). */
  providerReads: Map<string, Record<string, unknown>>;
  /** Run before the next plan change, pause or unpause answers (a verified read landing meanwhile). */
  beforeAnswer: (() => Promise<void>) | null;
  /** Stage 44: run once while a subscription checkout is being opened (a write racing the start). */
  beforeSubscribe: (() => Promise<void>) | null;
}

export interface PaymentsDouble {
  gw: Gateway;
  runtime: IntegrationRuntime;
  /** The payments connection the double's refunds are submitted through. */
  connectionId(): string;
  /** Creates the org's payments connection, owned by `ownerId`. Call once, before a refund. */
  connect(ownerId: string): Promise<void>;
  /** Stores a verified event and applies it, as the host's adapter does. */
  deliver(event: PaymentsEvent): ReturnType<typeof applyAndReturn>;
  /** Plays the provider: the gatekeeper verified a payment of the last checkout for the order. */
  providerPays(
    orderId: string,
    amount?: number,
    currency?: string,
  ): ReturnType<typeof applyAndReturn>;
  /** Plays the provider confirming refund action `action` by webhook. */
  providerRefunds(action: number, amount?: number): ReturnType<typeof applyAndReturn>;
}

type Events = ReturnType<typeof memoryEventSink>;

async function applyAndReturn(
  runtime: IntegrationRuntime,
  events: Events,
  connectionId: string,
  event: PaymentsEvent,
  crm: CrmDb,
) {
  const key = await recordPaymentEvent(db, event, connectionId, new Date().toISOString());
  if (!key) throw new Error("not stored");
  const result = await applyStoredPaymentEvent(
    { crm, integrations: runtime, events, appOrigin: "https://crm.example.com" },
    key,
  );
  return { event, result };
}

/** A fresh double. `events` gives the event sink of the test running now; `crm` the database the
 * host applies events with (a test may count what it writes). */
export function paymentsDouble(events: () => Events, crm: () => CrmDb = () => db): PaymentsDouble {
  const gw: Gateway = {
    checkouts: [],
    emails: [],
    refunds: new Map(),
    applied: [],
    action: 0,
    subscriptions: [],
    changes: [],
    pages: new Map(),
    statusAsks: [],
    nextExpiresAt: null,
    nextChange: "applied",
    nextCancel: "applied",
    providerReads: new Map(),
    beforeAnswer: null,
    beforeSubscribe: null,
  };
  let connectionId = "";
  const no = () => Promise.reject(new Error("not used in this test"));
  const runtime: IntegrationRuntime = {
    availableVendors: async () => ["payments"],
    startConnect: no,
    provision: no,
    redeem: no,
    reconnect: no,
    disconnect: no,
    bindResource: no,
    unbindResource: no,
    configure: no,
    supportedResources: no,
    types: no,
    setSync: no,
    syncNow: no,
    async callAsHost(input) {
      if (input.method === "createCheckout") {
        const request = input.args[0] as { orderId: string; amount: number; currency: string };
        const ref = `fcs_${unique("c")}`;
        gw.checkouts.push({ ref, ...request });
        return {
          value: { provider: "fake", ref, url: `https://pay.example/${ref}`, expiresAt: null },
          pending: [],
          applied: [],
        };
      }
      // Stage 32a (ADR 0485): the host's own subscription calls.
      if (input.method === "createSubscriptionCheckout") {
        const request = input.args[0] as Gateway["subscriptions"][number];
        if (gw.beforeSubscribe) {
          const hook = gw.beforeSubscribe;
          gw.beforeSubscribe = null;
          await hook();
        }
        const ref = `fcs_${unique("s")}`;
        gw.subscriptions.push({ ...request, ref });
        gw.pages.set(ref, "open");
        const expiresAt = gw.nextExpiresAt;
        gw.nextExpiresAt = null;
        return {
          value: { provider: "fake", ref, url: `https://pay.example/${ref}`, expiresAt },
          pending: [],
          applied: [],
        };
      }
      // Stage 32a review: whether a page is open, completed or expired, as the test sets it.
      if (input.method === "getSubscriptionCheckout") {
        const ref = String(input.args[0]);
        gw.statusAsks.push(ref);
        const status = gw.pages.get(ref) ?? "expired";
        if (status === "error") throw new Error("the provider did not answer");
        return { value: { ref, status }, pending: [], applied: [] };
      }
      if (input.method === "getSubscription") {
        const ref = String(input.args[0]);
        const read = gw.providerReads.get(ref);
        if (!read) throw new Error("the provider has no such subscription");
        return { value: read, pending: [], applied: [] };
      }
      if (
        input.method === "cancelSubscription" ||
        input.method === "resumeSubscription" ||
        input.method === "changeSubscription" ||
        input.method === "pauseSubscription" ||
        input.method === "unpauseSubscription" ||
        input.method === "voidPendingUpdate" ||
        input.method === "openPortal"
      ) {
        gw.changes.push({
          method: input.method,
          request: input.args[0] as Record<string, unknown>,
        });
        const changing =
          input.method === "changeSubscription" ||
          input.method === "pauseSubscription" ||
          input.method === "unpauseSubscription" ||
          input.method === "voidPendingUpdate";
        const cancelling = input.method === "cancelSubscription";
        const how = changing ? gw.nextChange : cancelling ? gw.nextCancel : "applied";
        if (changing) gw.nextChange = "applied";
        if (cancelling) gw.nextCancel = "applied";
        if (changing && gw.beforeAnswer) {
          const hook = gw.beforeAnswer;
          gw.beforeAnswer = null;
          await hook();
        }
        if (how === "throw") throw new Error("the gatekeeper did not answer");
        const action = {
          action: gw.changes.length,
          actionKind: `payments.${input.method}`,
          title: "x",
        };
        return {
          value:
            input.method === "openPortal"
              ? { url: "https://billing.example/portal" }
              : { status: how === "applied" ? "sent" : "pending", id: gw.changes.length },
          pending: [],
          applied: (changing || cancelling) && how !== "applied" ? [] : [action],
          ...(how === "refused"
            ? {
                failed: [
                  {
                    ...action,
                    outcome: "refused" as const,
                    message: "Refused by the provider.",
                  },
                ],
              }
            : how === "unknown"
              ? {
                  failed: [
                    {
                      ...action,
                      outcome: "unknown" as const,
                      message: "The provider did not answer.",
                    },
                  ],
                }
              : {}),
        };
      }
      if (input.method === "send") {
        gw.emails.push(input.args[0] as Gateway["emails"][number]);
        return {
          value: { status: "sent" },
          pending: [],
          applied: [{ action: 1, actionKind: "email.send", title: "x" }],
        };
      }
      throw new Error(`unexpected ${input.method}`);
    },
    // A refund: submitted to the approval queue exactly as the integration host submits one.
    async call(input) {
      if (input.method !== "refund") throw new Error(`unexpected ${input.method}`);
      const request = input.args[0] as Gateway["refunds"] extends Map<number, infer R> ? R : never;
      gw.action += 1;
      const action = gw.action;
      gw.refunds.set(action, request);
      const decision = await submitOutbound(db, {
        connectionId,
        connectionTitle: "Payments",
        vendor: "payments",
        facetKey: "merchant",
        resourceTitle: "Payments with Fake provider",
        action,
        description: {
          title: `Refund ${request.amount} on order ${request.orderId}`,
          description: "Refund a payment.",
          fields: [
            { label: "Payment", value: request.paymentRef },
            { label: "Amount", value: String(request.amount) },
          ],
          actionKind: { tag: "payments.refund", label: "Refund a payment" },
          autoApprovable: false,
          descriptionIsComplete: true,
        },
        actor: input.caller.actor,
        user: {
          id: input.caller.userId,
          email: "",
          name: input.caller.userName,
          role: input.caller.role,
        },
        origin: input.caller.origin,
      });
      return {
        value: { status: "pending", id: action },
        pending: decision.decision === "review" ? [decision.pending] : [],
        applied: [],
      };
    },
    async applyOutbound(input) {
      gw.applied.push(input.action);
    },
    rejectOutbound: async () => undefined,
  };

  const deliver = (event: PaymentsEvent) =>
    applyAndReturn(runtime, events(), connectionId, event, crm());

  return {
    gw,
    runtime,
    connectionId: () => connectionId,
    async connect(ownerId) {
      connectionId = `con_${unique("pay").toUpperCase()}`;
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'payments', 'org', ?, 'Payments', 'active', ?, ?, ?)",
      )
        .bind(
          connectionId,
          ownerId,
          JSON.stringify([
            {
              key: "merchant",
              url: "payments://merchant/fake",
              pattern: "payments://merchant/:provider",
              title: "Payments with Fake provider",
              tsType: "PaymentsSession",
              bindingName: "PAYMENTS",
            },
          ]),
          now,
          now,
        )
        .run();
    },
    deliver,
    providerPays(orderId, amount, currency = CURRENCY) {
      const opened = gw.checkouts.filter((c) => c.orderId === orderId).at(-1);
      if (!opened) throw new Error("no checkout");
      return deliver({
        kind: "payment",
        provider: "fake",
        eventId: `fevt_${unique("e")}`,
        orderId,
        checkoutRef: opened.ref,
        amount: amount ?? opened.amount,
        currency,
        paymentRef: `fpi_${unique("p")}`,
        occurredAt: new Date().toISOString(),
      });
    },
    providerRefunds(action, amount) {
      const request = gw.refunds.get(action);
      if (!request) throw new Error("no refund");
      return deliver({
        kind: "refund",
        provider: "fake",
        eventId: `fevt_${unique("r")}`,
        orderId: request.orderId,
        refundId: request.refundId,
        refundRef: `fre_${unique("f")}`,
        paymentRef: request.paymentRef,
        amount: amount ?? request.amount,
        currency: CURRENCY,
        occurredAt: new Date().toISOString(),
      });
    },
  };
}
