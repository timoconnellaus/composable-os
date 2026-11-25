// How this web app reaches the host: its one service binding, HOST, to the host's ClientApp
// entrypoint. Nothing here opens a database or holds a secret; the host decides who the caller is
// from the customer's session cookie, which it set on this app's hostname at sign-in.
//
// Every call names the visitor's address (`visitorAddress`, the `cos-visitor-address` header,
// made from Cloudflare's `cf-connecting-ip` on the browser's request): the host limits public
// operations and sign-in per client address (ADR 0940), and over the binding every call comes from
// this Worker. Leave it out and all visitors share one limit. Never pass on a `cos-visitor-address`
// the browser sent: every route here builds its headers afresh, and `forVisitor` never copies one.
//
// This file has no framework in it, so it works the same in any Worker. src/server.ts uses it.
import {
  CUSTOMER_AUTH_PATH,
  forVisitor,
  keepCustomerSignedIn,
  visitorAddress,
} from "@composable-os/client";
import { signedOut } from "./agreements.ts";
import { createCustomerClient, operations } from "./client/customer.ts";

export interface HostEnv {
  /** The service binding to the host's ClientApp entrypoint (wrangler.jsonc). */
  HOST: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** What a bound URL starts with: a binding ignores the host part. */
const BOUND = "https://host";

/** The typed client for the customer this request comes from (or the public). */
export function customerApi(env: HostEnv, request: Request) {
  return createCustomerClient({
    baseUrl: BOUND,
    fetch: (url, init) => env.HOST.fetch(url, init),
    headers: () => forVisitor(request),
  });
}

/** The signed-in customer's own Person, or null when the request is the public's. */
export async function signedInCustomer(env: HostEnv, request: Request) {
  try {
    return await customerApi(env, request).call("me.get", {});
  } catch (error) {
    // me.get is open to customers only: the public gets the unknown-operation answer.
    if (signedOut(error)) return null;
    throw error;
  }
}

/** Forwards one sign-in step to the host and passes its answer, cookie included, back. */
async function signInStep(env: HostEnv, request: Request, route: string, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // The host refuses a sign-in posted from another site; the browser's Origin says which.
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;
  // The visitor's address, for the host's limits per address, and their session cookie.
  Object.assign(headers, forVisitor(request));
  const answer = await env.HOST.fetch(`${BOUND}${CUSTOMER_AUTH_PATH}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  // The cookie names no Domain, so the browser keeps it for this app's hostname.
  const out = new Headers({ "content-type": "application/json" });
  for (const cookie of answer.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(await answer.text(), { status: answer.status, headers: out });
}

/**
 * This app's sign-in routes, called by the sign-in page:
 *   POST /auth/code      { email }        the host emails a code
 *   POST /auth/sign-in   { email, code }  the host signs the customer in
 *   POST /auth/sign-out
 * Null for any other request.
 */
export async function authRoute(request: Request, env: HostEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.startsWith("/auth/")) return null;
  const input = (await request.json().catch(() => ({}))) as { email?: string; code?: string };
  if (pathname === "/auth/code") {
    return signInStep(env, request, "/email-otp/send-verification-otp", {
      email: input.email,
      type: "sign-in",
    });
  }
  if (pathname === "/auth/sign-in") {
    return signInStep(env, request, "/sign-in/email-otp", { email: input.email, otp: input.code });
  }
  if (pathname === "/auth/sign-out") return signInStep(env, request, "/sign-out", {});
  return null;
}

/**
 * Keeps the customer signed in: once a day at most, a page request with the customer's cookie
 * renews its lifetime to the session's own (keepCustomerSignedIn). Returns the response with
 * the cookies added.
 */
export async function withSessionKept(
  request: Request,
  env: HostEnv,
  response: Response,
): Promise<Response> {
  if (request.method !== "GET") return response;
  const cookies = await keepCustomerSignedIn({
    cookieHeader: request.headers.get("cookie"),
    fetch: (url, init) => env.HOST.fetch(url, init),
    baseUrl: BOUND,
  });
  if (!cookies.length) return response;
  const kept = new Response(response.body, response);
  for (const cookie of cookies) kept.headers.append("set-cookie", cookie);
  return kept;
}

/** Where the browser's typed-client calls come in, unless `operationRoute` is told another path. */
export const OPERATION_ROUTE = "/api/v1/op/";

export interface OperationRouteOptions {
  /** The operations a page in the browser may call through this route: nothing else is passed. */
  allow: readonly (keyof typeof operations)[];
  /** The path the route answers, ending in "/" (default /api/v1/op/): POST <path><operation>. */
  path?: string;
}

const refuse = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

/** A path's part decoded, or null when it is not valid percent-encoding (a bad `%`). */
function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

const badPath = () => refuse(400, "invalid_input", "The address is not valid");

/**
 * A same-origin route for calls from the browser (ADR 0451): a web block running in a page, an
 * Astro island, any client code that cannot reach HOST itself. `POST <path><operation>` with a
 * JSON body is forwarded to the host over HOST with the customer's cookie and the
 * Idempotency-Key, and nothing else; the host's answer is passed back. Only operations in
 * `allow` are passed. The request must come from this site (its Origin, which a write must
 * send); an Authorization header is never forwarded. Null for any other request.
 *
 * In the browser: createCustomerClient({ baseUrl: location.origin, ... }) with the generated
 * client, and its calls go to /api/v1/op/<operation>, which this route answers.
 */
export async function operationRoute(
  request: Request,
  env: HostEnv,
  options: OperationRouteOptions,
): Promise<Response | null> {
  const path = options.path ?? OPERATION_ROUTE;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(path)) return null;
  const name = decoded(url.pathname.slice(path.length));
  if (name === null) return badPath();
  if (request.method !== "POST") return refuse(405, "invalid_input", "Use POST");
  const spec = (operations as Record<string, { kind: "query" | "mutation" } | undefined>)[name];
  if (!spec || !options.allow.includes(name as keyof typeof operations)) {
    return refuse(404, "unknown_operation", `No operation named "${name}"`);
  }
  // Same origin only. A write must say where it comes from; a read may come with no Origin (a
  // same-origin GET-like fetch from an older browser), never from another site.
  const origin = request.headers.get("origin");
  if (origin ? origin !== url.origin : spec.kind === "mutation") {
    return refuse(403, "forbidden", "Calls come from this site only");
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return refuse(415, "invalid_input", "Send JSON (content-type: application/json)");
  }
  const body = await request.text();
  if (body.length > 1_000_000) return refuse(413, "invalid_input", "The body is too large");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...forVisitor(request),
  };
  const key = request.headers.get("idempotency-key");
  if (key) headers["idempotency-key"] = key;
  const answer = await env.HOST.fetch(`${BOUND}/api/v1/op/${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: body || "{}",
  });
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": answer.headers.get("content-type") ?? "application/json" },
  });
}

/** Where a signed-in customer downloads their own signed agreement (stage 44, ADR 0645). */
export const AGREEMENT_PDF_ROUTE = "/api/v1/agreements/acceptances/";

const ACCEPTANCE_ID = /^aga_[A-Za-z0-9_-]{1,60}$/;

/**
 * A signed agreement's PDF, on this site's own hostname (stage 44): `GET
 * /api/v1/agreements/acceptances/<id>.pdf` is forwarded to the host over HOST with the customer's
 * cookie and nothing else, and the file comes back as the host drew it. Whose it may be is the
 * host's answer (`me.agreements.pdf`: the customer's own and their children's); anything else is
 * not found. Never cached. Null for any other request.
 */
export async function agreementPdfRoute(request: Request, env: HostEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(AGREEMENT_PDF_ROUTE)) return null;
  if (request.method !== "GET") return refuse(405, "invalid_input", "Use GET");
  const file = decoded(url.pathname.slice(AGREEMENT_PDF_ROUTE.length));
  if (file === null) return badPath();
  const id = file.endsWith(".pdf") ? file.slice(0, -4) : "";
  if (!ACCEPTANCE_ID.test(id)) return refuse(404, "not_found", "Not found");
  const answer = await env.HOST.fetch(`${BOUND}${AGREEMENT_PDF_ROUTE}${id}.pdf`, {
    method: "GET",
    headers: forVisitor(request),
  });
  const headers = new Headers({
    "content-type": answer.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const disposition = answer.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  return new Response(answer.body, { status: answer.status, headers });
}

/** Where this site's pages ask for a picture: `<img src="/api/media/<id>?w=640">`. */
export const MEDIA_ROUTE = "/api/media/";

const MEDIA_ID = /^med_[A-Za-z0-9]{1,60}$/;

/**
 * The pictures of the host's media library, on this site's own hostname (stage 28, ADR 0444):
 * `GET /api/media/<id>?w=<width>` is forwarded to the host over HOST, with the id, the width and
 * the customer's cookie and nothing else, and the picture comes back with the host's type and
 * cache headers. What may be shown is the host's answer (`media.serve`): a picture published
 * content shows, for whoever may read that content; anything else is not found. Null for any
 * other request.
 */
export async function mediaRoute(request: Request, env: HostEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(MEDIA_ROUTE)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return refuse(405, "invalid_input", "Use GET");
  }
  const id = decoded(url.pathname.slice(MEDIA_ROUTE.length));
  if (id === null) return badPath();
  if (!MEDIA_ID.test(id)) return refuse(404, "not_found", "Not found");
  const width = url.searchParams.get("w");
  const query = width && /^[0-9]{1,5}$/.test(width) ? `?w=${width}` : "";
  const answer = await env.HOST.fetch(`${BOUND}/api/media/${id}${query}`, {
    method: request.method,
    headers: forVisitor(request),
  });
  const headers = new Headers({
    "content-type": answer.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": answer.headers.get("cache-control") ?? "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  });
  return new Response(request.method === "HEAD" ? null : answer.body, {
    status: answer.status,
    headers,
  });
}

/**
 * The form page's two paths (stage 29, ADR 0728): a form's own page, for a link or a QR code, and
 * where a personal link from an email opens (`/form?t=…`, the SDK's PERSONAL_LINK_PATH).
 */
export const FORM_PAGE_PREFIX = "/f/";
export const FORM_LINK_PATH = "/form";

/** The headers of the host's page that are passed back: what it may load, framing, caching. */
const FORM_PAGE_HEADERS = [
  "content-type",
  "cache-control",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "permissions-policy",
  "allow",
] as const;

/**
 * The form page on this site (stage 29, ADR 0728): `GET` and `POST` of `/f/<slug>` and `/form`
 * are forwarded to the host over HOST, with the customer's cookie and, for a send, the form's
 * fields, and nothing else; the host draws the page (the Forms pack's form page) and its answer
 * comes back with the page's own headers. So a personal link an email sends to this site opens
 * here, and a QR code can name this site. The page works without JavaScript; whether the form is
 * open to the visitor, the spam checks, who may answer and once only are the host's. With no
 * Forms on the host, both paths are not found.
 *
 * A personal link's page is sent with no referrer (set here too, whatever the host said), loads
 * no script from anywhere else, and takes the token out of the address bar once it has loaded.
 * A send must come from this site's own page: another site's form posting here is refused before
 * anything reaches the host. Null for any other request.
 */
export async function formPageRoute(request: Request, env: HostEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const page =
    url.pathname === FORM_LINK_PATH ||
    (url.pathname.startsWith(FORM_PAGE_PREFIX) &&
      url.pathname.length > FORM_PAGE_PREFIX.length &&
      !url.pathname.slice(FORM_PAGE_PREFIX.length).includes("/"));
  if (!page) return null;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return formRefusal(405, "invalid_input", "Use GET or POST", { allow: "GET, HEAD, POST" });
  }
  // Built afresh: the customer's cookie and the visitor's address (Cloudflare's, never one the
  // browser sent), and for a send the form's type. Nothing else of the browser's request.
  const headers: Record<string, string> = forVisitor(request);
  let body: string | undefined;
  if (method === "POST") {
    // The browser's word that the send comes from this site's own page: an allow-list. With
    // Sec-Fetch-Site, same-origin only (a sibling subdomain is same-site, and a customer's cookie
    // still goes with it); without it, an Origin of this site, or "null" (the page's no-referrer
    // policy makes a browser send that).
    const site = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    const ours =
      site !== null ? site === "same-origin" || site === "none" : origin === "null" || origin === url.origin;
    if (!ours) return formRefusal(403, "forbidden", "Answers are sent from this site's page only");
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
      return formRefusal(415, "invalid_input", "Send the page's form");
    }
    const read = await bodyUpTo(request, FORM_PAGE_MAX_BODY);
    if (read === null) return formRefusal(413, "invalid_input", "The answers are too long");
    headers["content-type"] = type;
    body = read;
  }
  const answer = await env.HOST.fetch(`${BOUND}${url.pathname}${url.search}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const out = new Headers();
  for (const name of FORM_PAGE_HEADERS) {
    const value = answer.headers.get(name);
    if (value) out.set(name, value);
  }
  // Never sent on as a referrer, never kept by a cache: a personal link's token is in the address.
  out.set("referrer-policy", "no-referrer");
  out.set("cache-control", "no-store");
  return new Response(method === "HEAD" ? null : answer.body, {
    status: answer.status,
    headers: out,
  });
}

/** The most a form page's send may be, in bytes (the host's page takes no more). */
const FORM_PAGE_MAX_BODY = 131_072;

/** The form route's own refusals: no referrer and no cache, as its pages. */
function formRefusal(
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { "referrer-policy": "no-referrer", "cache-control": "no-store", ...extra },
    },
  );
}

/** A body as text, read only up to `max` bytes; null when it is (or says it is) longer. */
async function bodyUpTo(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Where a stop link opens: the host makes each one for this site (`stopLink`, stage 30). */
export const STOP_ROUTE = "/stop";

const STOP_TOKEN = /^[A-Za-z0-9._-]{1,400}$/;

const stopPage = (body: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Stop these messages</title></head><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem">${body}</body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "referrer-policy": "no-referrer",
      },
    },
  );

/**
 * The one-tap stop on this site (stage 30, ADR 0675). A stoppable email links here with the
 * host's token (`/stop?t=…`) and names the same address in its List-Unsubscribe header:
 *
 * - GET shows a page with one button. Opening the link stops nothing, so a mail scanner that
 *   fetches every link stops nothing.
 * - POST stops: the page's button, or a mail app's one-click (`List-Unsubscribe=One-Click`,
 *   RFC 8058). It calls the host's public `contact.stop` with the token and nothing else (no
 *   cookie: the token alone says who and what), and answers the same whatever the host said.
 *
 * What a token may turn off is the host's to decide; this only carries it. Null for any other
 * request.
 */
export async function stopRoute(request: Request, env: HostEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== STOP_ROUTE) return null;
  const token = url.searchParams.get("t") ?? "";
  if (request.method === "GET" || request.method === "HEAD") {
    if (url.searchParams.get("done") === "1") {
      return stopPage("<h1>Done</h1><p>You will not get these messages any more.</p>");
    }
    if (!STOP_TOKEN.test(token)) {
      return stopPage("<h1>Stop these messages</h1><p>This link is not complete.</p>");
    }
    return stopPage(
      `<h1>Stop these messages</h1><p>Press the button and we will stop sending you these messages. You can turn them back on in your account.</p><form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Stop these messages</button></form>`,
    );
  }
  if (request.method !== "POST") return refuse(405, "invalid_input", "Use GET or POST");
  const fromPage = request.headers.get("origin") === url.origin;
  if (!STOP_TOKEN.test(token)) {
    return fromPage
      ? stopPage("<h1>Stop these messages</h1><p>This link is not complete.</p>")
      : new Response(null, { status: 400 });
  }
  // What the host answered: only a yes is "done". A refusal (too many tries just now, the host
  // unreachable) is never reported as a stop that happened (review of PR #459, M1).
  let status = 200;
  try {
    // The typed client, as the public: no cookie, so the token alone says who and what.
    await createCustomerClient({
      baseUrl: BOUND,
      fetch: (url, init) => env.HOST.fetch(url, init),
      // The visitor's address only (ADR 0940).
      headers: () => visitorAddress(request.headers),
    }).call("contact.stop", { token });
  } catch (error) {
    status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 503;
    if (status < 400) status = 503;
  }
  if (!fromPage) {
    // A mail app's one-click (RFC 8058) gets the host's status: it may try again on a failure.
    return new Response(null, { status });
  }
  if (status === 200) {
    return new Response(null, { status: 303, headers: { location: `${STOP_ROUTE}?done=1` } });
  }
  const page = stopPage(
    `<h1>Stop these messages</h1><p>That did not go through just now, so nothing has changed yet. Please try again in a minute.</p><form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Stop these messages</button></form>`,
  );
  return new Response(page.body, { status, headers: page.headers });
}
