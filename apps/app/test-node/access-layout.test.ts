// The Access layout (ADR 0455, src/server/access-layout.ts) against cos-app's route table: every
// route the host serves is either staff-only behind Access or a bypassed path that authenticates
// by its own means. A route added anywhere (a file route, a dispatch in src/server.ts, an OAuth
// endpoint, a gatekeeper vendor) that is in neither list fails here, so it cannot be forgotten.
//
// The route table is read from the sources the Worker is built from: TanStack Start's generated
// route tree, the entry's own dispatch (src/server.ts), the MCP/OAuth handler's endpoints and the
// integrations catalogue.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_BYPASS,
  ACCESS_STAFF,
  bypassFor,
  GATEKEEPER_ROUTES,
  matchesLayout,
} from "../src/server/access-layout.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** A route path as a concrete example path (`$id` and the splat filled in). */
const example = (route: string) =>
  route
    .replace(/\/\$$/, "/anything")
    .replace(/\$[a-zA-Z]+/g, "x")
    .replace(/\/$/, "") || "/";

const staff = (pathname: string) => ACCESS_STAFF.some((e) => matchesLayout(e.path, pathname));

/**
 * What the layout says of a path. A bypass is more specific than the staff entries it sits under
 * (Access applies the most specific application's path), so it wins.
 */
function classify(pathname: string): "bypass" | "staff" | "unaccounted" {
  if (bypassFor(pathname) !== null) return "bypass";
  return staff(pathname) ? "staff" : "unaccounted";
}

describe("every route of cos-app is accounted for behind Access", () => {
  it("TanStack Start's file routes", () => {
    const tree = read("../src/routeTree.gen.ts");
    const block = /export interface FileRoutesById \{([\s\S]*?)\n\}/.exec(tree)?.[1] ?? "";
    const ids = [...block.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThan(30);
    const unaccounted: string[] = [];
    for (const id of ids) {
      // The `_app` layout's pages are the staff app: its layout requires a staff principal.
      if (id === "/_app" || id.startsWith("/_app/")) continue;
      // The gatekeeper splat is split by vendor below.
      if (id === "/gatekeeper/$") continue;
      const verdict = classify(example(id));
      if (verdict === "unaccounted") unaccounted.push(`${id}: ${verdict}`);
    }
    expect(unaccounted).toEqual([]);
    // The staff app's pages are not under any bypass.
    for (const id of ids.filter((i) => i.startsWith("/_app/"))) {
      const path = example(id.slice("/_app".length));
      expect(bypassFor(path), id).toBeNull();
    }
  });

  it("the Worker entry's own dispatch (src/server.ts), before TanStack Start", () => {
    const server = read("../src/server.ts");
    const dispatched = new Set([
      ...[...server.matchAll(/if \((\w+)\(pathname\)\)/g)].map((m) => m[1] as string),
      ...[...server.matchAll(/pathname === (\w+)/g)].map((m) => m[1] as string),
    ]);
    // Each dispatch the entry makes, and the path it serves. A new one must be added here, and so
    // classified.
    const known: Record<string, string> = {
      isSupportRoute: "/support/enter",
      SOCKET_PATH: "/api/assistant/socket",
      isApiPath: "/api/v1/op/me.get",
      isCustomerAuthPath: "/api/customer-auth/sign-in/email-otp",
      NATIVE_STAFF_SIGN_IN_PATH: "/native/staff-sign-in",
    };
    expect([...dispatched].sort()).toEqual(Object.keys(known).sort());
    expect(Object.fromEntries(Object.entries(known).map(([k, p]) => [k, classify(p)]))).toEqual({
      isSupportRoute: "staff",
      SOCKET_PATH: "staff",
      isApiPath: "bypass",
      isCustomerAuthPath: "bypass",
      NATIVE_STAFF_SIGN_IN_PATH: "staff",
    });
    // Every version of the surface, and every native sign-in route, is the bypassed surface.
    for (const path of [
      "/api/v1/manifest",
      "/api/v1/auth/customer/sign-in",
      "/api/v1/auth/staff/exchange",
      "/api/v1/auth/sign-out",
    ]) {
      expect(classify(path), path).toBe("bypass");
    }
  });

  it("the MCP and OAuth endpoints", () => {
    const handler = read("../src/server/mcp/handler.ts");
    const endpoints = [...handler.matchAll(/Endpoint: "([^"]+)"/g)].map((m) => m[1] as string);
    expect(endpoints.sort()).toEqual(["/oauth/register", "/oauth/token"]);
    for (const path of [...endpoints, "/mcp", "/.well-known/oauth-authorization-server"]) {
      expect(classify(path), path).toBe("bypass");
    }
    expect(read("../src/server/mcp/consent.ts")).toContain('CONSENT_PATH = "/oauth/consent"');
    expect(classify("/oauth/consent")).toBe("staff");
  });

  it("every gatekeeper vendor: provider pushes bypassed, browser routes behind Access", () => {
    const catalogue = read("../../../packages/core/src/integrations/catalogue.ts");
    const vendors = [...catalogue.matchAll(/^\s{4}vendor: "([^"]+)"/gm)].map((m) => m[1] as string);
    expect(vendors.length).toBeGreaterThan(8);
    expect(Object.keys(GATEKEEPER_ROUTES).sort()).toEqual([...vendors].sort());
    const gatekeeperBypass = ACCESS_BYPASS.filter((e) => e.path.startsWith("/gatekeeper/")).map(
      (e) => e.path,
    );
    expect(gatekeeperBypass.sort()).toEqual(Object.values(GATEKEEPER_ROUTES).flat().sort());
    for (const vendor of vendors) {
      // A connect popup and an OAuth callback stay behind Access.
      expect(classify(`/gatekeeper/${vendor}/oauth`), vendor).toBe("staff");
    }
    expect(classify("/gatekeeper/fake/cron")).toBe("staff");
    expect(classify("/gatekeeper/payments/fake/state")).toBe("staff");
  });

  it("what is bypassed says how it authenticates, and the framework's own paths are listed", () => {
    for (const entry of ACCESS_BYPASS)
      expect(entry.authenticates.length, entry.path).toBeGreaterThan(20);
    expect(classify("/_serverFn/abc")).toBe("bypass");
    expect(classify("/assets/index-abc.js")).toBe("bypass");
  });
});
