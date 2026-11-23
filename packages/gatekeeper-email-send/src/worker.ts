// cos-gatekeeper-email-send: an auto-provisioned gatekeeper that sends email through Cloudflare
// Email Service. Each sender address is a resource; its facet turns every `send()` into an
// approval-queue action and only hands the email to Email Service once the action is applied.
// README.md explains the design.
//
// No capnweb-validate decorators (the CRM app's dev server cannot transform them): every RPC input
// is validated explicitly, see validate.ts and sender.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { agreementPdf } from "@composable-os/agreement-pdf";
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
  ObservationDescription,
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
import { domainOf, parseDomainList } from "./address";
import {
  AGREEMENT_FILENAME,
  AGREEMENT_KIND,
  agreementSummary,
  isAgreementShaped,
  isHostAgreementMail,
} from "./agreement";
import {
  CALENDAR_FILENAME,
  CANCEL_FILENAME,
  calendarFile,
  calendarSummary,
  type EmailCalendarEvent,
} from "./calendar";

/** A message's calendar events, as a list (one or two). */
function calendarsOf(message: ParsedMessage): EmailCalendarEvent[] {
  const c = message.calendar;
  return (c ? (Array.isArray(c) ? c : [c]) : []) as EmailCalendarEvent[];
}

import type { SenderConfiguratorRpc } from "./configurator/sender-configurator-types";
import {
  AGREEMENT_KEY_PREFIX,
  HOST_PRIVATE_CLASSES,
  type QueueClass,
  queueClassOf,
} from "./queue-class";
import { hostRoutineMail, isRoutineShaped, ROUTINE_KIND } from "./routine";
import { assertSenderAllowed, SENDER_URL_PATTERN, senderFromUrl, senderUrl } from "./sender";

import { isHostSignInMail, isSignInCodeMessage, SIGN_IN_KIND } from "./sign-in";
import {
  type EmailTransport,
  isRefusedBeforeSending,
  isRetryableRefusal,
  sendEmail,
} from "./transport";
import type {
  EmailSendMessage,
  EmailSendReceipt,
  EmailSendRecord,
  EmailSendSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import { type ParsedMessage, parseMessage, recipientsOf } from "./validate";

const MAIL_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M224 48H32a8 8 0 0 0-8 8v136a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a8 8 0 0 0-8-8Zm-20.57 16L128 133.15 52.57 64ZM216 192H40V74.19l82.59 75.71a8 8 0 0 0 10.82 0L216 74.19V192Z'/></svg>",
    ),
};

const SENDER_RESOURCE: SupportedResource = {
  urlPattern: SENDER_URL_PATTERN,
  title: "Sender address",
  description:
    "Send email from one address through Cloudflare Email Service. Every email waits for " +
    "approval, except email to colleagues when your workspace auto-approves it.",
  icon: MAIL_ICON,
  grantable: true,
};

/**
 * Action kinds, by tag. `email.internal` and the host's `email.signin` (sign-in.ts, ADR 0456) are
 * the auto-approvable ones.
 */
const SEND_KIND: ActionKind = { tag: "email.send", label: "Send email" };
const INTERNAL_KIND: ActionKind = { tag: "email.internal", label: "Send email to colleagues" };

/**
 * Sends that may wait for approval at once, per sender (the journal's default is 50): callers'
 * (and the host's routine and orders mail) together, and the host's own independent mail (an
 * agreement's copy, a sign-in code) apart, so callers' sends can never crowd those out (the second
 * review of PR #283). The journal holds both.
 */
const MAX_PENDING_SENDS = 500;
const MAX_PENDING_HOST_SENDS = 100;
/** The host's mail that never waits behind, nor counts against, anyone else's. */
const INDEPENDENT_CLASSES: ReadonlySet<QueueClass> = new Set(["agreements", "sign-in"]);
const TOO_MANY_PENDING =
  "Too many pending actions; approve or reject some in the approval queue first.";

/** How many sent and rejected emails the facet remembers for `listSent()`. */
const HISTORY_LIMIT = 200;
/** How many rows `listSent()` returns. */
const LIST_LIMIT = 100;
const HISTORY_PREFIX = "history:";
/**
 * Idempotency keys (ADR 0574, ADR 0645): `idemc:<class>:<key>` → the send's id, and per class the
 * order they were seen in, each class pruned by its own volume (the agreements mail's slots are
 * bounded by acceptances, and kept longer).
 */
const IDEMPOTENCY_PREFIX = "idemc:";
const IDEMPOTENCY_ORDER = "idemcorder:";
const IDEMPOTENCY_LIMIT = 2_000;
const IDEMPOTENCY_LIMITS: Partial<Record<QueueClass, number>> = { agreements: 20_000 };
/**
 * Keys remembered before keys were kept per class (`idem:<key>`). A miss reads them too, except
 * the copy's, so a retry across the deploy still finds its first send. Drop after one release.
 */
const LEGACY_IDEMPOTENCY_PREFIX = "idem:";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A send's idempotency key, checked, and the message without it. */
function splitIdempotencyKey(input: unknown): { key: string | null; rest: unknown } {
  if (!input || typeof input !== "object" || !("idempotencyKey" in input)) {
    return { key: null, rest: input };
  }
  const { idempotencyKey, ...rest } = input as { idempotencyKey?: unknown };
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new TypeError(
      "Invalid email: idempotencyKey must be 1 to 200 letters, digits or . _ : -.",
    );
  }
  return { key: idempotencyKey, rest };
}

// ── Actions ─────────────────────────────────────────────────────────

/**
 * What the journal stores for one send: the sender at submit time, the validated message, and the
 * class of queue that sent it (ADR 0645; absent on sends from before it: a caller's).
 */
type StoredEmail = { from: string; message: ParsedMessage; queue?: QueueClass };

type Actions = {
  send: StoredEmail;
  sendInternal: StoredEmail;
  sendSignIn: StoredEmail;
  sendRoutine: StoredEmail;
  sendAgreement: StoredEmail;
};
type SendKind = keyof Actions;

/** A settled send, as `listSent()` reports it. */
type HistoryEntry = {
  id: number;
  to: string[];
  subject: string;
  /** The class of queue that sent it (ADR 0645); absent: a caller's. */
  queue?: QueueClass;
  status: "sent" | "rejected";
  sentAt?: string;
  messageId?: string;
};

/**
 * What the action handlers may do. Deliberately not the Durable Object: provider calls live behind
 * the approval path only.
 */
type EmailHost = {
  deliver(id: number, email: StoredEmail): Promise<void>;
  recordRejected(id: number, email: StoredEmail): void;
};

/** The approver's view of one send: who it goes to, from where, and exactly what it says. */
function describeSend(email: StoredEmail, internal: boolean) {
  const { message } = email;
  const count = recipientsOf(message).length;
  const builder = buildDescription(
    `Sends an email from the sender address to ${count} ${count === 1 ? "recipient" : "recipients"}` +
      (internal ? ", all of them colleagues." : "."),
  )
    .inline("From", email.from)
    .list("To", message.to);
  if (message.cc) builder.list("Cc", message.cc);
  if (message.bcc) builder.list("Bcc", message.bcc);
  if (message.replyTo) builder.inline("Reply-To", message.replyTo);
  builder.inline("Subject", message.subject);
  if (message.text !== undefined) builder.verbatim("Body", message.text);
  if (message.html !== undefined) builder.verbatim("HTML body", message.html, "html");
  if (message.relatedRecords) builder.list("Related records", message.relatedRecords);
  // Everything the calendar file will say, so the approver reviews all of it (ADR 0571).
  for (const event of calendarsOf(message)) {
    builder.inline("Calendar file", calendarSummary(event));
    if (event.url) builder.inline("Calendar link", event.url);
    if (event.description) builder.verbatim("Calendar description", event.description);
  }
  // The signed agreement's file, in one line: what, which version, how and when; no name typed,
  // no signature, no answer (ADR 0645).
  if (message.agreement) builder.inline("Attachment", agreementSummary(message.agreement));
  return {
    title: sanitizeTitle(`Send email: ${message.subject}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

const sendDefinition = (internal: boolean, kind?: ActionKind, autoApprovable?: boolean) => ({
  kind: kind ?? (internal ? INTERNAL_KIND : SEND_KIND),
  autoApprovable: autoApprovable ?? (internal || kind !== undefined),
  delivery: "continue-with-simulation" as const,
  // A crash between handing the email to Email Service and recording it must not send it twice.
  claimBeforeApply: true,
  describe: (email: StoredEmail) => describeSend(email, internal),
  apply: async (email: StoredEmail, host: EmailHost, ctx: { id: number }) => {
    await host.deliver(ctx.id, email);
  },
  reject: async (email: StoredEmail, host: EmailHost, ctx: { id: number }) => {
    host.recordRejected(ctx.id, email);
  },
});

const SEND_DEFINITIONS = {
  send: sendDefinition(false),
  sendInternal: sendDefinition(true),
  // The host's sign-in code (ADR 0456): an independent send, so it never waits behind another.
  sendSignIn: sendDefinition(false, SIGN_IN_KIND),
  // Routine mail (ADR 0590): the host's own decision, not an admin's switch, lets it apply,
  // so it is not auto-approvable; an independent send, so it never waits behind another.
  sendRoutine: sendDefinition(false, ROUTINE_KIND, false),
  // The copy of a signed agreement (ADR 0645): the host's own mail, applied by the host's
  // decision (its `callAsHost`), never by an admin's switch; an independent send.
  sendAgreement: sendDefinition(false, AGREEMENT_KIND, false),
} satisfies Record<SendKind, ReturnType<typeof sendDefinition>>;

const actions = defineActions<EmailHost, Actions>(
  SEND_DEFINITIONS,
  // Email Service has no per-user authority to pin: the Worker's own binding sends every email,
  // and apply re-checks the sender domain against the current configuration instead.
  { fence: "none", vendorId: "email-send" },
);

/** Whether every recipient is at one of the comma-separated `internalDomains`. */
function isInternal(message: EmailSendMessage, internalDomains: string | undefined): boolean {
  const internal = parseDomainList(internalDomains);
  if (internal.length === 0) return false;
  return recipientsOf(message).every((address) => internal.includes(domainOf(address)));
}

function historyKey(id: number): string {
  return HISTORY_PREFIX + String(id).padStart(12, "0");
}

// ── Facet ───────────────────────────────────────────────────────────

type SenderProps = { sender: string };

/** What a session may ask of its facet, as closures so the session holds no facet reference. */
type SessionBackend = {
  sender: string;
  submit(queue: RpcStub<ApprovalQueue>, email: StoredEmail, kind: SendKind): Promise<number>;
  wasSent(id: number): boolean;
  /**
   * Submits a journalled send that is still waiting to its queue again, as it was described
   * (ADR 0645: a copy whose first submission was cut off before the host applied it). False when
   * it is no longer waiting (applied, rejected or failed).
   */
  resubmit(queue: RpcStub<ApprovalQueue>, id: number): Promise<boolean>;
  /**
   * The send an idempotency key already made (ADR 0574), "busy" while it is being made. Keys are
   * kept per queue class: one class's key never answers another's send.
   */
  recall(queueClass: QueueClass, key: string): number | "busy" | null;
  remember(queueClass: QueueClass, key: string, id: number | "busy" | null): void;
  /** How many sends wait in the same pool as `queueClass`'s (independent host mail, or the rest). */
  pendingIn(queueClass: QueueClass): number;
  listSent(viewer: QueueClass): EmailSendRecord[];
  internalDomains(): string | undefined;
  allowedDomains(): string | undefined;
};

class EmailSendSessionImpl extends RpcTarget implements EmailSendSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  /** Validates the message and queues it for approval. */
  async send(message: EmailSendMessage): Promise<EmailSendReceipt> {
    const { key, rest } = splitIdempotencyKey(message);
    // Who is sending, from how the host opened the queue (ADR 0645, after the review of PR #283).
    const queueClass = await queueClassOf(this.#queue);
    // The copy's keys are the host's agreements mail's alone: no other caller may take one first.
    if (key?.startsWith(AGREEMENT_KEY_PREFIX) && queueClass !== "agreements") {
      throw new TypeError(
        `Invalid email: idempotencyKey ${AGREEMENT_KEY_PREFIX}… is the host's own agreements mail's.`,
      );
    }
    const parsed = parseMessage(rest);
    const sender = this.#backend.sender;
    assertSenderAllowed(sender, this.#backend.allowedDomains());
    // The host's sign-in mail only from the host's own queue, and only the fixed template; its
    // routine mail only from the host's own queue, and only of routine shape (ADR 0590).
    // A signed agreement only from the host's own agreements mail, and only in the copy's shape:
    // nothing else may attach a file (ADR 0645).
    if (parsed.agreement) {
      if (!isAgreementShaped(parsed) || !(await isHostAgreementMail(this.#queue))) {
        throw new TypeError(
          "Invalid email: agreement is attached only by the host, to its copy of a signed agreement.",
        );
      }
    }
    const routine = parsed.agreement ? null : await hostRoutineMail(this.#queue);
    const kind: SendKind = parsed.agreement
      ? "sendAgreement"
      : isSignInCodeMessage(parsed) && (await isHostSignInMail(this.#queue))
        ? "sendSignIn"
        : routine && isRoutineShaped(parsed, routine.siteOrigin)
          ? "sendRoutine"
          : isInternal(parsed, this.#backend.internalDomains())
            ? "sendInternal"
            : "send";
    // A caller retrying a step passes the same key: the send it already made is answered again,
    // never queued twice (ADR 0574). Keys are remembered per queue class only (not the kind: the
    // host may decide a routine email held on its retry, or a caller's recipients make it
    // internal on one try and not the next), so a key only ever answers a send from the same
    // class of caller.
    if (key) {
      const known = this.#backend.recall(queueClass, key);
      if (known === "busy") throw new Error("A send with this idempotency key is in progress.");
      if (known !== null) return this.#again(known, queueClass);
    }
    // Each pool's own limit: callers' sends never crowd out the host's independent mail.
    const independent = INDEPENDENT_CLASSES.has(queueClass);
    if (
      this.#backend.pendingIn(queueClass) >=
      (independent ? MAX_PENDING_HOST_SENDS : MAX_PENDING_SENDS)
    ) {
      throw new Error(TOO_MANY_PENDING);
    }
    if (key) this.#backend.remember(queueClass, key, "busy");
    let id: number;
    try {
      id = await this.#backend.submit(
        this.#queue,
        { from: sender, message: parsed, queue: queueClass },
        kind,
      );
    } catch (error) {
      if (key) this.#backend.remember(queueClass, key, null);
      throw error;
    }
    if (key) this.#backend.remember(queueClass, key, id);
    // An auto-approved send may already have been applied while the submission was in flight.
    return { status: this.#backend.wasSent(id) ? "sent" : "pending", id };
  }

  /**
   * The answer to a send its key already made. The host's agreements mail re-drives one that is
   * still waiting (its first submission may have been cut off before the host applied it: the
   * queue decides it again, and finds a person's pending approval if there is one), and is told
   * plainly when it was turned down, so it is never left waiting for nothing.
   */
  async #again(id: number, queueClass: QueueClass): Promise<EmailSendReceipt> {
    if (this.#backend.wasSent(id)) return { status: "sent", id };
    if (queueClass === "agreements") {
      if (!(await this.#backend.resubmit(this.#queue, id))) {
        throw new Error("Refused: this email was turned down or failed, and is not sent again.");
      }
      return { status: this.#backend.wasSent(id) ? "sent" : "pending", id };
    }
    return { status: "pending", id };
  }

  /**
   * Lists recent sends, pending ones included, after recording the read. The host's own
   * agreements, sign-in and orders mail is listed only to that same queue (ADR 0645): a caller
   * never reads who agreed to what, who signed in or who bought.
   */
  async listSent(): Promise<EmailSendRecord[]> {
    const rows = this.#backend.listSent(await queueClassOf(this.#queue));
    const observation: ObservationDescription = {
      title: "List sent email",
      description: `Listed ${rows.length} recent ${rows.length === 1 ? "email" : "emails"} from the sender address.`,
      fields: [{ label: "Sender", kind: "inline", value: this.#backend.sender }],
    };
    await this.#queue.authorizeObservation(observation);
    return rows;
  }

  /** The sender address; resource configuration, not provider data, so no observation. */
  async getSender(): Promise<string> {
    return this.#backend.sender;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

export class EmailSendGatekeeper
  extends DurableObject<Cloudflare.Env, SenderProps>
  implements Gatekeeper<EmailSendSession>
{
  // Members' booking emails (ADR 0572) each wait for a person under Balanced: room for a day's
  // worth of them before new sends are refused (as back-pressure, ADR 0573).
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "email",
    // Both pools' limits; `send` holds each pool to its own.
    maxPending: MAX_PENDING_SENDS + MAX_PENDING_HOST_SENDS,
  });

  readonly #host: EmailHost = {
    deliver: (id, email) => this.#deliver(id, email),
    recordRejected: (id, email) => this.#record(id, email, { status: "rejected" }),
  };

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  #sender(): string {
    // Props come from getGatekeeperClassFor, which validated them; re-parse anyway so a facet
    // never sends from anything but a plain address.
    return senderFromUrl(senderUrl(this.ctx.props.sender));
  }

  async #deliver(id: number, email: StoredEmail): Promise<void> {
    try {
      assertSenderAllowed(email.from, this.env.ALLOWED_SENDER_DOMAINS);
    } catch (error) {
      // Checked before anything is sent, so the email is known not to have gone out.
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
    const { message } = email;
    let messageId: string;
    try {
      // The binding is structurally an EmailTransport; tests bind EMAIL to a fake with send().
      const transport: EmailTransport = this.env.EMAIL;
      ({ messageId } = await sendEmail(transport, {
        from: email.from,
        to: message.to,
        ...(message.cc ? { cc: message.cc } : {}),
        ...(message.bcc ? { bcc: message.bcc } : {}),
        subject: message.subject,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(calendarsOf(message).length || message.agreement
          ? {
              attachments: [
                ...calendarsOf(message).map((event) => ({
                  disposition: "attachment" as const,
                  filename: event.cancelled ? CANCEL_FILENAME : CALENDAR_FILENAME,
                  type: `text/calendar; charset=utf-8; method=${event.cancelled ? "CANCEL" : "PUBLISH"}`,
                  content: calendarFile(event, { address: email.from, to: message.to }, new Date()),
                })),
                // The signed agreement, made here from the checked values (ADR 0645).
                ...(message.agreement
                  ? [
                      {
                        disposition: "attachment" as const,
                        filename: AGREEMENT_FILENAME,
                        type: "application/pdf",
                        content: agreementPdf(message.agreement),
                      },
                    ]
                  : []),
              ],
            }
          : {}),
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Rate and quota limits: refused, so a later retry is safe.
      if (isRetryableRefusal(error)) throw new Error(`Email Service refused for now: ${detail}`);
      if (isRefusedBeforeSending(error)) {
        throw new ActionApplyError(`Email Service refused this email: ${detail}`);
      }
      throw new ActionOutcomeUnknownError(
        `Email Service failed while sending, so the email may or may not have gone out: ${detail}`,
      );
    }
    this.#record(id, email, { status: "sent", sentAt: new Date().toISOString(), messageId });
  }

  #recall(queueClass: QueueClass, key: string): number | "busy" | null {
    const kv = this.ctx.storage.kv;
    let value = kv.get<number | string>(`${IDEMPOTENCY_PREFIX}${queueClass}:${key}`);
    // Upgrade: a key remembered before keys were kept per class (never the copy's). Drop after
    // one release.
    if (value === undefined && !key.startsWith(AGREEMENT_KEY_PREFIX)) {
      value = kv.get<number | string>(LEGACY_IDEMPOTENCY_PREFIX + key);
    }
    if (value === undefined) return null;
    if (typeof value === "number") return value;
    // A send being made, unless it was left so by a crash long enough ago to try again.
    return Date.now() - Number(value.slice(5)) < 300_000 ? "busy" : null;
  }

  /**
   * Keeps each class's most recent keys (IDEMPOTENCY_LIMIT, more for the agreements mail); older
   * ones are forgotten (a week of retries). One class's volume never evicts another's keys.
   */
  #remember(queueClass: QueueClass, key: string, id: number | "busy" | null): void {
    const kv = this.ctx.storage.kv;
    const slot = `${IDEMPOTENCY_PREFIX}${queueClass}:${key}`;
    if (id === null) {
      kv.delete(slot);
      return;
    }
    const known = kv.get(slot) !== undefined;
    kv.put(slot, id === "busy" ? `busy:${Date.now()}` : id);
    if (known) return;
    const order = `${IDEMPOTENCY_ORDER}${queueClass}:`;
    kv.put(`${order}${String(Date.now()).padStart(15, "0")}:${key}`, key);
    const entries = [...kv.list<string>({ prefix: order })];
    const limit = IDEMPOTENCY_LIMITS[queueClass] ?? IDEMPOTENCY_LIMIT;
    for (const [entry, old] of entries.slice(0, Math.max(0, entries.length - limit))) {
      kv.delete(entry);
      kv.delete(`${IDEMPOTENCY_PREFIX}${queueClass}:${old}`);
    }
  }

  /** Sends waiting in `queueClass`'s pool: the host's independent mail, or everyone else's. */
  #pendingIn(queueClass: QueueClass): number {
    const independent = INDEPENDENT_CLASSES.has(queueClass);
    return this.#journal
      .listPending()
      .filter(
        ({ action }) => INDEPENDENT_CLASSES.has(action.payload.queue ?? "caller") === independent,
      ).length;
  }

  #record(
    id: number,
    email: StoredEmail,
    outcome: Pick<HistoryEntry, "status" | "sentAt" | "messageId">,
  ): void {
    const kv = this.ctx.storage.kv;
    const entry: HistoryEntry = {
      id,
      to: recipientsOf(email.message),
      subject: email.message.subject,
      ...(email.queue && email.queue !== "caller" ? { queue: email.queue } : {}),
      ...outcome,
    };
    kv.put(historyKey(id), entry);
    // Bounded: drop the oldest entries past the limit.
    const keys = [...kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX })].map(([key]) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_LIMIT))) kv.delete(key);
  }

  /** History plus the sends still awaiting approval, newest first, as `viewer` may see them. */
  #listSent(viewer: QueueClass): EmailSendRecord[] {
    const visible = (queue: QueueClass | undefined) =>
      !queue || !HOST_PRIVATE_CLASSES.has(queue) || queue === viewer;
    const settled = [
      ...this.ctx.storage.kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX, reverse: true }),
    ]
      .filter(([, entry]) => visible(entry.queue))
      .map(
        ([, entry]): EmailSendRecord => ({
          id: entry.id,
          to: entry.to,
          subject: entry.subject,
          status: entry.status,
          ...(entry.sentAt ? { sentAt: entry.sentAt } : {}),
        }),
      );
    const pending = this.#journal
      .listPending()
      .filter(({ action }) => visible(action.payload.queue))
      .map(
        ({ id, action }): EmailSendRecord => ({
          id,
          to: recipientsOf(action.payload.message),
          subject: action.payload.message.subject,
          status: "pending",
        }),
      );
    return [...pending, ...settled].sort((a, b) => b.id - a.id).slice(0, LIST_LIMIT);
  }

  /** Describes the sender-address binding. */
  async describe(): Promise<ResourceDescription> {
    const sender = this.#sender();
    return {
      url: senderUrl(sender),
      title: `Email from ${sender}`,
      snippet: `Send email from ${sender}. Each email waits for approval unless it only goes to colleagues.`,
      suggestedBindingName: "EMAIL_SEND",
      tsType: "EmailSendSession",
    };
  }

  /** Returns the agent-facing EmailSendSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** `email.internal` (every recipient a colleague) and `email.signin` (the host's sign-in code). */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions().autoApprovableKinds();
  }

  /** Opens a session that submits each send through `approvalQueue`. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<EmailSendSession> {
    const backend: SessionBackend = {
      sender: this.#sender(),
      submit: (queue, email, kind) => this.#actions().submit(queue, kind, email),
      // The journal's record, or (once the journal has forgotten it) the sent history's.
      wasSent: (id) =>
        this.#journal.wasApplied(id) ||
        this.ctx.storage.kv.get<HistoryEntry>(historyKey(id))?.status === "sent",
      resubmit: async (queue, id) => {
        const waiting = this.#journal.listPending().find((p) => p.id === id);
        if (!waiting) return false;
        const definition = SEND_DEFINITIONS[waiting.action.kind];
        await queue.submitAction(id, {
          ...definition.describe(waiting.action.payload),
          autoApprovable: definition.autoApprovable === true,
          actionKind: definition.kind,
        });
        return true;
      },
      recall: (queueClass, key) => this.#recall(queueClass, key),
      remember: (queueClass, key, id) => this.#remember(queueClass, key, id),
      pendingIn: (queueClass) => this.#pendingIn(queueClass),

      listSent: (viewer) => this.#listSent(viewer),
      internalDomains: () => this.env.INTERNAL_DOMAINS,
      allowedDomains: () => this.env.ALLOWED_SENDER_DOMAINS,
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new EmailSendSessionImpl(backend, approvalQueue.dup());
  }

  /** No catalog: the session types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the sent list holds only what this binding itself sent. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** No observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  /** Allows every observer. */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /** Sends an approved email, exactly once. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(requireActionId(action));
  }

  /** Drops a rejected email; it is never sent. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("A sent email cannot be unsent.");
  }
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

// ── Account ─────────────────────────────────────────────────────────

/** The sender configurator's `ui` capability. */
export class SenderConfiguratorRpcImpl extends RpcTarget implements SenderConfiguratorRpc {
  readonly #allowed: string[];

  constructor(env: Cloudflare.Env) {
    super();
    this.#allowed = parseDomainList(env.ALLOWED_SENDER_DOMAINS);
  }

  async allowedDomains(): Promise<string[]> {
    return [...this.#allowed];
  }
}

// The CRM renders the configurator spec (src/configurator/sender-configurator-ui.tsx) itself; this
// frame is the fallback for a Workshop that only knows iframes.
const SENDER_CONFIGURATOR_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sender address</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
<p>Enter the address email should be sent from, like <code>crm@example.com</code>.</p>
</body></html>`;

export class EmailSendAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account. All accounts are alike: none holds credentials. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Email sending",
      avatar: MAIL_ICON,
      grantedResourceUrlPatterns: [SENDER_URL_PATTERN],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  /** Returns the sender facet class for an allowed sender address. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<EmailSendSession>>;
    resource: SupportedResource;
  }> {
    const sender = senderFromUrl(url);
    assertSenderAllowed(sender, this.env.ALLOWED_SENDER_DOMAINS);
    const props: SenderProps = { sender };
    return { class: this.ctx.exports.EmailSendGatekeeper({ props }), resource: SENDER_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== SENDER_URL_PATTERN) {
      throw new Error(`Unsupported resource configurator type: ${String(resourceUrlPattern)}`);
    }
    return {
      iframeHtml: SENDER_CONFIGURATOR_HTML,
      ui: new RpcStub(new SenderConfiguratorRpcImpl(this.env)),
    };
  }

  /** Nothing to revoke: the account holds no credentials and no state. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Email sending has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Email sending has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier that goes with admitting every observer. */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.EmailSendVerifier({});
  }

  /** No grant to expand: the sender resource needs no authorization. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

export class EmailSendVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier {}

// ── Vendor ──────────────────────────────────────────────────────────

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Email sending",
      url: "https://developers.cloudflare.com/email-service/",
      logo: MAIL_ICON,
      tagline: "Send email from your domain",
      description:
        "Let automations and extensions send email from your organization's own domain through " +
        "Cloudflare Email Service. Every email is shown for approval before it goes out.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.EmailSendAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Email sending is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
