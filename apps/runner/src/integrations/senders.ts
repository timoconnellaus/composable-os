// Email sending per client (stage 66; ADR 0616, "Email sending per client"): on a host of many
// clients the email-send gatekeeper sends a client's mail only from that client's verified sender
// domains. The host gives them with every bind, send and apply, read here from the client's own
// environment (`COS_SENDER_DOMAINS`, built by the directory from the registry), never from a
// caller: the integration host that asks is the client's own object, so `env` is that client's.
import { clientOf } from "@composable-os/db/client-environment";

/** The vendor whose sends carry the client's sender domains. */
export const EMAIL_SEND_VENDOR = "email-send";

/**
 * The client's verified sender domains on a host of many clients (empty when it has none), or null
 * on a single-client deployment, whose gatekeeper reads its own ALLOWED_SENDER_DOMAINS as before.
 */
export function clientSenderDomains<E extends object>(
  env: E & { COS_SENDER_DOMAINS?: unknown },
): string[] | null {
  if (clientOf(env) === null) return null;
  const value = env.COS_SENDER_DOMAINS;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((domain) => domain.trim())
    .filter((domain) => domain !== "");
}

/** What the host passes the email-send account and facet for `vendor`, or null: none needed. */
export function senderOptions(env: object, vendor: string): { senderDomains: string[] } | null {
  if (vendor !== EMAIL_SEND_VENDOR) return null;
  const domains = clientSenderDomains(env);
  return domains === null ? null : { senderDomains: domains };
}
