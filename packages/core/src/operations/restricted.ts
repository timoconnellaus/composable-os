// record.readRestricted (stage 54 step 2, ADR 0811): staff's one read of restricted fields. Pack
// code only, inside a tool of the pack that declares the field, a tool only a person calls
// (`humanOnly`) and that names the field's restricted permission, called by that person
// themselves: so the reader is a person the pipeline found holding the permission (an admin, or
// one an admin granted it, ADR 0625), never an assistant, MCP, an automation or another pack.
// Every read is audited (who read which records' field), never the values.
import { z } from "zod";
import { ForbiddenError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { restrictedFieldsOf } from "../records/restricted.ts";
import { visibleSource } from "../visibility/index.ts";

/** The most records one read names. */
export const RESTRICTED_READ_MAX = 50;

/** The restricted field a tool run may read, or a refusal that says why and names no value. */
function readableField(ctx: HandlerContext, objectName: string, fieldName: string) {
  const caller = ctx.extension;
  const tool = caller?.tool;
  if (ctx.actor !== "extension" || !caller || !tool) {
    throw new ForbiddenError("A restricted field is read from a pack's tool a person calls.", {
      rule: "restricted_field",
    });
  }
  // A person called the tool themselves: not an assistant or MCP acting for one, and not a person
  // approving another actor's call.
  if (tool.humanOnly !== true || tool.calledBy?.actor !== "human" || tool.startedByApproval) {
    throw new ForbiddenError("A restricted field is read by a person only, never by an AI.", {
      rule: "human_only",
    });
  }
  const object = getObject(objectName);
  const field = restrictedFieldsOf(object).find((f) => f.name === fieldName);
  if (!object || !field || object.extension !== caller.id) {
    throw new ForbiddenError("A restricted field is read only by the pack that declares it.", {
      rule: "restricted_field",
    });
  }
  // The tool names the field's permission and no other, so the pipeline held its caller to that
  // one (ADR 0625): a tool naming several opens to a holder of any one of them (ADR 0600).
  const named = tool.permission === null ? [] : [tool.permission].flat();
  if (!named.length || named.some((p) => p !== field.permission)) {
    throw new ForbiddenError(`Reading ${object.name}.${field.name} needs ${field.permission}.`, {
      rule: "restricted",
      permission: field.permission,
    });
  }
  return { object, field };
}

export const recordReadRestricted = defineOperation({
  name: "record.readRestricted",
  description:
    "From a pack's tool a person calls themselves (humanOnly) that names the field's restricted " +
    "permission: read one restricted field (a text kept out of every view, list, search and " +
    "export) of up to 50 live records of the pack's own object. Records that are not live are " +
    "left out; a record with nothing kept reads null. Every read is audited with the records " +
    "named, never the values. Refused to an assistant, MCP, an automation and any other pack. " +
    "Read-only.",
  input: z.object({
    object: z.string().min(1).max(80).describe("The pack's object, e.g. `reviews.review`"),
    field: z.string().min(1).max(80).describe("Its restricted field"),
    ids: z.array(z.string().min(1).max(64)).min(1).max(RESTRICTED_READ_MAX),
  }),
  output: z.object({
    values: z.array(z.object({ id: z.string(), value: z.string().nullable() })),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["extension"],
  mcp: { expose: false },
  auditReads: true,
  auditSummary: (output, input) => ({
    object: input.object,
    field: input.field,
    ids: input.ids,
    count: output.values.length,
  }),
  redactResult: ["values"],
  async handler(input, ctx) {
    const { object, field } = readableField(ctx, input.object, input.field);
    const ids = [...new Set(input.ids)];
    // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
    const live = (await (ctx.db as any)
      .selectFrom(visibleSource(ctx, object))
      .select("id")
      .where("id", "in", jsonList(ids))
      .execute()) as { id: string }[];
    const kept = await ctx.db
      .selectFrom("core_restricted_value")
      .select(["record_id", "value"])
      .where("object_type", "=", object.name)
      .where("field", "=", field.name)
      .where("record_id", "in", jsonList(live.map((r) => r.id)))
      .execute();
    const values = new Map(kept.map((r) => [r.record_id, r.value]));
    const order = new Set(live.map((r) => r.id));
    return {
      values: ids
        .filter((id) => order.has(id))
        .map((id) => ({ id, value: values.get(id) ?? null })),
    };
  },
});

export const restrictedOperations = [recordReadRestricted] as const;
