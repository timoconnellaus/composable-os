// stock.* operations (stage 37, ADR 0680): how many of a thing there are, the ledger of why, and
// the two movements a person makes by hand. Staff read the numbers; a customer or the public see
// only what the object's `show` allows, worked out in the host (visibility/stock.ts). Nobody types
// on hand: opening stock and a correction are movements, written with the counter in one batch.
// A sale is an order's (orders/holds.ts); receipts, counts and write-offs are records' (step 2's
// `stockMoves`).
//
// Opening stock and a correction need `stock:adjust` (admins by default, grantable). An AI's call
// always waits for a person who holds it too (approval.ts), so stock is never changed by an AI
// alone.
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { movementStatements, readStockNumbers, STOCK_PLACE } from "../stock/index.ts";
import { watchLow } from "../stock/low.ts";
import "../stock/sold.ts";
import { unknownObject } from "../visibility/customer.ts";
import { orgReader, visibleTable } from "../visibility/index.ts";

const target = {
  object: z.string().min(1).max(80).describe("An extension object that declares stock"),
  id: z.string().min(1).max(64),
};

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
  onHand: z.number().optional().describe("Staff only: how many there are, sold ones gone"),
  held: z.number().optional().describe("Staff only: how many unpaid orders hold"),
  reorderAt: z.number().nullable().optional(),
  reorderQty: z.number().nullable().optional(),
  atReorderLevel: z.boolean().optional(),
  show: z.enum(["exact", "low", "availability"]).optional(),
  lowAt: z.number().nullable().optional(),
  recent: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        quantity: z.number(),
        place: z.string(),
        at: z.string(),
        note: z.string().nullable(),
      }),
    )
    .optional()
    .describe("Staff only: the last five movements, newest first; the rest is stock.movements"),
});

const movementSchema = z.object({
  id: z.string(),
  place: z.string(),
  quantity: z.number().describe("Signed: in is positive, out negative"),
  kind: z.enum([
    "opening",
    "received",
    "sold",
    "returned",
    "written_off",
    "counted",
    "adjusted",
    "used",
  ]),
  sourceType: z.string(),
  sourceId: z.string(),
  by: z.string().nullable().describe("The staff account; null when the host made it"),
  at: z.string(),
  note: z.string().nullable(),
  unitCost: z.number().nullable(),
});

/** The stock object and a live record of it, or not found. */
async function stockRecord(ctx: HandlerContext, name: string, id: string) {
  const object = getObject(name);
  if (!object?.stock) throw unknownObject(name);
  const row = await orgReader(ctx.db)
    .db.selectFrom(visibleTable(orgReader(ctx.db), object, "t"))
    .select("t.deleted_at")
    .where("t.id", "=", id)
    .executeTakeFirst();
  if (!row || row.deleted_at !== null) throw new NotFoundError(name, id);
  return object as ObjectDefinition;
}

export const stockGet = defineOperation({
  name: "stock.get",
  description:
    "How many of a thing in stock there are (a variant of an item in a shop). Staff get on " +
    "hand (sold ones gone), held (by orders being paid for), available (on hand less held) and " +
    "the reorder level, and the last five movements. Customers and the public get only what the object shows: in stock or " +
    "sold out, a low-stock warning, or the number available. Read-only; holds nothing.",
  input: z.object(target),
  output: stockViewSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return ctx.records.stock(input.object, input.id);
  },
});

export const stockMovements = defineOperation({
  name: "stock.movements",
  description:
    "The stock ledger of one record, newest first: every movement with its kind (opening, " +
    "received, sold, returned, written_off, counted, adjusted, used), signed quantity, place, " +
    "what made it (an order line, a record or a person), who and when. Movements are never " +
    "changed or deleted. Staff only.",
  input: z.object({
    ...target,
    limit: z.number().int().min(1).max(100).default(50),
    before: z
      .string()
      .max(64)
      .optional()
      .describe("A movement id from the last page: the movements older than it"),
  }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    items: z.array(movementSchema),
    nextCursor: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    await stockRecord(ctx, input.object, input.id);
    let query = ctx.db
      .selectFrom("core_stock_movement")
      .selectAll()
      .where("object_type", "=", input.object)
      .where("record_id", "=", input.id);
    if (input.before) {
      const cursor = await ctx.db
        .selectFrom("core_stock_movement")
        .select(["at", "id"])
        .where("id", "=", input.before)
        .executeTakeFirst();
      if (!cursor) throw new ValidationError("Unknown cursor", { field: "before" });
      query = query.where((eb) =>
        eb.or([
          eb("at", "<", cursor.at),
          eb.and([eb("at", "=", cursor.at), eb("id", "<", cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy("at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    return {
      object: input.object,
      id: input.id,
      items: page.map((r) => ({
        id: r.id,
        place: r.place,
        quantity: r.quantity,
        kind: r.kind,
        sourceType: r.source_type,
        sourceId: r.source_id,
        by: r.by_user,
        at: r.at,
        note: r.note,
        unitCost: r.unit_cost,
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});

const changed = z.object({
  object: z.string(),
  id: z.string(),
  movementId: z.string(),
  onHand: z.number().describe("On hand once the movement is written"),
});

/** In the approval queue's dry run nothing is written: refuse now what the counter would. */
async function judgeNow(ctx: HandlerContext, object: string, id: string, quantity: number) {
  const now = await readStockNumbers(ctx.db, object, id);
  if (now.onHand + quantity < now.held) {
    throw new ValidationError(
      `Stock cannot go below what unpaid orders hold: ${now.onHand} on hand, ${now.held} held`,
      { rule: "stock", object, record: id, onHand: now.onHand, held: now.held, quantity },
    );
  }
  return now;
}

export const stockOpening = defineOperation({
  name: "stock.opening",
  description:
    "Records a record's opening stock: how many there are when it is first counted (also by an " +
    "import). Once per record; a later change is stock.adjust, a delivery a receipt. Written in " +
    "the ledger as `opening` at the default place. Needs stock:adjust. An assistant's or MCP " +
    "client's call always waits for a person who holds it too.",
  input: z.object({
    ...target,
    quantity: z.number().int().min(1).max(1_000_000),
    note: z.string().trim().max(500).optional(),
  }),
  output: changed,
  permission: "stock:adjust",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    await stockRecord(ctx, input.object, input.id);
    const opened = await ctx.db
      .selectFrom("core_stock_movement")
      .select("id")
      .where("object_type", "=", input.object)
      .where("record_id", "=", input.id)
      .where("kind", "=", "opening")
      .executeTakeFirst();
    if (opened) {
      throw new ConflictError(
        "This record already has its opening stock; correct it with stock.adjust",
        { rule: "stock", reason: "opening_exists", movementId: opened.id },
      );
    }
    const now = await judgeNow(ctx, input.object, input.id, input.quantity);
    const movement = movementStatements(
      {
        object: input.object,
        record: input.id,
        quantity: input.quantity,
        kind: "opening",
        source: { type: "user", id: ctx.user.id },
        by: ctx.user.id,
        note: input.note || null,
      },
      ctx.now,
    );
    ctx.write(...movement.statements);
    watchLow(ctx, input.object, [input.id]);
    ctx.recordChange({
      object: "stock_movement",
      id: movement.id,
      action: "create",
      after: {
        object: input.object,
        record: input.id,
        place: STOCK_PLACE,
        kind: "opening",
        quantity: input.quantity,
      },
    });
    return {
      object: input.object,
      id: input.id,
      movementId: movement.id,
      onHand: now.onHand + input.quantity,
    };
  },
});

export const stockAdjust = defineOperation({
  name: "stock.adjust",
  description:
    "Corrects how many of a record there are, by a signed quantity with a reason (found two " +
    "more, one broken in the stockroom). Written in the ledger as `adjusted` at the default " +
    "place. Refused when it would leave fewer on hand than unpaid orders hold, with the " +
    "numbers. Not for deliveries, counts or write-offs, which are records of their own. Needs " +
    "stock:adjust. An assistant's or MCP client's call always waits for a person who holds it too.",
  input: z.object({
    ...target,
    quantity: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((n) => n !== 0, "A correction is not 0")
      .describe("Signed: positive adds, negative removes"),
    reason: z.string().trim().min(1).max(500).describe("Why: kept in the ledger"),
  }),
  output: changed,
  permission: "stock:adjust",
  risk: "write",
  actors: ["human", "assistant", "mcp"],
  alwaysReview: ["assistant", "mcp"],
  async handler(input, ctx) {
    await stockRecord(ctx, input.object, input.id);
    const now = await judgeNow(ctx, input.object, input.id, input.quantity);
    const movement = movementStatements(
      {
        object: input.object,
        record: input.id,
        quantity: input.quantity,
        kind: "adjusted",
        source: { type: "user", id: ctx.user.id },
        by: ctx.user.id,
        note: input.reason,
      },
      ctx.now,
    );
    ctx.write(...movement.statements);
    watchLow(ctx, input.object, [input.id]);
    ctx.recordChange({
      object: "stock_movement",
      id: movement.id,
      action: "create",
      after: {
        object: input.object,
        record: input.id,
        place: STOCK_PLACE,
        kind: "adjusted",
        quantity: input.quantity,
        reason: input.reason,
      },
    });
    return {
      object: input.object,
      id: input.id,
      movementId: movement.id,
      onHand: now.onHand + input.quantity,
    };
  },
});

export const stockOperations = [stockGet, stockMovements, stockOpening, stockAdjust] as const;
