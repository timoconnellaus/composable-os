// subscription.* operations (stage 32a, ADRs 0485 to 0487).
//
// Who may call what:
//   subscription.start    staff, customers and the public   the provider's page to subscribe on
//   subscription.get      staff; a customer, their own      one subscription through the seam
//   subscription.list     staff; a customer, their own      a page of subscriptions
//   subscription.cancel   staff (subscriptions:manage); a customer, their own: end it at period end
//   subscription.resume   staff (subscriptions:manage); a customer, their own: undo that
//   subscription.portal   a customer                        the provider's portal: card, invoices
//
// No operation here takes a price, moves a subscription or makes a period paid: the provider's
// verified events do that, through `order.applyPaymentEvent`. Cancel and resume ask the provider;
// the subscription shows the change when the provider's event arrives. A customer's "own" is the
// subscription they pay for (ADR 0487). Ending one at once is staff's, with stage 32a's staff side.
//
// subscription.start, .cancel, .resume and .portal are `hostInternal`: the host calls the
// gatekeeper for a caller outside the org, so they keep the database; each touches only the
// caller's own subscription (through the seam) or the checkout it opens.
import { z } from "zod";
import { SUBSCRIPTION_STATES } from "../fields/subscription.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  cancelAtPeriodEnd,
  openPortal,
  resumeSubscription,
  startSubscription,
  subscriptionForChange,
} from "../subscriptions/subscriptions.ts";
import type { VisibleRecord } from "../visibility/records.ts";

const subscriptionId = z.string().min(1).max(64).describe("Subscription id (sbs_…)");
const when = z.string().nullable();

/** A subscription as its payer may read it. `payerPersonId` and `email` are for staff only. */
export const subscriptionSchema = z.object({
  id: z.string(),
  state: z.enum(SUBSCRIPTION_STATES),
  planObject: z.string(),
  planId: z.string(),
  planTitle: z.string(),
  amount: z
    .number()
    .describe("The price of one period, in the currency's minor unit, tax included"),
  currency: z.string(),
  interval: z.enum(["week", "month", "year"]),
  taxed: z.boolean(),
  trialEnd: when,
  currentPeriodStart: when,
  currentPeriodEnd: when.describe("When the current paid period (or trial) ends: the next charge"),
  cancelAtPeriodEnd: z.boolean().describe("Set to end when the current period ends"),
  cancelAt: when.describe("A date it is set to end on at the provider (its dashboard), or null"),
  canceledAt: when,
  endedAt: when,
  actionUrl: when.describe("The provider's page to confirm a renewal on, while one waits"),
  createdAt: z.string(),
  holderPersonId: z.string().nullable(),
  payerPersonId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  endReason: z.string().nullable().optional(),
  failingSince: when.optional(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const text = (value: unknown) => (value == null ? null : String(value));
const isStaff = (ctx: HandlerContext) => ctx.principal.kind === "staff";

function fromRecord(record: VisibleRecord, staff: boolean): Subscription {
  const v = record.values;
  return subscriptionSchema.parse({
    id: record.id,
    state: v.state,
    planObject: v.planObject,
    planId: v.planId,
    planTitle: v.planTitle,
    amount: v.amount,
    currency: v.currency,
    interval: v.interval,
    taxed: Boolean(v.taxed),
    trialEnd: text(v.trialEnd),
    currentPeriodStart: text(v.currentPeriodStart),
    currentPeriodEnd: text(v.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(v.cancelAtPeriodEnd),
    cancelAt: text(v.cancelAt),
    canceledAt: text(v.canceledAt),
    endedAt: text(v.endedAt),
    actionUrl: text(v.actionUrl),
    createdAt: String(v.createdAt),
    holderPersonId: text(v.holderPersonId),
    ...(staff
      ? {
          payerPersonId: text(v.payerPersonId),
          email: text(v.email),
          endReason: text(v.endReason),
          failingSince: text(v.failingSince),
        }
      : {}),
  });
}

export const subscriptionStart = defineOperation({
  name: "subscription.start",
  description:
    "Start a subscription to a plan (a record of an object sold every week, month or year), as a " +
    "signed-in customer, a guest (with an email address) or staff for someone. Opens the payment " +
    "provider's own page, which takes the card; the provider charges each period on its own " +
    "schedule, after the plan's free trial when it has one. The host prices it from the plan: no " +
    "price is sent. Coming back to `returnUrl` changes nothing: the subscription exists once the " +
    "provider confirms it. Returns the page's address and what will be charged, in minor units.",
  input: z.object({
    plan: z.object({
      object: z.string().min(1).max(80).describe("The plan's object"),
      id: z.string().min(1).max(64).describe("The plan"),
    }),
    returnUrl: z.string().min(1).max(2000).describe("Where the payer comes back to"),
    email: z
      .string()
      .trim()
      .max(320)
      .optional()
      .describe("The payer's email. Required unless the caller is a signed-in customer."),
  }),
  output: z.object({
    subscriptionId: z.string(),
    url: z.string().describe("The provider's page"),
    amount: z.number(),
    currency: z.string(),
    interval: z.enum(["week", "month", "year"]),
    trialDays: z.number().nullable(),
    expiresAt: z.string().nullable(),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  hostInternal: true,
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    subscriptionId: output.subscriptionId,
    plan: input.plan,
    amount: output.amount,
  }),
  async handler(input, ctx) {
    return startSubscription(ctx, input);
  },
});

export const subscriptionGet = defineOperation({
  name: "subscription.get",
  description:
    "Get one subscription: its plan, price per period, state (trial, active, past due, ended…), " +
    "the current period and whether it ends when that period does. A signed-in customer gets " +
    "the subscriptions they pay for only; anyone else's is not found. Read-only.",
  input: z.object({ id: subscriptionId }),
  output: subscriptionSchema,
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return fromRecord(await ctx.records.get("subscription", input.id), isStaff(ctx));
  },
});

export const subscriptionList = defineOperation({
  name: "subscription.list",
  description:
    "A page of subscriptions, newest first unless sorted otherwise. Filter on state, planObject, " +
    "planId, payerPersonId, holderPersonId, cancelAtPeriodEnd, currentPeriodEnd, failingSince. A " +
    "signed-in customer sees the ones they pay for only. Pass nextCursor back as cursor for the " +
    "next page. Read-only.",
  input: z.object({
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({ items: z.array(subscriptionSchema), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await ctx.records.list("subscription", input);
    const staff = isStaff(ctx);
    return {
      items: page.items.map((record) => fromRecord(record, staff)),
      nextCursor: page.nextCursor,
    };
  },
});

const changeOutput = z.object({
  id: z.string(),
  requested: z
    .literal(true)
    .describe("Asked of the provider; the subscription shows it once the provider confirms"),
});

export const subscriptionCancel = defineOperation({
  name: "subscription.cancel",
  description:
    "End a subscription when its current paid period (or trial) ends: nothing more is charged, " +
    "and what it gives lasts until then. A signed-in customer cancels their own; staff any, with the subscriptions:manage permission. " +
    "Nothing is refunded (a period's refund is order.refund). It can be undone until the period " +
    "ends (subscription.resume). Asked of the payment provider: the subscription shows it once " +
    "the provider confirms. A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    reason: z.string().trim().min(1).max(500).default("Cancelled by the payer").describe("Why"),
  }),
  output: changeOutput,
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff", "customer"],
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    await cancelAtPeriodEnd(ctx, row, input.reason);
    return { id: row.id, requested: true as const };
  },
});

export const subscriptionResume = defineOperation({
  name: "subscription.resume",
  description:
    "Keep a subscription going that was set to end when its period does, before that happens: " +
    "the provider charges the next period as usual. A signed-in customer resumes their own; staff " +
    "any, with the subscriptions:manage permission. An end date set at the provider another way " +
    "is refused: staff change it there. Asked of the payment provider: the subscription shows it " +
    "once the provider confirms. " +
    "A person decides, not an AI assistant.",
  input: z.object({ id: subscriptionId }),
  output: changeOutput,
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff", "customer"],
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    await resumeSubscription(ctx, row);
    return { id: row.id, requested: true as const };
  },
});

export const subscriptionPortal = defineOperation({
  name: "subscription.portal",
  description:
    "Open the payment provider's customer portal for the signed-in customer: the card they pay " +
    "with, their billing details and past invoices. Cancelling and plan changes are not there " +
    "(subscription.cancel). The address is short-lived and opens in its own page, never a frame.",
  input: z.object({
    returnUrl: z.string().min(1).max(2000).describe("Where the portal's back link goes"),
  }),
  output: z.object({ url: z.string() }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    return { url: await openPortal(ctx, input.returnUrl) };
  },
});

export const subscriptionOperations = [
  subscriptionStart,
  subscriptionGet,
  subscriptionList,
  subscriptionCancel,
  subscriptionResume,
  subscriptionPortal,
] as const;
