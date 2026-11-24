// The conformance suite every accounting gatekeeper passes (stage 61, ADR 0880): each read and
// write of the contract, the host's reference stored and found again, a reference never written
// twice, no delete and no edit, a void only of a document the host posted and only once a person
// approves it, another currency and a locked day refused. It runs against any target: the fake in
// memory, the fake gatekeeper through its session, and a real system's gatekeeper against a test
// organisation, by hand with a person's account. It writes real entries there (each referenced
// `cos:conformance:<run>:…`), so never run it against a business's books. Checks that need the
// fake's controls (a lost answer, the bookkeeper's own entries) are skipped without them.

import type { FakeFailure, FakeWriteMethod } from "./fake.js";
import { refusalCode } from "./refusal.js";
import type {
  AccountingAccount,
  AccountingBooks,
  AccountingDocumentInput,
  AccountingRefusalCode,
  AccountingSession,
  AccountingSummaryInput,
  AccountingTaxRate,
} from "./types.js";

/** What the fake lets a test do to its books. A real system has none. */
export interface ConformanceControl {
  failNext(method: FakeWriteMethod, failure: FakeFailure): Promise<void>;
  writesOf(reference: string): Promise<number>;
  setLockDate(date: string | null): Promise<void>;
  recordPaymentInBooks(document: string, amount: number, date: string): Promise<string>;
  addInvoiceInBooks(contact: string, number: string, total: number, date: string): Promise<string>;
}

/**
 * What the suite drives. A write resolves to its receipt once applied, or rejects with the
 * gatekeeper's message (a refusal's `[accounting:<code>]` in it); a void resolves `pending`, and
 * `approve` applies it as a person approving would.
 */
export interface ConformanceTarget {
  session: AccountingSession;
  approve(id: number): Promise<void>;
  control?: ConformanceControl;
}

export interface ConformanceOptions {
  /** Unique to this run, `[A-Za-z0-9]{1,20}`: every reference and number carries it. */
  run: string;
  /** An open day to date entries on (after any lock date). Defaults to today (UTC). */
  date?: string;
}

export type ConformanceResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
};

type Context = {
  target: ConformanceTarget;
  session: AccountingSession;
  books: AccountingBooks;
  revenue: AccountingAccount;
  clearing: AccountingAccount;
  bank: AccountingAccount;
  fees: AccountingAccount;
  rate: AccountingTaxRate;
  date: string;
  /** A fresh host reference for this check. */
  reference(label: string): string;
  /** A fresh document number for this check. */
  number(): string;
};

export type ConformanceCheck = {
  name: string;
  /** Needs the fake's controls: skipped against a real system. */
  needsControl?: boolean;
  run(ctx: Context, control: ConformanceControl): Promise<void>;
};

class Skip extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

/** The write failed; its refusal code (or `null` for a failure that may have gone through). */
async function failure(promise: Promise<unknown>): Promise<AccountingRefusalCode | null> {
  try {
    await promise;
  } catch (error) {
    return refusalCode(error);
  }
  throw new Error("expected the write to fail, and it went through");
}

async function refused(promise: Promise<unknown>, code: AccountingRefusalCode, what: string) {
  same(await failure(promise), code, `${what}: the refusal's code`);
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** A balanced day: one sale of 10.00 plus its tax, to revenue, against clearing. */
function summary(ctx: Context, reference: string, date = ctx.date): AccountingSummaryInput {
  const tax = Math.round((1000 * ctx.rate.rate) / 10_000);
  return {
    reference,
    currency: ctx.books.baseCurrency,
    date,
    text: `Conformance ${reference}`,
    lines: [
      { account: ctx.clearing.ref, taxRate: null, net: 1000 + tax, tax: 0, text: "Card sales" },
      { account: ctx.revenue.ref, taxRate: ctx.rate.ref, net: -1000, tax: -tax, text: "Sales" },
    ],
  };
}

function document(ctx: Context, reference: string, contact: string): AccountingDocumentInput {
  const tax = Math.round((2000 * ctx.rate.rate) / 10_000);
  return {
    reference,
    currency: ctx.books.baseCurrency,
    number: ctx.number(),
    contact,
    issueDate: ctx.date,
    dueDate: addDays(ctx.date, 14),
    lines: [
      {
        text: "Room hire",
        account: ctx.revenue.ref,
        taxRate: ctx.rate.ref,
        quantity: 2,
        unitPrice: 1000,
        net: 2000,
        tax,
      },
    ],
  };
}

function total(input: AccountingDocumentInput): number {
  return input.lines.reduce((sum, line) => sum + line.net + line.tax, 0);
}

async function sent(receipt: Promise<{ status: string; ref: string | null }>, what: string) {
  const r = await receipt;
  same(r.status, "sent", `${what}: the receipt's status`);
  check(typeof r.ref === "string" && r.ref.length > 0, `${what}: the receipt names the books' ref`);
  return r.ref as string;
}

async function newContact(ctx: Context, label: string): Promise<string> {
  return sent(
    ctx.session.upsertContact({ reference: ctx.reference(label), name: `Conformance ${label}` }),
    "the contact",
  );
}

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    name: "describes the books: name, base currency, lock date and how prices are stored",
    async run({ books }) {
      check(typeof books.name === "string" && books.name.length > 0, "a name");
      check(/^[A-Z]{3}$/.test(books.baseCurrency), "an ISO 4217 base currency");
      check(
        books.lockDate === null || /^\d{4}-\d{2}-\d{2}$/.test(books.lockDate),
        "a lock date or none",
      );
      check(typeof books.pricesIncludeTax === "boolean", "whether prices include tax");
    },
  },
  {
    name: "lists accounts with the contract's fields only, never a bank account number",
    async run({ session }) {
      const accounts = await session.listAccounts();
      check(accounts.length > 0, "at least one account");
      const types = [
        "revenue",
        "expense",
        "bank",
        "current_asset",
        "current_liability",
        "equity",
        "other",
      ];
      for (const a of accounts) {
        same(
          Object.keys(a).sort(),
          ["archived", "code", "name", "ref", "type"],
          "an account's keys",
        );
        check(types.includes(a.type), `account ${a.ref} has a contract type`);
        check(typeof a.archived === "boolean", `account ${a.ref} says whether it is archived`);
      }
    },
  },
  {
    name: "lists tax rates in hundredths of a percent",
    async run({ session }) {
      for (const r of await session.listTaxRates()) {
        same(Object.keys(r).sort(), ["archived", "name", "rate", "ref"], "a tax rate's keys");
        check(Number.isInteger(r.rate) && r.rate >= 0 && r.rate <= 10_000, `rate ${r.ref}`);
      }
    },
  },
  {
    name: "creates a contact once, finds it by its reference, and updates it",
    async run(ctx) {
      const reference = ctx.reference("contact");
      const ref = await sent(
        ctx.session.upsertContact({ reference, name: "Conformance contact" }),
        "the contact",
      );
      same(
        (await ctx.session.findByReference(reference))?.ref,
        ref,
        "findByReference finds the contact",
      );
      const again = await sent(
        ctx.session.upsertContact({ reference, name: "Conformance contact" }),
        "the contact again",
      );
      same(again, ref, "the same reference makes no second contact");
      await sent(
        ctx.session.upsertContact({ reference, ref, name: "Conformance contact, renamed" }),
        "the update",
      );
      const found = await ctx.session.findContacts({ reference });
      same(
        found.map((c) => [c.ref, c.name, c.reference]),
        [[ref, "Conformance contact, renamed", reference]],
        "findContacts by reference",
      );
    },
  },
  {
    name: "finds contacts by email and by tax number, and needs a key to look one up",
    async run(ctx) {
      const email = `conformance-${ctx.number().toLowerCase()}@example.com`;
      const taxNumber = `99 ${ctx.number().replace(/\D/g, "").slice(-9) || "1"}`;
      const ref = await sent(
        ctx.session.upsertContact({
          reference: ctx.reference("contact"),
          name: "Conformance lookup",
          email,
          taxNumber,
        }),
        "the contact",
      );
      check(
        (await ctx.session.findContacts({ email })).some((c) => c.ref === ref),
        "found by email",
      );
      check(
        (await ctx.session.findContacts({ taxNumber })).some((c) => c.ref === ref),
        "found by tax number",
      );
      check((await ctx.session.findContacts({ name: "Conformance" })).length <= 10, "at most 10");
      await refused(ctx.session.findContacts({}), "invalid", "an empty query");
    },
  },
  {
    name: "posts a summary, finds it by its reference, and never writes it twice",
    async run(ctx, control) {
      const reference = ctx.reference("summary");
      const ref = await sent(ctx.session.postSummary(summary(ctx, reference)), "the summary");
      const found = await ctx.session.findByReference(reference);
      same([found?.ref, found?.kind], [ref, "summary"], "findByReference");
      same(
        await sent(ctx.session.postSummary(summary(ctx, reference)), "the summary again"),
        ref,
        "the same reference posts nothing new",
      );
      if (ctx.target.control) same(await control.writesOf(reference), 1, "writes at the books");
    },
  },
  {
    name: "refuses a summary whose lines do not balance",
    async run(ctx) {
      const input = summary(ctx, ctx.reference("summary"));
      input.lines[0] = { ...input.lines[0], net: (input.lines[0]?.net ?? 0) + 1 } as never;
      await refused(ctx.session.postSummary(input), "invalid", "an unbalanced summary");
      same(await ctx.session.findByReference(input.reference), null, "nothing in the books");
    },
  },
  {
    name: "refuses an entry in a currency that is not the books' own",
    async run(ctx) {
      const reference = ctx.reference("summary");
      const currency = ctx.books.baseCurrency === "USD" ? "EUR" : "USD";
      await refused(
        ctx.session.postSummary({ ...summary(ctx, reference), currency }),
        "invalid",
        "another currency",
      );
      same(await ctx.session.findByReference(reference), null, "nothing in the books");
    },
  },
  {
    name: "posts a payout as a transfer from clearing to the bank, with its fees",
    async run(ctx) {
      const reference = ctx.reference("payout");
      const ref = await sent(
        ctx.session.postTransfer({
          reference,
          currency: ctx.books.baseCurrency,
          date: ctx.date,
          text: `Conformance payout ${reference}`,
          clearingAccount: ctx.clearing.ref,
          bankAccount: ctx.bank.ref,
          amount: 9650,
          lines: [{ account: ctx.fees.ref, amount: 350, text: "Card fees" }],
        }),
        "the transfer",
      );
      const found = await ctx.session.findByReference(reference);
      same([found?.ref, found?.kind], [ref, "transfer"], "findByReference");
    },
  },
  {
    name: "posts an invoice, two payments, a credit note and its refund, each found by reference",
    async run(ctx) {
      const contact = await newContact(ctx, "customer");
      const invoice = document(ctx, ctx.reference("invoice"), contact);
      const doc = await sent(ctx.session.postInvoice(invoice), "the invoice");
      const due = total(invoice);
      same(
        (await ctx.session.documentStatus([doc])).map((s) => [s.status, s.amountDue]),
        [["open", due]],
        "the new invoice's status",
      );
      const money = (label: string, amount: number, document = doc) => ({
        reference: ctx.reference(label),
        currency: ctx.books.baseCurrency,
        document,
        account: ctx.bank.ref,
        date: ctx.date,
        amount,
        text: `Conformance ${label}`,
      });
      const first = money("payment", 1000);
      await sent(ctx.session.postPayment(first), "the first payment");
      same(
        (await ctx.session.documentStatus([doc])).map((s) => [s.status, s.amountDue]),
        [["part_paid", due - 1000]],
        "part paid",
      );
      await sent(ctx.session.postPayment(money("payment", due - 1000)), "the second payment");
      const status = (await ctx.session.documentStatus([doc]))[0];
      same([status?.status, status?.amountDue], ["paid", 0], "paid");
      same(status?.paymentsNotSent, [], "no payment the host did not send");
      same(
        (await ctx.session.findByReference(first.reference))?.kind,
        "payment",
        "the payment by reference",
      );
      const credit = { ...document(ctx, ctx.reference("credit"), contact) };
      const note = await sent(ctx.session.postCreditNote(credit), "the credit note");
      const refund = money("refund", total(credit), note);
      await sent(ctx.session.postRefund(refund), "the refund");
      same(
        (await ctx.session.findByReference(refund.reference))?.kind,
        "refund",
        "the refund by reference",
      );
      same(
        (await ctx.session.findByReference(credit.reference))?.kind,
        "credit_note",
        "the credit note by reference",
      );
    },
  },
  {
    name: "voids only a document the host posted, and only once a person approves",
    async run(ctx) {
      const contact = await newContact(ctx, "customer");
      const invoice = document(ctx, ctx.reference("invoice"), contact);
      const doc = await sent(ctx.session.postInvoice(invoice), "the invoice");
      const day = ctx.reference("summary");
      const entry = await sent(ctx.session.postSummary(summary(ctx, day)), "the summary");
      const reason = "Conformance: issued by mistake";
      // A reference the host never wrote, a document under another reference, an entry.
      await refused(
        approved(ctx, { reference: ctx.reference("nothing"), ref: doc, reason }),
        "invalid",
        "a void under a reference the host did not write",
      );
      await refused(
        approved(ctx, { reference: day, ref: entry, reason }),
        "invalid",
        "a void of an entry, not a document",
      );
      const receipt = await ctx.session.voidDocument({
        reference: invoice.reference,
        ref: doc,
        reason,
      });
      same([receipt.status, receipt.ref], ["pending", null], "a void waits for a person");
      same((await ctx.session.documentStatus([doc]))[0]?.status, "open", "not void until approved");
      await ctx.target.approve(receipt.id);
      same((await ctx.session.documentStatus([doc]))[0]?.status, "void", "void once approved");
      same((await ctx.session.findByReference(invoice.reference))?.voided, true, "marked voided");
    },
  },
  {
    name: "has no delete and no edit of a posted entry",
    async run(ctx) {
      const session = ctx.session as unknown as Record<string, (input: unknown) => unknown>;
      for (const method of [
        "delete",
        "deleteContact",
        "deleteDocument",
        "deleteEntry",
        "deleteInvoice",
        "updateInvoice",
        "updateEntry",
        "editDocument",
      ]) {
        let threw = false;
        try {
          await session[method]?.({ reference: ctx.reference("nothing") });
          threw = typeof session[method] !== "function";
        } catch {
          threw = true;
        }
        check(threw, `the session has no ${method}`);
      }
    },
  },
  {
    name: "refuses an entry dated on or before the books' lock date, and posts the day after",
    async run(ctx, control) {
      let lock = ctx.books.lockDate;
      if (ctx.target.control) {
        lock = addDays(ctx.date, -1);
        await control.setLockDate(lock);
      }
      if (lock === null) throw new Skip("the books are not locked");
      try {
        const reference = ctx.reference("summary");
        await refused(
          ctx.session.postSummary(summary(ctx, reference, lock)),
          "locked_period",
          "an entry dated on the lock date",
        );
        same(await ctx.session.findByReference(reference), null, "nothing in the books");
        if (ctx.target.control) {
          await sent(
            ctx.session.postSummary(summary(ctx, ctx.reference("summary"), addDays(lock, 1))),
            "the day after the lock",
          );
        }
      } finally {
        if (ctx.target.control) await control.setLockDate(ctx.books.lockDate);
      }
    },
  },
  {
    name: "refuses an invoice number already in use",
    needsControl: true,
    async run(ctx) {
      const contact = await newContact(ctx, "customer");
      const first = document(ctx, ctx.reference("invoice"), contact);
      await sent(ctx.session.postInvoice(first), "the first invoice");
      await refused(
        ctx.session.postInvoice({
          ...document(ctx, ctx.reference("invoice"), contact),
          number: first.number,
        }),
        "duplicate_number",
        "the same number again",
      );
    },
  },
  {
    name: "an answer lost after the write: found by its reference, and never written twice",
    needsControl: true,
    async run(ctx, control) {
      const reference = ctx.reference("summary");
      await control.failNext("postSummary", "unknown_after_write");
      same(
        await failure(ctx.session.postSummary(summary(ctx, reference))),
        null,
        "a lost answer is not a refusal",
      );
      const found = await ctx.session.findByReference(reference);
      check(found !== null, "the entry is in the books");
      same(
        await sent(ctx.session.postSummary(summary(ctx, reference)), "sent again"),
        found.ref,
        "sending again answers the same entry",
      );
      same(await control.writesOf(reference), 1, "written once");
    },
  },
  {
    name: "an answer lost before the write: nothing in the books, and written once when sent again",
    needsControl: true,
    async run(ctx, control) {
      const reference = ctx.reference("summary");
      await control.failNext("postSummary", "unknown");
      same(await failure(ctx.session.postSummary(summary(ctx, reference))), null, "not a refusal");
      same(await ctx.session.findByReference(reference), null, "nothing in the books");
      await sent(ctx.session.postSummary(summary(ctx, reference)), "sent again");
      same(await control.writesOf(reference), 1, "written once");
    },
  },
  {
    name: "a refusal says why, and writes nothing",
    needsControl: true,
    async run(ctx, control) {
      const reference = ctx.reference("summary");
      await control.failNext("postSummary", { refuse: "rate_limited" });
      await refused(ctx.session.postSummary(summary(ctx, reference)), "rate_limited", "refused");
      same(await ctx.session.findByReference(reference), null, "nothing in the books");
      same(await control.writesOf(reference), 0, "nothing written");
    },
  },
  {
    name: "shows a payment entered in the books that the host did not send",
    needsControl: true,
    async run(ctx, control) {
      const contact = await newContact(ctx, "customer");
      const invoice = document(ctx, ctx.reference("invoice"), contact);
      const doc = await sent(ctx.session.postInvoice(invoice), "the invoice");
      const theirs = await control.recordPaymentInBooks(doc, 300, ctx.date);
      const status = (await ctx.session.documentStatus([doc]))[0];
      same(status?.status, "part_paid", "part paid in the books");
      same(
        status?.paymentsNotSent,
        [{ ref: theirs, date: ctx.date, amount: 300, reference: null }],
        "the bookkeeper's payment",
      );
    },
  },
  {
    name: "refuses a void of a document the host did not write",
    needsControl: true,
    async run(ctx, control) {
      const contact = await newContact(ctx, "customer");
      const theirs = await control.addInvoiceInBooks(contact, ctx.number(), 5000, ctx.date);
      await refused(
        approved(ctx, { reference: ctx.reference("invoice"), ref: theirs, reason: "Conformance" }),
        "invalid",
        "a void of the bookkeeper's invoice",
      );
      same((await ctx.session.documentStatus([theirs]))[0]?.status, "open", "still open");
    },
  },
];

/** Asks for a void and approves it, as a person would: resolves once applied. */
async function approved(ctx: Context, input: { reference: string; ref: string; reason: string }) {
  const receipt = await ctx.session.voidDocument(input);
  await ctx.target.approve(receipt.id);
}

function pick(accounts: AccountingAccount[], type: AccountingAccount["type"], ...names: RegExp[]) {
  const open = accounts.filter((a) => a.type === type && !a.archived);
  const named = open.find((a) => names.some((name) => name.test(a.name)));
  const account = named ?? open[0];
  if (!account) throw new Error(`The books have no open ${type} account to test with.`);
  return account;
}

/** Reads the books and picks the accounts and tax rate the checks post to. */
export async function prepareConformance(
  target: ConformanceTarget,
  options: ConformanceOptions,
): Promise<Context> {
  if (!/^[A-Za-z0-9]{1,20}$/.test(options.run)) throw new Error("run is [A-Za-z0-9]{1,20}.");
  const books = await target.session.describeBooks();
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (books.lockDate !== null && date <= books.lockDate) {
    throw new Error(`The books are locked to ${books.lockDate}: choose a later date to test on.`);
  }
  const accounts = await target.session.listAccounts();
  const rate = (await target.session.listTaxRates()).find((r) => !r.archived && r.rate > 0);
  if (!rate) throw new Error("The books have no open tax rate above zero to test with.");
  let counter = 0;
  return {
    target,
    session: target.session,
    books,
    revenue: pick(accounts, "revenue", /sales/i),
    clearing: pick(accounts, "current_asset", /clearing/i, /undeposited/i),
    bank: pick(accounts, "bank"),
    fees: pick(accounts, "expense", /fee/i, /bank/i),
    rate,
    date,
    reference: (label) => `cos:conformance:${options.run}:${label}-${++counter}`,
    number: () => `C-${options.run}-${++counter}`,
  };
}

/** Runs every check in order; one that fails does not stop the others. */
export async function runConformance(
  target: ConformanceTarget,
  options: ConformanceOptions,
): Promise<ConformanceResult[]> {
  const ctx = await prepareConformance(target, options);
  const results: ConformanceResult[] = [];
  for (const c of CONFORMANCE_CHECKS) results.push(await runCheck(c, ctx));
  return results;
}

/** One check against a prepared context: passed, failed with why, or skipped with why. */
export async function runCheck(c: ConformanceCheck, ctx: Context): Promise<ConformanceResult> {
  const { control } = ctx.target;
  if (c.needsControl && !control) {
    return { name: c.name, status: "skipped", error: "needs the fake's controls" };
  }
  try {
    await c.run(ctx, control ?? NO_CONTROL);
    return { name: c.name, status: "passed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: c.name, status: error instanceof Skip ? "skipped" : "failed", error: message };
  }
}

const unavailable = async (): Promise<never> => {
  throw new Error("This target has no controls.");
};
const NO_CONTROL: ConformanceControl = {
  failNext: unavailable,
  writesOf: unavailable,
  setLockDate: unavailable,
  recordPaymentInBooks: unavailable,
  addInvoiceInBooks: unavailable,
};

export type { Context as ConformanceContext };
