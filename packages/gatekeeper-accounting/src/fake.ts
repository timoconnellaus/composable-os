// A fake accounting system (stage 61, ADR 0880): books with accounts, tax rates, contacts,
// documents and a lock date, held in one plain state object so it runs in memory for the
// conformance suite and inside a Durable Object for the fake gatekeeper. It refuses what real
// books refuse (an unknown or archived account, an archived contact, a number in use, a date in
// the lock, another currency), and a test can make its next write fail: refused, an outcome
// unknown with nothing written, or one unknown after the write went through. It counts how many
// times each reference was written, which must never be more than once.

import { ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import { refuse } from "./refusal.js";
import type { AccountingSystem } from "./system.js";
import type {
  AccountingAccount,
  AccountingAddress,
  AccountingBooks,
  AccountingBooksPayment,
  AccountingContact,
  AccountingContactInput,
  AccountingContactQuery,
  AccountingDocumentInput,
  AccountingDocumentStatus,
  AccountingMoneyInput,
  AccountingRecord,
  AccountingRecordKind,
  AccountingRefusalCode,
  AccountingSummaryInput,
  AccountingTaxRate,
  AccountingTransferInput,
} from "./types.js";
import { MAX_CONTACT_CANDIDATES } from "./validate.js";

export const FAKE_WRITE_METHODS = [
  "createContact",
  "updateContact",
  "postSummary",
  "postTransfer",
  "postInvoice",
  "postCreditNote",
  "postPayment",
  "postRefund",
  "voidDocument",
] as const;
export type FakeWriteMethod = (typeof FAKE_WRITE_METHODS)[number];

/**
 * How the next write fails. `refuse`: refused with the code, nothing written. `unknown`: the
 * answer is lost, nothing written. `unknown_after_write`: written, then the answer is lost.
 */
export type FakeFailure = { refuse: AccountingRefusalCode } | "unknown" | "unknown_after_write";

export type FakeContact = AccountingContact & { address: AccountingAddress | null };

/** A record in the fake books: an entry, a document, or money against a document. */
export type FakeRecord = {
  ref: string;
  kind: Exclude<AccountingRecordKind, "contact">;
  /** The host's reference; `null` for one entered by the bookkeeper. */
  reference: string | null;
  date: string;
  voided: boolean;
  /** A document's number, contact and total; money's document and amount. */
  number?: string;
  contact?: string;
  total?: number;
  document?: string;
  amount?: number;
  /** As written, so a test can read exactly what reached the books. */
  input: unknown;
};

export type FakeBooksState = {
  books: AccountingBooks;
  accounts: AccountingAccount[];
  taxRates: AccountingTaxRate[];
  contacts: FakeContact[];
  records: FakeRecord[];
  /** How many times each reference was written. */
  writes: Record<string, number>;
  /** The next writes' failures, in order, each for one method or for any write. */
  failures: { method: FakeWriteMethod | "any"; failure: FakeFailure }[];
  seq: number;
};

/** The marker the fake's lost answers carry across RPC, so the gatekeeper's side throws it again. */
export const FAKE_UNKNOWN_TAG = "[fake:unknown] ";

/** Books as a fresh fake starts: invented accounts, rates and contacts, nothing posted. */
export function fakeBooksState(overrides: Partial<AccountingBooks> = {}): FakeBooksState {
  const account = (
    ref: string,
    code: string,
    name: string,
    type: AccountingAccount["type"],
    archived = false,
  ): AccountingAccount => ({ ref, code, name, type, archived });
  const contact = (
    ref: string,
    name: string,
    email: string | null,
    taxNumber: string | null,
    archived = false,
  ): FakeContact => ({ ref, name, email, taxNumber, archived, reference: null, address: null });
  return {
    books: {
      name: "Fake books",
      baseCurrency: "AUD",
      lockDate: null,
      pricesIncludeTax: true,
      ...overrides,
    },
    accounts: [
      account("acc-sales", "200", "Sales", "revenue"),
      account("acc-memberships", "201", "Memberships", "revenue"),
      account("acc-passes", "202", "Passes and drop-ins", "revenue"),
      account("acc-old-sales", "209", "Old sales", "revenue", true),
      account("acc-refunds", "210", "Refunds", "revenue"),
      account("acc-clearing", "610", "Card clearing", "current_asset"),
      account("acc-bank", "090", "Business account", "bank"),
      account("acc-fees", "404", "Card fees", "expense"),
      account("acc-rounding", "860", "Rounding", "expense"),
      account("acc-gst", "820", "GST", "current_liability"),
    ],
    taxRates: [
      { ref: "tax-gst", name: "GST on income", rate: 1000, archived: false },
      { ref: "tax-free", name: "GST free", rate: 0, archived: false },
      { ref: "tax-old", name: "Old rate", rate: 1250, archived: true },
    ],
    contacts: [
      contact("con-example", "Example Pty Ltd", "accounts@example.com", "51 824 753 556"),
      contact("con-sample", "Sample Trading", "office@sample.example", null),
      contact("con-sample-2", "Sample Trading Co", "hello@sample.example", null),
      contact("con-closed", "Closed Studio", "closed@example.org", null, true),
    ],
    records: [],
    writes: {},
    failures: [],
    seq: 0,
  };
}

function lower(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function taxKey(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "");
}

/** The fake system over a state it mutates in place. Every method is synchronous underneath. */
export class FakeBooks implements AccountingSystem {
  readonly title: string;
  readonly state: FakeBooksState;

  constructor(state: FakeBooksState = fakeBooksState(), title = "Fake books (development)") {
    this.state = state;
    this.title = title;
  }

  // --- Controls a test (or the dev seed) uses; not part of the system. --------------------------

  failNext(method: FakeWriteMethod | "any", failure: FakeFailure): void {
    this.state.failures.push({ method, failure });
  }

  writesOf(reference: string): number {
    return this.state.writes[reference] ?? 0;
  }

  setLockDate(date: string | null): void {
    this.state.books.lockDate = date;
  }

  /** The bookkeeper records a payment on a document in the books (a transfer in the bank feed). */
  recordPaymentInBooks(document: string, amount: number, date: string): string {
    const doc = this.#document(document);
    const ref = this.#nextRef("payment");
    this.state.records.push({
      ref,
      kind: "payment",
      reference: null,
      date,
      voided: false,
      document: doc.ref,
      amount,
      input: { document, amount, date },
    });
    return ref;
  }

  /** The bookkeeper's own invoice, entered in the books: no host reference. */
  addInvoiceInBooks(contact: string, number: string, total: number, date: string): string {
    const ref = this.#nextRef("invoice");
    this.state.records.push({
      ref,
      kind: "invoice",
      reference: null,
      date,
      voided: false,
      number,
      contact,
      total,
      input: { contact, number, total, date },
    });
    return ref;
  }

  // --- Reads. ------------------------------------------------------------------------------------

  async describeBooks(): Promise<AccountingBooks> {
    return structuredClone(this.state.books);
  }

  async listAccounts(): Promise<AccountingAccount[]> {
    return structuredClone(this.state.accounts);
  }

  async listTaxRates(): Promise<AccountingTaxRate[]> {
    return structuredClone(this.state.taxRates);
  }

  async findContacts(query: AccountingContactQuery): Promise<AccountingContact[]> {
    return this.state.contacts
      .filter(
        (c) =>
          (query.reference === undefined || c.reference === query.reference) &&
          (query.email === undefined || lower(c.email) === lower(query.email)) &&
          (query.taxNumber === undefined || taxKey(c.taxNumber) === taxKey(query.taxNumber)) &&
          (query.name === undefined || lower(c.name).includes(lower(query.name))),
      )
      .slice(0, MAX_CONTACT_CANDIDATES)
      .map(({ address: _address, ...contact }) => structuredClone(contact));
  }

  async documentStatus(refs: string[]): Promise<AccountingDocumentStatus[]> {
    const out: AccountingDocumentStatus[] = [];
    for (const ref of refs) {
      const doc = this.state.records.find(
        (r) => r.ref === ref && (r.kind === "invoice" || r.kind === "credit_note"),
      );
      if (!doc) continue;
      const due = this.#due(doc);
      const total = doc.total ?? 0;
      out.push({
        ref,
        status: doc.voided ? "void" : due === 0 ? "paid" : due < total ? "part_paid" : "open",
        amountDue: doc.voided ? 0 : due,
        paymentsNotSent: this.state.records
          .filter((r) => r.document === ref && r.kind === "payment" && r.reference === null)
          .map(
            (r): AccountingBooksPayment => ({
              ref: r.ref,
              date: r.date,
              amount: r.amount ?? 0,
              reference: null,
            }),
          ),
      });
    }
    return out;
  }

  async findByReference(reference: string): Promise<AccountingRecord | null> {
    const contact = this.state.contacts.find((c) => c.reference === reference);
    if (contact) return { ref: contact.ref, kind: "contact", reference, voided: false };
    const record = this.state.records.find((r) => r.reference === reference);
    return record ? { ref: record.ref, kind: record.kind, reference, voided: record.voided } : null;
  }

  // --- Writes. -----------------------------------------------------------------------------------

  async createContact(input: AccountingContactInput): Promise<string> {
    return this.#write("createContact", input.reference, () => {
      const ref = this.#nextRef("contact");
      this.state.contacts.push({
        ref,
        name: input.name,
        email: input.email ?? null,
        taxNumber: input.taxNumber ?? null,
        archived: false,
        reference: input.reference,
        address: input.address ?? null,
      });
      return ref;
    });
  }

  async updateContact(input: AccountingContactInput & { ref: string }): Promise<string> {
    return this.#write("updateContact", null, () => {
      const contact = this.state.contacts.find((c) => c.ref === input.ref);
      if (!contact) throw refuse("invalid", `No contact ${input.ref} in the books.`);
      if (contact.archived) {
        throw refuse("contact_archived", `Contact ${input.ref} is archived in the books.`);
      }
      contact.name = input.name;
      contact.email = input.email ?? null;
      contact.taxNumber = input.taxNumber ?? null;
      contact.address = input.address ?? null;
      contact.reference ??= input.reference;
      return contact.ref;
    });
  }

  async postSummary(input: AccountingSummaryInput): Promise<string> {
    return this.#write("postSummary", input.reference, () => {
      this.#checkEntry(input.currency, input.date);
      for (const line of input.lines) {
        this.#account(line.account);
        if (line.taxRate !== null) this.#taxRate(line.taxRate);
      }
      if (input.contact !== undefined) this.#contact(input.contact);
      return this.#record("summary", input.reference, input.date, input, {});
    });
  }

  async postTransfer(input: AccountingTransferInput): Promise<string> {
    return this.#write("postTransfer", input.reference, () => {
      this.#checkEntry(input.currency, input.date);
      if (this.#account(input.bankAccount).type !== "bank") {
        throw refuse("unmapped", `${input.bankAccount} is not a bank account in the books.`);
      }
      this.#account(input.clearingAccount);
      for (const line of input.lines) this.#account(line.account);
      return this.#record("transfer", input.reference, input.date, input, {
        amount: input.amount,
      });
    });
  }

  async postInvoice(input: AccountingDocumentInput): Promise<string> {
    return this.#postDocument("postInvoice", "invoice", input);
  }

  async postCreditNote(input: AccountingDocumentInput): Promise<string> {
    return this.#postDocument("postCreditNote", "credit_note", input);
  }

  async postPayment(input: AccountingMoneyInput): Promise<string> {
    return this.#postMoney("postPayment", "payment", input);
  }

  async postRefund(input: AccountingMoneyInput): Promise<string> {
    return this.#postMoney("postRefund", "refund", input);
  }

  async voidDocument(ref: string): Promise<void> {
    await this.#write("voidDocument", null, () => {
      const doc = this.#document(ref);
      if (doc.reference === null || !doc.reference.startsWith("cos:")) {
        throw refuse("invalid", `${ref} was not posted by the host.`);
      }
      const total = doc.total ?? 0;
      if (this.#due(doc) !== total) {
        throw refuse("invalid", `${ref} has money against it: it cannot be voided.`);
      }
      doc.voided = true;
      return ref;
    });
  }

  // --- Internals. --------------------------------------------------------------------------------

  #nextRef(kind: string): string {
    this.state.seq += 1;
    return `fake-${kind}-${this.state.seq}`;
  }

  /** Runs one write with the next failure that applies to it, and counts it by reference. */
  #write(method: FakeWriteMethod, reference: string | null, write: () => string): string {
    const index = this.state.failures.findIndex((f) => f.method === method || f.method === "any");
    const failure = index === -1 ? null : this.state.failures.splice(index, 1)[0]?.failure;
    if (failure && typeof failure === "object") {
      throw refuse(failure.refuse, `The fake books refused this ${method} (as asked).`);
    }
    if (failure === "unknown") {
      throw new ActionOutcomeUnknownError(`${FAKE_UNKNOWN_TAG}The answer to ${method} was lost.`);
    }
    const ref = write();
    if (reference !== null) this.state.writes[reference] = (this.state.writes[reference] ?? 0) + 1;
    if (failure === "unknown_after_write") {
      throw new ActionOutcomeUnknownError(
        `${FAKE_UNKNOWN_TAG}${method} was written, and then its answer was lost.`,
      );
    }
    return ref;
  }

  #record(
    kind: FakeRecord["kind"],
    reference: string,
    date: string,
    input: unknown,
    extra: Partial<FakeRecord>,
  ): string {
    const ref = this.#nextRef(kind);
    this.state.records.push({
      ref,
      kind,
      reference,
      date,
      voided: false,
      input: structuredClone(input),
      ...extra,
    });
    return ref;
  }

  #checkEntry(currency: string, date: string): void {
    const { books } = this.state;
    if (currency !== books.baseCurrency) {
      throw refuse("invalid", `The books keep ${books.baseCurrency}, not ${currency}.`);
    }
    if (books.lockDate !== null && date <= books.lockDate) {
      throw refuse("locked_period", `The books are locked to ${books.lockDate}.`);
    }
  }

  #account(ref: string): AccountingAccount {
    const account = this.state.accounts.find((a) => a.ref === ref);
    if (!account || account.archived) {
      throw refuse("unmapped", `Account ${ref} is not an open account in the books.`);
    }
    return account;
  }

  #taxRate(ref: string): AccountingTaxRate {
    const rate = this.state.taxRates.find((r) => r.ref === ref);
    if (!rate || rate.archived) {
      throw refuse("unmapped", `Tax rate ${ref} is not an open tax rate in the books.`);
    }
    return rate;
  }

  #contact(ref: string): FakeContact {
    const contact = this.state.contacts.find((c) => c.ref === ref);
    if (!contact) throw refuse("invalid", `No contact ${ref} in the books.`);
    if (contact.archived) throw refuse("contact_archived", `Contact ${ref} is archived.`);
    return contact;
  }

  #document(ref: string): FakeRecord {
    const doc = this.state.records.find(
      (r) => r.ref === ref && (r.kind === "invoice" || r.kind === "credit_note"),
    );
    if (!doc) throw refuse("invalid", `No document ${ref} in the books.`);
    return doc;
  }

  /** What is still owed on an invoice, or still to refund on a credit note. */
  #due(doc: FakeRecord): number {
    let due = doc.total ?? 0;
    for (const r of this.state.records) {
      if (r.document !== doc.ref) continue;
      // Money in settles an invoice; money out settles a credit note, or reverses an invoice's payment.
      const settles = doc.kind === "invoice" ? r.kind === "payment" : r.kind === "refund";
      due += settles ? -(r.amount ?? 0) : (r.amount ?? 0);
    }
    return due;
  }

  #postDocument(
    method: FakeWriteMethod,
    kind: "invoice" | "credit_note",
    input: AccountingDocumentInput,
  ): string {
    return this.#write(method, input.reference, () => {
      this.#checkEntry(input.currency, input.issueDate);
      this.#contact(input.contact);
      for (const line of input.lines) {
        this.#account(line.account);
        if (line.taxRate !== null) this.#taxRate(line.taxRate);
      }
      if (
        this.state.records.some((r) => r.kind === kind && r.number === input.number && !r.voided)
      ) {
        throw refuse("duplicate_number", `${input.number} is already used in the books.`);
      }
      const total = input.lines.reduce((sum, line) => sum + line.net + line.tax, 0);
      return this.#record(kind, input.reference, input.issueDate, input, {
        number: input.number,
        contact: input.contact,
        total,
      });
    });
  }

  #postMoney(method: FakeWriteMethod, kind: "payment" | "refund", input: AccountingMoneyInput) {
    return this.#write(method, input.reference, () => {
      this.#checkEntry(input.currency, input.date);
      this.#account(input.account);
      const doc = this.#document(input.document);
      if (doc.voided) throw refuse("invalid", `${doc.ref} is void.`);
      const settles = doc.kind === "invoice" ? kind === "payment" : kind === "refund";
      if (settles && input.amount > this.#due(doc)) {
        throw refuse("invalid", `${input.amount} is more than is due on ${doc.ref}.`);
      }
      return this.#record(kind, input.reference, input.date, input, {
        document: doc.ref,
        amount: input.amount,
      });
    });
  }
}
