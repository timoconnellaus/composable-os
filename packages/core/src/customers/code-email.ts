// The customer sign-in code email (stage 22, ADR 0402). It goes out through the email-send
// gatekeeper, as one `send` on the connection customer.settings names (stage 23), the same
// path notification emails take (`sendEmail`, ADR 0172). There is no direct outbound.
import type { CoreDatabase } from "@composable-os/db";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import type { Kysely } from "kysely";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import {
  type CallIntegration,
  type ChannelTarget,
  resolveChannelTarget,
  sendEmail,
} from "../notifications/channels.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadCustomerEmailConnection } from "./settings.ts";

/** The subject and text of a sign-in code email. Plain text; the code is the only variable. */
export function customerCodeEmail(code: string): { subject: string; text: string } {
  const name = productName(product);
  return {
    // Not in the subject: a subject is kept in the audit log as the send's title (ADR 0455).
    subject: `Your ${name} sign-in code`,
    text:
      `Your sign-in code for ${name} is ${code}.\n\n` +
      "It works once and expires in five minutes. If you did not ask for it, ignore this email.",
  };
}

/**
 * Where customer mail (sign-in codes, a declined erase request) is sent from: the connection
 * customer.settings names (stage 23), or why there is none.
 */
export async function customerCodeTarget(
  db: Kysely<CoreDatabase>,
): Promise<{ target: ChannelTarget } | { problem: string }> {
  const connectionId = await loadCustomerEmailConnection(db);
  if (!connectionId) {
    return {
      problem:
        "no email connection is chosen for customer mail (an admin sets it in the customer settings)",
    };
  }
  return resolveChannelTarget(db, "email", connectionId);
}

/** The system's own caller for customer mail: the host sends it, not a staff member. */
export const CUSTOMER_MAIL_ORIGIN = {
  surface: "system",
  automationId: "system.customer-mail",
} as const;

/** The system's own caller for staff mail (ADR 0455): invite notices and staff sign-in codes. */
export const STAFF_MAIL_ORIGIN = {
  surface: "system",
  automationId: "system.staff-mail",
} as const;

/**
 * Calls the integration host as the host itself (ADR 0419): the system user with actor
 * `automation`, never a staff member. For customer mail only; cos-runner's integration host
 * accepts the system user, which has no core_user row.
 */
export function hostMailCall(
  runtime: Pick<IntegrationRuntime, "call">,
  reason = "A customer asked for a sign-in code",
  origin: { surface: "system"; automationId: string } = CUSTOMER_MAIL_ORIGIN,
): CallIntegration {
  return async (input) => {
    const result = await runtime.call({
      ...input,
      caller: {
        actor: "automation",
        userId: SYSTEM_USER.id,
        userName: SYSTEM_USER.name,
        role: SYSTEM_USER.role,
        origin: { ...origin },
        reason,
      },
    });
    return { value: result.value, pending: result.pending, applied: result.applied };
  };
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

/** The email telling a person that staff declined to erase them, with the reason. Plain text. */
export function eraseDeclinedEmail(reason: string): { subject: string; text: string } {
  const name = productName(product);
  return {
    subject: `Your ${name} erasure request`,
    text:
      `You deleted your ${name} account and asked for your personal data to be erased. ` +
      "We cannot erase all of it, because we must keep a record of it:\n\n" +
      `${reason}\n\n` +
      "Your account stays closed. Reply to this email if you have a question.",
  };
}

/**
 * Sends one email to a customer through the email-send gatekeeper (the org's notification email
 * connection). A send the approval gate queued for review is `pending`, not an error: it goes
 * out when someone approves it.
 */
export async function sendCustomerEmail(
  call: CallIntegration,
  target: ChannelTarget,
  message: { to: string; subject: string; text: string },
): Promise<"sent" | "pending"> {
  const outcome = await sendEmail(call, target, message);
  return outcome.status === "sent" ? "sent" : "pending";
}
