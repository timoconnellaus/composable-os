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
import { createCustomerClient } from "./client/customer.ts";

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
