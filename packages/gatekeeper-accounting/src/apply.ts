// What every accounting gatekeeper does when a write is applied, whatever its system (ADR 0880):
// the books' currency and lock date are read first, so an entry in another currency or dated
// inside the lock is refused with nothing written; a reference already in the books writes
// nothing and answers that record's ref, so a write sent again (after an uncertain outcome, or a
// crash between the books' answer and the host recording it) is never written twice; and a void
// is applied only to a document the host's own reference finds.

import { refuse } from "./refusal.js";
import type { AccountingSystem } from "./system.js";
import type {
  AccountingContactInput,
  AccountingDocumentInput,
  AccountingMoneyInput,
  AccountingSummaryInput,
  AccountingTransferInput,
  AccountingVoidInput,
} from "./types.js";

/** One write, as journalled: its kind and its checked input. */
export type AccountingWrite =
  | { kind: "contact"; input: AccountingContactInput }
  | { kind: "summary"; input: AccountingSummaryInput }
  | { kind: "transfer"; input: AccountingTransferInput }
  | { kind: "invoice"; input: AccountingDocumentInput }
  | { kind: "credit_note"; input: AccountingDocumentInput }
  | { kind: "payment"; input: AccountingMoneyInput }
  | { kind: "refund"; input: AccountingMoneyInput }
  | { kind: "void"; input: AccountingVoidInput };

/** The day a write carries, which the lock date is compared with. Contacts and voids carry none. */
export function writeDate(write: AccountingWrite): string | null {
  switch (write.kind) {
    case "contact":
    case "void":
      return null;
    case "invoice":
    case "credit_note":
      return write.input.issueDate;
    default:
      return write.input.date;
  }
}

function writeCurrency(write: AccountingWrite): string | null {
  return write.kind === "contact" || write.kind === "void" ? null : write.input.currency;
}

/** Applies one write to the books; returns the books' ref of the record it names. */
export async function applyWrite(
  system: AccountingSystem,
  write: AccountingWrite,
): Promise<string> {
  const books = await system.describeBooks();
  const currency = writeCurrency(write);
  if (currency !== null && currency !== books.baseCurrency) {
    throw refuse(
      "invalid",
      `The books keep ${books.baseCurrency}; this entry is in ${currency}. Nothing was written.`,
    );
  }
  const date = writeDate(write);
  if (date !== null && books.lockDate !== null && date <= books.lockDate) {
    throw refuse(
      "locked_period",
      `The books are locked to ${books.lockDate}; this entry is dated ${date}. Nothing was written.`,
    );
  }

  const existing = await system.findByReference(write.input.reference);
  if (write.kind === "void") {
    const isDocument = existing?.kind === "invoice" || existing?.kind === "credit_note";
    if (!existing || !isDocument || existing.ref !== write.input.ref) {
      throw refuse(
        "invalid",
        `${write.input.ref} is not a document the host posted as ${write.input.reference}: only ` +
          "those may be voided. Nothing was voided.",
      );
    }
    if (!existing.voided) await system.voidDocument(existing.ref);
    return existing.ref;
  }
  if (write.kind === "contact" && write.input.ref !== undefined) {
    // A linked contact the host updates: the same reference every time, so it is not a repeat.
    if (existing && existing.ref !== write.input.ref) {
      throw refuse(
        "invalid",
        `${write.input.reference} is already on contact ${existing.ref}, not ${write.input.ref}.`,
      );
    }
    return system.updateContact({ ...write.input, ref: write.input.ref });
  }
  // Written before: nothing is written again.
  if (existing) {
    if (existing.kind !== write.kind) {
      throw refuse(
        "invalid",
        `${write.input.reference} is already on a ${existing.kind} in the books, not a ${write.kind}.`,
      );
    }
    return existing.ref;
  }
  switch (write.kind) {
    case "contact":
      return system.createContact(write.input);
    case "summary":
      return system.postSummary(write.input);
    case "transfer":
      return system.postTransfer(write.input);
    case "invoice":
      return system.postInvoice(write.input);
    case "credit_note":
      return system.postCreditNote(write.input);
    case "payment":
      return system.postPayment(write.input);
    case "refund":
      return system.postRefund(write.input);
  }
}
