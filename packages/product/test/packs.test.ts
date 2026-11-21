// A product's release carries the packs it lists, and only their extensions (stage 24).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { product as crm } from "../../../products/crm/product.ts";
import { defineProduct } from "../src/index.ts";
import { productPacks } from "../src/packs.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const withPacks = (packs: string[]) => defineProduct({ ...crm, id: "fixture", packs });

describe("productPacks", () => {
  it("reads the CRM's three packs, the extension only", () => {
    const packs = productPacks(crm, root);
    expect(packs.map((p) => p.id)).toEqual(["deals", "leads", "lifecycle"]);
    const deals = packs.find((p) => p.id === "deals");
    expect(Object.keys(deals?.files ?? {})).toContain("index.ts");
    // client/ (headless hooks) and blocks/ are client code: they never reach the runner.
    for (const pack of packs) {
      expect(Object.keys(pack.files).filter((f) => /^(client|blocks|test)\//.test(f))).toEqual([]);
    }
    expect(packs.find((p) => p.id === "lifecycle")?.optional).toBe(true);
  });

  it("leaves out a pack the product does not list", () => {
    expect(productPacks(withPacks(["deals"]), root).map((p) => p.id)).toEqual(["deals"]);
  });

  it("carries Ticketing only for a product that lists it (stage 27)", () => {
    // The CRM does not sell tickets: its release has no ticketing source at all.
    expect(productPacks(crm, root).some((p) => p.id === "ticketing")).toBe(false);
    const packs = productPacks(withPacks(["ticketing"]), root);
    expect(packs.map((p) => p.id)).toEqual(["ticketing"]);
    const ticketing = packs[0];
    const files = Object.keys(ticketing?.files ?? {}).sort();
    // Exactly the extension's sources: what the runner bundles for the host.
    expect(files).toEqual(["automations.ts", "dashboards.ts", "index.ts", "tools.ts"]);
    // Never the client code (hooks, blocks) or the tests: they do not run in the host.
    expect(files.filter((f) => /^(client|blocks|test)\//.test(f))).toEqual([]);
    // Installed at boot in every deployment of a product that lists it, not opt-in.
    expect(ticketing?.optional).toBeUndefined();
  });

  it("is empty for a product with no packs: a host with base records only", () => {
    expect(productPacks(withPacks([]), root)).toEqual([]);
  });

  it("refuses a pack that does not exist", () => {
    expect(() => productPacks(withPacks(["tickets"]), root)).toThrow(
      /lists the pack tickets, and packs\/tickets\/ has no package.json/,
    );
  });
});
