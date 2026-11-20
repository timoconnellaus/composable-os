// Who may sign up as a customer (stage 22, ADR 0402): a product setting, `open` or `invite_only`.
// The default is `invite_only`. Only a human admin changes it (customer.settings.update).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const CUSTOMER_SIGNUP_SETTING = "customer_signup";

/**
 * - `open`: anyone who verifies an address gets an account.
 * - `invite_only`: a code goes only to an address staff invited or one that has an account.
 */
export const CUSTOMER_SIGNUP_MODES = ["open", "invite_only"] as const;
export type CustomerSignupMode = (typeof CUSTOMER_SIGNUP_MODES)[number];
export const customerSignupModeSchema = z.enum(CUSTOMER_SIGNUP_MODES);

export const DEFAULT_CUSTOMER_SIGNUP: CustomerSignupMode = "invite_only";

/** The sign-up mode. A missing or unreadable setting is `invite_only`, never `open`. */
export async function loadCustomerSignup(db: Kysely<CoreDatabase>): Promise<CustomerSignupMode> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", CUSTOMER_SIGNUP_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_CUSTOMER_SIGNUP;
  try {
    const parsed = customerSignupModeSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULT_CUSTOMER_SIGNUP;
  } catch {
    return DEFAULT_CUSTOMER_SIGNUP;
  }
}
