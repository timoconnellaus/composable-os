// Issue #155: with a client product's label set (COS_PRODUCT_LABEL), every surface that shows the
// product's name shows the label: the MCP server's instructions here, and, read from source, the
// screens (sidebar, sign-in, setup, the settings pages), the MCP consent screen and server, and
// the runner's pages. A surface that still printed the compiled name or the word "CRM" would show
// a gym's staff the platform's product instead of theirs.
import { setProductLabel } from "@composable-os/product";
import { afterEach, describe, expect, it } from "vitest";
import { serverInstructions } from "../src/server/mcp/tools.ts";

const SURFACES = [
  "src/components/app-sidebar.tsx",
  "src/routes/__root.tsx",
  "src/routes/sign-in.tsx",
  "src/routes/_app/setup.tsx",
  "src/routes/_app/settings/notification-delivery.tsx",
  "src/routes/_app/settings/updates.tsx",
  "src/routes/_app/settings/connected-apps.tsx",
  "src/routes/_app/settings/approval-policy.tsx",
  "src/routes/_app/settings/integrations.tsx",
  "src/components/integrations/connection-card.tsx",
  "src/components/integrations/admin-settings.tsx",
  "src/server/mcp/consent.ts",
  "src/server/mcp/handler.ts",
  "src/server/mcp/tools.ts",
  "../runner/src/integrations/pages.ts",
];

/** The sources, as text (workerd has no file system of the checkout). */
const SOURCES = import.meta.glob<string>(
  [
    "../src/components/**/*.tsx",
    "../src/routes/**/*.tsx",
    "../src/server/mcp/*.ts",
    "../../runner/src/integrations/pages.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** The source without comments, so what is left is code and what people are shown. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

afterEach(() => setProductLabel(undefined));

describe("a deployment's product label", () => {
  it("is what the MCP server tells a client it is", () => {
    setProductLabel("Ghetto Movement");
    expect(serverInstructions()).toContain("This server is Ghetto Movement");
    expect(serverInstructions()).not.toContain("CRM");
  });

  it("is the only product name any surface shows: none keeps the compiled name or the word CRM", () => {
    const problems: string[] = [];
    for (const file of SURFACES) {
      const text = SOURCES[`../${file}`];
      if (text === undefined) throw new Error(`${file} is not among the sources read`);
      const code = withoutComments(text);
      if (code.includes("product.strings")) problems.push(`${file}: product.strings`);
      for (const line of code.split("\n")) {
        // Identifiers (CrmDb, createCrmMcpServer, crm://) are not words people read.
        if (/\bCRM\b/.test(line)) problems.push(`${file}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
