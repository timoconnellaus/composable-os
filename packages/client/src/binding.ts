// A company's web app calling the host over its service binding (stage 24, ADR 0421).
//
// The web app holds no credential of its own. It forwards the customer's session cookie, which
// the host set on the web app's hostname at sign-in and verifies on every call, and nothing else:
// `customerSession` picks that cookie out of the browser's request, so the web app's other
// cookies never reach the host.
//
//   const api = createCustomerClient({
//     baseUrl: "https://host",                     // any origin: a binding ignores it
//     fetch: (url, init) => env.HOST.fetch(url, init),
//     headers: () => customerSession(request.headers.get("cookie")),
//   });

import type { FetchLike } from "./types.ts";

/** Customer session cookies are `cos-customer.*`, `__Secure-` prefixed on https (the host's). */
export const CUSTOMER_COOKIE_PREFIX = "cos-customer";

/** Customer sign-in, served by the host and reached over the binding: forward these paths. */
export const CUSTOMER_AUTH_PATH = "/api/customer-auth";

/** A cookie's name (or name=value pair) without the browser's `__Secure-`/`__Host-` prefix. */
function unprefixed(cookie: string): string {
  return cookie.replace(/^__(Secure|Host)-/, "");
}

function isCustomerCookie(pair: string): boolean {
  return unprefixed(pair).startsWith(`${CUSTOMER_COOKIE_PREFIX}.`);
}

/** The customer cookies in a `Cookie` header, as one header value ("" when there are none). */
export function customerCookies(cookieHeader: string | null | undefined): string {
  return (cookieHeader ?? "")
    .split(/;\s*/)
    .filter((pair) => pair && isCustomerCookie(pair))
    .join("; ");
}

/** Headers for a call made for the browser's customer: their session cookie, if any. */
export function customerSession(cookieHeader: string | null | undefined): Record<string, string> {
  const cookie = customerCookies(cookieHeader);
  return cookie ? { cookie } : {};
}

/** The web app's own marker: when it last checked the customer's session (not a credential). */
export const SESSION_CHECKED_COOKIE = "cos-session-checked";
/** At most this often, the session is checked and its cookie given a fresh lifetime. */
export const SESSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cookiePairs(header: string | null | undefined): [string, string][] {
  return (header ?? "")
    .split(/;\s*/)
    .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])
    .filter(([name]) => Boolean(name)) as [string, string][];
}

export interface KeepSignedInOptions {
  /** The browser's `Cookie` header. */
  cookieHeader: string | null | undefined;
  /** The binding's fetch: `(url, init) => env.HOST.fetch(url, init)`. */
  fetch: FetchLike;
  /** Any origin: a binding ignores it. */
  baseUrl: string;
  /** Default: now. */
  now?: Date;
}

/**
 * Keeps a signed-in customer signed in on the web app's hostname (stage 24, ADR 0421). The host
 * extends a session in its database while it is used, but the browser keeps the cookie's
 * lifetime from sign-in. Once a day at most, on a request that carries the customer's cookie,
 * this asks the host for the session over the binding and returns `Set-Cookie` values for the
 * web app's response: the same cookie with a lifetime to the session's current expiry, and the
 * web app's marker of when it checked. A session that has ended clears both. Nothing to do: [].
 */
export async function keepCustomerSignedIn(options: KeepSignedInOptions): Promise<string[]> {
  const pairs = cookiePairs(options.cookieHeader);
  const session = pairs.find(
    ([name]) => unprefixed(name) === `${CUSTOMER_COOKIE_PREFIX}.session_token`,
  );
  if (!session) return [];
  const now = (options.now ?? new Date()).getTime();
  const checked = Number(pairs.find(([name]) => name === SESSION_CHECKED_COOKIE)?.[1]);
  if (checked > 0 && now - checked >= 0 && now - checked < SESSION_CHECK_INTERVAL_MS) return [];
  const [name, value] = session;
  const attributes = `; Path=/; HttpOnly; SameSite=Lax${name.startsWith("__Secure-") ? "; Secure" : ""}`;
  const response = await options.fetch(
    `${options.baseUrl.replace(/\/+$/, "")}${CUSTOMER_AUTH_PATH}/get-session`,
    { method: "GET", headers: { cookie: customerCookies(options.cookieHeader) } },
  );
  // The host could not answer: leave the cookie as it is, and try again on a later request.
  if (response.status >= 500) return [];
  let expiresAt = Number.NaN;
  if (response.status === 200) {
    try {
      const body = JSON.parse(await response.text()) as { session?: { expiresAt?: string } } | null;
      expiresAt = Date.parse(body?.session?.expiresAt ?? "");
    } catch {}
  }
  if (!(expiresAt > now)) {
    return [
      `${name}=${attributes}; Max-Age=0`,
      `${SESSION_CHECKED_COOKIE}=${attributes}; Max-Age=0`,
    ];
  }
  const maxAge = Math.floor((expiresAt - now) / 1000);
  return [
    `${name}=${value}${attributes}; Max-Age=${maxAge}`,
    `${SESSION_CHECKED_COOKIE}=${now}${attributes}; Max-Age=${maxAge}`,
  ];
}
