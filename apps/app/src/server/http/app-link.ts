// Native staff sign-in (ADR 0451): a staff member signs in to a company's mobile app in the
// system browser, at the host, with whatever identity provider the deployment uses, and the app
// exchanges that sign-in for a staff device session (ADR 0419).
//
//   1. The app opens GET /api/v1/auth/app-link?redirect_uri&state&code_challenge&device_name in
//      the system browser. Not signed in: the host's own sign-in, then back here. Signed in: a
//      page that names the account and the device and asks to confirm.
//   2. Confirming POSTs the same form back (same origin only). The host answers 303 to
//      redirect_uri with a code and the app's state. The code is signed by the host, says who
//      and which device, lasts two minutes, and is bound to the redirect and to the app's PKCE
//      challenge (S256).
//   3. The app POSTs /api/v1/auth/token { code, codeVerifier, redirectUri } with no cookie: the
//      host checks the signature, the time, the redirect and the verifier, and issues the staff
//      device session. The token is the account's: a pack role (ADR 0436) still holds it to the
//      role's operations, on every call.
//
// A redirect must be one the deployment lists (STAFF_APP_REDIRECTS, set by cos deploy from
// product.ts): a code is never sent anywhere else, so a link someone else crafted cannot take a
// staff member's sign-in to another app or site.
import type { Principal } from "@composable-os/auth";
import { ForbiddenError, issueDeviceSession, ValidationError } from "@composable-os/core";
import type { CrmDb } from "@composable-os/db";

export const APP_LINK_ROUTE = "/auth/app-link";
/** How long a code may wait between the browser and the app's exchange. */
export const APP_LINK_CODE_MS = 120_000;

export interface AppLinkEnv {
  BETTER_AUTH_SECRET?: string;
  /** The redirect URIs a staff app sign-in may return to, comma separated (`gym://staff-sign-in`). */
  STAFF_APP_REDIRECTS?: string;
}

interface CodeClaims {
  /** The staff user. */
  u: string;
  /** The PKCE challenge: base64url(SHA-256(verifier)). */
  c: string;
  /** The redirect URI the code was sent to. */
  r: string;
  /** The device's name. */
  d: string;
  /** Expiry, ms since the epoch. */
  e: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function key(env: AppLinkEnv): Promise<CryptoKey> {
  if (!env.BETTER_AUTH_SECRET) {
    throw new ForbiddenError("Staff app sign-in is not set up on this deployment", {
      httpStatus: 503,
    });
  }
  // A key of its own, derived from the staff secret: a code is never a session token.
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode("cos.staff-app-link.v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** The redirects this deployment allows. */
export function allowedRedirects(env: AppLinkEnv): string[] {
  return (env.STAFF_APP_REDIRECTS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/** base64url(SHA-256(verifier)): PKCE's S256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

async function signCode(env: AppLinkEnv, claims: CodeClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

const invalid = () =>
  new ForbiddenError("This sign-in link is not valid: sign in again", {
    reason: "code_invalid",
    httpStatus: 401,
  });

async function readCode(env: AppLinkEnv, code: string, now: Date): Promise<CodeClaims> {
  const [body, mac] = code.split(".");
  if (!body || !mac || code.length > 2000) throw invalid();
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(env), fromB64url(mac), enc.encode(body));
  } catch (error) {
    if (error instanceof ForbiddenError) throw error;
    ok = false;
  }
  if (!ok) throw invalid();
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as CodeClaims;
  if (typeof claims.e !== "number" || claims.e < now.getTime()) {
    throw new ForbiddenError("This sign-in took too long: sign in again", {
      reason: "code_expired",
      httpStatus: 401,
    });
  }
  return claims;
}

interface LinkParams {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  deviceName: string;
}

function params(get: (name: string) => string | null, env: AppLinkEnv): LinkParams {
  const redirectUri = get("redirect_uri") ?? "";
  const state = get("state") ?? "";
  const codeChallenge = get("code_challenge") ?? "";
  const deviceName = (get("device_name") ?? "").trim();
  if (!allowedRedirects(env).includes(redirectUri)) {
    throw new ValidationError("This app is not one this deployment signs staff in to", {
      field: "redirect_uri",
    });
  }
  if (get("code_challenge_method") && get("code_challenge_method") !== "S256") {
    throw new ValidationError("code_challenge_method is S256", { field: "code_challenge_method" });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new ValidationError("code_challenge is base64url(SHA-256(verifier))", {
      field: "code_challenge",
    });
  }
  if (!state || state.length > 200)
    throw new ValidationError("state is required", { field: "state" });
  if (!deviceName || deviceName.length > 100) {
    throw new ValidationError("device_name is the device's name, 1 to 100 characters", {
      field: "device_name",
    });
  }
  return { redirectUri, state, codeChallenge, deviceName };
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

function page(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to the app</title></head><body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem">${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Never framed: the confirmation is a click that signs an app in.
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}

export interface AppLinkDeps {
  /** The staff session this browser request carries, if any. */
  staff: (request: Request) => Promise<Principal | null>;
  /** The staff user's id and name for a principal (refused when deactivated). */
  user: (principal: Principal) => Promise<{ id: string; name: string; email: string }>;
  /** Where staff sign in on this deployment, if it has a page (Better Auth's); else none. */
  signInPath?: string | null | undefined;
  now?: () => Date;
}

/** GET shows the confirmation; POST (same origin) sends the code to the app. */
export async function handleAppLink(
  request: Request,
  env: AppLinkEnv,
  deps: AppLinkDeps,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      const link = params((n) => url.searchParams.get(n), env);
      const principal = await deps.staff(request);
      if (!principal) {
        if (!deps.signInPath) return page(401, "<p>Sign in to this deployment first.</p>");
        const target = new URL(deps.signInPath, url);
        target.searchParams.set("redirect", url.pathname + url.search);
        return Response.redirect(target.toString(), 302);
      }
      const user = await deps.user(principal);
      const hidden = Object.entries({
        redirect_uri: link.redirectUri,
        state: link.state,
        code_challenge: link.codeChallenge,
        device_name: link.deviceName,
      })
        .map(([n, v]) => `<input type="hidden" name="${n}" value="${escape(v)}">`)
        .join("");
      return page(
        200,
        `<h1 style="font-size: 1.25rem">Sign in to the app on ${escape(link.deviceName)}?</h1><p>As ${escape(user.name || user.email)} (${escape(user.email)}). The app gets its own session, which you can end from your account.</p><form method="post">${hidden}<button type="submit">Sign in to the app</button></form>`,
      );
    }
    if (request.method === "POST") {
      // A cross-site form cannot confirm for someone: same origin only.
      if (request.headers.get("origin") !== url.origin) {
        throw new ForbiddenError("Confirm from this deployment's own page");
      }
      const form = await request.formData();
      const link = params((n) => {
        const v = form.get(n);
        return typeof v === "string" ? v : null;
      }, env);
      const principal = await deps.staff(request);
      if (!principal) throw new ForbiddenError("Sign in first", { httpStatus: 401 });
      const user = await deps.user(principal);
      const now = deps.now?.() ?? new Date();
      const code = await signCode(env, {
        u: user.id,
        c: link.codeChallenge,
        r: link.redirectUri,
        d: link.deviceName,
        e: now.getTime() + APP_LINK_CODE_MS,
      });
      const back = new URL(link.redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", link.state);
      return new Response(null, {
        status: 303,
        headers: { location: back.toString(), "cache-control": "no-store" },
      });
    }
    return page(405, "<p>Use the app's sign-in button.</p>");
  } catch (error) {
    const message = error instanceof Error ? error.message : "This sign-in did not work";
    const status =
      error instanceof ValidationError ? 400 : error instanceof ForbiddenError ? 403 : 500;
    return page(status, `<p>${escape(message)}</p>`);
  }
}

/**
 * The app's exchange: a code from the browser, the verifier only it holds, and the redirect the
 * code went to, for a staff device session. No cookie and no bearer token is read.
 */
export async function exchangeAppLinkCode(
  env: AppLinkEnv,
  db: CrmDb,
  input: Record<string, unknown>,
  now: Date,
) {
  const { code, codeVerifier, redirectUri } = input;
  if (
    typeof code !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof redirectUri !== "string"
  ) {
    throw new ValidationError("code, codeVerifier and redirectUri are required", { field: "code" });
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    throw new ValidationError("codeVerifier is 43 to 128 unreserved characters", {
      field: "codeVerifier",
    });
  }
  const claims = await readCode(env, code, now);
  if (claims.r !== redirectUri || !allowedRedirects(env).includes(redirectUri)) throw invalid();
  if ((await pkceChallenge(codeVerifier)) !== claims.c) throw invalid();
  const user = await db.query
    .selectFrom("core_user")
    .select(["id", "deactivated_at"])
    .where("id", "=", claims.u)
    .executeTakeFirst();
  if (!user || user.deactivated_at) {
    throw new ForbiddenError("This account cannot sign in", {
      reason: "account_unavailable",
      httpStatus: 401,
    });
  }
  return issueDeviceSession(db, { audience: "staff", subjectId: user.id }, claims.d, now);
}
