// The port between the operations registry and the integration host (ADRs 0050, 0110). cos-runner
// implements it (one integration host Durable Object per connection, which owns the gatekeeper
// accounts, facets and hooks); cos-app reaches the same implementation over the RUNNER service
// binding. Integration operations receive it through the invocation context, so packages/core
// never imports the runtime or the gatekeeper interface.
import type { PendingApproval } from "../errors.ts";
import type { Actor, Origin, Permission, Role } from "../principals.ts";

/** One resource bound on a connection: a facet the host owns, keyed within the connection. */
export interface BoundResource {
  /** Stable key of the facet within its connection (a hash of the resource URL). */
  key: string;
  url: string;
  /** The SupportedResource urlPattern it matched. */
  pattern: string;
  title: string;
  /** The session type agents code against (`GmailSession`), from the facet's describe(). */
  tsType: string;
  bindingName: string;
  hookTsType?: string | undefined;
}

/** Who is calling a gatekeeper session, so its ApprovalQueue routes and records as them. */
export interface IntegrationCaller {
  actor: Actor;
  userId: string;
  userName: string;
  role: Role;
  origin: Origin;
  grantedPermissions?: readonly Permission[] | undefined;
  reason?: string | undefined;
  /**
   * The person's own words this call was made for (the assistant's Durable Object passes them;
   * never a model). `outbound.message` checks a message's recipients against them (ADR 0238).
   */
  request?: string | undefined;
}

/** The result of a session call made through `integration.call`. */
export interface IntegrationCallResult {
  /** The method's result, as JSON (RPC stubs in it are described, not returned). */
  value: unknown;
  /** Outbound actions the call submitted that are waiting for approval. */
  pending: PendingApproval[];
  /** Outbound actions the call submitted that applied at once (auto-approved). */
  applied: { action: number; actionKind: string | null; title: string }[];
  /**
   * Actions that were to apply at once and failed, with the gatekeeper's message (stage 32b):
   * the host's own subscription calls tell a refusal (nothing changed) from an unknown outcome.
   */
  failed?: {
    action: number;
    actionKind: string | null;
    title: string;
    /** What came of it, from the gatekeeper's typed tag (`integrations/outcome.ts`). */
    outcome: "refused" | "unknown" | "retryable";
    message: string;
  }[];
  /**
   * Actions the gate denied (the deploy-time floor) and rejected on the facet: never sent. Set by
   * the host's own calls (`callAsHost`), so the copy of an agreement tells a refusal from a wait.
   */
  denied?: number[];
}

export interface ConnectStart {
  /** The provider's connect page (a bearer capability): open it in a popup. */
  url: string;
  /**
   * The per-flow nonce the popup keeps in sessionStorage and sends back with the ticket. The
   * host activates the staged account only for this nonce and the user who started the flow.
   */
  nonce: string;
}

export interface ConnectRedeemed {
  accountLabel: string | null;
  /** A further connect step for the same connection (a companion gatekeeper), if any. */
  next: (ConnectStart & { vendor: string }) | null;
}

/** What a sync source on a connection does (ADR 0112). */
export interface SyncConfig {
  /** The bound resource (key) holding mail, or null to stop syncing mail. */
  mail: string | null;
  /** The bound resource (key) holding calendar events, or null. */
  calendar: string | null;
  /** How far back the first sync reads. Default 90 days. */
  backfillDays?: number | undefined;
}

export interface IntegrationRuntime {
  /** Vendors whose gatekeeper Worker is bound in this deployment (`GATEKEEPER_<NAME>`). */
  availableVendors(): Promise<string[]>;
  /** Starts an OAuth connect flow for a new connection (the D1 mirror row already exists). */
  startConnect(input: {
    connectionId: string;
    vendor: string;
    userId: string;
    /** The CRM's public origin, where the popup is handed back (/connect/handoff). */
    appOrigin?: string | undefined;
  }): Promise<ConnectStart>;
  /** Mints an auto-provisioned account (web search, email sending, webhooks): no OAuth. */
  provision(input: { connectionId: string; vendor: string; userId: string }): Promise<{
    accountLabel: string | null;
  }>;
  /** Redeems the handoff ticket from the connect popup over the initiating user's session. */
  redeem(input: {
    connectionId: string;
    ticket: string;
    nonce: string;
    userId: string;
  }): Promise<ConnectRedeemed>;
  /** Starts a reconnect for an expired connection (same ticket and nonce handoff). */
  reconnect(input: {
    connectionId: string;
    userId: string;
    appOrigin?: string | undefined;
  }): Promise<ConnectStart>;
  /** Revokes the account and drops facets, hooks and sync. */
  disconnect(input: { connectionId: string }): Promise<void>;
  /** Creates (or returns) the facet for a resource URL on the connection. */
  bindResource(input: { connectionId: string; url: string }): Promise<BoundResource>;
  unbindResource(input: { connectionId: string; key: string }): Promise<void>;
  /** The resource types the connection's account offers (and its companion's), for pickers. */
  supportedResources(input: {
    connectionId: string;
  }): Promise<
    { urlPattern: string; title: string; description: string; grantable: boolean; vendor: string }[]
  >;
  /** Calls a method of the account's resource configurator `ui` capability (resource pickers). */
  configure(input: {
    connectionId: string;
    pattern: string;
    method: string;
    args: unknown[];
  }): Promise<unknown>;
  /** Calls a top-level method of a bound resource's session, as `caller`. */
  call(input: {
    connectionId: string;
    resource: string;
    method: string;
    args: unknown[];
    caller: IntegrationCaller;
  }): Promise<IntegrationCallResult>;
  /**
   * Calls a session method as the host itself, for platform code only (stage 25, ADR 0429): the
   * payments gatekeeper's checkout and the order confirmation email. No person or agent is the
   * caller. An outbound action it submits is a message the host composed from a fixed template,
   * so it applies at once unless the deploy-time floor denies it (a refund never: it is always
   * reviewed). Optional: a runtime without it cannot take payments.
   */
  callAsHost?(input: {
    connectionId: string;
    resource: string;
    method: string;
    args: unknown[];
    /**
     * `orders`: an order's checkout and confirmation (ADR 0429). `sign-in`: a sign-in code, sent
     * by the host for `origin` (ADR 0456); the queue tells the gatekeeper it is the host's
     * sign-in mail, which no other caller can say. `agreements`: the copy of a signed agreement
     * (ADR 0645), one send; the queue tells the gatekeeper it may carry the signed PDF, which no
     * other caller can say, and the send is the system's (no AI writes or reads it). Or
     * `scrubAgreementCopy` once the acceptance is erased (ADR 0646): the gatekeeper scrubs that
     * copy for this queue only. `accounting`: the sync's reads and entries on the connected books
     * (stage 61, ADR 0881), the only way into a connection whose gatekeeper implements accounting;
     * a void it asks for still waits for a person. `phone-check`: a checking code sent to, or
     * checked for, a member's own number (ADR 0673); the text gatekeeper takes `startCheck` and
     * `check` from this queue only.
     */
    purpose: "orders" | "sign-in" | "agreements" | "accounting" | "phone-check";
    origin?: "system.customer-mail" | "system.staff-mail";
  }): Promise<IntegrationCallResult>;
  /**
   * Sends one email row of core_routine_mail through `connectionId` (ADR 0670): a host kind's
   * routine message, asked for by host code. The integration host claims the row and sends its
   * own words through the routine-mail queue, exactly as for a pack's (ADR 0590); the caller
   * passes only the row's id. Optional: a runtime without it sends no host kind's email.
   */
  sendRoutineMessage?(input: { connectionId: string; resource: string; id: string }): Promise<{
    status: "sent" | "waiting" | "denied" | "failed" | "skipped" | "off" | "stopped";
    pendingActionId?: string;
    error?: string;
  }>;
  /**
   * Sends one text row of core_routine_mail through the text connection `connectionId` (ADR
   * 0672): the integration host claims it (the month's limit, the number's day), and sends its
   * own words through the routine-mail queue, where only the host's decision applies it. The
   * caller passes only the row's id. Optional: a runtime without it sends no text.
   */
  sendRoutineText?(input: { connectionId: string; resource: string; id: string }): Promise<{
    status:
      | "sent"
      | "waiting"
      | "denied"
      | "failed"
      | "skipped"
      | "off"
      | "stopped"
      | "over_limit"
      | "expired"
      | "held";
    pendingActionId?: string;
    error?: string;
  }>;
  /** The TypeScript declarations agents code against for a bound resource. */
  types(input: { connectionId: string; resource: string }): Promise<string>;
  /** Approval: applies a mirrored outbound action on its facet (in order per facet). */
  applyOutbound(input: { connectionId: string; facetKey: string; action: number }): Promise<void>;
  /** Rejection (or expiry): tells the facet to drop the action. */
  rejectOutbound(input: {
    connectionId: string;
    facetKey: string;
    action: number;
  }): Promise<{ restart?: boolean } | undefined>;
  /** Configures mail and calendar sync for the connection (ADR 0112). */
  setSync(input: { connectionId: string; config: SyncConfig }): Promise<void>;
  /** Runs a sync pass now (catch-up, or the next backfill chunk). */
  syncNow(input: { connectionId: string }): Promise<void>;
}

/** Blob storage for email bodies (R2, ADR 0112). */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  /** Keys under a prefix, a page at a time (the erase log, ADR 0320). */
  list?(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>;
}
