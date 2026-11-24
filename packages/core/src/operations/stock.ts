// stock.* operations (stage 37, ADR 0682): how many of a thing there are, why, and the two ways a
// person changes it in this step (opening stock and an adjustment). Staff read the numbers and
// the ledger; a customer or the public see only what the object's `show` allows, worked out in the
// host (visibility/stock.ts). Nobody writes on hand: each write here is a movement, written with
// its counter's change in one batch, refused by the database when it would leave less on hand
// than unpaid orders hold. Sales are the order's (orders/holds.ts), never an operation here.
//
// An AI's opening or adjustment always waits for a person (`alwaysReview`): an AI may read and
// suggest, never change a count by itself.
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { actingAccount } from "../staffing/rosterers.ts";
import {
  movementStatements,
  STOCK_MOVEMENT_KINDS,
  STOCK_QUANTITY_MAX,
  type StockMovementKind,
} from "../stock/index.ts";
import { liveStockCounter, stockMovements, stockObject } from "../visibility/stock.ts";

const movementSchema = z.object({
  id: z.string(),
  kind: z.enum(STOCK_MOVEMENT_KINDS),
  quantity: z.number().describe("Signed: what came in is positive, what went out negative"),
  place: z.string().describe("Where it happened: one default place in this version"),
  source: z.object({ type: z.string(), id: z.string() }).nullable(),
  madeBy: z.string().nullable().describe("The staff account; null when the host made it"),
  madeAs: z.enum(["staff", "host"]),
  note: z.string().nullable(),
  unitCost: z.number().nullable().describe("Minor units, on a receipt"),
  at: z.string(),
});

export const stockViewSchema = z.object({
  object: z.string(),
  id: z.string(),
  status: z
    .enum(["in_stock", "low", "sold_out"])
    .describe("`low` only when the object shows a low-stock warning and few are left"),
  available: z
    .number()
    .optional()
    .describe("How many can be bought now. Shown to outsiders only when `show` allows"),
  onHand: z.number().optional(),
  held: z.number().optional().describe("Held by unpaid orders while their buyers pay"),
  place: z.string().optional(),
  show: z.enum(["exact", "low", "availability"]).optional(),
  lowAt: z.number().nullable().optional(),
  reorderAt: z.number().nullable().optional(),
  reorderQty: z.number().nullable().optional(),
  low: z.boolean().optional().describe("On hand is at or below the reorder level"),
  movements: z.array(movementSchema).optional(),
});

const recordInput = {
  object: z.string().min(1).max(80).describe("An extension object that declares stock"),
  id: z.string().min(1).max(64),
};

export const stockGet = defineOperation({
  name: "stock.get",
  description:
    "How many of a thing a business has (a variant it sells). Staff get on hand, held (by " +
    "unpaid orders while their buyers pay), available (on hand less held), the reorder level " +
    "and whether on hand is at or below it, and the last movements of the ledger. Customers " +
    "and the public get only what the object shows: in stock or sold out, 'only N left', or " +
    "the number available. Read-only; holds nothing.",
  input: z.object(recordInput),
  output: stockViewSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return ctx.records.stock(input.object, input.id);
  },
});

export const stockMovementsList = defineOperation({
  name: "stock.movements",
  description:
    "A record's stock ledger, newest first: every movement with its kind (opening, received, " +
    "sold, returned, written_off, counted, adjusted, used), signed quantity, place, what it came " +
    "from (an order line, a record), who made it and why. Movements are never changed or " +
    "deleted; their sum is on hand. Read-only.",
  input: z.object({
    ...recordInput,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(400).optional(),
  }),
  output: z.object({ items: z.array(movementSchema), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    await liveStockCounter(ctx.db, stockObject(input.object), input.id);
    return stockMovements(ctx.db, input.object, input.id, {
      limit: input.limit,
      cursor: input.cursor,
    });
  },
});

const moveOutput = z.object({
  movementId: z.string(),
  object: z.string(),
  id: z.string(),
  kind: z.enum(STOCK_MOVEMENT_KINDS),
  quantity: z.number(),
});

/** Queues one movement made by the calling staff account. */
async function move(
  ctx: HandlerContext,
  input: { object: string; id: string; quantity: number; note?: string | undefined },
  kind: StockMovementKind,
) {
  const object = stockObject(input.object);
  const now = await liveStockCounter(ctx.db, object, input.id);
  if (kind === "opening" && now.hasOpening) {
    throw new ValidationError(
      `${object.label} already has its opening stock: correct it with an adjustment`,
      { rule: "stock", reason: "opening_given", object: input.object, record: input.id },
    );
  }
  // The approval queue's dry run writes nothing: say now what the database would refuse.
  if (ctx.simulation && input.quantity < 0 && now.onHand + input.quantity < now.held) {
    throw new ValidationError(
      `That would leave fewer on hand than unpaid orders hold: ${now.onHand} on hand, ${now.held} held while buyers pay, removing ${-input.quantity}. Try again in a few minutes`,
      {
        rule: "stock",
        object: input.object,
        record: input.id,
        onHand: now.onHand,
        held: now.held,
        removing: -input.quantity,
      },
    );
  }
  const { id, statements } = movementStatements(
    ctx.db,
    {
      object: input.object,
      record: input.id,
      quantity: input.quantity,
      kind,
      by: { account: actingAccount(ctx) },
      note: input.note ?? null,
    },
    ctx.now,
  );
  ctx.write(...statements);
  return { movementId: id, object: input.object, id: input.id, kind, quantity: input.quantity };
}

export const stockOpening = defineOperation({
  name: "stock.opening",
  description:
    "Records a record's opening stock: how many there are when the business starts counting " +
    "it (also used by an import). Once per record; after that, correct it with stock.adjust. " +
    "Writes an `opening` movement; on hand goes up by that many. An AI's call waits for a person.",
  input: z.object({
    ...recordInput,
    quantity: z.number().int().min(1).max(STOCK_QUANTITY_MAX),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("Kept for good: never a customer's name or contact details"),
  }),
  output: moveOutput,
  permission: "records:write",
  risk: "write",
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    return move(ctx, input, "opening");
  },
});

export const stockAdjust = defineOperation({
  name: "stock.adjust",
  description:
    "Corrects a record's stock by a number of units, up (found some) or down (some went " +
    "missing), with the reason. Writes an `adjusted` movement. Refused when it would leave fewer " +
    "on hand than unpaid orders hold. Use it for a correction, not for a delivery, a count or a " +
    "write-off (those are their own records). The reason is kept for good and can never be " +
    "erased: say what happened, never who a customer is (no names, emails or order details). An " +
    "AI's call waits for a person.",
  input: z.object({
    ...recordInput,
    quantity: z
      .number()
      .int()
      .min(-STOCK_QUANTITY_MAX)
      .max(STOCK_QUANTITY_MAX)
      .refine((n) => n !== 0, "An adjustment moves at least one unit")
      .describe("Signed: positive adds, negative removes"),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What happened, kept for good: never a customer's name or contact details"),
  }),
  output: moveOutput,
  permission: "records:write",
  risk: "write",
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    return move(ctx, { ...input, note: input.reason }, "adjusted");
  },
});

export const stockOperations = [stockGet, stockMovementsList, stockOpening, stockAdjust] as const;
