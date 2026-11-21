// A product (ADR 0400): a named composition on the platform. Its definition holds names only, and
// is the one place a name that depends on the product is written. Packages never write one: the
// release build, the deploy engine, the installer, the self-updater and the UI read them from the
// definition (products/<id>/product.ts).

export interface ProductDefinition {
  /** Names the product in release manifests, release files and `--product`. Lowercase. */
  id: string;
  /** The product's name as people read it. */
  label: string;
  /** What a deployment of this product is called in a Cloudflare account. */
  names: {
    /** The app Worker (UI, `/mcp`, the operations registry). */
    app: string;
    /** The runner Worker (extension code, automations, Workflows). */
    runner: string;
    /** Gatekeeper Workers are this plus the gatekeeper's short name. */
    gatekeeperPrefix: string;
    /** The D1 database. */
    database: string;
    /** Buckets, queues, KV namespaces, Vectorize indexes and Workflows are this plus their name. */
    resourcePrefix: string;
  };
  /**
   * The packs the product includes, by id (`packs/<id>`, stage 24). A pack is a shipped extension
   * plus its client hooks and blocks; only the packs listed here are in the product's release and
   * installed in its deployments. Empty: a host with base records only.
   */
  packs: string[];
  /** GitHub `owner/repo` its releases are published from and updates are read from. */
  updateRepository: string;
  /** Where a hosted plan is changed. Shown when a plan's limit is reached. */
  billingUrl: string;
  /** What the UI, emails and model instructions call the product. */
  strings: {
    name: string;
  };
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PREFIX = /^[a-z0-9]+(-[a-z0-9]+)*-$/;

/** Checks a definition and returns it. Throws on the first name a Cloudflare account would refuse. */
export function defineProduct(definition: ProductDefinition): ProductDefinition {
  const fail = (what: string): never => {
    throw new Error(`product ${JSON.stringify(definition.id)}: ${what}`);
  };
  if (!NAME.test(definition.id)) fail("id must be lowercase letters, digits and single hyphens");
  if (!definition.label.trim()) fail("label is empty");
  if (!definition.strings.name.trim()) fail("strings.name is empty");
  const { app, runner, gatekeeperPrefix, database, resourcePrefix } = definition.names;
  for (const [key, value] of Object.entries({ app, runner, database })) {
    if (!NAME.test(value)) fail(`names.${key} must be lowercase letters, digits and hyphens`);
  }
  for (const [key, value] of Object.entries({ gatekeeperPrefix, resourcePrefix })) {
    if (!PREFIX.test(value)) fail(`names.${key} must end with a hyphen`);
  }
  if (app === runner) fail("names.app and names.runner are the same");
  if (!/^[\w.-]+\/[\w.-]+$/.test(definition.updateRepository)) {
    fail("updateRepository must be owner/repo");
  }
  if (!/^https:\/\//.test(definition.billingUrl)) fail("billingUrl must be an https:// URL");
  return definition;
}

/**
 * A client repo's product (stage 24, ADR 0422): `product.ts` at the root of a company's own
 * repository. It says which platform release the host is deployed from, which of that release's
 * packs are on, and where the company's own apps are. It is the one place a client product's
 * names are written (AGENTS.md).
 *
 * The host is named for it at its first install (issue #155): its Workers and resources take the
 * names `clientNames` gives (`<id>-app`, `<id>-runner`, `<id>-gatekeeper-…`, the `<id>` database,
 * `<id>-…` resources, unless `names` overrides them), applied as deploy-time configuration (the
 * deployment state's name maps, ADR 0193), so the verified release is deployed unchanged; and
 * every surface that shows the product's name shows `label` (COS_PRODUCT_LABEL). A deployment that
 * exists keeps its names: nothing deployed is renamed.
 */
export interface ClientProductDefinition {
  /** The company's product, lowercase: names its Workers (`<id>-web`) and the repo. */
  id: string;
  /** The product's name as people read it. */
  label: string;
  platform: {
    /** The platform version the repo is on: the release deployed, the client kit copied from. */
    version: string;
    /** The platform product whose release is deployed as the host (`crm`). */
    release: string;
    /** GitHub `owner/repo` the platform's releases come from. */
    repository: string;
  };
  /** The release's packs that are on (`deals`, `leads`, …). Empty: base records only. */
  packs: string[];
  /**
   * The web app, if the repo has one: its folder, its Worker's name, its hostname (else
   * workers.dev) and where its generated client is (default `src/client`).
   */
  web?: {
    dir: string;
    worker: string;
    hostname?: string;
    clientDir?: string;
    /**
     * "cos" (the default): `cos deploy` builds and uploads it. "own": it deploys itself, as an
     * adopted site does today, and `cos deploy` only checks it; its wrangler config binds HOST.
     */
    deploy?: "cos" | "own";
  };
  /** The mobile app, if the repo has one: its folder, and where its generated client is. */
  mobile?: { dir: string; clientDir?: string };
  /** The host's names, when they are not the ones derived from `id` (`clientNames`). */
  names?: Partial<ProductDefinition["names"]>;
}

/** The names a client product's host is deployed with: derived from its id, or as it says. */
export function clientNames(product: ClientProductDefinition): ProductDefinition["names"] {
  return {
    app: `${product.id}-app`,
    runner: `${product.id}-runner`,
    gatekeeperPrefix: `${product.id}-gatekeeper-`,
    database: product.id,
    resourcePrefix: `${product.id}-`,
    ...product.names,
  };
}

/**
 * The deployed name of each of a release's Worker and resource names, for a client product: the
 * release's product's names replaced by the client's (`crm-app` → `gym-app`, the `crm` database →
 * `gym`). Only names that differ are listed. What the deployment state's `workerNames` and
 * `resourceNames` hold (ADR 0193).
 */
export function clientNameMaps(
  release: ProductDefinition,
  client: ProductDefinition["names"],
  manifest: { workers: { name: string }[]; resources: { name: string }[] },
): { workers: Record<string, string>; resources: Record<string, string> } {
  const rename = (name: string): string => {
    const r = release.names;
    if (name === r.app) return client.app;
    if (name === r.runner) return client.runner;
    if (name === r.database) return client.database;
    if (name.startsWith(r.gatekeeperPrefix)) {
      return `${client.gatekeeperPrefix}${name.slice(r.gatekeeperPrefix.length)}`;
    }
    if (name.startsWith(r.resourcePrefix)) {
      return `${client.resourcePrefix}${name.slice(r.resourcePrefix.length)}`;
    }
    return name;
  };
  const map = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [name, rename(name)] as const).filter(([from, to]) => from !== to),
    );
  return {
    workers: map(manifest.workers.map((w) => w.name)),
    resources: map(manifest.resources.map((r) => r.name)),
  };
}

/**
 * The deploy-time variable that holds a client product's label (`cos deploy` sets it on the app
 * and the runner). Every surface that shows the product's name reads it through `productName`.
 */
export const PRODUCT_LABEL_VAR = "COS_PRODUCT_LABEL";

let deployedLabel: string | null = null;

/** Called once per isolate by a Worker's entry, with its COS_PRODUCT_LABEL (unset: none). */
export function setProductLabel(value: string | null | undefined): void {
  deployedLabel = typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The product's name as people read it: the deployment's label when one is set, else the build's. */
export function productName(product: Pick<ProductDefinition, "strings">): string {
  return deployedLabel ?? product.strings.name;
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Checks a client repo's product and returns it. Throws on the first problem. */
export function defineClientProduct(definition: ClientProductDefinition): ClientProductDefinition {
  const fail = (what: string): never => {
    throw new Error(`product ${JSON.stringify(definition.id)}: ${what}`);
  };
  if (!NAME.test(definition.id)) fail("id must be lowercase letters, digits and single hyphens");
  if (!definition.label.trim()) fail("label is empty");
  if (!VERSION.test(definition.platform.version)) fail("platform.version must be x.y.z");
  if (!NAME.test(definition.platform.release)) fail("platform.release must be a product id");
  if (!/^[\w.-]+\/[\w.-]+$/.test(definition.platform.repository)) {
    fail("platform.repository must be owner/repo");
  }
  for (const pack of definition.packs) if (!NAME.test(pack)) fail(`pack ${pack} is not an id`);
  if (new Set(definition.packs).size !== definition.packs.length) fail("a pack is listed twice");
  if (definition.web && !NAME.test(definition.web.worker)) fail("web.worker must be a Worker name");
  const names = clientNames(definition);
  for (const key of ["app", "runner", "database"] as const) {
    if (!NAME.test(names[key])) fail(`names.${key} must be lowercase letters, digits and hyphens`);
  }
  for (const key of ["gatekeeperPrefix", "resourcePrefix"] as const) {
    if (!PREFIX.test(names[key])) fail(`names.${key} must end with a hyphen`);
  }
  if (names.app === names.runner) fail("names.app and names.runner are the same");
  if (definition.web && [names.app, names.runner].includes(definition.web.worker)) {
    fail("web.worker is one of the host's Workers");
  }
  return definition;
}

/**
 * The prefix packages use for Workers and resources in their own configuration (wrangler.jsonc,
 * deploy-inputs.json) and in local development: `cos-app`, the database `cos`. It belongs to the
 * platform. A release replaces it with the product's names (`deployedName`).
 */
export const LOCAL_PREFIX = "cos";

/**
 * The name a Worker or resource has in a deployment of `product`, from the name a package gives
 * it. Names that do not start with the platform's prefix are left alone.
 */
export function deployedName(product: ProductDefinition, localName: string): string {
  if (localName === LOCAL_PREFIX) return product.names.database;
  if (!localName.startsWith(`${LOCAL_PREFIX}-`)) return localName;
  const rest = localName.slice(LOCAL_PREFIX.length + 1);
  if (rest === "app") return product.names.app;
  if (rest === "runner") return product.names.runner;
  if (rest.startsWith("gatekeeper-")) {
    return `${product.names.gatekeeperPrefix}${rest.slice("gatekeeper-".length)}`;
  }
  return `${product.names.resourcePrefix}${rest}`;
}

/** `deployedName` over a comma-separated list of names (a var that lists Workers). */
export function deployedNameList(product: ProductDefinition, list: string): string {
  return list
    .split(",")
    .map((name) => deployedName(product, name.trim()))
    .join(",");
}

/** What a product's release files start with: `composable-os-<product>-<version>.tar.gz`. */
export function releaseFilePrefix(productId: string): string {
  return `composable-os-${productId}`;
}
