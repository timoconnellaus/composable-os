// cos-gatekeeper-text: text messages through the business's own text provider account (stage 30,
// ADR 0672). One resource, the business's sender number (`text://sender`); its facet turns every
// send into an approval-queue action, and only the host's own queues may use it:
//
// - its routine messages (`routine-mail`): one row's text, the `text.routine` kind when the host
//   decided it routine and it has routine shape (applied by the host's decision, as routine
//   email), else `text.send`, which a person reviews with the number partly masked;
// - its phone check (`phone-check`): a code sent to a member's own number, and checked;
// - its text events hook (`text-events`): verified receipts and STOP, START and HELP replies.
//
// Every other caller is refused, not reviewed: a text has no free path in this stage. Sends
// waiting for a decision are held to one pool of 500; a full pool refuses the send and the host's
// row stays ready (back-pressure, never a drop). README.md explains the design.
//
// No capnweb-validate decorators: every RPC input is validated explicitly (text.ts).

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
import { eventsStub, type StoredInitiator } from "./events.js";
import { fakeLedger } from "./fake.js";
import { MAX_PENDING_TEXTS, ROUTINE_KIND, SEND_KIND, SENDER_URL } from "./kinds.js";
import {
  baseUrl,
  fakeSecretOrLocal,
  providerFor,
  providerModule,
  senderNumber,
} from "./provider.js";
import { hostRoutine, queueClassOf, REFUSED, type TextQueueClass } from "./queue-class.js";
import { handleRequest } from "./routes.js";
import { isRoutineShaped, maskNumber, type ParsedText, parseNumber, parseText } from "./text.js";
import type { TextEventHook, TextMessage, TextReceipt, TextSession } from "./types.js";
import TYPES_CODE from "./types.txt";

export { TextEvents } from "./events.js";
export { FakeTextLedger } from "./fake.js";

type Env = Cloudflare.Env;
type TextHookTarget = RpcTarget & TextEventHook;

const TEXT_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M216 48H40a16 16 0 0 0-16 16v160a15.85 15.85 0 0 0 9.24 14.5A16.13 16.13 0 0 0 40 240a15.89 15.89 0 0 0 10.25-3.78l.09-.07L83 208h133a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16Zm0 144H80a8 8 0 0 0-5.23 1.95L40 224V64h176Z'/></svg>",
    ),
};

const SENDER_RESOURCE: SupportedResource = {
  urlPattern: SENDER_URL,
  title: "Sender number",
  description:
    "Send the host's routine texts and checking codes from the business's own number, through " +
    "its own text provider account. Nothing else can send a text.",
  icon: TEXT_ICON,
  grantable: false,
};

const TOO_MANY_PENDING =
  "Too many pending actions; approve or reject some in the approval queue first.";

const IDEMPOTENCY_PREFIX = "idem:";
const IDEMPOTENCY_ORDER = "idemorder:";
const IDEMPOTENCY_LIMIT = 5_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

type StoredText = { message: ParsedText; key: string | null };
type Actions = { sendRoutine: StoredText; send: StoredText };
type SendKind = keyof Actions;

type TextHost = { deliver(text: StoredText): Promise<void> };

function describeText(text: StoredText) {
  const { message } = text;
  const builder = buildDescription(
    `Sends a text of ${message.segments} ${message.segments === 1 ? "segment" : "segments"} from the business's number.`,
  )
    .inline("To", maskNumber(message.to))
    .verbatim("Words", message.text);
  return {
    title: sanitizeTitle(`Send a text to ${maskNumber(message.to)}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

const definition = (kind: ActionKind) => ({
  kind,
  // The host's decision applies a routine text (its `routineMail` submission); a held one waits
  // for a person. Neither is an admin's auto-approve switch.
  autoApprovable: false,
  delivery: "continue-with-simulation" as const,
  // A crash between handing the text to the provider and recording it must not send it twice.
  claimBeforeApply: true,
  describe: (text: StoredText) => describeText(text),
  apply: async (text: StoredText, host: TextHost) => {
    await host.deliver(text);
  },
});

const DEFINITIONS = { sendRoutine: definition(ROUTINE_KIND), send: definition(SEND_KIND) };

const actions = defineActions<TextHost, Actions>(DEFINITIONS, {
  fence: "none",
  vendorId: "text",
});

function idempotencyKeyOf(input: unknown): { key: string | null; rest: unknown } {
  if (!input || typeof input !== "object" || !("idempotencyKey" in input)) {
    return { key: null, rest: input };
  }
  const { idempotencyKey, ...rest } = input as { idempotencyKey?: unknown };
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new TypeError(
      "Invalid text: idempotencyKey must be 1 to 200 letters, digits or . _ : -.",
    );
  }
  return { key: idempotencyKey, rest };
}

// ── Session ──────────────────────────────────────────────────────────

type SessionBackend = {
  submit(queue: RpcStub<ApprovalQueue>, text: StoredText, kind: SendKind): Promise<number>;
  wasApplied(id: number): boolean;
  pending(): number;
  recall(space: string, key: string): number | "busy" | null;
  remember(space: string, key: string, id: number | "busy" | null): void;
  /** Counts a code to `number` today; false when it has had its day's codes. */
  countCode(number: string): Promise<boolean>;
  subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<TextHookTarget>): Promise<void>;
};

class TextSessionImpl extends RpcTarget implements TextSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #env: Env;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>, env: Env) {
    super();
    this.#backend = backend;
    this.#queue = queue;
    this.#env = env;
  }

  async #require(cls: TextQueueClass): Promise<void> {
    if ((await queueClassOf(this.#queue)) !== cls) throw new Error(REFUSED);
  }

  /** Validates one routine text and queues it: the host's routine messages only. */
  async send(message: TextMessage): Promise<TextReceipt> {
    await this.#require("routine");
    const { key, rest } = idempotencyKeyOf(message);
    const parsed = parseText(rest);
    const routine = await hostRoutine(this.#queue);
    const kind: SendKind =
      routine && isRoutineShaped(parsed, routine.siteOrigin) ? "sendRoutine" : "send";
    if (key) {
      const known = this.#backend.recall("routine", key);
      if (known === "busy") throw new Error("A send with this idempotency key is in progress.");
      if (known !== null) {
        return {
          status: this.#backend.wasApplied(known) ? "sent" : "pending",
          id: known,
          segments: parsed.segments,
        };
      }
    }
    if (this.#backend.pending() >= MAX_PENDING_TEXTS) throw new Error(TOO_MANY_PENDING);
    if (key) this.#backend.remember("routine", key, "busy");
    let id: number;
    try {
      id = await this.#backend.submit(this.#queue, { message: parsed, key }, kind);
    } catch (error) {
      if (key) this.#backend.remember("routine", key, null);
      throw error;
    }
    if (key) this.#backend.remember("routine", key, id);
    return {
      status: this.#backend.wasApplied(id) ? "sent" : "pending",
      id,
      segments: parsed.segments,
    };
  }

  /** Sends a checking code: the host's phone check only, three a day per number. */
  async startCheck(input: { to: string }): Promise<{ started: true }> {
    await this.#require("check");
    const to = parseNumber(input?.to);
    const provider = providerFor(this.#env);
    if (await eventsStub(this.#env).isStopped(to)) {
      throw new Error("Refused: this number replied STOP, so it is not texted.");
    }
    if (!(await this.#backend.countCode(to))) {
      throw new Error("Refused: this number has had its codes for today.");
    }
    await this.#queue.authorizeObservation({
      title: "Send a checking code",
      description: `Sent a checking code to ${maskNumber(to)} from the business's number.`,
    });
    await provider.startCheck({ from: senderNumber(this.#env), to });
    return { started: true };
  }

  /** Checks a code the member typed: the host's phone check only. */
  async check(input: { to: string; code: string }): Promise<{ checked: boolean }> {
    await this.#require("check");
    const to = parseNumber(input?.to);
    const code = input?.code;
    if (typeof code !== "string" || !/^\d{4,10}$/.test(code)) return { checked: false };
    const checked = await providerFor(this.#env).check({ to, code });
    await this.#queue.authorizeObservation({
      title: "Check a code",
      description: `Checked a code for ${maskNumber(to)}: ${checked ? "it matched" : "it did not match"}.`,
    });
    return { checked };
  }

  /** Binds the host's hook for verified receipts and replies: the host's text events only. */
  async subscribe(hook: TextEventHook): Promise<void> {
    await this.#require("events");
    if (hook === null || (typeof hook !== "object" && typeof hook !== "function")) {
      throw new TypeError("subscribe() takes a stub implementing TextEventHook.");
    }
    await this.#backend.subscribe(this.#queue, hook as unknown as RpcStub<TextHookTarget>);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

// ── Facet ────────────────────────────────────────────────────────────

export class TextGatekeeper extends DurableObject<Env> implements Gatekeeper<TextSession> {
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "text",
    maxPending: MAX_PENDING_TEXTS,
  });

  readonly #host: TextHost = { deliver: (text) => this.#deliver(text) };

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  async #deliver(text: StoredText): Promise<void> {
    const { message } = text;
    let provider: ReturnType<typeof providerFor>;
    try {
      provider = providerFor(this.env);
      // A number that replied STOP is never texted, whatever the host asked (ADR 0672).
      if (await eventsStub(this.env).isStopped(message.to)) {
        throw new Error("Refused: this number replied STOP, so it is not texted.");
      }
    } catch (error) {
      // Checked before anything is sent, so the text is known not to have gone.
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
    let providerRef: string;
    try {
      ({ providerRef } = await provider.send({
        from: senderNumber(this.env),
        to: message.to,
        text: message.text,
      }));
    } catch (error) {
      if (error instanceof ActionApplyError || error instanceof ActionOutcomeUnknownError) {
        throw error;
      }
      throw new ActionOutcomeUnknownError(
        `The text provider failed while sending, so the text may or may not have gone: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await eventsStub(this.env).sent(providerRef, text.key, message.business);
    } catch (error) {
      // Sent: only its receipt will not name its row.
      console.warn(
        "text: sent, its reference not kept",
        error instanceof Error ? error.message : error,
      );
    }
  }

  #recall(space: string, key: string): number | "busy" | null {
    const value = this.ctx.storage.kv.get<number | string>(`${IDEMPOTENCY_PREFIX}${space}:${key}`);
    if (value === undefined) return null;
    if (typeof value === "number") return value;
    return Date.now() - Number(value.slice(5)) < 300_000 ? "busy" : null;
  }

  #remember(space: string, key: string, id: number | "busy" | null): void {
    const kv = this.ctx.storage.kv;
    const slot = `${IDEMPOTENCY_PREFIX}${space}:${key}`;
    if (id === null) {
      kv.delete(slot);
      return;
    }
    const known = kv.get(slot) !== undefined;
    kv.put(slot, id === "busy" ? `busy:${Date.now()}` : id);
    if (known) return;
    const order = `${IDEMPOTENCY_ORDER}${space}:`;
    kv.put(`${order}${String(Date.now()).padStart(15, "0")}:${key}`, key);
    const entries = [...kv.list<string>({ prefix: order })];
    for (const [entry, old] of entries.slice(0, Math.max(0, entries.length - IDEMPOTENCY_LIMIT))) {
      kv.delete(entry);
      kv.delete(`${IDEMPOTENCY_PREFIX}${space}:${old}`);
    }
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: SENDER_URL,
      title: "Texts from the business's number",
      snippet:
        "The host's routine texts and checking codes, from the business's own number. Nothing " +
        "else can send a text.",
      suggestedBindingName: "TEXT",
      tsType: "TextSession",
      hookTsType: "TextEventHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** None: a routine text applies by the host's decision, a held one by a person's. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TextSession> {
    const backend: SessionBackend = {
      submit: (queue, text, kind) => this.#actions().submit(queue, kind, text),
      wasApplied: (id) => this.#journal.wasApplied(id),
      pending: () => this.#journal.listPending().length,
      recall: (space, key) => this.#recall(space, key),
      remember: (space, key, id) => this.#remember(space, key, id),
      countCode: (number) => eventsStub(this.env).countCode(number),
      subscribe: (queue, hook) => this.#subscribe(queue, hook),
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new TextSessionImpl(backend, approvalQueue.dup(), this.env);
  }

  async #subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<TextHookTarget>): Promise<void> {
    const controller = this.ctx.exports.TextHookController({});
    const binder = queue as unknown as Pick<ApprovalQueue, "bindHook">;
    await binder.bindHook<TextHookTarget>(
      controller as unknown as Fetcher<HookController<TextHookTarget>>,
      hook,
      {
        title: "Receive text receipts and replies",
        description:
          "Deliver each verified delivery receipt, and each STOP, START or HELP reply, from the " +
          "text provider. Other replies are not read.",
      },
    );
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /** Sends an approved text, exactly once. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(requireActionId(action));
  }

  /** Drops a rejected text; it is never sent. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("A sent text cannot be unsent.");
  }
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

// ── Hook controller ──────────────────────────────────────────────────

export class TextHookController
  extends WorkerEntrypoint<Env>
  implements HookController<TextHookTarget>
{
  async enable(
    initiator: Fetcher<HookInitiator<TextHookTarget>>,
    target: HookTargetMetadata,
  ): Promise<void> {
    if (initiator === null || (typeof initiator !== "object" && typeof initiator !== "function")) {
      throw new TypeError("enable() takes a HookInitiator stub.");
    }
    const workspaceId =
      typeof target?.workspaceId === "string" ? target.workspaceId.slice(0, 200) : "";
    await eventsStub(this.env).setHook(initiator as unknown as StoredInitiator, { workspaceId });
  }

  async disable(): Promise<void> {
    await eventsStub(this.env).setHook(null);
  }
}

// ── Account, verifier, vendor ────────────────────────────────────────

const CONFIGURATOR_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sender number</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
<p>Texts go from the business's own number, set in product.ts (TEXT_SENDER_NUMBER).</p>
</body></html>`;

/** The configurator's capability: nothing to choose, the sender number is a deploy setting. */
class SenderConfiguratorUi extends RpcTarget {}

export class TextAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Text messages",
      avatar: TEXT_ICON,
      grantedResourceUrlPatterns: [SENDER_URL],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  /** The sender facet, once this deployment has a provider and a sender number set up. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<TextSession>>;
    resource: SupportedResource;
  }> {
    if (url !== SENDER_URL) throw new Error(`Not a text resource: ${String(url).slice(0, 200)}`);
    const found = providerModule(this.env);
    if ("problem" in found) throw new Error(found.problem);
    return {
      class: this.ctx.exports.TextGatekeeper({}) as unknown as DurableObjectClass<
        Gatekeeper<TextSession>
      >,
      resource: SENDER_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== SENDER_URL) {
      throw new Error(`Unsupported resource type: ${String(resourceUrlPattern).slice(0, 200)}`);
    }
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new SenderConfiguratorUi()) };
  }

  /** Nothing to revoke: the account holds no credentials; the keys belong to the deployment. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Text messages have no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Text messages have no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TextVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

export class TextVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/**
 * The fake provider's phones, for development and tests: what was "sent" and the codes, as a
 * member would read them. Refused unless the fake is the provider here; no deployment binds it.
 */
export class FakeTextControl extends WorkerEntrypoint<Env> {
  #ledger() {
    if (this.env.TEXT_PROVIDER !== "fake" || !fakeSecretOrLocal(this.env)) {
      throw new Error("The fake text provider is not on here.");
    }
    return fakeLedger(this.env);
  }
  async sent() {
    return this.#ledger().sent();
  }
  async codeFor(to: string) {
    return this.#ledger().codeFor(to);
  }
  async refuse(to: string, refuse: boolean) {
    return this.#ledger().refuse(to, refuse);
  }
}

/**
 * The vendor, and the Worker's default entrypoint: its `fetch` serves the provider's webhook,
 * which the CRM proxies from /gatekeeper/text/*.
 */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleRequest(request, this.env);
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Text messages",
      url: baseUrl(this.env),
      logo: TEXT_ICON,
      tagline: "Texts from the business's own number",
      description:
        "Send members' routine texts (a reminder, a cancellation) and checking codes through " +
        "the business's own text provider account. The provider's keys stay in this gatekeeper; " +
        "only the host's own routine messages can send a text.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.TextAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Text messages are auto-provisioned and have no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
