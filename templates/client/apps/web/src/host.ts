// How this web app reaches the host: its one service binding, HOST, to the host's ClientApp
// entrypoint. Nothing here opens a database or holds a secret; the host decides who the caller is
// from the customer's session cookie, which it set on this app's hostname at sign-in.
//
// This file has no framework in it, so it works the same in any Worker. src/server.ts uses it.
import {
  ApiError,
  CUSTOMER_AUTH_PATH,
  customerSession,
  keepCustomerSignedIn,
} from "@composable-os/client";
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
    headers: () => customerSession(request.headers.get("cookie")),
  });
}

/** The signed-in customer's own Person, or null when the request is the public's. */
export async function signedInCustomer(env: HostEnv, request: Request) {
  try {
    return await customerApi(env, request).call("me.get", {});
  } catch (error) {
    // me.get is open to customers only: the public gets the unknown-operation answer.
    if (error instanceof ApiError && error.code === "unknown_operation") return null;
    throw error;
  }
}

/** Forwards one sign-in step to the host and passes its answer, cookie included, back. */
async function signInStep(env: HostEnv, request: Request, route: string, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // The host refuses a sign-in posted from another site; the browser's Origin says which.
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;
  // The visitor's address, for the host's limit on code requests per address.
  const address = request.headers.get("cf-connecting-ip");
  if (address) headers["cf-connecting-ip"] = address;
  Object.assign(headers, customerSession(request.headers.get("cookie")));
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
  const name = decodeURIComponent(url.pathname.slice(path.length));
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
    ...customerSession(request.headers.get("cookie")),
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
