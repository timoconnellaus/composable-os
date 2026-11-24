// What may be put on an order (stage 27, ADR 0435): an extension object that declares `sellable`
// in its manifest. The declaration is read from the field registry, which the reconciler builds
// from the manifest; there is no other way to make something sellable. An order line may point at
// any record of such an object; the host reads the price from the record, so a caller never sends
// one.
//
// This replaced stage 25's interim registry (`registerSellable`, ADR 0427), which platform code
// filled by hand until the declaration existed.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import type { ObjectDefinition, SellableDefinition } from "../fields/types.ts";
import type { AnyRow, VisibleSource } from "../visibility/index.ts";

export type Sellable = SellableDefinition;

/**
 * The most records one order may be granted, across its lines. Each grant adds 5 statements to
 * the paid batch (the record, its history row, its search document's delete and insert, the grant
 * row; measured in test/sellable.test.ts), on about 15 for the payment itself, so 100 grants is a
 * batch of about 515 statements: half the 1,000 queries a Worker invocation may make on D1, which
 * leaves room for several lines' holds, the audit and the confirmation.
 */
export const GRANTS_PER_ORDER_CEILING = 100;
/** The most of one record a line may hold when its object grants and its record sets no limit. */
export const GRANTS_PER_LINE_DEFAULT = 10;

/**
 * The most of one record a line may hold, given the record's own `maxPerOrder` (null when unset):
 * that limit, or the host's when the object grants something, never more than the ceiling.
 * Null when nothing limits it but ORDER_MAX_QUANTITY.
 */
export function lineLimit(sellable: Sellable, recordMax: number | null): number | null {
  const own = recordMax === null ? null : Math.max(Math.floor(recordMax), 0);
  if (!sellable.grants) return own;
  return Math.min(own ?? GRANTS_PER_LINE_DEFAULT, GRANTS_PER_ORDER_CEILING);
}

/** The object's sellable declaration, or undefined when it cannot be bought. */
export function sellableOf(object: ObjectDefinition): Sellable | undefined {
  return object.sellable;
}

/**
 * What is wrong with a declaration against the object it names (empty when nothing is). The
 * contract check refuses these before an extension is installed; the host checks again before it
 * prices a line, so a declaration the registry no longer matches sells nothing.
 */
export function sellableProblems(sellable: Sellable, object: ObjectDefinition): string[] {
  const problems: string[] = [];
  const field = (name: string) => object.fields.find((f) => f.name === name);
  const numeric = (name: string, what: string) => {
    const f = field(name);
    if (!f?.column) problems.push(`${what} "${name}" is not a single-valued field`);
    else if (f.type !== "number") problems.push(`${what} "${name}" is not a number`);
  };
  const date = (name: string, what: string) => {
    const f = field(name);
    if (!f?.column || (f.type !== "date" && f.type !== "datetime")) {
      problems.push(`${what} "${name}" is not a date field`);
    }
  };
  numeric(sellable.price, "price");
  if (sellable.maxPerOrder) numeric(sellable.maxPerOrder, "maxPerOrder");
  if (sellable.saleWindow?.from) date(sellable.saleWindow.from, "saleWindow.from");
  if (sellable.saleWindow?.until) date(sellable.saleWindow.until, "saleWindow.until");
  if (sellable.deposit) {
    numeric(sellable.deposit.amount, "deposit.amount");
    date(sellable.deposit.balanceDue, "deposit.balanceDue");
  }
  if (sellable.recurring?.trialDays) numeric(sellable.recurring.trialDays, "recurring.trialDays");
  if (!object.titleField) problems.push("a sellable object needs a title field");
  return problems;
}

/** One record's row of a view (`source`: the object's view as some reader sees it), or undefined. */
export function viewRow(
  db: Kysely<CoreDatabase>,
  source: VisibleSource<AnyRow, string>,
  id: string,
): Promise<AnyRow | undefined> {
  return db.selectFrom(source).selectAll().where("id", "=", id).executeTakeFirst();
}
