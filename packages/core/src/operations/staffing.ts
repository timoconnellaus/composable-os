// The `staffed` behaviour's operations (stage 45, ADRs 0621 and 0622). The host's staffing
// operations are tool-only: called from a shipped pack's tool run, with the caller the runtime
// verified, never from a person, MCP or an assistant directly (Rostering's tools call them from
// step 4). A warning says someone is away or not qualified, which only rosterers read.
import { z } from "zod";
import { NotFoundError, UnknownOperationError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { checkShift } from "../staffing/index.ts";
import { loadRecord, staffWarningSchema } from "./record.ts";

/**
 * Refuses anyone but a shipped pack's tool run, as an operation that does not exist. The pipeline
 * refuses a call from outside a tool run (`toolOnly`); this also refuses a runtime extension's.
 */
async function assertShippedToolRun(ctx: HandlerContext, name: string): Promise<void> {
  const caller = ctx.extension;
  if (ctx.actor !== "extension" || !caller?.tool) throw new UnknownOperationError(name);
  const row = await ctx.db
    .selectFrom("core_extensions")
    .select(["source", "status"])
    .where("id", "=", caller.id)
    .executeTakeFirst();
  if (row?.source !== "shipped" || row.status !== "active") throw new UnknownOperationError(name);
}

const otherShift = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

export const staffingCheck = defineOperation({
  name: "staffing.check",
  description:
    "Tool-only (a shipped pack's tool): the dry run of putting someone on a shift. For a record " +
    "of an object that declares `staffed`, as it is or with `account` as its person (null: " +
    "nobody), answers the warnings the write would be made with (unavailable, not_qualified, " +
    "uncovered) and the other shift it would clash with (a clash is refused as double_booked). " +
    "Writes nothing.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    account: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe("A staff account to check as the shift's person; null for nobody"),
  }),
  output: z.object({
    warnings: z.array(staffWarningSchema),
    clash: otherShift.nullable(),
  }),
  permission: "records:read",
  risk: "read",
  toolOnly: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertShippedToolRun(ctx, "staffing.check");
    const object = getObject(input.object);
    if (!object?.staffed) {
      throw new ValidationError(`${input.object} is not a shift (it declares no staffed)`, {
        field: "object",
      });
    }
    const record = await loadRecord(ctx, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    return checkShift(ctx, object, input.id, record.values, input.account);
  },
});

export const staffingOperations = [staffingCheck] as const;
