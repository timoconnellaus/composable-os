// A host of many clients installed as the hosted product (stage 66, the owner's decision of
// 2026-11-27): `cos fleet install --product composable` from a published, attested release that
// carries the hosted product's bundle beside the default product's, against the fake Cloudflare
// API. A single-client install from such a release creates exactly what it did from a release of
// the default product alone.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductDefinition } from "@composable-os/product";
import { HOSTED_PRODUCT, products as repositoryProducts } from "@composable-os/products";
import {
  buildFixtureRelease,
  FIXTURE_PRODUCT_DEFINITION as DEMO,
  type FixtureRelease,
} from "@composable-os/release/testing";
import { describe, expect, it } from "vitest";
import { runIn, startWorld, type World } from "./world.ts";

// The repository's hosted product, its releases read from the fake GitHub's repository.
const HOSTED: ProductDefinition = {
  ...(repositoryProducts[HOSTED_PRODUCT] as ProductDefinition),
  updateRepository: "example/demo",
};
// The fixture's demo stands in for the CRM, the default product.
const PRODUCTS = { all: { [DEMO.id]: DEMO, [HOSTED.id]: HOSTED }, default: DEMO.id };

/**
 * One tag, v1.0.0, carrying the default product's release and, unless `alone`, the hosted one's,
 * listed first, so nothing that takes a release's first bundle could pass.
 */
async function publish(world: World, demo: FixtureRelease, alone = false) {
  const releases = alone
    ? [demo]
    : [
        await buildFixtureRelease({
          version: "1.0.0",
          fleet: true,
          clientGatekeepers: true,
          product: HOSTED,
        }),
        demo,
      ];
  await world.github.publishProducts(releases);
}

/** Every name the fake account holds, by kind. */
function made(world: World) {
  return {
    scripts: [...world.cf.scripts.keys()].sort(),
    d1: [...world.cf.d1.values()].map((d) => d.name).sort(),
    r2: [...world.cf.r2].sort(),
    queues: [...world.cf.queues.values()].map((q) => q.name).sort(),
    kv: [...world.cf.kv.values()].sort(),
    vectorize: [...world.cf.vectorize.keys()].sort(),
    workflows: [...world.cf.workflows.keys()].sort(),
  };
}

describe("cos fleet install --product composable", () => {
  it("installs the fleet from the hosted product's bundle: every Worker and store composable-*, nothing of the default product's", async () => {
    const world = await startWorld();
    world.products = PRODUCTS;
    try {
      await publish(
        world,
        await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }),
      );
      const keysPath = join(mkdtempSync(join(tmpdir(), "hosted-keys-")), "live.json");
      expect((await runIn(world, "fleet", "keys", "--env", "live", "--out", keysPath)).code).toBe(
        0,
      );
      const install = await runIn(
        world,
        "fleet",
        "install",
        "--product",
        HOSTED.id,
        "--env",
        "live",
        "--keys-file",
        keysPath,
        "--callback-hostname",
        "callback.fleet.example",
        "--domain",
        "fleet.example",
      );
      expect(install.code, install.output).toBe(0);
      expect(install.output).toContain("host of many clients of Composable OS 1.0.0");
      const names = made(world);
      expect(names.scripts).toEqual([
        "composable-app",
        "composable-client-db",
        "composable-gatekeeper-email-send",
        "composable-operator",
        "composable-runner",
      ]);
      expect(names.d1).toEqual(["composable", "composable-registry"]);
      expect(names.queues.length).toBeGreaterThan(0);
      for (const name of Object.values(names).flat()) {
        expect(name.startsWith("composable"), name).toBe(true);
      }
      // Every later command names the product too: without it, cos looks for the default
      // product's fleet, finds none, and changes nothing.
      const list = await runIn(world, "client", "list", "--env", "live");
      expect(list.code).toBe(1);
      expect(list.output).toContain("No live host of many clients of Demo");
      const listed = await runIn(world, "client", "list", "--env", "live", "--product", HOSTED.id);
      expect(listed.code, listed.output).toBe(0);
    } finally {
      world.server.close();
    }
  });

  it("refuses a product file that names the hosted product: --product-file takes a throwaway one only", async () => {
    const world = await startWorld();
    world.products = PRODUCTS;
    try {
      const { writeFileSync } = await import("node:fs");
      const file = join(mkdtempSync(join(tmpdir(), "hosted-file-")), "product.json");
      writeFileSync(file, JSON.stringify(HOSTED));
      const refused = await runIn(world, "client", "list", "--env", "live", "--product-file", file);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("only a throwaway product is taken from a file");
    } finally {
      world.server.close();
    }
  });
});

describe("a single-client install from a release that also carries the hosted product", () => {
  it("creates exactly what it creates from a release of the default product alone", async () => {
    const demo = await buildFixtureRelease({ version: "1.0.0", clientGatekeepers: true });
    const snapshot = async (alone: boolean) => {
      const world = await startWorld();
      world.products = PRODUCTS;
      try {
        await publish(world, demo, alone);
        const { code, output } = await runIn(world, "install", "--yes", "--ai", "off");
        expect(code, output).toBe(0);
        const scripts = [...world.cf.scripts.values()].map((s) => ({
          name: s.name,
          migrationTag: s.migrationTag,
          sources: s.versions.at(-1)?.sources,
          // Generated secrets differ from run to run; which are set does not.
          bindings: s.bindings.map((b) =>
            b.type === "secret_text" ? { ...b, text: "<secret>" } : b,
          ),
          secrets: [...s.secrets.keys()].sort(),
          schedules: s.schedules,
        }));
        return { made: made(world), scripts };
      } finally {
        world.server.close();
      }
    };
    const alone = await snapshot(true);
    const both = await snapshot(false);
    expect(alone.made.scripts).toContain("demo-app");
    expect(both).toEqual(alone);
  });
});
