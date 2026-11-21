// my.* operations (stage 22, ADR 0402, ADR 0412): a signed-in customer's own records of any object
// that declares a customer, through the visibility seam. The seam decides which rows (the ones
// whose customer field is the caller's Person) and which fields (the ones the object lists): these
// handlers never filter by customer themselves. An object that declares no customer is an unknown
// object here.
import { z } from "zod";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("The object, e.g. `person` or an extension object such as `shop.order`");

const recordSchema = z.object({
  object: z.string(),
  id: z.string(),
  /** The fields the object lets its customer read, by field name. */
  values: z.record(z.string(), z.unknown()),
});

export const myList = defineOperation({
  name: "my.list",
  description:
    "A page of your own records of an object, as a signed-in customer: only the records that are " +
    "yours and only the fields you may see. Filter and sort on those fields; pass nextCursor back " +
    "as cursor for the next page. Read-only.",
  input: z.object({
    object: objectName,
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({ items: z.array(recordSchema), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { object, ...page } = input;
    return ctx.records.list(object, page);
  },
});

export const myGet = defineOperation({
  name: "my.get",
  description:
    "One of your own records, as a signed-in customer, with only the fields you may see. A record " +
    "that is not yours is not found. Read-only.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: recordSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return ctx.records.get(input.object, input.id);
  },
});

export const myOperations = [myList, myGet] as const;
