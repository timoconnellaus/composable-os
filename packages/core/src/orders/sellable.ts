// What may be put on an order (stage 27, ADR 0435): an extension object that declares `sellable`
// in its manifest. The declaration is read from the field registry, which the reconciler builds
// from the manifest; there is no other way to make something sellable. An order line may point at
// any record of such an object; the host reads the price from the record, so a caller never sends
// one.
//
// This replaced stage 25's interim registry (`registerSellable`, ADR 0427), which platform code
// filled by hand until the declaration existed.
import type { ObjectDefinition, SellableDefinition } from "../fields/types.ts";

export type Sellable = SellableDefinition;

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
  if (!object.titleField) problems.push("a sellable object needs a title field");
  return problems;
}
