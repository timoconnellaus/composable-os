// A company's web app (stage 24), as the client template builds it: the template's own host module
// (templates/client/apps/web/src/host.ts), in a Worker of its own with a service binding to the
// host's ClientApp entrypoint and no database, bucket, KV or secret. Only the pages are left out:
// TanStack Start renders them in the real template, from the same functions.
//
//   POST /auth/code, /auth/sign-in, /auth/sign-out   the template's sign-in routes
//   GET  /account                                     the signed-in page: the name from me.get
//   GET  /                                            the public page
//
// Bundled by the app's vitest config with esbuild and run as an auxiliary Worker.
import {
  authRoute,
  type HostEnv,
  operationRoute,
  signedInCustomer,
  withSessionKept,
} from "../../../../../templates/client/apps/web/src/host.ts";

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const auth = await authRoute(request, env);
    if (auth) return auth;
    // The browser's typed-client calls (ADR 0451): these two only.
    const call = await operationRoute(request, env, { allow: ["me.get", "me.update"] });
    if (call) return call;
    const { pathname } = new URL(request.url);
    if (pathname === "/account") {
      const me = await signedInCustomer(env, request);
      const page = me
        ? new Response(`Signed in as ${me.displayName}`)
        : new Response("Sign in to see your account", { status: 401 });
      return withSessionKept(request, env, page);
    }
    if (pathname === "/") return withSessionKept(request, env, new Response("Welcome"));
    return new Response("Not found", { status: 404 });
  },
};
