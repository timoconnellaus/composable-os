// The form page on the host (stage 29 step 4, ADR 0728): a form for a link or a QR code
// (`/f/<slug>`) and a personal link from an email (`/form?t=<token>`), drawn by the Forms pack's
// page (`@composable-os/pack-forms/page`). Served on the host's own address (public: in the
// Access bypass list, access-layout.ts) and over the client-app binding (bound.ts), so a business's
// web app serves the same page on its own site by forwarding these paths (the template's
// `formPageRoute`).
//
// The page is a client of the HTTP surface like any other: its typed client calls the binding's
// door in-process (`handleBound`), which decides the caller from the customer's verified session
// cookie or makes it the public, never staff, and keeps each send's Idempotency-Key. Only the
// customer's session cookie is passed on; nothing else of the request is. Whether a form is open,
// the spam checks, the caps, who may answer and once only are the door's.
import { CUSTOMER_COOKIE_PREFIX, hostOnlyCookies, isSessionCookie } from "@composable-os/auth";
import { formPage, formPageClient, isFormPagePath } from "@composable-os/pack-forms/page";
import type { ApiEnv } from "./api.ts";

/** The header the page's calls name their visitor in (bound.ts reads it, ADR 0940). */
const VISITOR_ADDRESS_HEADER = "cos-visitor-address";

export { isFormPagePath };

export interface FormPageEnv extends ApiEnv {
  /** The Turnstile widget's site key, for a public form's page (docs/deploying.md). */
  TURNSTILE_SITE_KEY?: string;
}

/**
 * The request's customer session cookie (its parts), or null: never a staff cookie. On a host of
 * many clients only its `__Host-` names (stage 66, ADR 0619 rule (c), `isSessionCookie`).
 */
function customerCookie(request: Request, env: object): string | null {
  const hostOnly = hostOnlyCookies(env);
  const parts = (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .filter((part) => part && isSessionCookie(part, CUSTOMER_COOKIE_PREFIX, hostOnly));
  return parts.length ? parts.join("; ") : null;
}

/** Where the page is served, and so who vouches for the visitor (ADR 0728, ADR 0940). */
export interface FormPageVisitor {
  /**
   * The visitor's address, for the per-address limits on the page's calls: on the host's own
   * address, Cloudflare's `cf-connecting-ip` (never a `cos-visitor-address` a browser sent); over
   * the binding, what the bound Worker forwarded, in the binding's order.
   */
  address: string | null;
  /**
   * `page`: a browser posts to the host itself, and the page checks its Sec-Fetch-Site or Origin.
   * `forwarded`: the bound Worker checked its browser's request and forwards neither header.
   */
  sameOrigin: "page" | "forwarded";
}

/**
 * The visitor of a request to the host's own address: Cloudflare's `cf-connecting-ip`, which a
 * browser cannot set. A `cos-visitor-address` the browser sent is never read here.
 */
export function hostVisitor(request: Request): FormPageVisitor {
  return { address: request.headers.get("cf-connecting-ip"), sameOrigin: "page" };
}

/**
 * The visitor of a request over the binding: the bound Worker's word, in the binding's order (a
 * forwarded `cf-connecting-ip` first, then the `cos-visitor-address` it names). The bound Worker
 * checked its browser's request came from its own page.
 */
export function boundVisitor(request: Request): FormPageVisitor {
  return {
    address: request.headers.get("cf-connecting-ip") ?? request.headers.get(VISITOR_ADDRESS_HEADER),
    sameOrigin: "forwarded",
  };
}

/**
 * Serves one request to the form page. `door` answers the page's calls to the HTTP surface: the
 * client-app binding's (`handleBound`), so the caller is a customer or the public, counted against
 * `visitor.address`. The inner requests are made afresh: the customer's cookie and the address,
 * nothing else of the browser's request.
 */
export function handleFormPage(
  request: Request,
  env: FormPageEnv,
  door: (request: Request) => Promise<Response>,
  visitor: FormPageVisitor,
): Promise<Response> {
  const cookie = customerCookie(request, env);
  const address = visitor.address?.trim();
  return formPage(request, {
    client: formPageClient({
      fetch: (url, init) => door(new Request(url, init)),
      headers: (): Record<string, string> => ({
        ...(cookie ? { cookie } : {}),
        ...(address ? { [VISITOR_ADDRESS_HEADER]: address } : {}),
      }),
    }),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY?.trim() || null,
    sameOrigin: visitor.sameOrigin,
  });
}
