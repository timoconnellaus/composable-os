// The business's invoicing settings (stage 35, ADRs 0730 and 0732): its details and bank details as
// printed on every document, its tax rates, whether amounts are typed with or without tax, payment
// terms, quote validity, deposit invoices' terms, the reminder schedule, the threshold over which a
// recorded payment tells the admins, the PDF footer and how long documents are kept. One JSON row
// of core_settings, changed only by a human admin (invoice.settings.update). The numbering series
// are their own rows (numbering.ts). No rate, wording or bank detail ships: the business enters
// its own.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const INVOICE_SETTINGS = "invoice_settings";

/** A rate in hundredths of a percent: 1000 is 10%, 10000 is 100%. */
export const taxRateSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, "A key is lower-case letters, digits and _ (gst, vat_std)")
    .describe("Kept on every line that uses it; never reused for another rate"),
  label: z.string().trim().min(1).max(60).describe("As printed: GST, VAT 20%, Exempt"),
  rate: z.number().int().min(0).max(10000).describe("Hundredths of a percent: 1000 = 10%"),
  retired: z.boolean().default(false).describe("No new line may use it; documents keep it"),
});
export type TaxRate = z.infer<typeof taxRateSchema>;

const line = z.string().trim().max(200);

export const businessSchema = z.object({
  legalName: z.string().trim().max(200).nullable(),
  addressLines: z.array(line).max(6),
  taxNumber: z.string().trim().max(60).nullable(),
  taxNumberLabel: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .describe("What the business's tax number is called on its documents"),
});

/** A bank detail as printed: "Account name" / "…". */
export const bankDetailSchema = z.object({
  label: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(120),
});

export const invoiceSettingsSchema = z.object({
  business: businessSchema,
  bank: z.array(bankDetailSchema).max(8),
  taxRates: z.array(taxRateSchema).max(20),
  defaultTaxRate: z.string().nullable(),
  amountsIncludeTax: z
    .boolean()
    .describe("Whether staff type unit prices with tax (taken out) or without (added on top)"),
  paymentTermsDays: z.number().int().min(0).max(365),
  quoteValidDays: z.number().int().min(1).max(365),
  depositDueDays: z.number().int().min(0).max(365).describe("0: a deposit invoice is due on issue"),
  reminders: z.object({
    on: z.boolean(),
    days: z
      .array(z.number().int().min(-60).max(365))
      .max(10)
      .describe("Days from the due date: negative before it, 0 on it, positive after"),
  }),
  recordedPaymentNoticeOver: z
    .number()
    .int()
    .min(0)
    .max(10_000_000_000)
    .describe("A recorded payment over this (minor units) tells every admin; 0: every one"),
  pdfFooter: z.string().trim().max(1000).nullable(),
  retentionYears: z.number().int().min(1).max(30),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

/** Decisions 5 and 6: 14 days to pay, a quote good for 30, reminders on the due date, then 7 and
 * 14 days after; kept 7 years, as agreements' acceptances. */
export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  business: { legalName: null, addressLines: [], taxNumber: null, taxNumberLabel: null },
  bank: [],
  taxRates: [],
  defaultTaxRate: null,
  amountsIncludeTax: true,
  paymentTermsDays: 14,
  quoteValidDays: 30,
  depositDueDays: 0,
  reminders: { on: true, days: [0, 7, 14] },
  recordedPaymentNoticeOver: 0,
  pdfFooter: null,
  retentionYears: 7,
};

/**
 * The settings as stored, each part falling back to its default when missing or unreadable (a
 * broken row never loses the rest).
 */
export async function loadInvoiceSettings(db: Kysely<CoreDatabase>): Promise<InvoiceSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", INVOICE_SETTINGS)
    .executeTakeFirst();
  let stored: Record<string, unknown> = {};
  try {
    const parsed = row ? (JSON.parse(row.value) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stored = parsed as Record<string, unknown>;
    }
  } catch {
    stored = {};
  }
  const out: Record<string, unknown> = { ...DEFAULT_INVOICE_SETTINGS };
  const shape = invoiceSettingsSchema.shape;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (!(key in stored)) continue;
    const parsed = shape[key].safeParse(stored[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as InvoiceSettings;
}

/** The rate a line uses: the key asked for, or the default; null for no tax. */
export function rateFor(
  settings: Pick<InvoiceSettings, "taxRates" | "defaultTaxRate">,
  key: string | null | undefined,
): TaxRate | null {
  const wanted = key === undefined ? settings.defaultTaxRate : key;
  if (wanted === null) return null;
  return settings.taxRates.find((r) => r.key === wanted) ?? null;
}

/** Bank details as the audit log and notices may show them: the labels and the last characters. */
export function maskedBank(bank: InvoiceSettings["bank"]): string[] {
  return bank.map((d) => `${d.label}: …${d.value.replace(/\s+/g, "").slice(-3)}`);
}
