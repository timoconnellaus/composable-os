// subscription.offer.* operations (stage 32a, build step 4, ADRs 0491 and 0492): continuation
// offers for subscribers moving from another platform.
//
// Who may call what:
//   subscription.offer.import    staff, a person, subscriptions:manage   offers from a list (dry run first)
//   subscription.offer.list      staff, subscriptions:manage             the report: who took theirs
//   subscription.offer.export    staff, subscriptions:manage             the report as CSV
//   subscription.offer.withdraw  staff, a person, subscriptions:manage   one not yet taken
//   subscription.offer.mine      a signed-in customer                    their own open offers
//
// An offer is taken with `subscription.start { offerId }`, by its own person signed in as its
// address. Nothing here gives free time to anyone: the import writes offers for addresses whose
// people must still sign in, and only a person runs it (never an assistant, an MCP client or an
// automation).
import { z } from "zod";
import { defineOperation } from "../operation.ts";
import {
  exportOffers,
  importOffers,
  listOffers,
  myOffers,
  OFFER_IMPORT_MAX,
  OFFER_IMPORT_OUTCOMES,
  OFFER_STATUSES,
  withdrawOffer,
} from "../subscriptions/offers.ts";

const plan = z.object({
  object: z.string().min(1).max(80).describe("The plan's object (one sold every period)"),
  id: z.string().min(1).max(64).describe("The plan"),
});

export const subscriptionOfferImport = defineOperation({
  name: "subscription.offer.import",
  description:
    `Import up to ${OFFER_IMPORT_MAX} continuation offers for one plan: people subscribed on ` +
    "another platform, each an email address and the date they have paid up to there. Each person " +
    "signs in as that address and subscribes again, free until the date, then charged; never a " +
    "trial on top. Addresses are matched to the one live person who has them (import the people " +
    "first; none is created). The address is the key: a re-run changes nothing, a changed date " +
    "updates an offer not yet taken, and an offer taken or withdrawn since is a conflict, kept. " +
    "A date is the start of that day in the organisation's time zone. dryRun checks everything " +
    "and says what would happen, writing nothing. invite also invites each address to sign in " +
    "(customer.invite; needs users:manage). A person's door: cos subscriptions offers import runs it.",
  input: z.object({
    plan,
    rows: z
      .array(
        z.object({
          email: z.string().max(320),
          freeUntil: z
            .string()
            .max(40)
            .describe("The date they have paid up to (YYYY-MM-DD), or a moment with its offset"),
          reference: z
            .string()
            .max(200)
            .optional()
            .describe("The other platform's reference for the old subscription"),
        }),
      )
      .min(1)
      .max(OFFER_IMPORT_MAX),
    dryRun: z.boolean().default(false),
    invite: z
      .boolean()
      .default(false)
      .describe("Invite each matched address to sign in as a customer (needs users:manage)"),
  }),
  output: z.object({
    results: z.array(
      z.object({
        email: z.string(),
        outcome: z.enum(OFFER_IMPORT_OUTCOMES),
        offerId: z.string().nullable(),
        personId: z.string().nullable(),
        freeUntil: z.string().nullable(),
        note: z.string().nullable(),
        signIn: z.enum(["invited", "invited_before", "has_account"]).nullable(),
      }),
    ),
  }),
  permission: "subscriptions:manage",
  risk: "bulk-write",
  actors: ["human"],
  mcp: { expose: false },
  bulkSize: (input) => input.rows.length,
  auditSummary: (output, input) => ({
    plan: input.plan,
    dryRun: input.dryRun,
    invite: input.invite,
    outcomes: output.results.reduce<Record<string, number>>((n, r) => {
      n[r.outcome] = (n[r.outcome] ?? 0) + 1;
      return n;
    }, {}),
  }),
  async handler(input, ctx) {
    return { results: await importOffers(ctx, input) };
  },
});

const reportItem = z.object({
  id: z.string(),
  email: z.string(),
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  planObject: z.string(),
  planId: z.string(),
  reference: z.string().nullable(),
  freeUntil: z.string().describe("The date they paid up to elsewhere: free until then"),
  status: z
    .enum(OFFER_STATUSES)
    .describe(
      "taken (end their old subscription), open (not yet: chase them before the date), " +
        "expired (the date passed untaken), withdrawn",
    ),
  held: z.boolean().describe("A checkout from it is open at the provider"),
  takenAt: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  subscriptionState: z.string().nullable(),
  chargesFrom: z
    .string()
    .nullable()
    .describe("When the new subscription starts charging (taken offers only)"),
  chargedFromStart: z
    .boolean()
    .describe("Taken with under 48 hours left, so charged at once with no free time"),
  subscribedWithout: z
    .object({ id: z.string(), state: z.string(), createdAt: z.string() })
    .nullable()
    .describe("Not taken, but subscribed to the plan another way (charged, no free time)"),
  withdrawnAt: z.string().nullable(),
  withdrawReason: z.string().nullable(),
  createdAt: z.string(),
});

const reportFilter = {
  status: z.enum(OFFER_STATUSES).optional(),
  planObject: z.string().min(1).max(80).optional(),
};

export const subscriptionOfferList = defineOperation({
  name: "subscription.offer.list",
  description:
    "The continuation offers report, by address: who has taken their offer (with the date their " +
    "new subscription starts charging), so the company ends exactly those old subscriptions on " +
    "the other platform at their period's end, and who has not, to chase before their date. " +
    "Filter by status (taken, open, expired, withdrawn) and plan object. counts gives every " +
    "status's total. Pass nextCursor back as cursor for the next page. Read-only.",
  input: z.object({
    ...reportFilter,
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    items: z.array(reportItem),
    nextCursor: z.string().nullable(),
    counts: z.object({
      open: z.number(),
      taken: z.number(),
      expired: z.number(),
      withdrawn: z.number(),
    }),
  }),
  permission: "subscriptions:manage",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return listOffers(ctx, input);
  },
});

export const subscriptionOfferExport = defineOperation({
  name: "subscription.offer.export",
  description:
    "The continuation offers report as a CSV file (every offer, or those of one status): " +
    "email, name, the old platform's reference, paid up to, status, when it was taken, when the " +
    "new subscription starts charging, and the subscription. Read-only.",
  input: z.object(reportFilter),
  output: z.object({ filename: z.string(), csv: z.string(), rowCount: z.number() }),
  permission: "subscriptions:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    return exportOffers(ctx, input);
  },
});

export const subscriptionOfferWithdraw = defineOperation({
  name: "subscription.offer.withdraw",
  description:
    "Withdraw a continuation offer that has not been taken, with a reason: it can no longer be " +
    "taken. A checkout already open from it can still be completed at the provider; staff are " +
    "told if it is. A person decides, not an AI assistant.",
  input: z.object({
    id: z.string().min(1).max(64).describe("Offer id (sof_…)"),
    reason: z.string().trim().min(1).max(500).describe("Why"),
  }),
  output: z.object({
    id: z.string(),
    pageOpen: z.boolean().describe("A checkout from it was open and may still be completed"),
  }),
  permission: "subscriptions:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    return withdrawOffer(ctx, input.id, input.reason);
  },
});

export const subscriptionOfferMine = defineOperation({
  name: "subscription.offer.mine",
  description:
    "The signed-in customer's own continuation offers they can still take: a plan, free until " +
    "the date they have paid up to on another platform, then charged. Take one with " +
    "subscription.start { offerId }. chargedNow: under 48 hours are left, so taking it now is " +
    "charged at once. Read-only.",
  input: z.object({}),
  output: z.object({
    offers: z.array(
      z.object({
        id: z.string(),
        planObject: z.string(),
        planId: z.string(),
        freeUntil: z.string(),
        chargedNow: z.boolean(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    return { offers: await myOffers(ctx) };
  },
});

export const subscriptionOfferOperations = [
  subscriptionOfferImport,
  subscriptionOfferList,
  subscriptionOfferExport,
  subscriptionOfferWithdraw,
  subscriptionOfferMine,
] as const;
