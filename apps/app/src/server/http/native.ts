// Native staff sign-in through the system browser (ADRs 0455, 0457), for an app or a command-line
// tool whose staff sign in through a browser (Google, Cloudflare Access, or the host's own page).
// A staff page: behind Access, and with Better Auth a signed-out browser is sent to /sign-in
// first. The browser's cookie stays the browser's; the app never sees one.
//
// 1. GET checks the request (a listed redirect address, an S256 challenge, a state) and, signed
//    in, shows a confirm page: which account, and where the code will go. It issues nothing.
// 2. The person presses Continue: a POST from this page (same origin, checked), carrying the
//    page's one-time token, bound to the account and the request's parameters. Only then is the
//    handoff code issued and the browser sent to the redirect address with it.
// So a link someone else made (with their own challenge, to their own app) cannot take a code
// from a signed-in browser without the person seeing where it goes and agreeing (issue #165).
import {
  issueNativeHandoff,
  issueSignInConfirmation,
  nativeRedirectAllowed,
  parseNativeRedirects,
  redeemSignInConfirmation,
  resolveActingUser,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { escapeHtml } from "../html.ts";
import { authorize } from "../identity.ts";
import type { ApiEnv } from "./api.ts";

export const NATIVE_STAFF_SIGN_IN_PATH = "/native/staff-sign-in";

export interface NativeEnv extends ApiEnv {
  /** The app redirect addresses a code may be sent to, exactly, comma separated. */
  NATIVE_REDIRECT_URIS?: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every answer of this page: never cached, never framed, nothing sent on. */
const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const;

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...PAGE_HEADERS },
  });
}

interface SignInRequest {
  redirectUri: string;
  challenge: string;
  state: string;
}

/** The request's parameters, or null when they are not a valid sign-in request. */
function parseRequest(params: URLSearchParams, allowed: readonly string[]): SignInRequest | null {
  const redirectUri = params.get("redirect_uri") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  // Never redirected to when wrong: a code goes only to an address the deployment lists.
  if (
    !nativeRedirectAllowed(allowed, redirectUri) ||
    params.get("code_challenge_method") !== "S256" ||
    !CHALLENGE_RE.test(challenge) ||
    !state ||
    state.length > 200
  ) {
    return null;
  }
  return { redirectUri, challenge, state };
}

/** Where the code will go, in words: an app by its scheme, or a tool on this computer. */
export function destinationOf(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "a command-line tool on this computer (such as cos content import)";
  }
  return `the app that opens ${url.protocol}// links`;
}

/**
 * A POST that this page's own form made (ADR 0457, amended). An Origin that names a site must be
 * the host's own. An Origin of `null` names none (a browser sends it when a page's referrer policy
 * withholds the origin, or from a sandboxed frame or a file), so it proves nothing on its own:
 * then, as with no Origin at all, only `Sec-Fetch-Site: same-origin` passes, a header a page
 * cannot set. Anything else is refused. The page's one-time token is the real protection; this
 * keeps a cross-site form from even spending it.
 */
export function sameOrigin(request: Request): boolean {
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin === own;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** The signed-in staff account, or a response refusing the request. */
async function signedInAccount(
  request: Request,
  env: NativeEnv,
): Promise<{ userId: string; name: string; email: string } | Response> {
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
    .select(["name", "email", "support_grant_id"])
    .where("id", "=", userId)
    .executeTakeFirst();
  // A support user's access is the host's support grant, never a phone's session.
  if (!row || row.support_grant_id) return refuse(403, "This account cannot sign in to the app");
  return { userId, name: row.name, email: row.email };
}

function confirmPage(
  account: { name: string; email: string },
  asked: SignInRequest,
  token: string,
): Response {
  const label = escapeHtml(productName(product));
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to ${label}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:1px solid #333;background:#111;color:#fff;cursor:pointer}
.where{padding:.75rem;border:1px solid #ccc;border-radius:.375rem}</style></head>
<body><h1>Sign in to ${label}?</h1>
<p>You are signed in as <strong>${escapeHtml(account.name)}</strong> (${escapeHtml(account.email)}).</p>
<p class="where">A sign-in for this account will go to ${escapeHtml(destinationOf(asked.redirectUri))}.</p>
<p>Continue only if you started signing in there just now. If you did not, close this page.</p>
<form method="post" action="${NATIVE_STAFF_SIGN_IN_PATH}">
${hidden("redirect_uri", asked.redirectUri)}${hidden("code_challenge", asked.challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", asked.state)}${hidden("confirm", token)}
<button type="submit">Continue</button></form></body></html>`;
  // The form posts here, and the answer redirects to the app: a browser holds a form's
  // redirects to form-action too, so the app's own address is allowed, and nothing else.
  const target = new URL(asked.redirectUri);
  const formTarget = target.protocol === "http:" ? target.origin : target.protocol;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...PAGE_HEADERS,
      // The page's own form then sends its real Origin, in browsers without Fetch metadata too;
      // nothing goes to another site (the redirect with the code is sent with no referrer).
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTarget}; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

export async function handleNativeStaffSignIn(request: Request, env: NativeEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return refuse(405, "Use GET");
  const allowed = parseNativeRedirects(env.NATIVE_REDIRECT_URIS);
  if (!allowed.length) return refuse(404, "Not found");
  const invalid = () =>
    refuse(400, "This sign-in link is not valid. Start signing in from the app again.");

  if (request.method === "GET") {
    const asked = parseRequest(new URL(request.url).searchParams, allowed);
    if (!asked) return invalid();
    const account = await signedInAccount(request, env);
    if (account instanceof Response) return account;
    // Nothing is issued here: the page asks first.
    const token = await issueSignInConfirmation(
      createCrmDb(env.DB),
      { userId: account.userId, ...asked },
      new Date(),
    );
    return confirmPage(account, asked, token);
  }

  // The confirmed POST: from this page only, for this account and exactly these parameters.
  if (!sameOrigin(request)) return refuse(403, "This sign-in was not confirmed on this page");
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return invalid();
  const text = await request.text();
  if (text.length > 4000) return invalid();
  const form = new URLSearchParams(text);
  const asked = parseRequest(form, allowed);
  if (!asked) return invalid();
  const account = await signedInAccount(request, env);
  if (account instanceof Response) return account;
  const db = createCrmDb(env.DB);
  const now = new Date();
  const confirmed = await redeemSignInConfirmation(
    db,
    form.get("confirm") ?? "",
    { userId: account.userId, ...asked },
    now,
  );
  if (!confirmed) {
    return refuse(
      403,
      "This sign-in was not confirmed, or the page was open too long. Start again.",
    );
  }
  const code = await issueNativeHandoff(
    db,
    { userId: account.userId, challenge: asked.challenge, redirectUri: asked.redirectUri },
    now,
  );
  const target = new URL(asked.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", asked.state);
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), ...PAGE_HEADERS },
  });
}
