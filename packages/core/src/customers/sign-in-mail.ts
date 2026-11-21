// The host's sign-in mail (ADR 0456): a customer's or a staff member's sign-in code, sent by the
// host itself through the connection chosen for the host's mail, as its own outbound kind.
//
// - The gatekeeper gives a send the sign-in kind only when the integration host says the call is
//   the host's sign-in mail (a queue only `callAsHost` with purpose `sign-in` opens) and the
//   message is exactly the fixed code template. Every other caller, and any other message, gets
//   the ordinary kind, which is reviewed.
// - The kind is auto-approvable, never auto-approved by default: a human admin turns it on, as for
//   any kind (outbound.setAutoApprove). Until the gate would apply it at once, sign-in by code says
//   it is not set up, and no code is made.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { evaluateGate, type GateFloor } from "../gate.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { type CallIntegration, resolveChannelTarget } from "../notifications/channels.ts";
import { loadApprovalPolicy } from "../settings.ts";
import { loadCustomerEmailConnection } from "./settings.ts";

/** The sign-in kind each email-sending vendor declares, by vendor. */
export const SIGN_IN_MAIL_KINDS: Readonly<Record<string, { tag: string; label: string }>> = {
  "email-send": { tag: "email.signin", label: "Send sign-in codes" },
  fake: { tag: "fake.signin", label: "Send sign-in codes" },
};

/** Who sends sign-in mail: the host, for a customer's code or a staff member's. */
export const SIGN_IN_MAIL_ORIGINS = ["system.customer-mail", "system.staff-mail"] as const;
export type SignInMailOrigin = (typeof SIGN_IN_MAIL_ORIGINS)[number];

export interface SignInMailState {
  /** The chosen connection's sign-in kind, or null when there is none to send through. */
  kind: { tag: string; label: string } | null;
  /** Whether a human admin let the kind apply without review. */
  autoApproved: boolean;
  /** Whether a code would go out at once now. */
  ready: boolean;
  /** Why not, in words an admin can act on; null when ready. */
  problem: string | null;
}

/**
 * Whether sign-in codes can go out now through the host's mail connection: chosen, able to send,
 * of a vendor with a sign-in kind, and that kind applying at once under the policy and the floor.
 */
export async function signInMailState(
  db: Kysely<CoreDatabase>,
  floor: GateFloor = {},
): Promise<SignInMailState> {
  const connectionId = await loadCustomerEmailConnection(db);
  if (!connectionId) {
    return {
      kind: null,
      autoApproved: false,
      ready: false,
      problem:
        "no email connection is chosen for the host's mail (an admin chooses it on Settings → Users)",
    };
  }
  const target = await resolveChannelTarget(db, "email", connectionId);
  if ("problem" in target)
    return { kind: null, autoApproved: false, ready: false, problem: target.problem };
  const connection = await db
    .selectFrom("core_integration_connection")
    .select("vendor")
    .where("id", "=", connectionId)
    .executeTakeFirst();
  const kind = connection ? (SIGN_IN_MAIL_KINDS[connection.vendor] ?? null) : null;
  if (!kind) {
    return {
      kind: null,
      autoApproved: false,
      ready: false,
      problem: "the host's mail connection cannot send sign-in codes (use an Email sending one)",
    };
  }
  const row = await db
    .selectFrom("core_outbound_kind")
    .select(["auto_approve", "auto_approvable"])
    .where("tag", "=", kind.tag)
    .executeTakeFirst();
  const enabled = row?.auto_approve === 1 && row.auto_approvable === 1;
  const policy = await loadApprovalPolicy(db);
  const gate = evaluateGate(
    { actor: "automation", risk: "outbound", outbound: { autoApprovable: true, enabled } },
    policy,
    floor,
  );
  if (gate.decision === "auto") return { kind, autoApproved: enabled, ready: true, problem: null };
  const problem = !enabled
    ? `sign-in codes would wait for review: an admin turns on "${kind.label}" (${kind.tag}) on ` +
      "Settings → Users, or its auto-approval on Settings → Integrations"
    : gate.policyDecision !== "auto"
      ? `sign-in codes would wait for review under the ${policy.preset} approval policy: ` +
        `"${kind.label}" applies without review only under Balanced`
      : "sign-in codes would wait for review: the deployment's approval floor (APPROVAL_FLOOR) " +
        "reviews automations' outbound sends";
  return { kind, autoApproved: enabled, ready: false, problem };
}

/** The statement that makes a vendor's sign-in kind known (auto-approvable, not auto-approved). */
export function signInKindStatement(db: Kysely<CoreDatabase>, vendor: string, now: string) {
  const kind = SIGN_IN_MAIL_KINDS[vendor];
  if (!kind) return null;
  return db
    .insertInto("core_outbound_kind")
    .values({
      tag: kind.tag,
      vendor,
      label: kind.label,
      auto_approvable: 1,
      auto_approve: 0,
      first_seen_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column("tag").doNothing());
}

/**
 * Sends sign-in mail as the host (ADR 0456): `callAsHost` with purpose `sign-in`, which only the
 * host's own code reaches. The integration host opens a queue that tells the gatekeeper so.
 */
export function signInMailCall(
  runtime: Pick<IntegrationRuntime, "callAsHost">,
  origin: SignInMailOrigin,
): CallIntegration {
  return async (input) => {
    if (!runtime.callAsHost) throw new Error("The integration host cannot send as the host");
    const result = await runtime.callAsHost({
      connectionId: input.connectionId,
      resource: input.resource,
      method: input.method,
      args: input.args,
      purpose: "sign-in",
      origin,
    });
    return { value: result.value, pending: result.pending, applied: result.applied };
  };
}
