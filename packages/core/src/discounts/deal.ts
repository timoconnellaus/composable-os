// The deal (stage 34 step 4, ADR 0693): the one discount an order gets, worked out by the host
// when it prices the order (orders/orders.ts, `priceOrder`), from records of objects declaring the
// `discount` behaviour. A caller sends at most a code; every amount is read from the record.
//
// The rules (the spec's "rules at pricing"):
//   1. Every automatic discount the buyer qualifies for and the code, when one is given, are
//      worked out on the lines as priced; the one that takes most off applies (decision 9). On a
//      tie, an automatic one (it spends nobody's code). A staff adjustment comes after it.
//   2. Who: a guest never qualifies for anything but `anyone`, nor for a discount with a limit
//      per person, the same answer for every address. A signed-in customer and staff buying for
//      a Person do.
//   3. New customer: no paid order and no live subscription for any Person sharing a folded
//      address (ADR 0692).
//   4. A percentage is rounded down per line; an amount is spread over the lines it applies to in
//      proportion; a set price takes off the difference per unit, never below nothing.
//   5. A deal never makes the order free: one that would take every line but the delivery to
//      nothing does not apply (a code that would is not valid here); nor one that leaves less to
//      pay than the order setting `minCharge` (0.50 by default), which stands in for the
//      provider's minimum charge.
//   7. Limits are read here and held by the database in the order's batch (discounts/uses.ts).
//   8. A delivery is never discounted; its free postage is decided after the deal, on the goods'
//      net (orders/goods.ts).
//
// A code that does not apply gets one answer whatever the reason (unknown, not live, outside its
// dates, used up, not for this buyer, not for these lines): the reason is kept for staff only.

import type { CoreDatabase } from "@composable-os/db";
import { foldCode } from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import { samePeople } from "../customers/accounts.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { DiscountDefinition, ObjectDefinition } from "../fields/types.ts";
import type { Guesses } from "../guesses.ts";
import { percentOff } from "../orders/adjustments.ts";
import { loadMinCharge, toMinorUnits } from "../orders/settings.ts";
import { splitInProportion } from "../orders/tax.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { possibleCode } from "./words.ts";

/** The longest code a caller may type (the SDK's, one for the host and packs). */
export { CODE_MAX_LENGTH } from "@composable-os/sdk";

/** How many automatic discounts of one object are weighed for one order, and codes matched. */
const CANDIDATES_PER_OBJECT = 25;
const CODES_MATCHED = 5;

/** Who is buying, as the order says: their Person (when proved) and how they came. */
export interface DealBuyer {
  personId: string | null;
  placedAs: "customer" | "public" | "staff";
}

/** A line as the deal sees it. A delivery is never discounted. */
export interface DealLine {
  id: string;
  position: number;
  object: string;
  recordId: string;
  unitPrice: number;
  quantity: number;
  total: number;
  delivery?: boolean;
}

export interface DealShare {
  lineId: string;
  amount: number;
}

/** The one discount on an order, and what it takes off each line. */
export interface Deal {
  kind: "code" | "automatic";
  discountObject: string;
  discountId: string;
  title: string;
  codeObject: string | null;
  codeId: string | null;
  /** Asked as a percentage, when it is one. */
  percent: number | null;
  amount: number;
  shares: DealShare[];
  limits: { maxUses: number | null; maxPerPerson: number | null; codeMaxUses: number | null };
}

/** Why a code did not apply. Never told to a caller outside the org: one answer for every one. */
export type CodeRefusal =
  | "unknown"
  | "not_live"
  | "dates"
  | "who"
  | "used_up"
  | "min_spend"
  | "nothing_here"
  | "free"
  | "min_charge";

export type CodeOutcome =
  | { given: false }
  | { given: true; valid: true; applied: boolean; deal: Deal }
  | { given: true; valid: false; reason: CodeRefusal };

export interface DealOutcome {
  deal: Deal | null;
  code: CodeOutcome;
}

/** The one answer a caller outside the org gets for a code that does not apply. */
export const CODE_NOT_VALID = "This code is not valid here";

/** A code as compared and kept (ADR 0940): `foldCode`, so non-ASCII letters match too. */
export function normaliseCode(code: string): string {
  return foldCode(code);
}

/** Every object declaring the discount behaviour. */
export function discountObjects(): (ObjectDefinition & { discount: DiscountDefinition })[] {
  return listObjects().filter(
    (o): o is ObjectDefinition & { discount: DiscountDefinition } => o.discount !== undefined,
  );
}

const column = (object: ObjectDefinition, name: string | undefined): string | null => {
  if (!name) return null;
  const field = object.fields.find((f) => f.name === name);
  return field ? viewColumnOf(field) : null;
};

function valuesOf(object: ObjectDefinition, row: AnyRow): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of object.fields) {
    const col = viewColumnOf(field);
    if (col && Object.hasOwn(row, col)) values[field.name] = row[col];
  }
  return values;
}

/** A multi-valued field's values (a JSON array), or a single one's. */
function many(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [String(value)];
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** A date or datetime as a moment: a date from the start of its day, or through its end, UTC. */
function moment(value: unknown, end: "start" | "end"): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}${end === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`
    : value;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// biome-ignore lint/suspicious/noExplicitAny: a registry-driven view, not a key of the typed schema.
const any = (db: Kysely<CoreDatabase>) => db as unknown as Kysely<any>;

/** A discount record as read, with what the deal needs from it. */
interface DiscountRecord {
  object: ObjectDefinition & { discount: DiscountDefinition };
  id: string;
  values: Record<string, unknown>;
}

/** What the buyer is, read once per order and only as far as a discount asks. */
class BuyerFacts {
  private subscriptions?: Promise<{ plan_id: string }[]>;
  private person?: Promise<{ organisation_id: unknown; tags: unknown } | undefined>;
  private fresh?: Promise<boolean>;
  constructor(
    private readonly db: Kysely<CoreDatabase>,
    readonly buyer: DealBuyer,
  ) {}

  /** A buyer who proved who they are: never a guest. */
  get proved(): string | null {
    return this.buyer.placedAs !== "public" && this.buyer.personId ? this.buyer.personId : null;
  }

  plans(personId: string) {
    this.subscriptions ??= this.db
      .selectFrom("core_subscription")
      .select("plan_id")
      .where("holder_person_id", "=", personId)
      .where("state", "in", ["trialing", "active", "past_due"])
      .execute();
    return this.subscriptions;
  }

  personRow(personId: string) {
    this.person ??= this.db
      .selectFrom(visibleSource(orgReader(this.db), "person"))
      .select(["organisation_id", "tags"])
      .where("id", "=", personId)
      .executeTakeFirst();
    return this.person;
  }

  /** No paid order and no subscription for anyone sharing a folded address (ADR 0692). */
  isNew(personId: string): Promise<boolean> {
    this.fresh ??= (async () => {
      const order = getObject("order");
      const people = samePeople(this.db, personId);
      const paid = order
        ? await any(this.db)
            .selectFrom(visibleSource(orgReader(this.db), order))
            .select("id")
            .where("person_id", "in", people)
            .where("paid_at", "is not", null)
            .limit(1)
            .executeTakeFirst()
        : undefined;
      if (paid) return false;
      const subscribed = await this.db
        .selectFrom("core_subscription")
        .select("id")
        .where((eb) =>
          eb.or([
            eb("holder_person_id", "in", samePeople(this.db, personId)),
            eb("payer_person_id", "in", samePeople(this.db, personId)),
          ]),
        )
        .where("state", "not in", ["incomplete", "expired"])
        .limit(1)
        .executeTakeFirst();
      return !subscribed;
    })();
    return this.fresh;
  }
}

/** Uses held or used, per discount and per code, leaving out one order's own (it is re-priced). */
async function usesOf(
  db: Kysely<CoreDatabase>,
  records: readonly DiscountRecord[],
  excludeOrderId: string | undefined,
): Promise<Map<string, number>> {
  const ids = records.filter((r) => r.object.discount.totalUses).map((r) => r.id);
  if (!ids.length) return new Map();
  let query = db
    .selectFrom("core_discount_use")
    .select(["discount_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("discount_id", "in", ids)
    .where("state", "in", ["held", "used"])
    .groupBy("discount_id");
  if (excludeOrderId) query = query.where("order_id", "!=", excludeOrderId);
  const rows = await query.execute();
  return new Map(rows.map((r) => [r.discount_id, Number(r.n)]));
}

async function personUsesOf(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  personId: string,
  excludeOrderId: string | undefined,
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  let query = db
    .selectFrom("core_discount_use")
    .select(["discount_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("discount_id", "in", ids)
    .where("state", "in", ["held", "used"])
    .where("person_id", "in", samePeople(db, personId))
    .groupBy("discount_id");
  if (excludeOrderId) query = query.where("order_id", "!=", excludeOrderId);
  const rows = await query.execute();
  return new Map(rows.map((r) => [r.discount_id, Number(r.n)]));
}

/** A discount's state is one it applies in. */
function isLive(record: DiscountRecord): boolean {
  const field = record.object.states?.field;
  return field ? record.object.discount.live.includes(String(record.values[field] ?? "")) : false;
}

/** The lines a discount applies to: every line but a delivery, narrowed by objects and records. */
function linesFor(record: DiscountRecord, lines: readonly DealLine[]): DealLine[] {
  const declared = record.object.discount;
  const objects = declared.objects ? many(record.values[declared.objects]) : [];
  const named = (declared.records ?? []).flatMap((f) => many(record.values[f]));
  return lines.filter((line) => {
    if (line.delivery || line.total <= 0) return false;
    if (!objects.length && !named.length) return true;
    return objects.includes(line.object) || named.includes(line.recordId);
  });
}

/** What the discount takes off `lines`, per line, or null when it takes nothing. */
function sharesOf(
  record: DiscountRecord,
  lines: readonly DealLine[],
  currency: string,
): { shares: DealShare[]; percent: number | null } | null {
  const declared = record.object.discount;
  const kind = String(record.values[declared.kind] ?? "");
  if (kind === "percent") {
    const percent = declared.percent ? record.values[declared.percent] : null;
    if (typeof percent !== "number" || !(percent > 0) || percent > 100) return null;
    const shares = lines.map((line) => ({
      lineId: line.id,
      amount: percentOff([line.total], percent),
    }));
    return { shares, percent };
  }
  const money = declared.amount ? toMinorUnits(record.values[declared.amount], currency) : null;
  if (money === null) return null;
  if (kind === "amount") {
    if (money <= 0) return null;
    const room = lines.reduce((sum, line) => sum + line.total, 0);
    const split = splitInProportion(
      Math.min(money, room),
      lines.map((line) => line.total),
    );
    return {
      shares: lines.map((line, i) => ({
        lineId: line.id,
        amount: Math.min(split[i] ?? 0, line.total),
      })),
      percent: null,
    };
  }
  if (kind === "price") {
    return {
      shares: lines.map((line) => ({
        lineId: line.id,
        amount: Math.min(Math.max(line.unitPrice - money, 0) * line.quantity, line.total),
      })),
      percent: null,
    };
  }
  return null;
}

interface Weighed {
  ok: true;
  deal: Deal;
}
interface Refused {
  ok: false;
  reason: CodeRefusal;
}

/**
 * Whether `record` applies to these lines for this buyer now, and what it takes off. The limits
 * are read here (the uses already held or used); the database holds the last one.
 */
async function weigh(
  record: DiscountRecord,
  kind: "code" | "automatic",
  code: { object: string; id: string; maxUses: number | null } | null,
  lines: readonly DealLine[],
  facts: BuyerFacts,
  now: string,
  currency: string,
  uses: Map<string, number>,
  personUses: Map<string, number>,
  minCharge: number,
): Promise<Weighed | Refused> {
  const declared = record.object.discount;
  const v = record.values;
  if (!isLive(record)) return { ok: false, reason: "not_live" };
  const from = declared.from ? moment(v[declared.from], "start") : null;
  const until = declared.until ? moment(v[declared.until], "end") : null;
  if ((from && now < from) || (until && now > until)) return { ok: false, reason: "dates" };

  // Who.
  const who = declared.who ? String(v[declared.who] ?? "anyone") || "anyone" : "anyone";
  const maxPerPerson = declared.perPerson ? count(v[declared.perPerson]) : null;
  const personId = facts.proved;
  if (who !== "anyone" || maxPerPerson !== null) {
    if (!personId) return { ok: false, reason: "who" };
  }
  if (personId) {
    if (who === "members") {
      const plans = declared.plans ? many(v[declared.plans]) : [];
      const held = await facts.plans(personId);
      if (!held.some((s) => !plans.length || plans.includes(s.plan_id))) {
        return { ok: false, reason: "who" };
      }
    } else if (who === "new_customers") {
      if (!(await facts.isNew(personId))) return { ok: false, reason: "who" };
    } else if (who === "organisation") {
      const orgs = declared.organisations ? many(v[declared.organisations]) : [];
      const row = await facts.personRow(personId);
      if (!row?.organisation_id || !orgs.includes(String(row.organisation_id))) {
        return { ok: false, reason: "who" };
      }
    } else if (who === "tag") {
      const tag = declared.tag
        ? String(v[declared.tag] ?? "")
            .trim()
            .toLowerCase()
        : "";
      const row = await facts.personRow(personId);
      const tags = many(row?.tags).map((t) => t.trim().toLowerCase());
      if (!tag || !tags.includes(tag)) return { ok: false, reason: "who" };
    } else if (who !== "anyone" && who !== "signed_in") {
      return { ok: false, reason: "who" };
    }
  }

  // Limits, as read.
  const maxUses = declared.totalUses ? count(v[declared.totalUses]) : null;
  if (maxUses !== null && (uses.get(record.id) ?? 0) >= maxUses) {
    return { ok: false, reason: "used_up" };
  }
  if (maxPerPerson !== null && (personUses.get(record.id) ?? 0) >= maxPerPerson) {
    return { ok: false, reason: "used_up" };
  }
  if (code?.maxUses != null && (uses.get(`code:${code.id}`) ?? 0) >= code.maxUses) {
    return { ok: false, reason: "used_up" };
  }

  // On what, and how much.
  const eligible = linesFor(record, lines);
  if (!eligible.length) return { ok: false, reason: "nothing_here" };
  const minSpend = declared.minSpend ? toMinorUnits(v[declared.minSpend], currency) : null;
  const spend = eligible.reduce((sum, line) => sum + line.total, 0);
  if (minSpend !== null && spend < minSpend) return { ok: false, reason: "min_spend" };
  const off = sharesOf(record, eligible, currency);
  const shares = (off?.shares ?? []).filter((s) => s.amount > 0);
  const amount = shares.reduce((sum, s) => sum + s.amount, 0);
  if (!off || amount <= 0) return { ok: false, reason: "nothing_here" };
  const goods = lines.filter((line) => !line.delivery).reduce((sum, line) => sum + line.total, 0);
  if (amount >= goods) return { ok: false, reason: "free" };
  // Something left to pay, but less than can be charged (the spec's rule 5, the order setting
  // standing in for the provider's minimum): not applied.
  const owed = lines.reduce((sum, line) => sum + line.total, 0) - amount;
  if (owed < minCharge) return { ok: false, reason: "min_charge" };
  const title = record.object.titleField ? v[record.object.titleField] : null;
  return {
    ok: true,
    deal: {
      kind,
      discountObject: record.object.name,
      discountId: record.id,
      title: title == null || title === "" ? record.object.label : String(title),
      codeObject: code?.object ?? null,
      codeId: code?.id ?? null,
      percent: off.percent,
      amount,
      shares,
      limits: { maxUses, maxPerPerson, codeMaxUses: code?.maxUses ?? null },
    },
  };
}

/**
 * Live automatic discounts of every discount object that could apply now: in their dates, and
 * for a guest only those for anyone with no per-person limit. Filtered before the cap, newest
 * first, so discounts out of date never crowd out one that applies (the review of PR #454). At
 * most CANDIDATES_PER_OBJECT each; `weigh` judges every rule again.
 */
async function automaticOnes(
  db: Kysely<CoreDatabase>,
  now: string,
  guest: boolean,
): Promise<DiscountRecord[]> {
  const found: DiscountRecord[] = [];
  const today = now.slice(0, 10);
  const empty = (col: string) => sql<boolean>`(${sql.ref(col)} IS NULL OR ${sql.ref(col)} = '')`;
  for (const object of discountObjects()) {
    const declared = object.discount;
    const auto = column(object, declared.automatic);
    const state = column(object, object.states?.field);
    if (!auto || !state) continue;
    const from = column(object, declared.from);
    const until = column(object, declared.until);
    const who = column(object, declared.who);
    const perPerson = column(object, declared.perPerson);
    let query = any(db)
      .selectFrom(visibleSource(orgReader(db), object))
      .selectAll()
      .where(auto, "=", 1)
      .where(state, "in", [...declared.live]);
    // A date is from the start of its day (`<=` the moment); a datetime is a moment.
    if (from) query = query.where(sql<boolean>`(${empty(from)} OR ${sql.ref(from)} <= ${now})`);
    // A date runs through its day (`>=` today); a datetime until its moment.
    if (until) {
      query = query.where(
        sql<boolean>`(${empty(until)} OR (length(${sql.ref(until)}) = 10 AND ${sql.ref(until)} >= ${today}) OR ${sql.ref(until)} >= ${now})`,
      );
    }
    if (guest) {
      if (who) query = query.where(sql<boolean>`(${empty(who)} OR ${sql.ref(who)} = 'anyone')`);
      if (perPerson) query = query.where(sql<boolean>`${sql.ref(perPerson)} IS NULL`);
    }
    const rows = (await query
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(CANDIDATES_PER_OBJECT)
      .execute()) as AnyRow[];
    for (const row of rows) {
      found.push({ object, id: String(row.id), values: valuesOf(object, row) });
    }
  }
  return found;
}

interface CodeMatch {
  record: DiscountRecord;
  code: { object: string; id: string; maxUses: number | null } | null;
}

/** The discounts a typed code names: a discount's own word, or a code record's. */
async function codeMatches(db: Kysely<CoreDatabase>, typed: string): Promise<CodeMatch[]> {
  const word = normaliseCode(typed);
  // Words are kept folded and at least CODE_MIN_LENGTH long (words.ts): nothing else is one.
  if (!possibleCode(word)) return [];
  const matches: CodeMatch[] = [];
  for (const object of discountObjects()) {
    const declared = object.discount;
    const own = column(object, declared.code);
    if (own) {
      const rows = (await any(db)
        .selectFrom(visibleSource(orgReader(db), object))
        .selectAll()
        // By the reconciler's unique index on the live records' folded words: no scan.
        .where(own, "=", word)
        .orderBy("id")
        .limit(CODES_MATCHED)
        .execute()) as AnyRow[];
      for (const row of rows) {
        matches.push({
          record: { object, id: String(row.id), values: valuesOf(object, row) },
          code: null,
        });
      }
    }
    const codes = declared.codes;
    const codeObject = codes ? getObject(codes.object) : undefined;
    if (!codes || !codeObject) continue;
    const wordCol = column(codeObject, codes.word);
    const discountCol = column(codeObject, codes.discount);
    if (!wordCol || !discountCol) continue;
    const rows = (await any(db)
      .selectFrom(visibleSource(orgReader(db), codeObject))
      .selectAll()
      .where(wordCol, "=", word)
      .orderBy("id")
      .limit(CODES_MATCHED)
      .execute()) as AnyRow[];
    for (const row of rows) {
      const values = valuesOf(codeObject, row);
      if (codes.active && !(values[codes.active] === 1 || values[codes.active] === true)) continue;
      const discountId = values[codes.discount];
      if (typeof discountId !== "string" || !discountId) continue;
      const discount = (await any(db)
        .selectFrom(visibleSource(orgReader(db), object))
        .selectAll()
        .where("id", "=", discountId)
        .executeTakeFirst()) as AnyRow | undefined;
      if (!discount) continue;
      matches.push({
        record: { object, id: discountId, values: valuesOf(object, discount) },
        code: {
          object: codeObject.name,
          id: String(row.id),
          maxUses: codes.uses ? count(values[codes.uses]) : null,
        },
      });
    }
  }
  return matches;
}

/**
 * Works out an order's one deal (rules 1 to 5): the automatic discounts the buyer qualifies for
 * and the code, when one is given; the one that takes most off. Reads only: the use is held by
 * the caller's batch (discounts/uses.ts). `excludeOrderId` leaves out an order's own use, when a
 * pending order's code is changed.
 */
export async function workOutDeal(
  db: Kysely<CoreDatabase>,
  lines: readonly DealLine[],
  buyer: DealBuyer,
  code: string | undefined,
  now: string,
  currency: string,
  options: {
    excludeOrderId?: string | undefined;
    /**
     * On a call from outside the org (ADR 0940): checked before a code is looked at, so the right
     * code is refused too once this address gave too many wrong ones; a wrong one is counted.
     */
    guesses?: Guesses | undefined;
  } = {},
): Promise<DealOutcome> {
  if (code !== undefined) await options.guesses?.check();
  const outcome = await dealFor(db, lines, buyer, code, now, currency, options);
  if (outcome.code.given && !outcome.code.valid) await options.guesses?.wrong();
  return outcome;
}

async function dealFor(
  db: Kysely<CoreDatabase>,
  lines: readonly DealLine[],
  buyer: DealBuyer,
  code: string | undefined,
  now: string,
  currency: string,
  options: { excludeOrderId?: string | undefined },
): Promise<DealOutcome> {
  if (!discountObjects().length) {
    return {
      deal: null,
      code:
        code === undefined ? { given: false } : { given: true, valid: false, reason: "unknown" },
    };
  }
  const facts = new BuyerFacts(db, buyer);
  const minCharge = await loadMinCharge(db);
  const automatic = await automaticOnes(db, now, !facts.proved);
  const matches = code === undefined ? [] : await codeMatches(db, code);
  const records = [...automatic, ...matches.map((m) => m.record)];
  const uses = await usesOf(db, records, options.excludeOrderId);
  const codeIds = matches.flatMap((m) => (m.code?.maxUses != null ? [m.code] : []));
  if (codeIds.length) {
    let query = db
      .selectFrom("core_discount_use")
      .select(["code_id", (eb) => eb.fn.countAll<number>().as("n")])
      .where(
        "code_id",
        "in",
        codeIds.map((c) => c.id),
      )
      .where("state", "in", ["held", "used"])
      .groupBy("code_id");
    if (options.excludeOrderId) query = query.where("order_id", "!=", options.excludeOrderId);
    for (const row of await query.execute()) uses.set(`code:${row.code_id}`, Number(row.n));
  }
  const perPerson = records.filter((r) => r.object.discount.perPerson).map((r) => r.id);
  const personUses =
    facts.proved && perPerson.length
      ? await personUsesOf(db, [...new Set(perPerson)], facts.proved, options.excludeOrderId)
      : new Map<string, number>();

  let best: Deal | null = null;
  const better = (deal: Deal) => !best || deal.amount > best.amount;
  for (const record of automatic) {
    const weighed = await weigh(
      record,
      "automatic",
      null,
      lines,
      facts,
      now,
      currency,
      uses,
      personUses,
      minCharge,
    );
    if (weighed.ok && better(weighed.deal)) best = weighed.deal;
  }
  if (code === undefined) return { deal: best, code: { given: false } };

  // The code: the best of what it names (one word may name a discount and a code record).
  let codeDeal: Deal | null = null;
  let refusal: CodeRefusal = "unknown";
  for (const match of matches) {
    const weighed = await weigh(
      match.record,
      "code",
      match.code,
      lines,
      facts,
      now,
      currency,
      uses,
      personUses,
      minCharge,
    );
    if (weighed.ok) {
      if (!codeDeal || weighed.deal.amount > codeDeal.amount) codeDeal = weighed.deal;
    } else if (refusal === "unknown") {
      refusal = weighed.reason;
    }
  }
  if (!codeDeal) return { deal: best, code: { given: true, valid: false, reason: refusal } };
  // The better for the buyer; on a tie, the automatic one (no code spent).
  const applied = better(codeDeal);
  return {
    deal: applied ? codeDeal : best,
    code: { given: true, valid: true, applied, deal: codeDeal },
  };
}
