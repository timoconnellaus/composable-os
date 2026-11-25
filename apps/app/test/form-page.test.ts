// The form page on the host (stage 29 step 4, ADR 0728, review of PR #461): what the host's
// handler passes to the page's calls, and who they are counted against (ADR 0940).
// - On the host's own address: the customer's cookie only (a staff session is dropped), and the
//   visitor is Cloudflare's `cf-connecting-ip`, never a `cos-visitor-address` the browser sent.
// - Over the binding: what the bound Worker forwarded, a `cf-connecting-ip` first.
// - A send from a sibling subdomain is refused before any call.
// The page itself is tested in packs/forms (page.test.ts) and against the real host in
// apps/runner (forms-page.test.ts); the template's route in company-web.test.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleBound, VISITOR_ADDRESS_HEADER } from "../src/server/http/bound.ts";
import {
  boundVisitor,
  type FormPageEnv,
  handleFormPage,
  hostVisitor,
} from "../src/server/http/form-page.ts";
import { boundTestEnv } from "./bound-env.ts";

const hostEnv = boundTestEnv(env) as FormPageEnv;

/** A door that records the page's calls and answers each as not found (no Forms here). */
function recordingDoor() {
  const calls: Request[] = [];
  return {
    calls,
    door: async (call: Request) => {
      calls.push(call);
      return Response.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      );
    },
  };
}

describe("the host's own address", () => {
  it("passes the customer's cookie only, and the connection's address, never the browser's word", async () => {
    const { calls, door } = recordingDoor();
    const page = await handleFormPage(
      new Request("https://crm.example/f/newsletter", {
        headers: {
          cookie:
            "better-auth.session_token=staff.sig; CF_Authorization=jwt; cos-customer.session_token=c.sig; cos-practitioner.session_token=p.sig",
          "cf-connecting-ip": "198.51.100.61",
          [VISITOR_ADDRESS_HEADER]: "192.0.2.250",
          authorization: "Bearer staff-token",
        },
      }),
      hostEnv,
      door,
      { address: "198.51.100.61", sameOrigin: "page" },
    );
    expect(page.status).toBe(404);
    expect(calls).toHaveLength(1);
    const sent = calls[0] as Request;
    expect(sent.headers.get("cookie")).toBe("cos-customer.session_token=c.sig");
    expect(sent.headers.get(VISITOR_ADDRESS_HEADER)).toBe("198.51.100.61");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("cf-connecting-ip")).toBeNull();
  });

  it("refuses a send from a sibling subdomain, with a signed-in customer's cookie, before any call", async () => {
    const { calls, door } = recordingDoor();
    const sent = await handleFormPage(
      new Request("https://crm.gym.example/f/newsletter", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: "cos-customer.session_token=c.sig",
          "sec-fetch-site": "same-site",
          origin: "null",
        },
        body: "a.news=yes",
      }),
      hostEnv,
      door,
      { address: "198.51.100.62", sameOrigin: "page" },
    );
    expect(sent.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("who the page's calls are counted against (ADR 0940)", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://host/f/ask-about-a-trial", { headers });

  it("on the host's own address: cf-connecting-ip, never a cos-visitor-address a browser sent", () => {
    expect(
      hostVisitor(
        request({ "cf-connecting-ip": "198.51.100.81", [VISITOR_ADDRESS_HEADER]: "192.0.2.250" }),
      ),
    ).toEqual({ address: "198.51.100.81", sameOrigin: "page" });
    expect(hostVisitor(request({ [VISITOR_ADDRESS_HEADER]: "192.0.2.250" })).address).toBeNull();
  });

  it("over the binding: a forwarded cf-connecting-ip first, then the visitor the Worker names", () => {
    expect(
      boundVisitor(
        request({ "cf-connecting-ip": "203.0.113.71", [VISITOR_ADDRESS_HEADER]: "203.0.113.72" }),
      ),
    ).toEqual({ address: "203.0.113.71", sameOrigin: "forwarded" });
    expect(boundVisitor(request({ [VISITOR_ADDRESS_HEADER]: "203.0.113.72" })).address).toBe(
      "203.0.113.72",
    );
  });

  it("the binding serves the page with its calls named for that visitor", async () => {
    // No Forms on this host: the page is the plain not-found answer, its call counted nowhere.
    const page = await handleBound(
      request({ "cf-connecting-ip": "203.0.113.71", authorization: "" }),
      hostEnv,
    );
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("This form is not open");
  });
});
