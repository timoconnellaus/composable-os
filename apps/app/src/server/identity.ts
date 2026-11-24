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
  if (principal) {
    // Server functions are judged by `refusesFixedRole` in their own middleware (start.ts): only
    // there is the function's file known.
    if (kind.handlerType === "router" && !packRoleMayReach(new URL(request.url).pathname)) {
      if (await holdsPackRole(env.DB, principal)) return { ok: false, response: forbidden() };
    }
    return { ok: true, principal };
  }

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

/**
 * What an account holding a pack role (a coach, the door, a rostered cleaner; ADR 0436) may reach
 * besides the admin's pages, whose layout shows it only its screens (stage 47, ADR 0660): its
 * session (`session.public.ts`), operations (`call-operation.ts`, which the pipeline holds to the
 * role: its tools, its reads and `screens.mine`), sign-in and sign-out (`/api/auth/*`) and the
 * health check. Every other server function and `/api/*` route (the assistant's, system status, the
 * hello workflow) is refused before its handler runs: routes here, server functions by
 * `refusesFixedRole` in the middleware every server function runs (start.ts).
 */
const PACK_ROLE_SERVER_FN = /(?:^|\/)src\/server\/(?:session\.public|call-operation)\.ts$/;
const PACK_ROLE_API = ["/api/auth/", "/api/health"];

/** Whether a pack-role account may reach this path (pages yes; of `/api/*`, the short list). */
export function packRoleMayReach(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return PACK_ROLE_API.some((p) => pathname.startsWith(p));
  return true;
}

/** Whether a pack-role account may call the server functions of this file (src-relative path). */
export function packRoleMayCallServerFn(filename: string | undefined): boolean {
  return PACK_ROLE_SERVER_FN.test(filename ?? "");
}

/**
 * Whether to refuse this server function to the signed-in account: it holds a pack role and the
 * function is not one it may call. One read, only for a function outside the short list.
 */
export async function refusesFixedRole(
  env: { DB: D1Database },
  principal: Principal | null,
  filename: string | undefined,
): Promise<boolean> {
  if (!principal || packRoleMayCallServerFn(filename)) return false;
  return holdsPackRole(env.DB, principal);
}

/** Whether the signed-in account holds a pack role. */
async function holdsPackRole(db: D1Database, principal: Principal): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT pack_role FROM core_user WHERE kind = 'human' AND (id = ?1 OR lower(email) = ?2)
       ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
    )
    .bind(principal.userId, principal.email.trim().toLowerCase())
    .first<{ pack_role: string | null }>();
  return Boolean(row?.pack_role);
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
