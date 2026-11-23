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
import {
  type ActingUser,
  type ApplyOutcome,
  auditOutboundApplied,
  type IntegrationCaller,
  type OutboundDescription,
  type OutboundSubmission,
  type PendingApproval,
  parseApplyOutcome,
  parseFloor,
  readCountHour,
  type SignInMailOrigin,
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
      purpose: "sync" | "webhook" | "payments" | "orders" | "probe" | "agreements";
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
        automationId: string;
        runId: string;
        extensionId: string;
        siteOrigin: string | null;
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
  apply(facetKey: string, action: number): Promise<void>;
  reject(facetKey: string, action: number): Promise<void>;
  /** Keeps a hook controller stub in the host's storage; returns its hook id. */
  stashController(controller: unknown): Promise<string>;
  enableHook(
    id: string,
    facetKey: string,
    purpose: "sync" | "webhook" | "payments",
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

  async submitAction(action: number, description: OutboundDescription): Promise<void> {
    const host = this.#host;
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
              actor: "automation" as const,
              userId: this.#caller.user.id,
              userName: this.#caller.user.name,
              role: this.#caller.user.role,
              origin: {
                surface: "automation" as const,
                automationId: routine.automationId,
                runId: routine.runId,
                extensionId: routine.extensionId,
              },
              reason: routine.routine
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
      // (an agreement's copy, ADR 0645, as an order's confirmation).
      ...(this.#caller.kind === "system" &&
      (this.#caller.purpose === "orders" || this.#caller.purpose === "agreements")
        ? { hostMessage: true }
        : {}),

      // Routine mail (ADR 0590): the host's decision, which the gate applies only with the
      // gatekeeper's routine kind; anything else from this queue waits for a person.
      ...(routine ? { routineMail: { routine: routine.routine, ordinary: routine.ordinary } } : {}),
      ...(this.#caller.kind === "actor" && this.#caller.caller.request
        ? { asked: this.#caller.caller.request }
        : {}),
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
        await host.apply(host.facetKey, action);
        this.applied.push({
          action,
          actionKind: description.actionKind?.tag ?? null,
          title: description.title,
        });
        await auditOutboundApplied(db, submission, { ok: true }, decision.judgeUsage);
      } catch (error) {
        this.failed.push({
          action,
          actionKind: description.actionKind?.tag ?? null,
          title: description.title,
          ...parseApplyOutcome(error instanceof Error ? error.message : String(error)),
        });
        await auditOutboundApplied(
          db,
          submission,
          { ok: false, message: error instanceof Error ? error.message : String(error) },
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
        this.#caller.purpose === "payments")
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
