// customer.settings.* operations (stage 22, ADR 0402): whether customers sign up freely or only
// when invited (or as buyers, ADR 0458, and anyone starting a subscription, ADR 0459), and how
// long staff have to action an erase request. Staff only. Changing them is admins only and humans
// only: no assistant, MCP client, automation or extension may open or close sign-up or give staff
// longer to erase someone, or change how far ahead a customer's "Needs your attention" looks
// (stage 48, ADR 0711).
import { z } from "zod";
import { findPlanOnSale, forgetPlanOnSale, hasPlanOnSale } from "../customers/plan-on-sale.ts";
import {
  ACCOUNT_ATTENTION_DAYS_SETTING,
  attentionDaysSchema,
  CUSTOMER_EMAIL_CONNECTION_SETTING,
  CUSTOMER_ERASE_DUE_SETTING,
  CUSTOMER_SIGNUP_SETTING,
  CUSTOMER_SIGNUP_SUBSCRIBERS_SETTING,
  customerSignupModeSchema,
  eraseDueDaysSchema,
  loadAttentionDays,
  loadCustomerEmailConnection,
  loadCustomerSignup,
  loadCustomerSignupSubscribers,
  loadEraseDueDays,
} from "../customers/settings.ts";
import { signInKindStatement, signInMailState } from "../customers/sign-in-mail.ts";
import { signupStateStatement } from "../customers/subscriber-signup.ts";
import { ValidationError } from "../errors.ts";
import { resolveChannelTarget } from "../notifications/channels.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const signup = customerSignupModeSchema.describe(
  "Who may sign in as a customer. invite_only (the default): an address staff invited or that " +
    "has an account. buyers: those, and the buyer's address of any order that was paid (in " +
    "full or in part, even if refunded since). open: anyone who verifies an email address.",
);
const startingSubscription = z
  .boolean()
  .describe(
    "On top of signup: anyone starting a subscription (default false). While the host has a " +
      "subscription plan on sale to the public, any address with no account may get a sign-in " +
      "code and so a customer account, to start the plan signed in with its free trial. In " +
      "effect, anyone can make an account while a plan is on sale, including people already in " +
      "the records (a contact, a past buyer), who then see their own orders, tickets and " +
      "subscriptions. Sign-up opens the moment a plan goes on sale, whoever publishes or prices " +
      "it; admins are told when it does. Kept when signup is open, and applies again if the " +
      "mode changes back.",
  );
const eraseDueDays = eraseDueDaysSchema.describe(
  "Days staff have to erase the person or decline, after a customer deletes their account " +
    "(default 30). Admins are notified daily about a request past it.",
);
const attentionDays = attentionDaysSchema.describe(
  "account.attentionDays: how many days ahead a customer's Needs your attention (me.attention) " +
    "lists a pass about to expire with uses left and a free trial about to end (default 7, 1 " +
    "to 30).",
);
const emailConnectionId = z
  .string()
  .min(1)
  .max(64)
  .nullable()
  .describe(
    "The org email-send connection (con_…) the host's mail goes out from: customer and staff " +
      "sign-in codes, invite notices and a declined erase request. The host sends it itself, as " +
      "no staff member. Null: nobody can sign in by code, and is told sign-in is not set up.",
  );
const customerSettings = z.object({
  signup,
  startingSubscription,
  eraseDueDays,
  attentionDays,
  emailConnectionId,
});
/** Whether sign-in codes go out at once through that connection now (ADR 0456). */
const signInMail = z.object({
  kind: z.object({ tag: z.string(), label: z.string() }).nullable(),
  autoApproved: z.boolean(),
  ready: z.boolean(),
  problem: z.string().nullable(),
});

async function load(ctx: HandlerContext) {
  return {
    signup: await loadCustomerSignup(ctx.db),
    startingSubscription: await loadCustomerSignupSubscribers(ctx.db),
    eraseDueDays: await loadEraseDueDays(ctx.db),
    attentionDays: await loadAttentionDays(ctx.db),
    emailConnectionId: await loadCustomerEmailConnection(ctx.db),
  };
}

export const customerSettingsGet = defineOperation({
  name: "customer.settings.get",
  description:
    "Get the customer account settings: whether customer sign-up is open or invite only, " +
    "whether anyone starting a subscription may sign in too (and whether a plan is on sale), " +
    "how many days staff have to action a deleted account's erase request, how many days ahead " +
    "a customer's Needs your attention looks, which email " +
    "connection the host's mail goes out from, and whether sign-in codes go out through it " +
    "now (signInMail: not until an admin lets its sign-in kind apply without review). Read-only.",
  input: z.object({}),
  output: customerSettings.extend({
    signInMail,
    planOnSale: z
      .boolean()
      .describe(
        "A subscription plan is on sale to the public now, so startingSubscription lets new " +
          "addresses sign in",
      ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return {
      ...(await load(ctx)),
      signInMail: await signInMailState(ctx.db, ctx.floor),
      planOnSale: await hasPlanOnSale(ctx.db, ctx.now),
    };
  },
});

export const customerSettingsUpdate = defineOperation({
  name: "customer.settings.update",
  description:
    "Change whether customer sign-up is open or invite only, whether anyone starting a " +
    "subscription may sign in too, the days staff have to action " +
    "an erase request, the days ahead a customer's Needs your attention looks, or the email connection customer mail goes out from. Only what you " +
    "pass changes. Admins only, and only a human can call it: " +
    "AI assistants, MCP clients, automations and extensions are refused.",
  input: z.object({
    signup: signup.optional(),
    startingSubscription: startingSubscription.optional(),
    eraseDueDays: eraseDueDays.optional(),
    attentionDays: attentionDays.optional(),
    emailConnectionId: emailConnectionId.optional(),
  }),
  output: customerSettings.extend({ previous: customerSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (
      input.signup === undefined &&
      input.startingSubscription === undefined &&
      input.eraseDueDays === undefined &&
      input.attentionDays === undefined &&
      input.emailConnectionId === undefined
    ) {
      throw new ValidationError(
        "Pass signup, startingSubscription, eraseDueDays, attentionDays, emailConnectionId or " +
          "any of them",
      );
    }
    if (input.emailConnectionId) {
      // Only a connection that can send: an org email-send connection with a sender bound.
      const target = await resolveChannelTarget(ctx.db, "email", input.emailConnectionId);
      if ("problem" in target) {
        throw new ValidationError(`That connection cannot send customer mail: ${target.problem}`, {
          field: "emailConnectionId",
        });
      }
    }
    const previous = await load(ctx);
    const next = {
      signup: input.signup ?? previous.signup,
      startingSubscription: input.startingSubscription ?? previous.startingSubscription,
      eraseDueDays: input.eraseDueDays ?? previous.eraseDueDays,
      attentionDays: input.attentionDays ?? previous.attentionDays,
      emailConnectionId:
        input.emailConnectionId === undefined
          ? previous.emailConnectionId
          : input.emailConnectionId,
    };
    const store = (
      key: string,
      field:
        | "signup"
        | "startingSubscription"
        | "eraseDueDays"
        | "attentionDays"
        | "emailConnectionId",
    ) => {
      const value = JSON.stringify(next[field]);
      ctx.write(
        ctx.db
          .insertInto("core_settings")
          .values({ key, value, updated_at: ctx.now, updated_by: ctx.user.id })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
          ),
      );
      ctx.recordChange({
        object: "settings",
        id: key,
        action: "update",
        before: { [field]: previous[field] },
        after: { [field]: next[field] },
      });
    };
    if (input.signup !== undefined) store(CUSTOMER_SIGNUP_SETTING, "signup");
    if (input.startingSubscription !== undefined) {
      store(CUSTOMER_SIGNUP_SUBSCRIBERS_SETTING, "startingSubscription");
      forgetPlanOnSale();
      // Turned on: what is on sale now is the starting point, so only a plan going on sale
      // later is reported to admins as opening sign-up (subscriber-signup.ts).
      if (input.startingSubscription && !previous.startingSubscription) {
        const found = await findPlanOnSale(ctx.db, ctx.now);
        ctx.write(
          signupStateStatement(
            ctx.db,
            {
              onSale: found.state === "on_sale",
              plan: found.state === "on_sale" ? found.plan : null,
              at: ctx.now,
            },
            ctx.user.id,
          ),
        );
      }
    }
    if (input.eraseDueDays !== undefined) store(CUSTOMER_ERASE_DUE_SETTING, "eraseDueDays");
    if (input.attentionDays !== undefined) {
      store(ACCOUNT_ATTENTION_DAYS_SETTING, "attentionDays");
    }
    if (input.emailConnectionId !== undefined) {
      store(CUSTOMER_EMAIL_CONNECTION_SETTING, "emailConnectionId");
      // Its vendor's sign-in kind is made known now (auto-approvable, not auto-approved), so an
      // admin can turn it on before any code is asked for (ADR 0456).
      if (input.emailConnectionId) {
        const connection = await ctx.db
          .selectFrom("core_integration_connection")
          .select("vendor")
          .where("id", "=", input.emailConnectionId)
          .executeTakeFirst();
        const statement = connection
          ? signInKindStatement(ctx.db, connection.vendor, ctx.now)
          : null;
        if (statement) ctx.write(statement);
      }
    }
    return { ...next, previous };
  },
});

export const customerSettingsOperations = [customerSettingsGet, customerSettingsUpdate] as const;
