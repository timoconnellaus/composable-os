// What may be put on an order (stage 25, ADR 0427): the host's list of objects that have a price,
// and which of their fields hold it. An order line may point at any record of one of them; the
// host reads the price from the record, so a caller never sends one.
//
// This is the seam stage 27's `sellable` behaviour fills from an object's manifest. Until then
// platform code registers an object here (tests register a fixture). It is not in the SDK or the
// contract: an extension cannot make one of its objects sellable by calling anything.
import type { ObjectDefinition } from "../fields/types.ts";

/** Which fields of an object say what it costs. Names are registry field names. */
export interface Sellable {
  /** The object's registry name. */
  object: string;
  /** A number or currency field: the unit price, in the currency's major unit. */
  price: string;
  /**
   * Paying by deposit, when the object offers it: the field holding the deposit for one unit and
   * the date field saying when the balance is due. A record offers a deposit when both have a
   * value.
   */
  deposit?: { amount: string; balanceDue: string } | undefined;
}

const sellables = new Map<string, Sellable>();

/** Makes `sellable.object` something an order line may point at. Platform code only. */
export function registerSellable(sellable: Sellable): () => void {
  sellables.set(sellable.object, sellable);
  return () => {
    if (sellables.get(sellable.object) === sellable) sellables.delete(sellable.object);
  };
}

export function sellableOf(object: string): Sellable | undefined {
  return sellables.get(object);
}

/** What is wrong with a declaration against the object it names (empty when nothing is). */
export function sellableProblems(sellable: Sellable, object: ObjectDefinition): string[] {
  const problems: string[] = [];
  const field = (name: string) => object.fields.find((f) => f.name === name);
  const numeric = (name: string, what: string) => {
    const f = field(name);
    if (!f?.column) problems.push(`${what} "${name}" is not a single-valued field`);
    else if (f.type !== "number") problems.push(`${what} "${name}" is not a number`);
  };
  numeric(sellable.price, "price");
  if (sellable.deposit) {
    numeric(sellable.deposit.amount, "deposit.amount");
    const due = field(sellable.deposit.balanceDue);
    if (!due?.column || (due.type !== "date" && due.type !== "datetime")) {
      problems.push(`deposit.balanceDue "${sellable.deposit.balanceDue}" is not a date field`);
    }
  }
  if (!object.titleField) problems.push("a sellable object needs a title field");
  return problems;
}
