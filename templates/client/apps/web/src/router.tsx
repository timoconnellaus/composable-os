// The server build's router (TanStack Start): the routes in src/routes/, with the ScreenHost that
// reaches the host through this site's own routes and the customer's cookie. The browser build
// makes its own router from the same routes (src/browser/main.tsx).
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { cookieScreenHost } from "./screen-host/cookie.ts";

export function getRouter() {
  return createRouter({
    routeTree,
    context: { screenHost: cookieScreenHost() },
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
