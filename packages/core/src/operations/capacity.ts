// capacity.* operations (stage 26, ADR 0433): how many places a record has left. Staff see the
// real numbers (places, held, taken, available, and the pool's); a customer or the public see
// only what the object's `show` allows, worked out in the host by the visibility seam
// (visibility/capacity.ts). Claims are never made here: whatever needs places (an order, later a
// booking) claims them in its own write's batch.
import { z } from "zod";
import { defineOperation } from "../operation.ts";

const numbers = z.object({
  object: z.string(),
  id: z.string(),
  places: z.number().nullable(),
  held: z.number(),
  taken: z.number(),
  available: z.number().nullable(),
});

export const capacityViewSchema = z.object({
  object: z.string(),
  id: z.string(),
  status: z
    .enum(["available", "low", "sold_out"])
    .describe("`low` only when the object shows a low-stock warning and few are left"),
  available: z
    .number()
    .nullable()
    .optional()
    .describe("Places left; null when unlimited. Shown to outsiders only when `show` allows"),
  places: z.number().nullable().optional(),
  held: z.number().optional(),
  taken: z.number().optional(),
  show: z.enum(["exact", "low", "availability"]).optional(),
  lowAt: z.number().nullable().optional(),
  pool: numbers.nullable().optional(),
});

export const capacityGet = defineOperation({
  name: "capacity.get",
  description:
    "How many places a record of an object with a capacity has left (a ticket type, a class). " +
    "Staff get places, held (while someone pays), taken (paid), available, and the pool's " +
    "numbers when the record draws on a parent's places. Customers and the public get only " +
    "what the object shows: the number left, a low-stock warning, or available / sold out. " +
    "Read-only; claims nothing.",
  input: z.object({
    object: z.string().min(1).max(80).describe("An extension object that declares a capacity"),
    id: z.string().min(1).max(64),
  }),
  output: capacityViewSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return ctx.records.capacity(input.object, input.id);
  },
});

export const capacityOperations = [capacityGet] as const;
