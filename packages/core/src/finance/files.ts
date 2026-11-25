// The finance files (stage 52 step 3, ADR 0796): one CSV per report, for the business to send its
// accountant. Its first rows name the report, the period, the version, when it was closed and by
// whom (or say it is a preview, on the very first row), the currency and the notes; then its
// tables. Every amount is in minor units with a decimal column beside it; every text cell is
// quoted and guarded against formulas (`csvText`). A closed version's file is made only from its
// stored rows and its version, so it downloads byte for byte the same every time, a reopen since
// included, but for its names: who closed it and the staff on a refund are read as their accounts
// are named when it is downloaded, and an erased customer reads "Erased person" (ADR 0796).
import { csvText } from "../csv.ts";
import { currencyDecimals } from "../orders/settings.ts";
import type { BuiltReport, ReportView } from "./reports.ts";

const row = (cells: string[]) => cells.join(",");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const text = (v: unknown) =>
  csvText(typeof v === "string" ? v : typeof v === "boolean" ? (v ? "yes" : "no") : "");

/** Minor units as a decimal in the currency's places, exactly (no floating point). */
export function decimal(minor: unknown, places: number): string {
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) return "";
  if (places <= 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(places + 1, "0");
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

const TITLES: Record<BuiltReport, string> = {
  sales: "Sales",
  tax: "Tax",
  refunds: "Refunds",
  payouts: "Payouts",
};

type Column = [header: string, cell: (r: Record<string, unknown>) => string[]];

function money(header: string, key: string, places: number): Column {
  return [header, (r) => [num(r[key]), decimal(r[key], places)]];
}
const textCol = (header: string, key: string): Column => [header, (r) => [text(r[key])]];
const list = (header: string, key: string): Column => [
  header,
  (r) => [csvText(Array.isArray(r[key]) ? (r[key] as unknown[]).map(String).join(" ") : "")],
];

function headers(columns: readonly Column[], places: number, sample: (h: string) => boolean) {
  return columns.flatMap(([h]) => (sample(h) ? [h, `${h} (decimal, ${places} places)`] : [h]));
}

function table(
  out: string[],
  title: string,
  columns: readonly Column[],
  moneyHeaders: ReadonlySet<string>,
  rows: readonly Record<string, unknown>[],
  places: number,
) {
  out.push("");
  out.push(row([csvText(title)]));
  out.push(row(headers(columns, places, (h) => moneyHeaders.has(h)).map(csvText)));
  for (const r of rows) out.push(row(columns.flatMap(([, cell]) => cell(r))));
}

const FIGURES: readonly [string, string][] = [
  ["sold", "sold"],
  ["discounts", "discounts"],
  ["refunded", "refunded"],
  ["net", "net"],
  ["tax on sales", "taxOnSales"],
  ["tax refunded (reported)", "taxRefunded"],
  ["tax refunded (estimate)", "taxRefundedEstimated"],
  ["tax", "tax"],
  ["net of tax", "netOfTax"],
];

/** One report as a CSV file. */
export function reportCsv(view: ReportView): string {
  const places = currencyDecimals(view.currency ?? "AUD");
  const out: string[] = [];
  if (view.preview) {
    out.push(row([csvText("PREVIEW: this period is not closed; its figures may still change")]));
  }
  out.push(row([csvText("Finance report"), csvText(TITLES[view.report])]));
  out.push(
    row([
      csvText("Period"),
      csvText(view.month ?? ""),
      csvText(view.start),
      csvText(view.end),
      csvText(view.zone),
    ]),
  );
  out.push(
    row(
      view.preview
        ? [csvText("Version"), csvText("preview")]
        : [
            csvText("Version"),
            String(view.version ?? ""),
            csvText("Closed at"),
            csvText(view.closedAt),
            csvText("Closed by"),
            csvText(view.closedByName),
          ],
    ),
  );
  out.push(row([csvText("Currency"), csvText(view.currency)]));
  for (const note of view.notes) out.push(row([csvText("Note"), csvText(note)]));
  const rows = (type: string) => view.rows.filter((r) => r.type === type);
  const figureCols = FIGURES.map(([h, k]) => money(h, k, places));
  const figureHeaders = new Set(FIGURES.map(([h]) => h));
  const traced: Column[] = [
    ["orders", (r) => [num(r.orderCount)]],
    list("order ids (up to 200)", "orders"),
  ];
  if (view.report === "sales") {
    table(
      out,
      "By item",
      [
        textCol("belongs to closed month", "belongsTo"),
        textCol("category", "category"),
        textCol("category label", "categoryLabel"),
        textCol("item", "title"),
        textCol("object", "object"),
        textCol("record", "recordId"),
        ...figureCols,
        ...traced,
      ],
      figureHeaders,
      rows("item"),
      places,
    );
    table(
      out,
      "By day",
      [
        textCol("date", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("category", "category"),
        textCol("category label", "categoryLabel"),
        ...figureCols,
        ...traced,
      ],
      figureHeaders,
      rows("day"),
      places,
    );
    table(
      out,
      "In another currency (not summed)",
      [
        textCol("date", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("kind", "kind"),
        textCol("source", "sourceId"),
        textCol("order", "orderId"),
        textCol("currency", "currency"),
        ["amount", (r) => [num(r.amount)]],
      ],
      new Set(),
      rows("exception"),
      places,
    );
  } else if (view.report === "tax") {
    const cols: Column[] = [
      textCol("belongs to closed month", "belongsTo"),
      ["taxed", (r) => [text(r.type === "rate")]],
      textCol("tax code", "taxCode"),
      textCol("country", "taxCountry"),
      money("sales (tax inside)", "sold", places),
      money("tax on sales", "taxOnSales", places),
      money("refunds (tax inside)", "refunded", places),
      money("tax refunded (reported)", "taxRefunded", places),
      money("tax refunded (estimate)", "taxRefundedEstimated", places),
      money("tax", "tax", places),
      money("net of tax", "netOfTax", places),
      [
        "estimate",
        (r) => [
          text(
            typeof r.taxRefundedEstimated === "number" && r.taxRefundedEstimated > 0
              ? "estimate"
              : "",
          ),
        ],
      ],
      ...traced,
    ];
    table(
      out,
      "By tax code and country",
      cols,
      new Set([
        "sales (tax inside)",
        "tax on sales",
        "refunds (tax inside)",
        "tax refunded (reported)",
        "tax refunded (estimate)",
        "tax",
        "net of tax",
      ]),
      view.rows.filter((r) => r.type === "rate" || r.type === "untaxed"),
      places,
    );
  } else if (view.report === "payouts") {
    const m = (header: string, key: string) => money(header, key, places);
    const payoutMoney = [
      "amount to the bank",
      "payments",
      "refunds",
      "disputes",
      "adjustments",
      "matching nothing",
      "fees",
      "lines net",
      "difference",
    ];
    table(
      out,
      "Payouts arriving",
      [
        textCol("date", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("payout", "payoutRef"),
        textCol("provider", "provider"),
        m("amount to the bank", "amount"),
        m("payments", "payments"),
        m("refunds", "refunds"),
        m("disputes", "disputes"),
        m("adjustments", "adjustments"),
        m("matching nothing", "unmatched"),
        m("fees", "fees"),
        m("lines net", "linesNet"),
        m("difference", "difference"),
        ["lines", (r) => [num(r.lineCount)]],
        ["itemised", (r) => [text(r.itemised === true)]],
        ...traced,
      ],
      new Set(payoutMoney),
      rows("payout"),
      places,
    );
    table(
      out,
      "Payout lines",
      [
        textCol("payout", "payoutRef"),
        textCol("line", "lineRef"),
        textCol("kind", "kind"),
        textCol("at", "occurredAt"),
        m("amount", "amount"),
        m("fee", "fee"),
        m("net", "net"),
        ["matched", (r) => [text(r.matched === true)]],
        textCol("matched to", "source"),
        textCol("payment or refund", "sourceId"),
        textCol("order", "orderId"),
        textCol("payment reference", "paymentRef"),
        textCol("refund reference", "refundRef"),
      ],
      new Set(["amount", "fee", "net"]),
      rows("line"),
      places,
    );
    table(
      out,
      "Failed after arriving (the bank returned it)",
      [
        textCol("seen on", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("payout", "payoutRef"),
        textCol("arrived", "arrivalDate"),
        m("amount", "amount"),
      ],
      new Set(["amount"]),
      rows("failure"),
      places,
    );
    table(
      out,
      "Received through the provider, not yet paid out",
      [
        textCol("as at", "asAt"),
        textCol("from", "since"),
        m("payments", "payments"),
        m("refunds", "refunds"),
        m("not yet paid out", "amount"),
        ["payments counted", (r) => [num(r.paymentCount)]],
        ["refunds counted", (r) => [num(r.refundCount)]],
        list("payments and refunds (up to 200)", "sources"),
        ...traced,
      ],
      new Set(["payments", "refunds", "not yet paid out"]),
      rows("unpaid"),
      places,
    );
    table(
      out,
      "In another currency (not summed)",
      [
        textCol("date", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("payout", "payoutRef"),
        textCol("currency", "currency"),
        ["amount", (r) => [num(r.amount)]],
      ],
      new Set(),
      rows("exception"),
      places,
    );
  } else {
    table(
      out,
      "Refunds confirmed",
      [
        textCol("date", "date"),
        textCol("belongs to closed month", "belongsTo"),
        textCol("refund", "refundId"),
        textCol("order", "orderId"),
        list("items", "items"),
        list("categories", "categories"),
        money("amount", "amount", places),
        textCol("method", "method"),
        money("tax given back", "tax", places),
        ["tax is", (r) => [text(r.taxEstimated ? "estimate" : "as reported")]],
        textCol("asked by", "requestedByName"),
        textCol("approved by", "approvedByName"),
        textCol("name", "name"),
        textCol("email", "email"),
      ],
      new Set(["amount", "tax given back"]),
      rows("refund"),
      places,
    );
  }
  return `${out.join("\r\n")}\r\n`;
}

/** The file's name: the report, the period and its version (or preview). */
export function reportFilename(view: ReportView): string {
  const period = view.month ?? `${view.start}-to-${view.end}`;
  return `${view.report}-${period}${view.preview ? "-preview" : `-v${view.version}`}.csv`;
}
