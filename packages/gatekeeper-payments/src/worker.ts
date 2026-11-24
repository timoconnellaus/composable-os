// cos-gatekeeper-payments: a provider-neutral payments gatekeeper. The org takes money on the
// provider's own hosted page, so card details never reach this Worker or the CRM. The provider's
// keys are this Worker's secrets and never leave it. Each provider is one resource,
// `payments://merchant/<provider>`; its facet opens checkouts (an observation: no money moves),
// submits refunds as `payments.refund` actions that the host must apply, and binds a hook that
// receives every verified payment and refund event. Card readers (stage 50, ADR 0774) are
// registered and removed as actions a person approves, and payments are presented on them by the
// host's own call. README.md explains the design.
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
  ActionOutcomeUnknownError,
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
  PaymentsChangeSubscriptionInput,
  PaymentsCheckout,
  PaymentsCheckoutInput,
  PaymentsEvent,
  PaymentsEventHook,
  PaymentsPauseSubscriptionInput,
  PaymentsPayment,
  PaymentsPortal,
  PaymentsPortalInput,
  PaymentsPresentation,
  PaymentsPresentInput,
  PaymentsProviderName,
  PaymentsReader,
  PaymentsReaderChangeReceipt,
  PaymentsRefundInput,
  PaymentsRefundReceipt,
  PaymentsRegisterReaderInput,
  PaymentsRemoveReaderInput,
  PaymentsResumeSubscriptionInput,
  PaymentsSession,
  PaymentsSubscription,
  PaymentsSubscriptionChangeReceipt,
  PaymentsSubscriptionCheckoutInput,
  PaymentsSubscriptionCheckoutStatus,
  PaymentsUnpauseSubscriptionInput,
  PaymentsVoidUpdateInput,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import {
  assertProviderName,
  assertProviderRef,
  assertReaderRef,
  MERCHANT_URL_PATTERN,
  merchantUrl,
  PROVIDER_NAMES,
  parseCancelSubscriptionInput,
  parseChangeSubscriptionInput,
  parseCheckoutInput,
  parsePauseSubscriptionInput,
  parsePortalInput,
  parsePresentInput,
  parseRefundInput,
  parseRegisterReaderInput,
  parseRemoveReaderInput,
  parseResumeSubscriptionInput,
  parseSubscriptionCheckoutInput,
  parseUnpauseSubscriptionInput,
  parseVoidUpdateInput,
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
/** A plan change, a pause and its end (stage 32b, ADRs 0530 and 0531). */
type StoredChange = { provider: PaymentsProviderName; input: PaymentsChangeSubscriptionInput };
type StoredPause = { provider: PaymentsProviderName; input: PaymentsPauseSubscriptionInput };
type StoredUnpause = { provider: PaymentsProviderName; input: PaymentsUnpauseSubscriptionInput };
type StoredVoid = { provider: PaymentsProviderName; input: PaymentsVoidUpdateInput };
/** A reader's registration and removal (stage 50, ADR 0774). */
type StoredRegisterReader = { provider: PaymentsProviderName; input: PaymentsRegisterReaderInput };
type StoredRemoveReader = { provider: PaymentsProviderName; input: PaymentsRemoveReaderInput };
type Actions = {
  register_reader: StoredRegisterReader;
  remove_reader: StoredRemoveReader;
  refund: StoredRefund;
  cancel: StoredCancel;
  resume: StoredResume;
  change: StoredChange;
  pause: StoredPause;
  unpause: StoredUnpause;
  void_update: StoredVoid;
};

const REFUND_KIND: ActionKind = { tag: "payments.refund", label: "Refund a payment" };
const CANCEL_KIND: ActionKind = {
  tag: "payments.subscription.cancel",
  label: "Cancel a subscription",
};
const RESUME_KIND: ActionKind = {
  tag: "payments.subscription.resume",
  label: "Keep a subscription going",
};
const CHANGE_KIND: ActionKind = {
  tag: "payments.subscription.change",
  label: "Change a subscription's plan",
};
const PAUSE_KIND: ActionKind = {
  tag: "payments.subscription.pause",
  label: "Pause a subscription",
};
const VOID_UPDATE_KIND: ActionKind = {
  tag: "payments.subscription.void_update",
  label: "Withdraw a subscription's upgrade",
};
const REGISTER_READER_KIND: ActionKind = {
  tag: "payments.reader.register",
  label: "Register a card reader",
};
const REMOVE_READER_KIND: ActionKind = {
  tag: "payments.reader.remove",
  label: "Remove a card reader",
};
const UNPAUSE_KIND: ActionKind = {
  tag: "payments.subscription.unpause",
  label: "End a subscription's pause",
};

/** What the action handlers may do. Not the Durable Object: provider calls live behind approval. */
type PaymentsHost = {
  sendRegisterReader(change: StoredRegisterReader): Promise<void>;
  sendRemoveReader(change: StoredRemoveReader): Promise<void>;
  sendRefund(refund: StoredRefund): Promise<void>;
  sendCancel(change: StoredCancel): Promise<void>;
  sendResume(change: StoredResume): Promise<void>;
  sendChange(change: StoredChange): Promise<void>;
  sendPause(change: StoredPause): Promise<void>;
  sendUnpause(change: StoredUnpause): Promise<void>;
  sendVoid(change: StoredVoid): Promise<void>;
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

function describeChange(change: StoredChange) {
  const { input } = change;
  const amount = formatMinor(input.amount, input.currency);
  const when =
    input.when === "now"
      ? `now: the rest of the current period is charged at once, prorated, and the change applies only once that is paid`
      : "from the next period: nothing is prorated or refunded";
  const builder = buildDescription(
    `Changes subscription ${input.subscriptionId} through ${PROVIDER_TITLES[change.provider]} to ` +
      `${amount} every ${input.interval}, ${when}. Money moves on the payer's card.`,
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef)
    .verbatim("New plan", input.description)
    .inline("New price", `${amount} (${input.amount} minor units) every ${input.interval}`)
    .inline("When", input.when === "now" ? "Now, prorated" : "From the next period")
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`Change subscription ${input.subscriptionId} to ${amount}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describePause(change: StoredPause) {
  const { input } = change;
  const builder = buildDescription(
    `Pauses subscription ${input.subscriptionId} through ${PROVIDER_TITLES[change.provider]} ` +
      `from ${input.from ?? "now"} until ${input.until}: nothing is charged and nothing is given ` +
      "while it is paused; the provider resumes it then and charges a new period.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef)
    .inline("From", input.from ?? "Now")
    .inline("Until", input.until)
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`Pause subscription ${input.subscriptionId}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describeUnpause(change: StoredUnpause) {
  const { input } = change;
  const builder = buildDescription(
    `Ends the pause of subscription ${input.subscriptionId} through ` +
      `${PROVIDER_TITLES[change.provider]} now (or withdraws one not yet started): the provider ` +
      "charges a new period from today.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef)
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`End the pause of subscription ${input.subscriptionId}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describeVoid(change: StoredVoid) {
  const { input } = change;
  const builder = buildDescription(
    `Withdraws the upgrade of subscription ${input.subscriptionId} through ` +
      `${PROVIDER_TITLES[change.provider]}: voids the open invoice its pending update made, so it ` +
      "can no longer be paid and the subscription stays on its plan.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Subscription", input.subscriptionId)
    .inline("Provider's reference", input.subscriptionRef)
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`Withdraw the upgrade of subscription ${input.subscriptionId}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

/**
 * The approver's view of a reader's registration: which device, at which address. The pairing code
 * is not shown: it is the admin's to type, and single-use.
 */
function describeRegisterReader(change: StoredRegisterReader) {
  const { input } = change;
  const { address } = input;
  const where = [address.line1, address.city, address.region, address.postcode, address.country]
    .filter((part) => part !== undefined)
    .join(", ");
  const builder = buildDescription(
    `Registers a card reader to the business's ${PROVIDER_TITLES[change.provider]} account at ` +
      "the address below. It moves no money, but once registered the reader can take card " +
      "payments that the host puts on it.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Reader", input.readerId)
    .verbatim("Label", input.label)
    .verbatim("Location", input.locationName)
    .verbatim("Address", where);
  return {
    title: sanitizeTitle(`Register card reader ${input.label}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

function describeRemoveReader(change: StoredRemoveReader) {
  const { input } = change;
  const builder = buildDescription(
    `Removes card reader ${input.readerId} from the business's ` +
      `${PROVIDER_TITLES[change.provider]} account. It can take no payment after this, and is ` +
      "registered again with a new code.",
  )
    .inline("Provider", PROVIDER_TITLES[change.provider])
    .inline("Reader", input.readerId)
    .inline("Provider's reference", input.readerRef)
    .verbatim("Reason", input.reason);
  return {
    title: sanitizeTitle(`Remove card reader ${input.readerId}`),
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
    // A reader moves no money, but adds a device that can take it (stage 50, ADR 0774): never
    // auto-approvable, and asked only by the host's own operation, which a human admin runs.
    register_reader: {
      kind: REGISTER_READER_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeRegisterReader(change),
      apply: async (change, host) => {
        await host.sendRegisterReader(change);
      },
      reject: async () => {},
    },
    remove_reader: {
      kind: REMOVE_READER_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeRemoveReader(change),
      apply: async (change, host) => {
        await host.sendRemoveReader(change);
      },
      reject: async () => {},
    },
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
    // A plan change and a pause change what the payer is charged (stage 32b): never
    // auto-approvable, as a cancel is; the host's own call is applied at once by the host.
    change: {
      kind: CHANGE_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeChange(change),
      apply: async (change, host) => {
        await host.sendChange(change);
      },
      reject: async () => {},
    },
    pause: {
      kind: PAUSE_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describePause(change),
      apply: async (change, host) => {
        await host.sendPause(change);
      },
      reject: async () => {},
    },
    void_update: {
      kind: VOID_UPDATE_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeVoid(change),
      apply: async (change, host) => {
        await host.sendVoid(change);
      },
      reject: async () => {},
    },
    unpause: {
      kind: UNPAUSE_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (change) => describeUnpause(change),
      apply: async (change, host) => {
        await host.sendUnpause(change);
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
  submitChange(queue: RpcStub<ApprovalQueue>, change: StoredChange): Promise<number>;
  submitPause(queue: RpcStub<ApprovalQueue>, change: StoredPause): Promise<number>;
  submitUnpause(queue: RpcStub<ApprovalQueue>, change: StoredUnpause): Promise<number>;
  submitVoid(queue: RpcStub<ApprovalQueue>, change: StoredVoid): Promise<number>;
  submitRegisterReader(
    queue: RpcStub<ApprovalQueue>,
    change: StoredRegisterReader,
  ): Promise<number>;
  submitRemoveReader(queue: RpcStub<ApprovalQueue>, change: StoredRemoveReader): Promise<number>;
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

/**
 * The tag an apply failure's message starts with (stage 32b review): `[apply-outcome:refused] `.
 * Core reads it (`packages/core/src/integrations/outcome.ts`, the same text): the one place the two
 * agree, since RPC carries an error's message and not its class.
 */
const APPLY_OUTCOME_TAG = "[apply-outcome:";
function applyOutcomeTag(outcome: "refused" | "unknown" | "retryable"): string {
  return `${APPLY_OUTCOME_TAG}${outcome}] `;
}

/**
 * A plan change, a pause and its end are asked only by the host (stage 32b review), as the portal
 * is: the host writes the change it asks for before asking, and follows it from verified reads, so
 * one asked another way (Code Mode, an extension's tool, MCP, the assistant) would be a change the
 * host never asked for. Cancel and resume stay open to a session that waits for a person.
 */
async function requireHostQueue(queue: unknown): Promise<void> {
  if (!(await isHostOrdersQueue(queue))) {
    throw new Error(
      "Plan changes and pauses are asked only by the host, through its own subscription operations.",
    );
  }
}

/** Card readers are the host's own call only (stage 50, ADR 0774). */
async function requireHostReaderQueue(queue: unknown): Promise<void> {
  if (!(await isHostOrdersQueue(queue))) {
    throw new Error(
      "Card readers and the payments on them are asked only by the host, through its own operations.",
    );
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

  async changeSubscription(
    input: PaymentsChangeSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parseChangeSubscriptionInput(input);
    await requireHostQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitChange(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async pauseSubscription(
    input: PaymentsPauseSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parsePauseSubscriptionInput(input);
    await requireHostQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitPause(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async unpauseSubscription(
    input: PaymentsUnpauseSubscriptionInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parseUnpauseSubscriptionInput(input);
    await requireHostQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitUnpause(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async voidPendingUpdate(
    input: PaymentsVoidUpdateInput,
  ): Promise<PaymentsSubscriptionChangeReceipt> {
    const parsed = parseVoidUpdateInput(input);
    await requireHostQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitVoid(this.#queue, {
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

  // --- Card readers (stage 50, ADR 0774) ------------------------------------------------------
  // The host's own call only: the host keeps which till a reader serves and the presentation it
  // matches the payment on, so a reader registered or a payment presented any other way (Code
  // Mode, an extension's tool, MCP, the assistant) is one the host never asked for. The list too:
  // a reader's reference is all the fake reader's public page needs (review of PR #348).

  async registerReader(input: PaymentsRegisterReaderInput): Promise<PaymentsReaderChangeReceipt> {
    const parsed = parseRegisterReaderInput(input);
    await requireHostReaderQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitRegisterReader(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async removeReader(input: PaymentsRemoveReaderInput): Promise<PaymentsReaderChangeReceipt> {
    const parsed = parseRemoveReaderInput(input);
    await requireHostReaderQueue(this.#queue);
    this.#backend.open();
    const id = await this.#backend.submitRemoveReader(this.#queue, {
      provider: this.#backend.provider,
      input: parsed,
    });
    return { status: this.#backend.wasApplied(id) ? "sent" : "pending", id };
  }

  async listReaders(): Promise<PaymentsReader[]> {
    await requireHostReaderQueue(this.#queue);
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "List card readers",
      description: `Read the card readers registered to the ${PROVIDER_TITLES[provider.name]} account.`,
    });
    return provider.listReaders();
  }

  async presentPayment(input: PaymentsPresentInput): Promise<PaymentsPresentation> {
    const parsed = parsePresentInput(input);
    await requireHostReaderQueue(this.#queue);
    const provider = this.#backend.open();
    const amount = formatMinor(parsed.amount, parsed.currency);
    await this.#queue.authorizeObservation({
      title: sanitizeTitle(`Put ${amount} for order ${parsed.orderId} on a card reader`),
      description:
        `Handed a payment of ${amount} to reader \`${parsed.readerRef}\` on ` +
        `${PROVIDER_TITLES[provider.name]}. No money moves until the buyer's card does.`,
      fields: [
        { label: "Order", kind: "inline", value: parsed.orderId },
        { label: "Amount", kind: "inline", value: `${amount} (${parsed.amount} minor units)` },
        { label: "Reader", kind: "inline", value: parsed.readerRef },
      ],
    });
    const presented = await provider.presentPayment(parsed);
    return { provider: provider.name, ...presented };
  }

  async cancelPresented(readerRef: string): Promise<void> {
    const checked = assertReaderRef(readerRef);
    await requireHostReaderQueue(this.#queue);
    const provider = this.#backend.open();
    await this.#queue.authorizeObservation({
      title: "Clear a card reader",
      description: `Cleared the payment on reader \`${checked}\` on ${PROVIDER_TITLES[provider.name]}; it stays unpaid.`,
    });
    await provider.cancelPresented(checked);
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
    sendRegisterReader: async (change) => {
      await (await this.#openForApply(change.provider)).registerReader(change.input);
    },
    sendRemoveReader: async (change) =>
      (await this.#openForApply(change.provider)).removeReader(change.input),
    sendRefund: (refund) => this.#sendRefund(refund),
    sendCancel: async (change) =>
      (await this.#openForApply(change.provider)).cancelSubscription(change.input),
    sendResume: async (change) =>
      (await this.#openForApply(change.provider)).resumeSubscription(change.input),
    sendChange: async (change) =>
      (await this.#openForApply(change.provider)).changeSubscription(change.input),
    sendPause: async (change) =>
      (await this.#openForApply(change.provider)).pauseSubscription(change.input),
    sendUnpause: async (change) =>
      (await this.#openForApply(change.provider)).unpauseSubscription(change.input),
    sendVoid: async (change) =>
      (await this.#openForApply(change.provider)).voidPendingUpdate(change.input),
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
        "refund waits for approval. The host also puts payments on registered card readers.",
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
      submitChange: (queue, change) => this.#actions().submit(queue, "change", change),
      submitPause: (queue, change) => this.#actions().submit(queue, "pause", change),
      submitUnpause: (queue, change) => this.#actions().submit(queue, "unpause", change),
      submitVoid: (queue, change) => this.#actions().submit(queue, "void_update", change),
      submitRegisterReader: (queue, change) =>
        this.#actions().submit(queue, "register_reader", change),
      submitRemoveReader: (queue, change) => this.#actions().submit(queue, "remove_reader", change),
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
          `Deliver each verified payment, refund and card reader event from ` +
          `${PROVIDER_TITLES[provider]}: the order, amounts, currency and the provider's ` +
          "references. Never card details.",
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
  /**
   * Applies an action. A failure is thrown with what came of it in front of its message
   * (`APPLY_OUTCOME_TAG`): RPC carries an error's message only, not its class, so the host's own
   * call reads the outcome from this tag, never from the wording (review of 32b): `refused`
   * (`ActionApplyError`: nothing changed), `unknown` (`ActionOutcomeUnknownError`: it may have),
   * `retryable` (anything else: the action is pending again, nothing was sent).
   */
  async applyAction(action: number): Promise<void> {
    try {
      await this.#actions().apply(requireActionId(action));
    } catch (error) {
      const outcome =
        error instanceof ActionApplyError
          ? "refused"
          : error instanceof ActionOutcomeUnknownError
            ? "unknown"
            : "retryable";
      throw new Error(
        `${applyOutcomeTag(outcome)}${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
