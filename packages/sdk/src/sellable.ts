// The `sellable` behaviour (stage 27, ADR 0435): an object's records can be put on an order. The
// host reads the price from the record, refuses a line outside the sale window or over the most
// one order may hold, and, when the order is first paid, creates what a paid line grants (a
// ticket per place) in the batch that marks it paid. Its declaration, its manifest schema and its
// contract checks live here; the host's side is packages/core/src/orders/ (sellable.ts, grants.ts).
import { z } from "zod";
import { customerWritable, spendsOnList } from "./allowance.ts";
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
  /**
   * When what was granted is valid (stage 32b, ADR 0511): the host writes `from` (the moment it
   * is granted) and `until` (that moment plus `days` local days in the organisation's zone; for a
   * date field, the day before that, since a date includes its whole day), each a date or
   * datetime field of the granted object. `days` is `item.<number field>` of the record bought (a
   * class pack's "valid for 30 days"); empty there, `until` is left empty. A pass's expiry.
   */
  valid?: { from?: string; until?: string; days?: `item.${string}` };
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
 * - `tax`: tax at checkout (ADR 0479), see TaxSpec. A line is taxed only when this is declared and
 *   a human admin has turned tax on for the deployment.
 * - `recurring`: a plan, paid for every period (stage 32a, ADR 0485), see RecurringSpec. Its records
 *   are subscribed to, never put on an order: `price` is the price of one period. Not with
 *   `deposit`, `maxPerOrder` or `grants` (32b adds what a subscription grants).
 */
export interface SellableSpec {
  price: string;
  currency?: string;
  saleWindow?: { from?: string; until?: string };
  maxPerOrder?: string;
  deposit?: { amount: string; balanceDue: string };
  grants?: GrantSpec;
  tax?: TaxSpec;
  recurring?: RecurringSpec;
  /**
   * A boolean field: while it is true on a record, a Person may buy it once, across every record
   * of this object with it true (an intro offer: one per Person, ADR 0512). The host holds it from
   * the order's start, uses it when the order is paid, and gives it back only when the order
   * expires or is cancelled unpaid; the database refuses a second hold, so two purchases at once
   * give one. Only a buyer who proved who they are buys it (a signed-in customer, or staff for a
   * Person): a guest who typed an address is refused (`rule: "once_per_person"`, `reason:
   * "sign_in"`). Such a line holds one, and an order at most one such line. Not on a plan.
   */
  onePerPerson?: string;
}

/**
 * How a plan recurs (ADR 0485). The payment provider charges every `interval` on its own schedule;
 * the host learns of each paid period from its verified events and writes a paid order for it.
 *
 * - `interval`: `week`, `month` or `year`.
 * - `trialDays`: a number field of the plan holding the days of a free first period (the card is
 *   taken at the start, the first charge is when it ends). Empty or zero: no trial.
 */
export interface RecurringSpec {
  interval: "week" | "month" | "year";
  trialDays?: string;
  /**
   * What a subscription to the plan grants (stage 32b, ADR 0510): one record of `object` for the
   * subscription's holder, made by the host when the provider first reports it running, then kept
   * in step with it, as the host, in each verified event's batch: its state follows the
   * subscription's (`states` maps each of the host's subscription states to one of the granted
   * object's), and `until` is when it stops giving (the end of its last period when it is set to
   * end, 30 days of failing while past due, the moment it ended). No extension code runs.
   *
   * - `object`: another of this extension's objects, declaring `states`.
   * - `set`: fields filled once, when it is granted: `item` (a relation to the plan),
   *   `item.<field>` (the plan's terms as they are at the start: its uses, its class types),
   *   `subscription` (a text field, the subscription's id), `subscription.holder` and
   *   `subscription.payer` (relations to person). The holder always has a value.
   * - `from`, `until`: datetime fields the host keeps.
   * - `states`: the granted object's state for each subscription state that grants
   *   (`trialing`, `active`, `past_due`, `unpaid`, `paused`, `ended`); `ended`'s is final.
   *
   * Not the `recurring` behaviour (a weekly timetable rule, ADR 0500): this is the plan's own
   * `sellable.recurring`, and its `grants` is what the subscription gives while it runs.
   */
  grants?: RecurringGrantSpec;
}

/** Where a field of what a subscription grants gets its value (see RecurringSpec.grants). */
export type RecurringGrantSource =
  | "item"
  | `item.${string}`
  | "subscription"
  | "subscription.holder"
  | "subscription.payer";

/** The host's subscription states a grant follows (ADR 0485). */
export const SUBSCRIPTION_GRANT_STATES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "ended",
] as const;
export type SubscriptionGrantState = (typeof SUBSCRIPTION_GRANT_STATES)[number];

export interface RecurringGrantSpec {
  object: string;
  set: Readonly<Record<string, RecurringGrantSource>>;
  from?: string;
  until?: string;
  states: Readonly<Record<SubscriptionGrantState, string>>;
}

/**
 * How the payment provider taxes a line of this object (ADR 0479). Prices stay what the buyer
 * pays: the provider works the tax out inside them.
 *
 * - `code`: the provider's product tax code (Stripe's list: `txcd_` and eight digits). A human
 *   admin may override it per object in Settings → Orders.
 * - `place`: for admission to an in-person event, where it is held, so the provider taxes it
 *   there and not where the buyer lives. Text fields of this object, or of the record its
 *   relation `via` points at (a ticket type's event): `country` (two letters, ISO 3166-1) and,
 *   when given, `region`, `postcode`, `city` and `line1`.
 */
export interface TaxSpec {
  code: string;
  place?: {
    via?: string;
    country: string;
    region?: string;
    postcode?: string;
    city?: string;
    line1?: string;
  };
}

/** A product tax code as Stripe's list has them. */
export const TAX_CODE_PATTERN = /^txcd_\d{8}$/;

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

const itemSource = z
  .string()
  .regex(/^item\.[a-z][a-zA-Z0-9]{0,39}$/, "item.<field>") as z.ZodType<`item.${string}`>;

const recurringGrantSource = z.union([
  z.enum(["item", "subscription", "subscription.holder", "subscription.payer"]),
  itemSource,
]);

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
        valid: z
          .object({
            from: fieldName.optional(),
            until: fieldName.optional(),
            days: itemSource.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    onePerPerson: fieldName.optional(),
    tax: z
      .object({
        code: z.string().regex(TAX_CODE_PATTERN, "A product tax code: txcd_ and eight digits"),
        place: z
          .object({
            via: fieldName.optional(),
            country: fieldName,
            region: fieldName.optional(),
            postcode: fieldName.optional(),
            city: fieldName.optional(),
            line1: fieldName.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    recurring: z
      .object({
        interval: z.enum(["week", "month", "year"]),
        trialDays: fieldName.optional(),
        grants: z
          .object({
            object: z.string().max(40),
            set: z.record(fieldName, recurringGrantSource),
            from: fieldName.optional(),
            until: fieldName.optional(),
            states: z
              .object({
                trialing: z.string().min(1).max(100),
                active: z.string().min(1).max(100),
                past_due: z.string().min(1).max(100),
                unpaid: z.string().min(1).max(100),
                paused: z.string().min(1).max(100),
                ended: z.string().min(1).max(100),
              })
              .strict(),
          })
          .strict()
          .optional(),
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
  if (sellable.recurring) {
    // A plan is subscribed to, not put on an order (ADR 0485).
    for (const key of ["deposit", "maxPerOrder", "grants"] as const) {
      if (sellable[key] !== undefined) {
        contract(
          `${path}.${key}`,
          `A recurring plan has no ${key}: it is subscribed to, one at a time`,
        );
      }
    }
    const trial = sellable.recurring.trialDays;
    if (trial !== undefined && !single(trial, new Set(["number"]))) {
      contract(`${path}.recurring.trialDays`, `"${trial}" must be a number field of ${name}`);
    }
    if (sellable.onePerPerson !== undefined) {
      contract(
        `${path}.onePerPerson`,
        "A plan's trial is already one per person (ADR 0489); onePerPerson is for things bought once",
      );
    }
    if (sellable.recurring.grants) {
      checkRecurringGrants(
        m,
        name,
        object,
        sellable.recurring.grants,
        `${path}.recurring.grants`,
        contract,
      );
    }
  }
  if (sellable.onePerPerson !== undefined && !single(sellable.onePerPerson, new Set(["boolean"]))) {
    contract(
      `${path}.onePerPerson`,
      `"${sellable.onePerPerson}" must be a boolean field of ${name}`,
    );
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
  const place = sellable.tax?.place;
  if (place) {
    let holder: ObjectManifest | undefined = object;
    let holderName = name;
    if (place.via !== undefined) {
      const via = fieldOf(place.via);
      const local = via?.to?.startsWith(`${m.id}.`) ? via.to.slice(m.id.length + 1) : undefined;
      if (
        !via ||
        via.type !== "relation" ||
        via.many ||
        !local ||
        !Object.hasOwn(m.objects, local)
      ) {
        contract(
          `${path}.tax.place.via`,
          `"${place.via}" must be a relation of ${name} to one record of another of this extension's objects`,
        );
        holder = undefined;
      } else {
        holder = m.objects[local];
        holderName = local;
      }
    }
    if (holder) {
      for (const key of ["country", "region", "postcode", "city", "line1"] as const) {
        const local = place[key];
        if (local === undefined) continue;
        const field = Object.hasOwn(holder.fields, local) ? holder.fields[local] : undefined;
        if (!field || field.type !== "text" || field.many) {
          contract(`${path}.tax.place.${key}`, `"${local}" must be a text field of ${holderName}`);
        }
      }
    }
  }
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
  checkGrantedHolder(m, local, granted, contract);
  if (grants.valid) {
    const { from, until, days } = grants.valid;
    if (from === undefined && until === undefined) {
      contract(`${path}.valid`, "valid names the granted object's from field, until field or both");
    }
    for (const [key, target] of [
      ["from", from],
      ["until", until],
    ] as const) {
      if (target === undefined) continue;
      const field = Object.hasOwn(granted.fields, target) ? granted.fields[target] : undefined;
      if (!field || !DATES.has(field.type) || field.many) {
        contract(
          `${path}.valid.${key}`,
          `"${target}" must be a date or datetime field of ${local}`,
        );
      } else if (Object.hasOwn(grants.set, target)) {
        contract(
          `${path}.valid.${key}`,
          `"${target}" is in set too: the host writes it from valid`,
        );
      }
    }
    if (days !== undefined) {
      const own = itemField(days.slice("item.".length));
      if (own?.type !== "number" || own.many) {
        contract(`${path}.valid.days`, `"${days}" must be item.<a number field of ${name}>`);
      }
      if (until === undefined) contract(`${path}.valid.days`, "days needs an until field to fill");
    }
  }

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

/**
 * Checks what a plan's subscription grants (ADR 0510), as `checkGrants` checks an order line's:
 * each of these is a way the verified event's batch could otherwise fail, which would leave the
 * provider's event unapplied.
 */
function checkRecurringGrants(
  m: ExtensionManifest,
  name: string,
  plan: ObjectManifest,
  grants: NonNullable<NonNullable<SellableManifest["recurring"]>["grants"]>,
  path: string,
  contract: (path: string, message: string) => void,
): void {
  const local = grants.object.startsWith(`${m.id}.`)
    ? grants.object.slice(m.id.length + 1)
    : grants.object;
  const granted = Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
  if (!granted || local === name) {
    contract(`${path}.object`, `"${grants.object}" must be another of this extension's objects`);
    return;
  }
  if (granted.sellable) {
    contract(`${path}.object`, `${local} is itself sellable; a grant is what was bought`);
  }
  if (granted.owner !== undefined) {
    contract(
      `objects.${local}.owner`,
      `${local} is granted by ${name}'s subscriptions: an owner would run assignment rules in the provider's event batch. Remove owner`,
    );
  }
  const states = granted.states;
  if (!states) {
    contract(
      `${path}.object`,
      `${local} must declare states: its state follows the subscription's`,
    );
    return;
  }
  const stateField = granted.fields[states.field];
  const values = new Set((stateField?.options ?? []).map((o) => o.value));
  const mapped = new Set(Object.values(grants.states));
  for (const [from, to] of Object.entries(grants.states)) {
    if (!values.has(to)) contract(`${path}.states.${from}`, `"${to}" is not a state of ${local}`);
  }
  if (!mapped.has(states.initial)) {
    contract(
      `${path}.states`,
      `${local}'s initial state "${states.initial}" must be one the subscription's states map to`,
    );
  }
  const ended = grants.states.ended;
  const finals = new Set(states.moves.filter((mv) => mv.final).map((mv) => mv.to));
  if (!finals.has(ended)) {
    contract(`${path}.states.ended`, `"${ended}" must be a final state of ${local}`);
  }
  // The provider's reads move a subscription between its states in any order, so the granted
  // record needs a host move from each mapped state to each other one (none out of the final).
  for (const fromState of mapped) {
    if (fromState === ended) continue;
    for (const toState of mapped) {
      if (toState === fromState) continue;
      const ok = states.moves.some(
        (mv) => mv.to === toState && moveOrigins(mv).includes(fromState) && mv.by.includes("host"),
      );
      if (!ok) {
        contract(
          `objects.${local}.states`,
          `${local} needs a move from "${fromState}" to "${toState}" the host may make (by: ["host", ...]): it follows the subscription`,
        );
      }
    }
  }
  if (Object.hasOwn(grants.set, states.field)) {
    contract(
      `${path}.set.${states.field}`,
      `${states.field} is ${local}'s state: the host sets it`,
    );
  }
  const filled = new Set<string>();
  for (const [key, target] of [
    ["from", grants.from],
    ["until", grants.until],
  ] as const) {
    if (target === undefined) continue;
    const field = Object.hasOwn(granted.fields, target) ? granted.fields[target] : undefined;
    // A moment, not a day: access stops at the period's end and not a minute after (ADR 0488).
    if (field?.type !== "datetime" || field.many) {
      contract(`${path}.${key}`, `"${target}" must be a datetime field of ${local}`);
    } else if (Object.hasOwn(grants.set, target)) {
      contract(`${path}.${key}`, `"${target}" is in set too: the host keeps it`);
    }
    if (key === "from") filled.add(target);
  }
  for (const [target, source] of Object.entries(grants.set)) {
    const fp = `${path}.set.${target}`;
    const field = Object.hasOwn(granted.fields, target) ? granted.fields[target] : undefined;
    if (!field || field.type === "formula") {
      contract(fp, `"${target}" must be a field of ${local} other than a formula`);
      continue;
    }
    const one = !field.many;
    let always = true;
    if (source === "item") {
      if (!(field.type === "relation" && one && field.to === `${m.id}.${name}`)) {
        contract(fp, `item needs a relation (one record) to ${m.id}.${name}`);
      }
    } else if (source.startsWith("item.")) {
      const from = source.slice("item.".length);
      const own = Object.hasOwn(plan.fields, from) ? plan.fields[from] : undefined;
      if (!own || own.type === "formula") {
        contract(fp, `"${from}" is not a field of ${name}`);
        continue;
      }
      if (
        own.type !== field.type ||
        Boolean(own.many) !== Boolean(field.many) ||
        (own.type === "relation" && own.to !== field.to)
      ) {
        contract(
          fp,
          `${source} needs a ${own.type} field like ${name}.${from}; "${target}" is a ${field.type} field`,
        );
      }
      always = Boolean(own.required);
    } else if (source === "subscription") {
      if (field.type !== "text") {
        contract(fp, `subscription needs a text field; "${target}" is a ${field.type} field`);
      }
    } else if (!(field.type === "relation" && one && field.to === "person")) {
      contract(
        fp,
        `${source} needs a relation to one person; "${target}" is a ${field.type} field`,
      );
    } else if (source === "subscription.payer") {
      // A payer erased later leaves the field empty; it never fills a required one.
      always = false;
    }
    if (field.required && !always) {
      contract(fp, `"${target}" is required and ${source} may be empty`);
    }
    if (always) filled.add(target);
  }
  for (const [fieldName, field] of Object.entries(granted.fields)) {
    if (!field.required || field.type === "formula" || field.default !== undefined) continue;
    if (fieldName === states.field || filled.has(fieldName)) continue;
    contract(
      `${path}.set`,
      `${local}.${fieldName} is required: set it from the plan or the subscription`,
    );
  }
  granted.requireOneOf?.forEach((group, i) => {
    if (!group.some((f) => filled.has(f))) {
      contract(
        `objects.${local}.requireOneOf.${i}`,
        `${local} is granted by ${name}'s subscriptions: set one of ${group.join(", ")}`,
      );
    }
  });
  checkGrantedHolder(m, local, granted, contract);
}

/**
 * A granted holder (a pass a paid line grants, a membership a subscription grants) keeps the
 * terms it was granted (ADR 0513): its Person, uses, period, dates, zone and the fields its
 * conditions compare with are read-only and never a customer's to write, and nobody but the host
 * (or a tool only a person with a permission may call) moves it into a state it can be spent in.
 * Otherwise a staff write, an assistant or an automation could give someone uses nobody paid for.
 */
export function checkGrantedHolder(
  m: ExtensionManifest,
  local: string,
  granted: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const allowance = granted.allowance;
  if (!allowance || !("holds" in allowance)) return;
  const h = allowance.holds;
  const op = `objects.${local}`;
  const terms = new Set<string>([h.person, h.uses]);
  if (typeof h.per === "object") terms.add(h.per.field);
  for (const f of [h.from, h.until, h.zone]) if (f) terms.add(f);
  for (const target of spendsOnList(h)) {
    for (const clause of target.when ?? []) {
      for (const v of [clause.in, clause.atLeast, clause.below]) {
        if (typeof v === "string") terms.add(v);
      }
    }
  }
  const customer = customerWritable(m, local);
  for (const term of terms) {
    const field = Object.hasOwn(granted.fields, term) ? granted.fields[term] : undefined;
    if (field && !field.readOnly) {
      contract(
        `${op}.fields.${term}`,
        `${local} is granted: "${term}" is one of its terms, so it must be readOnly (only the host writes it)`,
      );
    }
    if (customer.has(term) && term !== granted.customer?.field) {
      contract(`${op}.fields.${term}`, `${local} is granted: a customer cannot write "${term}"`);
    }
  }
  const live = new Set(h.live ?? []);
  for (const [i, move] of (granted.states?.moves ?? []).entries()) {
    if (!live.has(move.to)) continue;
    const open = move.by.filter((by) => by === "staff" || by === "customer");
    if (open.length) {
      contract(
        `${op}.states.moves.${i}`,
        `${local} is granted: only the host moves it into "${move.to}", where it can be spent (not ${open.join(" or ")})`,
      );
    }
  }
}
