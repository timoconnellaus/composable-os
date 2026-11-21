import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Welcome" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => <Outlet />,
  shellComponent: Document,
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
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
        {children}
        <Scripts />
      </body>
    </html>
  );
}
