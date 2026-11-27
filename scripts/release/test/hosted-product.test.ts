// The hosted product (products/composable): what a host of many clients is installed as (stage 66),
// and the release that carries it beside the CRM. Each rule here has a test that fails without it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineProduct, type ProductDefinition } from "@composable-os/product";
import { repositoryPackIds } from "@composable-os/product/packs";
import {
  DEFAULT_PRODUCT,
  HOSTED_PACKS_LEFT_OUT,
  HOSTED_PRODUCT,
  products,
} from "@composable-os/products";
import {
  formatSums,
  isFleetWorker,
  parseSums,
  type ReleaseManifest,
  releaseAssetNames,
  sha256Hex,
  stableStringify,
} from "@composable-os/release";
import { describe, expect, it } from "vitest";
import { collectAssets, productsOfArgs, productsToBuild } from "../build-release.ts";
import {
  generateManifest,
  readDeployablePackages,
  readMigrations,
  type WorkerBuild,
} from "../manifest-lib.ts";
import { mergeReleaseParts } from "../merge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const HOSTED = products[HOSTED_PRODUCT] as ProductDefinition;
const CRM = products[DEFAULT_PRODUCT] as ProductDefinition;

/** Worker names the fleet's account is known to hold, outside any deployment of ours. */
const ACCOUNT_HOLDS = ["cos-docs", "cos-site", "crm-client-db-proof", "crm-client-db-proof-db"];
/** The staging check's throwaway products' prefix (scripts/fleet-staging-check.mjs). */
const THROWAWAY = "cosstg-";

/** A release manifest for `product` from the repository's real configs, with fixture modules. */
async function manifestOf(product: ProductDefinition): Promise<ReleaseManifest> {
  const assets = await collectAssets(join(HERE, "testdata", "fixture-assets"));
  const builds: WorkerBuild[] = [];
  for (const pkg of readDeployablePackages(ROOT)) {
    const body = `// fixture module for ${pkg.dir}\nexport default {};\n`;
    builds.push({
      pkg,
      mainModule: "index.js",
      modules: [
        { name: "index.js", type: "esm", sha256: await sha256Hex(body), size: body.length },
      ],
      ...(pkg.role === "app" ? { assets: { config: {}, files: assets.files } } : {}),
    });
  }
  return generateManifest(
    {
      root: ROOT,
      product,
      version: "1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: product.updateRepository,
      wranglerVersion: "0.0.0-fixture",
    },
    builds,
    readMigrations(ROOT),
  );
}

describe("the hosted product's definition", () => {
  it("validates, and is a product the installer offers beside the CRM, which stays the default", () => {
    expect(defineProduct({ ...HOSTED })).toEqual(HOSTED);
    expect(HOSTED.id).toBe("composable");
    expect(HOSTED.label).toBe("Composable OS");
    expect(HOSTED.strings.name).toBe("Composable OS");
    expect(DEFAULT_PRODUCT).toBe("crm");
    expect(Object.keys(products).sort()).toEqual(["composable", "crm"]);
  });

  it("names everything its own: its id or its id and a hyphen, never cos-, crm- or the throwaway prefix", () => {
    const own = (name: string) => name === HOSTED.id || name.startsWith(`${HOSTED.id}-`);
    expect(Object.values(HOSTED.names).filter((name) => !own(name))).toEqual([]);
    for (const name of Object.values(HOSTED.names)) {
      for (const other of ["cos-", "crm-", THROWAWAY]) expect(name.startsWith(other)).toBe(false);
    }
  });

  it("offers every pack in the repository but those it leaves out with a reason", () => {
    const offered = repositoryPackIds(ROOT).filter((id) => !(id in HOSTED_PACKS_LEFT_OUT));
    expect([...HOSTED.packs].sort()).toEqual(offered);
    for (const id of Object.keys(HOSTED_PACKS_LEFT_OUT)) expect(HOSTED.packs).not.toContain(id);
    // What a first client of the fleet needs is among them.
    for (const id of ["ticketing", "content", "programs", "courses", "bookings"]) {
      expect(HOSTED.packs).toContain(id);
    }
  });
});

describe("what a client of the hosted product reads", () => {
  /** Source a client's staff and customers see as screens or mail: no product's name in it. */
  const SURFACES = [
    "apps/app/src/routes",
    "apps/app/src/components",
    "apps/app/src/server/host-mail.ts",
    "packages/core/src/customers",
    "packages/core/src/notifications",
    "packages/core/src/agreements",
    "packages/core/src/integrations/catalogue.ts",
    "blocks",
    ...repositoryPackIds(ROOT).flatMap((id) => [`packs/${id}/blocks`, `packs/${id}/client`]),
  ];

  const sources = (path: string): string[] => {
    const full = join(ROOT, path);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch {
      return /\.(ts|tsx)$/.test(path) ? [path] : [];
    }
    return entries.flatMap((e) =>
      e.name === "node_modules" || e.name === "test" || /\.test\.tsx?$/.test(e.name)
        ? []
        : sources(`${path}/${e.name}`),
    );
  };

  /** The code of a file without its comments (a `//` after `:` is a URL, kept). */
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"));

  it("never says CRM: the product's name comes from its label (productName)", () => {
    const found: string[] = [];
    for (const file of SURFACES.flatMap(sources)) {
      code(readFileSync(join(ROOT, file), "utf8")).forEach((line, i) => {
        if (/\bCRM\b/.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  /**
   * Where the host's errors and its dashboards' descriptions are written. Operation descriptions,
   * the assistant's prompt and the judge's, adjudicator's and summaries' instructions there are
   * model-facing and still say CRM (left on purpose, docs/deploying.md lists them): only the
   * message of every error and every dashboard's description is read here.
   */
  const HOST_CODE = [
    "packages/core/src",
    "packages/auth/src",
    "apps/app/src",
    "apps/runner/src",
    ...repositoryPackIds(ROOT).map((id) => `packs/${id}`),
  ];

  /** A string literal: "…", '…' or `…`, joined with `+` across lines. */
  const LITERAL = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60[^\x60]*\x60)(?:\s*\+\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60[^\x60]*\x60))*`;

  it("never says CRM in an error a person can see, nor in a dashboard's description", () => {
    const found: string[] = [];
    const errors = new RegExp(String.raw`new \w*Error\(\s*(${LITERAL})`, "g");
    const descriptions = new RegExp(String.raw`description:\s*(${LITERAL})`, "g");
    for (const file of HOST_CODE.flatMap(sources)) {
      const text = code(readFileSync(join(ROOT, file), "utf8")).join("\n");
      const patterns = /\/dashboards\/|^packs\//.test(file) ? [errors, descriptions] : [errors];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          if (/\bCRM\b/.test(match[1] as string)) {
            found.push(`${file}: ${(match[1] as string).replace(/\s+/g, " ").slice(0, 120)}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("the hosted product's release manifest", () => {
  it("names every Worker and resource from the hosted product, the fleet's Workers among them", async () => {
    const manifest = await manifestOf(HOSTED);
    expect(manifest.product).toBe("composable");
    expect(manifest.productLabel).toBe("Composable OS");
    const workers = manifest.workers.map((w) => w.name);
    const resources = manifest.resources.map((r) => r.name);
    for (const name of [...workers, ...resources]) {
      expect(name === "composable" || name.startsWith("composable-"), name).toBe(true);
      expect(ACCOUNT_HOLDS).not.toContain(name);
    }
    // A fleet installs the app, the runner, the email-send gatekeeper and every fleet Worker
    // (client-db and operator; cos-front too, once it is a fleet Worker of the repository).
    for (const name of [
      "composable-app",
      "composable-runner",
      "composable-client-db",
      "composable-operator",
      "composable-gatekeeper-email-send",
    ]) {
      expect(workers).toContain(name);
    }
    const fleet = manifest.workers.filter(isFleetWorker).map((w) => w.name);
    expect(fleet.length).toBeGreaterThanOrEqual(2);
    for (const name of fleet) expect(name.startsWith("composable-")).toBe(true);
    // No name of the CRM's, nor a package's own cos-* name, is left anywhere in it.
    const text = stableStringify(manifest);
    for (const prefix of [CRM.names.resourcePrefix, "cos-app", "cos-runner", "cos-client-db"]) {
      expect(text).not.toContain(`"${prefix}`);
      expect(text).not.toContain(`(${prefix}`);
    }
  });

  it("is the same release otherwise: the CRM's Workers, renamed, and the same migrations", async () => {
    const [crm, hosted] = await Promise.all([manifestOf(CRM), manifestOf(HOSTED)]);
    const local = (product: ProductDefinition, m: ReleaseManifest) =>
      m.workers.map((w) => `${w.package}:${w.name.slice(product.id.length)}`).sort();
    expect(local(HOSTED, hosted)).toEqual(local(CRM, crm));
    expect(hosted.migrations).toEqual(crm.migrations);
  });
});

describe("a release of every product (build-release.ts --products all)", () => {
  it("builds every product, the default one as a build with no product named builds it", () => {
    expect(productsToBuild("all")).toEqual([undefined, "composable"]);
    expect(productsToBuild("composable")).toEqual(["composable"]);
    expect(() => productsToBuild("crm,crm")).toThrow(/twice/);
    expect(() => productsToBuild("nope")).toThrow(/no product nope/);
    // Every product is built with its own COS_PRODUCT, so never from what a build left (review of #553).
    expect(productsOfArgs({ products: "all" }, {})).toEqual([undefined, "composable"]);
    expect(() => productsOfArgs({ products: "all", "skip-build": true }, {})).toThrow(
      /--skip-build/,
    );
    expect(() => productsOfArgs({ products: "all", product: "crm" }, {})).toThrow(/--product/);
    expect(() => productsOfArgs({ products: "all" }, { COS_PRODUCT: "crm" })).toThrow(
      /COS_PRODUCT/,
    );
  });

  /** A folder as build-release.ts writes it for one product. */
  async function part(root: string, product: string, version: string, tag = "") {
    const dir = join(root, product);
    mkdirSync(dir, { recursive: true });
    const names = releaseAssetNames(product, version);
    const bundle = `bundle of ${product}${tag}`;
    const manifest = `{"product":"${product}"}`;
    writeFileSync(join(dir, names.bundle), bundle);
    writeFileSync(join(dir, names.manifest), manifest);
    writeFileSync(
      join(dir, names.sums),
      formatSums(
        new Map([
          [names.bundle, await sha256Hex(bundle)],
          [names.manifest, await sha256Hex(manifest)],
        ]),
      ),
    );
    return { product, dir };
  }

  it("carries each product's bundle and manifest under its own name, with one SHA256SUMS for all", async () => {
    const root = mkdtempSync(join(tmpdir(), "cos-merge-"));
    const out = join(root, "release-out");
    const parts = [await part(root, "crm", "1.2.0"), await part(root, "composable", "1.2.0")];
    const sums = await mergeReleaseParts(parts, "1.2.0", out);
    expect(readdirSync(out).sort()).toEqual([
      "SHA256SUMS",
      "composable-os-composable-1.2.0.manifest.json",
      "composable-os-composable-1.2.0.tar.gz",
      "composable-os-crm-1.2.0.manifest.json",
      "composable-os-crm-1.2.0.tar.gz",
    ]);
    const listed = parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8"));
    expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toBe(sums);
    expect(listed.size).toBe(4);
    for (const [name, digest] of listed) {
      expect(await sha256Hex(new Uint8Array(readFileSync(join(out, name))))).toBe(digest);
    }
    // The CRM's lines are exactly the ones a release of the CRM alone has.
    const crmAlone = parseSums(readFileSync(join(root, "crm", "SHA256SUMS"), "utf8"));
    for (const [name, digest] of crmAlone) expect(listed.get(name)).toBe(digest);
  });

  it("refuses a part that is not what its SHA256SUMS lists, a stray file, a wrong version and a product twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "cos-merge-"));
    const out = join(root, "release-out");
    const crm = await part(root, "crm", "1.2.0");
    const hosted = await part(root, "composable", "1.2.0");
    writeFileSync(join(hosted.dir, "composable-os-composable-1.2.0.tar.gz"), "changed");
    await expect(mergeReleaseParts([crm, hosted], "1.2.0", out)).rejects.toThrow(
      /not the file its SHA256SUMS lists/,
    );
    const other = await part(mkdtempSync(join(tmpdir(), "cos-merge-")), "composable", "1.2.0");
    writeFileSync(join(other.dir, "stray.txt"), "x");
    await expect(mergeReleaseParts([crm, other], "1.2.0", out)).rejects.toThrow(/holds/);
    await expect(mergeReleaseParts([crm], "1.3.0", out)).rejects.toThrow(/holds/);
    await expect(mergeReleaseParts([crm, crm], "1.2.0", out)).rejects.toThrow(/twice/);
  });
});
