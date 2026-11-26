// cos-app's front door for MCP (ADR 0021, ADR 0032). `workers-oauth-provider` serves OAuth 2.1
// (metadata, dynamic client registration, token, revocation) and checks Bearer tokens on /mcp;
// /oauth/consent is our authorization page; everything else goes to TanStack Start.
//
// /mcp uses the Agents SDK's stateless Streamable HTTP handler with an MCP SDK v2 server built
// per request. The protocol has no sessions, so the MCP session is the connected app: one
// row in core_connected_app per authorization, whose id is in the token's props.

import {
  getOAuthApi,
  OAuthError,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { IdentityEnv } from "@composable-os/auth";
import {
  bindConnectionGrant,
  isGrantActive,
  loadConnection,
  loadPackRole,
  loadSupportGrant,
  parseFloor,
  type RateLimitBinding,
  RateLimitedError,
  rateLimit,
  scopePermissions,
  touchConnection,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { perClientMissing } from "@composable-os/db/client-entries";
import { clientOf, withOAuthHelpers } from "@composable-os/db/client-environment";
import { productName } from "@composable-os/product";
import { product } from "@composable-os/products/active";
import { createMcpHandler } from "agents/mcp/server";
import { actingUserOf } from "../acting-user.ts";
import { aiContextFor } from "../ai.ts";
import { approvalExpiryDays } from "../approval-expiry.ts";
import { blobStoreFor, integrationRuntimeFor } from "../integrations.ts";
import {
  automationWiring,
  ensureShippedExtensions,
  extensionHostFor,
  type OperationsEnv,
} from "../operations.ts";
import { CONSENT_PATH, handleConsent, type McpProps } from "./consent.ts";
import { createCrmMcpServer, type McpCaller } from "./tools.ts";

export const MCP_PATH = "/mcp";

export interface McpEnv extends IdentityEnv, OperationsEnv {
  OAUTH_KV: KVNamespace;
  APPROVAL_EXPIRY_DAYS?: string;
  /** Every /mcp request, per connected app (Workers Rate Limiting, ADR 0091). */
  MCP_RATE_LIMIT?: RateLimitBinding;
  /** Non-read operations over MCP, per connected app. */
  MCP_WRITE_RATE_LIMIT?: RateLimitBinding;
  MCP_ACCESS_TOKEN_TTL?: string;
  /** The public /mcp URL tokens are bound to. Default: this request's origin + /mcp. */
  MCP_RESOURCE?: string;
}

const REFRESH_TOKEN_TTL = 30 * 24 * 3600;

function int(value: string | undefined, fallback: number, min = 1): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function bearerError(status: number, error: string, description: string, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set("www-authenticate", `Bearer error="${error}", error_description="${description}"`);
  return Response.json({ error, error_description: description }, { status, headers: h });
}

/** JSON-RPC error body, so MCP clients show the message. */
function rpcError(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message } },
    { status, headers },
  );
}

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** /mcp, after the provider has verified the Bearer token. */
export async function serveMcp(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext & { props?: unknown },
  clock: () => Date = () => new Date(),
): Promise<Response> {
  const props = (ctx.props ?? {}) as Partial<McpProps>;
  if (!props.connectionId) return bearerError(401, "invalid_token", "Token has no connection");
  const db = createCrmDb(env.DB);
  const connection = await loadConnection(db.query, props.connectionId);
  if (!connection || connection.revokedAt) {
    return bearerError(401, "invalid_token", "This app was disconnected. Connect it again.");
  }
  const row = await db.query
    .selectFrom("core_user")
    .select(["id", "email", "name", "role", "deactivated_at", "support_grant_id"])
    .where("id", "=", connection.userId)
    .executeTakeFirst();
  if (!row) return bearerError(401, "invalid_token", "The user no longer exists");
  if (row.deactivated_at) return bearerError(401, "invalid_token", "This account was deactivated");
  // A support user's connection lives no longer than its grant (ADR 0212).
  if (row.support_grant_id) {
    const grant = await loadSupportGrant(db.query, row.support_grant_id);
    if (!isGrantActive(grant)) return bearerError(401, "invalid_token", "Support access ended");
  }
  const user = actingUserOf(row);

  const now = clock().toISOString();
  // Keyed per connected app, so refreshing a token does not reset the budget (ADR 0091).
  const requests = await rateLimit(env.MCP_RATE_LIMIT, connection.id);
  if (!requests.ok) {
    return rpcError(
      429,
      `Rate limit: this connection is making too many requests. Retry in ${requests.retryAfterSeconds}s.`,
      { "retry-after": String(requests.retryAfterSeconds) },
    );
  }
  ctx.waitUntil(touchConnection(db.query, connection.id, now).catch(() => {}));

  await ensureShippedExtensions(env);
  const extensionHost = extensionHostFor(env);
  const integrations = integrationRuntimeFor(env);
  const blobs = blobStoreFor(env);
  // What the account's pack role (ADR 0436) lets the MCP tool list show.
  const packRole = await loadPackRole(db.query, user.id);
  const caller: McpCaller = {
    packRole,
    context: {
      ...(integrations ? { integrations } : {}),
      ...(blobs ? { blobs } : {}),
      actor: "mcp",
      user,
      origin: {
        surface: "mcp",
        clientId: connection.clientId,
        clientName: connection.clientName,
        sessionId: connection.id,
      },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      grantedPermissions: scopePermissions(connection.scopes),
      approvalExpiryDays: approvalExpiryDays(env.APPROVAL_EXPIRY_DAYS),
      ...(extensionHost ? { extensionHost } : {}),
      ...automationWiring(env),
      ...aiContextFor(env, db),
    },
    async consumeWrite() {
      const writes = await rateLimit(env.MCP_WRITE_RATE_LIMIT, connection.id);
      if (!writes.ok) {
        throw new RateLimitedError(
          `Rate limit: this connection is making too many changes. Retry in ${writes.retryAfterSeconds}s.`,
          { retryAfterSeconds: writes.retryAfterSeconds },
        );
      }
    },
  };
  const handler = createMcpHandler(() => createCrmMcpServer(caller, APP_VERSION), {
    route: MCP_PATH,
  });
  return handler(request, env, ctx);
}

interface Fallback {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Response | Promise<Response>;
}

export function oauthOptions(
  origin: string,
  env: McpEnv,
  fallback: Fallback,
): OAuthProviderOptions<McpEnv> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: (request, env, ctx) => serveMcp(request, env as McpEnv, ctx),
    },
    defaultHandler: {
      fetch: (request, env, ctx) => {
        const e = env as McpEnv & { OAUTH_PROVIDER: OAuthHelpers };
        if (new URL(request.url).pathname === CONSENT_PATH) {
          return handleConsent(request, e, e.OAUTH_PROVIDER);
        }
        return fallback.fetch(request, e, ctx);
      },
    },
    authorizeEndpoint: CONSENT_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["read", "write", "admin"],
    accessTokenTTL: int(env.MCP_ACCESS_TOKEN_TTL, 3600, 60),
    refreshTokenTTL: REFRESH_TOKEN_TTL,
    resourceMetadata: {
      resource: env.MCP_RESOURCE || `${origin}${MCP_PATH}`,
      resource_name: `${productName(product)}`,
    },
    // Code exchange binds the provider's grant to the connected app; every refresh checks the
    // connection is still live, so revoking it also kills its refresh token.
    tokenExchangeCallback: async (options) => {
      const props = (options.props ?? {}) as Partial<McpProps>;
      if (!props.connectionId) return;
      const db = createCrmDb(options.env.DB);
      const connection = await loadConnection(db.query, props.connectionId);
      if (!connection || connection.revokedAt) {
        throw new OAuthError("invalid_grant", { description: "This app was disconnected" });
      }
      if (!connection.grantId) await bindConnectionGrant(db.query, connection.id, options.grantId);
    },
  };
}

/** The OAuth helpers outside a request the provider routed (e.g. revoking a grant from the UI). */
export function oauthApi(env: McpEnv, origin = "https://localhost"): OAuthHelpers {
  return getOAuthApi(oauthOptions(origin, env, { fetch: () => new Response(null) }), env);
}

/** Deletes a revoked connection's tokens from the provider's store (best effort). */
export async function deleteGrantTokens(
  env: McpEnv,
  grantId: string | null,
  userId: string,
): Promise<void> {
  if (!grantId || !env.OAUTH_KV) return;
  try {
    await oauthApi(env).revokeGrant(grantId, userId);
  } catch (error) {
    console.warn("could not revoke OAuth grant", grantId, error);
  }
}

/** The paths the OAuth provider answers itself (and /mcp), whose issuer and resource matter. */
function isOAuthPath(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith(`${MCP_PATH}/`) ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-")
  );
}

/** A client's environment with its OAuth helpers, one per client environment and origin. */
const oauthEnvs = new WeakMap<object, Map<string, McpEnv>>();

/**
 * The `env` the OAuth library is handed. A single-client deployment's own `env`, on which the
 * library sets its helpers itself, as before; a client's environment on a many-client host is
 * frozen, so its helpers (over its own OAUTH_KV) are made here and set beside it (stage 66,
 * ADR 0615).
 */
function oauthEnv(env: McpEnv, origin: string, fallback: Fallback): McpEnv {
  if (clientOf(env) === null) return env;
  let byOrigin = oauthEnvs.get(env);
  if (!byOrigin) {
    byOrigin = new Map();
    oauthEnvs.set(env, byOrigin);
  }
  let withHelpers = byOrigin.get(origin);
  if (!withHelpers) {
    withHelpers = withOAuthHelpers(env, getOAuthApi(oauthOptions(origin, env, fallback), env));
    byOrigin.set(origin, withHelpers);
  }
  return withHelpers;
}

/** Wraps the app's fetch handler with OAuth and /mcp. One provider per origin, per isolate. */
export function createAppHandler(fallback: Fallback) {
  const providers = new Map<string, OAuthProvider<McpEnv>>();
  return {
    fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
      const origin = new URL(request.url).origin;
      // On a many-client host the MCP issuer and resource are the client's own address, from its
      // environment (MCP_RESOURCE, from its staff hostname, ADR 0616), never the request's: a
      // client with none has OAuth and /mcp answer that they are not available. Every other path
      // goes on as before.
      if (clientOf(env) !== null && isOAuthPath(new URL(request.url).pathname)) {
        const missing = perClientMissing(env, "MCP_RESOURCE");
        if (missing) {
          return Promise.resolve(
            Response.json(
              { error: "temporarily_unavailable", error_description: missing },
              { status: 503 },
            ),
          );
        }
      }
      // By client and origin (review of #512, M4): a hostname the registry gives another client
      // gets that client's token lifetime and resource address, never the first one's.
      const cacheKey = `${clientOf(env) ?? ""} ${origin}`;
      let provider = providers.get(cacheKey);
      if (!provider) {
        provider = new OAuthProvider<McpEnv>(oauthOptions(origin, env, fallback));
        providers.set(cacheKey, provider);
      }
      return provider.fetch(request, oauthEnv(env, origin, fallback), ctx);
    },
  };
}
