// This web app's Worker: the sign-in routes and the browser's operation route (src/host.ts)
// first, then TanStack Start for pages.
import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { authRoute, type HostEnv, operationRoute, withSessionKept } from "./host.ts";

/**
 * The operations code running in the browser (a block, an island) may call through
 * /api/v1/op/<name>. Name each one a page needs; pages rendered on the server call the host
 * directly (customerApi) and need no entry here.
 */
const BROWSER_OPERATIONS = ["me.get"] as const;

export default {
  async fetch(request: Request): Promise<Response> {
    const host = env as unknown as HostEnv;
    const auth = await authRoute(request, host);
    if (auth) return auth;
    const call = await operationRoute(request, host, { allow: BROWSER_OPERATIONS });
    if (call) return call;
    return withSessionKept(request, host, await handler.fetch(request));
  },
};
