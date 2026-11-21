// Native staff sign-in through the system browser (ADR 0455), for staff whose sign-in is
// browser-based (Google, Cloudflare Access). A staff page: behind Access, and with Better Auth a
// signed-out browser is sent to /sign-in first. Signed in, it hands the app a one-time code on
// its own redirect address, which the app exchanges with its PKCE verifier at
// /api/v1/auth/staff/exchange. The browser's cookie stays the browser's; the app never sees one.
import {
  issueNativeHandoff,
  nativeRedirectAllowed,
  parseNativeRedirects,
  resolveActingUser,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { authorize } from "../identity.ts";
import type { ApiEnv } from "./api.ts";

export const NATIVE_STAFF_SIGN_IN_PATH = "/native/staff-sign-in";

export interface NativeEnv extends ApiEnv {
  /** The app redirect addresses a code may be sent to, exactly, comma separated. */
  NATIVE_REDIRECT_URIS?: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleNativeStaffSignIn(request: Request, env: NativeEnv): Promise<Response> {
  if (request.method !== "GET") return refuse(405, "Use GET");
  const allowed = parseNativeRedirects(env.NATIVE_REDIRECT_URIS);
  if (!allowed.length) return refuse(404, "Not found");
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  // Checked before anything else, and never redirected to when wrong: a code goes only to an
  // address the deployment lists.
  if (
    !nativeRedirectAllowed(allowed, redirectUri) ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !CHALLENGE_RE.test(challenge) ||
    !state ||
    state.length > 200
  ) {
    return refuse(400, "This sign-in link is not valid. Start signing in from the app again.");
  }
  const result = await authorize(request, env, { handlerType: "router" });
  if (!result.ok) return result.response;
  if (!result.principal) return refuse(401, "Sign in first");
  const db = createCrmDb(env.DB);
  let userId: string;
  try {
    // Under Access a first visit makes the account (and accepts its invite), as any page does.
    userId = (await resolveActingUser(db, result.principal)).id;
  } catch {
    return refuse(403, "This account cannot sign in to the app");
  }
  const row = await db.query
    .selectFrom("core_user")
    .select("support_grant_id")
    .where("id", "=", userId)
    .executeTakeFirst();
  // A support user's access is the host's support grant, never a phone's session.
  if (!row || row.support_grant_id) return refuse(403, "This account cannot sign in to the app");
  const code = await issueNativeHandoff(db, { userId, challenge, redirectUri }, new Date());
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
