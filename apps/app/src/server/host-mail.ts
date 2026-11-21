// The host's own mail for staff (ADR 0455): staff sign-in codes and the invite notice. Both go
// through the email-send gatekeeper on the one connection a human admin chose for the host's mail
// (the customer mail setting, `customer.settings` `emailConnectionId`), called by the system user
// with actor `automation` (`hostMailCall`, origin `system.staff-mail`), never by a staff member.
import { identityProviderKind, type StaffCodes } from "@composable-os/auth";
import {
  customerCodeTarget,
  type HostMail,
  hostMailCall,
  STAFF_MAIL_ORIGIN,
  sendEmail,
  staffCodeEmail,
  staffInviteEmail,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { integrationRuntimeFor } from "./integrations.ts";
import type { OperationsEnv } from "./operations.ts";

type MailEnv = OperationsEnv & { IDENTITY_PROVIDER?: string };

/** Where the host's mail goes out from and how to call it, or why it cannot go out. */
async function mailRoute(env: MailEnv, reason: string) {
  const target = await customerCodeTarget(createCrmDb(env.DB).query);
  if ("problem" in target) return { problem: target.problem } as const;
  const runtime = integrationRuntimeFor(env);
  if (!runtime) return { problem: "the integration host is not bound" } as const;
  return { target: target.target, call: hostMailCall(runtime, reason, STAFF_MAIL_ORIGIN) } as const;
}

/** Staff sign-in codes for this env (packages/auth asks for them by env). */
export function staffCodesFor(env: MailEnv): StaffCodes {
  return {
    async ready() {
      const route = await mailRoute(env, "Checking the host's mail");
      if ("problem" in route) return route.problem ?? "the host cannot send mail";
      return null;
    },
    async send({ to, code }) {
      const route = await mailRoute(env, "A staff member asked for a sign-in code");
      if ("problem" in route) throw new Error(route.problem);
      const outcome = await sendEmail(route.call, route.target, {
        to,
        ...staffCodeEmail(productName(product), code),
      });
      // A code that waits for an admin's review is no use.
      if (outcome.status !== "sent") throw new Error("The sign-in code was queued, not sent");
    },
  };
}

/** The host's mail as a staff call sees it: the invite notice, with where to sign in. */
export function hostMailFor(env: MailEnv, appOrigin: string | undefined): HostMail {
  const staffSignIn = identityProviderKind(env) === "cloudflare-access" ? "access" : "code";
  return {
    staffSignIn,
    async sendStaffInvite({ to, invitedBy }) {
      try {
        const route = await mailRoute(env, `${invitedBy} invited a staff member`);
        if ("problem" in route || !appOrigin) return "not_sent";
        const outcome = await sendEmail(route.call, route.target, {
          to,
          ...staffInviteEmail(productName(product), invitedBy, `${appOrigin}/sign-in`),
        });
        return outcome.status === "sent" ? "sent" : "not_sent";
      } catch (error) {
        console.error("invite email not sent", error instanceof Error ? error.message : error);
        return "not_sent";
      }
    },
  };
}
