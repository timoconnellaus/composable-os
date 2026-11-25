// The figures for the books (stage 52, ADR 0791): book entries and their lines. A month's close
// writes one entry per business day (a day summary), one per payout, one for what is held for
// customers at the month's end, and one for each day something arrived for a closed month
// (`late`). Each entry has a key that is the same in every version, balances to the minor unit
// (its debits equal its credits), and carries a fingerprint of its lines, so a reader (Accounting
// sync, stage 61) sees at once which entries a later version changed. Lines carry headings in the
// host's words, never an account code. An entry names nobody.
import { ValidationError } from "../errors.ts";
import { parseLocalDate } from "../time/local.ts";
import { parseMonth } from "./day.ts";

export const ENTRY_KINDS = ["day", "payout", "held", "late"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type Side = "debit" | "credit";

/** One line of an entry: what it is, which side, how much in minor units, and its detail. */
export interface EntryLine {
  heading: string;
  side: Side;
  /** Minor units, a whole number above zero (a line of nothing is dropped). */
  amount: number;
  taxCode?: string | null;
  taxCountry?: string | null;
  method?: string | null;
  category?: string | null;
}

/** One book entry as a close writes it. */
export interface BookEntry {
  key: string;
  kind: EntryKind;
  /** The local date it is for (a day summary's day, a payout's arrival, the month's last day). */
  date: string;
  /** A `late` entry's month: the closed month what it carries belongs to. */
  belongsTo: string | null;
  lines: EntryLine[];
}

/** An entry ready to store: lines in a fixed order, and its fingerprint. */
export interface SealedEntry extends BookEntry {
  fingerprint: string;
}

const PART = "[A-Za-z0-9_.-]+";
const CATEGORY = "[a-z][a-z0-9_]*";
/**
 * The headings an entry line may carry (ADR 0791). Stage 34's payment methods add theirs when its
 * step 3 lands; nothing else adds a heading without amending ADR 0791.
 */
const HEADINGS: readonly RegExp[] = [
  new RegExp(`^sales:${CATEGORY}$`),
  new RegExp(`^refunds:${CATEGORY}$`),
  new RegExp(`^tax:${PART}:[A-Z]{2}$`),
  new RegExp(`^tax_estimated:${PART}:[A-Z]{2}$`),
  /^money_in:provider$/,
  new RegExp(`^money_in:recorded:${CATEGORY}$`),
  new RegExp(`^money_out:${CATEGORY}$`),
  /^held:(gift_card|credit|voucher)$/,
  /^credit_given$/,
  /^held_expired$/,
  /^fees:provider$/,
  /^bank$/,
  /^disputes$/,
  /^adjustments$/,
  /^unmatched$/,
  // A payout's difference from its lines (ADR 0791 as amended for stage 52 step 4, ADR 0793).
  /^payout_difference$/,
];

export function isHeading(heading: string): boolean {
  return HEADINGS.some((re) => re.test(heading));
}

/** The key an entry of this kind has: `day:<date>`, `payout:<id>`, `held:<month>`, `late:<month>@<date>`. */
export function entryKey(
  kind: EntryKind,
  of: { date?: string; payout?: string; month?: string; belongsTo?: string },
): string {
  switch (kind) {
    case "day":
      return `day:${of.date}`;
    case "payout":
      return `payout:${of.payout}`;
    case "held":
      return `held:${of.month}`;
    case "late":
      return `late:${of.belongsTo}@${of.date}`;
  }
}

function keyFits(entry: BookEntry): boolean {
  switch (entry.kind) {
    case "day":
      return entry.key === `day:${entry.date}`;
    case "payout":
      return /^payout:[A-Za-z0-9_.:-]{1,200}$/.test(entry.key);
    case "held":
      return entry.key === `held:${entry.date.slice(0, 7)}`;
    case "late":
      return entry.key === `late:${entry.belongsTo}@${entry.date}`;
  }
}

const lineOrder = (a: EntryLine, b: EntryLine) =>
  a.side.localeCompare(b.side) ||
  a.heading.localeCompare(b.heading) ||
  (a.taxCode ?? "").localeCompare(b.taxCode ?? "") ||
  (a.taxCountry ?? "").localeCompare(b.taxCountry ?? "") ||
  (a.method ?? "").localeCompare(b.method ?? "") ||
  (a.category ?? "").localeCompare(b.category ?? "") ||
  a.amount - b.amount;

const cleanLine = (l: EntryLine): EntryLine => ({
  heading: l.heading,
  side: l.side,
  amount: l.amount,
  taxCode: l.taxCode ?? null,
  taxCountry: l.taxCountry ?? null,
  method: l.method ?? null,
  category: l.category ?? null,
});

/** The sign of the debits less the credits of some lines (zero when they balance). */
export function imbalance(lines: readonly EntryLine[]): number {
  // Summed exactly (BigInt), so amounts near the safe-integer limit cannot round to a balance.
  const total = lines.reduce(
    (sum, l) => sum + (l.side === "debit" ? BigInt(l.amount) : -BigInt(l.amount)),
    0n,
  );
  return total === 0n ? 0 : total > 0n ? 1 : -1;
}

/**
 * An entry checked and put in its stored order: a known kind, a key that fits it, a real date,
 * `belongsTo` exactly on a late entry, known headings, whole positive amounts (zero lines dropped),
 * and debits equal to credits. A figure that fails any of these is a fault in the host's own
 * reports, never the business's data: refused, never stored.
 */
export function checkEntry(entry: BookEntry): BookEntry {
  const fail = (why: string): never => {
    throw new ValidationError(`Book entry ${entry.key}: ${why}`, { rule: "finance_entry" });
  };
  if (!(ENTRY_KINDS as readonly string[]).includes(entry.kind)) fail("an unknown kind");
  if (!parseLocalDate(entry.date)) fail("its date is not a date");
  if ((entry.kind === "late") !== (entry.belongsTo !== null)) {
    fail("only a late entry belongs to another month");
  }
  if (entry.belongsTo !== null && !parseMonth(entry.belongsTo)) fail("belongs to no month");
  if (!keyFits(entry)) fail("its key does not fit its kind and date");
  const lines: EntryLine[] = [];
  for (const l of entry.lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0)
      fail(`${l.heading} is not whole minor units`);
    if (l.side !== "debit" && l.side !== "credit") fail(`${l.heading} has no side`);
    if (!isHeading(l.heading)) fail(`${l.heading} is not a heading`);
    if (l.amount > 0) lines.push(cleanLine(l));
  }
  if (imbalance(lines) !== 0) fail("its debits do not equal its credits");
  return { ...entry, lines: lines.sort(lineOrder) };
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The fingerprint of an entry's lines: SHA-256 of their stored order, so equal lines match. */
export async function lineFingerprint(lines: readonly EntryLine[]): Promise<string> {
  const canonical = JSON.stringify(
    [...lines]
      .map(cleanLine)
      .sort(lineOrder)
      .map((l) => [l.side, l.heading, l.amount, l.taxCode, l.taxCountry, l.method, l.category]),
  );
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/** Checks an entry and adds its fingerprint. */
export async function sealEntry(entry: BookEntry): Promise<SealedEntry> {
  const checked = checkEntry(entry);
  return { ...checked, fingerprint: await lineFingerprint(checked.lines) };
}
