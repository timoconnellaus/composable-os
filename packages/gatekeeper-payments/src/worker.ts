// cos-gatekeeper-payments: a provider-neutral payments gatekeeper. The org takes money on the
// provider's own hosted page, so card details never reach this Worker or the CRM. The provider's
// keys are this Worker's secrets and never leave it. Each provider is one resource,
// `payments://merchant/<provider>`; its facet opens checkouts (an observation: no money moves),
// submits refunds as `payments.refund` actions that the host must apply, and binds a hook that
// receives every verified payment and refund event. README.md explains the design.
//
// No capnweb-validate decorators (the CRM's Vite dev server runs this Worker as an auxiliary
// worker and cannot transform them): every RPC input is checked by the guards in validate.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { workerVersionTag } from "@composable-os/gatekeeper-interface/gatekeeper";
import { buildDescription, sanitizeTitle } from "@composable-os/gatekeeper-kit/action-description";
import {
  ActionApplyError,
  ActionJournal,
  defineActions,
  type TaggedAction,
} from "@composable-os/gatekeeper-kit/actions";
import { eventsStub, PaymentsEvents, type StoredInitiator } from "./events.js";
import { FakePaymentsLedger, FakeProvider, fakeLedger } from "./fake.js";
import { formatMinor } from "./money.js";
import {
  assertProviderAvailable,
  baseUrl,
  fakeWebhookSecret,
  type PaymentProvider,
  PROVIDER_TITLES,
  stripeAccount,
  stripeApiBase,
  stripeSecretKey,
  stripeWebhookSecret,
  unavailableReason,
} from "./provider.js";
import { deliverFakeEvent, handleRequest } from "./routes.js";
import { StripeProvider, type TaxLocationCache } from "./stripe.js";
import type {
  PaymentsCancelSubscriptionInput,
  PaymentsCheckout,
  PaymentsCheckoutInput,
  PaymentsEvent,
  PaymentsEventHook,
  PaymentsPayment,
  PaymentsPortal,
  PaymentsPortalInput,
  PaymentsProviderName,
  PaymentsRefundInput,
  PaymentsRefundReceipt,
  PaymentsResumeSubscriptionInput,
  PaymentsSession,
  PaymentsSubscription,
  PaymentsSubscriptionChangeReceipt,
  PaymentsSubscriptionCheckoutInput,
  PaymentsSubscriptionCheckoutStatus,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import {
  assertProviderName,
  assertProviderRef,
  MERCHANT_URL_PATTERN,
  merchantUrl,
  PROVIDER_NAMES,
  parseCancelSubscriptionInput,
  parseCheckoutInput,
  parsePortalInput,
  parseRefundInput,
  parseResumeSubscriptionInput,
  parseSubscriptionCheckoutInput,
  providerFromUrl,
  validInstant,
} from "./validate.js";

export type {
  PaymentsCheckout,
  PaymentsCheckoutInput,
  PaymentsEvent,
  PaymentsEventHook,
  PaymentsPayment,
  PaymentsProviderName,
  PaymentsRefundInput,
  PaymentsRefundReceipt,
  PaymentsSession,
};
export { FakePaymentsLedger, PaymentsEvents };

type Env = Cloudflare.Env;
type ProviderProps = { provider: PaymentsProviderName };
/** PaymentsEventHook as the hook generics need it: an RpcTarget. */
type PaymentsHookTarget = RpcTarget & PaymentsEventHook;

const PAYMENTS_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
        "<rect width='20' height='14' x='2' y='5' rx='2'/><line x1='2' x2='22' y1='10' y2='10'/></svg>",
    ),
};

const MERCHANT_RESOURCE: SupportedResource = {
  urlPattern: MERCHANT_URL_PATTERN,
  title: "Payment account",
  description:
    "Take payments on the provider's own hosted page and refund them. Every refund waits for " +
    "approval; card details never reach the CRM.",
  icon: PAYMENTS_ICON,
  grantable: true,
};

/** The inert frame startResourceConfigurator() serves to a host that only knows iframes. */
const CONFIGURATOR_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Payment account</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
    <p>Choose the payment provider this account uses. Its keys are set by an administrator on the
    payments gatekeeper, never here.</p>
  </body>
</html>`;

/** The provider a facet or session acts through, built from this Worker's own secrets. */
function providerFor(
  env: Env,
  name: PaymentsProviderName,
  defer: (work: Promise<unknown>) => void,
  taxLocations?: TaxLocationCache,
): PaymentProvider {
  assertProviderAvailable(env, name);
  if (name === "stripe") {
    return new StripeProvider({
      secretKey: stripeSecretKey(env),
      webhookSecret: stripeWebhookSecret(env),
      apiBase: stripeApiBase(env),
      account: stripeAccount(env),
      ...(taxLocations ? { taxLocations, store: taxLocations } : {}),
    });
  }
  return new FakeProvider({
    ledger: fakeLedger(env),
    baseUrl: baseUrl(env),
    webhookSecret: fakeWebhookSecret(env),
    deliver: (body) => deliverFakeEvent(env, body),
    defer,
  });
}

// =======================================================================================
// The refund action.

/** What the journal stores for one refund: the provider at submit time and the validated input. */
type StoredRefund = { provider: PaymentsProviderName; input: PaymentsRefundInput };
/** A subscription change (ADR 0485): the provider at submit time and the validated input. */
type StoredCancel = { provider: PaymentsProviderName; input: PaymentsCancelSubscriptionInput };
type StoredResume = { provider: PaymentsProviderName; input: PaymentsResumeSubscriptionInput };
type Actions = { refund: StoredRefund; cancel: StoredCancel; resume: StoredResume };

const REFUND_KIND: ActionKind = { tag: "payments.refund", label: "Refund a payment" };
const CANCEL_KIND: ActionKind = {
  tag: "payments.subscription.cancel",
  label: "Cancel a subscription",
};
const RESUME_KIND: ActionKind = {
  tag: "payments.subscription.resume",
  label: "Keep a subscription going",
};

/** What the action handlers may do. Not the Durable Object: provider calls live behind approval. */
type PaymentsHost = {
  sendRefund(refund: StoredRefund): Promise<void>;
  sendCancel(change: StoredCancel): Promise<void>;
  sendResume(change: StoredResume): Promise<void>;
};

function describeCancel(change: StoredCancel) {
  const { input } = change;
  const when =
    input.when === "now"
      ? "at once, with nothing refunded for the rest of the period"
      : "when its current paid period ends";
  const builder = buildDescription(
    `Ends subscription ${input.subscriptionId} through ${PROVIDER_TITLES[change.provider]} ${when}. ` +
      "No money moves; the provider stops charging the card.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef)
    .inline("When", input.when === "now" ? "Now" : "At the period's end")
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`Cancel subscription ${input.subscriptionId}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describeResume(change: StoredResume) {
  const { input } = change;
  const builder = buildDescription(
    `Keeps subscription ${input.subscriptionId} going through ${PROVIDER_TITLES[change.provider]}: ` +
      "undoes its cancellation at the period's end, so the card is charged for the next period.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef);
  return {
    title: sanitizeTitle(`Keep subscription ${input.subscriptionId} going`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

/** The approver's view of one refund: how much, to which payment, on which order, and why. */
function describeRefund(refund: StoredRefund) {
  const { input } = refund;
  const amount = formatMinor(input.amount, input.currency);
  const builder = buildDescription(
    `Refunds ${amount} to the customer through ${PROVIDER_TITLES[refund.provider]}, back to ` +
      "the payment named below. Money leaves the organisation's account once this is applied.",
  )
    .inline("Provider", PROVIDER_TITLES[refund.provider])
    .inline("Order", input.orderId)
    .inline("Payment", input.paymentRef)
    .inline("Amount", `${amount} (${input.amount} minor units)`)
    .verbatim("Reason", input.reason)
    .inline("Refund id", input.refundId);
  return {
    title: sanitizeTitle(`Refund ${amount} on order ${input.orderId}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

const actions = defineActions<PaymentsHost, Actions>(
  {
    refund: {
      kind: REFUND_KIND,
      // Money leaves the org: a human decides every refund.
      autoApprovable: false,
      delivery: "continue-with-simulation",
      // A crash between the provider call and recording it must not refund twice.
      claimBeforeApply: true,
      describe: (refund) => describeRefund(refund),
      apply: async (refund, host) => {
        await host.sendRefund(refund);
      },
      // Nothing was sent, so there is nothing to release.
      reject: async () => {},
    },
    // A subscription change moves no money, but ends or keeps a customer's plan: never
    // auto-approvable, so an agent's session waits for a person. The host's own call (a customer
    // changing their own through the host's operation, ADR 0485) is applied at once by the host.
    cancel: {
      kind: CANCEL_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeCancel(change),
      apply: async (change, host) => {
        await host.sendCancel(change);
      },
      reject: async () => {},
    },
    resume: {
      kind: RESUME_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeResume(change),
      apply: async (change, host) => {
        await host.sendResume(change);
      },
      reject: async () => {},
    },
  },
  // The provider's keys are this Worker's own, not a user's connection: nothing to fence on.
  { fence: "none", vendorId: "payments" },
);

// =======================================================================================
// The agent-facing session.

/** What a session may ask of its facet, as closures so the session holds no facet reference. */
type SessionBackend = {
  provider: PaymentsProviderName;
  open(): PaymentProvider;
  submitRefund(queue: RpcStub<ApprovalQueue>, refund: StoredRefund): Promise<number>;
  submitCancel(queue: RpcStub<ApprovalQueue>, change: StoredCancel): Promise<number>;
  submitResume(queue: RpcStub<ApprovalQueue>, change: StoredResume): Promise<number>;
  wasApplied(id: number): boolean;
  subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<PaymentsHookTarget>): Promise<void>;
};

/**
 * Whether the session's approval queue is the host's own orders call (`callAsHost`, purpose
 * `orders`). Asked of the queue the host opened the session with, as the email gatekeeper asks
 * whether a send is the host's sign-in mail (ADR 0456); a queue without the method is not.
 */
async function isHostOrdersQueue(queue: unknown): Promise<boolean> {
  try {
    const target = queue as { isHostOrders?: () => Promise<unknown> };
    if (typeof target.isHostOrders !== "function") return false;
    return (await target.isHostOrders()) === true;
  } catch {
    return false;
  }
}

class PaymentsSessionImpl extends RpcTarget implements PaymentsSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  /** The provider; resource configuration, not provider data, so no observation. */
  async provider(): Promise<PaymentsProviderName> {
    return this.#backend.provider;
  }

  async createCheckout(input: PaymentsCheckoutInput): Promise<PaymentsCheckout> {
    const parsed = parseCheckoutInput(input);
    const provider = this.#backend.open();
    const amount = formatMinor(parsed.amount, parsed.currency);
    await this.#queue.authorizeObservation({
      title: sanitizeTitle(`Open a checkout of ${amount} for order ${parsed.orderId}`),
      description:
        `Opened ${PROVIDER_TITLES[provider.name]}'s hosted payment page for ${amount}. ` +
        "No money moves until the customer pays on that page." +
        (parsed.customerEmail ? " The customer's email is prefilled." : ""),
      fields: [
        { label: "Order", kind: "inline", value: parsed.orderId },
        { label: "Amount", kind: "inline", value: `${amount} (${parsed.amount} minor units)` },
        ...(parsed.tax
          ? [
              {
                label: "Tax",
                kind: "inline" as const,
                value: `Calculated by the provider inside the amount, on ${parsed.tax.lines.length} line(s)`,
              },
            ]
          : []),
      ],
    });
    const checkout = await provider.createCheckout(parsed);
    return {
      provider: provider.name,
      ref: checkout.ref,
      url: checkout.url,
      expiresAt: checkout.expiresAt,
    };
  }

  async getPayment(ref: string): Promise<PaymentsPayment> {
    const checked = assertProviderRef(ref);
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "Read a checkout",
      description: `Read checkout \`${checked}\` from ${PROVIDER_TITLES[provider.name]}.`,
    });
    return provider.getPayment(checked);
  }

  async refund(input: PaymentsRefundInput): Promise<PaymentsRefundReceipt> {
    const parsed = parseRefundInput(input);
    // Refused now, not at apply, when the provider is not set up at all.
    this.#backend.open();
    const id = await this.#backend.submitRefund(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async createSubscriptionCheckout(
    input: PaymentsSubscriptionCheckoutInput,
  ): Promise<PaymentsCheckout> {
    const parsed = parseSubscriptionCheckoutInput(input);
    const provider = this.#backend.open();
    const amount = formatMinor(parsed.amount, parsed.currency);
    await this.#queue.authorizeObservation({
      title: sanitizeTitle(`Open a subscription checkout of ${amount} a ${parsed.interval}`),
      description:
        `Opened ${PROVIDER_TITLES[provider.name]}'s hosted page to start subscription ` +
        `${parsed.subscriptionId} at ${amount} every ${parsed.interval}. Nothing is charged ` +
        "until the payer submits that page, and then only on the provider's own schedule." +
        (parsed.trialDays || parsed.trialEnd
          ? " The first period is free; the card is taken."
          : ""),
      fields: [
        { label: "Subscription", kind: "inline", value: parsed.subscriptionId },
        { label: "Price", kind: "inline", value: `${amount} (${parsed.amount} minor units)` },
        ...(parsed.trialEnd
          ? [{ label: "Free until", kind: "inline" as const, value: parsed.trialEnd }]
          : parsed.trialDays
            ? [{ label: "Trial", kind: "inline" as const, value: `${parsed.trialDays} days` }]
            : []),
        ...(parsed.tax
          ? [
              {
                label: "Tax",
                kind: "inline" as const,
                value: "Calculated by the provider inside the price",
              },
            ]
          : []),
      ],
    });
    const checkout = await provider.createSubscriptionCheckout(parsed);
    return {
      provider: provider.name,
      ref: checkout.ref,
      url: checkout.url,
      // Only a moment the host can read: a malformed one is reported as none, never passed on.
      expiresAt: validInstant(checkout.expiresAt),
    };
  }

  async getSubscriptionCheckout(ref: string): Promise<PaymentsSubscriptionCheckoutStatus> {
    const checked = assertProviderRef(ref);
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "Read a subscription checkout",
      description: `Read whether subscription checkout \`${checked}\` on ${PROVIDER_TITLES[provider.name]} is open, completed or expired.`,
    });
    return { ref: checked, status: await provider.getSubscriptionCheckout(checked) };
  }

  async getSubscription(ref: string): Promise<PaymentsSubscription> {
    const checked = assertProviderRef(ref);
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "Read a subscription",
      description: `Read subscription \`${checked}\` from ${PROVIDER_TITLES[provider.name]}.`,
    });
    return provider.getSubscription(checked);
  }

  async cancelSubscription(
    input: PaymentsCancelSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parseCancelSubscriptionInput(input);
    this.#backend.open();
    const id = await this.#backend.submitCancel(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async resumeSubscription(
    input: PaymentsResumeSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parseResumeSubscriptionInput(input);
    this.#backend.open();
    const id = await this.#backend.submitResume(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async openPortal(input: PaymentsPortalInput): Promise<PaymentsPortal> {
    const parsed = parsePortalInput(input);
    // A portal address shows a customer's invoices and lets their card and email be changed: it
    // is opened only by the host, for the signed-in payer's own customer, which the host's
    // operation has established (ADR 0485). Code Mode, an extension's tool, an automation and MCP
    // reach this session through queues that answer no.
    if (!(await isHostOrdersQueue(this.#queue))) {
      throw new Error(
        "The billing portal is opened only by the host, for a signed-in customer's own billing.",
      );
    }
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "Open the customer portal",
      description:
        `Opened ${PROVIDER_TITLES[provider.name]}'s customer portal for customer ` +
        `\`${parsed.customerRef}\`: the card, billing details and past invoices only.`,
    });
    return provider.openPortal(parsed);
  }

  async subscribe(hook: PaymentsEventHook): Promise<void> {
    if (hook === null || (typeof hook !== "object" && typeof hook !== "function")) {
      throw new TypeError("subscribe() takes a stub implementing PaymentsEventHook.");
    }
    await this.#backend.subscribe(this.#queue, hook as unknown as RpcStub<PaymentsHookTarget>);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

// =======================================================================================
// The per-provider gatekeeper facet.

export class PaymentsGatekeeper
  extends DurableObject<Env, ProviderProps>
  implements Gatekeeper<PaymentsSession>
{
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "payments",
  });

  readonly #host: PaymentsHost = {
    sendRefund: (refund) => this.#sendRefund(refund),
    sendCancel: async (change) =>
      (await this.#openForApply(change.provider)).cancelSubscription(change.input),
    sendResume: async (change) =>
      (await this.#openForApply(change.provider)).resumeSubscription(change.input),
  };

  /** The provider an approved action is sent through; a provider not set up sends nothing. */
  async #openForApply(name: PaymentsProviderName): Promise<PaymentProvider> {
    try {
      return this.#open(name);
    } catch (error) {
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
  }

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  #provider(): PaymentsProviderName {
    return assertProviderName(this.ctx.props.provider);
  }

  #open(name: PaymentsProviderName): PaymentProvider {
    const kv = this.ctx.storage.kv;
    const store = {
      get: (key: string) => kv.get<string>(key),
      put: (key: string, id: string) => kv.put(key, id),
    };
    return providerFor(this.env, name, (work) => this.ctx.waitUntil(work), store);
  }

  async #sendRefund(refund: StoredRefund): Promise<void> {
    let provider: PaymentProvider;
    try {
      provider = this.#open(refund.provider);
    } catch (error) {
      // Checked before anything is sent, so nothing was refunded.
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
    await provider.refund(refund.input);
  }

  async describe(): Promise<ResourceDescription> {
    const provider = this.#provider();
    return {
      url: merchantUrl(provider),
      title: `Payments with ${PROVIDER_TITLES[provider]}`,
      snippet:
        `Open ${PROVIDER_TITLES[provider]} checkouts, read them, and refund payments. Each ` +
        "refund waits for approval.",
      suggestedBindingName: "PAYMENTS",
      tsType: "PaymentsSession",
      hookTsType: "PaymentsEventHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** None: every refund waits for a human. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<PaymentsSession> {
    const provider = this.#provider();
    const backend: SessionBackend = {
      provider,
      open: () => this.#open(provider),
      submitRefund: (queue, refund) => this.#actions().submit(queue, "refund", refund),
      submitCancel: (queue, change) => this.#actions().submit(queue, "cancel", change),
      submitResume: (queue, change) => this.#actions().submit(queue, "resume", change),
      wasApplied: (id) => this.#journal.wasApplied(id),
      subscribe: (queue, hook) => this.#subscribe(queue, hook),
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new PaymentsSessionImpl(backend, approvalQueue.dup());
  }

  async #subscribe(
    queue: RpcStub<ApprovalQueue>,
    hook: RpcStub<PaymentsHookTarget>,
  ): Promise<void> {
    const provider = this.#provider();
    const props: ProviderProps = { provider };
    const controller = this.ctx.exports.PaymentsHookController({ props });
    // The RPC stub types of two Fetcher<HookController<…>> instantiations do not unify (the
    // webhook gatekeeper hits the same), so the call is typed by the interface's own signature.
    const binder = queue as unknown as Pick<ApprovalQueue, "bindHook">;
    await binder.bindHook<PaymentsHookTarget>(
      controller as unknown as Fetcher<HookController<PaymentsHookTarget>>,
      hook,
      {
        title: `Receive payment events (${PROVIDER_TITLES[provider]})`,
        description:
          `Deliver each verified payment and refund event from ${PROVIDER_TITLES[provider]}: ` +
          "the order, amounts, currency and the provider's references. Never card details.",
      },
    );
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the account belongs to the deployment, not to one person. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /** Sends an approved refund, exactly once. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(requireActionId(action));
  }

  /** Drops a rejected refund; nothing is sent. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("A refund cannot be taken back.");
  }
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

// =======================================================================================
// Hook controller: the host enables it with an initiator once a human approves the hook.

export class PaymentsHookController
  extends WorkerEntrypoint<Env, ProviderProps>
  implements HookController<PaymentsHookTarget>
{
  async enable(
    initiator: Fetcher<HookInitiator<PaymentsHookTarget>>,
    target: HookTargetMetadata,
  ): Promise<void> {
    if (initiator === null || (typeof initiator !== "object" && typeof initiator !== "function")) {
      throw new TypeError("enable() takes a HookInitiator stub.");
    }
    const workspaceId =
      typeof target?.workspaceId === "string" ? target.workspaceId.slice(0, 200) : "";
    const metadata: HookTargetMetadata = { workspaceId };
    if (typeof target?.gadgetId === "number" && Number.isInteger(target.gadgetId)) {
      metadata.gadgetId = target.gadgetId;
    }
    const provider = assertProviderName(this.ctx.props.provider);
    await eventsStub(this.env, provider).setHook(initiator as unknown as StoredInitiator, metadata);
  }

  async disable(): Promise<void> {
    const provider = assertProviderName(this.ctx.props.provider);
    await eventsStub(this.env, provider).setHook(null);
  }
}

// =======================================================================================
// The configurator capability, account, verifier and vendor.

export type PaymentsProviderOption = {
  name: PaymentsProviderName;
  title: string;
  available: boolean;
};

export class PaymentsConfiguratorUi extends RpcTarget {
  readonly #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  /** Every provider, and whether this deployment has it set up. Never a key. */
  async providers(): Promise<PaymentsProviderOption[]> {
    return PROVIDER_NAMES.map((name) => ({
      name,
      title: PROVIDER_TITLES[name],
      available: unavailableReason(this.#env, name) === undefined,
    }));
  }

  /** The resource URL for `provider`. */
  async resourceUrl(provider: unknown): Promise<string> {
    return merchantUrl(assertProviderName(provider));
  }
}

export class PaymentsAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Payments", avatar: PAYMENTS_ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MERCHANT_RESOURCE];
  }

  /** The facet class for a provider this deployment has set up. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<PaymentsSession>>;
    resource: SupportedResource;
  }> {
    const provider = providerFromUrl(url);
    assertProviderAvailable(this.env, provider);
    const props: ProviderProps = { provider };
    return {
      class: this.ctx.exports.PaymentsGatekeeper({ props }) as unknown as DurableObjectClass<
        Gatekeeper<PaymentsSession>
      >,
      resource: MERCHANT_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== MERCHANT_URL_PATTERN) {
      throw new Error(`Unsupported resource type: ${String(resourceUrlPattern).slice(0, 200)}`);
    }
    return {
      iframeHtml: CONFIGURATOR_HTML,
      ui: new RpcStub(new PaymentsConfiguratorUi(this.env)),
    };
  }

  /** Nothing to revoke: an account holds no credentials; the keys belong to the deployment. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Payments have no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Payments have no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.PaymentsVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

/** The trivial verifier that goes with admitting every observer. */
export class PaymentsVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/**
 * The vendor, and the Worker's default entrypoint: its `fetch` serves the public routes (the
 * webhooks and the fake provider's page), which the CRM proxies from /gatekeeper/payments/*.
 */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env);
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Payments",
      url: baseUrl(this.env),
      logo: PAYMENTS_ICON,
      tagline: "Take payments on the provider's hosted page",
      description:
        "Send customers to the payment provider's own checkout page and refund payments, each " +
        "refund approved by a person. The provider's keys stay in this gatekeeper, and card " +
        "details never reach the CRM.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. All accounts are alike: none holds credentials. */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.PaymentsAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Payments are auto-provisioned and have no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [MERCHANT_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
