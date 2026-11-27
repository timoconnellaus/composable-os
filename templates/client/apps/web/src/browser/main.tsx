// The browser build's entry (stage 75 step 2, ADR 0960): the same routes as the server build
// (src/routes/, src/routeTree.gen.ts), routed by the address's hash (`#/account`), so the files
// can be served from any folder with no server behind them and a reload never asks a server for
// a route. The screens reach the host over /api/v1 with tokens (src/screen-host/tokens.ts).
//
// Where the host is: COS_HOST_URL at build time, or, with none, the page's own origin (the screens
// served from the host's own address).
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "../routeTree.gen.ts";
import { tokenScreenHost } from "../screen-host/tokens.ts";
import "../styles.css";

/** Whether the host has said these screens are older than any contract it still serves. */
const outdated = {
  is: false,
  listeners: new Set<() => void>(),
  set() {
    outdated.is = true;
    for (const listener of outdated.listeners) listener();
  },
  subscribe(listener: () => void) {
    outdated.listeners.add(listener);
    return () => outdated.listeners.delete(listener);
  },
};

const screenHost = tokenScreenHost({
  hostUrl: __COS_HOST_URL__ || window.location.origin,
  // As the mobile app's onUpgradeRequired would: say so, and offer the newer screens. A browser
  // gets them by loading the page again (the published version, stage 75).
  onUpgradeRequired: () => outdated.set(),
});

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  context: { screenHost },
  scrollRestoration: true,
});

/** Shown over every screen once the host asks for newer screens (ADR 0417's upgrade_required). */
function UpgradeNotice() {
  const shown = useSyncExternalStore(
    outdated.subscribe,
    () => outdated.is,
    () => false,
  );
  if (!shown) return null;
  return (
    <div role="alert" style={{ padding: 16, background: "#fff3cd", fontFamily: "system-ui" }}>
      These pages are out of date.{" "}
      <button type="button" onClick={() => window.location.reload()}>
        Load the new version
      </button>
    </div>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("index.html has no #app");
createRoot(root).render(
  <StrictMode>
    <UpgradeNotice />
    <RouterProvider router={router} />
  </StrictMode>,
);
