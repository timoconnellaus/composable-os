// A client host behind Cloudflare Access (ADR 0455, docs/deploying.md "Cloudflare Access"):
// which of cos-app's paths stay behind the Access application, and which go in a bypass
// application because they serve customers, the public, providers or MCP clients and
// authenticate by their own means. Pure data, so a Node test can hold it to the route table
// (apps/app/test-node/access-layout.test.ts): a route that is in neither list fails it.
//
// A pattern is a path, or a prefix ending in `*`. The bypass list is what goes in Access's
// bypass application; everything else on the hostname stays behind Access.

export interface BypassedPath {
  path: string;
  /** How the path authenticates without Access, in a sentence a reviewer can check. */
  authenticates: string;
  /**
   * When the bypass is needed: `always`; `customers-on-host` when customers buy on the host's own
   * pages; `mcp` when MCP clients connect; `if-used` when that provider or webhook is in use;
   * `non-live` only outside a live environment.
   */
  when: "always" | "customers-on-host" | "mcp" | "non-live" | "if-used";
}

export interface StaffPath {
  path: string;
  why: string;
}

export const ACCESS_BYPASS: readonly BypassedPath[] = [
  {
    // Inside /api/v1/* (below), listed on its own so that it stays bypassed, and says how, if the
    // surface's bypass ever narrows: a calendar app cannot sign in through Access.
    path: "/api/v1/staffing/feed/*",
    when: "always",
    authenticates:
      "A staff member's private calendar feed (ADR 0628), polled by a calendar app with no " +
      "sign-in: the 32-byte random token in the address is the credential, looked up by its " +
      "SHA-256 (the host keeps nothing else of it), answering only that person's own shifts " +
      "while their account is active and holds the pack's permission. Any other token, and any " +
      "other path under it, is a 404 like a missing route; limited per token and per address.",
  },
  {
    // The same, for a customer's own calendar feed (stage 62, ADR 0890).
    path: "/api/v1/me/feed/*",
    when: "always",
    authenticates:
      "A customer's private calendar feed (ADR 0890), polled by a calendar app with no sign-in: " +
      "the 32-byte random token in the address is the credential, looked up by its SHA-256 in its " +
      "own table (a staff feed's token opens nothing here), answering only that customer's own " +
      "and their live dependants' bookings, read as the customer, while the account is active. " +
      "Any other token, and any other path under it, is a 404 like a missing route; limited per " +
      "token and per address.",
  },
  {
    path: "/api/v1/*",
    when: "always",
    authenticates:
      "The HTTP surface decides the caller itself: a bearer device token (looked up by its hash), " +
      "a customer cookie signed with CUSTOMER_AUTH_SECRET, or a staff credential (an Access JWT " +
      "verified against the team's keys, issuer and AUD, never trusted unverified); anything else " +
      "is the public. Cross-origin browsers are refused unless listed. The native sign-in routes " +
      "take a code or a handoff code and store only hashes.",
  },
  {
    path: "/api/customer-auth/*",
    when: "always",
    authenticates:
      "Customer sign-in: an emailed code (hashed, single use) and Better Auth sessions signed with " +
      "CUSTOMER_AUTH_SECRET, in their own tables. Never a staff session.",
  },
  {
    path: "/gatekeeper/payments/in/*",
    when: "if-used",
    authenticates: "The payment provider's webhook, checked against STRIPE_WEBHOOK_SECRET.",
  },
  {
    path: "/gatekeeper/text/in/*",
    when: "if-used",
    authenticates:
      "The text provider's webhook (receipts and STOP, START and HELP replies), checked against the provider's signing secret.",
  },
  {
    path: "/gatekeeper/webhook/in/*",
    when: "if-used",
    authenticates: "Inbound webhooks, each signed with its own endpoint's secret.",
  },
  {
    path: "/gatekeeper/google/pubsub",
    when: "if-used",
    authenticates:
      "Google Pub/Sub push: a Google-signed OIDC token for the configured service account.",
  },
  {
    path: "/gatekeeper/microsoft/outlook/notifications/*",
    when: "if-used",
    authenticates:
      "Microsoft Graph notifications: each carries the subscription's random clientState secret.",
  },
  {
    path: "/mcp",
    when: "mcp",
    authenticates: "MCP's own OAuth 2.1 bearer tokens.",
  },
  {
    path: "/oauth/token",
    when: "mcp",
    authenticates: "The OAuth token endpoint: a PKCE code or a refresh token.",
  },
  {
    path: "/oauth/register",
    when: "mcp",
    authenticates: "Dynamic client registration; registering grants nothing until consent.",
  },
  {
    path: "/.well-known/*",
    when: "mcp",
    authenticates: "Public OAuth metadata, nothing secret.",
  },
  {
    path: "/buy",
    when: "customers-on-host",
    authenticates: "The guest checkout page; its calls are the public's over /api/v1.",
  },
  {
    path: "/order/*",
    when: "customers-on-host",
    authenticates: "A guest's order page, opened only by the order's token.",
  },
  {
    path: "/_serverFn/*",
    when: "customers-on-host",
    authenticates:
      "Server functions: every one needs a verified staff principal except those in *.public.ts " +
      "(identity.ts), so the bypass only lets the guest pages' public ones through.",
  },
  {
    path: "/assets/*",
    when: "customers-on-host",
    authenticates: "The built JavaScript and CSS, public by nature.",
  },
  {
    path: "/api/health",
    when: "always",
    authenticates: "Health and version only, no data (cos deploy and monitors read it).",
  },
  {
    path: "/gatekeeper/payments/fake/pay/*",
    when: "non-live",
    authenticates:
      "The fake provider's checkout page, opened by its random checkout reference; it exists only " +
      "with PAYMENTS_FAKE_PROVIDER=true, never in a live environment.",
  },
];

export const ACCESS_STAFF: readonly StaffPath[] = [
  {
    path: "/",
    why: "The staff app: the `_app` layout's pages (every route file under routes/_app).",
  },
  { path: "/sign-in", why: "Better Auth's page; under Access, Access is the sign-in." },
  { path: "/api/auth/*", why: "Better Auth's routes, unused under Access." },
  { path: "/api/assistant/*", why: "The assistant, staff only (its socket too)." },
  { path: "/support/*", why: "Hosted support access, staff side." },
  { path: "/oauth/consent", why: "MCP consent: the person signs in through Access here." },
  {
    path: "/native/staff-sign-in",
    why:
      "A native app's or a command-line tool's staff sign-in in the system browser: Access signs " +
      "the person in, and they confirm on the page where the sign-in goes (ADR 0457).",
  },
  { path: "/connect/handoff", why: "The end of an integration's connect popup, staff only." },
  {
    path: "/api/media/*",
    why:
      "The media library (stage 28, ADR 0444): staff upload and view pictures. Outsiders are " +
      "served published content's pictures at /api/v1/media/<id> (bypassed with /api/v1) or " +
      "through the client-app binding, which Access does not front.",
  },
  {
    path: "/api/agreements/*",
    why:
      "A signed agreement's PDF and a version's blank form (stage 44, ADR 0645): staff download " +
      "them. A customer downloads their own at /api/v1/agreements/… (bypassed with /api/v1) or " +
      "through the client-app binding.",
  },
  {
    path: "/blocks",
    why: "A pack's web block mounted on its own, in development only; a deployed host renders nothing there.",
  },
  {
    path: "/desk",
    why:
      "The desk tablet's page (stage 44 step 6, ADR 0649): served only on the desk origin, a " +
      "hostname of its own that this Access application does not cover; the staff hostname " +
      "answers it as not found.",
  },
  {
    path: "/enrol",
    why: "Enrolling the desk tablet (ADR 0780): on the desk origin only, as /desk.",
  },
  {
    path: "/api/desk/*",
    why: "The desk tablet's calls: on the desk origin only, as /desk.",
  },
  {
    path: "/gatekeeper/*",
    why:
      "Every other gatekeeper route: OAuth callbacks and connect pages opened in a staff " +
      "member's browser, which carries the Access cookie; and the fake provider's dev helpers.",
  },
];

/**
 * Every gatekeeper vendor, and the paths under `/gatekeeper/<vendor>/` that a provider calls
 * (bypassed above). The rest of a vendor's routes are a staff member's browser: behind Access.
 * A vendor added to the catalogue must be added here, or the layout test fails.
 */
export const GATEKEEPER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  google: ["/gatekeeper/google/pubsub"],
  microsoft: ["/gatekeeper/microsoft/outlook/notifications/*"],
  slack: [],
  "slack-post": [],
  mcp: [],
  email: [],
  "email-send": [],
  zoominfo: [],
  websearch: [],
  webhook: ["/gatekeeper/webhook/in/*"],
  payments: ["/gatekeeper/payments/in/*", "/gatekeeper/payments/fake/pay/*"],
  text: ["/gatekeeper/text/in/*"],
  fake: [],
  // The fake accounting books (stage 61): development and tests only, and it serves no routes.
  "accounting-fake": [],
  // The fake booking system (stage 65): development and tests only, and it serves no routes.
  "booking-system-fake": [],
};

/** Whether `pathname` matches a layout pattern. */
export function matchesLayout(pattern: string, pathname: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return pathname === base || pathname.startsWith(`${base}/`);
  }
  return pathname === pattern;
}

/** The bypass entry a path falls under, or null when it stays behind Access. */
export function bypassFor(pathname: string): BypassedPath | null {
  return ACCESS_BYPASS.find((entry) => matchesLayout(entry.path, pathname)) ?? null;
}
