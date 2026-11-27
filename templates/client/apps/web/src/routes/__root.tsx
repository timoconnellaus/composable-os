import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { RouterContext } from "../screen-host/index.ts";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Welcome" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Layout,
  // The server build draws the whole document; the browser build's is its index.html.
  ...(__COS_BROWSER_BUILD__ ? {} : { shellComponent: Document }),
});

/** Every page's frame, in both builds. */
function Layout() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        margin: "0 auto",
        maxWidth: 640,
        padding: 16,
      }}
    >
      <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <Link to="/">Home</Link>
        <Link to="/account">Your account</Link>
      </nav>
      <Outlet />
    </div>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ margin: 0 }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
