// The host's own mail (ADRs 0419, 0455, 0456), on the one connection a human admin chose for it
// (`customer.settings` `emailConnectionId`), sent by the system user, never by a staff member.
//
// - Sign-in codes, staff and customer: `signInMailCall`, the host's `callAsHost` with purpose
//   `sign-in`, so the gatekeeper gives the send its sign-in kind. They are ready only while that
//   kind applies at once (`signInMailState`); otherwise sign-in by code says it is not set up.
// - The invite notice: an ordinary send (`hostMailCall`, origin `system.staff-mail`). It holds no
//   secret, may wait for review, and never holds back a code (the sign-in kind is independent).
import { identityProviderKind, type StaffCodes } from "@composable-os/auth";
import {
  CUSTOMER_MAIL_ORIGIN,
  customerCodeTarget,
  type HostMail,
  hostMailCall,
  parseFloor,
  STAFF_MAIL_ORIGIN,
  sendCustomerCode,
  sendEmail,
  signInMailCall,
  signInMailState,
  staffCodeEmail,
  staffInviteEmail,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { integrationRuntimeFor } from "./integrations.ts";
import type { OperationsEnv } from "./operations.ts";

type MailEnv = OperationsEnv & { IDENTITY_PROVIDER?: string };

/** Null when sign-in codes go out at once now, or why not, for an admin to act on. */
export async function signInMailProblem(env: MailEnv): Promise<string | null> {
  if (!integrationRuntimeFor(env)) return "the integration host is not bound";
  const state = await signInMailState(createCrmDb(env.DB).query, parseFloor(env.APPROVAL_FLOOR));
  return state.problem;
}

/** Sends one sign-in code as the host, for a customer or a staff member. Throws unless sent. */
export async function sendSignInCode(
  env: MailEnv,
  audience: "customer" | "staff",
  message: { to: string; code: string },
): Promise<void> {
  const target = await customerCodeTarget(createCrmDb(env.DB).query);
  if ("problem" in target) throw new Error(target.problem);
  const runtime = integrationRuntimeFor(env);
  if (!runtime) throw new Error("The integration host is not bound");
  const call = signInMailCall(
    runtime,
    audience === "customer" ? CUSTOMER_MAIL_ORIGIN.automationId : STAFF_MAIL_ORIGIN.automationId,
  );
  if (audience === "customer") {
    // Throws when the send was queued or failed: the code is then deleted (ADR 0455).
    await sendCustomerCode(call, target.target, message);
    return;
  }
  const outcome = await sendEmail(call, target.target, {
    to: message.to,
    ...staffCodeEmail(productName(product), message.code),
  });
  if (outcome.status !== "sent") throw new Error("The sign-in code was queued, not sent");
}

/** Staff sign-in codes for this env (packages/auth asks for them by env). */
export function staffCodesFor(env: MailEnv): StaffCodes {
  return {
    ready: () => signInMailProblem(env),
    send: (message) => sendSignInCode(env, "staff", message),
  };
}

/** The host's mail as a staff call sees it: the invite notice, with where to sign in. */
export function hostMailFor(env: MailEnv, appOrigin: string | undefined): HostMail {
  const staffSignIn = identityProviderKind(env) === "cloudflare-access" ? "access" : "code";
  return {
    staffSignIn,
    async sendStaffInvite({ to, invitedBy }) {
      try {
        const target = await customerCodeTarget(createCrmDb(env.DB).query);
        const runtime = integrationRuntimeFor(env);
        if ("problem" in target || !runtime || !appOrigin) return "not_sent";
        const call = hostMailCall(
          runtime,
          `${invitedBy} invited a staff member`,
          STAFF_MAIL_ORIGIN,
        );
        const outcome = await sendEmail(call, target.target, {
          to,
          ...staffInviteEmail(productName(product), invitedBy, `${appOrigin}/sign-in`),
        });
        return outcome.status === "sent" ? "sent" : "pending";
      } catch (error) {
        console.error("invite email not sent", error instanceof Error ? error.message : error);
        return "not_sent";
      }
    },
  };
}
