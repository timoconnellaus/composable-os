// The integration host (ADR 0050, ADR 0110): the Workshop side of the Cloudflare OS gatekeeper
// interface. ONE DURABLE OBJECT PER CONNECTION (`INTEGRATION_HOST.getByName(connectionId)`), so
// no single object carries the deployment's gatekeeper traffic (cost audit U10); listing comes
// from the D1 mirror.
//
// It owns, in its own storage (the only place persistent RPC stubs can live,
// allow_irrevocable_stub_storage):
// - the connected account (`Fetcher<GatekeeperUser>`), and a companion account (Slack posting);
// - the staged account of a connect or reconnect, until its ticket is redeemed;
// - one gatekeeper facet per bound resource, keyed by a hash of the resource URL, created from
//   the class stub `getGatekeeperClassFor(url)` returned (and recreated from it after a restart);
// - hook controllers and their purpose (sync, webhook, or an agent's request awaiting stage 5);
// - sync state (backfill and catch-up cursors), driven by alarms.
// D1 holds only the mirror (core_integration_connection) the UI and operations read.
import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  ACCOUNTING_HOST_ONLY,
  type ActingUser,
  applyStoredPaymentEvent,
  applyTextEvent,
  type BoundResource,
  type ConnectRedeemed,
  type ConnectStart,
  catalogueEntry,
  claimRoutineMail,
  claimRoutineText,
  dropStopTokens,
  errorForLog,
  evaluateGate,
  type IntegrationCaller,
  type IntegrationCallResult,
  invoke,
  keepsBooks,
  loadApprovalPolicy,
  loadRoutineMailSettings,
  mintStopLinks,
  parseFloor,
  ROLES,
  type Role,
  recordIntegrationEvents,
  recordPaymentEvent,
  revokeBindings,
  SIGN_IN_MAIL_ORIGINS,
  type Stoppable,
  SYNC_BATCH_MAX,
  SYSTEM_USER,
  type SyncConfig,
  type SyncItem,
  settleRoutineMail,
  settleRoutineText,
  sha256Hex,
  siteOriginOf,
  syncedInWindow,
  syncKindOf,
  vendorBinding,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { gatekeeperOffered, perClientMissing } from "@composable-os/db/client-entries";
import {
  CLIENT_OBJECT,
  ClientDurableObject,
  type ClientObject,
  refreshOnEachCall,
} from "@composable-os/db/client-objects";
import { PROOF } from "@composable-os/db/client-proofs";
import { runnerJudge } from "../extensions/ai.ts";
import { paymentEventDeps } from "./payments.ts";
import { HostQueue, type QueueCaller, type QueueHost } from "./queue.ts";
import { adapterFor, type SyncKind } from "./sync.ts";

// biome-ignore lint/suspicious/noExplicitAny: gatekeeper accounts, facets and sessions are RPC stubs whose types live in each vendor's package; the host treats them structurally.
type Stub = any;

const STAGE_TTL_MS = 15 * 60_000;
const CATCH_UP_MS = 15 * 60_000;
const BACKFILL_STEP_MS = 1_000;
const SYNC_SOON_MS = 5_000;
const SYNC_PAGE = 25;
const RECONCILE_WINDOW_MS = 7 * 86_400_000;

interface Meta {
  connectionId: string;
  vendor: string;
  scope: "personal" | "org";
  ownerUserId: string;
  title: string;
}

interface PendingConnect {
  vendor: string;
  userId: string;
  nonceHash: string;
  appOrigin: string;
  mode: "connect" | "reconnect" | "companion";
  startedAt: number;
}

interface Staged {
  vendor: string;
  ticketHash: string;
  expiresAt: number;
  mode: "connect" | "reconnect" | "companion";
  stageId?: string;
}

interface FacetRecord {
  key: string;
  url: string;
  pattern: string;
  title: string;
  tsType: string;
  bindingName: string;
  hookTsType?: string;
  /** The account that minted it: the connection's vendor or its companion. */
  vendor: string;
}

interface HookRecord {
  id: string;
  facetKey: string;
  purpose: "sync" | "webhook" | "payments" | "text-events" | "agent";
  title: string;
  description: string;
  enabled: boolean;
}

interface SyncState {
  config: SyncConfig;
  mail?: KindState;
  calendar?: KindState;
}

interface KindState {
  resource: string;
  cursor: string | null;
  since: string;
  backfilled: boolean;
  lastError?: string | null;
  lastRunAt?: string;
  created?: number;
  restricted?: number;
  /** Delete reconciliation walks 7-day windows from `since`; the next one starts here. */
  reconcileFrom?: string;
  deleted?: number;
}

/** Longest sync error kept in the host's state and mirrored to D1. */
const SYNC_ERROR_MAX = 500;

/**
 * The text a failed sync pass keeps (in the host's storage and mirrored to the connection row in
 * D1). Provider and ingest errors can quote mail addresses; they are replaced so a sync error
 * never holds an address an erase could not find (ADR 0019 amendment, erase completeness).
 */
export function syncErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[^\s"'<>()[\]{},;:]+/g, "[address]")
    .slice(0, SYNC_ERROR_MAX);
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Plain JSON for a session's result: cursors give their first page, capabilities a marker. */
async function toJson(value: unknown, depth = 0): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (typeof value === "function") {
    // An RPC stub (a cursor or a capability). A cursor answers next().
    try {
      const page = await (value as unknown as { next(): Promise<unknown> }).next();
      return depth < 2 ? toJson(page, depth + 1) : null;
    } catch {
      return "[capability]";
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Promise.all(value.slice(0, 200).map((v) => toJson(v, depth)));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === "function" ? "[capability]" : await toJson(v, depth);
    }
    return out;
  }
  return value;
}

/** A method name a caller may name on a session or a configurator (never `constructor`). */
function isCallableName(method: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(method) && method !== "constructor";
}

async function loadUser(env: Env, id: string): Promise<ActingUser> {
  // The host's own sends (customer sign-in codes, stage 23): the system user, no core_user row.
  // Only cos-app's and cos-runner's own code names it; no caller can supply it.
  if (id === SYSTEM_USER.id) return SYSTEM_USER;
  const row = await env.DB.prepare("SELECT id, email, name, role FROM core_user WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string; name: string; role: string }>();
  if (!row) throw new Error(`The user ${id} no longer exists`);
  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer";
  return { id: row.id, email: row.email, name: row.name, role };
}

/** Sync hooks call back with whatever their gatekeeper's hook interface names; all mean "pull". */
class SyncHookTarget extends RpcTarget {
  readonly #poke: () => Promise<void>;
  constructor(poke: () => Promise<void>) {
    super();
    this.#poke = poke;
  }
  changed() {
    return this.#poke();
  }
  receiveMessage(_entry: unknown) {
    return this.#poke();
  }
  receiveEvent(_event: unknown) {
    return this.#poke();
  }
  newMessage(_entry: unknown) {
    return this.#poke();
  }
}

/** Webhook deliveries become integration events (stage 5 triggers on them). */
class WebhookSink extends RpcTarget {
  readonly #env: Env;
  readonly #connectionId: string;
  constructor(env: Env, connectionId: string) {
    super();
    this.#env = env;
    this.#connectionId = connectionId;
  }
  async receiveEvent(event: {
    id?: string;
    endpointId?: string;
    scheme?: string;
    type?: string;
    receivedAt?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<void> {
    await recordIntegrationEvents(createCrmDb(this.#env.DB), [
      {
        source: "webhook",
        connectionId: this.#connectionId,
        type: String(event?.type ?? "webhook").slice(0, 200),
        externalId: event?.id ? `${event.endpointId ?? ""}:${event.id}` : null,
        payload: {
          endpointId: event?.endpointId ?? null,
          scheme: event?.scheme ?? null,
          payload: event?.payload ?? null,
          headers: event?.headers ?? {},
        },
        occurredAt: event?.receivedAt ?? new Date().toISOString(),
      },
    ]);
  }
}

/**
 * Verified payment events (stage 25, ADR 0429): stored as the provider's word, then applied to
 * their orders through order.applyPaymentEvent. Storing is what this delivery must get done (the
 * gatekeeper retries until it does); applying is retried here on a stale order and by the minute
 * cron, so a failure to apply never loses the event.
 */
export class PaymentSink extends RpcTarget {
  readonly #env: Env;
  readonly #connectionId: string;
  constructor(env: Env, connectionId: string) {
    super();
    this.#env = env;
    this.#connectionId = connectionId;
  }
  async receiveEvent(event: unknown): Promise<void> {
    const crm = createCrmDb(this.#env.DB);
    const key = await recordPaymentEvent(crm, event, this.#connectionId, new Date().toISOString());
    if (!key) {
      console.warn("payments: a delivered event was not one this host understands");
      return;
    }
    try {
      await applyStoredPaymentEvent(paymentEventDeps(this.#env), key);
    } catch (error) {
      // Stored: the minute cron applies it.
      console.error("payments: event stored, not yet applied", key.eventId, errorForLog(error));
    }
  }
}

/**
 * The text gatekeeper's verified receipts and replies (stage 30, ADR 0672): a receipt settles its
 * routine message's row, a STOP stops every text to the number, a START lifts it. Applied at once;
 * a failure is thrown, so the gatekeeper's delivery queue tries again.
 */
export class TextSink extends RpcTarget {
  readonly #env: Env;
  constructor(env: Env) {
    super();
    this.#env = env;
  }
  async receiveEvent(event: unknown): Promise<void> {
    const done = await applyTextEvent(createCrmDb(this.#env.DB).query, event);
    if (done === "ignored") console.warn("text: a delivered event was not one this host applies");
  }
}

export class IntegrationHost extends ClientDurableObject(DurableObject<Env>) {
  /** Configurator `ui` capabilities by resource pattern, for this isolate's lifetime. */
  #configurators = new Map<string, Stub>();
  /**
   * Whose connection this is on a many-client host (stage 66, ADR 0615): named
   * `<client>:<connectionId>` by the INTEGRATION_HOST wrapper, it runs on that client's
   * environment, and every entrypoint it mints for a gatekeeper carries that client in its props.
   */
  get #client(): ClientObject<Env> {
    return this[CLIENT_OBJECT] as unknown as ClientObject<Env>;
  }

  /**
   * The host's proof on what this object mints for a gatekeeper (review of #512, S1): of this
   * object's own client, its generation and the connection; it can sign for no other client.
   */
  #mintProof(connectionId: string): string | null {
    return this.#client.proof(PROOF.callback, connectionId);
  }

  // --- State ----------------------------------------------------------------------------------

  async #meta(): Promise<Meta> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (meta) return meta;
    // First use: read the mirror row the operation wrote.
    const id = this.#client.name ?? "";
    const row = await this.env.DB.prepare(
      "SELECT id, vendor, scope, owner_user_id, title FROM core_integration_connection WHERE id = ?",
    )
      .bind(id)
      .first<{
        id: string;
        vendor: string;
        scope: "personal" | "org";
        owner_user_id: string;
        title: string;
      }>();
    if (!row) throw new Error(`No connection ${id}`);
    const fresh: Meta = {
      connectionId: row.id,
      vendor: row.vendor,
      scope: row.scope,
      ownerUserId: row.owner_user_id,
      title: row.title,
    };
    await this.ctx.storage.put("meta", fresh);
    return fresh;
  }

  #vendor(vendor: string): Stub {
    const offered = gatekeeperOffered(this.env, vendorBinding(vendor));
    if (!offered.offered) {
      throw new Error(
        offered.why.includes("not available on this host")
          ? `The ${vendor} gatekeeper is not available on this host yet`
          : `The ${vendor} gatekeeper is not deployed here`,
      );
    }
    const binding = (this.env as unknown as Record<string, unknown>)[vendorBinding(vendor)];
    if (!binding) throw new Error(`The ${vendor} gatekeeper is not deployed here`);
    if (vendor === "fake" && this.env.INTEGRATIONS_FAKE_PROVIDER !== "true") {
      throw new Error("The fake provider is turned off");
    }
    return binding;
  }

  async #account(vendor?: string): Promise<Stub> {
    const meta = await this.#meta();
    const key = !vendor || vendor === meta.vendor ? "account" : `companion:${vendor}`;
    const account = await this.ctx.storage.get<Stub>(key);
    if (!account) throw new Error("This connection has no connected account yet");
    return account;
  }

  async #mirror(set: Record<string, unknown>): Promise<void> {
    const meta = await this.#meta();
    const columns = Object.keys(set);
    if (!columns.length) return;
    await this.env.DB.prepare(
      `UPDATE core_integration_connection SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    )
      .bind(...columns.map((c) => set[c] ?? null), new Date().toISOString(), meta.connectionId)
      .run();
  }

  // --- Connect --------------------------------------------------------------------------------

  async startConnect(input: {
    vendor: string;
    userId: string;
    appOrigin?: string;
  }): Promise<ConnectStart> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId)
      throw new Error("Only the connection's owner can connect it");
    return this.#begin(
      input.vendor,
      input.userId,
      input.appOrigin,
      input.vendor === meta.vendor ? "connect" : "companion",
    );
  }

  async #begin(
    vendor: string,
    userId: string,
    appOrigin: string | undefined,
    mode: PendingConnect["mode"],
  ): Promise<ConnectStart> {
    const meta = await this.#meta();
    const origin = appOrigin ?? this.env.APP_ORIGIN;
    if (!origin) {
      throw new Error(
        perClientMissing(this.env, "APP_ORIGIN") ??
          "The CRM's public origin is unknown (APP_ORIGIN)",
      );
    }
    const nonce = token();
    await this.ctx.storage.put<PendingConnect>("connect", {
      vendor,
      userId,
      nonceHash: await sha256Hex(nonce),
      appOrigin: new URL(origin).origin,
      mode,
      startedAt: Date.now(),
    });
    let url: string;
    if (mode === "reconnect") {
      ({ url } = await (await this.#account(vendor)).reconnect());
    } else {
      const callback = this.ctx.exports.ConnectCallback({
        props: {
          connectionId: meta.connectionId,
          vendor,
          client: this.#client.client,
          proof: this.#mintProof(meta.connectionId),
        },
      });
      ({ url } = await this.#vendor(vendor).connectAccount(callback, {}));
    }
    await this.#scheduleAlarm(Date.now() + STAGE_TTL_MS);
    return { url, nonce };
  }

  /** ConnectCallback.complete(): stage the account until the initiator redeems the ticket. */
  async stage(
    vendor: string,
    account: Stub,
    expiresAt?: Date,
  ): Promise<{ targetOrigin: string; ticket: string }> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (!pending || pending.vendor !== vendor) {
      try {
        await account.revoke();
      } catch {}
      throw new Error("No connect flow is waiting for this account");
    }
    const ticket = `${meta.connectionId}.${token()}`;
    await this.ctx.storage.put("staged-account", account);
    await this.ctx.storage.put<Staged>("staged", {
      vendor,
      ticketHash: await sha256Hex(ticket),
      expiresAt: Date.now() + STAGE_TTL_MS,
      mode: pending.mode,
    });
    if (expiresAt)
      await this.ctx.storage.put("credentials-expire", new Date(expiresAt).toISOString());
    return { targetOrigin: pending.appOrigin, ticket };
  }

  /** ConnectCallback.reconnectComplete(): credentials staged in the gatekeeper, keyed by stageId. */
  async stageReconnect(
    vendor: string,
    stageId: string,
  ): Promise<{ targetOrigin: string; ticket: string }> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (pending?.mode !== "reconnect" || pending.vendor !== vendor) {
      throw new Error("No reconnect is waiting");
    }
    const ticket = `${meta.connectionId}.${token()}`;
    await this.ctx.storage.put<Staged>("staged", {
      vendor,
      ticketHash: await sha256Hex(ticket),
      expiresAt: Date.now() + STAGE_TTL_MS,
      mode: "reconnect",
      stageId,
    });
    return { targetOrigin: pending.appOrigin, ticket };
  }

  async credentialsChanged(state: "expired" | "restored"): Promise<void> {
    await this.#mirror(
      state === "expired"
        ? { status: "expired", error: "The provider says the credentials expired. Reconnect." }
        : { status: "active", error: null },
    );
    if (state === "expired") {
      // Run-as (ADR 0170): automations bound to this connection pause and the admins are told.
      // Reconnecting does not restore the bindings: a person binds it again.
      const meta = await this.#meta();
      await revokeBindings(
        createCrmDb(this.env.DB),
        { connectionId: meta.connectionId },
        { reason: `${meta.title}'s credentials expired`, by: null },
      );
    } else {
      await this.#resumeSync();
    }
  }

  /** Redeems a handoff ticket over the initiating user's session (with the popup's nonce). */
  async redeem(input: { ticket: string; nonce: string; userId: string }): Promise<ConnectRedeemed> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    const staged = await this.ctx.storage.get<Staged>("staged");
    const fail = async (message: string): Promise<never> => {
      await this.#dropStaged();
      throw new Error(message);
    };
    if (!pending || !staged) return fail("No connect flow is waiting. Start again.");
    if (staged.expiresAt < Date.now()) return fail("This connect flow expired. Start again.");
    if (input.userId !== pending.userId)
      return fail("Only the user who started this flow can finish it");
    if ((await sha256Hex(input.nonce)) !== pending.nonceHash)
      return fail("This handoff is not for this window");
    if ((await sha256Hex(input.ticket)) !== staged.ticketHash)
      return fail("Unknown or used ticket");

    await this.ctx.storage.delete(["connect", "staged"]);
    let label: string | null = null;
    if (staged.mode === "reconnect") {
      await (await this.#account(staged.vendor)).commitReconnect(staged.stageId ?? "");
      // An expired connection's sync stopped (#syncPass): it carries on from its cursors once
      // `connection.completeConnect` has marked the connection active again.
      await this.#resumeSync();
    } else {
      const account = await this.ctx.storage.get<Stub>("staged-account");
      await this.ctx.storage.delete("staged-account");
      const key = staged.mode === "companion" ? `companion:${staged.vendor}` : "account";
      await this.ctx.storage.put(key, account);
    }
    if (staged.mode !== "companion") {
      try {
        const d = await (await this.#account()).describe();
        label = d?.uniqueName ?? d?.displayName ?? null;
      } catch {
        label = null;
      }
    }
    // A companion gatekeeper (Slack posting) connects next, in the same popup.
    const entry = catalogueEntry(meta.vendor);
    let next: ConnectRedeemed["next"] = null;
    if (staged.mode === "connect" && entry?.companion) {
      const binding = (this.env as unknown as Record<string, unknown>)[
        vendorBinding(entry.companion)
      ];
      if (binding) {
        const start = await this.#begin(
          entry.companion,
          input.userId,
          pending.appOrigin,
          "companion",
        );
        next = { ...start, vendor: entry.companion };
      }
    }
    return { accountLabel: label, next };
  }

  async #dropStaged(): Promise<void> {
    const account = await this.ctx.storage.get<Stub>("staged-account");
    await this.ctx.storage.delete(["connect", "staged", "staged-account"]);
    if (account) {
      try {
        await account.revoke();
      } catch (error) {
        console.warn("could not revoke a staged account", error);
      }
    }
  }

  async reconnect(input: { userId: string; appOrigin?: string }): Promise<ConnectStart> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId) throw new Error("Only the owner can reconnect");
    return this.#begin(meta.vendor, input.userId, input.appOrigin, "reconnect");
  }

  /** An auto-provisioned account (web search, email sending, webhooks). */
  async provision(input: {
    vendor: string;
    userId: string;
  }): Promise<{ accountLabel: string | null }> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId)
      throw new Error("Only the connection's owner can provision it");
    const vendor = this.#vendor(input.vendor);
    const account = await vendor.createAccount();
    await this.ctx.storage.put("account", account);
    const d = await account.describe();
    if (d?.singleton) {
      // The singleton facet is installed like any other and exposed to every usable actor.
      const cls = await account.getSingletonGatekeeperClass();
      await this.ctx.storage.put("class:singleton", cls);
      const facet = this.#facet("singleton", cls);
      const r = await facet.describe();
      const resource: FacetRecord = {
        key: "singleton",
        url: r.url,
        pattern: "singleton",
        title: r.title,
        tsType: r.tsType,
        bindingName: r.suggestedBindingName,
        vendor: input.vendor,
      };
      await this.ctx.storage.put("facet:singleton", resource);
      await this.#mirror({ resources: JSON.stringify([this.#bound(resource)]) });
    }
    return { accountLabel: d?.displayName ?? null };
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.delete("sync");
    for (const hook of (await this.ctx.storage.list<HookRecord>({ prefix: "hook:" })).values()) {
      await this.#dropHook(hook);
    }
    for (const key of [
      "account",
      ...[...(await this.ctx.storage.list({ prefix: "companion:" })).keys()],
    ]) {
      const account = await this.ctx.storage.get<Stub>(key);
      if (account) {
        try {
          await account.revoke();
        } catch (error) {
          console.warn("revoke failed", error);
        }
      }
    }
    const facets = await this.ctx.storage.list<FacetRecord>({ prefix: "facet:" });
    for (const record of facets.values()) await this.#dropFacet(record.key);
    await this.#dropStaged();
    await this.ctx.storage.delete(["account", "meta"]);
    await this.ctx.storage.deleteAlarm();
  }

  // --- Facets ---------------------------------------------------------------------------------

  #facet(key: string, cls: Stub): Stub {
    return this.ctx.facets.get(`f-${key}`, () => ({ class: cls }));
  }

  /** The running facet for a resource, recreated from its stored class after a restart. */
  async #facetFor(key: string): Promise<{ facet: Stub; record: FacetRecord }> {
    const record = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
    if (!record) throw new Error(`No resource ${key} on this connection`);
    const cls = await this.ctx.storage.get<Stub>(`class:${key}`);
    if (!cls) throw new Error(`The class of resource ${key} is missing`);
    return { facet: this.#facet(key, cls), record };
  }

  #bound(r: FacetRecord): BoundResource {
    return {
      key: r.key,
      url: r.url,
      pattern: r.pattern,
      title: r.title,
      tsType: r.tsType,
      bindingName: r.bindingName,
      ...(r.hookTsType ? { hookTsType: r.hookTsType } : {}),
    };
  }

  async bindResource(url: string): Promise<BoundResource> {
    const meta = await this.#meta();
    const key = (await sha256Hex(url)).slice(0, 16);
    const existing = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
    if (existing) return this.#bound(existing);
    let vendor = meta.vendor;
    let minted: { class: Stub; resource: { urlPattern: string } };
    try {
      minted = await (await this.#account()).getGatekeeperClassFor(url);
    } catch (error) {
      const companion = catalogueEntry(meta.vendor)?.companion;
      const other = companion ? await this.ctx.storage.get<Stub>(`companion:${companion}`) : null;
      if (!companion || !other) throw error;
      minted = await other.getGatekeeperClassFor(url);
      vendor = companion;
    }
    await this.ctx.storage.put(`class:${key}`, minted.class);
    const facet = this.#facet(key, minted.class);
    const d = await facet.describe();
    const record: FacetRecord = {
      key,
      url: d?.url ?? url,
      pattern: minted.resource?.urlPattern ?? "",
      title: d?.title ?? url,
      tsType: d?.tsType ?? "unknown",
      bindingName: d?.suggestedBindingName ?? "RESOURCE",
      ...(d?.hookTsType ? { hookTsType: d.hookTsType } : {}),
      vendor,
    };
    await this.ctx.storage.put(`facet:${key}`, record);
    // A payment account delivers its verified events to the host from the moment it is bound.
    if (meta.vendor === "payments") {
      await this.#withSession(
        key,
        { kind: "system", purpose: "payments", user: await loadUser(this.env, meta.ownerUserId) },
        (s) => s.subscribe(new PaymentSink(this.env, meta.connectionId)),
      );
    }
    // The text sender delivers its verified receipts and replies from the moment it is bound.
    if (meta.vendor === "text") {
      await this.#withSession(
        key,
        {
          kind: "system",
          purpose: "text-events",
          user: await loadUser(this.env, meta.ownerUserId),
        },
        (s) => s.subscribe(new TextSink(this.env)),
      );
    }
    // A webhook endpoint delivers into the CRM's event log from the moment it is bound.
    if (meta.vendor === "webhook") {
      await this.#withSession(
        key,
        { kind: "system", purpose: "webhook", user: await loadUser(this.env, meta.ownerUserId) },
        (s) => s.subscribe(new WebhookSink(this.env, meta.connectionId)),
      );
    }
    return this.#bound(record);
  }

  async unbindResource(key: string): Promise<void> {
    for (const hook of (await this.ctx.storage.list<HookRecord>({ prefix: "hook:" })).values()) {
      if (hook.facetKey === key) await this.#dropHook(hook);
    }
    await this.#dropFacet(key);
    const sync = await this.ctx.storage.get<SyncState>("sync");
    if (sync && (sync.config.mail === key || sync.config.calendar === key)) {
      await this.setSync({
        ...sync.config,
        mail: sync.config.mail === key ? null : sync.config.mail,
        calendar: sync.config.calendar === key ? null : sync.config.calendar,
      });
    }
  }

  /** Stops a facet and forgets it and its class. */
  async #dropFacet(key: string): Promise<void> {
    try {
      this.ctx.facets.delete(`f-${key}`);
    } catch {}
    await this.ctx.storage.delete([`facet:${key}`, `class:${key}`]);
  }

  async supportedResources(): Promise<
    { urlPattern: string; title: string; description: string; grantable: boolean; vendor: string }[]
  > {
    const meta = await this.#meta();
    const out: {
      urlPattern: string;
      title: string;
      description: string;
      grantable: boolean;
      vendor: string;
    }[] = [];
    const accounts: [string, Stub][] = [[meta.vendor, await this.#account()]];
    for (const [key, stub] of await this.ctx.storage.list<Stub>({ prefix: "companion:" })) {
      accounts.push([key.slice("companion:".length), stub]);
    }
    for (const [vendor, account] of accounts) {
      const list = (await account.getSupportedResources()) as {
        urlPattern: string;
        title: string;
        description?: string;
        grantable?: boolean;
      }[];
      for (const r of list ?? []) {
        out.push({
          urlPattern: r.urlPattern,
          title: r.title,
          description: r.description ?? "",
          grantable: r.grantable !== false,
          vendor,
        });
      }
    }
    return out;
  }

  async configure(pattern: string, method: string, args: unknown[]): Promise<unknown> {
    let ui = this.#configurators.get(pattern);
    if (!ui) {
      const frame = await (await this.#account()).startResourceConfigurator(pattern);
      ui = frame.ui;
      this.#configurators.set(pattern, ui);
    }
    if (!isCallableName(method)) {
      throw new Error("Not a configurator method");
    }
    return toJson(await ui[method](...args));
  }

  async types(key: string): Promise<string> {
    const { facet } = await this.#facetFor(key);
    return facet.getTypeScriptTypes();
  }

  // --- Sessions -------------------------------------------------------------------------------

  #queueHost(meta: Meta, record: FacetRecord): QueueHost {
    return {
      env: this.env,
      connectionId: meta.connectionId,
      connectionTitle: meta.title,
      vendor: record.vendor,
      ownerUserId: meta.ownerUserId,
      facetKey: record.key,
      resourceTitle: record.title,
      apply: (facetKey, action, stoppable) => this.applyOutbound(facetKey, action, stoppable),
      reject: async (facetKey, action) => {
        await this.rejectOutbound(facetKey, action);
      },
      stashController: async (controller) => {
        const id = token();
        await this.ctx.storage.put(`controller:${id}`, controller);
        return id;
      },
      enableHook: (id, facetKey, purpose, d) => this.#enableHook(id, facetKey, purpose, d),
      // Hooks agents ask for wait for a person (stage 5 binds them to automations).
      recordAgentHook: async (id, facetKey, d) => {
        await this.ctx.storage.put<HookRecord>(`hook:${id}`, {
          id,
          facetKey,
          purpose: "agent",
          ...d,
          enabled: false,
        });
      },
    };
  }

  /**
   * The host-only rule (stage 61, ADR 0881): the books a connection's gatekeeper keeps are opened
   * only by the host's accounting call, and that call opens nothing else. Checked for every
   * session, whoever opens it, so no person, AI, MCP client or extension reaches the books.
   */
  #assertBooksCaller(meta: Meta, record: FacetRecord, caller: QueueCaller | null): void {
    const books = keepsBooks(meta.vendor) || keepsBooks(record.vendor);
    const accounting = caller?.kind === "system" && caller.purpose === "accounting";
    if (books && !accounting) {
      throw new Error(
        `${ACCOUNTING_HOST_ONLY}: the accounting connection is the host's alone; only the accounting sync calls it`,
      );
    }
    if (accounting && !books) throw new Error("The host's accounting call reaches books only");
  }

  async #withSession<T>(
    key: string,
    caller: QueueCaller,
    run: (session: Stub, queue: HostQueue) => Promise<T>,
  ): Promise<{ value: T; queue: HostQueue }> {
    const meta = await this.#meta();
    const { facet, record } = await this.#facetFor(key);
    this.#assertBooksCaller(meta, record, caller);
    const queue = new HostQueue(this.#queueHost(meta, record), caller);
    const session = await facet.startSession(queue);
    try {
      const value = await run(session, queue);
      await queue.settle();
      return { value, queue };
    } finally {
      try {
        session[Symbol.dispose]?.();
      } catch {}
    }
  }

  async call(input: {
    resource: string;
    method: string;
    args: unknown[];
    caller: IntegrationCaller;
  }): Promise<IntegrationCallResult> {
    const meta = await this.#meta();
    if (meta.scope === "personal" && input.caller.userId !== meta.ownerUserId) {
      throw new Error("A personal connection is used only by its owner's actors");
    }
    if (!isCallableName(input.method)) {
      throw new Error("Not a session method");
    }
    const user = await loadUser(this.env, input.caller.userId);
    const { value, queue } = await this.#withSession(
      input.resource,
      { kind: "actor", caller: input.caller, user },
      async (session) => toJson(await session[input.method](...input.args)),
    );
    return { value, pending: queue.pending, applied: queue.applied, failed: queue.failed };
  }

  /**
   * A session call the host makes for itself (stage 25, ADR 0429): an order's checkout and its
   * confirmation email, or the accounting sync's reads and entries (ADR 0881). Only platform code
   * reaches it (`IntegrationRuntime.callAsHost`); an outbound action it submits is the host's own
   * message. Org connections only.
   */
  async callAsHost(input: {
    resource: string;
    method: string;
    args: unknown[];
    purpose: "orders" | "sign-in" | "agreements" | "accounting" | "phone-check";
    origin?: string;
  }): Promise<IntegrationCallResult> {
    const meta = await this.#meta();
    if (meta.scope !== "org") throw new Error("The host uses org connections only");
    if (
      input.purpose !== "orders" &&
      input.purpose !== "sign-in" &&
      input.purpose !== "agreements" &&
      input.purpose !== "accounting" &&
      input.purpose !== "phone-check"
    ) {
      throw new Error("Not a purpose the host calls for");
    }
    if (!isCallableName(input.method)) {
      throw new Error("Not a session method");
    }
    let caller: QueueCaller;
    if (input.purpose === "sign-in") {
      // The host's sign-in mail (ADR 0456): one send, for a customer's or a staff member's code,
      // by the system user. The queue tells the gatekeeper so; no other caller's queue does.
      if (input.method !== "send") throw new Error("Sign-in mail is one send");
      const origin = SIGN_IN_MAIL_ORIGINS.find((o) => o === input.origin);
      if (!origin) throw new Error("Not an origin the host sends sign-in mail for");
      caller = { kind: "system", purpose: "sign-in", origin, user: SYSTEM_USER };
    } else if (input.purpose === "agreements") {
      // The copy of a signed agreement (ADR 0645): one send, by the system user. The queue tells
      // the gatekeeper it may carry the signed PDF; no other caller's queue does. Or, once its
      // acceptance is erased, the scrub of that copy (ADR 0646), which the gatekeeper allows only
      // to this same queue.
      if (input.method !== "send" && input.method !== "scrubAgreementCopy") {
        throw new Error("Agreements mail is one send, or the scrub of one copy");
      }
      caller = { kind: "system", purpose: "agreements", user: SYSTEM_USER };
    } else if (input.purpose === "accounting") {
      // The accounting sync (ADR 0881): reads of the books and entries host code composed from
      // host records, by the system user. Its posts apply at once unless the floor denies them; a
      // void always waits for an admin (ALWAYS_REVIEWED_KINDS).
      caller = { kind: "system", purpose: "accounting", user: SYSTEM_USER };
    } else if (input.purpose === "phone-check") {
      // A member's number checked by code (ADR 0673): one code sent, or one checked, by the
      // system user. The text gatekeeper takes either from this queue only.
      if (input.method !== "startCheck" && input.method !== "check") {
        throw new Error("A phone check sends a code or checks one");
      }
      if (meta.vendor !== "text") throw new Error("A phone check goes through the text connection");
      caller = { kind: "system", purpose: "phone-check", user: SYSTEM_USER };
    } else {
      caller = {
        kind: "system",
        purpose: "orders",
        user: await loadUser(this.env, meta.ownerUserId),
      };
    }
    const { value, queue } = await this.#withSession(input.resource, caller, async (session) =>
      toJson(await session[input.method](...input.args)),
    );
    return {
      value,
      pending: queue.pending,
      applied: queue.applied,
      failed: queue.failed,
      // What the deploy-time floor refused: the host's own calls tell a refusal from a wait.
      ...(queue.denied.length ? { denied: queue.denied } : {}),
    };
  }

  /**
   * Sends one routine email (ADR 0590): the row of core_routine_mail `id`, which the host wrote
   * when an automation of a shipped pack asked for it. Only the runner's routine-mail module calls
   * this. The message and the recipient are the row's, never a caller's; the queue tells the gate
   * and the gatekeeper whether the host decided it routine. Org connections only, the row's own.
   */
  async sendRoutineMail(input: { id: string; resource: string }): Promise<{
    status: "sent" | "waiting" | "denied" | "failed" | "skipped" | "off" | "stopped";
    pendingActionId?: string;
    error?: string;
  }> {
    const meta = await this.#meta();
    if (meta.scope !== "org") throw new Error("Routine mail goes out from org connections only");
    const db = createCrmDb(this.env.DB).query;
    // Whether routine email goes on its own under the policy and the deploy floor now: an email
    // carrying a personal link goes only then, never to a person's approval (ADR 0723).
    const gate = evaluateGate(
      {
        actor: "automation",
        risk: "outbound",
        outbound: { autoApprovable: false, enabled: false, routine: true },
      },
      await loadApprovalPolicy(db),
      parseFloor(this.env.APPROVAL_FLOOR),
    );
    const row = await claimRoutineMail(db, input.id, meta.connectionId, undefined, {
      sendsOnItsOwn: gate.decision === "auto",
    });
    if (!row) return { status: "skipped" };
    // Turned off since it was prepared (F2), or stopped by the person (ADR 0675): nothing is sent.
    if (row === "off" || row === "stopped") return { status: row };
    // Not sent and settled (a receipt over the day's limit, a personal link that cannot go).
    if (row === "failed") return { status: "failed" };
    const settings = await loadRoutineMailSettings(db);
    const caller: QueueCaller = {
      kind: "system",
      purpose: "routine-mail",
      user: await loadUser(this.env, meta.ownerUserId),
      routine: {
        id: row.id,
        kind: row.kind,
        routine: row.routine,
        ordinary: row.ordinary,
        heldReason: row.heldReason,
        automationId: row.automationId,
        runId: row.runId,
        extensionId: row.extensionId,
        siteOrigin: siteOriginOf(settings.siteOrigin),
      },
    };
    let queue: HostQueue;
    let receipt: unknown;
    try {
      ({ queue, value: receipt } = await this.#withSession(
        input.resource,
        caller,
        async (session) =>
          toJson(await session.send({ ...row.message, idempotencyKey: `routine:${row.id}` })),
      ));
    } catch (error) {
      // Not sent (the queue full, the sender refused): the row waits for the step's retry.
      const message = error instanceof Error ? error.message : String(error);
      await settleRoutineMail(db, row.id, { status: "ready", error: message });
      throw error;
    }
    const pending = queue.pending[0];
    if (pending) {
      await settleRoutineMail(db, row.id, { status: "waiting", pendingActionId: pending.actionId });
      return { status: "waiting", pendingActionId: pending.actionId };
    }
    const failed = queue.failed[0];
    if (failed) {
      await settleRoutineMail(db, row.id, { status: "failed", error: failed.message });
      return { status: "failed", error: failed.message };
    }
    if (queue.denied.length) {
      await settleRoutineMail(db, row.id, { status: "denied" });
      return { status: "denied" };
    }
    // Applied now, or (a retried step) the send the key already made: as the gatekeeper says.
    const sent =
      queue.applied.length > 0 || (receipt as { status?: unknown } | null)?.status === "sent";
    if (sent) {
      await settleRoutineMail(db, row.id, { status: "sent" });
      return { status: "sent" };
    }
    // Waiting since an earlier try of the step (its pending action was recorded then).
    return { status: "waiting" };
  }

  /**
   * Sends one routine text (ADR 0672): the text row of core_routine_mail `id`, claimed here (its
   * kind and text still on, its number not stopped, its cost within the month's limit, its
   * number's day) and sent with the row's own words, never a caller's, through the routine-mail
   * queue, which tells the gate and the text gatekeeper whether the host decided it routine. A held
   * one is put to a person. Only the runner's send step calls this. The text connection only.
   */
  async sendRoutineText(input: { id: string; resource: string }): Promise<{
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
  }> {
    const meta = await this.#meta();
    if (meta.scope !== "org" || meta.vendor !== "text") {
      throw new Error("Routine texts go out through the org text connection only");
    }
    const db = createCrmDb(this.env.DB).query;
    const claimed = await claimRoutineText(db, input.id, meta.connectionId);
    if (!claimed) return { status: "skipped" };
    if (claimed.status !== "send") return { status: claimed.status };
    const row = claimed.row;
    const settings = await loadRoutineMailSettings(db);
    const caller: QueueCaller = {
      kind: "system",
      purpose: "routine-mail",
      user: await loadUser(this.env, meta.ownerUserId),
      routine: {
        id: row.id,
        kind: row.kind,
        routine: row.routine,
        ordinary: false,
        heldReason: row.heldReason,
        automationId: row.automationId,
        runId: row.runId,
        extensionId: row.extensionId,
        siteOrigin: siteOriginOf(settings.siteOrigin),
        channel: "text",
      },
    };
    let queue: HostQueue;
    let receipt: unknown;
    try {
      ({ queue, value: receipt } = await this.#withSession(
        input.resource,
        caller,
        async (session) =>
          toJson(
            await session.send({
              to: row.to,
              text: row.text,
              business: row.business,
              idempotencyKey: `routine:${row.id}`,
            }),
          ),
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The gatekeeper refused the text itself (its shape, a STOP): it never goes, so it is not
      // tried again every minute (the review of PR #435).
      if (/^(Invalid text|Refused)/.test(message)) {
        await settleRoutineText(db, row, { status: "failed", error: message, refund: true });
        return { status: "failed", error: message };
      }
      // Not handed over (a full pending pool, a failure on the way): back as it was, to retry.
      await settleRoutineText(db, row, { status: "back", error: message });
      throw error;
    }
    const pending = queue.pending[0];
    if (pending) {
      await settleRoutineText(db, row, { status: "waiting", pendingActionId: pending.actionId });
      return { status: "waiting", pendingActionId: pending.actionId };
    }
    const failed = queue.failed[0];
    if (failed) {
      await settleRoutineText(db, row, { status: "failed", error: failed.message });
      return { status: "failed", error: failed.message };
    }
    if (queue.denied.length) {
      await settleRoutineText(db, row, { status: "denied" });
      return { status: "denied" };
    }
    const sent =
      queue.applied.length > 0 || (receipt as { status?: unknown } | null)?.status === "sent";
    if (sent) {
      await settleRoutineText(db, row, { status: "sent" });
      return { status: "sent" };
    }
    // The gatekeeper answered with an earlier try's send (its key), still waiting: that try's
    // approval, which the row did not record when the host stopped (the review of PR #435).
    const action = (receipt as { id?: unknown } | null)?.id;
    const earlier =
      typeof action === "number"
        ? await db
            .selectFrom("core_pending_action")
            .select("id")
            .where("connection_id", "=", meta.connectionId)
            .where("gk_action", "=", action)
            .where("status", "=", "pending")
            .executeTakeFirst()
        : undefined;
    if (earlier) {
      await settleRoutineText(db, row, { status: "waiting", pendingActionId: earlier.id });
      return { status: "waiting", pendingActionId: earlier.id };
    }
    // Decided since without being sent (turned down, or expired): it does not go.
    await settleRoutineText(db, row, {
      status: "failed",
      error: "an earlier try of this text was turned down or expired",
    });
    return { status: "failed", error: "an earlier try of this text was turned down or expired" };
  }

  /** A session stub for code (Code Mode, extension tools) acting as `caller`. */
  async openSession(input: { resource: string; caller: IntegrationCaller }): Promise<Stub> {
    const meta = await this.#meta();
    if (meta.scope === "personal" && input.caller.userId !== meta.ownerUserId) {
      throw new Error("A personal connection is used only by its owner's actors");
    }
    const { facet, record } = await this.#facetFor(input.resource);
    this.#assertBooksCaller(meta, record, null);
    const user = await loadUser(this.env, input.caller.userId);
    return facet.startSession(
      new HostQueue(this.#queueHost(meta, record), { kind: "actor", caller: input.caller, user }),
    );
  }

  // --- Outbound -------------------------------------------------------------------------------

  async applyOutbound(facetKey: string, action: number, stoppable?: Stoppable): Promise<void> {
    const { facet } = await this.#facetFor(facetKey);
    if (!stoppable?.recipients.length) {
      await facet.applyAction(action, null);
      return;
    }
    // A stoppable email (ADR 0678): each recipient's stop link is made now, as it goes, and taken
    // back if it does not, so a refused, failed or retried send leaves no token behind.
    const db = createCrmDb(this.env.DB).query;
    const { links, tokens } = await mintStopLinks(db, stoppable);
    try {
      await facet.applyStoppable(action, links);
    } catch (error) {
      await dropStopTokens(db, tokens);
      throw error;
    }
  }

  async rejectOutbound(
    facetKey: string,
    action: number,
  ): Promise<{ restart?: boolean } | undefined> {
    const { facet } = await this.#facetFor(facetKey);
    const result = await facet.rejectAction(action);
    return result && typeof result === "object" ? { restart: Boolean(result.restart) } : undefined;
  }

  // --- Hooks ----------------------------------------------------------------------------------

  async #enableHook(
    id: string,
    facetKey: string,
    purpose: "sync" | "webhook" | "payments" | "text-events",
    d: { title: string; description: string },
  ): Promise<void> {
    const meta = await this.#meta();
    const controller = await this.ctx.storage.get<Stub>(`controller:${id}`);
    if (!controller) throw new Error("The hook controller is gone");
    const initiator = this.ctx.exports.HostHookInitiator({
      props: {
        connectionId: meta.connectionId,
        hookId: id,
        client: this.#client.client,
        proof: this.#mintProof(meta.connectionId),
      },
    });
    await controller.enable(initiator, { workspaceId: meta.connectionId });
    await this.ctx.storage.put<HookRecord>(`hook:${id}`, {
      id,
      facetKey,
      purpose,
      ...d,
      enabled: true,
    });
  }

  /** HookInitiator.startHook(): a fresh callback and queue for one firing. */
  async startHook(hookId: string): Promise<{ callback: RpcTarget; approvalQueue: HostQueue }> {
    const meta = await this.#meta();
    const hook = await this.ctx.storage.get<HookRecord>(`hook:${hookId}`);
    if (!hook?.enabled) throw new Error("This hook is no longer enabled");
    const { record } = await this.#facetFor(hook.facetKey);
    const user = await loadUser(this.env, meta.ownerUserId);
    const purpose =
      hook.purpose === "webhook" || hook.purpose === "payments" || hook.purpose === "text-events"
        ? hook.purpose
        : "sync";
    const queue = new HostQueue(this.#queueHost(meta, record), { kind: "system", purpose, user });
    const callback =
      hook.purpose === "webhook"
        ? new WebhookSink(this.env, meta.connectionId)
        : hook.purpose === "payments"
          ? new PaymentSink(this.env, meta.connectionId)
          : hook.purpose === "text-events"
            ? new TextSink(this.env)
            : new SyncHookTarget(() => this.syncSoon());
    return { callback, approvalQueue: queue };
  }

  /** Disables an enabled hook (best effort) and forgets it and its controller. */
  async #dropHook(hook: HookRecord): Promise<void> {
    const controller = await this.ctx.storage.get<Stub>(`controller:${hook.id}`);
    if (hook.enabled && controller) {
      try {
        await controller.disable();
      } catch {}
    }
    await this.ctx.storage.delete([`hook:${hook.id}`, `controller:${hook.id}`]);
  }

  // --- Sync -----------------------------------------------------------------------------------

  async setSync(config: SyncConfig): Promise<void> {
    const meta = await this.#meta();
    const before = await this.ctx.storage.get<SyncState>("sync");
    const days = config.backfillDays ?? 90;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const state: SyncState = { config };
    for (const kind of ["mail", "calendar"] as const) {
      const key = config[kind];
      if (!key) continue;
      const record = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
      if (
        !record ||
        syncKindOf(meta.vendor, record.url) !== kind ||
        !adapterFor(meta.vendor, kind)
      ) {
        throw new Error(`Resource ${key} cannot sync ${kind}`);
      }
      const prior = before?.[kind];
      state[kind] =
        prior && prior.resource === key
          ? prior
          : { resource: key, cursor: null, since, backfilled: false };
      if (!prior || prior.resource !== key) await this.#subscribeSync(kind, key);
    }
    await this.ctx.storage.put("sync", state);
    await this.#mirrorSync(state);
    await this.#scheduleAlarm(Date.now() + 10);
  }

  async #subscribeSync(kind: SyncKind, key: string): Promise<void> {
    const meta = await this.#meta();
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter?.subscribe) return;
    const user = await loadUser(this.env, meta.ownerUserId);
    try {
      await this.#withSession(
        key,
        { kind: "system", purpose: "sync", user },
        (session) =>
          adapter.subscribe?.(session, new SyncHookTarget(() => this.syncSoon())) ??
          Promise.resolve(),
      );
    } catch (error) {
      // Without push, the periodic catch-up still syncs.
      console.warn("sync: could not subscribe to changes", error);
    }
  }

  async syncSoon(): Promise<void> {
    await this.#scheduleAlarm(Date.now() + SYNC_SOON_MS, true);
  }

  /** Restarts the sync loop an expired connection stopped, if this connection syncs. */
  async #resumeSync(): Promise<void> {
    if (await this.ctx.storage.get<SyncState>("sync")) await this.syncSoon();
  }

  async syncNow(): Promise<void> {
    await this.#syncPass();
  }

  async #scheduleAlarm(at: number, onlyIfEarlier = true): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || !onlyIfEarlier || at < current) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const staged = await this.ctx.storage.get<Staged>("staged");
    if (staged && staged.expiresAt <= Date.now()) await this.#dropStaged();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (pending && pending.startedAt + STAGE_TTL_MS <= Date.now() && !staged) {
      await this.ctx.storage.delete("connect");
    }
    if (await this.ctx.storage.get<SyncState>("sync")) await this.#syncPass();
  }

  /** One sync pass: one chunk per configured kind, then the next alarm. */
  async #syncPass(): Promise<void> {
    const state = await this.ctx.storage.get<SyncState>("sync");
    if (!state) return;
    const meta = await this.#meta();
    const row = await this.env.DB.prepare(
      "SELECT sharing_level, status FROM core_integration_connection WHERE id = ?",
    )
      .bind(meta.connectionId)
      .first<{ sharing_level: string; status: string }>();
    // Expired credentials fail every pull until someone reconnects, so the loop stops here, with
    // no alarm, rather than waking every 15 minutes to fail (docs/cloudflare-costs.md). A
    // reconnect or the provider's "restored" starts it again (#resumeSync).
    if (!row || row.status === "disconnected" || row.status === "expired") return;
    // The owner is read once per pass, for every kind (a failure is each kind's error).
    let owner: Promise<ActingUser> | undefined;
    const user = () => {
      owner ??= loadUser(this.env, meta.ownerUserId);
      return owner;
    };
    let more = false;
    for (const kind of ["mail", "calendar"] as const) {
      const kindState = state[kind];
      if (!kindState) continue;
      try {
        more = (await this.#pullKind(meta, kind, kindState, row.sharing_level, user)) || more;
        kindState.lastError = null;
      } catch (error) {
        kindState.lastError = syncErrorText(error);
      }
      kindState.lastRunAt = new Date().toISOString();
    }
    await this.ctx.storage.put("sync", state);
    await this.#mirrorSync(state);
    await this.ctx.storage.setAlarm(Date.now() + (more ? BACKFILL_STEP_MS : CATCH_UP_MS));
  }

  async #pullKind(
    meta: Meta,
    kind: SyncKind,
    state: KindState,
    sharing: string,
    owner: () => Promise<ActingUser>,
  ): Promise<boolean> {
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter) return false;
    const user = await owner();
    const { value: result } = await this.#withSession(
      state.resource,
      { kind: "system", purpose: "sync", user },
      (session, queue) =>
        adapter.pull(session, state.cursor, {
          since: state.since,
          now: new Date().toISOString(),
          tracker: queue.tracker,
          limit: SYNC_PAGE,
        }),
    );
    state.restricted = (state.restricted ?? 0) + result.restricted;
    // "Don't sync": read nothing into the CRM, but keep the cursor moving.
    if (sharing !== "none") {
      const db = createCrmDb(this.env.DB);
      // sync.jobChange (ADR 0236): a changed signature of a known person may ask the judge.
      const judge = runnerJudge(this.env);
      for (let i = 0; i < result.items.length; i += SYNC_BATCH_MAX) {
        const out = await this.#ingest(meta, user, db, result.items.slice(i, i + SYNC_BATCH_MAX), {
          judge,
          bodies: result.bodies,
        });
        state.created = (state.created ?? 0) + out.created;
      }
    }
    state.cursor = result.cursor;
    if (!result.more) state.backfilled = true;
    // Caught up: reconcile one window for deletes (providers without a delete feed).
    if (!result.more && sharing !== "none") await this.#reconcile(meta, kind, state, user);
    return result.more;
  }

  /**
   * Delete propagation for window-based adapters (Gmail, Google Calendar, Outlook; ADR 0112): one
   * 7-day window per catch-up pass, walking the backfill range and starting again. What the CRM
   * synced in the window and the provider no longer lists (deleted, trashed) is sent to
   * sync.ingest as a delete. Nothing is deleted when the listing was cut short.
   */
  async #reconcile(meta: Meta, kind: SyncKind, state: KindState, user: ActingUser): Promise<void> {
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter?.listIds) return;
    const now = Date.now();
    const start = Math.max(Date.parse(state.reconcileFrom ?? state.since), Date.parse(state.since));
    const end = Math.min(start + RECONCILE_WINDOW_MS, now);
    if (end <= start) {
      state.reconcileFrom = state.since;
      return;
    }
    const from = new Date(start);
    const to = new Date(end);
    const { value: listed } = await this.#withSession(
      state.resource,
      { kind: "system", purpose: "sync", user },
      (session) =>
        adapter.listIds?.(session, from, to) ?? Promise.resolve({ ids: [], complete: false }),
    );
    state.reconcileFrom = end >= now ? state.since : to.toISOString();
    if (!listed.complete) return;
    const present = new Set(listed.ids);
    const db = createCrmDb(this.env.DB);
    const itemKind = kind === "mail" ? "email" : "meeting";
    const synced = await syncedInWindow(db.query, {
      connectionId: meta.connectionId,
      kind: itemKind,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const gone = synced.filter((id) => !present.has(id));
    for (let i = 0; i < gone.length; i += SYNC_BATCH_MAX) {
      const out = await this.#ingest(
        meta,
        user,
        db,
        gone
          .slice(i, i + SYNC_BATCH_MAX)
          .map((providerId) => ({ kind: itemKind, op: "delete", providerId })),
      );
      state.deleted = (state.deleted ?? 0) + out.deleted;
    }
  }

  /**
   * One sync.ingest batch as the connection's owner: the bodies it stored go to R2 (from `bodies`,
   * by external key), then the bodies it sent to Trash leave it.
   */
  async #ingest(
    meta: Meta,
    user: ActingUser,
    db: ReturnType<typeof createCrmDb>,
    items: SyncItem[],
    {
      judge,
      bodies,
    }: { judge?: ReturnType<typeof runnerJudge>; bodies?: Map<string, string> } = {},
  ) {
    const out = await invoke(
      "sync.ingest",
      { connectionId: meta.connectionId, items },
      {
        actor: "automation",
        user,
        origin: { surface: "automation", automationId: `sync:${meta.connectionId}` },
        db,
        ...(judge ? { judge } : {}),
      },
    );
    for (const body of out.bodies) {
      const text = bodies?.get(body.externalKey);
      if (text && this.env.BLOBS) await this.env.BLOBS.put(body.key, text);
    }
    if (out.removedBodies.length && this.env.BLOBS) await this.env.BLOBS.delete(out.removedBodies);
    return out;
  }

  async #mirrorSync(state: SyncState): Promise<void> {
    const view = {
      mail: state.config.mail,
      calendar: state.config.calendar,
      backfillDays: state.config.backfillDays ?? 90,
      status: {
        mail: state.mail ? this.#kindView(state.mail) : null,
        calendar: state.calendar ? this.#kindView(state.calendar) : null,
      },
    };
    const last = [state.mail?.lastRunAt, state.calendar?.lastRunAt].filter(Boolean).sort().at(-1);
    await this.#mirror({ sync: JSON.stringify(view), ...(last ? { last_sync_at: last } : {}) });
  }

  #kindView(s: KindState) {
    return {
      backfilled: s.backfilled,
      since: s.since,
      lastRunAt: s.lastRunAt ?? null,
      lastError: s.lastError ?? null,
      created: s.created ?? 0,
      deleted: s.deleted ?? 0,
      restrictedSkipped: s.restricted ?? 0,
    };
  }
}

// Every async method re-reads the client's admission first (stage 66, review of #512, M2).
refreshOnEachCall(IntegrationHost);
