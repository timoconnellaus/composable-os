// allowance.* operations (stage 32b, ADR 0493): how many uses a holder (a pass, a membership)
// has spent and has left in a period. Read only. Nothing here spends or gives back a use: a
// spender's own write does, in its batch, when it enters a state its object declares.
//
// A customer reads their own holders only (the record's customer scope: anyone else's is not
// found); staff read any. The operation is `hostInternal` because it reads the host's counters,
// after the seam has said the caller may see the holder.
import { z } from "zod";
import { periodOf } from "../allowance/periods.ts";
import { holderOf, holderTerms } from "../allowance/records.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const period = z.object({
  key: z.string().describe("total, week:<Monday's local date> or month:<YYYY-MM>"),
  startsAt: z.string(),
  endsAt: z.string(),
  used: z.number(),
  left: z
    .number()
    .nullable()
    .describe(
      "Uses that can still be spent in it; 0 when the holder cannot pay then, null when unlimited",
    ),
});

export const allowanceViewSchema = z.object({
  object: z.string(),
  id: z.string(),
  personId: z.string().nullable(),
  uses: z.number().nullable().describe("Uses per period; null is unlimited"),
  per: z.enum(["total", "week", "month"]),
  zone: z.string().describe("The time zone weeks and months are counted in"),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable().describe("A spender's time must be before this"),
  live: z.boolean().describe("Its state lets it be spent (not paused, used up, ended or void)"),
  at: z.string().describe("The time the period was read for"),
  period,
});
export type AllowanceView = z.infer<typeof allowanceViewSchema>;

/** The holder's numbers in the period containing `at`. */
export async function readAllowance(
  ctx: HandlerContext,
  objectName: string,
  id: string,
  at: string,
): Promise<AllowanceView> {
  const object = getObject(objectName);
  if (!object || !holderOf(object)) {
    throw new ValidationError(`${objectName} does not hold an allowance`, { field: "object" });
  }
  // The seam decides whether the caller may see it: a customer's own only.
  const record = await ctx.records.get(object.name, id);
  if (!record) throw new NotFoundError(object.name, id);
  const row = await ctx.db
    .selectFrom("core_allowance")
    .selectAll()
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .executeTakeFirst();
  // A holder written before its object declared the behaviour has no row yet: its record says.
  const terms = row
    ? {
        personId: row.person_id,
        uses: row.uses,
        per: row.per,
        zone: row.zone,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        live: row.live === 1 && row.trashed === 0,
      }
    : await holderTerms(ctx, object, id, record.values as Record<string, unknown>);
  const current = periodOf(at, terms.per, terms.zone);
  const counted = await ctx.db
    .selectFrom("core_allowance_period")
    .select("used")
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .where("period", "=", current.key)
    .executeTakeFirst();
  const used = counted?.used ?? 0;
  const payable =
    terms.live &&
    (terms.validFrom === null || at >= terms.validFrom) &&
    (terms.validUntil === null || at < terms.validUntil);
  return {
    object: object.name,
    id,
    personId: terms.personId,
    uses: terms.uses,
    per: terms.per,
    zone: terms.zone,
    validFrom: terms.validFrom,
    validUntil: terms.validUntil,
    live: terms.live,
    at,
    period: {
      key: current.key,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      used,
      left: !payable ? 0 : terms.uses === null ? null : Math.max(terms.uses - used, 0),
    },
  };
}

export const allowanceGet = defineOperation({
  name: "allowance.get",
  description:
    "How many uses a pass, membership or other allowance holder has spent and has left, in the " +
    "period containing `at` (default now): this week or month (from Monday, or the 1st, in its " +
    "time zone), or in all for a pass of N. Also its uses per period (null is unlimited), " +
    "whether it can be spent (live), and the dates it is valid between. A signed-in customer " +
    "reads their own only; anyone else's is not found. Read-only: uses are spent by booking.",
  input: z.object({
    object: z.string().min(1).max(81).describe("An extension object that holds an allowance"),
    id: z.string().min(1).max(64),
    at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("The time to read the period of (a class's start), ISO 8601; default now"),
  }),
  output: allowanceViewSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const at = new Date(input.at ?? ctx.now).toISOString();
    return readAllowance(ctx, input.object, input.id, at);
  },
});

export const allowanceOperations = [allowanceGet] as const;
