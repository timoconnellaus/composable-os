// Payouts in the books (stage 52 step 4, ADRs 0791 and 0793): each payout the provider sent to the
// bank in a span of business days, as the host read it (`payout-sync.ts`), with its lines matched
// to what the host recorded, and from those: one payout entry per payout, and the rows of the
// Payouts report. The entry and the rows are made from the same lines, so they agree.
//
// - **When**: a payout on the day the provider says it arrives in the bank (`arrival_date`); a
//   failure of one on the business day the host saw it. A payout read after its month was closed
//   is counted in the first open month, in that month's `late` entry for the month it belongs to
//   (ADR 0790); the closed month never changes.
// - **Matching**: a payment line to the provider's payment the host stored with that reference
//   (`core_order_payment.payment_ref`, method `provider`), a refund line to the refund the provider
//   confirmed with that reference (`core_order_refund.provider_refund_ref`); what matches nothing
//   is listed and carried on `unmatched`, never guessed or folded into a sale. Matching is done
//   when the figures are worked out, so a payment whose event arrives after its payout matches
//   then; a closed version keeps the match it was closed with.
// - **The entry** (`payout:<the provider's id>`): the payout to `bank` and the provider's fees to
//   `fees:provider` (debits), against what it settled: matched payments on `money_in:provider`,
//   matched refunds on `money_out:provider`, disputes on `disputes`, adjustments on
//   `adjustments`, and what matches nothing, with any difference between the payout and its lines,
//   on `unmatched`. A side flips with its sign. It balances by construction. A failure is its own
//   entry (`payout:<id>:failed`): the bank's money back on `adjustments`.
// - **Not yet paid out**: the provider's payments the host received in the `NOT_PAID_OUT_DAYS`
//   before the span's end, less its refunds confirmed then, that no payout arriving by the span's
//   end settled: one figure, with the sources it came from. A payment recorded by hand (a
//   transfer, cash) never reaches the provider and is in no payout and not in this figure.
// - **Currency**: one, the organisation's; a payout in another is listed apart and summed nowhere.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import type { CountedSource, ReportRow } from "./close.ts";
import { type BookEntry, type EntryLine, entryKey } from "./entries.ts";

type Db = Kysely<CoreDatabase>;

/** How far before a span's end "not yet paid out" looks for the provider's payments and refunds. */
export const NOT_PAID_OUT_DAYS = 92;
/** The most source ids a row lists (the rest are counted). */
const ROW_IDS = 200;

/** The note every Payouts figure and file carries. */
export const PAYOUTS_NOTE =
  "Payouts are as the payment provider reported them, on the day each arrives in the bank. Each " +
  "payment and refund line is matched to what the host recorded by the provider's reference; " +
  "what matches nothing is listed apart, never guessed. Payments recorded by hand (a transfer, " +
  "cash) never reach the provider and are in no payout. Not yet paid out counts the provider's " +
  `payments and refunds of the ${NOT_PAID_OUT_DAYS} days before the period's end.`;

/** A month a late payout can belong to: its local dates. */
export interface ClosedDates {
  month: string;
  start_date: string;
  end_date: string;
}

interface PayoutRow {
  provider: string;
  ref: string;
  amount: number;
  currency: string;
  arrival_date: string;
  itemised: number;
  line_count: number;
  lines_net: number;
}

interface FailureRow extends PayoutRow {
  date: string;
}

interface LineRow {
  provider: string;
  ref: string;
  payout_ref: string;
  kind: "payment" | "refund" | "dispute" | "adjustment" | "fee";
  amount: number;
  fee: number;
  currency: string;
  payment_ref: string | null;
  refund_ref: string | null;
  occurred_at: string;
  /** The matched payment's order and id (`provider:event`), tab-separated. */
  payment: string | null;
  /** The matched refund's order and id, tab-separated. */
  refund: string | null;
}

export interface PayoutBook {
  entries: BookEntry[];
  rows: ReportRow[];
  counted: CountedSource[];
  guards: string[];
}

const run = async <T>(db: Db, query: string, params: unknown[]) =>
  (await db.executeQuery<T>(CompiledQuery.raw(query, params))).rows;

/** Not counted by any closed version (the late scan's test), as SQL text over `id`. */
const UNCOUNTED = (kind: string, id: string) =>
  `NOT EXISTS (SELECT 1 FROM core_finance_counted c JOIN core_finance_period f ON f.id = c.period_id WHERE c.source_kind = '${kind}' AND c.source_id = ${id} AND f.state = 'closed')`;

/** The matched payment of a line (the first the host recorded with its reference), as SQL. */
const PAYMENT_MATCH = `(SELECT q.order_id || char(9) || q.provider || ':' || q.event_id
  FROM core_order_payment q WHERE q.provider = l.provider AND q.payment_ref = l.payment_ref
    AND q.method = 'provider' ORDER BY q.received_at, q.event_id LIMIT 1)`;
const REFUND_MATCH = `(SELECT r.order_id || char(9) || r.id FROM core_order_refund r
  WHERE r.provider = l.provider AND r.provider_refund_ref = l.refund_ref LIMIT 1)`;

async function readPayouts(db: Db, a: string, b: string, late: boolean): Promise<PayoutRow[]> {
  return run<PayoutRow>(
    db,
    `SELECT provider, ref, amount, currency, arrival_date, itemised, line_count, lines_net
     FROM core_payout WHERE arrival_date >= ? AND arrival_date <= ?
       ${late ? `AND ${UNCOUNTED("payout", "core_payout.provider || ':' || core_payout.ref")}` : ""}
     ORDER BY arrival_date, provider, ref`,
    [a, b],
  );
}

async function readFailures(db: Db, a: string, b: string, late: boolean): Promise<FailureRow[]> {
  return run<FailureRow>(
    db,
    `SELECT f.date, p.provider, p.ref, p.amount, p.currency, p.arrival_date, p.itemised,
       p.line_count, p.lines_net
     FROM core_payout_failure f JOIN core_payout p ON p.provider = f.provider AND p.ref = f.payout_ref
     WHERE f.date >= ? AND f.date <= ?
       ${late ? `AND ${UNCOUNTED("payout_failure", "f.provider || ':' || f.payout_ref")}` : ""}
     ORDER BY f.date, p.provider, p.ref`,
    [a, b],
  );
}

/** The lines of some payouts, with what each matches, by provider (each an index read). */
async function readLines(db: Db, payouts: readonly PayoutRow[]): Promise<Map<string, LineRow[]>> {
  const byProvider = new Map<string, string[]>();
  for (const p of payouts) {
    const list = byProvider.get(p.provider) ?? [];
    list.push(p.ref);
    byProvider.set(p.provider, list);
  }
  const out = new Map<string, LineRow[]>();
  for (const [provider, refs] of byProvider) {
    const rows = await run<LineRow>(
      db,
      `SELECT l.provider, l.ref, l.payout_ref, l.kind, l.amount, l.fee, l.currency, l.payment_ref,
         l.refund_ref, l.occurred_at,
         CASE WHEN l.kind IN ('payment', 'dispute') AND l.payment_ref IS NOT NULL
           THEN ${PAYMENT_MATCH} END AS payment,
         CASE WHEN l.kind = 'refund' AND l.refund_ref IS NOT NULL THEN ${REFUND_MATCH} END AS refund
       FROM core_payout_line l
       WHERE l.provider = ? AND l.payout_ref IN (SELECT value FROM json_each(?))
       ORDER BY l.payout_ref, l.occurred_at, l.ref`,
      [provider, JSON.stringify(refs)],
    );
    for (const row of rows) {
      const key = `${row.provider}:${row.payout_ref}`;
      const list = out.get(key) ?? [];
      list.push(row);
      out.set(key, list);
    }
  }
  return out;
}

const splitMatch = (value: string | null) => {
  if (!value) return null;
  const [orderId, id] = value.split("\t");
  return orderId && id ? { orderId, id } : null;
};

/** What the provider's payments and refunds of the window not yet in a payout come to. */
async function notPaidOut(
  db: Db,
  from: string,
  to: string,
  endDate: string,
  currency: string | null,
) {
  const paidOut = (column: string, kind: string, ref: string) =>
    `EXISTS (SELECT 1 FROM core_payout_line l JOIN core_payout o
       ON o.provider = l.provider AND o.ref = l.payout_ref
     WHERE l.provider = ${column} AND l.${kind === "payment" ? "payment_ref" : "refund_ref"} = ${ref}
       AND l.kind = '${kind}' AND o.arrival_date <= ?)`;
  const [payments, refunds] = await Promise.all([
    run<{ id: string; order_id: string; amount: number; currency: string }>(
      db,
      `SELECT p.provider || ':' || p.event_id AS id, p.order_id, p.amount, p.currency
       FROM core_order_payment p
       WHERE p.method = 'provider' AND p.received_at >= ? AND p.received_at < ?
         AND NOT (p.payment_ref IS NOT NULL AND ${paidOut("p.provider", "payment", "p.payment_ref")})
       ORDER BY p.received_at, p.event_id`,
      [from, to, endDate],
    ),
    run<{ id: string; order_id: string; amount: number; currency: string }>(
      db,
      `SELECT r.id, r.order_id, r.amount, r.currency FROM core_order_refund r
       WHERE r.status = 'confirmed' AND r.confirmed_at >= ? AND r.confirmed_at < ?
         AND r.method = 'provider'
         AND NOT (r.provider_refund_ref IS NOT NULL
           AND ${paidOut("r.provider", "refund", "r.provider_refund_ref")})
       ORDER BY r.confirmed_at, r.id`,
      [from, to, endDate],
    ),
  ]);
  const mine = <T extends { currency: string }>(rows: T[]) =>
    rows.filter((r) => currency === null || r.currency.toUpperCase() === currency);
  const p = mine(payments);
  const r = mine(refunds);
  const paymentsIn = p.reduce((n, x) => n + x.amount, 0);
  const refundsOut = r.reduce((n, x) => n + x.amount, 0);
  return {
    payments: paymentsIn,
    refunds: refundsOut,
    amount: paymentsIn - refundsOut,
    paymentCount: p.length,
    refundCount: r.length,
    paymentIds: p.map((x) => x.id),
    refundIds: r.map((x) => x.id),
    orders: [...new Set([...p, ...r].map((x) => x.order_id))].sort(),
  };
}

type Lines = Map<string, EntryLine>;

function add(lines: Lines, heading: string, side: "debit" | "credit", amount: number) {
  if (amount <= 0) return;
  const method = heading.startsWith("money_") ? "provider" : null;
  const key = `${side}\u0000${heading}`;
  const had = lines.get(key);
  if (had) had.amount += amount;
  else lines.set(key, { heading, side, amount, method });
}

/** `amount` on `heading`: a credit when positive (money the provider settled), else a debit. */
function settled(lines: Lines, heading: string, amount: number) {
  if (amount > 0) add(lines, heading, "credit", amount);
  else add(lines, heading, "debit", -amount);
}

/** A debit when positive (to the bank, the provider's fees), else a credit. */
function paid(lines: Lines, heading: string, amount: number) {
  if (amount > 0) add(lines, heading, "debit", amount);
  else add(lines, heading, "credit", -amount);
}

/** One payout's figures and its entry's lines, from its lines and what each matched. */
function payoutFigures(payout: PayoutRow, lines: readonly LineRow[], claimed: Set<string>) {
  const out: Lines = new Map();
  const f = {
    payments: 0,
    refunds: 0,
    disputes: 0,
    adjustments: 0,
    unmatched: 0,
    fees: 0,
    linesNet: 0,
  };
  const orders = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const l of lines) {
    f.linesNet += l.amount - l.fee;
    f.fees += l.fee;
    let matched: { orderId: string; id: string } | null = null;
    let source: "payment" | "refund" | null = null;
    if (l.kind === "fee") {
      // The provider's own charge (billing, a device), taken from the balance: a fee.
      f.fees += -l.amount;
    } else if (l.kind === "payment" || l.kind === "refund") {
      const m = splitMatch(l.kind === "payment" ? l.payment : l.refund);
      // Each payment or refund is settled by one line only: a second claim matches nothing.
      if (m && !claimed.has(`${l.kind}:${m.id}`)) {
        claimed.add(`${l.kind}:${m.id}`);
        matched = m;
        source = l.kind;
      }
      if (matched) {
        settled(out, l.kind === "payment" ? "money_in:provider" : "money_out:provider", l.amount);
        if (l.kind === "payment") f.payments += l.amount;
        else f.refunds += -l.amount;
      } else {
        settled(out, "unmatched", l.amount);
        f.unmatched += l.amount;
      }
    } else if (l.kind === "dispute") {
      settled(out, "disputes", l.amount);
      f.disputes += l.amount;
      // Traced to the payment it disputes, when the host has it; never matched as settled.
      matched = splitMatch(l.payment);
    } else {
      settled(out, "adjustments", l.amount);
      f.adjustments += l.amount;
    }
    if (matched) orders.add(matched.orderId);
    rows.push({
      type: "line",
      payoutRef: payout.ref,
      provider: payout.provider,
      lineRef: l.ref,
      kind: l.kind,
      occurredAt: l.occurred_at,
      amount: l.amount,
      fee: l.fee,
      net: l.amount - l.fee,
      matched: source !== null,
      source,
      sourceId: matched?.id ?? null,
      orderId: matched?.orderId ?? null,
      paymentRef: l.payment_ref,
      refundRef: l.refund_ref,
    });
  }
  const difference = payout.amount - f.linesNet;
  paid(out, "bank", payout.amount);
  paid(out, "fees:provider", f.fees);
  // What the payout carries beyond (or short of) its lines matches nothing: shown, never adjusted.
  settled(out, "unmatched", difference);
  return { lines: [...out.values()], figures: { ...f, difference }, orders, rows };
}

/**
 * The payouts of `range` (its dates, both included), with those of the closed months in `late`
 * none of their closed versions counted: entries, Payouts rows, sources counted, guards.
 */
export async function payoutBook(
  db: Db,
  range: { start: string; end: string; ends: number },
  late: readonly ClosedDates[],
  currency: string | null,
): Promise<PayoutBook> {
  const lateFrom = late.length ? late.map((m) => m.start_date).sort()[0] : null;
  const lateTo = late.length
    ? late
        .map((m) => m.end_date)
        .sort()
        .at(-1)
    : null;
  const toIso = new Date(range.ends * 1000).toISOString();
  const fromIso = new Date((range.ends - NOT_PAID_OUT_DAYS * 86_400) * 1000).toISOString();
  const [own, ownFailures, earlier, earlierFailures, waiting] = await Promise.all([
    readPayouts(db, range.start, range.end, false),
    readFailures(db, range.start, range.end, false),
    lateFrom && lateTo ? readPayouts(db, lateFrom, lateTo, true) : Promise.resolve([]),
    lateFrom && lateTo ? readFailures(db, lateFrom, lateTo, true) : Promise.resolve([]),
    notPaidOut(db, fromIso, toIso, range.end, currency),
  ]);
  const belongsTo = (date: string) =>
    late.find((m) => date >= m.start_date && date <= m.end_date)?.month ?? null;
  const payouts = [
    ...own.map((p) => ({ ...p, belongsTo: null as string | null })),
    ...earlier.flatMap((p) => {
      const month = belongsTo(p.arrival_date);
      return month ? [{ ...p, belongsTo: month }] : [];
    }),
  ];
  const failures = [
    ...ownFailures.map((p) => ({ ...p, belongsTo: null as string | null })),
    ...earlierFailures.flatMap((p) => {
      const month = belongsTo(p.date);
      return month ? [{ ...p, belongsTo: month }] : [];
    }),
  ];
  const ours = (c: string) => currency === null || c.toUpperCase() === currency;
  const lines = await readLines(
    db,
    payouts.filter((p) => ours(p.currency)),
  );

  const entries = new Map<string, BookEntry>();
  const entryOf = (key: string, date: string, belongs: string | null, kind: "payout" | "late") => {
    const had = entries.get(key);
    if (had) return had;
    const made: BookEntry = { key, kind, date, belongsTo: belongs, lines: [] };
    entries.set(key, made);
    return made;
  };
  const rows: ReportRow[] = [];
  const row = (data: Record<string, unknown>): ReportRow => ({
    report: "payouts",
    personId: null,
    name: null,
    email: null,
    data: { currency, ...data },
  });
  const counted: CountedSource[] = [];
  const claimed = new Set<string>();

  for (const p of payouts) {
    counted.push({ kind: "payout", id: `${p.provider}:${p.ref}` });
    if (!ours(p.currency)) {
      rows.push(
        row({
          type: "exception",
          payoutRef: p.ref,
          provider: p.provider,
          date: p.arrival_date,
          belongsTo: p.belongsTo,
          currency: p.currency,
          amount: p.amount,
        }),
      );
      continue;
    }
    const made = payoutFigures(p, lines.get(`${p.provider}:${p.ref}`) ?? [], claimed);
    const entry =
      p.belongsTo === null
        ? entryOf(entryKey("payout", { payout: p.ref }), p.arrival_date, null, "payout")
        : entryOf(
            entryKey("late", { belongsTo: p.belongsTo, date: range.start }),
            range.start,
            p.belongsTo,
            "late",
          );
    entry.lines.push(...made.lines);
    const orders = [...made.orders].sort();
    rows.push(
      row({
        type: "payout",
        payoutRef: p.ref,
        provider: p.provider,
        date: p.arrival_date,
        belongsTo: p.belongsTo,
        amount: p.amount,
        ...made.figures,
        lineCount: p.line_count,
        itemised: p.itemised === 1,
        orders: orders.slice(0, ROW_IDS),
        orderCount: orders.length,
      }),
    );
    for (const r of made.rows)
      rows.push(row({ ...r, date: p.arrival_date, belongsTo: p.belongsTo }));
  }

  for (const f of failures) {
    counted.push({ kind: "payout_failure", id: `${f.provider}:${f.ref}` });
    if (!ours(f.currency)) continue;
    const out: Lines = new Map();
    // The bank returned it: the money is the provider's balance again (paid out later, where it
    // comes back as an adjustment), not the bank's.
    paid(out, "adjustments", f.amount);
    settled(out, "bank", f.amount);
    const entry =
      f.belongsTo === null
        ? entryOf(`payout:${f.ref}:failed`, f.date, null, "payout")
        : entryOf(
            entryKey("late", { belongsTo: f.belongsTo, date: range.start }),
            range.start,
            f.belongsTo,
            "late",
          );
    entry.lines.push(...out.values());
    rows.push(
      row({
        type: "failure",
        payoutRef: f.ref,
        provider: f.provider,
        date: f.date,
        arrivalDate: f.arrival_date,
        belongsTo: f.belongsTo,
        amount: f.amount,
      }),
    );
  }

  rows.push(
    row({
      type: "unpaid",
      asAt: range.end,
      since: fromIso,
      payments: waiting.payments,
      refunds: waiting.refunds,
      amount: waiting.amount,
      paymentCount: waiting.paymentCount,
      refundCount: waiting.refundCount,
      sources: [...waiting.paymentIds, ...waiting.refundIds].slice(0, ROW_IDS),
      sourceCount: waiting.paymentIds.length + waiting.refundIds.length,
      orders: waiting.orders.slice(0, ROW_IDS),
      orderCount: waiting.orders.length,
    }),
  );

  return {
    entries: mergeEntries([...entries.values()]),
    rows,
    counted,
    guards: [
      ...payoutGuards(range.start, range.end, false),
      ...(lateFrom && lateTo ? payoutGuards(lateFrom, lateTo, true) : []),
      ...notPaidOutGuards(fromIso, toIso),
    ],
  };
}

/** The guards over a span's payouts (ADR 0790): a payout, failure or match landing fails the close. */
function payoutGuards(a: string, b: string, late: boolean): string[] {
  const span = `arrival_date >= '${a}' AND arrival_date <= '${b}'`;
  const notCounted = late
    ? ` AND ${UNCOUNTED("payout", "core_payout.provider || ':' || core_payout.ref")}`
    : "";
  const failNotCounted = late
    ? ` AND ${UNCOUNTED("payout_failure", "f.provider || ':' || f.payout_ref")}`
    : "";
  return [
    `SELECT count(*) * 1000003 + coalesce(sum(amount), 0) + coalesce(sum(line_count), 0) FROM core_payout WHERE ${span}${notCounted}`,
    `SELECT count(*) FROM core_payout_failure f WHERE f.date >= '${a}' AND f.date <= '${b}'${failNotCounted}`,
    // What the lines match: a payment or refund the host recorded meanwhile changes it.
    `SELECT count(*) FROM core_payout_line l JOIN core_payout ON core_payout.provider = l.provider AND core_payout.ref = l.payout_ref WHERE core_payout.${span}${notCounted} AND ((l.kind IN ('payment', 'dispute') AND l.payment_ref IS NOT NULL AND ${PAYMENT_MATCH} IS NOT NULL) OR (l.kind = 'refund' AND l.refund_ref IS NOT NULL AND ${REFUND_MATCH} IS NOT NULL))`,
  ];
}

/** The guards over what is not yet paid out: the provider's money in the window. */
function notPaidOutGuards(from: string, to: string): string[] {
  return [
    `SELECT count(*) * 1000003 + coalesce(sum(amount), 0) FROM core_order_payment WHERE method = 'provider' AND received_at >= '${from}' AND received_at < '${to}'`,
    `SELECT count(*) * 1000003 + coalesce(sum(amount), 0) FROM core_order_refund WHERE status = 'confirmed' AND confirmed_at >= '${from}' AND confirmed_at < '${to}' AND method = 'provider'`,
  ];
}

/**
 * Book entries merged by key (a month's `late` entry carries late payments and late payouts
 * alike): the lines of one heading, side and detail summed, so an entry holds each once.
 */
export function mergeEntries(...lists: readonly BookEntry[][]): BookEntry[] {
  const out = new Map<string, { entry: BookEntry; lines: Map<string, EntryLine> }>();
  for (const list of lists) {
    for (const e of list) {
      let had = out.get(e.key);
      if (!had) {
        had = { entry: { ...e, lines: [] }, lines: new Map() };
        out.set(e.key, had);
      }
      for (const l of e.lines) {
        const key = [l.side, l.heading, l.taxCode, l.taxCountry, l.method, l.category]
          .map((v) => v ?? "")
          .join("\u0000");
        const same = had.lines.get(key);
        if (same) same.amount += l.amount;
        else had.lines.set(key, { ...l });
      }
    }
  }
  return [...out.values()]
    .map(({ entry, lines }) => ({ ...entry, lines: [...lines.values()] }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
