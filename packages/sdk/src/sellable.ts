// The `sellable` behaviour (stage 27, ADR 0435): an object's records can be put on an order. The
// host reads the price from the record, refuses a line outside the sale window or over the most
// one order may hold, and, when the order is first paid, creates what a paid line grants (a
// ticket per place) in the batch that marks it paid. Its declaration, its manifest schema and its
// contract checks live here; the host's side is packages/core/src/orders/ (sellable.ts, grants.ts).
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";
import { moveOrigins } from "./states.ts";

/**
 * Where a granted record's field gets its value, when the host creates it:
 *
 * - `item`: the record that was bought (a relation to this sellable object);
 * - `item.<field>`: a field of the record that was bought (its event, its name);
 * - `order`: the order's id (a text field);
 * - `order.person`: the buyer, a relation to a person (empty when the order belongs to no one
 *   yet, so the field cannot be required);
 * - `order.email`: the address the order was placed with;
 * - `line`: the order line's id (a text field);
 * - `line.title`: what the line was called when it was bought;
 * - `line.unitPrice`: what one cost, in the currency's major unit;
 * - `code`: a long, random, unguessable code the host makes (a ticket's). A read-only text field;
 *   at most one per grant. The host keeps it unique across every granted record.
 */
export type GrantSource =
  | "item"
  | `item.${string}`
  | "order"
  | "order.person"
  | "order.email"
  | "line"
  | "line.title"
  | "line.unitPrice"
  | "code";

/**
 * What a paid line grants: one record of `object` for each unit bought (two tickets for a line
 * of two), created by the host, as the host, when the order is first paid (the move to `paid`,
 * or to `part_paid` for a deposit), in the same batch. No extension code runs.
 *
 * - `object` is another of this extension's objects. It declares `states`; its records start in
 *   the initial state.
 * - `set` names, for each field of the granted record the host fills, where its value comes from
 *   (see GrantSource). Every required field of the granted object must be set from a source that
 *   always has a value.
 * - `void` is the state the host moves what was granted to when the order is refunded in full, or
 *   cancelled after a deposit. Every state but `void` and the final ones needs a `host` move into
 *   it. A record already there, or in a final state, is left alone.
 */
export interface GrantSpec {
  object: string;
  set: Readonly<Record<string, GrantSource>>;
  void: string;
}

/**
 * Something that can be bought (ADR 0435). An order line may point only at a record of an object
 * that declares it; the host prices the line from the record, so a caller never sends a price.
 * Only a shipped pack or the org's own extension may declare it: selling to the public is a
 * reviewed change, so a runtime extension that does is refused at check and install.
 *
 * - `price`: this object's currency (or number) field holding the price of one, in the currency's
 *   major unit. A record with no price cannot be bought.
 * - `currency`: what the price is in (ISO 4217). Left out, the price field's own currency, and
 *   with neither, the deployment's. A line priced in another currency than the deployment's is
 *   refused.
 * - `saleWindow`: the date or datetime fields saying when a record is on sale, from `from` and
 *   until `until` (a date: the whole day, in UTC). Empty values leave that end open. A line
 *   outside it is refused with `{ rule: "sale_window" }`.
 * - `maxPerOrder`: a number field holding the most of one record one order may hold. Empty means
 *   no limit beyond the host's own: 10 when the object grants, and never more than 100 grants
 *   on one order (the paid batch has a size). More is refused with `{ rule: "max_per_order" }`.
 * - `deposit`: paying by deposit (stage 25): the field holding the deposit for one, and the date
 *   field saying when the balance is due. A record offers a deposit when both have a value.
 * - `grants`: what a paid line grants (see GrantSpec).
 */
export interface SellableSpec {
  price: string;
  currency?: string;
  saleWindow?: { from?: string; until?: string };
  maxPerOrder?: string;
  deposit?: { amount: string; balanceDue: string };
  grants?: GrantSpec;
}

const fieldName = z.string().max(40);

export const GRANT_SOURCES = [
  "item",
  "order",
  "order.person",
  "order.email",
  "line",
  "line.title",
  "line.unitPrice",
  "code",
] as const;

const grantSource = z.union([
  z.enum(GRANT_SOURCES),
  z.string().regex(/^item\.[a-z][a-zA-Z0-9]{0,39}$/, "Use item, item.<field>, order, line or code"),
]);

export const sellableManifestSchema = z
  .object({
    price: fieldName,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    saleWindow: z
      .object({ from: fieldName.optional(), until: fieldName.optional() })
      .strict()
      .optional(),
    maxPerOrder: fieldName.optional(),
    deposit: z
      .object({ amount: fieldName.optional(), balanceDue: fieldName.optional() })
      .strict()
      .optional(),
    grants: z
      .object({
        object: z.string().max(40),
        set: z.record(fieldName, grantSource),
        void: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SellableManifest = z.infer<typeof sellableManifestSchema>;

const NUMERIC = new Set(["number", "currency"]);
const DATES = new Set(["date", "datetime"]);
const TEXT = new Set(["text"]);

/** Reports problems with `objects.<name>.sellable` through `contract`. */
export function checkObjectSellable(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const sellable = object.sellable;
  if (!sellable) return;
  const path = `objects.${name}.sellable`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const single = (local: string, types: Set<string>) => {
    const field = fieldOf(local);
    return field !== undefined && types.has(field.type) && !field.many;
  };

  if (!single(sellable.price, NUMERIC)) {
    contract(`${path}.price`, `"${sellable.price}" must be a currency or number field of ${name}`);
  } else {
    const own = fieldOf(sellable.price)?.currency;
    if (sellable.currency && own && own !== sellable.currency) {
      contract(
        `${path}.currency`,
        `The price field is in ${own}; currency says ${sellable.currency}. Declare one`,
      );
    }
  }
  if (sellable.saleWindow) {
    const { from, until } = sellable.saleWindow;
    if (from === undefined && until === undefined) {
      contract(`${path}.saleWindow`, "A sale window names its from field, its until field or both");
    }
    for (const [key, local] of [
      ["from", from],
      ["until", until],
    ] as const) {
      if (local !== undefined && !single(local, DATES)) {
        contract(
          `${path}.saleWindow.${key}`,
          `"${local}" must be a date or datetime field of ${name}`,
        );
      }
    }
  }
  if (sellable.maxPerOrder !== undefined && !single(sellable.maxPerOrder, new Set(["number"]))) {
    contract(`${path}.maxPerOrder`, `"${sellable.maxPerOrder}" must be a number field of ${name}`);
  }
  if (sellable.deposit) {
    const { amount, balanceDue } = sellable.deposit;
    if (amount === undefined || balanceDue === undefined) {
      contract(
        `${path}.deposit`,
        "A deposit names both fields: amount (the deposit for one) and balanceDue (when the rest is due)",
      );
    }
    if (amount !== undefined && !single(amount, NUMERIC)) {
      contract(
        `${path}.deposit.amount`,
        `"${amount}" must be a currency or number field of ${name}`,
      );
    }
    if (balanceDue !== undefined && !single(balanceDue, DATES)) {
      contract(
        `${path}.deposit.balanceDue`,
        `"${balanceDue}" must be a date or datetime field of ${name}`,
      );
    }
  }
  if (sellable.grants) checkGrants(m, name, object, sellable.grants, `${path}.grants`, contract);
}

function checkGrants(
  m: ExtensionManifest,
  name: string,
  item: ObjectManifest,
  grants: NonNullable<SellableManifest["grants"]>,
  path: string,
  contract: (path: string, message: string) => void,
): void {
  const local = grants.object.startsWith(`${m.id}.`)
    ? grants.object.slice(m.id.length + 1)
    : grants.object;
  const granted = Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
  if (!granted) {
    contract(`${path}.object`, `"${grants.object}" must be another of this extension's objects`);
    return;
  }
  if (local === name) {
    contract(`${path}.object`, "An object cannot grant records of itself");
    return;
  }
  if (granted.sellable) {
    contract(
      `${path}.object`,
      `${local} is itself sellable; a grant is what was bought, not more for sale`,
    );
  }
  const states = granted.states;
  if (!states) {
    contract(
      `${path}.object`,
      `${local} must declare states, so what was granted can be voided (to "${grants.void}")`,
    );
  } else {
    const stateField = granted.fields[states.field];
    const values = new Set((stateField?.options ?? []).map((o) => o.value));
    const finals = new Set(states.moves.filter((mv) => mv.final).map((mv) => mv.to));
    if (!values.has(grants.void)) {
      contract(`${path}.void`, `"${grants.void}" is not a state of ${local}`);
    } else if (grants.void === states.initial) {
      contract(
        `${path}.void`,
        `"${grants.void}" is ${local}'s initial state; void is where a grant ends`,
      );
    } else {
      for (const state of values) {
        if (state === grants.void || finals.has(state)) continue;
        const moves = states.moves.some(
          (mv) =>
            mv.to === grants.void && moveOrigins(mv).includes(state) && mv.by.includes("host"),
        );
        if (!moves) {
          contract(
            `${path}.void`,
            `${local} needs a move from "${state}" to "${grants.void}" that the host may make (by: ["host", ...])`,
          );
        }
      }
    }
    if (Object.hasOwn(grants.set, states.field)) {
      contract(
        `${path}.set.${states.field}`,
        `${states.field} is ${local}'s state: a granted record starts in "${states.initial}"`,
      );
    }
  }

  const itemField = (f: string) => (Object.hasOwn(item.fields, f) ? item.fields[f] : undefined);
  let codes = 0;
  for (const [target, source] of Object.entries(grants.set)) {
    const fp = `${path}.set.${target}`;
    const field = Object.hasOwn(granted.fields, target) ? granted.fields[target] : undefined;
    if (!field || field.type === "formula") {
      contract(fp, `"${target}" must be a field of ${local} other than a formula`);
      continue;
    }
    const want = (ok: boolean, what: string) => {
      if (!ok) contract(fp, `${source} needs ${what}; "${target}" is a ${field.type} field`);
    };
    const one = !field.many;
    if (source === "item") {
      want(
        field.type === "relation" && one && field.to === `${m.id}.${name}`,
        `a relation (one record) to ${m.id}.${name}`,
      );
    } else if (source.startsWith("item.")) {
      const from = source.slice("item.".length);
      const own = itemField(from);
      if (!own || own.type === "formula") {
        contract(fp, `"${from}" is not a field of ${name}`);
        continue;
      }
      want(
        own.type === field.type &&
          Boolean(own.many) === Boolean(field.many) &&
          (own.type !== "relation" || own.to === field.to),
        `a ${own.type} field${own.to ? ` to ${own.to}` : ""}, like ${name}.${from}`,
      );
      if (field.required && !own.required) {
        contract(fp, `"${target}" is required and ${name}.${from} may be empty`);
      }
    } else if (source === "order.person") {
      want(field.type === "relation" && one && field.to === "person", "a relation to one person");
      if (field.required) {
        contract(fp, `"${target}" cannot be required: an order may belong to no one yet`);
      }
    } else if (source === "order.email") {
      want(field.type === "email" || field.type === "text", "an email or text field");
    } else if (source === "order" || source === "line" || source === "line.title") {
      want(TEXT.has(field.type), "a text field");
    } else if (source === "line.unitPrice") {
      want(NUMERIC.has(field.type), "a currency or number field");
    } else if (source === "code") {
      codes += 1;
      want(TEXT.has(field.type), "a text field");
      if (!field.readOnly) {
        contract(
          fp,
          `"${target}" holds the host's code: make it readOnly, so nobody can change it`,
        );
      }
    }
  }
  if (codes > 1) contract(`${path}.set`, "A grant has at most one code");

  // The granted object's own rules must not be able to refuse the host's insert, since that
  // would refuse the payment. What a grant always fills: its set fields whose source always has
  // a value, and fields with a default.
  const always = (source: string) =>
    source === "order.person"
      ? false
      : source.startsWith("item.")
        ? Boolean(itemField(source.slice("item.".length))?.required)
        : true;
  const filled = new Set([
    ...Object.entries(grants.set)
      .filter(([, source]) => always(source))
      .map(([field]) => field),
    ...Object.entries(granted.fields)
      .filter(([, field]) => field.default !== undefined)
      .map(([name]) => name),
  ]);
  if (granted.owner !== undefined) {
    contract(
      `objects.${local}.owner`,
      `${local} is granted by ${name}: an owner would run assignment rules in the paid batch, which could refuse it. Remove owner`,
    );
  }
  granted.requireOneOf?.forEach((group, i) => {
    if (!group.some((field) => filled.has(field))) {
      contract(
        `objects.${local}.requireOneOf.${i}`,
        `${local} is granted by ${name}: set one of ${group.join(", ")} in grants.set from a source that always has a value`,
      );
    }
  });
  for (const [fieldName, field] of Object.entries(granted.fields)) {
    if (field.type !== "select") continue;
    const source = grants.set[fieldName];
    // The choices a granted record can hold when it is created.
    const values =
      source?.startsWith("item.") === true
        ? (field.options ?? []).map((o) => o.value)
        : states && fieldName === states.field
          ? [states.initial]
          : field.default !== undefined
            ? [String(field.default)]
            : [];
    for (const option of field.options ?? []) {
      if (!values.includes(option.value)) continue;
      const missing = (option.requires ?? []).filter((required) => !filled.has(required));
      if (missing.length) {
        contract(
          `objects.${local}.fields.${fieldName}.options`,
          `${local} is granted by ${name}: "${option.value}" needs ${missing.join(", ")}, which grants.set does not always fill`,
        );
      }
    }
  }
  for (const [fieldName, field] of Object.entries(granted.fields)) {
    if (!field.required || field.type === "formula" || field.default !== undefined) continue;
    if (states && fieldName === states.field) continue;
    if (!Object.hasOwn(grants.set, fieldName)) {
      contract(
        `${path}.set`,
        `${local}.${fieldName} is required: set it from the item, the order or the line`,
      );
    }
  }
}
