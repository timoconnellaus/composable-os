// Quotes and invoices: drafts, the invoice settings and the document event log (stage 35 step 2,
// ADRs 0730 and 0732).
//
//   quote.create, .update, .addLine, .updateLine, .removeLine, .delete        staff (invoices:write)
//   invoice.create, .update, .addLine, .updateLine, .removeLine, .delete      staff (invoices:write)
//   quote.list, quote.get, invoice.list, invoice.get                          staff (records:read)
//   invoice.settings.get                                                      staff (records:read)
//   invoice.settings.update                       staff (settings:manage), a person only: an admin
//   invoice.events                                staff (invoices:payments): the log, by cursor
//
// Every operation here is staff only: nothing is open to a customer or the public (their reads
// are stage 35 step 8, a reviewed change, ADR 0402). The draft operations are a person's or the
// assistant's for them, through the gate as any write; an extension's own account holds none of
// these permissions. Sending a quote, issuing an invoice and credit notes are later steps: no
// operation here gives a number, and the database refuses any change to a document once it has
// one.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ValidationError } from "../errors.ts";
import { INVOICE_KINDS, TAX_MODES } from "../fields/invoice.ts";
import { filterSchema } from "../filter.ts";
import { newId } from "../ids.ts";
import { creditRefunds } from "../invoices/credit.ts";
import {
  aboutSchema,
  auditSnapshot,
  billToSchema,
  changedLine,
  checkAbout,
  checkBillTo,
  checkRecordLines,
  DOCUMENT_MAX_LINES,
  type DocumentRow,
  type DraftKind,
  type InvoiceRow,
  invoiceOutput,
  KIND_TABLES,
  type LineRow,
  lineChangeSchema,
  lineInputSchema,
  linesOf,
  lineWrites,
  loadDocument,
  loadLine,
  newLine,
  presentInvoice,
  presentQuote,
  type QuoteRow,
  quoteOutput,
  renumbered,
  repriced,
  requireDraft,
  requireRoom,
  totalsOf,
  updateDocument,
} from "../invoices/drafts.ts";
import {
  DOCUMENT_KINDS,
  EVENTS_PAGE_MAX,
  eventsAfter,
  INVOICE_EVENTS,
} from "../invoices/events.ts";
import {
  formatNumber,
  loadSeries,
  MAX_NUMBER,
  PREFIX_RE,
  SERIES,
  type Series,
  seriesStatement,
} from "../invoices/numbering.ts";
import {
  bankDetailSchema,
  businessSchema,
  INVOICE_SETTINGS,
  type InvoiceSettings,
  invoiceSettingsSchema,
  loadInvoiceSettings,
  maskedBank,
  taxRateSchema,
} from "../invoices/settings.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { notifyStatements } from "../notifications/send.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { loadOrderRow, owedOn } from "../orders/orders.ts";
import { loadOrderCurrency } from "../orders/settings.ts";

const quoteId = z.string().min(1).max(64).describe("The quote's id (qt_…)");
const invoiceId = z.string().min(1).max(64).describe("The invoice's id (inv_…)");
const lineId = z.string().min(1).max(64).describe("The line's id");
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Not a date");
const text = (max: number) => z.string().trim().min(1).max(max).nullable();

const depositSchema = z
  .object({
    kind: z.enum(["none", "amount", "percent"]),
    value: z
      .number()
      .int()
      .min(1)
      .max(10_000_000_000)
      .nullable()
      .default(null)
      .describe("An amount in minor units, or hundredths of a percent (2500 = 25%)"),
  })
  .refine(
    (d) => (d.kind === "none") === (d.value === null),
    "A deposit has a value, and no deposit has none",
  )
  .refine((d) => d.kind !== "percent" || (d.value ?? 0) <= 10000, "A percentage is at most 100%")
  .describe("What the customer pays when they accept: none, an amount, or a percentage");

/** Fields a quote's and an invoice's draft share. */
const draftFields = {
  billTo: billToSchema.nullable().optional(),
  siteAddress: text(500).optional().describe("Where the work is, when not the bill-to's address"),
  about: aboutSchema.nullable().optional(),
  title: text(200).optional(),
  notes: text(2000).optional().describe("For the customer, printed on the document"),
  taxMode: z
    .enum(TAX_MODES)
    .optional()
    .describe("Whether unit prices are typed without tax (added on top) or with it (inside)"),
};

const quoteFields = {
  ...draftFields,
  validUntil: dateSchema
    .nullable()
    .optional()
    .describe("Left empty: the settings' validity from the day it is sent"),
  deposit: depositSchema.optional(),
};

const invoiceFields = {
  ...draftFields,
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  dueOn: dateSchema
    .nullable()
    .optional()
    .describe("Left empty: worked out at issue from the payment terms"),
};

type DraftInput = {
  billTo?: z.infer<typeof billToSchema> | null | undefined;
  siteAddress?: string | null | undefined;
  about?: z.infer<typeof aboutSchema> | null | undefined;
  title?: string | null | undefined;
  notes?: string | null | undefined;
  taxMode?: (typeof TAX_MODES)[number] | undefined;
};

/** The columns the shared fields set: only what was given. */
async function draftColumns(ctx: HandlerContext, input: DraftInput) {
  const set: Record<string, unknown> = {};
  if (input.billTo !== undefined) {
    Object.assign(
      set,
      input.billTo
        ? await checkBillTo(ctx, input.billTo)
        : { person_id: null, organisation_id: null },
    );
  }
  if (input.about !== undefined) {
    Object.assign(
      set,
      input.about ? await checkAbout(ctx, input.about) : { about_object: null, about_id: null },
    );
  }
  if (input.siteAddress !== undefined) set.site_address = input.siteAddress;
  if (input.title !== undefined) set.title = input.title;
  if (input.notes !== undefined) set.notes = input.notes;
  if (input.taxMode !== undefined) set.tax_mode = input.taxMode;
  return set;
}

async function currencyOrRefuse(ctx: HandlerContext): Promise<string> {
  const currency = await loadOrderCurrency(ctx.db);
  if (!currency) {
    throw new ValidationError(
      "Set the currency first (Settings → Orders): every quote and invoice is in it",
      { rule: "no_currency" },
    );
  }
  return currency;
}

const NO_CHANGE = "Pass at least one field to change";

const presentOf = (kind: DraftKind, doc: DocumentRow, lines: readonly LineRow[]) =>
  kind === "quote"
    ? presentQuote(doc as QuoteRow, lines)
    : presentInvoice(doc as InvoiceRow, lines);

/** Writes `doc` with `set` and its lines as `after`, audited as a change of the document. */
function writeDraft(
  ctx: HandlerContext,
  kind: DraftKind,
  doc: DocumentRow,
  set: Record<string, unknown>,
  before: readonly LineRow[],
  after: readonly LineRow[],
) {
  const { statement, next } = updateDocument(ctx, kind, doc, set, after);
  // Lines first: their triggers read the document while it is still the draft they were read on.
  ctx.write(...lineWrites(ctx.db, kind, before, after), statement);
  ctx.recordChange({
    object: kind,
    id: doc.id,
    action: "update",
    before: auditSnapshot(doc, before),
    after: auditSnapshot(next, after),
  });
  return presentOf(kind, next, after);
}

// --- Creating -------------------------------------------------------------------------------

/** What a new draft holds before anything is sent or issued (the columns' own defaults). */
const QUOTE_DEFAULTS = {
  valid_until: null,
  deposit_kind: "none",
  deposit_value: null,
  replaces_quote_id: null,
  acceptance_id: null,
  sent_at: null,
  accepted_at: null,
  declined_at: null,
  decline_reason: null,
  withdrawn_at: null,
  expired_at: null,
};
const INVOICE_DEFAULTS = {
  kind: "standard",
  quote_id: null,
  order_id: null,
  issued_on: null,
  due_on: null,
  issued_at: null,
  sent_at: null,
  allow_part_payments: 0,
  reminders_paused: 0,
  reminders_paused_reason: null,
  business: null,
};

async function createDraft(
  ctx: HandlerContext,
  kind: DraftKind,
  input: DraftInput & { lines?: z.infer<typeof lineInputSchema>[] | undefined },
  own: Record<string, unknown>,
) {
  const currency = await currencyOrRefuse(ctx);
  const settings = await loadInvoiceSettings(ctx.db);
  const shared = await draftColumns(ctx, input);
  requireRoom(kind, [], input.lines?.length ?? 0);
  const id = newId(KIND_TABLES[kind].id);
  const base = {
    id,
    state: "draft",
    number: null,
    number_seq: null,
    currency,
    tax_mode: settings.amountsIncludeTax ? "inclusive" : "exclusive",
    person_id: null,
    organisation_id: null,
    bill_to_name: null,
    bill_to_address: null,
    bill_to_tax_number: null,
    bill_to_email: null,
    site_address: null,
    about_object: null,
    about_id: null,
    title: null,
    notes: null,
    created_at: ctx.now,
    created_by: ctx.user.id,
    updated_at: ctx.now,
    updated_by: ctx.user.id,
    version: 0,
    ...(kind === "quote" ? QUOTE_DEFAULTS : INVOICE_DEFAULTS),
    ...shared,
    ...own,
  };
  const draft = { ...base, net_total: 0, tax_total: 0, total: 0, tax_by_rate: "[]" };
  const lines: LineRow[] = [];
  for (const [index, line] of (input.lines ?? []).entries()) {
    lines.push(await newLine(ctx, kind, draft as unknown as DocumentRow, settings, line, index));
  }
  await checkRecordLines(ctx, currency, lines);
  const row = { ...base, ...totalsOf(lines) };
  const t = KIND_TABLES[kind];
  ctx.write(
    // biome-ignore lint/suspicious/noExplicitAny: the quote and invoice tables share these columns.
    (ctx.db as any).insertInto(t.doc).values(row),
    ...lineWrites(ctx.db, kind, [], lines),
  );
  const doc = row as unknown as DocumentRow;
  ctx.recordChange({ object: kind, id, action: "create", after: auditSnapshot(doc, lines) });
  return presentOf(kind, doc, lines);
}

const createLines = z
  .array(lineInputSchema)
  .max(DOCUMENT_MAX_LINES)
  .optional()
  .describe("Lines to start with (each as quote.addLine / invoice.addLine takes one)");

export const quoteCreate = defineOperation({
  name: "quote.create",
  description:
    "Start a quote as a draft: whom it is for (a Person, or an Organisation with its contact " +
    "Person), an optional site address, the record it is about, a title, notes for the customer, " +
    "valid-until, a deposit, and lines. A line is a record for sale (a pass type, a ticket type, " +
    "a price-list item), priced by the host, or a typed line with a description, quantity, unit " +
    "and unit price; each has a tax rate from the invoice settings and an optional discount. The " +
    "host works out each line's tax and the totals. A draft has no number and changes freely: " +
    "nothing is sent until a person sends it. Amounts are integers in the currency's minor unit.",
  input: z.object({ ...quoteFields, lines: createLines }),
  output: quoteOutput,
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    return (await createDraft(ctx, "quote", input, {
      valid_until: input.validUntil ?? null,
      deposit_kind: input.deposit?.kind ?? "none",
      deposit_value: input.deposit?.value ?? null,
    })) as z.infer<typeof quoteOutput>;
  },
});

export const invoiceCreate = defineOperation({
  name: "invoice.create",
  description:
    "Start an invoice as a draft: whom it is for (a Person, or an Organisation with its contact " +
    "Person), an optional site address, the record it is about, a title, notes for the customer, " +
    "payment terms (the settings' by default) or a due date, and lines. A line is a record for " +
    "sale (a pass type, a ticket type, a price-list item), priced by the host, or a typed line " +
    "with a description, quantity, unit and unit price; each has a tax rate from the invoice " +
    "settings and an optional discount. The host works out each line's tax and the totals. A " +
    "draft has no number and changes freely: nothing is owed until a person issues it. Amounts " +
    "are integers in the currency's minor unit.",
  input: z.object({ ...invoiceFields, lines: createLines }),
  output: invoiceOutput,
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    const settings = await loadInvoiceSettings(ctx.db);
    return (await createDraft(ctx, "invoice", input, {
      kind: "standard",
      payment_terms_days: input.paymentTermsDays ?? settings.paymentTermsDays,
      due_on: input.dueOn ?? null,
    })) as z.infer<typeof invoiceOutput>;
  },
});

// --- Changing a draft -----------------------------------------------------------------------

async function updateDraft(
  ctx: HandlerContext,
  kind: DraftKind,
  id: string,
  input: DraftInput,
  own: Record<string, unknown>,
  version: number | undefined,
) {
  const doc = await loadDocument(ctx.db, kind, id);
  requireDraft(kind, doc);
  checkVersion(doc, version);
  const set = { ...(await draftColumns(ctx, input)), ...own };
  if (!Object.keys(set).length) throw new ValidationError(NO_CHANGE);
  const before = await linesOf(ctx.db, kind, id);
  const mode = (set.tax_mode as DocumentRow["tax_mode"] | undefined) ?? doc.tax_mode;
  const after = mode === doc.tax_mode ? before : repriced(before, mode);
  return writeDraft(ctx, kind, doc, set, before, after);
}

function checkVersion(doc: DocumentRow, version: number | undefined): void {
  if (version !== undefined && version !== doc.version) {
    throw new ConflictError(
      "The draft changed since you read it (someone else saved it). Look at it again.",
      { rule: "document_changed", version: doc.version },
    );
  }
}

const versionInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("The version you read: a draft changed since by someone else is refused");

export const quoteUpdate = defineOperation({
  name: "quote.update",
  description:
    "Change a draft quote: whom it is for, the site address, what it is about, title, notes, " +
    "valid-until, the deposit, or whether its amounts are typed with or without tax (its lines " +
    "are priced again). Only what is given changes; null clears. A sent quote is never changed: " +
    "it is withdrawn and a new one sent.",
  input: z.object({ id: quoteId, version: versionInput, ...quoteFields }),
  output: quoteOutput,
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    const own: Record<string, unknown> = {};
    if (input.validUntil !== undefined) own.valid_until = input.validUntil;
    if (input.deposit !== undefined) {
      own.deposit_kind = input.deposit.kind;
      own.deposit_value = input.deposit.value;
    }
    return (await updateDraft(ctx, "quote", input.id, input, own, input.version)) as z.infer<
      typeof quoteOutput
    >;
  },
});

export const invoiceUpdate = defineOperation({
  name: "invoice.update",
  description:
    "Change a draft invoice: whom it is for, the site address, what it is about, title, notes, " +
    "payment terms, the due date, or whether its amounts are typed with or without tax (its lines " +
    "are priced again). Only what is given changes; null clears. An issued invoice is never " +
    "changed: it is credited.",
  input: z.object({ id: invoiceId, version: versionInput, ...invoiceFields }),
  output: invoiceOutput,
  permission: "invoices:write",
  risk: "write",
  async handler(input, ctx) {
    const own: Record<string, unknown> = {};
    if (input.paymentTermsDays !== undefined) own.payment_terms_days = input.paymentTermsDays;
    if (input.dueOn !== undefined) own.due_on = input.dueOn;
    return (await updateDraft(ctx, "invoice", input.id, input, own, input.version)) as z.infer<
      typeof invoiceOutput
    >;
  },
});

// --- Lines ----------------------------------------------------------------------------------

const lineDescription = (kind: DraftKind) =>
  `Add a line to a draft ${kind}: a record for sale (item: its object and id), priced by the ` +
  "host from the record, or a typed line (description, quantity, unit, unitPrice in minor units, " +
  `as the ${kind}'s amounts are typed). Each line has a tax rate (a key from the invoice ` +
  "settings; left out, the default; null, no tax) and an optional discount (an amount or a " +
  "percentage, with why), taken off before the tax. The host works out the line's tax, rounded " +
  `half up, and the ${kind}'s totals by rate. At most ${DOCUMENT_MAX_LINES} lines.`;

function addLineOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.addLine` as `${K}.addLine`,
    description: lineDescription(kind),
    input: z.object({
      id: kind === "quote" ? quoteId : invoiceId,
      version: versionInput,
      line: lineInputSchema,
    }),
    output: kind === "quote" ? quoteOutput : invoiceOutput,
    permission: "invoices:write",
    risk: "write",
    async handler(input, ctx) {
      const doc = await loadDocument(ctx.db, kind, input.id);
      requireDraft(kind, doc);
      checkVersion(doc, input.version);
      const before = await linesOf(ctx.db, kind, doc.id);
      requireRoom(kind, before, 1);
      const settings = await loadInvoiceSettings(ctx.db);
      const position = before.reduce((max, l) => Math.max(max, l.position + 1), 0);
      const line = await newLine(ctx, kind, doc, settings, input.line, position);
      if (line.source === "record") await checkRecordLines(ctx, doc.currency, [...before, line]);
      return writeDraft(ctx, kind, doc, {}, before, [...before, line]);
    },
  });
}

function updateLineOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.updateLine` as `${K}.updateLine`,
    description:
      `Change a line of a draft ${kind}: its description, quantity, unit, unit price (a typed ` +
      "line's only: a record's line keeps the host's price), tax rate, discount (null removes " +
      "it) or position (the others move along). Only what is given changes. The host works out " +
      `the line's tax and the ${kind}'s totals again.`,
    input: z.object({ lineId, version: versionInput, change: lineChangeSchema }),
    output: kind === "quote" ? quoteOutput : invoiceOutput,
    permission: "invoices:write",
    risk: "write",
    async handler(input, ctx) {
      const { doc, lines, line } = await loadLine(ctx.db, kind, input.lineId);
      requireDraft(kind, doc);
      checkVersion(doc, input.version);
      if (!Object.values(input.change).some((v) => v !== undefined)) {
        throw new ValidationError(NO_CHANGE);
      }
      const settings = await loadInvoiceSettings(ctx.db);
      const changed = changedLine(line, input.change, settings, doc.tax_mode);
      const position = input.change.position;
      let after = lines.map((l) => (l.id === line.id ? changed : l));
      if (position !== undefined) {
        const others = renumbered(lines.filter((l) => l.id !== line.id));
        const at = Math.min(position, others.length);
        after = [...others.slice(0, at), changed, ...others.slice(at)].map((l, i) => ({
          ...l,
          position: i,
        }));
      }
      if (changed.source === "record" && input.change.quantity !== undefined) {
        await checkRecordLines(ctx, doc.currency, after);
      }
      return writeDraft(ctx, kind, doc, {}, lines, after);
    },
  });
}

function removeLineOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.removeLine` as `${K}.removeLine`,
    description: `Remove a line from a draft ${kind}. The others close up, and the totals are worked out again.`,
    input: z.object({ lineId, version: versionInput }),
    output: kind === "quote" ? quoteOutput : invoiceOutput,
    permission: "invoices:write",
    risk: "write",
    async handler(input, ctx) {
      const { doc, lines, line } = await loadLine(ctx.db, kind, input.lineId);
      requireDraft(kind, doc);
      checkVersion(doc, input.version);
      return writeDraft(
        ctx,
        kind,
        doc,
        {},
        lines,
        renumbered(lines.filter((l) => l.id !== line.id)),
      );
    },
  });
}

function deleteOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.delete` as `${K}.delete`,
    description:
      `Delete a draft ${kind} and its lines, for good. Only a draft: a ${kind} that has a number ` +
      (kind === "quote" ? "is withdrawn instead." : "is credited or voided instead."),
    input: z.object({ id: kind === "quote" ? quoteId : invoiceId, version: versionInput }),
    output: z.object({ id: z.string(), deleted: z.literal(true) }),
    permission: "invoices:write",
    risk: "write",
    async handler(input, ctx) {
      const doc = await loadDocument(ctx.db, kind, input.id);
      requireDraft(kind, doc);
      checkVersion(doc, input.version);
      const lines = await linesOf(ctx.db, kind, doc.id);
      const t = KIND_TABLES[kind];
      // biome-ignore lint/suspicious/noExplicitAny: the quote and invoice tables share these columns.
      const loose = ctx.db as any;
      ctx.write(
        // First the version read, moved by one: a draft changed meanwhile (a line added, sent or
        // issued) fails the whole batch here (core_document_stale), so nothing is deleted from a
        // document that is not the one read, and a delete is never reported that did not happen.
        loose
          .updateTable(t.doc)
          .set({ version: doc.version + 1, updated_at: ctx.now, updated_by: ctx.user.id })
          .where("id", "=", doc.id),
        ...lineWrites(ctx.db, kind, lines, []),
        // Refused by the trigger if it was sent or issued meanwhile (migration 1030).
        loose.deleteFrom(t.doc).where("id", "=", doc.id),
      );
      ctx.recordChange({
        object: kind,
        id: doc.id,
        action: "delete",
        before: auditSnapshot(doc, lines),
      });
      return { id: doc.id, deleted: true as const };
    },
  });
}

// --- Reading --------------------------------------------------------------------------------

function getOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.get` as `${K}.get`,
    description:
      `One ${kind} with its lines, totals by rate, whom it bills and (once ${kind === "quote" ? "sent" : "issued"}) ` +
      "its number and the bill-to as printed. Amounts are integers in the currency's minor unit. Read-only.",
    input: z.object({ id: kind === "quote" ? quoteId : invoiceId }),
    output: kind === "quote" ? quoteOutput : invoiceOutput,
    permission: "records:read",
    risk: "read",
    mcp: { idempotent: true },
    async handler(input, ctx) {
      const doc = await loadDocument(ctx.db, kind, input.id);
      const out = presentOf(kind, doc, await linesOf(ctx.db, kind, doc.id));
      // An issued invoice's money is its order's (stage 35 step 3, ADR 0731).
      if (kind !== "invoice" || !(doc as InvoiceRow).order_id) return out;
      const order = await loadOrderRow(ctx.db, (doc as InvoiceRow).order_id as string);
      return {
        ...out,
        money: {
          paid: order.paid,
          credited: order.credited,
          refunded: order.refunded,
          balance: owedOn(order),
          owedBack: (await creditRefunds(ctx, order.id))
            .filter((r) => r.state === "owed")
            .reduce((sum, r) => sum + r.amount, 0),
          orderState: order.state,
        },
      };
    },
  });
}

const listItem = z.object({
  id: z.string(),
  number: z.string().nullable(),
  state: z.string(),
  currency: z.string(),
  personId: z.string().nullable(),
  organisationId: z.string().nullable(),
  netTotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  validUntil: z.string().nullable().optional(),
  kind: z.enum(INVOICE_KINDS).optional(),
  issuedOn: z.string().nullable().optional(),
  dueOn: z.string().nullable().optional(),
});

function listOperation<K extends DraftKind>(kind: K) {
  return defineOperation({
    name: `${kind}.list` as `${K}.list`,
    description:
      `A page of ${kind}s, newest first unless sorted otherwise, without their lines (${kind}.get ` +
      "has them). Filter and sort on state, number, personId, organisationId, total, createdAt" +
      (kind === "quote" ? ", validUntil" : ", kind, issuedOn, dueOn") +
      ". Pass nextCursor back as cursor for the next page. Read-only.",
    input: z.object({
      filter: filterSchema.optional(),
      sort: sortSchema.optional(),
      cursor: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
    }),
    output: z.object({ items: z.array(listItem), nextCursor: z.string().nullable() }),
    permission: "records:read",
    risk: "read",
    mcp: { idempotent: true },
    async handler(input, ctx) {
      const page = await ctx.records.list(kind, input);
      const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
      return {
        items: page.items.map(({ id, values: v }) => ({
          id,
          number: str(v.number),
          state: String(v.state),
          currency: String(v.currency),
          personId: str(v.personId),
          organisationId: str(v.organisationId),
          netTotal: Number(v.netTotal ?? 0),
          taxTotal: Number(v.taxTotal ?? 0),
          total: Number(v.total ?? 0),
          createdAt: String(v.createdAt),
          updatedAt: String(v.updatedAt),
          ...(kind === "quote"
            ? { validUntil: str(v.validUntil) }
            : {
                kind: v.kind as (typeof INVOICE_KINDS)[number],
                issuedOn: str(v.issuedOn),
                dueOn: str(v.dueOn),
              }),
        })),
        nextCursor: page.nextCursor,
      };
    },
  });
}

// --- Settings -------------------------------------------------------------------------------

const seriesOutput = z.object({
  series: z.enum(SERIES),
  prefix: z.string(),
  nextNumber: z.number(),
  next: z.string().describe("The next number as it will be printed"),
  version: z.number().describe("Pass it back to change the series"),
});

const settingsOutput = invoiceSettingsSchema.extend({ series: z.array(seriesOutput) });

async function settingsOf(ctx: HandlerContext) {
  const [settings, series] = await Promise.all([loadInvoiceSettings(ctx.db), loadSeries(ctx.db)]);
  return {
    ...settings,
    series: series.map((s) => ({
      series: s.series,
      prefix: s.prefix,
      nextNumber: s.nextNumber,
      next: formatNumber(s.prefix, s.nextNumber),
      version: s.version,
    })),
  };
}

export const invoiceSettingsGet = defineOperation({
  name: "invoice.settings.get",
  description:
    "The invoice settings: the business's details and bank details as printed on documents, its " +
    "tax rates (key, label, rate in hundredths of a percent, retired) and the default, whether " +
    "amounts are typed with or without tax, payment terms, quote validity, deposit invoices' " +
    "terms, the reminder schedule, the threshold over which a recorded payment tells the admins, " +
    "the PDF footer, how long documents are kept, and each numbering series (prefix, next number, " +
    "version). Read-only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  redactResult: ["bank"],
  handler: (_input, ctx) => settingsOf(ctx),
});

const seriesChange = z.object({
  series: z.enum(SERIES),
  version: z.number().int().min(0).describe("The series' version from invoice.settings.get"),
  prefix: z
    .string()
    .regex(PREFIX_RE, "Up to 12 letters, digits, - / or .")
    .optional()
    .describe("Printed before the number: INV-, Q-, CN-"),
  nextNumber: z
    .number()
    .int()
    .min(1)
    .max(MAX_NUMBER)
    .optional()
    .describe("Only ever raised: to carry on from the numbers used before"),
});

/** Which tax rate keys lines use: on any document, and on one sent or issued. */
async function ratesInUse(ctx: HandlerContext, keys: string[]) {
  const used = new Set<string>();
  const issued = new Set<string>();
  if (!keys.length) return { used, issued };
  for (const [line, doc, fk] of [
    ["core_quote_line", "core_quote", "quote_id"],
    ["core_invoice_line", "core_invoice", "invoice_id"],
    ["core_credit_note_line", "core_credit_note", "credit_note_id"],
  ] as const) {
    const { rows } = await sql<{ key: string; issued: number }>`SELECT l.tax_key AS key,
        MAX(d.state != 'draft') AS issued
      FROM ${sql.table(line)} l JOIN ${sql.table(doc)} d ON d.id = ${sql.ref(`l.${fk}`)}
      WHERE l.tax_key IN (${sql.join(keys)})
      GROUP BY l.tax_key`.execute(ctx.db);
    for (const row of rows) {
      used.add(row.key);
      if (Number(row.issued) === 1) issued.add(row.key);
    }
  }
  return { used, issued };
}

/** Why `next` cannot replace `previous` (ADR 0732): a rate never changes, and stays once used. */
async function checkRates(
  ctx: HandlerContext,
  previous: InvoiceSettings["taxRates"],
  next: InvoiceSettings["taxRates"],
): Promise<void> {
  const keys = next.map((r) => r.key);
  if (new Set(keys).size !== keys.length) {
    throw new ValidationError("Each tax rate has its own key", { field: "taxRates" });
  }
  const { used, issued } = await ratesInUse(
    ctx,
    previous.map((r) => r.key),
  );
  for (const old of previous) {
    const now = next.find((r) => r.key === old.key);
    if (!now) {
      if (used.has(old.key)) {
        throw new ValidationError(
          `The tax rate ${old.key} is on documents: retire it instead of removing it`,
          { field: "taxRates", rule: "tax_rate_in_use", key: old.key },
        );
      }
      continue;
    }
    if (now.rate !== old.rate) {
      throw new ValidationError(
        `A tax rate never changes: retire ${old.key} and add the new rate under a new key`,
        { field: "taxRates", rule: "tax_rate_fixed", key: old.key },
      );
    }
    if (now.label !== old.label && issued.has(old.key)) {
      throw new ValidationError(
        `The tax rate ${old.key} is on documents already sent or issued: its label stays. Retire it and add a new key`,
        { field: "taxRates", rule: "tax_rate_fixed", key: old.key },
      );
    }
  }
}

export const invoiceSettingsUpdate = defineOperation({
  name: "invoice.settings.update",
  description:
    "Change the invoice settings: the business's details and bank details printed on documents, " +
    "its tax rates (a rate never changes once saved: retire it and add a new key; a rate on any " +
    "document is retired, never removed), the default rate, whether amounts are typed with or " +
    "without tax, payment terms, quote validity, deposit invoices' terms, the reminder schedule " +
    "(or reminders off), the threshold over which a recorded payment tells the admins, the PDF " +
    "footer, how long documents are kept, and a numbering series' prefix and next number (only " +
    "ever raised, naming the series' version). Only what is given changes. Documents already sent " +
    "or issued keep what they were issued with. A change to the bank details is told to every " +
    "admin. Admins only, and only a person: AI assistants, MCP clients, automations and " +
    "extensions are refused.",
  input: z.object({
    business: businessSchema.optional(),
    bank: z.array(bankDetailSchema).max(8).optional().describe("Replaces the bank details"),
    taxRates: z.array(taxRateSchema).max(20).optional().describe("Replaces the list of rates"),
    defaultTaxRate: z.string().min(1).max(32).nullable().optional(),
    amountsIncludeTax: z.boolean().optional(),
    paymentTermsDays: invoiceSettingsSchema.shape.paymentTermsDays.optional(),
    quoteValidDays: invoiceSettingsSchema.shape.quoteValidDays.optional(),
    depositDueDays: invoiceSettingsSchema.shape.depositDueDays.optional(),
    reminders: invoiceSettingsSchema.shape.reminders.optional(),
    recordedPaymentNoticeOver: invoiceSettingsSchema.shape.recordedPaymentNoticeOver.optional(),
    pdfFooter: invoiceSettingsSchema.shape.pdfFooter.optional(),
    retentionYears: invoiceSettingsSchema.shape.retentionYears.optional(),
    series: z.array(seriesChange).max(3).optional(),
  }),
  output: settingsOutput,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["bank"],
  redactResult: ["bank"],
  auditSummary: (output) => ({
    bank: maskedBank(output.bank),
    series: output.series.map((s) => `${s.series}: ${s.next}`),
  }),
  async handler(input, ctx) {
    const { series: seriesInput, ...rest } = input;
    if (Object.values(input).every((v) => v === undefined)) throw new ValidationError(NO_CHANGE);
    const previous = await loadInvoiceSettings(ctx.db);
    const next: InvoiceSettings = { ...previous };
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    if (input.reminders) {
      next.reminders = {
        on: input.reminders.on,
        days: [...new Set(input.reminders.days)].sort((a, b) => a - b),
      };
    }
    if (input.taxRates) await checkRates(ctx, previous.taxRates, input.taxRates);
    if (next.defaultTaxRate !== null) {
      const rate = next.taxRates.find((r) => r.key === next.defaultTaxRate);
      if (!rate || rate.retired) {
        throw new ValidationError("The default tax rate is one of the live rates, or none", {
          field: "defaultTaxRate",
          rule: "unknown_tax_rate",
        });
      }
    }
    const value = JSON.stringify(next);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: INVOICE_SETTINGS, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    const bankChanged = JSON.stringify(previous.bank) !== JSON.stringify(next.bank);
    const shown = (s: InvoiceSettings) => ({ ...s, bank: maskedBank(s.bank) });
    ctx.recordChange({
      object: "settings",
      id: INVOICE_SETTINGS,
      action: "update",
      before: shown(previous),
      after: shown(next),
    });
    if (bankChanged) {
      // Changed bank details are a known way to divert payments: every admin hears of it.
      const plan = await notifyStatements(
        ctx.db,
        {
          to: [{ role: "admin" }],
          type: "system.message",
          title: "The bank details on invoices were changed",
          body:
            `${ctx.user.name} changed the bank details printed on quotes and invoices. ` +
            "Invoices already issued keep the details they were issued with. If you did not " +
            "expect this, look at Settings → Invoices now.",
          source: { actor: ctx.actor, userId: ctx.user.id },
        },
        ctx.now,
      );
      ctx.write(...plan.statements);
    }
    const rows = await loadSeries(ctx.db);
    const changes = new Set<Series>();
    for (const change of seriesInput ?? []) {
      if (changes.has(change.series)) {
        throw new ValidationError(`The ${change.series} series is named twice`, {
          field: "series",
        });
      }
      changes.add(change.series);
      const row = rows.find((r) => r.series === change.series);
      if (!row) continue;
      if (change.version !== row.version) {
        throw new ConflictError(
          `The ${change.series} series moved on since you read it (a number was given). Look at it again.`,
          { rule: "document_numbering", series: change.series, version: row.version },
        );
      }
      if (change.nextNumber !== undefined && change.nextNumber < row.nextNumber) {
        throw new ValidationError(
          `The next ${change.series} number only goes up: it is ${row.nextNumber} now`,
          { field: "series", rule: "number_down", next: row.nextNumber },
        );
      }
      if (change.prefix === undefined && change.nextNumber === undefined) continue;
      ctx.write(seriesStatement(ctx.db, row, change, ctx.user.id, ctx.now));
      ctx.recordChange({
        object: "settings",
        id: `document_series:${change.series}`,
        action: "update",
        before: { prefix: row.prefix, nextNumber: row.nextNumber },
        after: {
          prefix: change.prefix ?? row.prefix,
          nextNumber: change.nextNumber ?? row.nextNumber,
        },
      });
    }
    return ctx.afterCommit(() => settingsOf(ctx));
  },
});

// --- The event log --------------------------------------------------------------------------

export const invoiceEvents = defineOperation({
  name: "invoice.events",
  description:
    "The document event log, oldest first after a cursor: one row per quote sent, invoice or " +
    "credit note issued, payment applied or reversed (with its payment row and method), credit, " +
    "refund confirmed, payment paid back and void, each with its amount and when. Rows are " +
    "never changed or removed and seq only grows: pass the last seq you read as after. For the " +
    "books and finance reports. Read-only.",
  input: z.object({
    after: z.number().int().min(0).default(0).describe("The last seq read; 0 from the start"),
    limit: z.number().int().min(1).max(EVENTS_PAGE_MAX).default(100),
  }),
  output: z.object({
    items: z.array(
      z.object({
        seq: z.number(),
        documentKind: z.enum(DOCUMENT_KINDS),
        documentId: z.string(),
        invoiceId: z.string().nullable(),
        event: z.enum(INVOICE_EVENTS),
        paymentId: z.string().nullable(),
        method: z.string().nullable(),
        amount: z.number().nullable(),
        currency: z.string().nullable(),
        at: z.string(),
        byUser: z.string().nullable(),
      }),
    ),
    last: z.number().describe("The last seq returned (after, when none): the next call's after"),
  }),
  permission: "invoices:payments",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await eventsAfter(ctx.db, input.after, input.limit);
    return {
      items: rows.map((r) => ({
        seq: r.seq,
        documentKind: r.document_kind,
        documentId: r.document_id,
        invoiceId: r.invoice_id,
        event: r.event,
        paymentId: r.payment_id,
        method: r.method,
        amount: r.amount,
        currency: r.currency,
        at: r.at,
        byUser: r.by_user,
      })),
      last: rows.at(-1)?.seq ?? input.after,
    };
  },
});

export const invoiceOperations = [
  quoteCreate,
  quoteUpdate,
  addLineOperation("quote"),
  updateLineOperation("quote"),
  removeLineOperation("quote"),
  deleteOperation("quote"),
  getOperation("quote"),
  listOperation("quote"),
  invoiceCreate,
  invoiceUpdate,
  addLineOperation("invoice"),
  updateLineOperation("invoice"),
  removeLineOperation("invoice"),
  deleteOperation("invoice"),
  getOperation("invoice"),
  listOperation("invoice"),
  invoiceSettingsGet,
  invoiceSettingsUpdate,
  invoiceEvents,
] as const;
