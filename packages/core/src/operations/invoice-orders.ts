// An invoice as an order, its recorded payments, credit notes and void (stage 35 steps 3 to 5,
// ADRs 0731, 0733 and 0735).
//
//   invoice.issue              staff (invoices:send; a line discount also orders:discount, within
//                              the limit or approved); an AI asks, a person approves
//   invoice.allowPartPayments  staff (invoices:send)
//   invoice.recordPayment      staff (invoices:payments), a person only
//   invoice.reversePayment     staff (invoices:payments), a person only
//   creditNote.create, .delete staff (invoices:write): drafts
//   creditNote.get, .list      staff (records:read)
//   creditNote.issue           staff (invoices:credit), a person only
//   invoice.void               staff (invoices:credit), a person only
//
// Every operation here is staff only (ADR 0402): a customer's and the public's are step 8. Money
// moves only through the existing order, payment and refund paths: the issue starts an order with
// `createOrder`, a recorded payment is stage 34's shared step (`applyOtherPayment`, ADR 0694), a
// credit note's refund of a provider payment the existing approval (`requestRefund`).
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  askRefundAgain,
  type CreditLineRow,
  type CreditNoteRow,
  creditedSoFar,
  creditLines,
  creditNoteSource,
  creditRefunds,
  draftRow,
  draftStatements,
  issueCreditNote,
  loadCreditNote,
  requireCreditable,
  voidLines,
} from "../invoices/credit.ts";
import {
  type InvoiceRow,
  invoiceOutput,
  linesOf,
  loadDocument,
  presentInvoice,
} from "../invoices/drafts.ts";
import "../invoices/hooks.ts";
import { invoiceDiscountsWithinLimit, issueInvoice } from "../invoices/issue.ts";
import { loadInvoiceSettings } from "../invoices/settings.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { refusePageOpen } from "../orders/checkout.ts";
import { formatMoney, loadOrderRow } from "../orders/orders.ts";
import { applyOtherPayment, RECORDED_KINDS, reverseOtherPayment } from "../orders/payments.ts";
import { receivedDayOk } from "./order.ts";

const invoiceId = z.string().min(1).max(64).describe("The invoice's id (inv_…)");
const creditNoteId = z.string().min(1).max(64).describe("The credit note's id (cn_…)");
const versionInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("The version you read: one changed since by someone else is refused");
/**
 * The version read, required (review of PR #460): an act a person may have to approve names what
 * they approve. A queued call keeps its input, so applying it after the document changed (a line
 * added, a discount raised, a payment recorded) is refused, never applied to what was not asked.
 */
const pinnedVersion = z
  .number()
  .int()
  .min(0)
  .describe(
    "The version you read (from get): required, so what is approved is what was asked; one changed since is refused",
  );

function checkVersion(doc: { version: number }, version: number | undefined): void {
  if (version !== undefined && version !== doc.version) {
    throw new ConflictError("It changed since you read it. Look at it again.", {
      rule: "document_changed",
      version: doc.version,
    });
  }
}

/** The invoice as it is once the batch has committed (its number, its state). */
const invoiceAfter = (ctx: HandlerContext, id: string) =>
  ctx.afterCommit(async () => {
    const doc = await loadDocument(ctx.db, "invoice", id);
    return presentInvoice(doc, await linesOf(ctx.db, "invoice", id));
  });

// --- Issuing ----------------------------------------------------------------------------------

export const invoiceIssue = defineOperation({
  name: "invoice.issue",
  description:
    "Issue a draft invoice: it takes the next number of the invoice series (INV-0042), its " +
    "bill-to as printed, the business's details and bank details as they are now, its issue date " +
    "and its due date (the draft's, or today plus its payment terms), and starts its order in the " +
    "same step: the invoice's lines as the host priced them, its line discounts, and the tax " +
    "worked out on it. From then on it is never changed: it is credited. Its order does not " +
    "expire: it is due on the invoice's due date and shows among the overdue after it; places " +
    "it holds are held until it is paid, credited or voided. A record's price that changed since " +
    "its line was added, goods, and an agreement the bill-to still needs are refused with why. " +
    "A line discount needs the discount permission, and over the limit an admin set it waits for " +
    "approval. An AI assistant can ask; a person approves. Sending it is a separate step. " +
    "Returns the invoice.",
  input: z.object({ id: invoiceId, version: pinnedVersion }),
  output: invoiceOutput,
  permission: "invoices:send",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  // An AI asks; a person decides (stage 35, "What an AI may do").
  alwaysReview: ["assistant", "mcp"],
  // A line discount over the staff discount limit waits for an admin (ADR 0691).
  reviewWhen: (input, db) => invoiceDiscountsWithinLimit(db, input.id).then((ok) => !ok),
  auditSummary: (output, input) => ({
    id: input.id,
    number: output.number,
    orderId: output.orderId,
    total: output.total,
  }),
  async handler(input, ctx) {
    const doc = await loadDocument(ctx.db, "invoice", input.id);
    checkVersion(doc, input.version);
    await issueInvoice(ctx, doc, await linesOf(ctx.db, "invoice", doc.id));
    return invoiceAfter(ctx, doc.id);
  },
});

/** An issued invoice still owed something: its order pending or part paid. */
async function owingInvoice(ctx: HandlerContext, id: string) {
  const doc = await loadDocument(ctx.db, "invoice", id);
  if (!["issued", "sent", "part_paid"].includes(doc.state) || !doc.order_id) {
    throw new ConflictError(
      doc.state === "draft"
        ? "This invoice is a draft: issue it first"
        : `This invoice is ${doc.state}: nothing is owed on it`,
      { rule: "invoice_state", state: doc.state },
    );
  }
  return { doc, order: await loadOrderRow(ctx.db, doc.order_id) };
}

export const invoiceAllowPartPayments = defineOperation({
  name: "invoice.allowPartPayments",
  description:
    "Allow (or stop) part payments online on an issued invoice. Without, the payment page asks " +
    "for the whole balance; with, the payer may pay part of it, at least the minimum set for " +
    "orders. A payment recorded by staff can be any amount up to the balance either way. " +
    "Returns the invoice.",
  input: z.object({ id: invoiceId, allow: z.boolean(), version: pinnedVersion }),
  output: invoiceOutput,
  permission: "invoices:send",
  risk: "write",
  async handler(input, ctx) {
    const { doc } = await owingInvoice(ctx, input.id);
    checkVersion(doc, input.version);
    const allow = input.allow ? 1 : 0;
    if (doc.allow_part_payments !== allow) {
      ctx.write(
        ctx.db
          .updateTable("core_invoice")
          .set({
            allow_part_payments: allow,
            version: doc.version + 1,
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          })
          .where("id", "=", doc.id),
      );
      ctx.recordChange({
        object: "invoice",
        id: doc.id,
        action: "update",
        before: { allowPartPayments: doc.allow_part_payments === 1 },
        after: { allowPartPayments: input.allow },
      });
    }
    return invoiceAfter(ctx, doc.id);
  },
});

// --- Payments taken another way (ADR 0733, on stage 34's shared step) --------------------------

const recordedKind = z
  .enum(RECORDED_KINDS)
  .describe("How it was paid: transfer, cash, cheque, card_machine or other");

const paidOutput = z.object({
  paymentId: z.string().describe("The payment row (opy_…): what a reversal names"),
  invoice: invoiceOutput,
});

export const invoiceRecordPayment = defineOperation({
  name: "invoice.recordPayment",
  description:
    "Record a payment of an issued invoice taken another way than the payment page: a bank " +
    "transfer, cash, a cheque, a card machine. Any amount up to the balance, never more. The " +
    "invoice becomes part paid or paid, as its order does, and what it bought is given. The " +
    "payment names you as the person who received it; it is in the invoice's log, on the " +
    "timeline, and admins are told of one over the amount set in the invoice settings. A person " +
    "only, with the permission to record invoice payments: AI assistants, MCP clients, " +
    "automations and extensions are refused. Returns the payment's id and the invoice.",
  input: z.object({
    invoiceId,
    amount: z
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .describe("What was received, in the currency's minor unit (cents)"),
    kind: recordedKind,
    receivedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD")
      .describe("The day it was received (YYYY-MM-DD)"),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("The payer's reference: a bank reference, a cheque number"),
    version: pinnedVersion,
  }),
  output: paidOutput,
  permission: "invoices:payments",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    invoiceId: input.invoiceId,
    paymentId: output.paymentId,
    amount: input.amount,
    kind: input.kind,
  }),
  async handler(input, ctx) {
    if (!receivedDayOk(input.receivedOn, ctx.now)) {
      throw new ValidationError(
        "The day received is a real day, not after today and at most a year ago",
        { field: "receivedOn", rule: "received_on" },
      );
    }
    const { doc, order } = await owingInvoice(ctx, input.invoiceId);
    checkVersion(doc, input.version);
    // A payment page open for the old amount would no longer match (review of PR #460).
    await refusePageOpen(ctx, order, "record a payment");
    const settings = await loadInvoiceSettings(ctx.db);
    // The shared step (ADR 0694): the payment row, the order moved as the host through the
    // settle path, the invoice following it and the log written in that batch. At most what is
    // owed, which a credit note may have lowered.
    const paid = await applyOtherPayment(ctx, {
      orderId: order.id,
      amount: input.amount,
      payment: {
        method: "recorded",
        kind: input.kind,
        // Who received it is the caller, never input.
        recordedBy: ctx.user.id,
        receivedOn: input.receivedOn,
        reference: input.reference ?? null,
      },
      noticeOver: settings.recordedPaymentNoticeOver,
    });
    // The Person's timeline has it (the shared step); an organisation billed has it too.
    if (doc.organisation_id) {
      ctx.postActivity({
        subject: `Payment recorded on invoice ${doc.number}: ${formatMoney(input.amount, doc.currency)}`,
        payload: {
          kind: "invoice.paymentRecorded",
          invoiceId: doc.id,
          paymentId: paid.paymentId,
          amount: input.amount,
          recordedKind: input.kind,
          currency: doc.currency,
        },
        links: [{ object: "organisation", id: doc.organisation_id }],
      });
    }
    return ctx.afterCommit(async () => ({
      paymentId: paid.paymentId,
      invoice: presentInvoice(
        await loadDocument(ctx.db, "invoice", doc.id),
        await linesOf(ctx.db, "invoice", doc.id),
      ),
    }));
  },
});

export const invoiceReversePayment = defineOperation({
  name: "invoice.reversePayment",
  description:
    "Reverse a payment recorded on an invoice in error (invoice.recordPayment): a second entry " +
    "takes it back off, nothing is deleted, and a paid invoice is part paid again with the " +
    "amount owed. What it gave stays. Not for a payment made on the payment page (credit the " +
    "invoice instead), nor one a credit note gives money back on. Admins are told. A person " +
    "only, with the permission to record invoice payments. Returns the reversal's id and the " +
    "invoice.",
  input: z.object({
    paymentId: z.string().min(1).max(64).describe("The recorded payment (opy_…)"),
    reason: z.string().trim().min(1).max(500).describe("Why it was entered in error"),
  }),
  output: paidOutput,
  permission: "invoices:payments",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    paymentId: input.paymentId,
    reversalId: output.paymentId,
    invoiceId: output.invoice.id,
  }),
  async handler(input, ctx) {
    const paidOn = await ctx.db
      .selectFrom("core_order_payment")
      .select("order_id")
      .where("event_id", "=", input.paymentId)
      .executeTakeFirst();
    const on = paidOn ? await loadOrderRow(ctx.db, paidOn.order_id) : null;
    if (!on?.invoice_id) throw new NotFoundError("invoice payment", input.paymentId);
    // Money a credit note gives back on it was received: it is paid back, not reversed.
    const credited = await ctx.db
      .selectFrom("core_credit_note_refund")
      .select("id")
      .where("payment_ref", "=", input.paymentId)
      .executeTakeFirst();
    if (credited) {
      throw new ConflictError(
        "A credit note gives money back on this payment, so it was received: it cannot be reversed",
        { rule: "reverse_refunded" },
      );
    }
    const reversed = await reverseOtherPayment(ctx, {
      paymentId: input.paymentId,
      reason: input.reason,
      reversedBy: ctx.user.id,
    });
    const id = on.invoice_id;
    return ctx.afterCommit(async () => ({
      paymentId: reversed.reversalId,
      invoice: presentInvoice(
        await loadDocument(ctx.db, "invoice", id),
        await linesOf(ctx.db, "invoice", id),
      ),
    }));
  },
});

// --- Credit notes (ADR 0735) ---------------------------------------------------------------

const settleSchema = z
  .enum(["reduce", "refund", "both"])
  .describe(
    "reduce: take it off what is still owed; refund: give it back from what was paid (nothing " +
      "may be owed); both: take off what is owed first, then give back the rest",
  );

const creditNoteOutput = z.object({
  id: z.string(),
  number: z.string().nullable().describe("Given when issued; null on a draft"),
  state: z.enum(["draft", "issued"]),
  invoiceId: z.string(),
  currency: z.string(),
  taxMode: z.enum(["exclusive", "inclusive"]),
  reason: z.string().nullable(),
  settle: settleSchema,
  lines: z.array(
    z.object({
      id: z.string(),
      position: z.number(),
      description: z.string(),
      quantity: z.number(),
      unit: z.string().nullable(),
      unitPrice: z.number(),
      taxRate: z.object({ key: z.string(), label: z.string(), rate: z.number() }).nullable(),
      net: z.number(),
      tax: z.number(),
      total: z.number(),
      creditsLineId: z.string().nullable().describe("The invoice line it credits; null: an amount"),
    }),
  ),
  netTotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  issuedOn: z.string().nullable(),
  refunds: z
    .array(
      z.object({
        paymentRef: z.string(),
        method: z.enum(["provider", "recorded"]),
        amount: z.number(),
        refundId: z
          .string()
          .nullable()
          .describe("The refund asked for (provider) or recorded (paid back); null: still owed"),
        paidBackAt: z.string().nullable(),
        attempt: z.number().describe("1, or how many times a provider's refund was asked for"),
        state: z
          .enum(["given_back", "asked", "owed"])
          .describe(
            "given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain)",
          ),
      }),
    )
    .describe("What it gives back, per payment, and where each stands"),
  owedBack: z.number().describe("What it still owes back: not given back, nor waiting"),
  version: z.number(),
  createdAt: z.string(),
});

async function presentCreditNote(
  ctx: HandlerContext,
  note: CreditNoteRow,
  lines: readonly Omit<CreditLineRow, "credit_note_id" | "created_at">[],
): Promise<z.infer<typeof creditNoteOutput>> {
  const invoice = await loadDocument(ctx.db, "invoice", note.invoice_id);
  const refunds = invoice.order_id ? await creditRefunds(ctx, invoice.order_id, note.id) : [];
  return {
    id: note.id,
    number: note.number,
    state: note.state,
    invoiceId: note.invoice_id,
    currency: note.currency,
    taxMode: note.tax_mode,
    reason: note.reason,
    settle: note.settle,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        id: l.id,
        position: l.position,
        description: l.description,
        quantity: l.quantity_milli / 1000,
        unit: l.unit,
        unitPrice: l.unit_price,
        taxRate:
          l.tax_key === null
            ? null
            : { key: l.tax_key, label: l.tax_label ?? l.tax_key, rate: l.tax_rate },
        net: l.line_net,
        tax: l.line_tax,
        total: l.line_total,
        creditsLineId: l.credits_line_id,
      })),
    netTotal: note.net_total,
    taxTotal: note.tax_total,
    total: note.total,
    issuedOn: note.issued_on,
    refunds: refunds.map((r) => ({
      paymentRef: r.paymentRef,
      method: r.method,
      amount: r.amount,
      refundId: r.refundId,
      paidBackAt: r.paidBackAt,
      attempt: r.attempt,
      state: r.state,
    })),
    owedBack: refunds.filter((r) => r.state === "owed").reduce((sum, r) => sum + r.amount, 0),
    version: note.version,
    createdAt: note.created_at,
  };
}

const creditLinesInput = z
  .array(
    z.object({
      lineId: z.string().min(1).max(64).describe("The invoice line (inl_…)"),
      quantity: z
        .number()
        .positive()
        .max(10_000)
        .optional()
        .describe("How much of it: left out, all that is left to credit of it"),
    }),
  )
  .min(1)
  .max(50);

export const creditNoteCreate = defineOperation({
  name: "creditNote.create",
  description:
    "Draft a credit note against an issued invoice: some of its lines (each with a quantity, or " +
    "all that is left of it), or an amount at one of its tax rates (in minor units, as the " +
    "invoice's amounts are typed). Its tax is worked out as the invoice's was. Never more than " +
    "is left to credit of a line, a rate or the invoice. Say why, and how it settles: reduce " +
    "what is still owed, give back what was paid, or both. A draft changes nothing until a " +
    "person with the permission to credit issues it. Returns the draft.",
  input: z
    .object({
      invoiceId,
      lines: creditLinesInput.optional(),
      amount: z
        .object({
          value: z.number().int().min(1).max(100_000_000).describe("Minor units"),
          taxRate: z
            .string()
            .min(1)
            .max(32)
            .nullable()
            .describe("One of the invoice's rates' keys; null for its part without tax"),
          description: z.string().trim().min(1).max(500).optional(),
        })
        .optional(),
      reason: z.string().trim().min(1).max(500).describe("Why, as printed on the credit note"),
      settle: settleSchema.default("both"),
    })
    .refine((v) => (v.lines === undefined) !== (v.amount === undefined), {
      message: "Pass lines or amount, not both",
    }),
  output: creditNoteOutput,
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    const invoice = await loadDocument(ctx.db, "invoice", input.invoiceId);
    requireCreditable(invoice);
    const invoiceLines = await linesOf(ctx.db, "invoice", invoice.id);
    const lines = creditLines(
      invoice,
      invoiceLines,
      await creditedSoFar(ctx, invoice.id),
      input.lines
        ? { lines: input.lines }
        : { amount: input.amount as NonNullable<typeof input.amount> },
    );
    const row = draftRow(ctx, invoice, lines, input.reason, input.settle);
    ctx.write(...draftStatements(ctx, row, lines));
    ctx.recordChange({
      object: "creditNote",
      id: row.id,
      action: "create",
      after: { state: "draft", invoiceId: invoice.id, total: row.total, settle: row.settle },
    });
    return presentCreditNote(ctx, row, lines);
  },
});

export const creditNoteGet = defineOperation({
  name: "creditNote.get",
  description:
    "One credit note with its lines, totals, how it settles and what it gives back per payment. " +
    "Amounts are integers in the currency's minor unit. Read-only.",
  input: z.object({ id: creditNoteId }),
  output: creditNoteOutput,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const { note, lines } = await loadCreditNote(ctx, input.id, ctx);
    return presentCreditNote(ctx, note, lines);
  },
});

export const creditNoteList = defineOperation({
  name: "creditNote.list",
  description:
    "An invoice's credit notes, drafts and issued, oldest first, without their lines " +
    "(creditNote.get has them). Read-only.",
  input: z.object({ invoiceId }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        number: z.string().nullable(),
        state: z.enum(["draft", "issued"]),
        settle: settleSchema,
        total: z.number(),
        issuedOn: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // Through the seam, as the caller may read them.
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const rows = (await (ctx.db as any)
      .selectFrom(creditNoteSource(ctx))
      .select(["id", "number", "state", "settle", "total", "issued_on", "created_at"])
      .where("invoice_id", "=", input.invoiceId)
      .orderBy("created_at")
      .limit(200)
      .execute()) as {
      id: string;
      number: string | null;
      state: "draft" | "issued";
      settle: "reduce" | "refund" | "both";
      total: number;
      issued_on: string | null;
      created_at: string;
    }[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        number: r.number,
        state: r.state,
        settle: r.settle,
        total: r.total,
        issuedOn: r.issued_on,
        createdAt: r.created_at,
      })),
    };
  },
});

export const creditNoteDelete = defineOperation({
  name: "creditNote.delete",
  description: "Delete a draft credit note, for good. An issued one is never deleted.",
  input: z.object({ id: creditNoteId, version: versionInput }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    const { note, lines } = await loadCreditNote(ctx, input.id);
    if (note.state !== "draft") {
      throw new ConflictError("An issued credit note is never deleted", {
        rule: "document_immutable",
      });
    }
    checkVersion(note, input.version);
    ctx.write(
      // The version read, moved by one: one issued meanwhile fails the whole batch here.
      ctx.db
        .updateTable("core_credit_note")
        .set({ version: note.version + 1, updated_at: ctx.now, updated_by: ctx.user.id })
        .where("id", "=", note.id),
      ...lines.map((l) => ctx.db.deleteFrom("core_credit_note_line").where("id", "=", l.id)),
      ctx.db.deleteFrom("core_credit_note").where("id", "=", note.id),
    );
    ctx.recordChange({
      object: "creditNote",
      id: note.id,
      action: "delete",
      before: { total: note.total },
    });
    return { id: note.id, deleted: true as const };
  },
});

const issuedOutput = creditNoteOutput.extend({
  invoice: invoiceOutput,
  pending: z
    .array(z.string())
    .describe("The refunds waiting in Approvals for a person with the refund permission"),
});

async function issuedAfter(
  ctx: HandlerContext,
  noteId: string,
  invoice: InvoiceRow,
  pending: string[],
) {
  return ctx.afterCommit(async () => {
    const { note, lines } = await loadCreditNote(ctx, noteId);
    return {
      ...(await presentCreditNote(ctx, note, lines)),
      invoice: presentInvoice(
        await loadDocument(ctx.db, "invoice", invoice.id),
        await linesOf(ctx.db, "invoice", invoice.id),
      ),
      pending,
    };
  });
}

export const creditNoteIssue = defineOperation({
  name: "creditNote.issue",
  description:
    "Issue a draft credit note: it takes the next number of the credit note series and, in the " +
    "same step, takes off what is still owed on its invoice and gives back the rest from what " +
    "was paid, as it says. Money paid on the payment page goes back through the Approvals " +
    "inbox, for a person with the refund permission; money taken another way is owed back until " +
    "a person pays it back and records it (order.recordRefund). Never more than was paid. An " +
    "invoice credited in full with nothing paid is credited, its order cancelled and its places " +
    "given back. A person only, with the permission to credit invoices: AI assistants are " +
    "refused. Returns the credit note, its invoice and the refunds waiting.",
  input: z.object({ id: creditNoteId, version: pinnedVersion }),
  output: issuedOutput,
  permission: "invoices:credit",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    id: input.id,
    number: output.number,
    invoiceId: output.invoiceId,
    total: output.total,
  }),
  async handler(input, ctx) {
    const { note, lines } = await loadCreditNote(ctx, input.id);
    checkVersion(note, input.version);
    const settled = await issueCreditNote(ctx, note, lines);
    const invoice = await loadDocument(ctx.db, "invoice", note.invoice_id);
    return issuedAfter(
      ctx,
      note.id,
      invoice,
      settled.refunded.flatMap((r) => (r.pendingActionId ? [r.pendingActionId] : [])),
    );
  },
});

export const creditNoteAskRefundAgain = defineOperation({
  name: "creditNote.askRefundAgain",
  description:
    "Ask again for what an issued credit note gives back on the payment page, where its refund " +
    "was rejected, its approval expired or it failed: the same amount, on the same payment, " +
    "waiting in the Approvals inbox for a person with the refund permission as before. Until " +
    "then the credit note shows it as owed back. A person only, with the refund permission. " +
    "Returns the credit note and the refunds waiting.",
  input: z.object({ id: creditNoteId }),
  output: creditNoteOutput.extend({
    pending: z.array(z.string()).describe("The refunds now waiting in Approvals"),
  }),
  permission: "orders:refund",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({ id: input.id, pending: output.pending.length }),
  async handler(input, ctx) {
    const { note } = await loadCreditNote(ctx, input.id);
    const asked = await askRefundAgain(ctx, note);
    return ctx.afterCommit(async () => {
      const read = await loadCreditNote(ctx, input.id);
      return {
        ...(await presentCreditNote(ctx, read.note, read.lines)),
        pending: asked.pending,
      };
    });
  },
});

export const invoiceVoid = defineOperation({
  name: "invoice.void",
  description:
    "Void an issued invoice nothing has been paid on: a credit note for everything still owed " +
    "on it, issued at once; the invoice is void, its order cancelled and its places given back. " +
    "An invoice with something paid is credited instead (creditNote.create). A person only, " +
    "with the permission to credit invoices: AI assistants are refused. Returns the credit note " +
    "and the invoice.",
  input: z.object({
    id: invoiceId,
    reason: z.string().trim().min(1).max(500).describe("Why, as printed on the credit note"),
    version: pinnedVersion,
  }),
  output: issuedOutput,
  permission: "invoices:credit",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output, input) => ({ id: input.id, creditNoteId: output.id, total: output.total }),
  async handler(input, ctx) {
    const { doc, order } = await owingInvoice(ctx, input.id);
    checkVersion(doc, input.version);
    if (order.paid > 0 || order.state !== "pending") {
      throw new ConflictError(
        "Something has been paid on this invoice: credit it instead, giving back what was paid",
        { rule: "void_paid" },
      );
    }
    const invoiceLines = await linesOf(ctx.db, "invoice", doc.id);
    const lines = voidLines(doc, invoiceLines, await creditedSoFar(ctx, doc.id));
    const row = draftRow(ctx, doc, lines, input.reason, "reduce");
    ctx.write(...draftStatements(ctx, row, lines));
    await issueCreditNote(ctx, row, lines, { voiding: { reason: input.reason } });
    return issuedAfter(ctx, row.id, doc, []);
  },
});

export const invoiceOrderOperations = [
  invoiceIssue,
  invoiceAllowPartPayments,
  invoiceRecordPayment,
  invoiceReversePayment,
  creditNoteCreate,
  creditNoteGet,
  creditNoteList,
  creditNoteDelete,
  creditNoteIssue,
  creditNoteAskRefundAgain,
  invoiceVoid,
] as const;
