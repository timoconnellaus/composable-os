// The deployment-to-control-plane channel (ADR 0250). A hosted deployment asks the control plane
// to do the few things it cannot do itself, today only setting or removing an AI secret on its
// own tenant Workers (the customer's own provider keys and their own AI Gateway, ADR 0213
// amendment). The control plane → deployment direction is the support-session JWT (ADR 0212);
// this is the reverse, so a deployment cannot hold a signing key the control plane trusts for
// every tenant. Instead each tenant has its own key:
//
//   COS_CONTROL_KEY = base64url(HMAC-SHA256(CONTROL_CHANNEL_SECRET, "cos-deployment-channel:" + tenant))
//
// derived by the control plane from one master secret (so nothing per tenant is stored) and set
// as a secret on the tenant's app Worker at provisioning. A request carries
//
//   x-cos-tenant     the tenant id
//   x-cos-timestamp  unix seconds; refused when more than 5 minutes off
//   x-cos-signature  v1=<hex HMAC-SHA256(COS_CONTROL_KEY, "v1\n<tenant>\n<timestamp>\n<METHOD>\n<path>\n<sha256 hex of body>")>
//
// over HTTPS. A captured request can be replayed only within its 5 minutes, only for the same
// tenant and only with the same body, and every operation on this channel is idempotent (set
// this secret to this value), so a replay changes nothing. Shared here because both ends depend on
// this package: the deployment signs (@composable-os/core), the control plane verifies.

import { sameDigest, sha256Hex, toBase64, toHex } from "./hash.ts";

export const CONTROL_KEY_SECRET = "COS_CONTROL_KEY";
export const CONTROL_URL_VAR = "COS_CONTROL_URL";
export const TENANT_ID_VAR = "COS_TENANT_ID";
/** The path the control plane serves the AI secret call on. */
export const AI_SECRET_PATH = "/api/deployment/ai-secret";
export const CHANNEL_MAX_SKEW_SECONDS = 300;

/**
 * Secrets a deployment may ask the control plane to set or remove on its own Workers: provider
 * keys (`AI_KEY_<PROVIDER>`, ADR 0151), the customer's own AI Gateway, and the customer's own
 * TypeSafe key for the judge (`TYPESAFE_API_KEY`, ADR 0232, ADR 0234). Nothing else: never
 * BETTER_AUTH_SECRET, the platform token or the channel key itself.
 */
export const CUSTOMER_GATEWAY_SECRET = "AI_CUSTOMER_GATEWAY";
export const CUSTOMER_JUDGE_SECRET = "TYPESAFE_API_KEY";
export function isCustomerAiSecret(name: string): boolean {
  return (
    /^AI_KEY_[A-Z0-9_]{1,32}$/.test(name) ||
    name === CUSTOMER_GATEWAY_SECRET ||
    name === CUSTOMER_JUDGE_SECRET
  );
}

/** The body of an AI secret call. `value` is absent when removing the secret. */
export interface AiSecretRequest {
  name: string;
  value?: string;
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  return toBase64(new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(message));
}

/** A tenant's channel key, derived from the control plane's master secret. */
export async function deploymentChannelKey(masterSecret: string, tenant: string): Promise<string> {
  if (!masterSecret) throw new Error("the deployment channel needs CONTROL_CHANNEL_SECRET");
  return base64url(await hmac(masterSecret, `cos-deployment-channel:${tenant}`));
}

async function signature(
  key: string,
  parts: { tenant: string; timestamp: string; method: string; path: string; body: string },
): Promise<string> {
  const bodyHash = await sha256Hex(parts.body);
  const message = [
    "v1",
    parts.tenant,
    parts.timestamp,
    parts.method.toUpperCase(),
    parts.path,
    bodyHash,
  ].join("\n");
  return `v1=${toHex(new Uint8Array(await hmac(key, message)))}`;
}

/** The headers for one signed request from a deployment. */
export async function signDeploymentRequest(input: {
  key: string;
  tenant: string;
  method: string;
  path: string;
  body: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  return {
    "x-cos-tenant": input.tenant,
    "x-cos-timestamp": timestamp,
    "x-cos-signature": await signature(input.key, { ...input, timestamp }),
  };
}

const TENANT = /^t[a-z0-9]{9}$/;

/**
 * Verifies a signed request. `keyFor` returns the tenant's channel key (or null for an unknown
 * tenant). Returns the tenant and the body text, or why it was refused.
 */
export async function verifyDeploymentRequest(
  request: Request,
  keyFor: (tenant: string) => Promise<string | null>,
  options: { now?: Date } = {},
): Promise<{ ok: true; tenant: string; body: string } | { ok: false; reason: string }> {
  const tenant = request.headers.get("x-cos-tenant") ?? "";
  const timestamp = request.headers.get("x-cos-timestamp") ?? "";
  const given = request.headers.get("x-cos-signature") ?? "";
  if (!TENANT.test(tenant) || !/^\d{1,12}$/.test(timestamp) || !given.startsWith("v1=")) {
    return { ok: false, reason: "unsigned request" };
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > CHANNEL_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale request" };
  }
  const key = await keyFor(tenant);
  if (!key) return { ok: false, reason: "unknown tenant" };
  const body = await request.text();
  const expected = await signature(key, {
    tenant,
    timestamp,
    method: request.method,
    path: new URL(request.url).pathname,
    body,
  });
  if (!sameDigest(expected, given)) return { ok: false, reason: "bad signature" };
  return { ok: true, tenant, body };
}
