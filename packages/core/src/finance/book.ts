// A month's money as the books count it (stage 52 step 3, ADRs 0791 and 0796): the payments the
// host applied, the late payments staff honoured and the refunds the provider confirmed in a span
// of business days, each shared over its order's lines in proportion (`splitInProportion`, in
// whole minor units that add up), and from those shares: one day summary per business day money
// moved (a book entry), and the rows of Sales, Tax and Refunds. The entries and the rows are made
// from the same shares, so the day summaries always add up to the reports.
//
// - **When**: a payment on the business day of its `received_at`, a late payment staff honoured
//   on the day they honoured it (`resolved_at`: it became a sale then), a refund on the day it was
//   confirmed (ADR 0790). A late or mismatched payment staff have not honoured is not a sale, and
//   a refund of one is not a refund of a sale: neither is counted here.
// - **Shares**: a payment or refund is split over its order's lines by what each line costs after
//   its adjustments (`line_total - line_discount`, ADR 0690). Its tax (the provider's figure,
//   ADR 0479) is split over the lines by the tax each line carries (`core_order_line.tax_amount`),
//   so a line taxed at another rate takes its own share; never more than the line's share of the
//   money. A refund the provider gave no tax figure for carries an estimate in proportion to the
//   order's tax over what was paid (decision 6), marked: `tax_estimated:` in the entry.
// - **Late**: in a month's book (a close or a month's preview), a source dated in a closed month
//   that no closed version counted is counted now, in a `late` entry dated the month's first day
//   and naming the month it belongs to.
// - **Currency**: one currency, the organisation's; a source in another is listed apart in Sales
//   and summed nowhere.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { listObjects } from "../fields/index.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { splitInProportion } from "../orders/tax.ts";
import type { CountedSource, ReportRow } from "./close.ts";
import { localDateAt } from "./day.ts";
import { type BookEntry, type EntryLine, entryKey } from "./entries.ts";
import { loadFinanceSettings } from "./periods.ts";

type Db = Kysely<CoreDatabase>;

/** The most order ids a report row lists (the rest are counted, and traced by its sources). */
export const ROW_ORDERS = 200;
/** The heading part for a tax code or country the provider did not give. */
export const NO_TAX_CODE = "none";
export const NO_TAX_COUNTRY = "XX";

/** The note every Tax figure and file carries (decision 6). */
export const TAX_NOTE =
  "Tax is as the payment provider reported it. Where it reported none for a refund, the tax " +
  "given back is an estimate in proportion, marked as such: the payment provider's own tax " +
  "report is the authority.";
/** What the figures cover (decision 10) and whose call their treatment is. */
export const COVERS_NOTE =
  "Covers money taken through the payment provider and recorded by the host, nothing else. Not " +
  "accounting or tax advice: how each figure is treated in the books is for the business to " +
  "confirm with its accountant.";

export const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** A span of instants (unix seconds, half-open). */
interface Span {
  starts: number;
  ends: number;
}

interface SourceRow {
  k: "payment" | "refund";
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  at: string;
  tax: number | null;
  tax_country: string | null;
  requested_by: string | null;
  approved_by: string | null;
}

interface OrderRow {
  id: string;
  person_id: string | null;
  person_name: string | null;
  email: string | null;
  paid: number;
  tax_amount: number;
  tax_country: string | null;
  first_payment: string | null;
}

interface LineRow {
  id: string;
  order_id: string;
  position: number;
  object_type: string;
  record_id: string;
  title: string;
  line_total: number;
  line_discount: number;
  tax_amount: number;
  tax_code: string | null;
}

/** A payment or refund counted, with the day it is on and the closed month it belongs to. */
interface Source extends SourceRow {
  date: string;
  belongsTo: string | null;
}

/** One line's share of one source. */
export interface Piece {
  source: Source;
  line: LineRow;
  category: string;
  /** Its share of the money, tax inside. */
  gross: number;
  /** Its share of the tax. */
  tax: number;
  /** Null: untaxed (the payment was not taxed, or the order carries no tax). */
  taxCode: string | null;
  taxCountry: string;
  /** A refund's tax the provider did not report: an estimate (decision 6). */
  estimated: boolean;
  /** The order's discount on this line, on the order's first payment only. */
  discount: number;
}

/** What a span's money is: the pieces, the sources in another currency, and what was read. */
export interface MoneyBook {
  currency: string | null;
  entries: BookEntry[];
  rows: ReportRow[];
  counted: CountedSource[];
  guards: string[];
}

const PAYMENT_ID = sql`p.provider || ':' || p.event_id`;

/** Not counted by any closed version: the late scan's test. */
const uncounted = (kind: string, id: ReturnType<typeof sql>) =>
  sql`NOT EXISTS (SELECT 1 FROM core_finance_counted c JOIN core_finance_period f
    ON f.id = c.period_id WHERE c.source_kind = ${kind} AND c.source_id = ${id}
    AND f.state = 'closed')`;

/** A refund that gives back a payment never counted (late or mismatched, not honoured). */
const REFUND_OF_A_SALE = sql`NOT EXISTS (SELECT 1 FROM core_order_payment q
  WHERE q.order_id = r.order_id AND q.provider = r.provider AND q.payment_ref = r.payment_ref
  AND q.outcome != 'applied' AND q.resolved IS NOT 'honoured')`;

async function readSources(db: Db, span: Span, late: boolean): Promise<SourceRow[]> {
  const a = iso(span.starts);
  const b = iso(span.ends);
  const payments = late ? uncounted("payment", PAYMENT_ID) : sql`1`;
  const refunds = late ? uncounted("refund", sql`r.id`) : sql`1`;
  return (
    await sql<SourceRow>`
      SELECT 'payment' AS k, ${PAYMENT_ID} AS id, p.order_id, p.amount, p.currency,
        p.received_at AS at, p.tax_amount AS tax, p.tax_country, NULL AS requested_by,
        NULL AS approved_by
      FROM core_order_payment p
      WHERE p.outcome = 'applied' AND p.received_at >= ${a} AND p.received_at < ${b} AND ${payments}
      UNION ALL
      SELECT 'payment', ${PAYMENT_ID}, p.order_id, p.amount, p.currency, p.resolved_at,
        p.tax_amount, p.tax_country, NULL, NULL
      FROM core_order_payment p
      WHERE p.outcome = 'late' AND p.resolved = 'honoured' AND p.resolved_at >= ${a}
        AND p.resolved_at < ${b} AND ${payments}
      UNION ALL
      SELECT 'refund', r.id, r.order_id, r.amount, r.currency, r.confirmed_at, r.tax_amount,
        NULL, r.requested_by, pa.decided_by
      FROM core_order_refund r LEFT JOIN core_pending_action pa ON pa.id = r.pending_action_id
      WHERE r.status = 'confirmed' AND r.confirmed_at >= ${a} AND r.confirmed_at < ${b}
        AND ${REFUND_OF_A_SALE} AND ${refunds}
    `.execute(db)
  ).rows;
}

/**
 * The guards of a span (ADR 0790): integer SQL over every value its figures came from, read
 * before the close's batch and checked in it. Inlined instants are the host's own ISO strings.
 */
function spanGuards(span: Span, late: boolean): string[] {
  const a = `'${iso(span.starts)}'`;
  const b = `'${iso(span.ends)}'`;
  const notCounted = (kind: string, id: string) =>
    late
      ? ` AND NOT EXISTS (SELECT 1 FROM core_finance_counted c JOIN core_finance_period f ON f.id = c.period_id WHERE c.source_kind = '${kind}' AND c.source_id = ${id} AND f.state = 'closed')`
      : "";
  const paymentsIn =
    `(SELECT p.order_id, p.amount, p.tax_amount FROM core_order_payment p WHERE p.outcome = 'applied' AND p.received_at >= ${a} AND p.received_at < ${b}${notCounted("payment", "p.provider || ':' || p.event_id")}` +
    ` UNION ALL SELECT p.order_id, p.amount, p.tax_amount FROM core_order_payment p WHERE p.outcome = 'late' AND p.resolved = 'honoured' AND p.resolved_at >= ${a} AND p.resolved_at < ${b}${notCounted("payment", "p.provider || ':' || p.event_id")})`;
  const refundsIn = `(SELECT r.order_id, r.amount, r.tax_amount FROM core_order_refund r WHERE r.status = 'confirmed' AND r.confirmed_at >= ${a} AND r.confirmed_at < ${b} AND NOT EXISTS (SELECT 1 FROM core_order_payment q WHERE q.order_id = r.order_id AND q.provider = r.provider AND q.payment_ref = r.payment_ref AND q.outcome != 'applied' AND q.resolved IS NOT 'honoured')${notCounted("refund", "r.id")})`;
  const orders = `(SELECT order_id FROM ${paymentsIn} UNION SELECT order_id FROM ${refundsIn})`;
  return [
    `SELECT count(*) FROM ${paymentsIn}`,
    `SELECT coalesce(sum(amount), 0) FROM ${paymentsIn}`,
    `SELECT coalesce(sum(coalesce(tax_amount, 0)), 0) + count(tax_amount) FROM ${paymentsIn}`,
    `SELECT count(*) FROM ${refundsIn}`,
    `SELECT coalesce(sum(amount), 0) FROM ${refundsIn}`,
    // A refund's tax arrives with its credit note, perhaps after it was confirmed.
    `SELECT coalesce(sum(coalesce(tax_amount, 0)), 0) + count(tax_amount) FROM ${refundsIn}`,
    // What the shares are weighed by: the lines' tax, and the order's tax and paid (estimates).
    `SELECT coalesce(sum(l.tax_amount), 0) + count(l.tax_code) FROM core_order_line l WHERE l.order_id IN ${orders}`,
    `SELECT coalesce(sum(o.tax_amount), 0) * 2 + coalesce(sum(o.paid), 0) FROM core_order o WHERE o.id IN ${orders}`,
  ];
}

/** Order ids to one JSON parameter: a month of 50,000 orders is five reads of each kind. */
export const ORDER_CHUNK = 10_000;

async function readOrders(db: Db, ids: readonly string[]) {
  const unique = [...new Set(ids)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += ORDER_CHUNK)
    chunks.push(unique.slice(i, i + ORDER_CHUNK));
  const read = await Promise.all(
    chunks.map((chunk) => {
      const list = JSON.stringify(chunk);
      return Promise.all([
        sql<OrderRow>`
          SELECT o.id, o.person_id, pr.display_name AS person_name, o.email, o.paid, o.tax_amount,
            o.tax_country,
            (SELECT q.provider || ':' || q.event_id FROM core_order_payment q
              WHERE q.order_id = o.id AND (q.outcome = 'applied' OR q.resolved = 'honoured')
              ORDER BY q.received_at, q.event_id LIMIT 1) AS first_payment
          FROM core_order o LEFT JOIN core_person pr ON pr.id = o.person_id
          WHERE o.id IN (SELECT value FROM json_each(${list}))
        `.execute(db),
        sql<LineRow>`
          SELECT l.id, l.order_id, l.position, l.object_type, l.record_id, l.title, l.line_total,
            l.line_discount, l.tax_amount, l.tax_code
          FROM core_order_line l
          WHERE l.order_id IN (SELECT value FROM json_each(${list}))
          ORDER BY l.order_id, l.position
        `.execute(db),
      ]);
    }),
  );
  const orders = new Map<string, OrderRow>();
  const byOrder = new Map<string, LineRow[]>();
  for (const [o, l] of read) {
    for (const order of o.rows) orders.set(order.id, order);
    for (const line of l.rows) {
      const list = byOrder.get(line.order_id) ?? [];
      list.push(line);
      byOrder.set(line.order_id, list);
    }
  }
  return { orders, lines: byOrder };
}

/** Each sales category's key and label: an admin's label, else the first object's declaring it. */
export async function categoryLabels(db: Db): Promise<{
  of: (objectType: string) => string;
  label: (key: string) => string;
}> {
  const settings = await loadFinanceSettings(db);
  const byObject = new Map<string, string>();
  const declared = new Map<string, string>();
  for (const object of listObjects()) {
    const finance = object.sellable?.finance;
    if (!finance) continue;
    byObject.set(object.name, finance.category.key);
    if (!declared.has(finance.category.key)) {
      declared.set(finance.category.key, finance.category.label);
    }
  }
  return {
    of: (objectType) => byObject.get(objectType) ?? "other",
    label: (key) =>
      settings.categoryLabels[key] ?? declared.get(key) ?? (key === "other" ? "Other" : key),
  };
}

const country = (value: string | null | undefined) => {
  const v = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(v) ? v : NO_TAX_COUNTRY;
};
const code = (value: string | null) =>
  value && /^[A-Za-z0-9_.-]+$/.test(value) ? value : NO_TAX_CODE;

/** `amount * part / whole`, rounded half up, exactly. */
function proportion(amount: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  const n = BigInt(amount) * BigInt(part) * 2n + BigInt(whole);
  return Number(n / (BigInt(whole) * 2n));
}

/** `tax` over the lines by their tax, never more than a line's share of the money. */
function taxShares(tax: number, lines: readonly LineRow[], gross: readonly number[]): number[] {
  if (tax <= 0) return lines.map(() => 0);
  const byTax = lines.map((l) => l.tax_amount);
  if (byTax.some((t) => t > 0)) {
    const shares = splitInProportion(tax, byTax);
    if (shares.every((s, i) => s <= (gross[i] ?? 0))) return shares;
  }
  return splitInProportion(tax, gross);
}

/** A source's shares over its order's lines. */
export function piecesOf(
  source: Source,
  order: OrderRow | undefined,
  lines: readonly LineRow[],
  categoryOf: (objectType: string) => string,
): Piece[] {
  if (!lines.length) return [];
  const nets = lines.map((l) => Math.max(0, l.line_total - l.line_discount));
  const weights = nets.some((n) => n > 0) ? nets : lines.map((_, i) => (i === 0 ? 1 : 0));
  const gross = splitInProportion(source.amount, weights);
  let tax = source.tax ?? 0;
  let taxed = source.tax !== null;
  let estimated = false;
  let taxCountry = country(source.tax_country ?? order?.tax_country);
  if (source.k === "refund") {
    taxCountry = country(order?.tax_country);
    if (source.tax === null && order && order.tax_amount > 0) {
      // Decision 6: the provider said nothing; the order's tax over what was paid, in proportion.
      tax = Math.min(source.amount, proportion(source.amount, order.tax_amount, order.paid));
      taxed = true;
      estimated = tax > 0;
    }
  }
  const taxes = taxShares(Math.min(tax, source.amount), lines, gross);
  const first = source.k === "payment" && order?.first_payment === source.id;
  return lines.map((line, i) => ({
    source,
    line,
    category: categoryOf(line.object_type),
    gross: gross[i] ?? 0,
    tax: taxes[i] ?? 0,
    taxCode: taxed ? code(line.tax_code) : null,
    taxCountry,
    estimated,
    discount: first ? line.line_discount : 0,
  }));
}

type Lines = Map<string, EntryLine>;

function add(lines: Lines, line: EntryLine) {
  if (line.amount <= 0) return;
  const key = [line.side, line.heading, line.taxCode, line.taxCountry, line.method, line.category]
    .map((v) => v ?? "")
    .join("\u0000");
  const had = lines.get(key);
  if (had) had.amount += line.amount;
  else lines.set(key, { ...line });
}

/** A source's lines in its entry: money in or out against its pieces. Balanced by construction. */
function sourceLines(lines: Lines, source: Source, pieces: readonly Piece[]) {
  const sale = source.k === "payment";
  const money: EntryLine = {
    heading: sale ? "money_in:provider" : "money_out:provider",
    side: sale ? "debit" : "credit",
    amount: source.amount,
    method: "provider",
  };
  add(lines, money);
  const side = sale ? "credit" : "debit";
  for (const p of pieces) {
    add(lines, {
      heading: `${sale ? "sales" : "refunds"}:${p.category}`,
      side,
      amount: p.gross - p.tax,
      category: p.category,
    });
    if (p.tax > 0) {
      add(lines, {
        heading: `${p.estimated ? "tax_estimated" : "tax"}:${p.taxCode ?? NO_TAX_CODE}:${p.taxCountry}`,
        side,
        amount: p.tax,
        taxCode: p.taxCode ?? NO_TAX_CODE,
        taxCountry: p.taxCountry,
      });
    }
  }
}

interface Figures {
  sold: number;
  refunded: number;
  taxOnSales: number;
  taxRefunded: number;
  taxRefundedEstimated: number;
  discounts: number;
  orders: Set<string>;
}

const figures = (): Figures => ({
  sold: 0,
  refunded: 0,
  taxOnSales: 0,
  taxRefunded: 0,
  taxRefundedEstimated: 0,
  discounts: 0,
  orders: new Set(),
});

function addPiece(f: Figures, p: Piece) {
  if (p.source.k === "payment") {
    f.sold += p.gross;
    f.taxOnSales += p.tax;
    f.discounts += p.discount;
  } else {
    f.refunded += p.gross;
    if (p.estimated) f.taxRefundedEstimated += p.tax;
    else f.taxRefunded += p.tax;
  }
  f.orders.add(p.source.order_id);
}

/** A row's figures: sold, refunded, net (tax inside), the tax in it and the net of tax. */
function figuresOut(f: Figures) {
  const net = f.sold - f.refunded;
  const tax = f.taxOnSales - f.taxRefunded - f.taxRefundedEstimated;
  const orders = [...f.orders].sort();
  return {
    sold: f.sold,
    discounts: f.discounts,
    refunded: f.refunded,
    net,
    taxOnSales: f.taxOnSales,
    taxRefunded: f.taxRefunded,
    taxRefundedEstimated: f.taxRefundedEstimated,
    tax,
    netOfTax: net - tax,
    orders: orders.slice(0, ROW_ORDERS),
    orderCount: orders.length,
  };
}

function group<T>(map: Map<string, T>, key: string, make: () => T): T {
  const had = map.get(key);
  if (had) return had;
  const made = make();
  map.set(key, made);
  return made;
}

/**
 * The money of `range` (a month, or any span of days for a preview): its day summaries, the rows
 * of Sales, Tax and Refunds, the sources counted and the guards. `late`, for a month's book: the
 * closed months before it, whose uncounted sources this month counts as late for them.
 */
export async function moneyBook(
  db: Db,
  range: { start: string; zone: string; starts: number; ends: number },
  late: readonly { month: string; starts: number; ends: number }[] = [],
): Promise<MoneyBook> {
  const lateSpan = late.length
    ? {
        starts: Math.min(...late.map((m) => m.starts)),
        ends: Math.max(...late.map((m) => m.ends)),
      }
    : null;
  const [own, earlier, setCurrency, labels] = await Promise.all([
    readSources(db, range, false),
    lateSpan ? readSources(db, lateSpan, true) : Promise.resolve([]),
    loadOrderCurrency(db),
    categoryLabels(db),
  ]);
  const monthOf = (at: string) => {
    const s = Date.parse(at) / 1000;
    return late.find((m) => s >= m.starts && s < m.ends)?.month ?? null;
  };
  const sources: Source[] = [
    ...own.map((s) => ({
      ...s,
      date: localDateAt(Date.parse(s.at) / 1000, range.zone),
      belongsTo: null,
    })),
    ...earlier.flatMap((s) => {
      const belongsTo = monthOf(s.at);
      return belongsTo ? [{ ...s, date: range.start, belongsTo }] : [];
    }),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.k.localeCompare(b.k) || a.id.localeCompare(b.id));
  const currency = setCurrency ?? sources[0]?.currency ?? null;
  const counted: CountedSource[] = sources.map((s) => ({ kind: s.k, id: s.id }));
  const guards = [...spanGuards(range, false), ...(lateSpan ? spanGuards(lateSpan, true) : [])];

  const inCurrency = sources.filter((s) => s.currency.toUpperCase() === currency);
  const elsewhere = sources.filter((s) => s.currency.toUpperCase() !== currency);
  const { orders, lines } = await readOrders(
    db,
    inCurrency.map((s) => s.order_id),
  );

  const entryLines = new Map<string, { entry: Omit<BookEntry, "lines">; lines: Lines }>();
  const items = new Map<string, { key: Record<string, unknown>; f: Figures }>();
  const days = new Map<string, { key: Record<string, unknown>; f: Figures }>();
  const rates = new Map<string, { key: Record<string, unknown>; f: Figures }>();
  const refunds: ReportRow[] = [];

  for (const source of inCurrency) {
    const order = orders.get(source.order_id);
    const pieces = piecesOf(source, order, lines.get(source.order_id) ?? [], labels.of);
    // An order with no lines cannot be split; its money is still counted, as Other.
    const counted: Piece[] = pieces.length
      ? pieces
      : [
          {
            source,
            line: {
              id: "",
              order_id: source.order_id,
              position: 0,
              object_type: "",
              record_id: "",
              title: "",
              line_total: 0,
              line_discount: 0,
              tax_amount: 0,
              tax_code: null,
            },
            category: "other",
            gross: source.amount,
            tax: 0,
            taxCode: null,
            taxCountry: NO_TAX_COUNTRY,
            estimated: false,
            discount: 0,
          },
        ];
    const key =
      source.belongsTo === null
        ? entryKey("day", { date: source.date })
        : entryKey("late", { belongsTo: source.belongsTo, date: source.date });
    const entry = group(entryLines, key, () => ({
      entry: {
        key,
        kind: source.belongsTo === null ? ("day" as const) : ("late" as const),
        date: source.date,
        belongsTo: source.belongsTo,
      },
      lines: new Map(),
    }));
    sourceLines(entry.lines, source, counted);

    const belongsTo = source.belongsTo;
    for (const p of counted) {
      const item = group(
        items,
        JSON.stringify([belongsTo, p.category, p.line.object_type, p.line.record_id, p.line.title]),
        () => ({
          key: {
            type: "item",
            belongsTo,
            category: p.category,
            categoryLabel: labels.label(p.category),
            object: p.line.object_type,
            recordId: p.line.record_id,
            title: p.line.title,
          },
          f: figures(),
        }),
      );
      addPiece(item.f, p);
      const day = group(days, JSON.stringify([source.date, belongsTo, p.category]), () => ({
        key: {
          type: "day",
          date: source.date,
          belongsTo,
          category: p.category,
          categoryLabel: labels.label(p.category),
        },
        f: figures(),
      }));
      addPiece(day.f, p);
      const rate = group(
        rates,
        JSON.stringify([belongsTo, p.taxCode, p.taxCode === null ? null : p.taxCountry]),
        () => ({
          key: {
            type: p.taxCode === null ? "untaxed" : "rate",
            belongsTo,
            taxCode: p.taxCode,
            taxCountry: p.taxCode === null ? null : p.taxCountry,
          },
          f: figures(),
        }),
      );
      addPiece(rate.f, p);
    }

    if (source.k === "refund") {
      const tax = counted.reduce((n, p) => n + p.tax, 0);
      refunds.push({
        report: "refunds",
        personId: order?.person_id ?? null,
        name: order?.person_name ?? null,
        email: order?.email ?? null,
        data: {
          type: "refund",
          refundId: source.id,
          orderId: source.order_id,
          currency,
          date: source.date,
          belongsTo,
          items: [...new Set(counted.map((p) => p.line.title).filter(Boolean))],
          categories: [...new Set(counted.map((p) => p.category))],
          amount: source.amount,
          method: "provider",
          tax,
          taxEstimated: counted.some((p) => p.estimated),
          requestedBy: source.requested_by,
          approvedBy: source.approved_by,
        },
      });
    }
  }

  const entries: BookEntry[] = [...entryLines.values()]
    .map(({ entry, lines }) => ({ ...entry, lines: [...lines.values()] }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const sorted = <T extends { key: Record<string, unknown> }>(m: Map<string, T>) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const row = (report: "sales" | "tax", r: { key: Record<string, unknown>; f: Figures }) => ({
    report,
    personId: null,
    name: null,
    email: null,
    data: { ...r.key, currency, ...figuresOut(r.f) },
  });
  const rows: ReportRow[] = [
    ...sorted(items).map((r) => row("sales", r)),
    ...sorted(days).map((r) => row("sales", r)),
    ...elsewhere.map((s) => ({
      report: "sales" as const,
      personId: null,
      name: null,
      email: null,
      data: {
        type: "exception",
        kind: s.k,
        sourceId: s.id,
        orderId: s.order_id,
        date: s.date,
        belongsTo: s.belongsTo,
        currency: s.currency.toUpperCase(),
        amount: s.amount,
      },
    })),
    ...sorted(rates).map((r) => row("tax", r)),
    ...refunds,
  ];
  return { currency, entries, rows, counted, guards };
}
