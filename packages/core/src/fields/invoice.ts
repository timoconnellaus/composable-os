// Field registry for Quote, Invoice and Credit note (stage 35, ADR 0730): base records in core,
// beside Order. Names match the keys of the quote.* and invoice.* operations; the columns are
// their rec_* views', which carry numbers, states, dates, amounts and the bill-to's ids, never an
// address, a tax number, the notes or the business's bank details.
//
// Staff only for now: no customer or public declaration. A customer reading their own documents
// (and their organisation's as its named contact) is stage 35 step 8, a reviewed change (ADR
// 0402). Their states are not a machine the transition engine holds: a draft is written by its
// operations, every later move is host code's (issue, send, the order's move hook), and the
// database refuses a sent or issued document going back to a draft (migration 1030).
import { defineObject } from "./types.ts";

export const QUOTE_STATES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];

export const INVOICE_STATES = [
  "draft",
  "issued",
  "sent",
  "part_paid",
  "paid",
  "credited",
  "void",
] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const INVOICE_KINDS = ["standard", "deposit", "final"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const CREDIT_NOTE_STATES = ["draft", "issued"] as const;

export const TAX_MODES = ["exclusive", "inclusive"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

const LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  withdrawn: "Withdrawn",
  issued: "Issued",
  part_paid: "Part paid",
  paid: "Paid",
  credited: "Credited",
  void: "Void",
  standard: "Standard",
  deposit: "Deposit",
  final: "Final",
  exclusive: "Amounts without tax",
  inclusive: "Amounts with tax",
};

const id = { type: "id", filterable: true, sortable: false } as const;
const amount = { type: "number", filterable: true, sortable: true } as const;
const when = { type: "datetime", filterable: true, sortable: true } as const;
const day = { type: "date", filterable: true, sortable: true } as const;
const text = (name: string, label: string, column: string) =>
  ({ name, label, type: "text", column, filterable: true, sortable: false }) as const;
const choice = (name: string, label: string, column: string, values: readonly string[]) =>
  ({
    name,
    label,
    type: "enum",
    enumValues: values,
    column,
    filterable: true,
    sortable: true,
    options: { choices: values.map((value) => ({ value, label: LABELS[value] ?? value })) },
  }) as const;
const person = {
  ...id,
  name: "personId",
  label: "Person",
  column: "person_id",
  fieldType: "relation",
  options: { to: "person" },
} as const;
const organisation = {
  ...id,
  name: "organisationId",
  label: "Organisation",
  column: "organisation_id",
  fieldType: "relation",
  options: { to: "organisation" },
} as const;
const totals = [
  { ...amount, name: "netTotal", label: "Net", column: "net_total" },
  { ...amount, name: "taxTotal", label: "Tax", column: "tax_total" },
  { ...amount, name: "total", label: "Total", column: "total" },
] as const;
const stamps = [
  { ...when, name: "createdAt", label: "Created", column: "created_at" },
  { ...when, name: "updatedAt", label: "Updated", column: "updated_at" },
] as const;

export const quoteObject = defineObject({
  name: "quote",
  label: "Quote",
  plural: "Quotes",
  source: "rec_quote",
  titleField: "number",
  defaultSort: { field: "createdAt", direction: "desc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    text("number", "Number", "number"),
    choice("state", "State", "state", QUOTE_STATES),
    text("currency", "Currency", "currency"),
    choice("taxMode", "Amounts", "tax_mode", TAX_MODES),
    person,
    organisation,
    text("aboutObject", "About (object)", "about_object"),
    { ...id, name: "aboutId", label: "About", column: "about_id" },
    { ...day, name: "validUntil", label: "Valid until", column: "valid_until" },
    choice("depositKind", "Deposit", "deposit_kind", ["none", "amount", "percent"]),
    { ...amount, name: "depositValue", label: "Deposit value", column: "deposit_value" },
    ...totals,
    { ...id, name: "replacesQuoteId", label: "Replaces", column: "replaces_quote_id" },
    { ...when, name: "sentAt", label: "Sent", column: "sent_at" },
    { ...when, name: "acceptedAt", label: "Accepted", column: "accepted_at" },
    { ...when, name: "declinedAt", label: "Declined", column: "declined_at" },
    { ...when, name: "withdrawnAt", label: "Withdrawn", column: "withdrawn_at" },
    { ...when, name: "expiredAt", label: "Expired", column: "expired_at" },
    ...stamps,
  ],
});

export const invoiceObject = defineObject({
  name: "invoice",
  label: "Invoice",
  plural: "Invoices",
  source: "rec_invoice",
  titleField: "number",
  defaultSort: { field: "createdAt", direction: "desc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    text("number", "Number", "number"),
    choice("state", "State", "state", INVOICE_STATES),
    choice("kind", "Kind", "kind", INVOICE_KINDS),
    text("currency", "Currency", "currency"),
    choice("taxMode", "Amounts", "tax_mode", TAX_MODES),
    person,
    organisation,
    text("aboutObject", "About (object)", "about_object"),
    { ...id, name: "aboutId", label: "About", column: "about_id" },
    { ...id, name: "quoteId", label: "Quote", column: "quote_id" },
    { ...id, name: "orderId", label: "Order", column: "order_id" },
    {
      ...amount,
      name: "paymentTermsDays",
      label: "Payment terms (days)",
      column: "payment_terms_days",
    },
    { ...day, name: "issuedOn", label: "Issued on", column: "issued_on" },
    { ...day, name: "dueOn", label: "Due", column: "due_on" },
    { ...when, name: "issuedAt", label: "Issued", column: "issued_at" },
    { ...when, name: "sentAt", label: "Sent", column: "sent_at" },
    {
      name: "allowPartPayments",
      label: "Part payments online",
      type: "boolean",
      column: "allow_part_payments",
      filterable: true,
      sortable: false,
    },
    {
      name: "remindersPaused",
      label: "Reminders paused",
      type: "boolean",
      column: "reminders_paused",
      filterable: true,
      sortable: false,
    },
    ...totals,
    ...stamps,
  ],
});

export const creditNoteObject = defineObject({
  name: "creditNote",
  label: "Credit note",
  plural: "Credit notes",
  source: "rec_credit_note",
  titleField: "number",
  defaultSort: { field: "createdAt", direction: "desc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    text("number", "Number", "number"),
    choice("state", "State", "state", CREDIT_NOTE_STATES),
    { ...id, name: "invoiceId", label: "Invoice", column: "invoice_id" },
    text("currency", "Currency", "currency"),
    choice("taxMode", "Amounts", "tax_mode", TAX_MODES),
    person,
    organisation,
    choice("settle", "Settles by", "settle", ["reduce", "refund", "both"]),
    { ...day, name: "issuedOn", label: "Issued on", column: "issued_on" },
    { ...when, name: "issuedAt", label: "Issued", column: "issued_at" },
    ...totals,
    ...stamps,
  ],
});
