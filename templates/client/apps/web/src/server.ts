// This web app's Worker: the sign-in routes (src/host.ts) first, then TanStack Start for pages.
import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { authRoute, type HostEnv, withSessionKept } from "./host.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const host = env as unknown as HostEnv;
    const auth = await authRoute(request, host);
    if (auth) return auth;
    return withSessionKept(request, host, await handler.fetch(request));
  },
};
