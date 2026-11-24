// Stage 44 step 6 and stage 51 step 1 (ADRs 0649 and 0780): the desk origin. Its own hostname for
// this Worker serves the tablet's two pages and the desk calls and nothing else; the staff origin
// serves none of them. Its cookies are HttpOnly, Secure, SameSite=Strict and host-only, and never
// in an answer's body; every desk call needs the desk origin's Origin and is refused with a staff
// session; the desk calls are not on the HTTP surface. All text here is fixture text.
import { createIdentityProvider } from "@composable-os/auth";
import { memoryRateLimit } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { deskOrigin, isDeskRequest } from "../src/server/desk.ts";
import { type ApiEnv, handleApi } from "../src/server/http/api.ts";
import {
  DESK_HEADERS,
  DEVICE_COOKIE,
  type DeskHandlerEnv,
  handleDesk,
  isDeskPath,
  SESSION_COOKIE,
} from "../src/server/http/desk.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { runOperation } from "../src/server/operations.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const DESK = "https://desk.crm.test";
const deskEnv = {
  ...testEnv(),
  DESK_HOSTNAME: "desk.crm.test",
  DESK_SECRET: "fixture-desk-secret-for-the-desk-origin-789",
  DESK_RATE_LIMIT: memoryRateLimit(10_000),
} as unknown as DeskHandlerEnv & McpEnv;

let admin: TestUser;

const page = async () =>
  new Response("<html>desk page</html>", { headers: { "content-type": "text/html" } });

function call(
  name: string,
  body: unknown = {},
  init: { cookie?: string; origin?: string | null; contentType?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/json",
    "user-agent": "Fixture tablet browser",
    "cf-connecting-ip": "192.0.2.20",
  };
  if (init.origin !== null) headers.origin = init.origin ?? DESK;
  if (init.cookie) headers.cookie = init.cookie;
  return handleDesk(
    new Request(`${DESK}/api/desk/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    deskEnv,
    page,
  );
}

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

async function staffOp(name: string, input: unknown) {
  const principal = await createIdentityProvider(deskEnv).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(deskEnv, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as Record<string, unknown>;
}

/** An enrolled tablet: its device cookie. */
async function enrol(): Promise<{ cookie: string; deviceId: string }> {
  const made = await staffOp("device.enrol", { name: unique("Desk tablet"), use: "signing" });
  const claimed = await call("device.claim", { code: made.code });
  expect(claimed.status).toBe(200);
  return {
    cookie: `${DEVICE_COOKIE}=${cookieValue(claimed, DEVICE_COOKIE)}`,
    deviceId: (made.device as { id: string }).id,
  };
}

beforeAll(async () => {
  admin = await signUp(deskEnv, "admin");
});

describe("the desk origin", () => {
  it("is its own hostname; the staff origin serves none of its paths", () => {
    expect(isDeskRequest(new Request(`${DESK}/desk`), deskEnv)).toBe(true);
    expect(isDeskRequest(new Request(`${ORIGIN}/desk`), deskEnv)).toBe(false);
    expect(isDeskRequest(new Request(`${DESK}/desk`), { ...deskEnv, DESK_HOSTNAME: "" })).toBe(
      false,
    );
    for (const path of ["/desk", "/enrol", "/api/desk/desk.claim", "/api/desk"]) {
      expect(isDeskPath(path), path).toBe(true);
    }
    expect(isDeskPath("/desktop")).toBe(false);
    expect(deskOrigin(deskEnv, "http://localhost:5179")).toBe("http://desk.crm.test:5179");
    expect(deskOrigin(deskEnv)).toBe(DESK);
  });

  it("serves its two pages, never framed or cached, and nothing else", async () => {
    const desk = await handleDesk(new Request(`${DESK}/desk`), deskEnv, page);
    expect(desk.status).toBe(200);
    for (const [name, value] of Object.entries(DESK_HEADERS)) {
      expect(desk.headers.get(name)).toBe(value);
    }
    expect((await handleDesk(new Request(`${DESK}/`), deskEnv, page)).headers.get("location")).toBe(
      `${DESK}/desk`,
    );
    for (const path of [
      "/sign-in",
      "/people",
      "/api/v1/manifest",
      "/api/v1/op/desk.status",
      "/mcp",
      "/_serverFn/abc",
      "/api/auth/get-session",
      "/api/desk/person.list",
      "/api/desk/agreement.desk.start",
    ]) {
      const response = await handleDesk(
        new Request(`${DESK}${path}`, { method: "POST" }),
        deskEnv,
        page,
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("enrols a tablet: the credential is a host-only, HttpOnly, Secure, SameSite=Strict cookie, never in the body", async () => {
    const made = await staffOp("device.enrol", { name: unique("Desk tablet"), use: "signing" });
    expect(made.enrolUrl).toBe(`${ORIGIN.replace("crm.test", "desk.crm.test")}/enrol`);
    const claimed = await call("device.claim", { code: made.code });
    expect(claimed.status).toBe(200);
    const set = claimed.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`)) ?? "";
    expect(set).toMatch(/; Path=\//);
    expect(set).toMatch(/; Secure/);
    expect(set).toMatch(/; HttpOnly/);
    expect(set).toMatch(/; SameSite=Strict/);
    expect(set).not.toMatch(/Domain=/i);
    const value = cookieValue(claimed, DEVICE_COOKIE) as string;
    expect(await claimed.text()).not.toContain(value);
    const status = await call("desk.status", {}, { cookie: `${DEVICE_COOKIE}=${value}` });
    expect(((await status.json()) as { data: { enrolled: boolean } }).data.enrolled).toBe(true);
  });

  it("refuses a desk call from another origin, without one, not JSON, or with a staff session", async () => {
    const tablet = await enrol();
    const other = await call("desk.status", {}, { cookie: tablet.cookie, origin: ORIGIN });
    expect(other.status).toBe(403);
    expect((await other.json()) as unknown).toMatchObject({
      error: { details: { rule: "desk_origin" } },
    });
    expect((await call("desk.status", {}, { cookie: tablet.cookie, origin: null })).status).toBe(
      403,
    );
    expect(
      (await call("desk.status", {}, { cookie: tablet.cookie, contentType: "text/plain" })).status,
    ).toBe(415);
    const staff = await call("desk.status", {}, { cookie: `${tablet.cookie}; ${admin.cookie}` });
    expect(staff.status).toBe(403);
    expect((await staff.json()) as unknown).toMatchObject({
      error: { details: { rule: "desk_session_cookie" } },
    });
  });

  it("a session: claimed with the code, its token in its own cookie, refused with another device's credential", async () => {
    const tablet = await enrol();
    const person = await staffOp("person.create", {
      givenName: "Robin",
      familyName: unique("Fixture"),
      emails: [{ email: `${unique("r")}@example.com` }],
    });
    const started = await staffOp("agreement.desk.start", {
      personId: person.id,
      deviceId: tablet.deviceId,
    });
    expect(started.deskUrl).toBe("https://desk.crm.test");
    const claimed = await call("desk.claim", { code: started.code }, { cookie: tablet.cookie });
    expect(claimed.status).toBe(200);
    const token = cookieValue(claimed, SESSION_COOKIE) as string;
    const rotated = cookieValue(claimed, DEVICE_COOKIE) as string;
    expect(token).toBeTruthy();
    expect(rotated).toBeTruthy();
    expect(await claimed.text()).not.toContain(token);
    const both = `${DEVICE_COOKIE}=${rotated}; ${SESSION_COOKIE}=${token}`;
    expect((await call("desk.documents", {}, { cookie: both })).status).toBe(200);
    // The same token with another enrolled device's credential.
    const other = await enrol();
    const stolen = await call(
      "desk.documents",
      {},
      { cookie: `${other.cookie}; ${SESSION_COOKIE}=${token}` },
    );
    expect(stolen.status).toBe(401);
    // The token alone, with no device.
    expect(
      (await call("desk.documents", {}, { cookie: `${SESSION_COOKIE}=${token}` })).status,
    ).toBe(401);
    // Finished: the token cookie is cleared and answers nothing again.
    const done = await call("desk.finish", {}, { cookie: both });
    expect(done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(
      /Max-Age=0/,
    );
    expect((await call("desk.documents", {}, { cookie: both })).status).toBe(401);
  });

  it("the desk calls are not on the HTTP surface, and its cookies open nothing there", async () => {
    const tablet = await enrol();
    for (const name of ["desk.status", "desk.claim", "device.claim", "desk.documents"]) {
      const response = await handleApi(
        new Request(`${ORIGIN}/api/v1/op/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: tablet.cookie },
          body: JSON.stringify({ input: {} }),
        }),
        deskEnv as unknown as ApiEnv,
      );
      expect(response?.status, name).toBe(404);
    }
    const manifest = await handleApi(
      new Request(`${ORIGIN}/api/v1/manifest`),
      deskEnv as unknown as ApiEnv,
    );
    const json = (await manifest?.json()) as
      | { data: { operations: { name: string }[] } }
      | undefined;
    const names = (json?.data.operations ?? []).map((o) => o.name);
    expect(names.filter((n) => n.startsWith("desk.") || n.startsWith("device."))).toEqual([]);
  });
});
