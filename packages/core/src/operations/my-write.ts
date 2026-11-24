// my.create, my.update and my.delete (ADR 0414): the generic record writes a pack's tool makes for the
// customer who called it. A customer never calls them directly (`toolOnly`): the stage 22 rule
// is that a customer changes records only through a tool a pack opens. They write through the
// visibility seam, so the record is always the caller's own, and the fields are the object's
// `customer.write` plus what the calling tool lists in its `customerFields`.
import { z } from "zod";
import { defineOperation } from "../operation.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("An object that declares a customer, e.g. `shop.order`");
const valuesSchema = z
  .record(z.string().max(80), z.unknown())
  .describe("Field values by name. Only fields the customer, or this tool, may set.");
const recordSchema = z.object({
  object: z.string(),
  id: z.string(),
  values: z.record(z.string(), z.unknown()),
});

export const myCreate = defineOperation({
  name: "my.create",
  description:
    "From a tool called by a customer: create a record that belongs to that customer. The " +
    "customer field is set by the host to the caller and cannot be given; with forPersonId it " +
    "is set to that Person instead, only when they are a live dependant of the caller (a child " +
    "staff linked to them) and the object lets guardians write its records; anyone else is not " +
    "found. Other values must be fields the object lists as writable by its customer, or that " +
    "the tool lists in customerFields. Returns the record as the customer may see it.",
  input: z.object({
    object: objectName,
    values: valuesSchema.default({}),
    forPersonId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "A dependant of the caller to make it for (ADR 0540); left out, it is the caller's own",
      ),
  }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  toolOnly: true,
  async handler(input, ctx) {
    const { id } = await ctx.records.create(input.object, input.values, {
      forPersonId: input.forPersonId,
    });
    return ctx.afterCommit(() => ctx.records.get(input.object, id));
  },
});

export const myUpdate = defineOperation({
  name: "my.update",
  description:
    "From a tool called by a customer: change one of that customer's own records. A record " +
    "that is not theirs is reported as not found. Values must be fields the object lists as " +
    "writable by its customer, or that the tool lists in customerFields; whose record it is can " +
    "never change. Returns the record as the customer may see it.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64).describe("Record id"),
    values: valuesSchema,
    from: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Only move the record if it is still in this state, and move it out of it (ADR 0437): " +
          "refused as a conflict when it has left it.",
      ),
  }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  toolOnly: true,
  async handler(input, ctx) {
    await ctx.records.update(input.object, input.id, input.values, { from: input.from });
    return ctx.afterCommit(() => ctx.records.get(input.object, input.id));
  },
});

export const myDelete = defineOperation({
  name: "my.delete",
  description:
    "From a tool called by a customer: put one of that customer's own records in the Trash, " +
    "where its object lets its customer remove their own (`customer.delete`). A record that is " +
    "not theirs, or of an object that does not allow it, is reported as not found or refused. " +
    "Staff can restore it from the Trash. Returns the id.",
  input: z.object({
    object: objectName,
    id: z.string().min(1).max(64).describe("Record id"),
  }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  toolOnly: true,
  async handler(input, ctx) {
    await ctx.records.delete(input.object, input.id);
    return { id: input.id };
  },
});

export const myWriteOperations = [myCreate, myUpdate, myDelete] as const;
