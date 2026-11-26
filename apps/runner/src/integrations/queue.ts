// The integration host's ApprovalQueue (the Workshop side of the gatekeeper interface, ADR 0050,
// ADR 0051, ADR 0111). One per session (or hook firing), bound to whoever is calling: an actor
// (MCP, assistant, extension, automation, a person) or the system (sync, webhooks).
//
// - authorizeObservation: reads by actors are counted (ADR 0090); a read the gatekeeper flags
//   containsRestrictedData is refused for anyone but the connection's owner, and marked on the
//   tracker so sync never writes it (ADR 0052).
// - submitAction: the gate decides at once as risk `outbound` (core `submitOutbound`): review
//   mirrors it into the caller's change set; auto applies it right after the call; deny rejects.
// - bindHook: system hooks (sync, webhooks) are enabled at once (their owner consented when
//   turning sync on or creating the endpoint); hooks agents ask for wait (stage 5 binds them).
import { RpcTarget } from "cloudflare:workers";
import { clientSenderDomains } from "./senders.ts";
import {
  type ActingUser,
  type ApplyOutcome,
  auditOutboundApplied,
  checkSend,
  contactAtSubmit,
  contactRefusedAudit,
  type IntegrationCaller,
  isSendPurpose,
  type OutboundContact,
  type OutboundDescription,
  type OutboundSubmission,
  type PendingApproval,
  PURPOSE_REQUIRED_MESSAGE,
  parseApplyOutcome,
  parseFloor,
  RECIPIENT_STOPPED_MESSAGE,
  readCountHour,
  type SenderStanding,
  type SendPurpose,
  type SignInMailOrigin,
  STOP_LINK_NEEDS_SITE_MESSAGE,
  type Stoppable,
  stopLinksPossible,
  submitOutbound,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { runnerJudge } from "../extensions/ai.ts";

export type QueueCaller =
  | { kind: "actor"; caller: IntegrationCaller; user: ActingUser }
  | {
      kind: "system";
      // `payments`: verified payment events (stage 25). `orders`: the host's own calls for an
      // order, a checkout and its confirmation email (`callAsHost`, ADR 0429). `agreements`: the
      // copy of a signed agreement (`callAsHost`, ADR 0645), the only queue that may attach one.
      // `accounting`: the sync's reads and entries on the connected books (`callAsHost`, ADR
      // 0881), the only queue a connection whose gatekeeper implements accounting opens.
      purpose: "sync" | "webhook" | "payments" | "orders" | "probe" | "agreements" | "accounting";
      user: ActingUser;
    }
  | {
      kind: "system";
      // Texts (ADR 0672): `phone-check`, a code sent to or checked for a member's own number
      // (only `callAsHost` opens it); `text-events`, the text gatekeeper's verified receipts and
      // replies (the hook the host binds when the sender number is bound).
      purpose: "phone-check" | "text-events";
      user: ActingUser;
    }
  | {
      kind: "system";
      // The host's sign-in mail (ADR 0456): only `callAsHost` with purpose `sign-in` opens it.
      purpose: "sign-in";
      origin: SignInMailOrigin;
      user: ActingUser;
    }
  | {
      kind: "system";
      // Routine mail (ADR 0590): only the integration host's `sendRoutineMail` opens it, for one
      // row of core_routine_mail it read itself. `routine` is the host's decision; the run it
      // belongs to is where a held one waits.
      purpose: "routine-mail";
      user: ActingUser;
      routine: {
        id: string;
        kind: string;
        routine: boolean;
        /** The pack's routine email not turned on yet: an ordinary send (D1). */
        ordinary: boolean;
        heldReason: string | null;
        /** Null for a host kind's row (ADR 0670): host code asked for it, not an automation. */
        automationId: string | null;
        runId: string | null;
        extensionId: string;
        siteOrigin: string | null;
        /** The row's channel: an email, or a text (ADR 0672). Absent: an email. */
        channel?: "email" | "text";
      };
    };

export interface ObservationRecord {
  title: string;
  restricted: boolean;
}

/** Observations seen through one queue, so the sync service can tell restricted reads apart. */
export class ObservationTracker {
  restricted = false;
  count = 0;
  reset(): void {
    this.restricted = false;
  }
}

/** What the host gives each queue: where it is, and how to apply or reject an action later. */
export interface QueueHost {
  env: Env;
  connectionId: string;
  connectionTitle: string;
  vendor: string;
  ownerUserId: string;
  facetKey: string;
  resourceTitle: string;
  apply(facetKey: string, action: number, stoppable?: Stoppable): Promise<void>;
  reject(facetKey: string, action: number): Promise<void>;
  /** Keeps a hook controller stub in the host's storage; returns its hook id. */
  stashController(controller: unknown): Promise<string>;
  enableHook(
    id: string,
    facetKey: string,
    purpose: "sync" | "webhook" | "payments" | "text-events",
    description: { title: string; description: string },
  ): Promise<void>;
  recordAgentHook(
    id: string,
    facetKey: string,
    description: { title: string; description: string },
  ): Promise<void>;
}

export class HostQueue extends RpcTarget {
  readonly #host: QueueHost;
  readonly #caller: QueueCaller;
  readonly tracker = new ObservationTracker();
  readonly pending: PendingApproval[] = [];
  readonly applied: { action: number; actionKind: string | null; title: string }[] = [];
  /**
   * Actions that were to apply at once and failed (stage 32b review): the gatekeeper's message
   * says whether nothing changed or the outcome is unknown, for the host's own call to tell.
   */
  readonly failed: {
    action: number;
    actionKind: string | null;
    title: string;
    /** From the gatekeeper's tag (`parseApplyOutcome`): refused, unknown or retryable. */
    outcome: ApplyOutcome;
    message: string;
  }[] = [];
  /** Actions the gate denied (the deploy floor), rejected on the facet. */
  readonly denied: number[] = [];
  /** Work that must finish before the call returns (auto-applies, hook enables). */
  readonly deferred: Promise<unknown>[] = [];

  constructor(host: QueueHost, caller: QueueCaller) {
    super();
    this.#host = host;
    this.#caller = caller;
  }

  async authorizeObservation(description: {
    title?: string;
    containsRestrictedData?: boolean;
  }): Promise<void> {
    const restricted = description?.containsRestrictedData === true;
    const user = this.#caller.user;
    if (restricted && user.id !== this.#host.ownerUserId) {
      throw new Error(
        "This read contains restricted data: only the connection's owner may see it (ADR 0052)",
      );
    }
    this.tracker.count += 1;
    if (restricted) this.tracker.restricted = true;
    if (this.#caller.kind === "actor" && this.#caller.caller.actor !== "human") {
      await this.#countRead(this.#caller.caller);
    }
  }

  /** One upsert per hour, actor, user, caller and vendor (ADR 0090), never the content. */
  async #countRead(caller: IntegrationCaller): Promise<void> {
    const now = new Date().toISOString();
    const o = caller.origin;
    try {
      await this.#host.env.DB.prepare(
        `INSERT INTO core_audit_read_counts (hour, actor, user_id, caller, operation, count, simulated, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT (hour, actor, user_id, caller, operation)
         DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      )
        .bind(
          readCountHour(now),
          caller.actor,
          caller.userId,
          o.sessionId ?? o.extensionId ?? o.automationId ?? o.clientId ?? "",
          `gatekeeper.${this.#host.vendor}.observe`,
          now,
          now,
        )
        .run();
    } catch (error) {
      console.error("failed to count an observation", error);
    }
  }

  /**
   * The client's verified sender domains, on a host of many clients (stage 66; ADR 0616, "Email
   * sending per client"): the email-send gatekeeper allows a send only from one of them. From the
   * client's own environment (this queue's host is the client's integration host object), never
   * from anything the caller sent. Throws on a single-client deployment, whose gatekeeper reads
   * its own ALLOWED_SENDER_DOMAINS (and fails closed if it were ever asked there).
   */
  async senderDomains(): Promise<string[]> {
    const domains = clientSenderDomains(this.#host.env);
    if (domains === null) throw new Error("Sender domains are a host of many clients' only");
    return domains;
  }

  /**
   * Whether this session is the host's own sign-in mail (ADR 0456). A gatekeeper asks before it
   * gives a send the sign-in kind: the answer comes from how the host opened the queue, never from
   * anything the caller sent.
   */
  async isHostSignInMail(): Promise<boolean> {
    return this.#caller.kind === "system" && this.#caller.purpose === "sign-in";
  }

  /**
   * Whether this session is the host's own routine mail, decided routine (ADR 0590), and the
   * business's site its links may point to. Email-send gives a send its routine kind only when
   * this answers, and only for a message of routine shape: a held one answers null and is an
   * ordinary send. The answer comes from how the host opened the queue, never from the caller.
   */
  async hostRoutineMail(): Promise<{ siteOrigin: string | null } | null> {
    if (this.#caller.kind !== "system" || this.#caller.purpose !== "routine-mail") return null;
    return this.#caller.routine.routine ? { siteOrigin: this.#caller.routine.siteOrigin } : null;
  }

  /**
   * Which of the host's own purposes opened this queue, or null for a caller's (ADR 0645, after
   * the review of PR #283). A gatekeeper keeps the host's mail apart by it (idempotency keys,
   * `listSent`); the answer comes from how the host opened the queue, never from the caller.
   */
  async hostPurpose(): Promise<string | null> {
    return this.#caller.kind === "system" ? this.#caller.purpose : null;
  }

  /**
   * Who is calling, as a name for a gatekeeper to keep this caller's idempotency keys apart by
   * (ADR 0574, issue #286): a person, the assistant or an agent job for one person; an MCP app for
   * one person and one connected app; an automation by its id; extension code by its extension;
   * the host's own purposes each as one. Stable across a caller's retries (an automation's runs
   * and their retries share it). The answer comes from how the host opened the queue, never from
   * the caller.
   */
  async callerKeySpace(): Promise<string> {
    if (this.#caller.kind === "system") return `system:${this.#caller.purpose}`;
    const { actor, userId, origin } = this.#caller.caller;
    // JSON, so no id can run into the next.
    if (actor === "automation") {
      return JSON.stringify([
        actor,
        origin.automationId ?? null,
        origin.extensionId ?? null,
        userId,
      ]);
    }
    if (actor === "extension") return JSON.stringify([actor, origin.extensionId ?? null, userId]);
    if (actor === "mcp") {
      return JSON.stringify([actor, userId, origin.sessionId ?? origin.clientId ?? null]);
    }
    return JSON.stringify([actor, userId]);
  }

  /**
   * Whether this session is the host's own agreements mail (ADR 0645): the copy of a signed
   * agreement. Email-send attaches the signed PDF only for such a session; the answer comes from
   * how the host opened the queue, never from anything the caller sent.
   */
  async isHostAgreementMail(): Promise<boolean> {
    return this.#caller.kind === "system" && this.#caller.purpose === "agreements";
  }

  /**
   * Whether this session is the host's own orders call (`callAsHost`, purpose `orders`): an
   * order's checkout, a subscription's, its portal (ADR 0485). The payments gatekeeper opens a
   * customer's billing portal only for such a session; the answer comes from how the host opened
   * the queue, never from anything the caller sent.
   */
  async isHostOrders(): Promise<boolean> {
    return this.#caller.kind === "system" && this.#caller.purpose === "orders";
  }

  /** Who this queue's caller is, for consent (ADR 0678); null for the host's own work. */
  #standing(): SenderStanding | null {
    if (this.#caller.kind !== "actor") return null;
    // Host code calling as the system on an org connection (origin `system`, set by platform code,
    // never by a caller): staff notices to staff accounts and the invite notice, the host's own
    // account mail.
    if (this.#caller.caller.origin.surface === "system") return null;
    return this.#caller.caller.actor === "human" ? "staff" : "other";
  }

  /**
   * Records a send refused for consent (ADR 0678): who sent it and through what, the channel and
   * how many cannot be contacted, never who or why. For people only (`audit.list`).
   */
  async #auditRefusal(input: {
    channel: "email" | "text";
    actionKind: string | null;
    refused: number;
    sent: boolean;
  }): Promise<void> {
    if (this.#caller.kind !== "actor") return;
    const db = createCrmDb(this.#host.env.DB);
    try {
      await db.batch([
        contactRefusedAudit(db.query, {
          actor: this.#caller.caller.actor,
          user: this.#caller.user,
          origin: this.#caller.caller.origin,
          vendor: this.#host.vendor,
          connectionId: this.#host.connectionId,
          at: new Date().toISOString(),
          ...input,
        }),
      ]);
    } catch (error) {
      console.error("failed to record a refused send", error);
    }
  }

  /**
   * Consent to be contacted (stage 30, ADR 0678): a gatekeeper asks before it queues a caller's
   * email, with the addresses it would go to and the purpose the caller declared. The host drops
   * who may not be contacted (only how many is said), refuses when nobody is left, and says which
   * recipients a stoppable message's copies get a stop link for: the links themselves are made
   * when it goes. The host's own queues (routine mail, sign-in codes, an agreement's copy, an
   * order's mail) are asked on their own paths or are essential: everyone passes. What it allowed
   * is remembered, so the send the gatekeeper then submits is known to have asked.
   */
  async contactCheck(input: { channel?: unknown; to?: unknown; purpose?: unknown }): Promise<{
    allowed: { to: string; stop: boolean }[];
    dropped: number;
  }> {
    const to = Array.isArray(input?.to) ? input.to.map(String).slice(0, 500) : [];
    const channel = input?.channel === "text" ? "text" : "email";
    const sender = this.#standing();
    if (!sender) return { allowed: to.map((t) => ({ to: t, stop: false })), dropped: 0 };
    if (input?.purpose !== undefined && input.purpose !== null && !isSendPurpose(input.purpose)) {
      throw new Error('Invalid email: purpose is "follow_up" or "news_and_offers".');
    }
    const purpose = isSendPurpose(input?.purpose) ? input.purpose : null;
    const db = createCrmDb(this.#host.env.DB).query;
    const at = new Date().toISOString();
    const answer = await checkSend(db, {
      channel,
      recipients: to,
      sender,
      purpose,
      oneToOne: to.length === 1,
      at,
    });
    if (answer.purposeRequired) throw new Error(PURPOSE_REQUIRED_MESSAGE);
    if (!answer.allowed.length) {
      await this.#auditRefusal({ channel, actionKind: null, refused: answer.dropped, sent: false });
      throw new Error(RECIPIENT_STOPPED_MESSAGE);
    }
    // A stop link needs the business's site: refused now, not when it would go.
    const stops = purpose !== null && answer.allowed.some((r) => r.person);
    if (stops && !(await stopLinksPossible(db))) throw new Error(STOP_LINK_NEEDS_SITE_MESSAGE);
    if (answer.dropped) {
      await this.#auditRefusal({ channel, actionKind: null, refused: answer.dropped, sent: true });
    }
    for (const r of answer.allowed) {
      this.#vouched.set(r.to.toLowerCase(), { purpose, person: r.person });
    }
    return {
      allowed: answer.allowed.map((r) => ({
        to: r.to,
        stop: purpose !== null && r.person !== null,
      })),
      dropped: answer.dropped,
    };
  }

  /** What `contactCheck` allowed in this session (ADR 0678): each address's purpose and Person. */
  readonly #vouched = new Map<string, { purpose: SendPurpose | null; person: string | null }>();

  async submitAction(action: number, description: OutboundDescription): Promise<void> {
    const host = this.#host;
    // Consent to be contacted (ADR 0678), at the one place every caller's send passes, for every
    // kind that sends to people (integrations/sends.ts): refused here, it is never queued,
    // applied or retried.
    const standing = this.#standing();
    let contact: OutboundContact | null = null;
    if (standing && this.#caller.kind === "actor") {
      try {
        contact = await contactAtSubmit(createCrmDb(host.env.DB), {
          vendor: host.vendor,
          description,
          sender: standing,
          actor: this.#caller.caller.actor,
          vouched: this.#vouched,
          at: new Date().toISOString(),
        });
      } catch (error) {
        await this.#auditRefusal({
          channel: "email",
          actionKind: description.actionKind?.tag ?? null,
          refused: 1,
          sent: false,
        });
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    }
    // An agreement's copy submitted again (ADR 0645: a retry of one whose first submission was cut
    // off): if a person's approval already waits for it, that is the answer, never a second one.
    if (this.#caller.kind === "system" && this.#caller.purpose === "agreements") {
      const waiting = await createCrmDb(host.env.DB)
        .query.selectFrom("core_pending_action")
        .select(["id", "change_set_id", "expires_at"])
        .where("connection_id", "=", host.connectionId)
        .where("facet_key", "=", host.facetKey)
        .where("gk_action", "=", action)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (waiting) {
        this.pending.push({
          status: "pending_approval",
          changeSetId: waiting.change_set_id,
          actionId: waiting.id,
          operation: "integration.outbound",
          provisionalIds: [],
          dependsOn: [],
          expiresAt: waiting.expires_at,
          simulated: null,
          message: "Waiting for a person's approval.",
        });
        return;
      }
    }
    const routine =
      this.#caller.kind === "system" && this.#caller.purpose === "routine-mail"
        ? this.#caller.routine
        : null;
    const caller =
      this.#caller.kind === "actor"
        ? this.#caller.caller
        : routine
          ? {
              // A routine email is its automation run's: a held one waits in the run's change set.
              // A host kind's (ADR 0670) has no run: it waits in the host's own set for the kind.
              actor: "automation" as const,
              userId: this.#caller.user.id,
              userName: this.#caller.user.name,
              role: this.#caller.user.role,
              origin:
                routine.automationId && routine.runId
                  ? {
                      surface: "automation" as const,
                      automationId: routine.automationId,
                      runId: routine.runId,
                      extensionId: routine.extensionId,
                    }
                  : {
                      surface: "automation" as const,
                      automationId: `routine-message:${routine.kind}`,
                    },
              reason:
                routine.channel === "text"
                  ? routine.routine
                    ? `Routine text ${routine.kind} (${routine.id})`
                    : `Routine text ${routine.kind}, held for a person: ${routine.heldReason ?? "not routine"}. ` +
                      "Approving it sends this text to the member's number."
                  : routine.routine
                    ? `Routine email ${routine.kind} (${routine.id})`
                    : routine.ordinary
                      ? `Routine email ${routine.kind}: routine email is not turned on, so it waits as before`
                      : `Routine email ${routine.kind}, held for a person: ${routine.heldReason ?? "not routine"}. ` +
                        "Approving it sends this email, and means you stand behind the values it shows: " +
                        "later routine email about this record goes out on its own while they stay as they are.",
            }
          : {
              actor: "automation" as const,
              userId: this.#caller.user.id,
              userName: this.#caller.user.name,
              role: this.#caller.user.role,
              // The host's own mail no AI wrote or reads (sign-in codes, an agreement's copy) is
              // the system's: the outbound check never reads it (ADR 0645).
              origin:
                this.#caller.purpose === "sign-in"
                  ? { surface: "system" as const, automationId: this.#caller.origin }
                  : this.#caller.purpose === "agreements"
                    ? { surface: "system" as const, automationId: "system.agreements" }
                    : this.#caller.purpose === "accounting"
                      ? // The sync's entries are composed by host code from host records: no AI
                        // wrote them, so the outbound check never reads them (ADR 0881).
                        { surface: "system" as const, automationId: "system.accounting" }
                      : {
                          surface: "automation" as const,
                          automationId: `${this.#caller.purpose}:${host.connectionId}`,
                        },
            };
    const submission: OutboundSubmission = {
      connectionId: host.connectionId,
      connectionTitle: host.connectionTitle,
      vendor: host.vendor,
      facetKey: host.facetKey,
      resourceTitle: host.resourceTitle,
      action,
      description,
      actor: caller.actor,
      user: this.#caller.user,
      origin: caller.origin,
      reason: caller.reason,
      floor: parseFloor(host.env.APPROVAL_FLOOR),
      // outbound.message (ADR 0238): a message an AI actor wrote is checked before it leaves.
      judge: runnerJudge(host.env),
      // The host's own message (ADR 0429): only `callAsHost` opens a queue with these purposes
      // (an agreement's copy, ADR 0645, as an order's confirmation; an entry for the books, ADR
      // 0881, whose void the always-reviewed kinds still hold for a person).
      ...(this.#caller.kind === "system" &&
      (this.#caller.purpose === "orders" ||
        this.#caller.purpose === "agreements" ||
        this.#caller.purpose === "accounting")
        ? { hostMessage: true }
        : {}),

      // Routine mail (ADR 0590): the host's decision, which the gate applies only with the
      // gatekeeper's routine kind; anything else from this queue waits for a person.
      ...(routine ? { routineMail: { routine: routine.routine, ordinary: routine.ordinary } } : {}),
      ...(this.#caller.kind === "actor" && this.#caller.caller.request
        ? { asked: this.#caller.caller.request }
        : {}),
      ...(contact ? { contact } : {}),
    };
    const db = createCrmDb(host.env.DB);
    const decision = await submitOutbound(db, submission);
    if (decision.decision === "review") {
      this.pending.push(decision.pending);
      return;
    }
    // Apply or reject once submitAction has returned: the gatekeeper is still inside the call
    // that submitted it.
    const later = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      if (decision.decision === "deny") {
        this.denied.push(action);
        await host.reject(host.facetKey, action);
        return;
      }
      try {
        await host.apply(host.facetKey, action, contact?.stoppable);
        this.applied.push({
          action,
          actionKind: description.actionKind?.tag ?? null,
          title: description.title,
        });
        await auditOutboundApplied(db, submission, { ok: true }, decision.judgeUsage);
      } catch (error) {
        const outcome = parseApplyOutcome(error instanceof Error ? error.message : String(error));
        // An agreement's copy: the provider's words may name the recipient, and an admin's MCP
        // client reads the audit, so its row keeps the outcome only (ADR 0645).
        const agreements = this.#caller.kind === "system" && this.#caller.purpose === "agreements";
        this.failed.push({
          action,
          actionKind: description.actionKind?.tag ?? null,
          title: description.title,
          ...(agreements ? { ...outcome, message: `Not sent (${outcome.outcome})` } : outcome),
        });
        await auditOutboundApplied(
          db,
          submission,
          {
            ok: false,
            message: agreements
              ? `Not sent (${outcome.outcome})`
              : error instanceof Error
                ? error.message
                : String(error),
          },
          decision.judgeUsage,
        );
      }
    });
    this.deferred.push(later);
  }

  async bindHook(
    controller: unknown,
    _callback: unknown,
    description: { title: string; description: string },
  ): Promise<void> {
    const host = this.#host;
    const d = {
      title: String(description?.title ?? "Hook").slice(0, 200),
      description: String(description?.description ?? "").slice(0, 2000),
    };
    // The controller is a persistent stub: store it now, while it is still ours.
    const id = await host.stashController(controller);
    if (
      this.#caller.kind === "system" &&
      (this.#caller.purpose === "sync" ||
        this.#caller.purpose === "webhook" ||
        this.#caller.purpose === "payments" ||
        this.#caller.purpose === "text-events")
    ) {
      const purpose = this.#caller.purpose;
      // Enable it once bindHook has returned to the gatekeeper.
      this.deferred.push(
        new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
          host.enableHook(id, host.facetKey, purpose, d),
        ),
      );
      return;
    }
    await host.recordAgentHook(id, host.facetKey, d);
  }

  getGitCache(): never {
    throw new Error("This CRM hosts no git cache");
  }

  /** Waits for the auto-applies and hook enables this queue scheduled. */
  async settle(): Promise<void> {
    while (this.deferred.length) {
      const batch = this.deferred.splice(0);
      await Promise.allSettled(batch);
    }
  }
}
