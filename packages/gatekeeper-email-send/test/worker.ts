// The test Worker: the real gatekeeper Worker plus a host-like harness standing in for the CRM's
// integration host (the Workshop side), and a fake Email Service binding (vitest.config.ts binds
// EMAIL to FakeEmail).

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ObservationDescription,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import type { OutgoingEmail } from "../src/transport";
import type { EmailSendSession } from "../src/types";
import { EmailSendGatekeeper } from "../src/worker";
import { fakeEmail, observations, sentEmails, submissions } from "./fakes";

/**
 * The real facet, plus a way for a test to seed its storage as an older version of it left it
 * (the idempotency keys remembered before keys were kept per class).
 */
export class SeedableEmailSendGatekeeper extends EmailSendGatekeeper {
  async seedStorage(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }
}

// Named one by one: the Workers pool derives ctx.exports from the main module's own export names,
// and does not follow `export *`.
export {
  default,
  EmailSendAccount,
  EmailSendGatekeeper,
  EmailSendVerifier,
  GatekeeperVendor,
} from "../src/worker";

/** Stands in for Email Service's `send_email` binding. */
export class FakeEmail extends WorkerEntrypoint {
  async send(message: OutgoingEmail): Promise<{ messageId: string }> {
    if (fakeEmail.failNext) {
      fakeEmail.failNext = false;
      throw new Error("connection reset while sending");
    }
    sentEmails.push(message);
    return { messageId: `msg-${sentEmails.length}` };
  }
}

/**
 * Stands in for the overseer's approval queue. With `autoApply`, it applies an auto-approvable
 * action while the submission is still in flight, as a host with that kind enabled may.
 */
class FakeQueue extends RpcTarget {
  readonly #autoApply: ((id: number) => Promise<void>) | undefined;
  readonly #hostSignIn: boolean;
  readonly #routine: { siteOrigin: string | null } | null;
  readonly #hostAgreement: boolean;

  constructor(
    autoApply?: (id: number) => Promise<void>,
    hostSignIn = false,
    routine: { siteOrigin: string | null } | null = null,
    hostAgreement = false,
  ) {
    super();
    this.#autoApply = autoApply;
    this.#hostSignIn = hostSignIn;
    this.#routine = routine;
    this.#hostAgreement = hostAgreement;
  }

  /** What the host says opened the queue (ADR 0645): one of its own purposes, or null. */
  hostPurposeAnswer: string | null | undefined = undefined;
  async hostPurpose(): Promise<string | null> {
    return this.hostPurposeAnswer ?? null;
  }

  /** As the CRM's integration host answers: true only for its own agreements mail (ADR 0645). */
  async isHostAgreementMail(): Promise<boolean> {
    return this.#hostAgreement;
  }

  /** As the CRM's integration host answers: only for its own routine mail, decided routine (ADR 0590). */
  async hostRoutineMail(): Promise<{ siteOrigin: string | null } | null> {
    return this.#routine;
  }

  /** As the CRM's integration host answers: true only for its own sign-in mail (ADR 0456). */
  async isHostSignInMail(): Promise<boolean> {
    return this.#hostSignIn;
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
    if (description.autoApprovable === true && this.#autoApply) await this.#autoApply(action);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    observations.push(description);
  }
}

type SessionMethod = keyof EmailSendSession;

/** The host side: owns the facet, as the CRM's integration host DO does. */
export class TestHost extends DurableObject<Cloudflare.Env> {
  #facet: Fetcher<EmailSendGatekeeper> | undefined;
  #session: EmailSendSession | undefined;

  /** Resolves `url` through a fresh account, creates the facet and opens a session. */
  async open(
    url: string,
    options: {
      autoApply?: boolean;
      hostSignIn?: boolean;
      hostRoutine?: { siteOrigin: string | null };
      hostAgreement?: boolean;
      /** The host's purpose the queue answers (`agreements`, `routine-mail`, …). */
      hostPurpose?: string;
      /** A facet whose storage the test may seed (`seed`). */
      seedable?: boolean;
    } = {},
  ): Promise<ResourceDescription> {
    const account = this.ctx.exports.EmailSendAccount({});
    const { class: gatekeeperClass } = await account.getGatekeeperClassFor(url);
    const facet = this.ctx.facets.get<SeedableEmailSendGatekeeper>("gatekeeper", () => ({
      // The real class, with a seeding method for tests; the sender is the URL's, as the
      // account's class would have it.
      class: (options.seedable
        ? // A test-only export: the generated types know the Worker's main module only.
          (
            this.ctx.exports as unknown as Record<string, (o: { props: unknown }) => unknown>
          ).SeedableEmailSendGatekeeper?.({
            props: { sender: decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)) },
          })
        : gatekeeperClass) as unknown as DurableObjectClass<SeedableEmailSendGatekeeper>,
    }));
    this.#facet = facet;
    const queue = new FakeQueue(
      options.autoApply ? (id) => facet.applyAction(id) : undefined,
      options.hostSignIn === true,
      options.hostRoutine ?? null,
      options.hostAgreement === true,
    );
    queue.hostPurposeAnswer = options.hostPurpose;

    this.#session = (await facet.startSession(queue as never)) as unknown as EmailSendSession;
    return facet.describe();
  }

  /** Writes `value` at `key` in the facet's storage (a facet opened `seedable`). */
  async seed(key: string, value: unknown): Promise<void> {
    await (this.#requireFacet() as unknown as Fetcher<SeedableEmailSendGatekeeper>).seedStorage(
      key,
      value,
    );
  }

  /** Calls a session method with arguments that may be anything, as extension code can. */

  async call(method: SessionMethod, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Record<
      SessionMethod,
      (...args: unknown[]) => Promise<unknown>
    >;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    return session[method](...args);
  }

  async apply(id: number): Promise<void> {
    await this.#requireFacet().applyAction(id);
  }

  async reject(id: number): Promise<void> {
    await this.#requireFacet().rejectAction(id);
  }

  async revert(id: number): Promise<unknown> {
    return this.#requireFacet().revertAction(id);
  }

  async autoApprovable(): Promise<ActionKind[]> {
    return this.#requireFacet().getAutoApprovableActions();
  }

  async types(): Promise<string> {
    return this.#requireFacet().getTypeScriptTypes();
  }

  #requireFacet(): Fetcher<EmailSendGatekeeper> {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): EmailSendSession {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
