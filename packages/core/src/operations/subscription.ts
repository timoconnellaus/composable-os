// subscription.* operations (stage 32a, ADRs 0485 to 0487).
//
// Who may call what:
//   subscription.start    staff, customers and the public   the provider's page to subscribe on
//   subscription.get      staff; a customer, their own      one subscription through the seam
//   subscription.list     staff; a customer, their own      a page of subscriptions
//   subscription.cancel   staff (subscriptions:manage); a customer, their own: end it at period end
//   subscription.resume   staff (subscriptions:manage); a customer, their own: undo that
//   subscription.portal   a customer                        the provider's portal: card, invoices
//   subscription.change   staff (subscriptions:manage); a customer, their own: another plan
//                         (an upgrade now, prorated; a downgrade from the next period)
//   subscription.pause    staff (subscriptions:manage): the provider's pause, for a set time
//   subscription.unpause  staff (subscriptions:manage): end a pause now, or withdraw one asked
//   subscription.coolingOff staff; a customer, their own: may it be cooled off, and how far one got
//   subscription.coolOff  staff (subscriptions:manage); a customer, their own: end it now in its
//                         cooling-off period, every paid period owed back (ADR 0647)
//
// No operation here takes a price, moves a subscription or makes a period paid: the provider's
// verified events do that, through `order.applyPaymentEvent`. Cancel and resume ask the provider;
// the subscription shows the change when the provider's event arrives. A customer's "own" is the
// subscription they pay for (ADR 0487). Ending one at once (`subscription.cancel` with `now`) is
// staff's only. The trial rule (one per holder per plan object, ADR 0489) is subscription.start's.
//
// subscription.start, .cancel, .resume and .portal are `hostInternal`: the host calls the
// gatekeeper for a caller outside the org, so they keep the database; each touches only the
// caller's own subscription (through the seam) or the checkout it opens.
import { z } from "zod";
import { guestAcceptancesSchema } from "../agreements/enforce.ts";
import { ForbiddenError } from "../errors.ts";
import { SUBSCRIPTION_STATES } from "../fields/subscription.ts";
import { filterSchema } from "../filter.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { afterCommit, defineOperation, type HandlerContext } from "../operation.ts";
import {
  requestPause,
  requestPlanChange,
  requestUnpause,
  withdrawPlanChange,
} from "../subscriptions/changes.ts";
import {
  coolingOffFor,
  coolOff,
  NOT_OFFERED,
  releaseFollowUp,
  sweepCoolOffs,
} from "../subscriptions/cooling-off.ts";
import {
  cancelAtPeriodEnd,
  cancelNow,
  openPortal,
  resumeSubscription,
  startSubscription,
  subscriptionForChange,
} from "../subscriptions/subscriptions.ts";
import { NO_TRIAL_REASONS } from "../subscriptions/trial.ts";
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
  change: z
    .object({
      id: z.string(),
      kind: z.enum(["upgrade", "downgrade", "pause"]),
      state: z
        .enum(["requested", "waiting", "applied", "lapsed", "withdrawn"])
        .describe(
          "requested: asked of the provider (an upgrade waits for its charge to be paid); " +
            "waiting: a downgrade from the next period, or a pause not yet started; applied: the " +
            "pause it is in; lapsed: an upgrade whose charge was never paid",
        ),
      toPlanId: z.string().nullable(),
      toPlanTitle: z.string().nullable(),
      toAmount: z.number().nullable(),
      pauseFrom: when,
      pauseUntil: when.describe("When a pause ends and the provider charges again"),
      effectiveAt: when.describe("When a downgrade takes effect (its period's end)"),
      requestedAt: z.string(),
      callOutcome: z
        .enum(["sent", "pending", "unknown", "refused"])
        .nullable()
        .describe(
          "What came of asking the provider: unknown means it may or may not have reached it, and " +
            "the provider's next event decides; staff can withdraw it",
        ),
      actionUrl: when.describe(
        "The provider's page to confirm an upgrade's charge, while it waits",
      ),
      endOutcome: z
        .enum(["sent", "pending", "unknown", "refused"])
        .nullable()
        .describe("What came of ending a pause early: refused or unknown, ask again"),
    })
    .nullable()
    .optional()
    .describe("A plan change or a pause asked for and not yet over, or the pause it is in"),
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
    change: v.changeId
      ? {
          id: String(v.changeId),
          kind: v.changeKind,
          state: v.changeState,
          toPlanId: text(v.changeToPlanId),
          toPlanTitle: text(v.changeToPlanTitle),
          toAmount: v.changeToAmount == null ? null : Number(v.changeToAmount),
          pauseFrom: text(v.pauseFrom),
          pauseUntil: text(v.pauseUntil),
          effectiveAt: text(v.changeEffectiveAt),
          requestedAt: String(v.changeRequestedAt),
          callOutcome: v.changeCallOutcome ?? null,
          actionUrl: text(v.changeActionUrl),
          endOutcome: v.changeEndOutcome ?? null,
        }
      : null,
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
    "schedule, after the plan's free trial when it has one. A trial is one per person per plan, " +
    "and only for a signed-in customer (or staff with subscriptions:manage starting it for a " +
    "person): a guest is charged from the start, and `noTrial` says why no trial was given. " +
    "Starting again while the page you opened with a trial is still open gives that page. " +
    "A signed-in customer with a continuation offer (moving their subscription from another " +
    "platform) takes it with `offerId`: free until their paid-up date, then charged, with no " +
    "trial on top; with under 48 hours left it is charged at once. " +
    "Nobody starts one without the agreements the business needs for the plan (its terms, a " +
    "waiver): refused with rule agreements_due and the documents while any is due, a " +
    "continuation offer included (a guest passes their acceptances in `agreements`; a " +
    "signed-in customer agrees first; staff send a link or record paper). " +
    "The host prices it from the plan: no " +
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
    offerId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Take your continuation offer (subscription.offer.mine): free until its date, then " +
          "charged. A signed-in customer's own offer only.",
      ),
    holderPersonId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Staff only: the Person who holds what it gives (a child whose parent pays), when not " +
          "the payer. The payer, named by email, is billed; the trial and access are the holder's.",
      ),
    agreements: guestAcceptancesSchema.optional(),
  }),
  output: z.object({
    subscriptionId: z.string(),
    url: z.string().describe("The provider's page"),
    amount: z.number(),
    currency: z.string(),
    interval: z.enum(["week", "month", "year"]),
    trialDays: z.number().nullable().describe("The free days given; null: charged from the start"),
    freeUntil: z
      .string()
      .nullable()
      .describe("Free until this moment (a continuation offer taken), then charged; else null"),
    noTrial: z
      .enum(NO_TRIAL_REASONS)
      .nullable()
      .describe(
        "Why the plan's trial was not given: sign_in (a guest: only a signed-in customer gets a " +
          "trial), used (one trial per person per plan, had already), permission (staff without " +
          "subscriptions:manage), held (another page with the trial is open for this person), " +
          "unconfirmed (the payment provider could not say whether an earlier page was " +
          "completed; try again later for the trial), continuation (this person has an open " +
          "continuation offer on this plan, or a subscription from one still running: no trial on " +
          "top of it). Null otherwise",
      ),
    expiresAt: z.string().nullable(),
  }),
  permission: "records:write",
  risk: "write",
  audiences: ["staff", "customer", "public"],
  // Per signed-in account (ADR 0940): each opens the payment provider's page. A guest names
  // nothing yet: counted per address at the flood level.
  publicLimit: { tier: "write", perCaller: {}, group: "subscription.start" },
  // Naming another holder is staff's until the family link (ADR 0487, amended).
  staffInput: ["holderPersonId"],
  hostInternal: true,
  mcp: { expose: false },
  // What a visitor typed, drew and answered never reaches the audit log.
  redact: ["agreements"],
  auditSummary: (output, input) => ({
    subscriptionId: output.subscriptionId,
    plan: input.plan,
    amount: output.amount,
    ...(input.offerId ? { offerId: input.offerId, freeUntil: output.freeUntil } : {}),
    ...(input.holderPersonId ? { holderPersonId: input.holderPersonId } : {}),
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
    "planId, payerPersonId, holderPersonId, cancelAtPeriodEnd, currentPeriodEnd, failingSince, " +
    "changeKind, changeState, pauseUntil. Each shows its plan change or pause (`change`). A " +
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
    "the provider confirms. Staff can instead end it at once (`now: true`): nothing more is " +
    "charged, nothing is refunded and what it gives stops when the provider confirms; a customer " +
    "cannot. A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    reason: z.string().trim().min(1).max(500).default("Cancelled by the payer").describe("Why"),
    now: z
      .boolean()
      .default(false)
      .describe("Staff only: end it now instead of when its period ends"),
  }),
  output: changeOutput,
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff", "customer"],
  // Ending it at once is staff's: not in the customer's contract, refused from a customer.
  staffInput: ["now"],
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    // A cooling off under way is refused by both (ADR 0647, subscriptions/subscriptions.ts).
    if (input.now) await cancelNow(ctx, row, input.reason);
    else await cancelAtPeriodEnd(ctx, row, input.reason);
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

export const subscriptionChange = defineOperation({
  name: "subscription.change",
  description:
    "Move a subscription to another plan of the same kind (a membership from 3 a week to " +
    "unlimited). A dearer plan is an upgrade: it takes effect now, and the payment provider " +
    "charges the rest of the current period at once, prorated; the new plan applies only once " +
    "that charge is paid, so nothing is given that was not paid for. A cheaper (or same-priced) " +
    "plan is a downgrade: nothing is refunded or prorated, the member keeps the current plan until " +
    "its period ends, and the new price is charged from the next period. What the subscription " +
    "grants (a membership's classes) follows the plan when it takes effect. Only an active " +
    "subscription not set to end, with no other change waiting. A signed-in customer changes " +
    "their own, to a plan on sale; staff any, with subscriptions:manage. Asked of the payment " +
    "provider: the subscription shows the change once the provider confirms it. " +
    "A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    planId: z.string().min(1).max(64).describe("The plan to move to (a record of the same object)"),
    reason: z.string().trim().min(1).max(500).default("Changed by the payer").describe("Why"),
  }),
  output: z.object({
    id: z.string(),
    changeId: z.string(),
    kind: z.enum(["upgrade", "downgrade"]),
    effectiveAt: z
      .string()
      .nullable()
      .describe("When a downgrade takes effect (the period's end); null for an upgrade: once paid"),
    amount: z.number().describe("The new plan's price per period, minor units, tax included"),
    currency: z.string(),
    asked: z
      .enum(["sent", "pending", "unknown", "not_needed"])
      .describe(
        "sent: the provider was asked; unknown: it may or may not have been (its next event " +
          "decides); not_needed: the same price, nothing to ask",
      ),
    requested: z.literal(true),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  // Opened to customers (a reviewed change, ADR 0402; ADR 0530): a member changes their own plan
  // on the web (decision 5), through the host's rules (the plan priced by the host, one change at
  // a time, an upgrade applied only once paid).
  audiences: ["staff", "customer"],
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  auditSummary: (output, input) => ({
    subscriptionId: output.id,
    changeId: output.changeId,
    planId: input.planId,
    kind: output.kind,
    amount: output.amount,
  }),
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    return requestPlanChange(ctx, row, { planId: input.planId, reason: input.reason });
  },
});

export const subscriptionPause = defineOperation({
  name: "subscription.pause",
  description:
    "Pause a subscription for a set time (a membership frozen for an injury or travel): from now " +
    "or a later moment until a moment, within the plan's shortest and longest pause. While it is " +
    "paused the payment provider charges nothing, and what the subscription gives stops (no " +
    "classes, no access); on the end date the provider resumes it and charges a new period, less " +
    "the unused time of the period it was paused in. Only an active subscription not set to end, " +
    "on a plan that allows pauses, with no other change waiting. Staff only, with " +
    "subscriptions:manage; a member asks staff. Asked of the payment provider: the subscription " +
    "shows it paused once the provider confirms. A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    from: z
      .string()
      .max(40)
      .optional()
      .describe("When the pause starts (ISO 8601, later than now); left out: now"),
    until: z.string().min(1).max(40).describe("When it ends and charging starts again (ISO 8601)"),
    reason: z.string().trim().min(1).max(500).describe("Why (an injury, travel)"),
  }),
  output: z.object({
    id: z.string(),
    changeId: z.string(),
    from: z.string().nullable(),
    until: z.string(),
    asked: z.enum(["sent", "pending", "unknown"]),
    requested: z.literal(true),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff"],
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({
    subscriptionId: output.id,
    changeId: output.changeId,
    from: output.from,
    until: output.until,
  }),
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    return requestPause(ctx, row, input);
  },
});

export const subscriptionUnpause = defineOperation({
  name: "subscription.unpause",
  description:
    "End a subscription's pause now, before its date: the payment provider resumes it and charges " +
    "a new period from today, and what it gives starts again once the provider confirms. Or " +
    "withdraw a pause asked for later that has not started. Staff only, with " +
    "subscriptions:manage. A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    reason: z.string().trim().min(1).max(500).default("Back early").describe("Why"),
  }),
  output: z.object({
    id: z.string(),
    asked: z
      .enum(["sent", "pending", "unknown"])
      .describe(
        "unknown: it may or may not have reached the provider; ask again if it stays paused",
      ),
    requested: z.literal(true),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff"],
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    return requestUnpause(ctx, row, input.reason);
  },
});

export const subscriptionChangeWithdraw = defineOperation({
  name: "subscription.change.withdraw",
  description:
    "Withdraw a subscription's plan change that has not taken effect: one stuck waiting for the " +
    "payment provider, one whose outcome is unknown, or a downgrade waiting for its period (undo " +
    "it). A downgrade the provider may already show is put back there: the old price from the next " +
    "invoice, nothing prorated. An upgrade's pending charge is voided at the provider, so it can no " +
    "longer be paid (with nothing pending there, it was voided or expired already). The change " +
    "closes only once the provider is asked; refused or unknown, it stays open and is asked again. " +
    "A pause is ended with subscription.unpause. Staff only, with " +
    "subscriptions:manage. A person decides, not an AI assistant.",
  input: z.object({
    id: subscriptionId,
    reason: z.string().trim().min(1).max(500).describe("Why"),
  }),
  output: z.object({
    id: z.string(),
    changeId: z.string(),
    asked: z.enum(["sent", "pending", "unknown", "not_needed"]),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff"],
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await subscriptionForChange(ctx, input.id);
    return withdrawPlanChange(ctx, row, input.reason);
  },
});

const coolOffSchema = z
  .object({
    state: z
      .enum(["asked", "ended", "lapsed"])
      .describe(
        "asked: open until its deadline (any end of the subscription by then is its end); " +
          "ended: it ended (or staff finished it) and its refunds are owed; lapsed: its deadline " +
          "passed (or its waiting cancel was turned down, or the end was not its): nothing owed as " +
          "cooled off, and the ordinary cancel works again",
      ),
    asked: z
      .enum(["sent", "pending", "unknown", "refused"])
      .nullable()
      .describe("What came of the latest ask of the provider"),
    askedBy: z.enum(["payer", "staff"]),
    askedAt: z.string(),
    deadline: z.string().describe("Open until then: the ask plus the approval expiry (7 days)"),
    endedAt: when,
    finished: z.boolean().describe("Staff finished a lapsed one"),
    finishing: z
      .enum(["asked", "sent", "pending", "unknown", "stuck"])
      .nullable()
      .describe(
        "Staff asked to finish a lapsed one, not yet confirmed: asked or unknown (the host asks " +
          "the provider again), sent (waiting for the provider's end), pending (waiting for a " +
          "person at the payments gatekeeper), stuck (it could not be done; admins were told)",
      ),
    waiting: z
      .boolean()
      .describe(
        "A cancel of it waits for a person at the payments gatekeeper: nobody may ask again " +
          "until it is approved or turned down",
      ),
    lapsedBecause: z.enum(["deadline", "action", "end_time", "used"]).nullable(),
    askAgain: z
      .boolean()
      .describe(
        "The caller may ask the provider again now (the member inside the period, staff before " +
          "the deadline), or (staff) finish a lapsed one",
      ),
    open: z.boolean().describe("Open, before its deadline: the ordinary cancel waits"),
    staffTold: z.boolean().describe("Admins were told it is stuck or lapsed"),
    paid: z
      .number()
      .describe(
        "What it owes (or would, if it ended now): paid on or before the end of the period, plus paid after the ask and by the end, in minor units",
      ),
    refunded: z.number().describe("What has been refunded of that so far, in minor units"),
    refunds: z
      .enum(["waiting", "refunded", "held"])
      .nullable()
      .describe(
        "Once ended: waiting (each refund waits for a person who may refund), refunded, or held " +
          "(a refund was not approved or could not be asked: staff refund it from the order)",
      ),
  })
  .nullable();

const coolingOffStatusSchema = z.object({
  subscriptionId: z.string(),
  offered: z.boolean().describe("The payer may end it now for a full refund (cooling off)"),
  why: z
    .enum(NOT_OFFERED)
    .nullable()
    .describe(
      "Why not: not_covered (the plan has no cooling off), off (the business set none), " +
        "continuation (not started here as a new member), ended, window_passed, used (once per " +
        "member), nothing_paid (a free trial: an ordinary cancel ends it at no charge)",
    ),
  days: z.number().describe("The cooling-off days that apply; 0 when none"),
  until: z
    .string()
    .nullable()
    .describe("The last day of the window (YYYY-MM-DD, the business's time zone)"),
  endsAt: when.describe("The moment the window closes"),
  refund: z
    .number()
    .describe("What a cooling off asked now owes back, not yet refunded, in minor units"),
  currency: z.string(),
  coolOff: coolOffSchema.describe("A cooling off asked for, and how far it has got"),
});

export const subscriptionCoolingOff = defineOperation({
  name: "subscription.coolingOff",
  description:
    "Whether each subscription may be ended in its cooling-off period for a full refund: the " +
    "business's setting (whole days, 0 off), counted from when the payment provider confirmed " +
    "it to the end of the last day in the business's time zone, for a new member's membership " +
    "only (not a pass, not one moved over with a continuation offer), once per member. Also " +
    "says how far a cooling off asked for has got and where its refunds are. The host decides; " +
    "an app shows the button only when `offered`. A signed-in customer asks about the " +
    "subscriptions they pay for only; another's is not found. Read-only.",
  input: z.object({
    ids: z.array(subscriptionId).min(1).max(20).describe("Up to 20 subscriptions"),
  }),
  output: z.object({ items: z.array(coolingOffStatusSchema) }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer"],
  hostInternal: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return { items: await coolingOffFor(ctx, input.ids) };
  },
});

export const subscriptionCoolOff = defineOperation({
  name: "subscription.coolOff",
  description:
    "End a subscription in its cooling-off period, for a full refund of what was paid in it " +
    "(subscription.coolingOff says whether it may be, and what it owes). Ended at the payment " +
    "provider now: nothing more is charged, and what it gives stops once the provider confirms. " +
    "Then each order paid up to the end of the period, and between the ask and the end, is owed " +
    "back in full, whatever was used; each waits for a person with orders:refund to approve it. " +
    "The bookings ahead the membership paid for are cancelled as the business's. Refused for a " +
    "plan with no cooling off, a membership moved over with a continuation offer, a member who " +
    "has cooled off before, while nothing has been paid (a free trial: cancel instead), and " +
    "after the period unless one was asked in it. An ask inside the period opens it for 7 days; " +
    "any end in that time is the cooling off's, and at its deadline it lapses (the ordinary " +
    "cancel works again). A signed-in customer ends their own (the one they pay for, a child's " +
    "included) and asks again only inside the period; staff any, with subscriptions:manage, ask " +
    "again until the deadline, and finish a lapsed one (only what was paid in the period is " +
    "owed, once the provider confirms the membership ended). Each ask reads the provider first " +
    "and is a new request to it; nothing is done twice. Refused while a cancel of it waits for " +
    "a person at the payments gatekeeper. A person decides, never an AI assistant.",
  input: z.object({ id: subscriptionId }),
  output: z.object({
    id: z.string(),
    state: z
      .enum(["asked", "ended", "lapsed"])
      .describe(
        "asked: open; ended: it ended (or was finished) and its refunds are owed; lapsed: staff " +
          "asked to finish it and the provider has not confirmed the end yet",
      ),
    asked: z
      .enum(["sent", "pending", "unknown"])
      .nullable()
      .describe(
        "sent: the provider was asked to end it; pending: it waits for a person at the payments " +
          "gatekeeper; unknown: it may or may not have reached it (its next event decides; staff " +
          "are told)",
      ),
    refund: z.number().describe("Paid and not refunded so far, in minor units: owed back"),
    currency: z.string(),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  audiences: ["staff", "customer"],
  actors: ["human"],
  hostInternal: true,
  mcp: { expose: false },
  auditSummary: (output) => ({
    subscriptionId: output.id,
    state: output.state,
    asked: output.asked,
    refund: output.refund,
  }),
  async handler(input, ctx) {
    return coolOff(ctx, input.id);
  },
});

export const subscriptionCoolOffSweep = defineOperation({
  name: "subscription.coolOffSweep",
  description:
    "The host's minute step for cooling offs: one whose call to the payment provider was lost " +
    "or never made is resolved from the provider's read or asked again (the same ask) until its " +
    "deadline; at the deadline, or once its latest waiting cancel is rejected or expires with " +
    "none still waiting, or once its holder has used theirs on another, an open one lapses " +
    "(every waiting cancel rejected, admins told once); staff's finish of a lapsed one is asked " +
    "again, waited for, or marked stuck with admins told; then the summary emails. Bounded; " +
    "nothing when nothing is due. The host's own cron only.",
  input: z.object({}),
  output: z.object({
    resolved: z.number(),
    asked: z.number(),
    told: z.number(),
    unread: z.number(),
    lapsed: z.number(),
    mailed: z.number(),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  actors: ["automation"],
  // The host finishing what a person asked in time: never queued under a floor.
  hostStep: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError("Only the host's own cron sweeps cooling offs");
    }
    return afterCommit(() => sweepCoolOffs(ctx));
  },
});

export const subscriptionCoolOffRelease = defineOperation({
  name: "subscription.coolOffRelease",
  description:
    "The host's follow-up for a membership ended in its cooling-off period: cancels the next " +
    "bookings ahead it paid for, as the business's, until none is left. The host's own cron only.",
  input: z.object({ id: subscriptionId }),
  output: z.object({ released: z.number(), left: z.boolean() }),
  permission: "subscriptions:manage",
  risk: "write",
  actors: ["automation"],
  // The host carrying out what a person asked in time: never queued under a floor.
  hostStep: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.origin.surface !== "system") {
      throw new ForbiddenError(
        "Only the host's own cron releases a cooled-off membership's bookings",
      );
    }
    return releaseFollowUp(ctx, input.id);
  },
});

export const subscriptionOperations = [
  subscriptionStart,
  subscriptionGet,
  subscriptionList,
  subscriptionCancel,
  subscriptionResume,
  subscriptionPortal,
  subscriptionChange,
  subscriptionPause,
  subscriptionUnpause,
  subscriptionChangeWithdraw,
  subscriptionCoolingOff,
  subscriptionCoolOff,
  subscriptionCoolOffSweep,
  subscriptionCoolOffRelease,
] as const;
