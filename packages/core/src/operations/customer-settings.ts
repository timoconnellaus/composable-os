// customer.settings.* operations (stage 22, ADR 0402): whether customers sign up freely or only
// when invited, and how long staff have to action an erase request. Staff only. Changing them is
// admins only and humans only: no assistant, MCP client, automation or extension may open or close
// sign-up or give staff longer to erase someone.
import { z } from "zod";
import {
  CUSTOMER_ERASE_DUE_SETTING,
  CUSTOMER_SIGNUP_SETTING,
  customerSignupModeSchema,
  eraseDueDaysSchema,
  loadCustomerSignup,
  loadEraseDueDays,
} from "../customers/settings.ts";
import { ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const signup = customerSignupModeSchema.describe(
  "open: anyone who verifies an email address gets a customer account. invite_only (the " +
    "default): a sign-in code is sent only to an address staff invited or that has an account.",
);
const eraseDueDays = eraseDueDaysSchema.describe(
  "Days staff have to erase the person or decline, after a customer deletes their account " +
    "(default 30). Admins are notified daily about a request past it.",
);
const customerSettings = z.object({ signup, eraseDueDays });

async function load(ctx: HandlerContext) {
  return { signup: await loadCustomerSignup(ctx.db), eraseDueDays: await loadEraseDueDays(ctx.db) };
}

export const customerSettingsGet = defineOperation({
  name: "customer.settings.get",
  description:
    "Get the customer account settings: whether customer sign-up is open or invite only, and " +
    "how many days staff have to action a deleted account's erase request. Read-only.",
  input: z.object({}),
  output: customerSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return load(ctx);
  },
});

export const customerSettingsUpdate = defineOperation({
  name: "customer.settings.update",
  description:
    "Change whether customer sign-up is open or invite only, or the days staff have to action " +
    "an erase request. Only what you pass changes. Admins only, and only a human can call it: " +
    "AI assistants, MCP clients, automations and extensions are refused.",
  input: z.object({ signup: signup.optional(), eraseDueDays: eraseDueDays.optional() }),
  output: customerSettings.extend({ previous: customerSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.signup === undefined && input.eraseDueDays === undefined) {
      throw new ValidationError("Pass signup, eraseDueDays or both");
    }
    const previous = await load(ctx);
    const next = {
      signup: input.signup ?? previous.signup,
      eraseDueDays: input.eraseDueDays ?? previous.eraseDueDays,
    };
    const store = (key: string, field: "signup" | "eraseDueDays") => {
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
    if (input.eraseDueDays !== undefined) store(CUSTOMER_ERASE_DUE_SETTING, "eraseDueDays");
    return { ...next, previous };
  },
});

export const customerSettingsOperations = [customerSettingsGet, customerSettingsUpdate] as const;
