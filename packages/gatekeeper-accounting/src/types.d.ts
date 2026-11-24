// The accounting contract (stage 61, ADR 0880): the session every accounting gatekeeper serves,
// whatever system keeps the books. Only the host calls it, for the books a human admin connected.
// Amounts are integers in minor units of the books' base currency; dates are `YYYY-MM-DD`. The host
// writes every entry with its own reference (`cos:…`), and the books never lose it, so an entry is
// found again by that reference and never written twice. There is no delete and no edit of a
// posted entry: a mistake is put right by a new entry, or by voiding a document the host posted.

/** What kind of account a books account is. Never its bank account number. */
export type AccountingAccountType =
  | "revenue"
  | "expense"
  | "bank"
  | "current_asset"
  | "current_liability"
  | "equity"
  | "other";

/** The books as a whole. */
export interface AccountingBooks {
  name: string;
  /** ISO 4217, upper case. Entries in any other currency are refused. */
  baseCurrency: string;
  /** Nothing may be dated on or before this day. `null`: the books are not locked. */
  lockDate: string | null;
  /** Whether the books' own prices are stored with tax included or without. */
  pricesIncludeTax: boolean;
}

export interface AccountingAccount {
  /** The books' own id: what every entry names. */
  ref: string;
  code: string | null;
  name: string;
  type: AccountingAccountType;
  archived: boolean;
}

export interface AccountingTaxRate {
  ref: string;
  name: string;
  /** In hundredths of a percent: 1000 is 10%. */
  rate: number;
  archived: boolean;
}

/** What a contact is looked up by. At least one key; each matches exactly, name by the books' own search. */
export interface AccountingContactQuery {
  reference?: string;
  email?: string;
  taxNumber?: string;
  name?: string;
}

export interface AccountingContact {
  ref: string;
  name: string;
  email: string | null;
  taxNumber: string | null;
  archived: boolean;
  /** The host's reference (`cos:<object>:<id>`) when the host made it. */
  reference: string | null;
}

export interface AccountingAddress {
  lines: string[];
  city?: string;
  region?: string;
  postcode?: string;
  /** ISO 3166 alpha-2. */
  country?: string;
}

export type AccountingDocumentState = "open" | "paid" | "part_paid" | "void";

/** A payment the books hold on a document. */
export interface AccountingBooksPayment {
  ref: string;
  date: string;
  amount: number;
  /** The host's reference when the host sent it; `null` for one entered in the books. */
  reference: string | null;
}

export interface AccountingDocumentStatus {
  ref: string;
  status: AccountingDocumentState;
  amountDue: number;
  /** Payments recorded in the books that the host did not send. */
  paymentsNotSent: AccountingBooksPayment[];
}

export type AccountingRecordKind =
  | "contact"
  | "summary"
  | "transfer"
  | "invoice"
  | "credit_note"
  | "payment"
  | "refund";

/** A record the host wrote, found again by its reference. */
export interface AccountingRecord {
  ref: string;
  kind: AccountingRecordKind;
  reference: string;
  /** For a document: void once voided. */
  voided: boolean;
}

/** One line of a summary entry. Positive is a debit, negative a credit; the lines sum to zero. */
export interface AccountingSummaryLine {
  account: string;
  /** The tax rate the line's tax belongs to, or `null` for none. */
  taxRate: string | null;
  net: number;
  tax: number;
  text: string;
}

/** A dated entry: the daily summary of card sales, or a reopen adjustment. */
export interface AccountingSummaryInput {
  reference: string;
  currency: string;
  date: string;
  text: string;
  lines: AccountingSummaryLine[];
  /** Only where the system needs one on an entry. */
  contact?: string;
}

/** A movement out of the clearing account besides the payout itself: a fee, a fee refund, a dispute. */
export interface AccountingTransferLine {
  account: string;
  /** Positive takes money out of clearing into `account` (a fee); negative brings it back. */
  amount: number;
  text: string;
}

/** A payout: `amount` from the clearing account to the bank, with its fees and other lines. */
export interface AccountingTransferInput {
  reference: string;
  currency: string;
  date: string;
  text: string;
  clearingAccount: string;
  bankAccount: string;
  /** What arrived in the bank. May be negative (a payout that took money back). */
  amount: number;
  lines: AccountingTransferLine[];
}

export interface AccountingDocumentLine {
  text: string;
  account: string;
  taxRate: string | null;
  /** Up to four decimal places. */
  quantity: number;
  unitPrice: number;
  net: number;
  tax: number;
}

/** An invoice or a credit note, under one contact. */
export interface AccountingDocumentInput {
  reference: string;
  currency: string;
  number: string;
  contact: string;
  issueDate: string;
  dueDate: string;
  lines: AccountingDocumentLine[];
}

/** Money against one document the host posted: into an account (a payment) or out of it (a refund). */
export interface AccountingMoneyInput {
  reference: string;
  currency: string;
  /** The books' ref of the document. */
  document: string;
  /** The account the money went into or came out of. */
  account: string;
  date: string;
  /** Positive. */
  amount: number;
  text: string;
}

/** A contact the host makes (`ref` absent) or one it linked earlier and updates (`ref`). */
export interface AccountingContactInput {
  reference: string;
  ref?: string;
  name: string;
  email?: string;
  taxNumber?: string;
  address?: AccountingAddress;
}

/** Voids a document the host posted: its reference and the books' ref must belong together. */
export interface AccountingVoidInput {
  reference: string;
  ref: string;
  reason: string;
}

/**
 * What a write did. `sent`: in the books, `ref` is the books' record. `pending`: waiting for a
 * person (a void always does), `ref` is `null`. `id` is the gatekeeper's action id.
 */
export interface AccountingReceipt {
  status: "sent" | "pending";
  id: number;
  ref: string | null;
}

/**
 * Why a write was refused with nothing written, at the start of the error's message as
 * `[accounting:<code>] `. An error without one may have gone through: look the reference up.
 */
export type AccountingRefusalCode =
  | "unmapped"
  | "locked_period"
  | "invalid"
  | "duplicate_number"
  | "contact_archived"
  | "rate_limited"
  | "unavailable";

export interface AccountingSession {
  /** Reads (observations). */
  describeBooks(): Promise<AccountingBooks>;
  listAccounts(): Promise<AccountingAccount[]>;
  listTaxRates(): Promise<AccountingTaxRate[]>;
  /** At most 10 candidates. */
  findContacts(query: AccountingContactQuery): Promise<AccountingContact[]>;
  /** For documents the host posted; at most 100 refs a call. */
  documentStatus(refs: string[]): Promise<AccountingDocumentStatus[]>;
  findByReference(reference: string): Promise<AccountingRecord | null>;

  /** Writes (outbound actions, journalled). `accounting.contact`. */
  upsertContact(input: AccountingContactInput): Promise<AccountingReceipt>;
  /** `accounting.post`. */
  postSummary(input: AccountingSummaryInput): Promise<AccountingReceipt>;
  postTransfer(input: AccountingTransferInput): Promise<AccountingReceipt>;
  postInvoice(input: AccountingDocumentInput): Promise<AccountingReceipt>;
  postCreditNote(input: AccountingDocumentInput): Promise<AccountingReceipt>;
  postPayment(input: AccountingMoneyInput): Promise<AccountingReceipt>;
  postRefund(input: AccountingMoneyInput): Promise<AccountingReceipt>;
  /** `accounting.void`: always reviewed by a person. */
  voidDocument(input: AccountingVoidInput): Promise<AccountingReceipt>;
}
