// Identity enforcement for every request. The TanStack Start request middleware (src/start.ts)
// calls `authorize()` for every route and server function; this module stays framework-free so it
// can be tested directly in workerd.
import { createIdentityProvider, type IdentityEnv, type Principal } from "@composable-os/auth";
import { type SupportEnv, supportPrincipal } from "./support.ts";

/** Paths anyone may load. Everything else needs a Principal. */
// /buy: the host's plain checkout start (stage 25), for buyers who have no account.
// /blocks: a pack's web block mounted on its own (stage 41), in development only (a production
// build mounts nothing there); the block's calls go to /api/v1/op as whoever the cookie says.
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
const PUBLIC_PATHS = new Set(["/sign-in", "/api/health", "/buy"]);
const DEV_PUBLIC_PATHS = new Set(["/blocks"]);
// /gatekeeper/: OAuth redirects, connect pages and provider pushes (stage 6a); each gatekeeper
// authenticates its own routes with nonces and signatures. /order/: a guest's order page, opened
// by the order's token (stage 25); the page shows nothing without it.
const PUBLIC_PREFIXES = ["/api/auth/", "/gatekeeper/", "/order/"];

/**
 * Server functions callable without a Principal live in files named `*.public.ts`. Every other
 * server function is denied to anonymous callers, so a new one is private by default.
 */
const PUBLIC_SERVER_FN_FILE = /\.public\.tsx?$/;

export interface RequestKind {
  handlerType: "serverFn" | "router";
  serverFnFile?: string | undefined;
}

export type AuthorizeResult =
  | { ok: true; principal: Principal | null }
  | { ok: false; response: Response };

/** `dev`: whether this is a development server (Vite's), where `/blocks` is open too. */
export function isPublicPath(pathname: string, dev = DEV): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    (dev && DEV_PUBLIC_PATHS.has(pathname)) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export async function authorize(
  request: Request,
  env: IdentityEnv & Pick<SupportEnv, "COS_SUPPORT_PUBLIC_KEY">,
  kind: RequestKind,
): Promise<AuthorizeResult> {
  // Hosted support access (ADR 0212): a valid `cos_support` cookie for a grant that is still
  // approved and unexpired makes the request the grant's support user. Anything else about the
  // cookie is ignored.
  const support = await supportPrincipal(request, env);
  if (support) return { ok: true, principal: support };

  const provider = createIdentityProvider(env);
  const principal = await provider.resolve(request);
  if (principal) return { ok: true, principal };

  const url = new URL(request.url);
  if (kind.handlerType === "serverFn") {
    if (kind.serverFnFile && PUBLIC_SERVER_FN_FILE.test(kind.serverFnFile)) {
      return { ok: true, principal: null };
    }
    return { ok: false, response: unauthorized() };
  }
  if (isPublicPath(url.pathname)) return { ok: true, principal: null };
  if (url.pathname.startsWith("/api/")) return { ok: false, response: unauthorized() };

  if (provider.signInPath) {
    const target = new URL(provider.signInPath, url);
    target.searchParams.set("redirect", url.pathname + url.search);
    return { ok: false, response: Response.redirect(target.toString(), 302) };
  }
  // Cloudflare Access sits in front of the Worker, so a request without a valid JWT got past
  // Access some other way (e.g. the workers.dev URL). Never serve it.
  return { ok: false, response: unauthorized() };
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
