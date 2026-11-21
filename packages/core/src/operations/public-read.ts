// public.list and public.get (stage 27, ADR 0438): what an object declares the public may read,
// for a pack's tool called by the public or a customer. Nobody calls them directly (`toolOnly`):
// the public reaches records only through a tool a pack opens to them. The seam decides which
// records (the ones meeting the object's `when`) and which fields (its `read`): these handlers
// never filter themselves. An object that declares nothing public is an unknown object here.
import { z } from "zod";
import { getObject } from "../fields/index.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { unknownObject } from "../visibility/customer.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("An object that declares what the public may read, e.g. `ticketing.event`");

const recordSchema = z.object({
  object: z.string(),
  id: z.string(),
  /** The fields the object lets the public read, by field name. */
  values: z.record(z.string(), z.unknown()),
});

/** Only objects that declare a public scope: a customer's own objects are my.*'s. */
function publicObjectName(name: string): string {
  if (!getObject(name)?.public) throw unknownObject(name);
  return name;
}

export const publicList = defineOperation({
  name: "public.list",
  description:
    "From a tool called by the public or a customer: a page of the records of an object that " +
    "the public may read (an event while it is on sale), with only the fields it declares. " +
    "Filter and sort on those fields; pass nextCursor back as cursor. Read-only.",
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
  audiences: ["customer", "public"],
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const { object, ...page } = input;
    return ctx.records.list(publicObjectName(object), page);
  },
});

export const publicGet = defineOperation({
  name: "public.get",
  description:
    "From a tool called by the public or a customer: one record the public may read, with only " +
    "the fields it declares. A record that is not public now is not found. Read-only.",
  input: z.object({ object: objectName, id: z.string().min(1).max(64) }),
  output: recordSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["customer", "public"],
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    return ctx.records.get(publicObjectName(input.object), input.id);
  },
});

export const publicReadOperations = [publicList, publicGet] as const;
