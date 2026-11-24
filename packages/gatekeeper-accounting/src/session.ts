// The accounting session and facet every accounting gatekeeper serves (ADR 0880), on the vendored
// gatekeeper kit unchanged. A gatekeeper names its system and its resource; this checks every
// input, records each read as an observation, journals each write as an outbound action
// (`accounting.contact`, `accounting.post`, `accounting.void`), describes it to a person, and
// applies it through `applyWrite` exactly once (`claimBeforeApply`). Contacts and entries may be
// approved automatically, because the host's outbox does the approving; a void never is.

import { DurableObject, type RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { sanitizeTitle } from "@composable-os/gatekeeper-kit/action-description";
import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  defineActions,
  type TaggedAction,
} from "@composable-os/gatekeeper-kit/actions";
import { type AccountingWrite, applyWrite } from "./apply.js";
import { describeWrite, type StoredWrite } from "./describe.js";
import type { AccountingSystem } from "./system.js";
import type {
  AccountingAccount,
  AccountingBooks,
  AccountingContact,
  AccountingContactQuery,
  AccountingDocumentStatus,
  AccountingReceipt,
  AccountingRecord,
  AccountingSession,
  AccountingTaxRate,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import {
  MAX_CONTACT_CANDIDATES,
  parseContactInput,
  parseContactQuery,
  parseDocumentInput,
  parseMoneyInput,
  parseReference,
  parseStatusRefs,
  parseSummaryInput,
  parseTransferInput,
  parseVoidInput,
} from "./validate.js";

export { TYPES_CODE };

export const CONTACT_KIND: ActionKind = {
  tag: "accounting.contact",
  label: "Create or update a contact in the books",
};
export const POST_KIND: ActionKind = {
  tag: "accounting.post",
  label: "Post an entry to the books",
};
export const VOID_KIND: ActionKind = {
  tag: "accounting.void",
  label: "Void a document in the books",
};

/** Every method of the session: the contract has no other (no delete, no edit of an entry). */
export const ACCOUNTING_SESSION_METHODS = [
  "describeBooks",
  "listAccounts",
  "listTaxRates",
  "findContacts",
  "documentStatus",
  "findByReference",
  "upsertContact",
  "postSummary",
  "postTransfer",
  "postInvoice",
  "postCreditNote",
  "postPayment",
  "postRefund",
  "voidDocument",
] as const satisfies readonly (keyof AccountingSession)[];

type Actions = { contact: StoredWrite; post: StoredWrite; void: StoredWrite };
type ActionHost = { apply(stored: StoredWrite): Promise<void> };

const definition = {
  delivery: "continue-with-simulation",
  // The books are written once: a crash between their answer and the journal's is an unknown
  // outcome, which the host resolves by looking the reference up, never by sending again.
  claimBeforeApply: true,
  describe: (stored: StoredWrite) => describeWrite(stored),
  apply: async (stored: StoredWrite, host: ActionHost) => {
    await host.apply(stored);
  },
  // Nothing was sent, so there is nothing to release.
  reject: async () => {},
} as const;

const actions = defineActions<ActionHost, Actions>(
  {
    contact: { ...definition, kind: CONTACT_KIND, autoApprovable: true },
    post: { ...definition, kind: POST_KIND, autoApprovable: true },
    // Takes a document out of the books' totals: a person decides every one (ADR 0880).
    void: { ...definition, kind: VOID_KIND, autoApprovable: false },
  },
  // Every write is checked against the books again when it is applied (currency, lock date,
  // reference), so an action does not depend on the credentials it was submitted under.
  { fence: "none", vendorId: "accounting" },
);

function kindOf(write: AccountingWrite): keyof Actions {
  return write.kind === "contact" ? "contact" : write.kind === "void" ? "void" : "post";
}

/** What a session asks of its facet, as closures so the session holds no facet reference. */
type SessionBackend = {
  books: string;
  system(): AccountingSystem;
  submit(queue: RpcStub<ApprovalQueue>, kind: keyof Actions, stored: StoredWrite): Promise<number>;
  wasApplied(id: number): boolean;
  appliedRef(id: number): string | null;
};

class AccountingSessionImpl extends RpcTarget implements AccountingSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  async #observe(title: string, description: string): Promise<void> {
    await this.#queue.authorizeObservation({
      title: sanitizeTitle(title),
      description: `${description} (${this.#backend.books}).`,
    });
  }

  async describeBooks(): Promise<AccountingBooks> {
    const system = this.#backend.system();
    await this.#observe("Read the books' settings", "Read the books' name, currency and lock date");
    return system.describeBooks();
  }

  async listAccounts(): Promise<AccountingAccount[]> {
    const system = this.#backend.system();
    await this.#observe("Read the books' accounts", "Read the chart of accounts, without numbers");
    return system.listAccounts();
  }

  async listTaxRates(): Promise<AccountingTaxRate[]> {
    const system = this.#backend.system();
    await this.#observe("Read the books' tax rates", "Read the tax rates");
    return system.listTaxRates();
  }

  async findContacts(query: AccountingContactQuery): Promise<AccountingContact[]> {
    const parsed = parseContactQuery(query);
    const system = this.#backend.system();
    await this.#observe(
      "Look a contact up in the books",
      `Looked contacts up by ${Object.keys(parsed).join(", ")}`,
    );
    return (await system.findContacts(parsed)).slice(0, MAX_CONTACT_CANDIDATES);
  }

  async documentStatus(refs: string[]): Promise<AccountingDocumentStatus[]> {
    const parsed = parseStatusRefs(refs);
    const system = this.#backend.system();
    await this.#observe(
      "Read documents' status in the books",
      `Read whether ${parsed.length} document(s) are paid`,
    );
    return system.documentStatus(parsed);
  }

  async findByReference(reference: string): Promise<AccountingRecord | null> {
    const parsed = parseReference(reference);
    const system = this.#backend.system();
    await this.#observe("Find an entry by its reference", `Looked up ${parsed}`);
    return system.findByReference(parsed);
  }

  async #write(write: AccountingWrite): Promise<AccountingReceipt> {
    // Refused now, not at apply, when the books are not set up at all.
    this.#backend.system();
    const id = await this.#backend.submit(this.#queue, kindOf(write), {
      books: this.#backend.books,
      write,
    });
    return this.#backend.wasApplied(id)
      ? { status: "sent", id, ref: this.#backend.appliedRef(id) }
      : { status: "pending", id, ref: null };
  }

  upsertContact(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "contact", input: parseContactInput(input) });
  }

  postSummary(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "summary", input: parseSummaryInput(input) });
  }

  postTransfer(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "transfer", input: parseTransferInput(input) });
  }

  postInvoice(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "invoice", input: parseDocumentInput(input) });
  }

  postCreditNote(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "credit_note", input: parseDocumentInput(input) });
  }

  postPayment(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "payment", input: parseMoneyInput(input) });
  }

  postRefund(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "refund", input: parseMoneyInput(input) });
  }

  voidDocument(input: unknown): Promise<AccountingReceipt> {
    return this.#write({ kind: "void", input: parseVoidInput(input) });
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

/**
 * The tag an apply failure's message starts with, as the payments gatekeeper's: core reads it
 * (`packages/core/src/integrations/outcome.ts`, `parseApplyOutcome`). The refusal's own code
 * (`[accounting:<code>] `) follows it.
 */
function applyOutcomeTag(outcome: "refused" | "unknown" | "retryable"): string {
  return `[apply-outcome:${outcome}] `;
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

/**
 * The facet of one set of books. A gatekeeper extends it and says which system it talks to
 * (`system()`, which throws when the books are not set up) and how its resource is described.
 */
export abstract class AccountingGatekeeper<P extends object = object>
  extends DurableObject<Cloudflare.Env, P>
  implements Gatekeeper<AccountingSession>
{
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "accounting",
  });

  /** The system these books are kept in, from this Worker's own credentials. */
  protected abstract system(): AccountingSystem;
  /** The resource URL these books are bound as. */
  protected abstract resourceUrl(): string;

  readonly #host: ActionHost = {
    apply: async (stored) => {
      let system: AccountingSystem;
      try {
        system = this.system();
      } catch (error) {
        // Checked before anything is sent, so nothing was written.
        throw new ActionApplyError(
          `[accounting:unavailable] ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#lastRef = await applyWrite(system, stored.write);
    },
  };
  #lastRef: string | null = null;
  readonly #refs = new Map<number, string>();

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  async describe(): Promise<ResourceDescription> {
    const system = this.system();
    return {
      url: this.resourceUrl(),
      title: system.title,
      snippet:
        `Read the accounts, tax rates, lock date and contacts of ${system.title}, and post ` +
        "entries and documents the host made, each once. Voids wait for a person; nothing is " +
        "deleted or edited.",
      suggestedBindingName: "BOOKS",
      tsType: "AccountingSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Contacts and entries: the host's outbox approves them. Never a void. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions().autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<AccountingSession> {
    const backend: SessionBackend = {
      books: this.system().title,
      system: () => this.system(),
      submit: async (queue, kind, stored) => {
        this.#lastRef = null;
        const id = await this.#actions().submit(queue, kind, stored);
        // Applied inside the submit (a queue that approves at once): keep the ref it wrote.
        if (this.#lastRef !== null) this.#refs.set(id, this.#lastRef);
        return id;
      },
      wasApplied: (id) => this.#journal.wasApplied(id),
      appliedRef: (id) => this.#refs.get(id) ?? null,
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new AccountingSessionImpl(backend, approvalQueue.dup());
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the books belong to the deployment, not to one person. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /**
   * Applies an action. A failure is thrown with what came of it in front of its message: RPC
   * carries an error's message only, so the host reads `refused` (nothing written, with the
   * refusal's code after it), `unknown` (it may have been written: look the reference up) or
   * `retryable` (nothing was sent; the action is pending again) from the tag.
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

  /** Drops a rejected write; nothing is sent. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Nothing in the books is taken back: a correction is a new entry.");
  }
}
