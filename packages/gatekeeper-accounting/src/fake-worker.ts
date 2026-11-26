// cos-gatekeeper-accounting-fake: the fake accounting system as a gatekeeper, for development and
// tests only (stage 61, ADR 0880). It is never part of a release: its config is
// wrangler.fake.jsonc, which no deployment reads, and only the CRM's dev server and cos-runner's
// tests bind it (`GATEKEEPER_ACCOUNTING_FAKE`). Each resource is one set of fake books,
// `accounting-fake://books/<name>`, kept in its own Durable Object; `FakeBooksControl` lets a
// test change them as a bookkeeper would, or make the next write fail.
//
// No capnweb-validate decorators (the dev server runs this Worker as an auxiliary worker): every
// session input is checked by validate.ts. As a Worker's main module it exports only entrypoints
// and classes.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { workerVersionTag } from "@composable-os/gatekeeper-interface/gatekeeper";
import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import {
  FAKE_UNKNOWN_TAG,
  FAKE_WRITE_METHODS,
  FakeBooks,
  type FakeBooksState,
  type FakeFailure,
  type FakeWriteMethod,
  fakeBooksState,
} from "./fake.js";
import { refusalCode } from "./refusal.js";
import { AccountingGatekeeper, TYPES_CODE } from "./session.js";
import type { AccountingSystem } from "./system.js";
import type {
  AccountingAccount,
  AccountingBooks,
  AccountingContact,
  AccountingContactInput,
  AccountingContactQuery,
  AccountingDocumentInput,
  AccountingDocumentStatus,
  AccountingMoneyInput,
  AccountingRecord,
  AccountingSession,
  AccountingSummaryInput,
  AccountingTaxRate,
  AccountingTransferInput,
} from "./types.js";

type Env = Cloudflare.Env;
type BooksProps = { books: string };

const BOOKS_URL_PATTERN = "accounting-fake://books/:name";
const BOOKS_URL = /^accounting-fake:\/\/books\/([a-z0-9][a-z0-9-]{0,39})$/;
const TITLE = "Fake books (development)";

function booksUrl(name: string): string {
  return `accounting-fake://books/${assertBooksName(name)}`;
}

function assertBooksName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    throw new TypeError("A fake books name is 1 to 40 of a-z, 0-9 and -.");
  }
  return name;
}

function booksFromUrl(url: unknown): string {
  const match = typeof url === "string" ? BOOKS_URL.exec(url) : null;
  if (!match?.[1]) throw new TypeError("Not fake books: expected accounting-fake://books/<name>.");
  return match[1];
}

const ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
        "<path d='M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'/></svg>",
    ),
};

const BOOKS_RESOURCE: SupportedResource = {
  urlPattern: BOOKS_URL_PATTERN,
  title: "Fake books",
  description:
    "Books with invented accounts, tax rates and contacts, for development and tests. Nothing " +
    "leaves this machine.",
  icon: ICON,
  grantable: true,
};

const CONFIGURATOR_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fake books</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
    <p>Name the fake books to connect. Each name is its own set of books.</p>
  </body>
</html>`;

// =======================================================================================
// The books, one Durable Object per name.

/** The system and control methods the books answer, by name. */
const BOOKS_METHODS = [
  "describeBooks",
  "listAccounts",
  "listTaxRates",
  "findContacts",
  "documentStatus",
  "findByReference",
  ...FAKE_WRITE_METHODS,
  "failNext",
  "writesOf",
  "setLockDate",
  "setUnavailable",
  "setLookupLag",
  "hangNext",
  "recordPaymentInBooks",
  "addInvoiceInBooks",
] as const;
type BooksMethod = (typeof BOOKS_METHODS)[number];

export class FakeAccountingBooks extends DurableObject<Env> {
  #load(): FakeBooksState {
    return this.ctx.storage.kv.get<FakeBooksState>("state") ?? fakeBooksState();
  }

  /** Runs one method on the books, keeping what it changed even when it then throws. */
  async run(method: BooksMethod, args: unknown[]): Promise<unknown> {
    if (!BOOKS_METHODS.includes(method)) throw new TypeError(`Not a books method: ${method}`);
    const waiting = this.#load();
    if (waiting.hangNext && (FAKE_WRITE_METHODS as readonly string[]).includes(method)) {
      // A write that hangs: taken off first, so only this one waits; the books are read again
      // after it, so what happened meanwhile is kept.
      const ms = waiting.hangNext;
      waiting.hangNext = 0;
      this.ctx.storage.kv.put("state", waiting);
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const books = new FakeBooks(this.#load(), TITLE);
    const target = books as unknown as Record<BooksMethod, (...a: unknown[]) => unknown>;
    try {
      return await target[method](...args);
    } finally {
      this.ctx.storage.kv.put("state", books.state);
    }
  }

  /** Starts the books again, as a fresh fake (optionally in another currency or locked). */
  async reset(overrides: Partial<AccountingBooks> = {}): Promise<void> {
    this.ctx.storage.kv.put("state", fakeBooksState(overrides));
  }

  async state(): Promise<FakeBooksState> {
    return this.#load();
  }
}

/** The system a facet talks to: the books' Durable Object, with its failures thrown as they were. */
class FakeBooksClient implements AccountingSystem {
  readonly title = TITLE;
  readonly #stub: DurableObjectStub<FakeAccountingBooks>;

  constructor(stub: DurableObjectStub<FakeAccountingBooks>) {
    this.#stub = stub;
  }

  async #run<T>(method: BooksMethod, ...args: unknown[]): Promise<T> {
    try {
      return (await this.#stub.run(method, args)) as T;
    } catch (error) {
      // RPC carries the message, not the class: throw the class the message says.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(FAKE_UNKNOWN_TAG)) throw new ActionOutcomeUnknownError(message);
      if (refusalCode(message) !== null) {
        throw new ActionApplyError(message.slice(message.indexOf("[accounting:")));
      }
      throw error;
    }
  }

  describeBooks(): Promise<AccountingBooks> {
    return this.#run("describeBooks");
  }
  listAccounts(): Promise<AccountingAccount[]> {
    return this.#run("listAccounts");
  }
  listTaxRates(): Promise<AccountingTaxRate[]> {
    return this.#run("listTaxRates");
  }
  findContacts(query: AccountingContactQuery): Promise<AccountingContact[]> {
    return this.#run("findContacts", query);
  }
  documentStatus(refs: string[]): Promise<AccountingDocumentStatus[]> {
    return this.#run("documentStatus", refs);
  }
  findByReference(reference: string): Promise<AccountingRecord | null> {
    return this.#run("findByReference", reference);
  }
  createContact(input: AccountingContactInput): Promise<string> {
    return this.#run("createContact", input);
  }
  updateContact(input: AccountingContactInput & { ref: string }): Promise<string> {
    return this.#run("updateContact", input);
  }
  postSummary(input: AccountingSummaryInput): Promise<string> {
    return this.#run("postSummary", input);
  }
  postTransfer(input: AccountingTransferInput): Promise<string> {
    return this.#run("postTransfer", input);
  }
  postInvoice(input: AccountingDocumentInput): Promise<string> {
    return this.#run("postInvoice", input);
  }
  postCreditNote(input: AccountingDocumentInput): Promise<string> {
    return this.#run("postCreditNote", input);
  }
  postPayment(input: AccountingMoneyInput): Promise<string> {
    return this.#run("postPayment", input);
  }
  postRefund(input: AccountingMoneyInput): Promise<string> {
    return this.#run("postRefund", input);
  }
  async voidDocument(ref: string): Promise<void> {
    await this.#run("voidDocument", ref);
  }
}

function booksStub(env: Env, name: string): DurableObjectStub<FakeAccountingBooks> {
  return env.FAKE_BOOKS.getByName(assertBooksName(name));
}

// =======================================================================================
// The facet of one set of fake books.

export class FakeAccountingGatekeeper extends AccountingGatekeeper<BooksProps> {
  protected system(): AccountingSystem {
    return new FakeBooksClient(booksStub(this.env, this.ctx.props.books));
  }

  protected resourceUrl(): string {
    return booksUrl(this.ctx.props.books);
  }
}

// =======================================================================================
// What a test does to the books, as a bookkeeper (or a failing network) would.

export class FakeBooksControl extends WorkerEntrypoint<Env> {
  async reset(books: string, overrides: Partial<AccountingBooks> = {}): Promise<void> {
    await booksStub(this.env, books).reset(overrides);
  }

  async failNext(books: string, method: FakeWriteMethod | "any", failure: FakeFailure) {
    await booksStub(this.env, books).run("failNext", [method, failure]);
  }

  async writesOf(books: string, reference: string): Promise<number> {
    return (await booksStub(this.env, books).run("writesOf", [reference])) as number;
  }

  async setLockDate(books: string, date: string | null): Promise<void> {
    await booksStub(this.env, books).run("setLockDate", [date]);
  }

  /** Each reference written from now on is missed by its next `lookups` look-ups. */
  async setLookupLag(books: string, lookups: number): Promise<void> {
    await booksStub(this.env, books).run("setLookupLag", [lookups]);
  }

  /** The next write waits `ms` before it is written (a call that hangs). */
  async hangNext(books: string, ms: number): Promise<void> {
    await booksStub(this.env, books).run("hangNext", [ms]);
  }

  /** The books go down (every call refused `unavailable`), or come back. */
  async setUnavailable(books: string, on: boolean): Promise<void> {
    await booksStub(this.env, books).run("setUnavailable", [on]);
  }

  async recordPaymentInBooks(books: string, document: string, amount: number, date: string) {
    return (await booksStub(this.env, books).run("recordPaymentInBooks", [
      document,
      amount,
      date,
    ])) as string;
  }

  async addInvoiceInBooks(
    books: string,
    contact: string,
    number: string,
    total: number,
    date: string,
  ): Promise<string> {
    return (await booksStub(this.env, books).run("addInvoiceInBooks", [
      contact,
      number,
      total,
      date,
    ])) as string;
  }

  async state(books: string): Promise<FakeBooksState> {
    return booksStub(this.env, books).state();
  }
}

// =======================================================================================
// The configurator capability, account, verifier and vendor.

export class FakeBooksConfiguratorUi extends RpcTarget {
  /** The resource URL of the books named `name`. */
  async resourceUrl(name: unknown): Promise<string> {
    return booksUrl(assertBooksName(name));
  }
}

export class FakeBooksAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: TITLE, avatar: ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [BOOKS_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<AccountingSession>>;
    resource: SupportedResource;
  }> {
    const props: BooksProps = { books: booksFromUrl(url) };
    return {
      class: this.ctx.exports.FakeAccountingGatekeeper({ props }) as unknown as DurableObjectClass<
        Gatekeeper<AccountingSession>
      >,
      resource: BOOKS_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== BOOKS_URL_PATTERN) {
      throw new Error(`Unsupported resource type: ${String(resourceUrlPattern).slice(0, 200)}`);
    }
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new FakeBooksConfiguratorUi()) };
  }

  /** Nothing to revoke: the fake holds no credentials. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The fake books have no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The fake books have no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.FakeBooksVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

/** The trivial verifier that goes with admitting every observer. */
export class FakeBooksVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/** The vendor, and the Worker's default entrypoint. It serves no routes. */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  override async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: TITLE,
      url: "http://localhost/gatekeeper/accounting-fake",
      logo: ICON,
      tagline: "Fake books for development",
      description:
        "Books with invented accounts, tax rates and contacts, served through the accounting " +
        "contract, for development and tests only.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.FakeBooksAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("The fake books are auto-provisioned and have no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [BOOKS_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
