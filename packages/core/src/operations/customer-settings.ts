// customer.settings.* operations (stage 22, ADR 0402): whether customers sign up freely or only
// when invited. Staff only. Changing it is admins only and humans only: no assistant, MCP client,
// automation or extension may open or close sign-up.
import { z } from "zod";
import {
  CUSTOMER_SIGNUP_SETTING,
  customerSignupModeSchema,
  loadCustomerSignup,
} from "../customers/settings.ts";
import { defineOperation } from "../operation.ts";

const customerSettings = z.object({
  signup: customerSignupModeSchema.describe(
    "open: anyone who verifies an email address gets a customer account. invite_only (the " +
      "default): a sign-in code is sent only to an address staff invited or that has an account.",
  ),
});

export const customerSettingsGet = defineOperation({
  name: "customer.settings.get",
  description:
    "Get the customer account settings: whether customer sign-up is open or invite only. Read-only.",
  input: z.object({}),
  output: customerSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return { signup: await loadCustomerSignup(ctx.db) };
  },
});

export const customerSettingsUpdate = defineOperation({
  name: "customer.settings.update",
  description:
    "Change whether customer sign-up is open or invite only. Admins only, and only a human can " +
    "call it: AI assistants, MCP clients, automations and extensions are refused.",
  input: customerSettings,
  output: customerSettings.extend({ previous: customerSignupModeSchema }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const previous = await loadCustomerSignup(ctx.db);
    const value = JSON.stringify(input.signup);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: CUSTOMER_SIGNUP_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: CUSTOMER_SIGNUP_SETTING,
      action: "update",
      before: { signup: previous },
      after: { signup: input.signup },
    });
    return { signup: input.signup, previous };
  },
});

export const customerSettingsOperations = [customerSettingsGet, customerSettingsUpdate] as const;
