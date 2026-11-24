// Where a staff cookie may be used from (stage 47, ADR 0660, amends ADR 0415). A staff session
// rides on a cookie the browser sends by itself (Better Auth's, Cloudflare Access's, which also
// arrives as the header Access adds, and hosted support's), so only the host's own pages may use
// it. Every place that reads one applies this rule once it has resolved a staff session:
// `authorize` (identity.ts: TanStack Start's pages, server functions and /api/* routes, the
// assistant's socket and the native sign-in page), `staffSession` (http/api.ts: the HTTP surface,
// the token exchange, media and the agreement PDFs) and the MCP consent page (mcp/consent.ts).
// A customer's cookie, a native app's bearer token and MCP's OAuth tokens are not staff cookies.
import { ForbiddenError } from "@composable-os/core";

/**
 * Whether a request carrying a staff cookie may use it:
 * - an `Origin` that names a site must be the host's own, even one `API_ALLOWED_ORIGINS` lets
 *   in (the company's website, for its customers);
 * - an `Origin` of `null` names none (a sandboxed frame, or a page whose referrer policy withholds
 *   it, as the native sign-in page's does), so only `Sec-Fetch-Site: same-origin` passes;
 * - with no `Origin`, a `Sec-Fetch-Site` that is not `same-origin` is refused, except a top-level
 *   GET navigation (a link into the admin from an email or a chat): its answer is shown to the
 *   person and never readable by the page that opened it, and no GET acts on anything;
 * - a request with neither header is not a browser's (or is one too old to send them) and passes.
 * A page cannot set `Origin` or `Sec-Fetch-*`.
 */
export function staffCookieAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin !== null && origin !== "null") return origin === new URL(request.url).origin;
  if (site === "same-origin") return true;
  if (origin === "null") return false;
  return site === null || isTopLevelNavigation(request);
}

function isTopLevelNavigation(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

/** The refusal of a staff cookie from somewhere else, as the HTTP surface answers it (403). */
export function staffCrossOrigin(): ForbiddenError {
  return new ForbiddenError("A staff session is used only from the host's own pages", {
    rule: "staff_cross_origin",
  });
}
