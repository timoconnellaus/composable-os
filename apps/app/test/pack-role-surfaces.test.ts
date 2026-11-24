// Stage 47 (ADR 0660, from the review of PR #303): an account holding a pack role (a coach, a
// rostered cleaner) reaches, besides the admin's pages (whose layout shows it only its screens),
// its session, operations (held to its role by the pipeline), sign-in and sign-out, and the health
// check. Every other server function and `/api/*` route is refused before its handler runs, in
// one place (`authorize`). This walks every server function and every server route the app has,
// as a coach and as a `rostering.team` account, and as a member for contrast.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SOCKET_PATH } from "../src/server/assistant/http.ts";
import {
  authorize,
  packRoleMayCallServerFn,
  packRoleMayReach,
  refusesFixedRole,
} from "../src/server/identity.ts";
import { ORIGIN, signUp, type TestUser, testEnv } from "./mcp-helpers.ts";

const authEnv = testEnv();

/** Every file under src/server that defines a server function, as TanStack Start names it. */
const serverFnFiles = Object.entries(
  import.meta.glob<string>("../src/server/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)
  .filter(([, text]) => text.includes("createServerFn("))
  .map(([path]) => path.replace(/^\.\.\//, ""));

/** Every server route (`/api/...`), with any parameter filled in, and the assistant's socket. */
const apiRoutes = [
  ...Object.values(
    import.meta.glob<string>("../src/routes/api/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).flatMap((text) => {
    const path = /createFileRoute\("([^"]+)"\)/.exec(text)?.[1];
    return path ? [path.replace(/\$[A-Za-z]*/g, "x")] : [];
  }),
  SOCKET_PATH,
];

const ALLOWED_FNS = ["src/server/session.public.ts", "src/server/call-operation.ts"];
const ALLOWED_API = (path: string) => path.startsWith("/api/auth/") || path === "/api/health";

let coach: TestUser;
let team: TestUser;
let member: TestUser;

async function withPackRole(role: string): Promise<TestUser> {
  const user = await signUp(authEnv, "viewer");
  await env.DB.prepare("UPDATE core_user SET pack_role = ? WHERE id = ?").bind(role, user.id).run();
  return user;
}

beforeAll(async () => {
  coach = await withPackRole("bookings.coach");
  team = await withPackRole("rostering.team");
  member = await signUp(authEnv, "member");
}, 60_000);

const request = (user: TestUser, path: string) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie: user.cookie, origin: ORIGIN },
  });

/** The principal a request's cookie resolves to (the request middleware's, as functions see it). */
async function principalOf(user: TestUser) {
  const result = await authorize(request(user, "/"), authEnv, { handlerType: "router" });
  if (!result.ok || !result.principal) throw new Error("not signed in");
  return result.principal;
}

describe("a pack-role account on the admin's server functions and routes (ADR 0660)", () => {
  it("finds the server functions and routes it walks", () => {
    expect(serverFnFiles.length).toBeGreaterThanOrEqual(3);
    expect(serverFnFiles).toContain("src/server/system.ts");
    expect(apiRoutes).toEqual(expect.arrayContaining(["/api/assistant/turn", "/api/health"]));
  });

  for (const [name, who] of [
    ["a coach", () => coach],
    ["a rostering.team account", () => team],
  ] as const) {
    it(`${name} reaches only the short allow-list`, async () => {
      const principal = await principalOf(who());
      // Every server function, as its own middleware judges it (start.ts).
      for (const file of serverFnFiles) {
        const refused = await refusesFixedRole(env.DB, principal, file);
        expect(refused, file).toBe(!ALLOWED_FNS.includes(file));
      }
      // Every server route, as the request middleware judges it.
      for (const path of apiRoutes) {
        const result = await authorize(request(who(), path), authEnv, { handlerType: "router" });
        expect(result.ok, path).toBe(ALLOWED_API(path));
        if (!result.ok) expect(result.response.status, path).toBe(403);
      }
      // The admin's pages: the layout shows the role its screens and "not found" for the rest.
      expect((await authorize(request(who(), "/"), authEnv, { handlerType: "router" })).ok).toBe(
        true,
      );
    });
  }

  it("a member keeps every server function and route", async () => {
    const principal = await principalOf(member);
    for (const file of serverFnFiles) {
      expect(await refusesFixedRole(env.DB, principal, file), file).toBe(false);
    }
    for (const path of apiRoutes) {
      expect(
        (await authorize(request(member, path), authEnv, { handlerType: "router" })).ok,
        path,
      ).toBe(true);
    }
  });

  it("decides by the function's file and the path, never by anything the caller names", () => {
    expect(packRoleMayCallServerFn("src/server/call-operation.ts")).toBe(true);
    expect(packRoleMayCallServerFn("src/server/session.public.ts")).toBe(true);
    expect(packRoleMayCallServerFn("src/server/system.ts")).toBe(false);
    expect(packRoleMayCallServerFn("src/server/call-operation.ts.evil/system.ts")).toBe(false);
    expect(packRoleMayCallServerFn(undefined)).toBe(false);
    expect(packRoleMayReach("/api/assistant/thread")).toBe(false);
    expect(packRoleMayReach("/api/auth/sign-out")).toBe(true);
    expect(packRoleMayReach("/s/bookings/desk")).toBe(true);
  });
});
