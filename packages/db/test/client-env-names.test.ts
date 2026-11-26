// Every name the app's and the runner's environments declare (wrangler types, .dev.vars.example,
// deploy-inputs.json) or their code reads (`env.NAME`) says what it becomes in a client's
// environment (src/client-env-names.ts, stage 66 step 3). A name with no line is left out of
// every client's environment, so adding one to a Worker without deciding fails here first.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ENV_NAMES } from "../src/client-env-names.ts";
import { envNameUse } from "../src/client-environment.ts";
import { CLIENT_SETTINGS } from "../src/registry.ts";

const declared = new Set(env.WORKER_ENV_NAMES);

describe("the names of the host's environment", () => {
  it("were found (the scan of the Workers' files works)", () => {
    for (const name of ["DB", "BLOBS", "APPROVAL_FLOOR", "BETTER_AUTH_SECRET", "LOADER", "AI"]) {
      expect(declared.has(name), name).toBe(true);
    }
    expect(declared.has("DEV")).toBe(true);
  });

  it("each say what they become in a client's environment", () => {
    const unlisted = [...declared].filter((name) => envNameUse(name) === null);
    expect(unlisted).toEqual([]);
  });

  it("list nothing no Worker declares or reads (except the host's own bindings to come)", () => {
    const toCome = new Set(["REGISTRY", "CLIENT_DB"]);
    const stale = [...Object.keys(ENV_NAMES), ...Object.keys(CLIENT_SETTINGS)].filter(
      (name) => !declared.has(name) && !toCome.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("never make a secret or an address shared, nor a setting the host's own", () => {
    for (const name of ["BETTER_AUTH_SECRET", "CUSTOMER_AUTH_SECRET", "DESK_SECRET"]) {
      expect(envNameUse(name), name).toMatchObject({ use: "per-client", what: "secret" });
    }
    for (const name of ["BETTER_AUTH_URL", "CUSTOMER_AUTH_URL", "APP_ORIGIN", "MCP_RESOURCE"]) {
      expect(envNameUse(name), name).toMatchObject({ use: "per-client", what: "address" });
    }
    for (const name of Object.keys(CLIENT_SETTINGS)) {
      expect(Object.hasOwn(ENV_NAMES, name), `${name} is a setting, listed once`).toBe(false);
    }
  });
});
