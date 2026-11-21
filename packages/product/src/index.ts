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
 * packs are on, and where the company's own apps are.
 *
 * The host keeps the release's names and strings (`crm-app`, "CRM"): they are built into the
 * release, which is deployed as verified. Naming the host for the company's own product needs the
 * platform to apply names and strings at deploy time, which it does not do yet.
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
