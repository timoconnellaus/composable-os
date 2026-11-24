// What a person reads about each write before it goes, and what the audit keeps (ADR 0880): the
// kind, the date, every line with its account and amount, and the host's reference. The host's
// outbox shows the same entry with its accounts by name; this is the gatekeeper's own account of
// what it will send, in the books' refs.

import { buildDescription, sanitizeTitle } from "@composable-os/gatekeeper-kit/action-description";
import type { ActionPresentation } from "@composable-os/gatekeeper-kit/actions";
import type { AccountingWrite } from "./apply.js";
import { formatMinor } from "./money.js";

/** One write as journalled: the books it goes to (the system's title) and the write. */
export type StoredWrite = { books: string; write: AccountingWrite };

function tax(rate: string | null, amount: number, currency: string): string {
  return rate === null ? "no tax" : `tax ${formatMinor(amount, currency)} at ${rate}`;
}

export function describeWrite({ books, write }: StoredWrite): ActionPresentation {
  switch (write.kind) {
    case "contact": {
      const { input } = write;
      const builder = buildDescription(
        input.ref === undefined
          ? `Creates the contact ${input.name} in ${books}.`
          : `Updates contact ${input.ref} in ${books}: its name, email, address and tax number.`,
      )
        .inline("Books", books)
        .inline("Name", input.name)
        .inline("Email", input.email ?? "none")
        .inline("Tax number", input.taxNumber ?? "none")
        .inline("Reference", input.reference);
      if (input.address) {
        builder.list("Address", [
          ...input.address.lines,
          ...[input.address.city, input.address.region, input.address.postcode].filter(
            (part): part is string => part !== undefined,
          ),
          ...(input.address.country ? [input.address.country] : []),
        ]);
      }
      return {
        title: sanitizeTitle(
          input.ref === undefined ? `Create contact ${input.name}` : `Update contact ${input.name}`,
        ),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
    case "summary": {
      const { input } = write;
      const debits = input.lines.reduce((sum, l) => sum + Math.max(0, l.net + l.tax), 0);
      const builder = buildDescription(
        `Posts an entry dated ${input.date} to ${books}: ${input.lines.length} lines, ` +
          `${formatMinor(debits, input.currency)} each side. Nothing already in the books changes.`,
      )
        .inline("Books", books)
        .inline("Date", input.date)
        .verbatim("Text", input.text)
        .list(
          "Lines (debits positive, credits negative)",
          input.lines.map(
            (l) =>
              `${l.account}: ${formatMinor(l.net, input.currency)}, ` +
              `${tax(l.taxRate, l.tax, input.currency)}: ${l.text}`,
          ),
        )
        .inline("Reference", input.reference);
      return {
        title: sanitizeTitle(`Post the entry of ${input.date}`),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
    case "transfer": {
      const { input } = write;
      const builder = buildDescription(
        `Posts a payout dated ${input.date} to ${books}: ${formatMinor(input.amount, input.currency)} ` +
          `from ${input.clearingAccount} to the bank account ${input.bankAccount}, and ` +
          `${input.lines.length} other line(s) from ${input.clearingAccount}.`,
      )
        .inline("Books", books)
        .inline("Date", input.date)
        .verbatim("Text", input.text)
        .inline("To the bank", formatMinor(input.amount, input.currency))
        .list(
          "Other lines",
          input.lines.map(
            (l) => `${l.account}: ${formatMinor(l.amount, input.currency)}: ${l.text}`,
          ),
        )
        .inline("Reference", input.reference);
      return {
        title: sanitizeTitle(
          `Post a payout of ${formatMinor(input.amount, input.currency)} on ${input.date}`,
        ),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
    case "invoice":
    case "credit_note": {
      const { input } = write;
      const what = write.kind === "invoice" ? "invoice" : "credit note";
      const total = input.lines.reduce((sum, l) => sum + l.net + l.tax, 0);
      const builder = buildDescription(
        `Posts ${what} ${input.number} to ${books} for contact ${input.contact}: ` +
          `${formatMinor(total, input.currency)} in all, issued ${input.issueDate}, due ${input.dueDate}.`,
      )
        .inline("Books", books)
        .inline("Number", input.number)
        .inline("Contact", input.contact)
        .inline("Total", formatMinor(total, input.currency))
        .list(
          "Lines",
          input.lines.map(
            (l) =>
              `${l.quantity} × ${formatMinor(l.unitPrice, input.currency)} to ${l.account}: ` +
              `${formatMinor(l.net, input.currency)}, ${tax(l.taxRate, l.tax, input.currency)}: ${l.text}`,
          ),
        )
        .inline("Reference", input.reference);
      return {
        title: sanitizeTitle(`Post ${what} ${input.number}`),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
    case "payment":
    case "refund": {
      const { input } = write;
      const amount = formatMinor(input.amount, input.currency);
      const builder = buildDescription(
        write.kind === "payment"
          ? `Posts a payment of ${amount} on ${input.date} against document ${input.document} in ` +
              `${books}, into account ${input.account}.`
          : `Posts a refund of ${amount} on ${input.date} against document ${input.document} in ` +
              `${books}, out of account ${input.account}.`,
      )
        .inline("Books", books)
        .inline("Document", input.document)
        .inline("Account", input.account)
        .inline("Amount", amount)
        .verbatim("Text", input.text)
        .inline("Reference", input.reference);
      return {
        title: sanitizeTitle(
          `Post a ${write.kind} of ${amount} against document ${input.document}`,
        ),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
    case "void": {
      const { input } = write;
      const builder = buildDescription(
        `Voids document ${input.ref} in ${books}, which the host posted as ${input.reference}. ` +
          "It stays in the books, marked void; nothing is deleted.",
      )
        .inline("Books", books)
        .inline("Document", input.ref)
        .inline("Reference", input.reference)
        .verbatim("Reason", input.reason);
      return {
        title: sanitizeTitle(`Void document ${input.ref}`),
        ...builder.finish(),
        implementsRevert: false,
      };
    }
  }
}
