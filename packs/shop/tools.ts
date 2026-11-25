// The Shop's staff tools (stage 37, step 5). They become operations x.shop.<tool>, run in the
// sandbox, and reach the host only through ctx.ops. None of them holds a rule: prices, where a
// thing is sold, stock, postage and which moves a shipment may make are all the host's. A tool
// asks, and reports what the host answered.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

export const ITEM = "shop.item";
export const VARIANT = "shop.variant";
export const SHIPMENT = "shop.shipment";

/** A record as record.get and record.list return it. */
export interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

// --- Stock levels --------------------------------------------------------------------------------

const stockRow = z.object({
  variantId: z.string(),
  variant: z.string().nullable(),
  itemId: z.string().nullable(),
  item: z.string().nullable(),
  category: z.string().nullable(),
  onHand: z.number().describe("On the shelf now: opening, received and returned, less sold"),
  held: z.number().describe("Held by orders being paid for"),
  available: z.number().describe("On hand less held: what can still be sold"),
  reorderAt: z.number().nullable(),
  reorderQty: z.number().nullable(),
  low: z.boolean().describe("On hand is at or below the reorder level"),
  supplierId: z.string().nullable(),
  supplier: z.string().nullable(),
});

/** The most variants one call lists. */
export const STOCK_LEVELS_LIMIT = 200;

export const stockLevels = defineTool({
  description:
    "The stock of the shop's active variants: on hand, held by orders being paid for, available, " +
    "the reorder level and quantity, and the usual supplier, lowest first. Use lowOnly for " +
    "'what's low?' (on hand at or below the reorder level), and category or supplierId to narrow " +
    "it. Numbers are the host's, kept from the stock ledger; this changes nothing. Read-only.",
  input: z.object({
    lowOnly: z.boolean().optional().describe("Only variants at or below their reorder level"),
    category: z.string().max(80).optional().describe("Only items of this category"),
    supplierId: z.string().max(64).optional().describe("Only variants this organisation supplies"),
  }),
  output: z.object({ variants: z.array(stockRow), truncated: z.boolean() }),
  risk: "read",
  // Staff who read the stock (a grant for a desk or coach account) and the stockroom role.
  permission: ["shop:read", "shop:stock"],
  // The stockroom role holds no limit (today's records, a team) that a grant could lift.
  grantLiftsRoleLimits: true,
  async handler(input, ctx) {
    const where = ["v.state = 'active'"];
    const params: unknown[] = [];
    if (input.lowOnly) where.push("v.reorder_at IS NOT NULL AND v._stk_on_hand <= v.reorder_at");
    if (input.category) {
      where.push("i.category = ?");
      params.push(input.category);
    }
    if (input.supplierId) {
      where.push("v.supplier = ?");
      params.push(input.supplierId);
    }
    const result = await ctx.ops.call<{ rows: Record<string, unknown>[] }>("query.sql", {
      sql:
        "SELECT v.id AS variant_id, v.name AS variant, i.id AS item_id, i.name AS item, " +
        "i.category AS category, v._stk_on_hand AS on_hand, v._stk_held AS held, " +
        "v._stk_available AS available, v.reorder_at AS reorder_at, v.reorder_qty AS reorder_qty, " +
        "o.id AS supplier_id, o.name AS supplier " +
        "FROM rec_x_shop_variant v LEFT JOIN rec_x_shop_item i ON i.id = v.item " +
        "LEFT JOIN rec_organisation o ON o.id = v.supplier " +
        `WHERE ${where.join(" AND ")} ` +
        "ORDER BY (v.reorder_at IS NOT NULL AND v._stk_on_hand <= v.reorder_at) DESC, " +
        `v._stk_available ASC, v.name ASC LIMIT ${STOCK_LEVELS_LIMIT + 1}`,
      params,
    });
    const rows = result.rows.slice(0, STOCK_LEVELS_LIMIT);
    return {
      truncated: result.rows.length > STOCK_LEVELS_LIMIT,
      variants: rows.map((row) => {
        const onHand = Number(row.on_hand ?? 0);
        const reorderAt = num(row.reorder_at);
        return {
          variantId: String(row.variant_id),
          variant: text(row.variant),
          itemId: text(row.item_id),
          item: text(row.item),
          category: text(row.category),
          onHand,
          held: Number(row.held ?? 0),
          available: Number(row.available ?? 0),
          reorderAt,
          reorderQty: num(row.reorder_qty),
          low: reorderAt !== null && onHand <= reorderAt,
          supplierId: text(row.supplier_id),
          supplier: text(row.supplier),
        };
      }),
    };
  },
});

// --- Shipments -----------------------------------------------------------------------------------

const shipmentOutput = z.object({
  id: z.string(),
  name: z.string().nullable(),
  orderId: z.string().nullable(),
  kind: z.string().nullable().describe("post or collect"),
  state: z.string().nullable(),
  tracking: z.string().nullable(),
  collectAt: z.string().nullable(),
  buyerId: z.string().nullable(),
  buyer: z.string().nullable().describe("The buyer's name, if they are a Person"),
  createdAt: z.string().nullable(),
});
type ShipmentOut = z.infer<typeof shipmentOutput>;

async function personName(ctx: ExtensionContext, id: string | null): Promise<string | null> {
  if (!id) return null;
  try {
    const person = await ctx.ops.call<{ displayName?: string | null; name?: string | null }>(
      "person.get",
      { id },
    );
    return text(person.displayName ?? person.name);
  } catch (error) {
    if (error instanceof OpsCallError && error.code === "not_found") return null;
    throw error;
  }
}

function describe(record: HostRecord, buyer: string | null): ShipmentOut {
  const v = record.values;
  return {
    id: record.id,
    name: text(v.name) ?? record.title,
    orderId: text(v.order),
    kind: text(v.kind),
    state: text(v.state),
    tracking: text(v.tracking),
    collectAt: text(v.collectAt),
    buyerId: text(v.buyer),
    buyer,
    createdAt: text(v.createdAt),
  };
}

/** The most shipments one call lists. */
export const SHIPMENTS_LIMIT = 100;

export const shipmentsToSend = defineTool({
  description:
    "What paid online orders have left to do: shipments to pack, packed ones to send or have " +
    "ready, and those waiting to be collected, oldest first, with the buyer's name, the kind " +
    "(post or collect), where to collect and the tracking reference. Read-only.",
  input: z.object({
    state: z
      .enum(["to_pack", "packed", "ready"])
      .optional()
      .describe("Only shipments in this state; left out, all three"),
  }),
  output: z.object({ shipments: z.array(shipmentOutput) }),
  risk: "read",
  permission: "shop:fulfil",
  async handler(input, ctx) {
    const states = input.state ? [input.state] : ["to_pack", "packed", "ready"];
    const page = await ctx.ops.call<{ items: HostRecord[] }>("record.list", {
      object: SHIPMENT,
      filter: { field: "state", op: "in", value: states },
      sort: { field: "createdAt", direction: "asc" },
      limit: SHIPMENTS_LIMIT,
    });
    const names = new Map<string, string | null>();
    for (const record of page.items) {
      const buyer = text(record.values.buyer);
      if (buyer && !names.has(buyer)) names.set(buyer, await personName(ctx, buyer));
    }
    return {
      shipments: page.items.map((record) => {
        const buyer = text(record.values.buyer);
        return describe(record, buyer ? (names.get(buyer) ?? null) : null);
      }),
    };
  },
});

const moveOutput = z.object({
  moved: z.boolean(),
  message: z.string(),
  shipment: shipmentOutput,
});

/**
 * Moves a shipment from the state it is in now to `to`, with `values`. The move is made from a
 * current read (ADR 0437): `from` is what was read, so two people marking the same shipment at
 * once make it once and the other is told. Which moves exist is the host's (the shipment's
 * states); a move it does not declare is refused there, not here.
 */
async function move(
  ctx: ExtensionContext,
  id: string,
  to: string,
  values: Record<string, unknown>,
  done: string,
): Promise<z.infer<typeof moveOutput>> {
  const current = await ctx.ops.call<HostRecord>("record.get", { object: SHIPMENT, id });
  const from = text(current.values.state);
  if (from === to) {
    return {
      moved: false,
      message: `Already ${label(to)}.`,
      shipment: describe(current, await personName(ctx, text(current.values.buyer))),
    };
  }
  try {
    const after = await ctx.ops.call<HostRecord>("record.update", {
      object: SHIPMENT,
      id,
      ...(from ? { from } : {}),
      values: { ...values, state: to },
    });
    return {
      moved: true,
      message: done,
      shipment: describe(after, await personName(ctx, text(after.values.buyer))),
    };
  } catch (error) {
    // Moved by someone else meanwhile, or a move the shipment's states do not allow from here.
    if (!(error instanceof OpsCallError) || !["conflict", "invalid_input"].includes(error.code)) {
      throw error;
    }
    const now = await ctx.ops.call<HostRecord>("record.get", { object: SHIPMENT, id });
    return {
      moved: false,
      message: `Not changed: the shipment is ${label(text(now.values.state))}. ${error.message}`,
      shipment: describe(now, await personName(ctx, text(now.values.buyer))),
    };
  }
}

function label(state: string | null): string {
  switch (state) {
    case "to_pack":
      return "to pack";
    case "ready":
      return "ready to collect";
    default:
      return state ?? "unknown";
  }
}

const shipmentId = z.string().min(1).max(64).describe("The shipment's id");

export const markPacked = defineTool({
  description:
    "Mark a shipment packed: its goods are boxed and waiting to be sent or collected. Safe to " +
    "call twice; two people at once: one marks it, the other is told.",
  input: z.object({ shipmentId }),
  output: moveOutput,
  risk: "write",
  permission: "shop:fulfil",
  recordAction: {
    object: SHIPMENT,
    label: "Mark packed",
    idInput: "shipmentId",
    hideWhen: { field: "state", values: ["packed", "sent", "ready", "collected", "void"] },
  },
  handler: (input, ctx) =>
    move(ctx, input.shipmentId, "packed", { packedAt: new Date().toISOString() }, "Packed."),
});

export const markSent = defineTool({
  description:
    "Mark a posted shipment sent, with the carrier's tracking reference if there is one. It " +
    "cannot be undone. The buyer sees the state and the reference on their own shipments.",
  input: z.object({
    shipmentId,
    tracking: z.string().max(200).optional().describe("The carrier's tracking reference"),
  }),
  output: moveOutput,
  risk: "write",
  permission: "shop:fulfil",
  recordAction: {
    object: SHIPMENT,
    label: "Mark sent",
    idInput: "shipmentId",
    hideWhen: { field: "kind", values: ["collect"] },
  },
  handler: (input, ctx) =>
    move(
      ctx,
      input.shipmentId,
      "sent",
      {
        sentAt: new Date().toISOString(),
        ...(input.tracking ? { tracking: input.tracking } : {}),
      },
      "Sent.",
    ),
});

export const markReady = defineTool({
  description:
    "Mark a shipment to collect as ready: its goods are waiting where the buyer collects them.",
  input: z.object({ shipmentId }),
  output: moveOutput,
  risk: "write",
  permission: "shop:fulfil",
  recordAction: {
    object: SHIPMENT,
    label: "Ready to collect",
    idInput: "shipmentId",
    hideWhen: { field: "kind", values: ["post"] },
  },
  handler: (input, ctx) =>
    move(
      ctx,
      input.shipmentId,
      "ready",
      { readyAt: new Date().toISOString() },
      "Ready to collect.",
    ),
});

export const markCollected = defineTool({
  description: "Mark a ready shipment collected: the buyer has picked it up. It cannot be undone.",
  input: z.object({ shipmentId }),
  output: moveOutput,
  risk: "write",
  permission: "shop:fulfil",
  recordAction: {
    object: SHIPMENT,
    label: "Mark collected",
    idInput: "shipmentId",
    hideWhen: { field: "state", values: ["to_pack", "packed", "sent", "collected", "void"] },
  },
  handler: (input, ctx) =>
    move(
      ctx,
      input.shipmentId,
      "collected",
      { collectedAt: new Date().toISOString() },
      "Collected.",
    ),
});
