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
          // Its kit's catalogue: what a new client's COS_PACKS is checked against.
          client: {
            "packs.json": JSON.stringify(["bookings", "programs", "ticketing"]),
            "contract/roles.json": JSON.stringify({ requires: { programs: ["bookings"] } }),
          },
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
      // A client has exactly the packs it is given (review of #553): COS_PACKS is required, and
      // "*" (the product's catalogue, Deals, Leads and Ticketing installed at boot) is refused.
      const add = (...more: string[]) =>
        runIn(
          world,
          "client",
          "add",
          "gym-a",
          "--product",
          HOSTED.id,
          "--env",
          "live",
          "--dry-run",
          ...more,
        );
      const none = await add();
      expect(none.code).not.toBe(0);
      expect(none.output).toContain("--setting COS_PACKS=<pack,pack…> is required");
      const all = await add("--setting", "COS_PACKS=*");
      expect(all.code).not.toBe(0);
      expect(all.output).toContain("never a client's");
      const given = await add("--setting", "COS_PACKS=ticketing");
      expect(given.code, given.output).toBe(0);
      expect(given.output).toContain("Would add gym-a");
      // Checked against the installed release's packs (re-review of #553).
      const typo = await add("--setting", "COS_PACKS=ticketting");
      expect(typo.code).not.toBe(0);
      expect(typo.output).toContain("does not carry (it carries bookings, programs, ticketing)");
      const lacking = await add("--setting", "COS_PACKS=programs");
      expect(lacking.code).not.toBe(0);
      expect(lacking.output).toContain("COS_PACKS lacks bookings");
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

describe("a command for another product than the deployment runs (review of #553)", () => {
  /** Releases 1.0.0 and 1.1.0, each carrying the default product's and the hosted one's. */
  async function twoReleases(world: World) {
    for (const version of ["1.0.0", "1.1.0"]) {
      await world.github.publishProducts([
        await buildFixtureRelease({ version, fleet: true, clientGatekeepers: true }),
        await buildFixtureRelease({
          version,
          fleet: true,
          clientGatekeepers: true,
          product: HOSTED,
        }),
      ]);
    }
  }
  const stateOf = async (world: World, name = "demo") => {
    const db = [...world.cf.d1.values()].find((d) => d.name === name);
    const rows = await db?.engine.query("SELECT value FROM core_install", []);
    return JSON.parse(String(rows?.[0]?.value)) as Record<string, unknown>;
  };
  const setState = async (world: World, state: Record<string, unknown>, name = "demo") => {
    const db = [...world.cf.d1.values()].find((d) => d.name === name);
    await db?.engine.query("UPDATE core_install SET value = ? WHERE key = 'deployment'", [
      JSON.stringify(state),
    ]);
  };
  const footprint = (world: World) => ({
    ...made(world),
    writes: world.cf.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/query")).length,
  });

  it("refuses upgrade, rollback and uninstall with --database before anything is made or deleted, for a state that records its product and for one that predates it", async () => {
    const world = await startWorld();
    world.products = PRODUCTS;
    try {
      await twoReleases(world);
      const install = await runIn(world, "install", "--yes", "--version", "1.0.0", "--ai", "off");
      expect(install.code, install.output).toBe(0);
      expect((await stateOf(world)).product).toBe(DEMO.id);
      const wrong = ["--product", HOSTED.id, "--database", "demo"];
      const check = async () => {
        const before = footprint(world);
        for (const argv of [
          ["upgrade", "--yes", "--version", "1.1.0", ...wrong],
          ["rollback", "--yes", ...wrong],
          ["uninstall", "--yes", ...wrong],
          ["install", "--yes", "--version", "1.0.0", ...wrong],
        ]) {
          const refused = await runIn(world, ...argv);
          expect(refused.code, argv.join(" ")).toBe(1);
          expect(refused.output).toContain("This deployment runs demo, not composable");
        }
        expect(footprint(world)).toEqual(before);
        expect(footprint(world).scripts.some((n) => n.startsWith("composable"))).toBe(false);
      };
      await check();
      // A state written before the product was recorded is the default product's.
      const { product: _product, ...legacy } = await stateOf(world);
      await setState(world, legacy);
      await check();
      // It gains the field at its next upgrade.
      const upgrade = await runIn(world, "upgrade", "--yes", "--version", "1.1.0");
      expect(upgrade.code, upgrade.output).toBe(0);
      expect((await stateOf(world)).product).toBe(DEMO.id);
    } finally {
      world.server.close();
    }
  });

  it("reads a state that records no product as the product whose database it is in, else the default (re-review of #553)", async () => {
    const world = await startWorld();
    world.products = PRODUCTS;
    try {
      await twoReleases(world);
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
        "--version",
        "1.0.0",
      );
      expect(install.code, install.output).toBe(0);
      // A composable fleet whose state predates the field is still the hosted product's.
      const { product: _product, ...legacy } = await stateOf(world, "composable");
      await setState(world, legacy, "composable");
      const listed = await runIn(world, "client", "list", "--product", HOSTED.id, "--env", "live");
      expect(listed.code, listed.output).toBe(0);
      // A deployment in a database no product is named for (a client product's, by --database)
      // is the default product's.
      const { productOfDatabase } = await import("../src/main.ts");
      expect(productOfDatabase("composable", HOSTED, { products: PRODUCTS })).toBe(HOSTED.id);
      expect(productOfDatabase("composable-staging", DEMO, { products: PRODUCTS })).toBe(HOSTED.id);
      expect(productOfDatabase("demo", HOSTED, { products: PRODUCTS })).toBe(DEMO.id);
      expect(productOfDatabase("gym", HOSTED, { products: PRODUCTS })).toBe(DEMO.id);
    } finally {
      world.server.close();
    }
  });

  it("refuses the fleet's commands for a fleet whose state records another product", async () => {
    const world = await startWorld();
    world.products = PRODUCTS;
    try {
      await twoReleases(world);
      const keysPath = join(mkdtempSync(join(tmpdir(), "hosted-keys-")), "live.json");
      expect((await runIn(world, "fleet", "keys", "--env", "live", "--out", keysPath)).code).toBe(
        0,
      );
      const args = [
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
      ];
      const install = await runIn(world, "fleet", "install", ...args, "--version", "1.0.0");
      expect(install.code, install.output).toBe(0);
      expect((await stateOf(world, "composable")).product).toBe(HOSTED.id);
      await setState(
        world,
        { ...(await stateOf(world, "composable")), product: DEMO.id },
        "composable",
      );
      const before = footprint(world);
      for (const argv of [
        ["fleet", "install", ...args],
        [
          "fleet",
          "upgrade",
          "--product",
          HOSTED.id,
          "--env",
          "live",
          "--keys-file",
          keysPath,
          "--version",
          "1.1.0",
          "--yes",
          "--skip-staging",
        ],
        ["client", "list", "--product", HOSTED.id, "--env", "live"],
        [
          "client",
          "add",
          "gym-a",
          "--product",
          HOSTED.id,
          "--env",
          "live",
          "--setting",
          "COS_PACKS=ticketing",
        ],
      ]) {
        const refused = await runIn(world, ...argv);
        expect(refused.code, argv.join(" ")).not.toBe(0);
        expect(refused.output).toContain("This deployment runs demo, not composable");
      }
      expect(footprint(world)).toEqual(before);
    } finally {
      world.server.close();
    }
  });
});
