// Tax at checkout (stage 42 section 4, ADR 0479). Prices are tax-inclusive: the host asks for the
// same amount it always did, and when tax is on the payment provider works the tax out inside it.
//
// The host decides only whether to ask, and with which codes:
//   - a line is taxed when a human admin has turned tax on (`order.settings.tax`) and the line's
//     object declares a product tax code (`sellable.tax`), possibly overridden per object by a
//     human admin (`order.settings.taxCodes`). Otherwise the checkout is exactly as before;
//   - the payment is split over the order's lines in proportion to their totals, so each share
//     carries its own code, and an in-person event's share its place;
//   - what the provider says the tax was is stored as it said it (orders/payments.ts). The host
//     never calculates a tax amount.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, TaxDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { loadOrderTax, loadOrderTaxCodes } from "./settings.ts";

/** An event's address for tax, as the provider takes it. */
export interface TaxPlace {
  country: string;
  region?: string;
  postcode?: string;
  city?: string;
  line1?: string;
}

/** One share of a payment, sent to the provider with its code (gatekeeper PaymentsTaxLine). */
export interface CheckoutTaxLine {
  ref: string;
  name: string;
  amount: number;
  taxCode: string;
  place?: TaxPlace;
}

export interface CheckoutTax {
  behavior: "inclusive";
  lines: CheckoutTaxLine[];
}

/** The code a line of `object` is taxed at: an admin's override, else the manifest's. */
export function taxCodeOf(
  object: ObjectDefinition | undefined,
  overrides: Readonly<Record<string, string>>,
): string | null {
  const declared = object?.sellable?.tax;
  if (!declared || !object) return null;
  return overrides[object.name] ?? declared.code;
}

/**
 * Splits `amount` over `weights` in proportion, in whole minor units that sum to `amount`: each
 * share rounded down, and what is left given one unit at a time to the largest remainders (the
 * earlier line first on a tie).
 */
export function splitInProportion(amount: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((total, w) => total + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (amount * w) / sum);
  const shares = exact.map(Math.floor);
  let left = amount - shares.reduce((total, s) => total + s, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

async function readRow(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  id: string,
): Promise<AnyRow | undefined> {
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  return (await (db as any)
    .selectFrom(visibleSource(orgReader(db), object))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as AnyRow | undefined;
}

function fieldValue(object: ObjectDefinition, row: AnyRow, field: string | undefined): unknown {
  if (!field) return undefined;
  const definition = object.fields.find((f) => f.name === field);
  const column = definition ? viewColumnOf(definition) : null;
  return column ? row[column] : undefined;
}

/**
 * Where a line's record is supplied, from its declared place (an event's address): read by the
 * host, org-wide. Refused when the object declares a place and the record has no country for
 * tax: the provider cannot tax admission without the event's place.
 */
export async function placeOf(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  recordId: string,
  tax: TaxDefinition,
  position: number,
): Promise<TaxPlace | undefined> {
  const declared = tax.place;
  if (!declared) return undefined;
  let holder: ObjectDefinition | undefined = object;
  let row = await readRow(db, object, recordId);
  if (declared.via && row) {
    const target = object.fields.find((f) => f.name === declared.via)?.options?.to;
    const id = fieldValue(object, row, declared.via);
    holder = typeof target === "string" ? getObject(target) : undefined;
    row = holder && typeof id === "string" ? await readRow(db, holder, id) : undefined;
  }
  const country =
    holder && row ? text(fieldValue(holder, row, declared.country))?.toUpperCase() : undefined;
  if (!holder || !row || !country || !/^[A-Z]{2}$/.test(country)) {
    throw new ValidationError(
      "This cannot be paid while tax is on: where it takes place has no country for tax yet",
      { rule: "tax_place", line: position },
    );
  }
  const place: TaxPlace = { country };
  const part = (key: "region" | "postcode" | "city" | "line1", max: number) => {
    const value = text(fieldValue(holder as ObjectDefinition, row as AnyRow, declared[key]));
    if (value) place[key] = value.slice(0, max);
  };
  part("region", 100);
  part("postcode", 20);
  part("city", 100);
  part("line1", 200);
  return place;
}

/**
 * The tax to ask the provider for on a payment of `amount` towards order `orderId`, or null when
 * the checkout is to be exactly as before tax: the setting is off, or no line's object declares a
 * code. An order mixing lines with a code and lines without one is refused while tax is on: the
 * provider would tax the second kind at the account's default code, a guess this host does not make.
 */
export async function checkoutTax(
  db: Kysely<CoreDatabase>,
  orderId: string,
  amount: number,
  prefix: string,
): Promise<CheckoutTax | null> {
  if (!(await loadOrderTax(db))) return null;
  const overrides = await loadOrderTaxCodes(db);
  const rows = await db
    .selectFrom("core_order_line")
    .select(["id", "position", "object_type", "record_id", "title", "quantity", "line_total"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute();
  const lines = rows.map((row) => {
    const object = getObject(row.object_type);
    return { row, object, code: taxCodeOf(object, overrides) };
  });
  const coded = lines.filter((line) => line.code !== null);
  if (coded.length === 0) return null;
  if (coded.length !== lines.length) {
    throw new ValidationError(
      "This order mixes things that declare a tax code and things that do not, so it cannot be " +
        "paid while tax is on",
      { rule: "tax_mixed" },
    );
  }
  const priced = lines.filter((line) => line.row.line_total > 0);
  const shares = splitInProportion(
    amount,
    priced.map((line) => line.row.line_total),
  );
  const out: CheckoutTaxLine[] = [];
  for (const [index, line] of priced.entries()) {
    const share = shares[index] ?? 0;
    if (share <= 0) continue;
    const object = line.object as ObjectDefinition;
    const place = await placeOf(
      db,
      object,
      line.row.record_id,
      object.sellable?.tax as TaxDefinition,
      line.row.position,
    );
    const item =
      line.row.quantity > 1 ? `${line.row.quantity} x ${line.row.title}` : line.row.title;
    out.push({
      ref: line.row.id,
      name: `${prefix}${item}`.slice(0, 200) || line.row.id,
      amount: share,
      taxCode: line.code as string,
      ...(place ? { place } : {}),
    });
  }
  return { behavior: "inclusive", lines: out };
}
