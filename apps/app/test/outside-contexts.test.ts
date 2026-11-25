// The limits on public operations hold at one choke point (ADR 0940): the pipeline's outside path
// counts every call whose context carries the limiter. So every adapter that builds a context for
// a customer, a practitioner or the public must give it the limiter and the caller's address. This
// test fails when a new entry builds such a context anywhere else, or one of the known builders
// stops passing the limits; and checks the builder's output at run time.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { describe, expect, it } from "vitest";
import { type ApiEnv, outsideContext } from "../src/server/http/api.ts";

// Inlined as text at build time, so this runs inside workerd.
const sources = {
  ...import.meta.glob(["../src/**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob(["../../runner/src/**/*.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

/** What building a context for someone outside the org looks like. */
const BUILDS_OUTSIDE =
  /OutsideInvocationContext|DeviceInvocationContext|outsideContext\(|principal:\s*(PUBLIC|run\.outside)|kind:\s*"public"/;

/** The files allowed to, and what each must say so the limits are passed. */
const BUILDERS: Record<string, RegExp> = {
  // Defines outsideContext, which every HTTP route (cookie, bearer token, public) goes through.
  "../src/server/http/api.ts": /publicLimits:\s*publicLimitBindings\(env\),\s*clientAddress,/,
  // The client-app binding: outsideContext with the visitor's address.
  "../src/server/http/bound.ts": /outsideContext\([^)]*address,?\s*\)/s,
  // The desk origin: outsideContext with the connection's address.
  "../src/server/http/desk.ts": /outsideContext\([\s\S]*?connectionAddress\(request, env\)/,
  // A pack tool's calls, as the caller who called it.
  "../../runner/src/executor/host.ts": /publicLimits:\s*publicLimitBindings\(this\.#env\)/,
};

describe("every outside context carries the limits", () => {
  it("is scanned", () => {
    expect(Object.keys(sources).some((f) => f.includes("runner/src"))).toBe(true);
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("only the known builders build one, and each passes the limits and the address", () => {
    const builders = Object.entries(sources)
      .filter(([file, text]) => !file.endsWith(".txt") && BUILDS_OUTSIDE.test(text))
      .map(([file]) => file)
      .sort();
    expect(
      builders,
      "A new file builds a context for callers outside the org: pass publicLimits and " +
        "clientAddress (use outsideContext), then add it here (ADR 0940).",
    ).toEqual(Object.keys(BUILDERS).sort());
    for (const [file, must] of Object.entries(BUILDERS)) {
      expect(sources[file], file).toMatch(must);
    }
  });

  it("outsideContext gives the pipeline the limiter and the address", async () => {
    const ctx = await outsideContext(
      env as unknown as ApiEnv,
      createCrmDb(env.DB),
      { kind: "public" },
      null,
      { key: "k", shared: false },
    );
    expect(ctx.publicLimits).toBeDefined();
    expect(ctx.publicLimits?.read).toBeDefined();
    expect(ctx.clientAddress).toEqual({ key: "k", shared: false });
  });
});
