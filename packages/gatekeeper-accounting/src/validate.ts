// Input guards for every session input (ADR 0114: no capnweb-validate decorators, every RPC input
// checked by hand). Each parser copies the known keys into a fresh object and refuses anything
// else as `invalid`, so what is journalled, described to a person and sent is exactly what was
// checked. Limits are the contract's, the same for every accounting system.

import { refuse } from "./refusal.js";
import type {
  AccountingAddress,
  AccountingContactInput,
  AccountingContactQuery,
  AccountingDocumentInput,
  AccountingDocumentLine,
  AccountingMoneyInput,
  AccountingSummaryInput,
  AccountingSummaryLine,
  AccountingTransferInput,
  AccountingTransferLine,
  AccountingVoidInput,
} from "./types.js";

/** `cos:<kind>:<id>[:<n>…]`: the host's reference on everything it writes. */
const REFERENCE = /^cos:[a-z][a-z0-9_]{0,30}(:[A-Za-z0-9_-]{1,64}){1,3}$/;
const MAX_REFERENCE = 100;
/** A books ref: whatever the system's ids are, printable and without spaces. */
const REF = /^[\x21-\x7e]{1,255}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Deliberately loose: the books validate the address; this only keeps out what is plainly not one.
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{1,63}$/;
const COUNTRY = /^[A-Z]{2}$/;
/** Well inside a safe integer, and more than any business's day. */
const MAX_AMOUNT = 1e13;

export const MAX_SUMMARY_LINES = 500;
export const MAX_DOCUMENT_LINES = 200;
export const MAX_TRANSFER_LINES = 200;
export const MAX_STATUS_REFS = 100;
export const MAX_CONTACT_CANDIDATES = 10;

function invalid(message: string): never {
  throw refuse("invalid", message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) invalid(`${what} has unknown key(s): ${extra.slice(0, 5).join(", ")}.`);
}

function text(value: unknown, what: string, max: number, min = 1): string {
  if (typeof value !== "string") invalid(`${what} must be a string.`);
  // Control characters other than tab and newline would hide text from the person approving.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is what is refused.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) invalid(`${what} has control characters.`);
  if (value.length < min || value.length > max) {
    invalid(`${what} must be ${min} to ${max} characters.`);
  }
  return value;
}

function optionalText(value: unknown, what: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, what, max);
}

export function parseReference(value: unknown, what = "reference"): string {
  if (typeof value !== "string" || value.length > MAX_REFERENCE || !REFERENCE.test(value)) {
    invalid(
      `${what} must be the host's reference, cos:<kind>:<id>, at most ${MAX_REFERENCE} characters.`,
    );
  }
  return value;
}

export function parseRef(value: unknown, what: string): string {
  if (typeof value !== "string" || !REF.test(value)) invalid(`${what} must be a books ref.`);
  return value;
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !CURRENCY.test(value)) {
    invalid("currency must be an ISO 4217 code in upper case.");
  }
  return value;
}

/** A real calendar day, `YYYY-MM-DD`. */
export function parseDate(value: unknown, what: string): string {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) invalid(`${what} must be a date, YYYY-MM-DD.`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) {
    invalid(`${what} is not a day of the calendar.`);
  }
  return value as string;
}

function amount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT) {
    invalid(`${what} must be a whole number of minor units.`);
  }
  return value;
}

function positive(value: unknown, what: string): number {
  const n = amount(value, what);
  if (n <= 0) invalid(`${what} must be more than zero.`);
  return n;
}

function quantity(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e9) {
    invalid(`${what} must be more than zero.`);
  }
  const scaled = value * 10_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) invalid(`${what} has more than 4 decimals.`);
  return value;
}

function list(value: unknown, what: string, max: number, min = 1): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(`${what} must be a list of ${min} to ${max}.`);
  }
  return value;
}

function taxRate(value: unknown, what: string): string | null {
  return value === null ? null : parseRef(value, what);
}

function summaryLine(value: unknown, i: number): AccountingSummaryLine {
  const what = `lines[${i}]`;
  const line = record(value, what);
  onlyKeys(line, ["account", "taxRate", "net", "tax", "text"], what);
  return {
    account: parseRef(line.account, `${what}.account`),
    taxRate: taxRate(line.taxRate, `${what}.taxRate`),
    net: amount(line.net, `${what}.net`),
    tax: amount(line.tax, `${what}.tax`),
    text: text(line.text, `${what}.text`, 500),
  };
}

/** A dated entry whose lines balance: debits positive, credits negative, summing to zero. */
export function parseSummaryInput(value: unknown): AccountingSummaryInput {
  const input = record(value, "The summary");
  onlyKeys(input, ["reference", "currency", "date", "text", "lines", "contact"], "The summary");
  const lines = list(input.lines, "lines", MAX_SUMMARY_LINES, 2).map(summaryLine);
  const sum = lines.reduce((total, line) => total + line.net + line.tax, 0);
  if (sum !== 0) invalid(`The lines do not balance: they sum to ${sum}, not 0.`);
  if (lines.some((line) => line.tax !== 0 && line.taxRate === null)) {
    invalid("A line with tax must name its tax rate.");
  }
  return {
    reference: parseReference(input.reference),
    currency: currency(input.currency),
    date: parseDate(input.date, "date"),
    text: text(input.text, "text", 500),
    lines,
    ...(input.contact === undefined ? {} : { contact: parseRef(input.contact, "contact") }),
  };
}

function transferLine(value: unknown, i: number): AccountingTransferLine {
  const what = `lines[${i}]`;
  const line = record(value, what);
  onlyKeys(line, ["account", "amount", "text"], what);
  const n = amount(line.amount, `${what}.amount`);
  if (n === 0) invalid(`${what}.amount must not be zero.`);
  return {
    account: parseRef(line.account, `${what}.account`),
    amount: n,
    text: text(line.text, `${what}.text`, 500),
  };
}

export function parseTransferInput(value: unknown): AccountingTransferInput {
  const input = record(value, "The transfer");
  onlyKeys(
    input,
    ["reference", "currency", "date", "text", "clearingAccount", "bankAccount", "amount", "lines"],
    "The transfer",
  );
  const clearingAccount = parseRef(input.clearingAccount, "clearingAccount");
  const bankAccount = parseRef(input.bankAccount, "bankAccount");
  if (clearingAccount === bankAccount) invalid("The clearing and bank accounts must differ.");
  const lines = list(input.lines, "lines", MAX_TRANSFER_LINES, 0).map(transferLine);
  const n = amount(input.amount, "amount");
  if (n === 0 && lines.length === 0) invalid("A transfer moves something.");
  return {
    reference: parseReference(input.reference),
    currency: currency(input.currency),
    date: parseDate(input.date, "date"),
    text: text(input.text, "text", 500),
    clearingAccount,
    bankAccount,
    amount: n,
    lines,
  };
}

function documentLine(value: unknown, i: number): AccountingDocumentLine {
  const what = `lines[${i}]`;
  const line = record(value, what);
  onlyKeys(line, ["text", "account", "taxRate", "quantity", "unitPrice", "net", "tax"], what);
  const parsed = {
    text: text(line.text, `${what}.text`, 500),
    account: parseRef(line.account, `${what}.account`),
    taxRate: taxRate(line.taxRate, `${what}.taxRate`),
    quantity: quantity(line.quantity, `${what}.quantity`),
    unitPrice: amount(line.unitPrice, `${what}.unitPrice`),
    net: amount(line.net, `${what}.net`),
    tax: amount(line.tax, `${what}.tax`),
  };
  if (parsed.tax !== 0 && parsed.taxRate === null) invalid(`${what} has tax but no tax rate.`);
  return parsed;
}

/** An invoice or a credit note: what the customer owes, or is credited, in total more than zero. */
export function parseDocumentInput(value: unknown): AccountingDocumentInput {
  const input = record(value, "The document");
  onlyKeys(
    input,
    ["reference", "currency", "number", "contact", "issueDate", "dueDate", "lines"],
    "The document",
  );
  const lines = list(input.lines, "lines", MAX_DOCUMENT_LINES).map(documentLine);
  if (lines.reduce((total, line) => total + line.net + line.tax, 0) <= 0) {
    invalid("A document's total must be more than zero.");
  }
  const issueDate = parseDate(input.issueDate, "issueDate");
  const dueDate = parseDate(input.dueDate, "dueDate");
  if (dueDate < issueDate) invalid("dueDate is before issueDate.");
  return {
    reference: parseReference(input.reference),
    currency: currency(input.currency),
    number: text(input.number, "number", 50),
    contact: parseRef(input.contact, "contact"),
    issueDate,
    dueDate,
    lines,
  };
}

export function parseMoneyInput(value: unknown): AccountingMoneyInput {
  const input = record(value, "The payment");
  onlyKeys(
    input,
    ["reference", "currency", "document", "account", "date", "amount", "text"],
    "The payment",
  );
  return {
    reference: parseReference(input.reference),
    currency: currency(input.currency),
    document: parseRef(input.document, "document"),
    account: parseRef(input.account, "account"),
    date: parseDate(input.date, "date"),
    amount: positive(input.amount, "amount"),
    text: text(input.text, "text", 500),
  };
}

function address(value: unknown): AccountingAddress {
  const input = record(value, "address");
  onlyKeys(input, ["lines", "city", "region", "postcode", "country"], "address");
  const lines = list(input.lines, "address.lines", 4, 0).map((line, i) =>
    text(line, `address.lines[${i}]`, 200),
  );
  const out: AccountingAddress = { lines };
  const city = optionalText(input.city, "address.city", 100);
  const region = optionalText(input.region, "address.region", 100);
  const postcode = optionalText(input.postcode, "address.postcode", 20);
  if (city !== undefined) out.city = city;
  if (region !== undefined) out.region = region;
  if (postcode !== undefined) out.postcode = postcode;
  if (input.country !== undefined) {
    if (typeof input.country !== "string" || !COUNTRY.test(input.country)) {
      invalid("address.country must be an ISO 3166 alpha-2 code in upper case.");
    }
    out.country = input.country;
  }
  return out;
}

function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) {
    invalid("email is not an email address.");
  }
  return value;
}

export function parseContactInput(value: unknown): AccountingContactInput {
  const input = record(value, "The contact");
  onlyKeys(input, ["reference", "ref", "name", "email", "taxNumber", "address"], "The contact");
  const out: AccountingContactInput = {
    reference: parseReference(input.reference),
    name: text(input.name, "name", 255),
  };
  if (input.ref !== undefined) out.ref = parseRef(input.ref, "ref");
  if (input.email !== undefined) out.email = email(input.email);
  if (input.taxNumber !== undefined) out.taxNumber = text(input.taxNumber, "taxNumber", 50);
  if (input.address !== undefined) out.address = address(input.address);
  return out;
}

export function parseContactQuery(value: unknown): AccountingContactQuery {
  const input = record(value, "The query");
  onlyKeys(input, ["reference", "email", "taxNumber", "name"], "The query");
  const out: AccountingContactQuery = {};
  if (input.reference !== undefined) out.reference = parseReference(input.reference);
  if (input.email !== undefined) out.email = email(input.email);
  if (input.taxNumber !== undefined) out.taxNumber = text(input.taxNumber, "taxNumber", 50);
  if (input.name !== undefined) out.name = text(input.name, "name", 255);
  if (Object.keys(out).length === 0) invalid("Look a contact up by at least one key.");
  return out;
}

export function parseStatusRefs(value: unknown): string[] {
  const refs = list(value, "refs", MAX_STATUS_REFS).map((ref, i) => parseRef(ref, `refs[${i}]`));
  if (new Set(refs).size !== refs.length) invalid("refs has a ref twice.");
  return refs;
}

export function parseVoidInput(value: unknown): AccountingVoidInput {
  const input = record(value, "The void");
  onlyKeys(input, ["reference", "ref", "reason"], "The void");
  return {
    reference: parseReference(input.reference),
    ref: parseRef(input.ref, "ref"),
    reason: text(input.reason, "reason", 500),
  };
}
