// allowance.* operations (stage 32b, ADR 0493): how many uses a holder (a pass, a membership)
// has spent and has left in a period. Read only. Nothing here spends or gives back a use: a
// spender's own write does, in its batch, when it enters a state its object declares.
//
// A customer reads their own holders only (the record's customer scope); anyone else's, and an
// object that is not a holder or does not exist for them, is not found, all alike. Of the terms a
// customer is told only those whose fields the object's `customer.read` lists; the period's
// numbers are what the operation is for. The terms are the host's own row (never worked out from
// what the customer may see). It is `hostInternal` because it reads the host's counters, after the
// seam has said the caller may see the holder.
import { z } from "zod";
import { periodOf } from "../allowance/periods.ts";
import { holderOf, keyingAt, storedTerms } from "../allowance/records.ts";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { localParts } from "../time/local.ts";

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
  personId: z.string().nullable().optional().describe("Staff only"),
  uses: z
    .number()
    .nullable()
    .optional()
    .describe("Uses per period; null is unlimited. Left out when the caller may not read it"),
  per: z.enum(["total", "week", "month"]).optional(),
  zone: z.string().optional().describe("The time zone weeks and months are counted in"),
  validFrom: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional().describe("A spender's time must be before this"),
  live: z
    .boolean()
    .optional()
    .describe("Its state lets it be spent (not paused, used up, ended or void)"),
  at: z.string().describe("The time the period was read for"),
  payable: z
    .boolean()
    .describe(
      "It can pay for something at `at`: live, out of the Trash and within its dates (uses aside)",
    ),
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
  const def = object ? holderOf(object) : undefined;
  if (!object || !def) throw new NotFoundError(objectName, id);
  // The seam decides whether the caller may see it: a customer's own only.
  await ctx.records.get(object.name, id).catch(() => {
    throw new NotFoundError(objectName, id);
  });
  const terms = await storedTerms(ctx, { object: object.name, id });
  if (!terms) throw new NotFoundError(objectName, id);
  const keying = keyingAt(terms, at);
  const current = periodOf(at, keying.per, keying.zone);
  const counted = await ctx.db
    .selectFrom("core_allowance_period")
    .select(["used", "uses"])
    .where("object_type", "=", object.name)
    .where("record_id", "=", id)
    .where("period", "=", current.key)
    .where("zone", "=", keying.zone)
    .executeTakeFirst();
  const used = counted?.used ?? 0;
  const limit = counted ? counted.uses : terms.uses;
  const atDate = localParts(at, terms.zone).date;
  const payable =
    terms.live &&
    !terms.trashed &&
    (terms.validFrom === null || at >= terms.validFrom) &&
    (terms.validUntil === null || at < terms.validUntil) &&
    (terms.fromDate === null || atDate >= terms.fromDate) &&
    (terms.untilDate === null || atDate <= terms.untilDate);
  const numbers = {
    key: current.key,
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    used,
    left: !payable ? 0 : limit === null ? null : Math.max(limit - used, 0),
  };
  const full: AllowanceView = {
    object: object.name,
    id,
    personId: terms.personId,
    uses: terms.uses,
    per: keying.per,
    zone: keying.zone,
    validFrom: terms.validFrom ?? (terms.fromDate ? `${terms.fromDate}` : null),
    validUntil: terms.validUntil ?? (terms.untilDate ? `${terms.untilDate}` : null),
    live: terms.live && !terms.trashed,
    at,
    payable,
    period: numbers,
  };
  if (ctx.principal.kind === "staff") return full;
  // A customer: only the terms whose fields they may read of their own record.
  const read = new Set(object.customer?.read ?? []);
  const may = (field: string | undefined) => field !== undefined && read.has(field);
  return {
    object: object.name,
    id,
    ...(may(def.uses) ? { uses: full.uses } : {}),
    ...("fixed" in def.per || may(def.per.field) ? { per: full.per } : {}),
    ...(def.zone === undefined || may(def.zone) ? { zone: full.zone } : {}),
    ...(may(def.from) ? { validFrom: full.validFrom } : {}),
    ...(may(def.until) ? { validUntil: full.validUntil } : {}),
    ...(may(object.states?.field) ? { live: full.live } : {}),
    at,
    payable,
    period: numbers,
  };
}

export const allowanceGet = defineOperation({
  name: "allowance.get",
  description:
    "How many uses a pass, membership or other allowance holder has spent and has left, in the " +
    "period containing `at` (default now): this week or month (from Monday, or the 1st, in its " +
    "time zone), or in all for a pass of N. Staff also get its uses per period (null is " +
    "unlimited), whether it can be spent (live), and the dates it is valid between; a signed-in " +
    "customer reads their own only, with the terms their own record shows them. Anyone else's " +
    "is not found. Read-only: uses are spent by booking.",
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

export const allowanceList = defineOperation({
  name: "allowance.list",
  description:
    "allowance.get for up to 50 holders of one object at once (a member's passes): each one's " +
    "numbers in the period containing `at` (default now), and whether it can pay then. Staff any; " +
    "a signed-in customer their own only: an id they cannot see is left out. Read-only.",
  input: z.object({
    object: z.string().min(1).max(81).describe("An extension object that holds an allowance"),
    ids: z.array(z.string().min(1).max(64)).min(1).max(50),
    at: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({ items: z.array(allowanceViewSchema) }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const at = new Date(input.at ?? ctx.now).toISOString();
    const items: AllowanceView[] = [];
    for (const id of new Set(input.ids)) {
      try {
        items.push(await readAllowance(ctx, input.object, id, at));
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return { items };
  },
});

export const allowanceOperations = [allowanceGet, allowanceList] as const;
