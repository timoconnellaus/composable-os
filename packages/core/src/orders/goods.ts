// Goods and delivery on an order (stage 37 step 3, ADRs 0682 and 0685): the host's rules for an
// order with goods, the same for every path (order.start for a customer, a guest or staff, MCP, a
// pack's tool, order.quote's dry run).
//
//   - A line of an object declaring `sellable.goods` is goods. An order with goods needs exactly
//     one delivery: a record of an object declaring `sellable.delivery`, chosen in `delivery`, never
//     put among the lines. An order with no goods takes no delivery.
//   - The order's channel is the host's, from the delivery's kind: `post` and `collect` are
//     `online`, `here` (take it now) is `in_person`. It is never read from the caller.
//   - Each goods line must be sold in that channel (`sellable.goods.soldIn`: online, in_person or
//     both; empty is both). A fridge drink sold in person only cannot be posted; an online-only
//     hoodie cannot be taken now.
//   - A post delivery needs an address in one of the option's countries (or, for an option that
//     posts "everywhere else", in a country no other post option of its object names). Collect and
//     take it now take no address.
//   - Postage is priced by the host (ADR 0685): the option's own price, or nothing when the goods
//     on the order cost at least its "free over". Carriers and weights are later steps.
//
// `order.quote` runs the same rules and reports what the buyer has still to do (choose a delivery,
// give an address) and what is not available, instead of refusing; everything else it refuses as
// `order.start` would.
import type { CoreDatabase } from "@composable-os/db";
import { type DeliveryKind, SOLD_IN, type SoldIn } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, SellableDefinition } from "../fields/types.ts";
import { viewColumnOf } from "../records/columns.ts";
import { pathReader, UNREADABLE } from "../records/windows.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import type { PricedLine } from "./orders.ts";
import { toMinorUnits } from "./settings.ts";

export type OrderChannel = "online" | "in_person";

/** The address goods are posted to. Kept by the host (core_order_delivery), in no view. */
export const deliveryAddressSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe("Who it is for"),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional().describe("State, county or province"),
    postcode: z.string().trim().max(20).optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "A two-letter country code (ISO 3166-1)")
      .transform((value) => value.toUpperCase()),
  })
  .strict();
export type DeliveryAddress = z.output<typeof deliveryAddressSchema>;

/** The delivery a caller chooses: an option's record, and for a post option the address. */
export const deliveryRequestSchema = z
  .object({
    object: z.string().min(1).max(80).describe("The delivery option's object"),
    id: z.string().min(1).max(64).describe("The delivery option chosen"),
    address: deliveryAddressSchema
      .optional()
      .describe("Where to post the goods: needed for a post option, refused for any other"),
  })
  .strict();
export type DeliveryRequest = z.output<typeof deliveryRequestSchema>;

/** What a goods line's record says about where it is sold. */
export interface GoodsFacts {
  soldIn: SoldIn | null;
}

/** What a delivery option's record says, read by the host as it prices the line. */
export interface DeliveryFacts {
  kind: DeliveryKind | null;
  /** In minor units; null: never free. */
  freeOver: number | null;
  /** The countries it posts to. */
  countries: string[];
  /** It posts everywhere no other post option of its object names (`*`). */
  everywhereElse: boolean;
  active: boolean;
}

/** The two-letter codes in a countries field, and whether it says `*` (everywhere else). */
export function parseCountries(value: unknown): { countries: string[]; everywhereElse: boolean } {
  const text = typeof value === "string" ? value : "";
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  return {
    countries: [...new Set(tokens.filter((t) => /^[A-Z]{2}$/.test(t)))],
    everywhereElse: tokens.includes("*"),
  };
}

/** A record's values by registry field name, from a row of its object's view. */
function valuesOf(object: ObjectDefinition, row: AnyRow): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of object.fields) {
    const column = viewColumnOf(field);
    if (column && Object.hasOwn(row, column)) values[field.name] = row[column];
  }
  return values;
}

/**
 * Reads what a priced line's record says about goods and delivery (the declaration's fields), as
 * the host, from the row its price was read from. Undefined for a line that is neither.
 */
export async function goodsFactsOf(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  sellable: SellableDefinition,
  row: AnyRow,
  currency: string,
): Promise<{ goods?: GoodsFacts; delivery?: DeliveryFacts }> {
  const values = valuesOf(object, row);
  if (sellable.goods) {
    const path = sellable.goods.soldIn;
    let raw: unknown = null;
    if (path) {
      raw = path.includes(".")
        ? await pathReader(orgReader(db), object, values).read(path)
        : (values[path] ?? null);
    }
    // Empty is both (decision 3); a value outside the list, or an item no longer readable, is
    // sold nowhere.
    const soldIn: SoldIn | null =
      raw === null || raw === ""
        ? "both"
        : raw !== UNREADABLE && (SOLD_IN as readonly unknown[]).includes(raw)
          ? (raw as SoldIn)
          : null;
    return { goods: { soldIn } };
  }
  if (sellable.delivery) {
    const declared = sellable.delivery;
    const kind = values[declared.kind];
    const active = declared.active ? values[declared.active] : 1;
    const freeOver = declared.freeOver
      ? toMinorUnits(values[declared.freeOver] ?? null, currency)
      : null;
    return {
      delivery: {
        kind: kind === "post" || kind === "collect" || kind === "here" ? kind : null,
        freeOver,
        ...parseCountries(declared.countries ? values[declared.countries] : null),
        // A boolean field reads 1 or 0 from its view; left empty, the option is offered.
        active: !(active === 0 || active === false),
      },
    };
  }
  return {};
}

/** Something the buyer has still to do, or cannot have, reported by order.quote. */
export interface QuoteProblem {
  rule: "delivery_needed" | "address_needed" | "sold_out" | "not_enough";
  message: string;
  line?: number;
}

export interface GoodsOutcome {
  /** The lines as priced, the delivery last, its price the host's postage. */
  lines: PricedLine[];
  channel: OrderChannel | null;
  delivery: {
    line: PricedLine;
    kind: DeliveryKind;
    address: DeliveryAddress | null;
    /** The option's own price, in minor units, before free over. */
    price: number;
    freeOver: number | null;
    free: boolean;
  } | null;
  /** The goods on the order, before the delivery: what free over is measured against. */
  goodsTotal: number;
  /** order.quote only: what the buyer has still to do. order.start throws these instead. */
  problems: QuoteProblem[];
}

function refuse(rule: string, message: string, extra?: object): never {
  throw new ValidationError(message, { rule, ...extra });
}

const CHANNEL_WORDS: Record<OrderChannel, string> = {
  online: "online (posted or collected)",
  in_person: "in person (taken now)",
};

/** Whether a goods line sold `soldIn` may be on an order in `channel`. */
export function soldInChannel(soldIn: SoldIn | null, channel: OrderChannel): boolean {
  return soldIn === "both" || soldIn === channel;
}

/**
 * The countries the other live post options of `object` name, for an option that posts
 * everywhere else. One read of the object's records, as the host.
 */
async function namedElsewhere(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  exceptId: string,
): Promise<Set<string>> {
  const declared = object.sellable?.delivery;
  const column = (name: string | undefined) => {
    const field = name ? object.fields.find((f) => f.name === name) : undefined;
    return field ? viewColumnOf(field) : null;
  };
  const kind = declared ? column(declared.kind) : null;
  const countries = declared ? column(declared.countries) : null;
  const active = declared ? column(declared.active) : null;
  if (!kind || !countries) return new Set();
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const rows = (await (db as Kysely<any>)
    .selectFrom(visibleSource(orgReader(db), object))
    .select([
      "id",
      `${kind} as kind`,
      `${countries} as countries`,
      ...(active ? [`${active} as active`] : []),
    ])
    .where("id", "!=", exceptId)
    .limit(500)
    .execute()) as { kind: unknown; countries: unknown; active?: unknown }[];
  const named = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "post" || row.active === 0 || row.active === false) continue;
    for (const country of parseCountries(row.countries).countries) named.add(country);
  }
  return named;
}

/**
 * Applies the goods rules to lines `priceLines` priced (the delivery, when chosen, last), and
 * prices the delivery. `quote` reports what the buyer has still to do instead of refusing it.
 */
export async function applyGoodsRules(
  db: Kysely<CoreDatabase>,
  priced: readonly PricedLine[],
  request: DeliveryRequest | undefined,
  mode: "start" | "quote",
): Promise<GoodsOutcome> {
  const problems: QuoteProblem[] = [];
  const soft = (problem: QuoteProblem) => {
    if (mode === "start") refuse(problem.rule, problem.message, { line: problem.line });
    problems.push(problem);
  };
  const lines = [...priced];
  const deliveryLine = request ? lines[lines.length - 1] : undefined;
  const goods = lines.filter((line) => line.goods);
  const goodsTotal = goods.reduce((sum, line) => sum + line.total, 0);
  for (const [index, line] of lines.entries()) {
    // Only the delivery chosen is a delivery: one per order, never among the lines.
    if (line.delivery && line !== deliveryLine) {
      refuse("delivery_line", "Choose how it is delivered in `delivery`, not as a line", {
        line: index,
      });
    }
  }
  if (deliveryLine && !deliveryLine.delivery) {
    refuse("not_delivery", "This is not a way of delivering an order", {
      line: deliveryLine.position,
    });
  }
  if (!goods.length) {
    if (request) {
      refuse("delivery_without_goods", "Nothing on this order is delivered: leave out `delivery`");
    }
    return { lines, channel: null, delivery: null, goodsTotal, problems };
  }
  if (!deliveryLine?.delivery || !request) {
    soft({
      rule: "delivery_needed",
      message: "Choose how the goods get to the buyer: posted, collected or taken now",
    });
    return { lines, channel: null, delivery: null, goodsTotal, problems };
  }
  const facts = deliveryLine.delivery;
  if (!facts.kind || !facts.active) {
    refuse("not_for_sale", "This way of delivering is not offered now", {
      line: deliveryLine.position,
    });
  }
  const kind = facts.kind;
  const channel: OrderChannel = kind === "here" ? "in_person" : "online";
  for (const line of goods) {
    if (!soldInChannel(line.goods?.soldIn ?? null, channel)) {
      refuse(
        "not_sold_here",
        channel === "online"
          ? `${line.title} is not sold online: it can only be bought in person`
          : `${line.title} is not sold in person: it can only be bought online`,
        { line: line.position, channel, words: CHANNEL_WORDS[channel] },
      );
    }
  }
  const address = request.address ?? null;
  if (kind !== "post" && address) {
    refuse("address_not_taken", "This way of delivering takes no address: leave it out", {
      field: "delivery.address",
    });
  }
  if (kind === "post") {
    if (!address) {
      soft({ rule: "address_needed", message: "Posting needs the address to post the goods to" });
    } else {
      const object = getObject(deliveryLine.object) as ObjectDefinition;
      const covered = facts.countries.includes(address.country)
        ? true
        : facts.everywhereElse
          ? !(await namedElsewhere(db, object, deliveryLine.recordId)).has(address.country)
          : false;
      if (!covered) {
        refuse("address_country", `${deliveryLine.title} does not post to ${address.country}`, {
          field: "delivery.address.country",
          country: address.country,
        });
      }
    }
  }
  // Postage (ADR 0685): the option's price, or nothing when the goods reach its free over.
  const price = deliveryLine.unitPrice;
  const free = facts.freeOver !== null && goodsTotal >= facts.freeOver;
  const charged: PricedLine = free ? { ...deliveryLine, unitPrice: 0, total: 0 } : deliveryLine;
  lines[lines.length - 1] = charged;
  return {
    lines,
    channel,
    delivery: { line: charged, kind, address, price, freeOver: facts.freeOver, free },
    goodsTotal,
    problems,
  };
}
