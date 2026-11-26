// Every env name the repo's Workers declare (their wrangler files, deploy inputs and
// `.dev.vars.example`, and the client environment's `ENV_NAMES`) that looks like a secret is either
// collected by the provider-text redactor (`isCredentialName`, src/ai/redact.ts) or on the list of
// names that only look secret. A new secret added to a Worker without either fails here.
import { describe, expect, it } from "vitest";
import { isCredentialName } from "../src/index.ts";

const sources = {
  ...import.meta.glob("../../../apps/*/wrangler.jsonc", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../packages/gatekeeper-*/wrangler.jsonc", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../apps/*/deploy-inputs.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../packages/gatekeeper-*/deploy-inputs.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../apps/*/.dev.vars.example", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../db/src/client-env-names.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

/** Names that look like secrets and are not: public keys, ids, flags, bindings, rate limits. */
const NOT_A_SECRET = new Set<string>([
  "COS_SUPPORT_PUBLIC_KEY",
  "TURNSTILE_SITE_KEY",
  "STREAM_SIGNING_KEY_ID",
  "MCP_ACCESS_TOKEN_TTL",
  // The names of the Workers Settings → AI writes secrets to, not a secret.
  "AI_SECRET_SCRIPTS",
]);

const LOOKS_SECRET = /(?:KEY|SECRET|TOKEN|PASSWORD|JWK|CREDENTIAL|PRIVATE)/;
/** Bindings and settings that happen to contain one of those words. */
const NOT_A_VALUE = /(?:_RATE_LIMIT|_KV|_TTL|_BYOK|_ID)$/;

function namesIn(path: string, source: string): string[] {
  const out = new Set<string>();
  const add = (name: string | undefined) => {
    if (name && /^[A-Z][A-Z0-9_]{2,}$/.test(name)) out.add(name);
  };
  if (path.endsWith(".dev.vars.example")) {
    for (const m of source.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) add(m[1]);
  } else if (path.endsWith("client-env-names.ts")) {
    for (const m of source.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)) add(m[1]);
  } else {
    for (const m of source.matchAll(/"([A-Z][A-Z0-9_]+)"\s*:/g)) add(m[1]);
    for (const m of source.matchAll(/"(?:name|binding)"\s*:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1]);
  }
  return [...out];
}

describe("the redactor's credential names", () => {
  it("read the Workers' declarations", () => {
    const paths = Object.keys(sources);
    expect(paths.some((p) => p.includes("apps/app/wrangler.jsonc"))).toBe(true);
    expect(paths.some((p) => p.includes("gatekeeper-google/deploy-inputs.json"))).toBe(true);
    expect(paths.some((p) => p.endsWith("client-env-names.ts"))).toBe(true);
  });

  it("collect every declared name that looks like a secret, or list it as not one", () => {
    const missed: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const name of namesIn(path, source)) {
        if (!LOOKS_SECRET.test(name) || NOT_A_VALUE.test(name)) continue;
        if (isCredentialName(name) || NOT_A_SECRET.has(name)) continue;
        missed.push(`${name} (${path.replace(/^(\.\.\/)+/, "")})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("never collect the names listed as not secrets", () => {
    for (const name of NOT_A_SECRET) expect(isCredentialName(name), name).toBe(false);
  });
});
