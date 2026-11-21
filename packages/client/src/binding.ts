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

/** Customer session cookies are `cos-customer.*`, `__Secure-` prefixed on https (the host's). */
export const CUSTOMER_COOKIE_PREFIX = "cos-customer";

/** Customer sign-in, served by the host and reached over the binding: forward these paths. */
export const CUSTOMER_AUTH_PATH = "/api/customer-auth";

function isCustomerCookie(pair: string): boolean {
  return pair.replace(/^__(Secure|Host)-/, "").startsWith(`${CUSTOMER_COOKIE_PREFIX}.`);
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
