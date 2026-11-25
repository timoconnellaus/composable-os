// Drafts of quotes and invoices (stage 35 step 2, ADRs 0730 and 0732): what the draft operations
// share. A draft is written only by staff with invoices:write (and the assistant for them,
// through the gate); a customer, the public and an extension's own account hold no such
// permission. A line comes from a record of a sellable object, priced by the host when it is
// added (the same read an order's line has, `priceLines`), or is typed by staff. Every write of a
// draft moves its `version` by one from the one read (compare-and-set: core_document_stale), and
// recomputes the totals from the lines, so a document's figures are always its lines' sum.
import type {
  CoreDatabase,
  CoreInvoiceLineTable,
  CoreInvoiceTable,
  CoreQuoteTable,
} from "@composable-os/db";
import type { Compilable, Kysely, Selectable } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import {
  creditNoteObject,
  type InvoiceKind,
  invoiceObject,
  quoteObject,
  type TaxMode,
} from "../fields/invoice.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { type IdKind, newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { applyGoodsRules } from "../orders/goods.ts";
import {
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  type PricedLine,
  priceLines,
} from "../orders/orders.ts";
import { viewRow } from "../orders/sellable.ts";
import { orgReader, type Viewer, visibleSource } from "../visibility/index.ts";
import { type InvoiceSettings, rateFor, type TaxRate } from "./settings.ts";
import { type Discount, documentTotals, lineAmounts, unitPriceFromRecord } from "./tax.ts";

/**
 * The most lines a document holds: an order's (an issued invoice is one order line per line,
 * stage 35 step 3), so every draft can be issued, and every write of one stays far inside D1's
 * limits.
 */
export const DOCUMENT_MAX_LINES = ORDER_MAX_LINES;
/** The most of one line: ten thousand hours, metres or units. */
export const LINE_MAX_QUANTITY = 10_000;
/** The most one unit costs, in minor units (a million in a two-decimal currency). */
export const LINE_MAX_UNIT_PRICE = 100_000_000;

export type DraftKind = "quote" | "invoice";

export type QuoteRow = Selectable<CoreQuoteTable>;
export type InvoiceRow = Selectable<CoreInvoiceTable>;
export type DocumentRow = QuoteRow | InvoiceRow;
/** A quote's line has the same columns as an invoice's, with quote_id for invoice_id. */
export type LineRow = Omit<
  Selectable<CoreInvoiceLineTable>,
  "invoice_id" | "deducts_invoice_id"
> & {
  document_id: string;
  deducts_invoice_id: string | null;
};

interface KindTables {
  doc: "core_quote" | "core_invoice";
  line: "core_quote_line" | "core_invoice_line";
  fk: "quote_id" | "invoice_id";
  id: IdKind;
  lineId: IdKind;
  label: string;
}

export const KIND_TABLES: Record<DraftKind, KindTables> = {
  quote: {
    doc: "core_quote",
    line: "core_quote_line",
    fk: "quote_id",
    id: "quote",
    lineId: "quoteLine",
    label: "quote",
  },
  invoice: {
    doc: "core_invoice",
    line: "core_invoice_line",
    fk: "invoice_id",
    id: "invoice",
    lineId: "invoiceLine",
    label: "invoice",
  },
};

// biome-ignore lint/suspicious/noExplicitAny: the quote and invoice tables share these columns; one builder writes either.
type LooseDb = Kysely<any>;
const loose = (db: Kysely<CoreDatabase>) => db as unknown as LooseDb;

// --- Inputs ---------------------------------------------------------------------------------

const quantitySchema = z
  .number()
  .positive()
  .max(LINE_MAX_QUANTITY)
  .refine(
    (q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6,
    "A quantity has at most three decimals",
  )
  .describe("How many: up to three decimals, for hours and metres");

export const discountSchema = z
  .object({
    kind: z.enum(["amount", "percent"]),
    value: z
      .number()
      .int()
      .min(1)
      .max(LINE_MAX_UNIT_PRICE * 100)
      .describe("An amount in minor units, or hundredths of a percent (1000 = 10%)"),
    reason: z.string().trim().min(1).max(200).describe("Why: printed for staff, kept in the audit"),
  })
  .refine((d) => d.kind === "amount" || d.value <= 10000, "A percentage is at most 100%");

const taxRateKey = z
  .string()
  .min(1)
  .max(32)
  .nullable()
  .describe("A tax rate's key from the invoice settings; null for no tax; left out: the default");

export const lineInputSchema = z.object({
  item: z
    .object({
      object: z.string().min(1).max(80).describe("A sellable object: a pass type, a ticket type"),
      id: z.string().min(1).max(64),
    })
    .optional()
    .describe("A record for sale: the host reads its price. Left out: a typed line"),
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("What it is, as printed. A record's line defaults to its title"),
  quantity: quantitySchema.default(1),
  unit: z.string().trim().min(1).max(20).nullable().optional().describe("hours, m, each"),
  unitPrice: z
    .number()
    .int()
    .min(0)
    .max(LINE_MAX_UNIT_PRICE)
    .optional()
    .describe(
      "A typed line's price for one, in minor units, as amounts are typed on this document (with or without tax)",
    ),
  taxRate: taxRateKey.optional(),
  discount: discountSchema.nullable().optional().describe("Money off this line, before its tax"),
});
export type LineInput = z.infer<typeof lineInputSchema>;

export const lineChangeSchema = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  quantity: quantitySchema.optional(),
  unit: z.string().trim().min(1).max(20).nullable().optional(),
  unitPrice: z.number().int().min(0).max(LINE_MAX_UNIT_PRICE).optional(),
  taxRate: taxRateKey.optional(),
  discount: discountSchema.nullable().optional(),
  position: z.number().int().min(0).max(DOCUMENT_MAX_LINES).optional(),
});
export type LineChange = z.infer<typeof lineChangeSchema>;

export const billToSchema = z
  .object({
    personId: z
      .string()
      .min(1)
      .max(64)
      .describe("The Person billed, or the organisation's contact Person"),
    organisationId: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe("The Organisation billed, with personId as its contact"),
  })
  .describe("Whom the document is addressed to");

export const aboutSchema = z
  .object({ object: z.string().min(1).max(80), id: z.string().min(1).max(64) })
  .describe("Any record the document is about: a deal, a booking, later a job");

// --- Outputs --------------------------------------------------------------------------------

export const lineOutput = z.object({
  id: z.string(),
  position: z.number(),
  description: z.string(),
  quantity: z.number(),
  unit: z.string().nullable(),
  unitPrice: z.number().describe("For one, in minor units, as the document's amounts are typed"),
  taxRate: z.object({ key: z.string(), label: z.string(), rate: z.number() }).nullable(),
  discount: z
    .object({
      kind: z.enum(["amount", "percent"]),
      value: z.number(),
      reason: z.string(),
      amount: z.number().describe("What it took off, in minor units"),
    })
    .nullable(),
  net: z.number(),
  tax: z.number(),
  total: z.number(),
  source: z.enum(["record", "custom", "deduction"]),
  item: z.object({ object: z.string(), id: z.string() }).nullable(),
});

export const rateTotalOutput = z.object({
  key: z.string(),
  label: z.string(),
  rate: z.number(),
  net: z.number(),
  tax: z.number(),
  total: z.number(),
});

const documentBase = z.object({
  id: z.string(),
  state: z.string(),
  number: z.string().nullable().describe("Given when sent or issued; null on a draft"),
  currency: z.string(),
  taxMode: z.enum(["exclusive", "inclusive"]),
  billTo: z.object({
    personId: z.string().nullable(),
    organisationId: z.string().nullable(),
    printed: z
      .object({
        name: z.string().nullable(),
        address: z.string().nullable(),
        taxNumber: z.string().nullable(),
        email: z.string().nullable(),
      })
      .nullable()
      .describe("As printed, fixed when sent or issued"),
  }),
  siteAddress: z.string().nullable(),
  about: z.object({ object: z.string(), id: z.string() }).nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(lineOutput),
  netTotal: z.number(),
  taxTotal: z.number(),
  total: z.number(),
  taxByRate: z.array(rateTotalOutput),
  version: z.number().describe("Moves with every write"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const quoteOutput = documentBase.extend({
  state: z.enum(["draft", "sent", "accepted", "declined", "expired", "withdrawn"]),
  validUntil: z.string().nullable(),
  deposit: z.object({ kind: z.enum(["none", "amount", "percent"]), value: z.number().nullable() }),
  replacesQuoteId: z.string().nullable(),
  sentAt: z.string().nullable(),
});

export const invoiceOutput = documentBase.extend({
  state: z.enum(["draft", "issued", "sent", "part_paid", "paid", "credited", "void"]),
  kind: z.enum(["standard", "deposit", "final"]),
  quoteId: z.string().nullable(),
  orderId: z.string().nullable(),
  paymentTermsDays: z.number(),
  issuedOn: z.string().nullable(),
  dueOn: z.string().nullable().describe("Set on a draft, or worked out at issue from the terms"),
  allowPartPayments: z.boolean(),
  remindersPaused: z.boolean(),
  money: z
    .object({
      paid: z.number(),
      credited: z.number().describe("What credit notes took off what was owed"),
      refunded: z.number().describe("What has gone back, confirmed or recorded"),
      balance: z.number().describe("What is still owed: total less paid less credited"),
      owedBack: z
        .number()
        .describe("What credit notes give back that has not gone back yet, nor waits for approval"),
      orderState: z.string(),
    })
    .nullable()
    .optional()
    .describe("Once issued (invoice.get): its order's money"),
});

const parseRates = (json: string) => {
  try {
    return z.array(rateTotalOutput).parse(JSON.parse(json));
  } catch {
    return [];
  }
};

function presentLine(line: LineRow): z.infer<typeof lineOutput> {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: line.quantity_milli / 1000,
    unit: line.unit,
    unitPrice: line.unit_price,
    taxRate:
      line.tax_key === null
        ? null
        : { key: line.tax_key, label: line.tax_label ?? line.tax_key, rate: line.tax_rate },
    discount:
      line.discount_kind === null || line.discount_value === null
        ? null
        : {
            kind: line.discount_kind,
            value: line.discount_value,
            reason: line.discount_reason ?? "",
            amount: line.discount,
          },
    net: line.line_net,
    tax: line.line_tax,
    total: line.line_total,
    source: line.source,
    item:
      line.source_object && line.source_id
        ? { object: line.source_object, id: line.source_id }
        : null,
  };
}

function presentBase(doc: DocumentRow, lines: readonly LineRow[]) {
  return {
    id: doc.id,
    number: doc.number,
    currency: doc.currency,
    taxMode: doc.tax_mode,
    billTo: {
      personId: doc.person_id,
      organisationId: doc.organisation_id,
      printed:
        doc.state === "draft"
          ? null
          : {
              name: doc.bill_to_name,
              address: doc.bill_to_address,
              taxNumber: doc.bill_to_tax_number,
              email: doc.bill_to_email,
            },
    },
    siteAddress: doc.site_address,
    about: doc.about_object && doc.about_id ? { object: doc.about_object, id: doc.about_id } : null,
    title: doc.title,
    notes: doc.notes,
    lines: [...lines].sort((a, b) => a.position - b.position).map(presentLine),
    netTotal: doc.net_total,
    taxTotal: doc.tax_total,
    total: doc.total,
    taxByRate: parseRates(doc.tax_by_rate),
    version: doc.version,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function presentQuote(
  doc: QuoteRow,
  lines: readonly LineRow[],
): z.infer<typeof quoteOutput> {
  return {
    ...presentBase(doc, lines),
    state: doc.state,
    validUntil: doc.valid_until,
    deposit: { kind: doc.deposit_kind, value: doc.deposit_value },
    replacesQuoteId: doc.replaces_quote_id,
    sentAt: doc.sent_at,
  };
}

export function presentInvoice(
  doc: InvoiceRow,
  lines: readonly LineRow[],
): z.infer<typeof invoiceOutput> {
  return {
    ...presentBase(doc, lines),
    state: doc.state,
    kind: doc.kind as InvoiceKind,
    quoteId: doc.quote_id,
    orderId: doc.order_id,
    paymentTermsDays: doc.payment_terms_days,
    issuedOn: doc.issued_on,
    dueOn: doc.due_on,
    allowPartPayments: doc.allow_part_payments === 1,
    remindersPaused: doc.reminders_paused === 1,
  };
}

/** What the audit log keeps of a document: its figures and whom it bills, never its text. */
export function auditSnapshot(
  doc: DocumentRow,
  lines: readonly LineRow[],
): Record<string, unknown> {
  return {
    state: doc.state,
    currency: doc.currency,
    taxMode: doc.tax_mode,
    personId: doc.person_id,
    organisationId: doc.organisation_id,
    lines: lines.length,
    netTotal: doc.net_total,
    taxTotal: doc.tax_total,
    total: doc.total,
  };
}

// --- Reading --------------------------------------------------------------------------------

/** The base object of a kind of document, as the seam knows it (fields/invoice.ts). */
export function documentObject(kind: DraftKind | "creditNote"): ObjectDefinition {
  const fallback =
    kind === "quote" ? quoteObject : kind === "invoice" ? invoiceObject : creditNoteObject;
  return getObject(fallback.name) ?? fallback;
}

/**
 * Whether the document `id` of `kind` is one `reader` may see, through the seam (its `rec_*`
 * view). The document's own columns that the view leaves out (the bill-to as printed, its notes,
 * its snapshot, its version) are read from its table after it, by the callers below.
 */
export async function documentVisible(
  db: Kysely<CoreDatabase>,
  reader: Viewer,
  kind: DraftKind | "creditNote",
  id: string,
): Promise<boolean> {
  return Boolean(await viewRow(db, visibleSource(reader, documentObject(kind)), id));
}

/**
 * The document, whole, as host code reads it (staff only; ADR 0730): first through the seam,
 * org-wide, then its table for the columns its view leaves out.
 */
export async function loadDocument<K extends DraftKind>(
  db: Kysely<CoreDatabase>,
  kind: K,
  id: string,
  /** Whose read it is: the caller's (`ctx`) for a caller's operation; org-wide for host code. */
  reader: Viewer = orgReader(db),
): Promise<K extends "quote" ? QuoteRow : InvoiceRow> {
  if (!(await documentVisible(db, reader, kind, id))) {
    throw new NotFoundError(KIND_TABLES[kind].label, id);
  }
  const row =
    kind === "quote"
      ? await db.selectFrom("core_quote").selectAll().where("id", "=", id).executeTakeFirst()
      : await db.selectFrom("core_invoice").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new NotFoundError(KIND_TABLES[kind].label, id);
  return row as K extends "quote" ? QuoteRow : InvoiceRow;
}

/** A document's lines: parts of a document read through `loadDocument` first. */
export async function linesOf(
  db: Kysely<CoreDatabase>,
  kind: DraftKind,
  id: string,
): Promise<LineRow[]> {
  if (kind === "quote") {
    const rows = await db
      .selectFrom("core_quote_line")
      .selectAll()
      .where("quote_id", "=", id)
      .orderBy("position")
      .limit(DOCUMENT_MAX_LINES + 1)
      .execute();
    return rows.map(({ quote_id, ...row }) => ({
      ...row,
      document_id: quote_id,
      deducts_invoice_id: null,
    }));
  }
  const rows = await db
    .selectFrom("core_invoice_line")
    .selectAll()
    .where("invoice_id", "=", id)
    .orderBy("position")
    .limit(DOCUMENT_MAX_LINES + 1)
    .execute();
  return rows.map(({ invoice_id, ...row }) => ({ ...row, document_id: invoice_id }));
}

/** The line `lineId` and the draft it is on. */
export async function loadLine(
  db: Kysely<CoreDatabase>,
  kind: DraftKind,
  lineId: string,
  reader: Viewer = orgReader(db),
): Promise<{ doc: DocumentRow; lines: LineRow[]; line: LineRow }> {
  const t = KIND_TABLES[kind];
  // The documents the caller may read, through the seam, first; then the line among their parts
  // (review of PR #460): a line id from input never reaches a table on its own.
  const docs = visibleSource(reader, documentObject(kind));
  const view = documentObject(kind).source;
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const anyDb = db as any;
  const found = (
    kind === "quote"
      ? await anyDb
          .selectFrom(docs)
          .innerJoin("core_quote_line as l", "l.quote_id", `${view}.id`)
          .select(`${view}.id as doc`)
          .where("l.id", "=", lineId)
          .executeTakeFirst()
      : await anyDb
          .selectFrom(docs)
          .innerJoin("core_invoice_line as l", "l.invoice_id", `${view}.id`)
          .select(`${view}.id as doc`)
          .where("l.id", "=", lineId)
          .executeTakeFirst()
  ) as { doc: string } | undefined;
  if (!found) throw new NotFoundError(`${t.label} line`, lineId);
  const doc = await loadDocument(db, kind, found.doc, reader);
  const lines = await linesOf(db, kind, doc.id);
  const line = lines.find((l) => l.id === lineId);
  if (!line) throw new NotFoundError(`${t.label} line`, lineId);
  return { doc, lines, line };
}

/** A draft is the only document anyone changes: a sent or issued one is final. */
export function requireDraft(kind: DraftKind, doc: DocumentRow): void {
  if (doc.state !== "draft") {
    throw new ConflictError(
      kind === "quote"
        ? "This quote has been sent: it is never changed. Withdraw it and send a new one."
        : "This invoice has been issued: it is never changed. Credit it instead.",
      { rule: "document_immutable", state: doc.state },
    );
  }
}

// --- Checking what a draft names ------------------------------------------------------------

/** The bill-to exists and is out of the Trash; an organisation always has its contact Person. */
export async function checkBillTo(
  ctx: HandlerContext,
  billTo: z.infer<typeof billToSchema>,
): Promise<{ person_id: string; organisation_id: string | null }> {
  await ctx.records.get("person", billTo.personId);
  if (billTo.organisationId) {
    await ctx.records.get("organisation", billTo.organisationId);
    // The contact is someone at the organisation: a customer later sees their organisation's
    // documents where they are its named contact (stage 35 step 8).
    const link = await ctx.db
      .selectFrom("core_affiliation")
      .select("id")
      .where("person_id", "=", billTo.personId)
      .where("organisation_id", "=", billTo.organisationId)
      .where("is_current", "=", 1)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!link) {
      throw new ValidationError(
        "The contact Person is not someone at this organisation: link them to it first",
        { field: "billTo", rule: "contact_not_at_organisation" },
      );
    }
  }
  return { person_id: billTo.personId, organisation_id: billTo.organisationId ?? null };
}

/** The record a document is about exists, and the caller may read it. */
export async function checkAbout(
  ctx: HandlerContext,
  about: z.infer<typeof aboutSchema>,
): Promise<{ about_object: string; about_id: string }> {
  if (!getObject(about.object)) {
    throw new ValidationError(`There is no object called ${about.object}`, {
      field: "about",
      rule: "unknown_object",
    });
  }
  await ctx.records.get(about.object, about.id);
  return { about_object: about.object, about_id: about.id };
}

// --- Lines ----------------------------------------------------------------------------------

function liveRate(settings: InvoiceSettings, key: string | null | undefined): TaxRate | null {
  const rate = rateFor(settings, key);
  if (key && !rate) {
    throw new ValidationError(`There is no tax rate ${key} in the invoice settings`, {
      field: "taxRate",
      rule: "unknown_tax_rate",
    });
  }
  if (rate?.retired) {
    throw new ValidationError(`The tax rate ${rate.key} is retired: no new line uses it`, {
      field: "taxRate",
      rule: "retired_tax_rate",
    });
  }
  return rate;
}

/** A line's amounts and rate columns, from its terms and the document's mode. */
function priced(
  line: Omit<LineRow, "discount" | "line_net" | "line_tax" | "line_total">,
  mode: TaxMode,
): LineRow {
  const discount: Discount | null =
    line.discount_kind && line.discount_value !== null
      ? { kind: line.discount_kind, value: line.discount_value }
      : null;
  const amounts = lineAmounts({
    unitPrice: line.unit_price,
    quantityMilli: line.quantity_milli,
    rate: line.tax_rate,
    mode,
    discount,
  });
  return {
    ...line,
    discount: amounts.discount,
    line_net: amounts.net,
    line_tax: amounts.tax,
    line_total: amounts.total,
  };
}

const milli = (quantity: number) => Math.round(quantity * 1000);

/** A record's line is whole units, at most an order line's most (an invoice's line is one). */
function recordQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity > ORDER_MAX_QUANTITY) {
    throw new ValidationError(
      `A line for a record is a whole number of units, at most ${ORDER_MAX_QUANTITY}`,
      { field: "quantity", rule: "whole_units", max: ORDER_MAX_QUANTITY },
    );
  }
}

/**
 * The document's record lines, checked together as the one order an invoice becomes (stage 35
 * step 3): the same item on two lines, more than a record's most per order, more grants than an
 * order holds, a record no longer for sale, and the goods rules (ADR 0682): goods are sold on an
 * order with a delivery, which a document does not choose, so a goods record is refused on one
 * (a typed line describes goods handed over another way). The same rules, by the same code, as
 * `order.start`, so a draft that passes can be issued; `invoice.issue` runs them again, through
 * `createOrder`. Every write that adds or changes a record's line asks. Returns the lines priced.
 */
export async function checkRecordLines(
  ctx: HandlerContext,
  currency: string,
  lines: readonly LineRow[],
): Promise<PricedLine[]> {
  const requests = lines
    .filter((l) => l.source === "record" && l.source_object && l.source_id)
    .map((l) => ({
      object: l.source_object as string,
      id: l.source_id as string,
      quantity: l.quantity_milli / 1000,
    }));
  if (!requests.length) return [];
  const priced = await priceLines(ctx.db, requests, currency, ctx.now);
  try {
    await applyGoodsRules(ctx.db, priced, undefined, "start");
  } catch (error) {
    const rule = (error as { details?: { rule?: unknown } } | undefined)?.details?.rule;
    if (error instanceof ValidationError && rule === "delivery_needed") {
      const goods = priced.find((line) => line.goods);
      throw new ValidationError(
        `${goods?.title ?? "This"} is goods, sold on an order with a delivery, which a ${KIND_TABLES.invoice.label} does not choose: sell it with an order, or type the line`,
        { field: "lines", rule: "goods_need_delivery", line: goods?.position ?? null },
      );
    }
    throw error;
  }
  return priced;
}

/**
 * A new line for `doc`: a record's (priced by the host, as an order's line is) or a typed one.
 * Nobody outside the staff writes a draft, so a typed price is a person on the staff's (or the
 * assistant's, for them, through the gate).
 */
export async function newLine(
  ctx: HandlerContext,
  kind: DraftKind,
  doc: DocumentRow,
  settings: InvoiceSettings,
  input: LineInput,
  position: number,
): Promise<LineRow> {
  const rate = liveRate(settings, input.taxRate);
  const quantityMilli = milli(input.quantity);
  const base = {
    id: newId(KIND_TABLES[kind].lineId),
    document_id: doc.id,
    position,
    quantity_milli: quantityMilli,
    unit: input.unit ?? null,
    tax_key: rate?.key ?? null,
    tax_label: rate ? rate.label : null,
    tax_rate: rate?.rate ?? 0,
    discount_kind: input.discount?.kind ?? null,
    discount_value: input.discount?.value ?? null,
    discount_reason: input.discount?.reason ?? null,
    deducts_invoice_id: null,
    source_category: null,
    created_at: ctx.now,
  };
  if (input.item) {
    if (input.unitPrice !== undefined) {
      throw new ValidationError(
        "A record's line is priced by the host from the record: give no unitPrice (a discount takes money off)",
        { field: "unitPrice", rule: "priced_by_host" },
      );
    }
    recordQuantity(input.quantity);
    // The same read an order's line has (ADR 0427): the host's price, in the document's currency.
    // The whole document's record lines are checked together as one order's by `checkRecordLines`.
    const [line] = await priceLines(
      ctx.db,
      [{ object: input.item.object, id: input.item.id, quantity: input.quantity }],
      doc.currency,
      ctx.now,
    );
    if (!line) throw new ValidationError("This cannot be bought", { rule: "not_for_sale" });
    return priced(
      {
        ...base,
        description: input.description ?? line.title,
        unit_price: unitPriceFromRecord(line.unitPrice, rate?.rate ?? 0, doc.tax_mode),
        source: "record",
        source_object: line.object,
        source_id: line.recordId,
        source_price: line.unitPrice,
      },
      doc.tax_mode,
    );
  }
  if (input.unitPrice === undefined || !input.description) {
    throw new ValidationError("A typed line needs a description and a unitPrice", {
      field: input.description ? "unitPrice" : "description",
      rule: "typed_line",
    });
  }
  return priced(
    {
      ...base,
      description: input.description,
      unit_price: input.unitPrice,
      source: "custom",
      source_object: null,
      source_id: null,
      source_price: null,
    },
    doc.tax_mode,
  );
}

/** `line` with `change` applied, priced again. A record's line keeps the host's price. */
export function changedLine(
  line: LineRow,
  change: LineChange,
  settings: InvoiceSettings,
  mode: TaxMode,
): LineRow {
  if (line.source === "deduction") {
    throw new ValidationError("A deduction line is the host's: it is not changed by hand", {
      rule: "deduction_line",
    });
  }
  if (change.unitPrice !== undefined && line.source === "record") {
    throw new ValidationError(
      "A record's line is priced by the host from the record: give no unitPrice (a discount takes money off)",
      { field: "unitPrice", rule: "priced_by_host" },
    );
  }
  let rate: Pick<LineRow, "tax_key" | "tax_label" | "tax_rate"> = line;
  if (change.taxRate !== undefined) {
    const next = liveRate(settings, change.taxRate);
    rate = {
      tax_key: next?.key ?? null,
      tax_label: next?.label ?? null,
      tax_rate: next?.rate ?? 0,
    };
  }
  const quantityMilli =
    change.quantity === undefined ? line.quantity_milli : milli(change.quantity);
  if (change.quantity !== undefined && line.source === "record") recordQuantity(change.quantity);
  const unitPrice =
    line.source === "record" && line.source_price !== null
      ? unitPriceFromRecord(line.source_price, rate.tax_rate, mode)
      : (change.unitPrice ?? line.unit_price);
  const discount = change.discount === undefined ? undefined : change.discount;
  return priced(
    {
      ...line,
      ...rate,
      description: change.description ?? line.description,
      quantity_milli: quantityMilli,
      unit: change.unit === undefined ? line.unit : change.unit,
      unit_price: unitPrice,
      ...(discount === undefined
        ? {}
        : {
            discount_kind: discount?.kind ?? null,
            discount_value: discount?.value ?? null,
            discount_reason: discount?.reason ?? null,
          }),
    },
    mode,
  );
}

/** Every line priced again in `mode` (the document's amounts changed between with and without tax). */
export function repriced(lines: readonly LineRow[], mode: TaxMode): LineRow[] {
  return lines.map((line) =>
    line.source === "record" && line.source_price !== null
      ? priced(
          { ...line, unit_price: unitPriceFromRecord(line.source_price, line.tax_rate, mode) },
          mode,
        )
      : priced(line, mode),
  );
}

/** Lines in order, numbered 0, 1, 2 … */
export function renumbered(lines: readonly LineRow[]): LineRow[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((line, position) => ({ ...line, position }));
}

/**
 * The totals columns for `lines`. A deduction line ("less deposit paid", the host's, stage 35
 * step 6) takes its amounts off, by its rate (ADR 0732); on the order it is a `prepaid`
 * adjustment (ADR 0731).
 */
export function totalsOf(lines: readonly LineRow[]) {
  const totals = documentTotals(
    lines.map((l) => {
      const sign = l.source === "deduction" ? -1 : 1;
      return {
        taxKey: l.tax_key,
        taxLabel: l.tax_label,
        taxRate: l.tax_rate,
        net: sign * l.line_net,
        tax: sign * l.line_tax,
        total: sign * l.line_total,
      };
    }),
  );
  return {
    net_total: totals.net,
    tax_total: totals.tax,
    total: totals.total,
    tax_by_rate: JSON.stringify(totals.byRate),
  };
}

// --- Writing --------------------------------------------------------------------------------

function lineColumns(kind: DraftKind, line: LineRow): Record<string, unknown> {
  const { document_id, deducts_invoice_id, ...rest } = line;
  return {
    ...rest,
    [KIND_TABLES[kind].fk]: document_id,
    ...(kind === "invoice" ? { deducts_invoice_id } : {}),
  };
}

export function insertLine(db: Kysely<CoreDatabase>, kind: DraftKind, line: LineRow): Compilable {
  return loose(db).insertInto(KIND_TABLES[kind].line).values(lineColumns(kind, line));
}

export function updateLine(db: Kysely<CoreDatabase>, kind: DraftKind, line: LineRow): Compilable {
  const { id, created_at: _created, ...set } = lineColumns(kind, line);
  return loose(db).updateTable(KIND_TABLES[kind].line).set(set).where("id", "=", id);
}

export function deleteLine(db: Kysely<CoreDatabase>, kind: DraftKind, id: string): Compilable {
  return loose(db).deleteFrom(KIND_TABLES[kind].line).where("id", "=", id);
}

/**
 * The draft's own update: `set` with the totals of `lines`, made against the version read (the
 * trigger refuses a write from an older read).
 */
export function updateDocument(
  ctx: HandlerContext,
  kind: DraftKind,
  doc: DocumentRow,
  set: Record<string, unknown>,
  lines: readonly LineRow[],
): { statement: Compilable; next: DocumentRow } {
  const columns = {
    ...set,
    ...totalsOf(lines),
    updated_at: ctx.now,
    updated_by: ctx.user.id,
    version: doc.version + 1,
  };
  return {
    statement: loose(ctx.db)
      .updateTable(KIND_TABLES[kind].doc)
      .set(columns)
      .where("id", "=", doc.id),
    next: { ...doc, ...columns } as DocumentRow,
  };
}

/** The lines whose columns differ between `before` and `after` (by id), and those removed. */
export function lineWrites(
  db: Kysely<CoreDatabase>,
  kind: DraftKind,
  before: readonly LineRow[],
  after: readonly LineRow[],
): Compilable[] {
  const old = new Map(before.map((l) => [l.id, l]));
  const kept = new Set(after.map((l) => l.id));
  const out: Compilable[] = [];
  for (const line of before) if (!kept.has(line.id)) out.push(deleteLine(db, kind, line.id));
  for (const line of after) {
    const was = old.get(line.id);
    if (!was) out.push(insertLine(db, kind, line));
    else if (JSON.stringify(was) !== JSON.stringify(line)) out.push(updateLine(db, kind, line));
  }
  return out;
}

export function requireRoom(kind: DraftKind, lines: readonly unknown[], adding: number): void {
  if (lines.length + adding > DOCUMENT_MAX_LINES) {
    throw new ValidationError(`A ${kind} has at most ${DOCUMENT_MAX_LINES} lines`, {
      field: "lines",
      rule: "too_many_lines",
      max: DOCUMENT_MAX_LINES,
    });
  }
}
