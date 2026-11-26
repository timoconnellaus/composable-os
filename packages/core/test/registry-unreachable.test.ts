// Stage 66 step 3 (ADR 0613): the registry is the operator's. No operation, extension, tool or
// assistant can read or write it (acceptance criterion 10's foundation). An operation is handed
// a database handle for its client, never `env`, and a client's environment holds no way to the
// registry (packages/db/test/client-environment.test.ts). This test reads the source of
// packages/core (every operation, tool and the assistant's code) and of every pack (extensions,
// which run with an empty env in any case) and fails when a file names the registry's binding,
// its tables, its module or the client's environment, or the binding of every client's
// databases.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.{ts,tsx,json,sql}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const packs = import.meta.glob(
  ["../../../packs/*/**/*.{ts,tsx,json,sql}", "!**/node_modules/**", "!**/package.json"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const FORBIDDEN: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "the registry's binding", pattern: /(?<![A-Za-z0-9_])REGISTRY(?![A-Za-z0-9_])/ },
  {
    what: "a registry table",
    pattern: /\bregistry_(?:clients|hostnames|settings|secrets|meta|migrations)\b/,
  },
  { what: "the registry's module", pattern: /@composable-os\/db\/registry|db\/src\/registry/ },
  {
    what: "the client's environment",
    pattern: /@composable-os\/db\/client-environment|db\/src\/client-environment/,
  },
  { what: "every client's databases", pattern: /(?<![A-Za-z0-9_])CLIENT_DB(?![A-Za-z0-9_])/ },
  { what: "the client's database class", pattern: /@composable-os\/db\/client-db/ },
];

describe("no operation reaches the registry", () => {
  it("reads packages/core's sources and the packs'", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(packs).some((file) => file.includes("/packs/deals/"))).toBe(true);
  });

  it("no file of packages/core or a pack names the registry, its tables or every client's databases", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries({ ...sources, ...packs })) {
      for (const { what, pattern } of FORBIDDEN) {
        if (pattern.test(text)) found.push(`${file}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });
});
