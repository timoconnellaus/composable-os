// TanStack Start instance. The identity middleware runs for every request: page routes, server
// routes (/api/*) and server function calls. It resolves the Principal through the deploy-time
// identity adapter (ADR 0008) and puts it on the request context.
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import { ForbiddenError } from "@composable-os/core";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { authorize, refusesFixedRole } from "./server/identity.ts";

export const identityMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, next, handlerType, serverFnMeta }) => {
    const result = await authorize(request, env, {
      handlerType,
      serverFnFile: serverFnMeta?.filename,
    });
    if (!result.ok) return result.response;
    return next({ context: { principal: result.principal } });
  },
);

/** Server functions are same-origin RPC: reject cross-site calls before anything else runs. */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Every server function's own check (stage 47, ADR 0660): an account holding a pack role calls
 * only its session's and the operations' (which the pipeline holds to its role). Here, unlike the
 * request middleware, the function's file is known.
 */
export const fixedRoleMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, context, serverFnMeta }) => {
    const principal = (context as unknown as { principal?: Principal | null }).principal ?? null;
    if (await refusesFixedRole(env, principal, serverFnMeta.filename)) {
      throw new ForbiddenError("This account's role does not reach this");
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, identityMiddleware],
  functionMiddleware: [fixedRoleMiddleware],
}));
