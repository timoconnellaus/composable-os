// Stage 66 step 6 (ADR 0616, criterion 10): a client's given secrets are written only by the
// operator's command and read only by the client directory, as it builds that client's
// environment. No operation, route, tool, extension or the assistant reads or writes them, and
// none names the host's two keys. This test reads the source of the host's Workers (the app and
// the runner), of packages/core (every operation, tool and the assistant) and of every pack, and
// fails when a file imports the secrets module or names `registry_secrets` or either key.
// packages/core/test/registry-unreachable.test.ts covers core and the packs for the registry as a
// whole; this adds the Workers' own code and packages/auth, which may use the client's
// environment but never this.
//
// The scan is textual: computed access (`env["COS_" + "ROOT_KEY"]`, `Object.entries(env)`) or a
// computed import would pass it. The real protection is structural, and tested in
// client-environment.test.ts and client-secrets.test.ts: a client's environment never holds a
// `host` name (either key, `REGISTRY`, `CLIENT_DB`), nor any name `ENV_NAMES` does not list; the
// opening side is not in the package's exports at all (only `registry-sealing`, which can seal
// but not open, is); and below an entry code is handed only the client's environment.
import { describe, expect, it } from "vitest";

const glob = {
  core: import.meta.glob("../../core/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  app: import.meta.glob("../../../apps/app/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  runner: import.meta.glob("../../../apps/runner/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  auth: import.meta.glob("../../auth/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  packs: import.meta.glob("../../../packs/*/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, Record<string, string>>;

const FORBIDDEN: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  {
    what: "the secrets module",
    pattern:
      /@composable-os\/db\/registry-(?:secrets|sealing)|db\/src\/registry-(?:secrets|sealing)/,
  },
  { what: "the secrets table", pattern: /\bregistry_secrets\b/ },
  { what: "the root key", pattern: /(?<![A-Za-z0-9_])COS_ROOT_KEY(?![A-Za-z0-9_])/ },
  {
    what: "the secrets key",
    pattern: /(?<![A-Za-z0-9_])COS_SECRETS_PRIVATE_KEY(?:_PREVIOUS)?(?![A-Za-z0-9_])/,
  },
];

describe("no Worker code, operation, tool or pack reaches a client's secrets", () => {
  it("reads the app's, the runner's, packages/core's and the packs' sources", () => {
    for (const [tree, files] of Object.entries(glob)) {
      expect(Object.keys(files).length, tree).toBeGreaterThan(
        tree === "packs" ? 50 : tree === "auth" ? 4 : 20,
      );
      for (const path of Object.keys(files)) expect(path, path).not.toMatch(/node_modules/);
    }
  });

  it("finds none of them naming the secrets module, its table or the host's keys", () => {
    const found: string[] = [];
    for (const files of Object.values(glob)) {
      for (const [path, source] of Object.entries(files)) {
        for (const { what, pattern } of FORBIDDEN) {
          if (pattern.test(source)) found.push(`${path}: ${what}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("the check itself finds each", () => {
    for (const { what, pattern } of FORBIDDEN) {
      const sample = {
        "the secrets module":
          'import { readClientSecrets } from "@composable-os/db/registry-secrets";',
        "the secrets table": "SELECT * FROM registry_secrets",
        "the root key": "env.COS_ROOT_KEY",
        "the secrets key": "env.COS_SECRETS_PRIVATE_KEY_PREVIOUS",
      }[what] as string;
      expect(pattern.test(sample), what).toBe(true);
    }
  });
});
