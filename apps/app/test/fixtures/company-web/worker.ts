// A company's web app (stage 24), as the client template builds it: the template's own host module
// (templates/client/apps/web/src/host.ts), in a Worker of its own with a service binding to the
// host's ClientApp entrypoint and no database, bucket, KV or secret. Only the pages are left out:
// TanStack Start renders them in the real template, from the same functions.
//
//   POST /auth/code, /auth/sign-in, /auth/sign-out   the template's sign-in routes
//   GET  /account                                     the signed-in page: the name from me.get
//   GET  /                                            the public page
//   GET  /api/media/<id>                              the template's media route (issue #181)
//   GET  /api/v1/agreements/acceptances/<id>.pdf      a signed agreement's PDF (stage 44)
//   GET, POST /stop                                   the one-tap stop (stage 30)
//   POST /passthrough/api/v1/op/<name>                 NOT the template: a careless proxy that
//                                                     forwards the browser's request, headers and
//                                                     all, to the host (review of PR #459, M2)
//
// Bundled by the app's vitest config with esbuild and run as an auxiliary Worker.
import {
  agreementPdfRoute,
  authRoute,
  type HostEnv,
  mediaRoute,
  operationRoute,
  signedInCustomer,
  stopRoute,
  withSessionKept,
} from "../../../../../templates/client/apps/web/src/host.ts";

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const auth = await authRoute(request, env);
    if (auth) return auth;
    // The browser's typed-client calls (ADR 0451): these two only.
    const call = await operationRoute(request, env, { allow: ["me.get", "me.update"] });
    if (call) return call;
    const picture = await mediaRoute(request, env);
    if (picture) return picture;
    const stop = await stopRoute(request, env);
    if (stop) return stop;
    const pdf = await agreementPdfRoute(request, env);
    if (pdf) return withSessionKept(request, env, pdf);
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/passthrough/")) {
      return env.HOST.fetch(`https://host${pathname.slice("/passthrough".length)}`, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
    }
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
