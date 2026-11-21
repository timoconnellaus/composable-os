// A stand-in for a company's own web app (stage 24): its own Worker on its own hostname, with a
// service binding to the host's `ClientApp` entrypoint and no database, bucket, KV or secret of
// its own. It is what the template's `apps/web` does at the wire, without the framework:
//
//   POST /sign-in/code   { email }        the sign-in form's first step
//   POST /sign-in        { email, code }  the second; the host's cookie comes back for this hostname
//   POST /sign-out
//   GET  /account        a signed-in page: the customer's name, from me.get
//   GET  /               a public page
//
// Bundled by the app's vitest config with esbuild and run as an auxiliary Worker.
import {
  ApiError,
  CUSTOMER_AUTH_PATH,
  customerCookies,
  customerSession,
} from "@composable-os/client";
import { createCustomerClient } from "./customer.ts";

interface Env {
  /** The service binding to the host's ClientApp entrypoint. */
  HOST: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** What a bound URL starts with: the binding ignores the host part. */
const BOUND = "https://host";

/** Forwards a sign-in step to the host and passes its answer, cookie included, back. */
async function signInStep(env: Env, request: Request, route: string, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Better Auth refuses a sign-in posted from another site; the browser's Origin says which.
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;
  // The visitor's address, for the host's per-address limit on code requests.
  const address = request.headers.get("cf-connecting-ip");
  if (address) headers["cf-connecting-ip"] = address;
  Object.assign(headers, customerSession(request.headers.get("cookie")));
  const answer = await env.HOST.fetch(`${BOUND}${CUSTOMER_AUTH_PATH}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  // The Set-Cookie headers are passed through as they are: the cookie is host-only, so the
  // browser keeps it for this hostname.
  const out = new Headers({ "content-type": "application/json" });
  for (const cookie of answer.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(await answer.text(), { status: answer.status, headers: out });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/sign-in/code") {
      const { email } = (await request.json()) as { email: string };
      return signInStep(env, request, "/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      });
    }
    if (request.method === "POST" && pathname === "/sign-in") {
      const { email, code } = (await request.json()) as { email: string; code: string };
      return signInStep(env, request, "/sign-in/email-otp", { email, otp: code });
    }
    if (request.method === "POST" && pathname === "/sign-out") {
      return signInStep(env, request, "/sign-out", {});
    }
    if (pathname === "/account") {
      const api = createCustomerClient({
        baseUrl: BOUND,
        fetch: (url, init) => env.HOST.fetch(url, init),
        headers: () => customerSession(request.headers.get("cookie")),
      });
      try {
        const me = await api.call("me.get", {});
        return new Response(`Signed in as ${me.displayName}`);
      } catch (error) {
        if (error instanceof ApiError && error.code === "unknown_operation") {
          // Not signed in: me.get is not open to the public.
          return new Response("Sign in to see your account", { status: 401 });
        }
        throw error;
      }
    }
    if (pathname === "/") {
      return new Response(
        customerCookies(request.headers.get("cookie")) ? "Welcome back" : "Welcome",
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
