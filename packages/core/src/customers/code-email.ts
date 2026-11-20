// The customer sign-in code email (stage 22, ADR 0402). It goes out through the email-send
// gatekeeper, as one `send` on the org's email connection (Settings → Notifications), the same
// path notification emails take (`sendEmail`, ADR 0172). There is no direct outbound.
import type { CoreDatabase } from "@composable-os/db";
import { product } from "@composable-os/products/active";
import type { Kysely } from "kysely";
import {
  type CallIntegration,
  type ChannelTarget,
  resolveChannelTarget,
  sendEmail,
} from "../notifications/channels.ts";
import { loadDeliverySettings } from "../notifications/preferences.ts";

/** The subject and text of a sign-in code email. Plain text; the code is the only variable. */
export function customerCodeEmail(code: string): { subject: string; text: string } {
  const name = product.strings.name;
  return {
    subject: `Your ${name} sign-in code: ${code}`,
    text:
      `Your sign-in code for ${name} is ${code}.\n\n` +
      "It works once and expires in five minutes. If you did not ask for it, ignore this email.",
  };
}

/** Where codes are sent from: the org's email connection, or why there is none. */
export async function customerCodeTarget(
  db: Kysely<CoreDatabase>,
): Promise<{ target: ChannelTarget } | { problem: string }> {
  const settings = await loadDeliverySettings(db);
  if (!settings.email) return { problem: "No email connection is set for notifications" };
  return resolveChannelTarget(db, "email", settings.email);
}

/**
 * Sends a sign-in code through the email-send gatekeeper. A send the approval gate queued for
 * review is a failure here: a code that waits for an admin is no use.
 */
export async function sendCustomerCode(
  call: CallIntegration,
  target: ChannelTarget,
  message: { to: string; code: string },
): Promise<void> {
  const outcome = await sendEmail(call, target, {
    to: message.to,
    ...customerCodeEmail(message.code),
  });
  if (outcome.status !== "sent") {
    throw new Error(
      "The sign-in code was queued for review, not sent: allow the email connection's " +
        "outbound sends to apply without review",
    );
  }
}
