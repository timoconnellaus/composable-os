// my.* operations (stage 22, ADR 0402, ADR 0412): a signed-in customer's own records of any object
// that declares a customer, through the visibility seam. The seam decides which rows (the ones
// whose customer field is the caller's Person) and which fields (the ones the object lists): these
// handlers never filter by customer themselves. An object that declares no customer is an unknown
// object here.
import { z } from "zod";
import { getObject } from "../fields/index.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { unknownObject } from "../visibility/customer.ts";

/**
 * my.* is a customer's own records, and the records every signed-in customer may read (ADR
 * 0447). The seam also lets a customer read what the public may (ADR 0438), but that is reached
 * through a pack's tool (public.*), not here.
 */
function ownObject(name: string): string {
  const object = getObject(name);
  if (!object?.customer && !object?.signedIn) throw unknownObject(name);
  return name;
}

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
    "A page of your own records of an object, as a signed-in customer (and the records every " +
    "signed-in customer may read, where the object shares some): only the records that are " +
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
    return ctx.records.list(ownObject(object), page);
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
    return ctx.records.get(ownObject(input.object), input.id);
  },
});

export const myOperations = [myList, myGet] as const;
