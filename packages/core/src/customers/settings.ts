// Who may sign up as a customer (stage 22, ADR 0402): a product setting, `open` or `invite_only`.
// The default is `invite_only`. Only a human admin changes it (customer.settings.update).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const CUSTOMER_SIGNUP_SETTING = "customer_signup";

/**
 * - `open`: anyone who verifies an address gets an account.
 * - `buyers` (ADR 0458): an address staff invited, one that has an account, or the buyer's
 *   address of an order a verified payment was applied to (`paid > 0`).
 * - `invite_only`: a code goes only to an address staff invited or one that has an account.
 */
export const CUSTOMER_SIGNUP_MODES = ["open", "buyers", "invite_only"] as const;
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

// --- When an erase request is due --------------------------------------------------------------

/** How many days staff have to action an erase request (me.deleteAccount). Default 30. */
export const CUSTOMER_ERASE_DUE_SETTING = "customer_erase_due_days";
export const DEFAULT_ERASE_DUE_DAYS = 30;
export const eraseDueDaysSchema = z.number().int().min(1).max(365);

/** The days an erase request has before it is due. A missing or unreadable setting is 30. */
export async function loadEraseDueDays(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", CUSTOMER_ERASE_DUE_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_ERASE_DUE_DAYS;
  try {
    const parsed = eraseDueDaysSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULT_ERASE_DUE_DAYS;
  } catch {
    return DEFAULT_ERASE_DUE_DAYS;
  }
}

// --- Which connection customer mail goes out from (stage 23) ------------------------------------

/**
 * The org email-send connection sign-in codes and other customer mail go out from, chosen by a
 * human admin (customer.settings.update). The host sends through it as itself (the system
 * user), never as a staff member. Unset: customer sign-in says it is not set up.
 */
export const CUSTOMER_EMAIL_CONNECTION_SETTING = "customer_email_connection";

/** The connection id, or null while none is chosen. */
export async function loadCustomerEmailConnection(
  db: Kysely<CoreDatabase>,
): Promise<string | null> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", CUSTOMER_EMAIL_CONNECTION_SETTING)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as unknown;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}
