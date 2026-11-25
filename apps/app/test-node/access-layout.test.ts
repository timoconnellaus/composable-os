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
      // Stage 43 step 3 (ADR 0581): practitioners sign in outside Access, as customers do.
      isPractitionerAuthPath: "/api/practitioner-auth/sign-in/email-otp",
      NATIVE_STAFF_SIGN_IN_PATH: "/native/staff-sign-in",
      // Stage 28 (ADR 0444): staff upload and view pictures here. Outsiders are served them at
      // /api/v1/media/<id> (the bypassed surface, below) or through the client-app binding.
      isMediaPath: "/api/media/med_1",
      // Stage 44 step 4 (ADR 0645): staff download a signed PDF here; a customer at
      // /api/v1/agreements/… (the bypassed surface) or through the client-app binding.
      isAgreementPdfPath: "/api/agreements/acceptances/aga_1.pdf",
      // Stage 45 step 5 (ADR 0628): a staff member's calendar feed, which a calendar app polls
      // with no sign-in: bypassed, authenticated by the token in its address.
      isStaffFeedPath: "/api/v1/staffing/feed/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics",
      // Stage 62 step 1 (ADR 0890): a customer's calendar feed, the same way.
      isCustomerFeedPath: "/api/v1/me/feed/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics",
      // Stage 44 step 6 (ADR 0649): the desk's paths, not found on the staff hostname; the desk
      // origin is a hostname of its own, outside this Access application.
      isDeskPath: "/desk",
      // Stage 29 step 4 (ADR 0728): a form's own page and a personal link's, public, drawn as
      // HTML; the page's calls go through the client-app binding's door.
      isFormPagePath: "/f/ask-about-a-trial",
    };

    expect([...dispatched].sort()).toEqual(Object.keys(known).sort());
    expect(Object.fromEntries(Object.entries(known).map(([k, p]) => [k, classify(p)]))).toEqual({
      isSupportRoute: "staff",
      SOCKET_PATH: "staff",
      isApiPath: "bypass",
      isCustomerAuthPath: "bypass",
      isPractitionerAuthPath: "bypass",
      NATIVE_STAFF_SIGN_IN_PATH: "staff",
      isMediaPath: "staff",
      isAgreementPdfPath: "staff",
      isStaffFeedPath: "bypass",
      isCustomerFeedPath: "bypass",
      isDeskPath: "staff",
      isFormPagePath: "bypass",
    });
    // A personal link's page is the other path of the form page; the staff app has neither.
    expect(bypassFor("/form")?.path).toBe("/form");
    expect(bypassFor("/f/ask-about-a-trial")?.path).toBe("/f/*");
    expect(bypassFor("/forms")).toBeNull();
    // The feed's bypass is its own entry (it says how the feed authenticates), and nothing of the
    // staff app is under it.
    expect(bypassFor("/api/v1/staffing/feed/x.ics")?.path).toBe("/api/v1/staffing/feed/*");
    expect(bypassFor("/api/v1/staffing/feed")?.path).toBe("/api/v1/staffing/feed/*");
    expect(bypassFor("/api/v1/staffing/feeds")?.path).toBe("/api/v1/*");
    expect(bypassFor("/api/v1/me/feed/x.ics")?.path).toBe("/api/v1/me/feed/*");
    expect(bypassFor("/api/v1/me/feed")?.path).toBe("/api/v1/me/feed/*");
    // Every version of the surface, and every native sign-in route, is the bypassed surface.
    for (const path of [
      "/api/v1/manifest",
      // A picture for a phone or anyone outside, on the host's own hostname (issue #181).
      "/api/v1/media/med_1",
      // An upload by a staff device token (cos content import, ADR 0470): the bypassed surface.
      "/api/v1/media",
      // A customer's own signed PDF (ADR 0645), as me.agreements.pdf decides.
      "/api/v1/agreements/acceptances/aga_1.pdf",
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
