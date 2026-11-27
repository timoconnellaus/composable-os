// cos-front (stage 66 step 8, ADR 0619): the Worker of ours that receives every request for a
// client's own web hostname (`www.gym-a.example`, a Cloudflare for SaaS custom hostname routed to
// it) and hands it to that client's web target.
//
// - **The client is the registry's, never the request's.** The hostname the request reached is
//   looked up exactly (`canonicalHostname`) among the registry's verified `web` hostnames of this
//   deployment's environment; nothing is derived from its text. Unknown, unverified, another
//   environment's, another surface's, or anywhere under the fleet domain's registrable domain
//   (where no client's web code ever runs: the owner's rule of 2026-11-27, ADR 0616 "Cookies"):
//   the same plain 404, reaching no client's data (criterion 8). A client paused or moving gets
//   "being updated".
// - **The client is fixed by cos-front.** The target is handed a `FrontClient` built from the
//   registry's row, and a copy of the request with every header that could name a client (or
//   another host) taken out (`frontRequest`). What the target does with the client is fixed by
//   cos-front, not by anything in the request.
// - **It holds nothing of a client's.** Its bindings are the registry (the host's own D1, holding
//   no client's records), its environment's name and the fleet's domain: no client's database, no
//   secret, no key (packages/release `fleetBindings`).
// - **Security headers** on everything it answers (`withFrontHeaders`): `X-Content-Type-Options`,
//   `Referrer-Policy`, `X-Frame-Options` and a content security policy with `frame-ancestors
//   'none'`; its own pages (the holding page, the 404) a policy that allows only their one style.
//
// In this step the only target is the built-in holding page. Stage 75 step 5 adds the target that
// serves the client's published version (under Worker Loader or by a namespace Worker, as stage
// 75's spike decides): it implements `WebTarget`, and nothing else here changes.
import { beingUpdatedResponse, unknownHostResponse } from "./client-entries.ts";
import {
  type ClientEnvironmentName,
  type ClientId,
  canonicalHostname,
  isClientId,
  isUnder,
  registrableDomain,
} from "./registry.ts";

/** What cos-front is bound to on a fleet deployment (and nothing else). */
export interface FrontEnv {
  /** The host's registry (ADR 0613): hostnames and clients, no client's records. */
  REGISTRY: D1Database;
  /** The environment this deployment holds: `live` or `staging`. */
  COS_HOST_ENVIRONMENT: string;
  /** The fleet's own domain: nothing under its registrable domain is served here. */
  COS_FLEET_DOMAIN: string;
}

/** The client a request is served for: fixed by cos-front from the registry's row. */
export interface FrontClient {
  readonly id: ClientId;
  readonly environment: ClientEnvironmentName;
  /** The verified web hostname the request reached. */
  readonly hostname: string;
}

/**
 * What serves a client's web hostname once cos-front has decided the client.
 *
 * Stage 75 step 5 implements this to serve the client's published version: by Worker Loader (the
 * version's code loaded with an id made from the client and the version, its files from the
 * version store, the host reached through a `ClientApp` stub minted with the client fixed in its
 * props) or by the client's namespace Worker (uploaded at publish with the client fixed on its
 * `HOST` binding), whichever the spike chooses. Either way:
 * - it takes the client from `client` only, never from `request` (whose client-naming headers
 *   cos-front has already removed);
 * - it reaches no other client's data, holds no secret of ours and opens no database;
 * - its response passes through `withFrontHeaders`, which adds the security headers a response
 *   lacks (a target may set a stricter policy of its own; cos-front never loosens one it sets).
 */
export interface WebTarget {
  /** A name for logs: `holding-page`, later `published-version`. */
  readonly name: string;
  serve(request: Request, client: FrontClient): Promise<Response>;
}

/**
 * Headers a request may carry that could name a client or another host: removed before the
 * target sees the request. Anything named `cos-…` or `x-cos-…`, and the forwarding headers.
 */
const CLIENT_NAMING_HEADERS = new Set([
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-server",
  "x-host",
  "x-original-host",
  "x-original-url",
  "x-rewrite-url",
]);

export function isClientNamingHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    CLIENT_NAMING_HEADERS.has(lower) || lower.startsWith("cos-") || lower.startsWith("x-cos-")
  );
}

/** A copy of `request` with every client-naming header removed. */
export function frontRequest(request: Request): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!isClientNamingHeader(name)) headers.append(name, value);
  }
  return new Request(request, { headers });
}

/** Why a hostname is served nothing, or the client it is served for. */
export type FrontLookup =
  | { client: FrontClient }
  | { refused: "unknown" }
  | { refused: "unavailable" };

/**
 * The client a request's hostname is a verified web hostname of, in this deployment's
 * environment: one exact lookup of the registry. Nothing is derived from the hostname's text.
 */
export async function lookUpWebHostname(env: FrontEnv, host: string): Promise<FrontLookup> {
  const hostname = canonicalHostname(host);
  const fleet = canonicalHostname(env.COS_FLEET_DOMAIN);
  // Fail closed on a deployment with no fleet domain: it would know nothing to keep off.
  if (!hostname || !fleet) return { refused: "unknown" };
  if (isUnder(hostname, registrableDomain(fleet))) return { refused: "unknown" };
  const row = await env.REGISTRY.prepare(
    "SELECT h.client AS client, c.environment AS environment, c.status AS status FROM registry_hostnames h JOIN registry_clients c ON c.id = h.client WHERE h.hostname = ? AND h.surface = 'web' AND h.verified = 1",
  )
    .bind(hostname)
    .first<{ client: string; environment: string; status: string }>();
  if (!row || !isClientId(row.client) || row.environment !== env.COS_HOST_ENVIRONMENT) {
    return { refused: "unknown" };
  }
  if (row.status !== "active") return { refused: "unavailable" };
  return {
    client: {
      id: row.client,
      environment: row.environment as ClientEnvironmentName,
      hostname,
    },
  };
}

// --- The holding page (this step's only target) ---------------------------------------------

const HOLDING_STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}";

/** The SHA-256 of a style, as a content security policy names it. */
async function styleHash(style: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

/** The policy of cos-front's own pages: nothing but their one inline style. */
export async function ownPagePolicy(): Promise<string> {
  return [
    "default-src 'none'",
    `style-src ${await styleHash(HOLDING_STYLE)}`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The built-in target: a plain page saying the site is being set up, with nothing of the client
 * in it (not its name, not its id) and nothing read from its data. GET and HEAD only.
 */
export const holdingPage: WebTarget = {
  name: "holding-page",
  async serve(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
      });
    }
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coming soon</title><style>${HOLDING_STYLE}</style></head><body><h1>Coming soon</h1><p>This site is being set up. Please come back soon.</p></body></html>`;
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": await ownPagePolicy(),
      },
    });
  },
};

// --- Headers and the entry ------------------------------------------------------------------

/**
 * `response` with the security headers it lacks: `X-Content-Type-Options: nosniff`,
 * `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a content
 * security policy of `frame-ancestors 'none'` when it has none. A header the response already
 * sets is kept (a target's own policy is its own; cos-front adds, never loosens).
 */
export async function withFrontHeaders(
  response: Response,
  policy?: string,
): Promise<Response> {
  const out = new Response(response.body, response);
  const set = (name: string, value: string) => {
    if (!out.headers.has(name)) out.headers.set(name, value);
  };
  set("x-content-type-options", "nosniff");
  set("referrer-policy", "strict-origin-when-cross-origin");
  set("x-frame-options", "DENY");
  set("content-security-policy", policy ?? "frame-ancestors 'none'");
  return out;
}

/** cos-front's `fetch`: the client from the registry, then the target, with its headers. */
export async function frontFetch(
  request: Request,
  env: FrontEnv,
  target: WebTarget = holdingPage,
): Promise<Response> {
  let lookup: FrontLookup;
  try {
    lookup = await lookUpWebHostname(env, new URL(request.url).hostname);
  } catch (error) {
    // A registry failure is told as nothing about it: logged here, the same page to everyone.
    console.error("cos.front.registry_failed", (error as Error).message);
    return withFrontHeaders(beingUpdatedResponse(request), await ownPagePolicy());
  }
  if ("refused" in lookup) {
    return withFrontHeaders(
      lookup.refused === "unknown" ? unknownHostResponse() : beingUpdatedResponse(request),
      await ownPagePolicy(),
    );
  }
  return withFrontHeaders(await target.serve(frontRequest(request), lookup.client));
}
