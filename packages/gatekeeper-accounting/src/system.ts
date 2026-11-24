// The accounting system behind a gatekeeper: what each one (the fake here, Xero in its own
// gatekeeper) implements, in the contract's own types. The shared session (session.ts) checks
// every input, describes it to a person, journals it and calls `applyWrite` (apply.ts), which
// refuses what the books could not take and never writes a reference twice; a system only talks
// to its books. It throws `refuse(code, …)` when nothing was written and
// `ActionOutcomeUnknownError` when a write may have gone through.

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
  AccountingSummaryInput,
  AccountingTaxRate,
  AccountingTransferInput,
} from "./types.js";

export interface AccountingSystem {
  /** For people: "Fake books (development)", "Xero". */
  readonly title: string;
  describeBooks(): Promise<AccountingBooks>;
  listAccounts(): Promise<AccountingAccount[]>;
  listTaxRates(): Promise<AccountingTaxRate[]>;
  /** Every key given must match; at most `MAX_CONTACT_CANDIDATES`. */
  findContacts(query: AccountingContactQuery): Promise<AccountingContact[]>;
  /** Only refs the books know; an unknown ref is left out. */
  documentStatus(refs: string[]): Promise<AccountingDocumentStatus[]>;
  findByReference(reference: string): Promise<AccountingRecord | null>;

  /** Each returns the books' ref of what it wrote, stored with `input.reference`. */
  createContact(input: AccountingContactInput): Promise<string>;
  /** Updates the contact `ref`, and stores the reference on it if it has none. */
  updateContact(input: AccountingContactInput & { ref: string }): Promise<string>;
  postSummary(input: AccountingSummaryInput): Promise<string>;
  postTransfer(input: AccountingTransferInput): Promise<string>;
  postInvoice(input: AccountingDocumentInput): Promise<string>;
  postCreditNote(input: AccountingDocumentInput): Promise<string>;
  postPayment(input: AccountingMoneyInput): Promise<string>;
  postRefund(input: AccountingMoneyInput): Promise<string>;
  /** Voids the document `ref`. Called only for one `applyWrite` found by the host's reference. */
  voidDocument(ref: string): Promise<void>;
}
