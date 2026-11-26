// The desk origin (stage 44 step 6, stage 51 step 1; ADRs 0649 and 0780): a hostname of its own
// for this same Worker (`desk.` before the host's name, DESK_HOSTNAME), where the business's
// enrolled tablet runs. It serves only:
//
//   GET  /                   to /desk
//   GET  /desk, /enrol       the tablet's two pages (TanStack Start routes, rendered here only)
//   POST /api/desk/<call>    the desk calls: desk.status, device.claim (at /enrol), desk.claim,
//                            desk.documents, desk.accept, desk.heartbeat, desk.finish
//   POST /api/desk/<call>    a device's calls (stage 51, ADR 0781): device.heartbeat and a pack's
//                            tools (`x.<pack>.<tool>`), called as the enrolled device; the
//                            pipeline resolves it from its credential and refuses anything its
//                            device role does not hold
//
// and the build's static files (answered before the Worker runs). Everything else is not found
// here: no admin page, server function, HTTP surface, MCP or sign-in. The staff origin serves none
// of the desk's paths (`isDeskPath`), so no script on it (a pack's block, an extension's screen, a
// compromised dependency) can frame the desk, read its page or send requests that carry its
// cookies.
//
// The cookies: the device credential (`__Host-cos-desk-device`) and the session token
// (`__Host-cos-desk-session`), each `HttpOnly`, `Secure`, `SameSite=Strict`, on this origin only
// (`__Host-`: no Domain, path /), never in a URL or an answer's body. A cookie path is not a
// security boundary and nothing relies on one: the token is read by the desk calls only, each on
// its one session and device, and a staff call never accepts it.
//
// Every desk call must come from this origin (`Origin`), is refused when it carries a staff (or a
// customer) session as a matter of hygiene, and is limited per client address. The operations
// themselves decide everything else (`deskOnly`, ADR 0649): what the credential and the token may
// do, the limits, the lock-outs.
import {
  createIdentityProvider,
  hostOnlyCookies,
  type IdentityEnv,
  isSessionCookie,
} from "@composable-os/auth";
import {
  type DeskRequest,
  type DeviceCaller,
  dataReply,
  errorReply,
  ForbiddenError,
  type HttpReply,
  invokeByName,
  OperationError,
  type PublicPrincipal,
  RateLimitedError,
  rateLimit,
  readBounded,
  ValidationError,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { type DeskEnv, deskOrigin } from "../desk.ts";
import { type SupportEnv, supportPrincipal } from "../support.ts";
import { type ApiEnv, connectionAddress, outsideContext } from "./api.ts";

export const DEVICE_COOKIE = "__Host-cos-desk-device";
export const SESSION_COOKIE = "__Host-cos-desk-session";

/** The calls the desk origin answers, and nothing else. */
export const DESK_CALLS = new Set([
  "desk.status",
  "device.claim",
  "desk.claim",
  "desk.documents",
  "desk.accept",
  "desk.heartbeat",
  "desk.finish",
]);

/**
 * A device's calls (ADR 0781): its heartbeat and a pack's tools. Which ones it may make is the
 * pipeline's to decide, from the device's role; any other name is answered as not found here.
 */
export const DEVICE_CALL_RE =
  /^(?:device\.heartbeat|x\.[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39})$/;

/** The desk's own pages. */
export const DESK_PAGES = new Set(["/desk", "/enrol"]);

/** Paths that belong to the desk origin, which the staff origin answers as not found. */
export function isDeskPath(pathname: string): boolean {
  // `/desk/` and `/desk//` too: the router would serve them as /desk (after the review of PR #390).
  const path = pathname.replace(/\/+$/, "") || "/";
  return DESK_PAGES.has(path) || path === "/api/desk" || path.startsWith("/api/desk/");
}

/** A device credential lasts until it rotates; browsers keep a cookie at most 400 days. */
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60;
/** A session never outlives its 20 minutes. */
const SESSION_MAX_AGE = 20 * 60;

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });
/** A device call: which device, the pipeline reads from its credential (ADR 0781). */
const DEVICE: DeviceCaller = Object.freeze({ kind: "device" });

/** What every desk answer carries: never framed, never cached, no referrer, nothing else loaded. */
export const DESK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

export type DeskHandlerEnv = ApiEnv & DeskEnv & IdentityEnv & SupportEnv;

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at), part.slice(at + 1));
  }
  return out;
}

function setCookie(name: string, value: string | null, maxAge: number): string {
  const attributes = "Path=/; Secure; HttpOnly; SameSite=Strict";
  return value === null
    ? `${name}=; ${attributes}; Max-Age=0`
    : `${name}=${value}; ${attributes}; Max-Age=${maxAge}`;
}

function reply(result: HttpReply, setCookies: string[] = []): Response {
  const headers = new Headers({
    ...DESK_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(result.body, { status: result.status, headers });
}

/** Adds the desk's headers to a page's answer (the TanStack Start routes /desk and /enrol). */
export function withDeskHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DESK_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Whether the request carries a staff session (or a customer's): refused on the desk. */
async function carriesSession(request: Request, env: DeskHandlerEnv): Promise<boolean> {
  if (request.headers.get("authorization")) return true;
  if (await supportPrincipal(request, env)) return true;
  if (await createIdentityProvider(env).resolve(request)) return true;
  const hostOnly = hostOnlyCookies(env);
  return [...cookies(request).keys()].some((name) =>
    isSessionCookie(name, "cos-customer", hostOnly),
  );
}

/**
 * Serves one request to the desk origin. `page` renders the desk's own pages (TanStack Start);
 * anything that is neither a page nor a desk call is not found.
 */
export async function handleDesk(
  request: Request,
  env: DeskHandlerEnv,
  page: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return withDeskHeaders(Response.redirect(new URL("/desk", url).toString(), 302));
  }
  if (DESK_PAGES.has(url.pathname.replace(/\/+$/, ""))) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply(errorReply(new ValidationError("Use GET", { httpStatus: 405 }), true));
    }
    return withDeskHeaders(await page(request));
  }
  const call = /^\/api\/desk\/([a-z][a-zA-Z0-9.]*)$/.exec(url.pathname)?.[1];
  const deviceCall = Boolean(call && DEVICE_CALL_RE.test(call));
  if (!call || (!DESK_CALLS.has(call) && !deviceCall)) {
    return reply(errorReply(new OperationError("not_found", "Not found"), true));
  }
  try {
    if (request.method !== "POST") throw new ValidationError("Use POST", { httpStatus: 405 });
    // Every desk call comes from the desk's own page.
    if (request.headers.get("origin") !== url.origin) {
      throw new ForbiddenError("A desk call comes from the desk's own page", {
        rule: "desk_origin",
      });
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new ValidationError("Send JSON", { httpStatus: 415 });
    }
    if (await carriesSession(request, env)) {
      throw new ForbiddenError("The desk takes no sign-in: use it without one.", {
        rule: "desk_session_cookie",
      });
    }
    const address = request.headers.get("cf-connecting-ip");
    const limited = await rateLimit(env.DESK_RATE_LIMIT, `desk:${address ?? "unknown"}`);
    if (!limited.ok) {
      throw new RateLimitedError(`Too many requests; retry in ${limited.retryAfterSeconds}s`, {
        retryAfterSeconds: limited.retryAfterSeconds,
      });
    }
    if (!env.DESK_SECRET) {
      throw new ForbiddenError("The desk is not set up on this deployment.", {
        rule: "desk_not_configured",
        httpStatus: 503,
      });
    }
    const text = await readBounded(request, 64_000);
    let input: unknown;
    try {
      input = JSON.parse(text || "{}");
    } catch {
      throw new ValidationError("The request body is not JSON");
    }
    const jar = cookies(request);
    const issued: { credential?: string; token?: string | null } = {};
    const deskRequest: DeskRequest = {
      credential: jar.get(DEVICE_COOKIE) ?? null,
      token: jar.get(SESSION_COOKIE) ?? null,
      userAgent: request.headers.get("user-agent"),
      address,
      issue: (set) => Object.assign(issued, set),
    };
    const ctx = await outsideContext(
      env,
      createCrmDb(env.DB),
      PUBLIC,
      null,
      await connectionAddress(request, env),
    );
    const desk = {
      secret: env.DESK_SECRET,
      origin: deskOrigin(env, url.origin),
      request: deskRequest,
    };
    // A device's call is made as the enrolled device: the pipeline reads which from the
    // credential and holds it to its device role (ADR 0781).
    const data = await invokeByName(
      call,
      input,
      deviceCall ? { ...ctx, principal: DEVICE, desk } : { ...ctx, desk },
    );
    // The cookies go only with an answer that succeeded.
    const set: string[] = [];
    if (issued.credential !== undefined) {
      set.push(setCookie(DEVICE_COOKIE, issued.credential, DEVICE_MAX_AGE));
    }
    if (issued.token !== undefined)
      set.push(setCookie(SESSION_COOKIE, issued.token, SESSION_MAX_AGE));
    return reply(dataReply(data), set);
  } catch (error) {
    // A session the host ended (or a device it revoked) clears the token on the tablet too.
    const typed = error instanceof OperationError ? error : null;
    const rule = (typed?.details as { rule?: unknown } | undefined)?.rule;
    const clear =
      rule === "desk_session_ended" || rule === "device_not_enrolled"
        ? [setCookie(SESSION_COOKIE, null, 0)]
        : [];
    return reply(errorReply(error, true), clear);
  }
}
