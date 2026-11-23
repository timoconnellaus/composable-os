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

/**
 * The location hints both D1 (`primary_location_hint`) and R2 (`locationHint`) accept when a
 * database or a bucket is created, as Cloudflare's API reference listed them on 2026-11-23 (ADR
 * 0580). A hint is a preference Cloudflare follows best effort, only at creation: never a
 * guarantee of where data is kept. A jurisdiction (eu, us, fedramp) is a different setting and is
 * not offered.
 */
export const LOCATION_HINTS = {
  wnam: "Western North America",
  enam: "Eastern North America",
  weur: "Western Europe",
  eeur: "Eastern Europe",
  apac: "Asia-Pacific",
  oc: "Oceania",
} as const;

export type LocationHint = keyof typeof LOCATION_HINTS;

export function isLocationHint(value: unknown): value is LocationHint {
  return typeof value === "string" && Object.hasOwn(LOCATION_HINTS, value);
}

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
/** A pack role the mobile app's staff sign in with, and the grants its client also types. */
export interface MobileRole {
  /** `<pack>.<role>`, as an account holds it. */
  role: string;
  /** Grantable pack permissions (`<pack>:<name>`) whose tools the role's client also holds. */
  grants?: string[];
}

/** A `mobile.roles` entry as its role and grants (a bare string has none). */
export function mobileRole(entry: string | MobileRole): { role: string; grants: string[] } {
  return typeof entry === "string"
    ? { role: entry, grants: [] }
    : { role: entry.role, grants: [...(entry.grants ?? [])] };
}

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
    /**
     * The web app's routes that reach the host, for the edge rate-limit rule `cos` prints (so it
     * names only those): the sign-in route (default `/auth/`) and the operation route
     * (`operationRoute`, default `/api/v1/op/`).
     */
    routes?: { signIn?: string; operations?: string };
  };
  /**
   * The mobile app, if the repo has one: its folder, where its generated client is, and the pack
   * roles (ADR 0436) its staff may sign in with: `cos client generate` writes a client for each
   * (`roles/<pack>.<role>.ts`) with only that role's operations, never the whole staff client
   * (ADR 0451). The web app has none: its binding never serves staff (ADR 0421).
   *
   * A role may name grantable pack permissions its staff are given one by one (ADR 0600), as
   * `{ role: "bookings.coach", grants: ["rostering:roster"] }`: its client then also holds the
   * tools those grants open (stage 45 step 7: a coach who is rostered). The host still decides
   * every call: the client only types what such an account may ask.
   */
  mobile?: {
    dir: string;
    clientDir?: string;
    roles?: (string | MobileRole)[];
    /** The app's URL scheme (app.json `expo.scheme`), default the product's id. */
    scheme?: string;
  };
  /**
   * The host's names, when they are not the ones derived from `id` (`clientNames`). With
   * environments, these are the live environment's (the one that keeps `<id>-app`).
   */
  names?: Partial<ProductDefinition["names"]>;
  /**
   * The deployments of this product, by name (ADR 0450): at least one, usually `staging` and
   * `live`. Each is its own host (its own Workers, database, deployment state and secrets) with
   * its own addresses, deployed into one Cloudflare account side by side by
   * `cos deploy --env <name>`. Absent: one deployment, named as without environments.
   */
  environments?: Record<string, ClientEnvironment>;
  /** Gatekeepers every environment installs, and their settings (ADR 0452). */
  gatekeepers?: GatekeeperSettings;
  /**
   * A location hint for the host's D1 database and R2 buckets (ADR 0580), e.g. `oc` (Oceania):
   * `cos deploy` sends it when the host is first installed and they are created. A preference
   * Cloudflare follows where it can, not a guarantee; KV, queues and Vectorize take none. A host
   * that exists is never moved by changing it. Absent: no hint.
   */
  location?: LocationHint;
}

/**
 * One environment of a client product (ADR 0450). Its names derive from the product's id and the
 * environment's name (`<id>-staging-app`, the `<id>-staging` database, `<id>-staging-…`
 * resources), except `live`, which keeps the names a product without environments has
 * (`<id>-app`), so nothing already deployed is renamed. Every name can be overridden.
 */
export interface ClientEnvironment {
  /**
   * Whether real customers and real money use it. Default true; an environment marked false
   * (staging) may use test settings a live one may not, such as the fake payment provider.
   * The environment named `live` is always live.
   */
  live?: boolean;
  /** The host's own hostname: the staff admin's address. Absent: workers.dev. */
  hostname?: string;
  /** Gatekeepers installed here and their settings, over the product's own (ADR 0452). */
  gatekeepers?: GatekeeperSettings;
  /** The web app in this environment: its hostname (else workers.dev) and its Worker's name. */
  web?: { hostname?: string; worker?: string };
  /**
   * The mobile app's build for this environment: its URL scheme, when it differs from the
   * product's (a staging build of the app installed beside the live one), for staff sign-in's
   * redirect (`<scheme>://staff-sign-in`, NATIVE_REDIRECT_URIS on the host).
   */
  mobile?: { scheme?: string };
  /** The host's names here, when they are not the derived ones. */
  names?: Partial<ProductDefinition["names"]>;
  /** The location hint here, over the product's (ADR 0580); `"none"` for no hint. */
  location?: LocationHint | "none";
}

/** The location hint a first install of an environment (or the product) is created with. */
export function clientLocation(
  product: ClientProductDefinition,
  environment?: string,
): LocationHint | undefined {
  const own = environment ? product.environments?.[environment]?.location : undefined;
  if (own === "none") return undefined;
  return own ?? product.location;
}

/**
 * The gatekeepers a client host installs and their settings (ADR 0452), by the gatekeeper's
 * short name. Each takes only the settings that gatekeeper declares in its release (`cos deploy`
 * refuses any other); secrets are never here: a person sets them as Worker secrets, and
 * `cos deploy` says which are missing. `{}` installs a gatekeeper with its defaults.
 */
export interface GatekeeperSettings {
  /** Outbound email through Cloudflare Email Service (packages/gatekeeper-email-send). */
  "email-send"?: {
    /** Domains mail may be sent from, comma separated (`gym.example`). */
    ALLOWED_SENDER_DOMAINS?: string;
    /** The org's own domains, comma separated: mail to them is internal. */
    INTERNAL_DOMAINS?: string;
    /** The `send_email` binding's limits (Cloudflare Email Service). */
    sendEmail?: {
      allowedSenderAddresses?: string[];
      destinationAddress?: string;
      allowedDestinationAddresses?: string[];
    };
  };
  /** Payments (packages/gatekeeper-payments). Its webhook address, BASE_URL, is derived. */
  payments?: {
    /** A Stripe Connect account to act for (`acct_…`), if any. */
    STRIPE_ACCOUNT?: string;
    /** The fake provider instead of Stripe: only in an environment marked `live: false`. */
    PAYMENTS_FAKE_PROVIDER?: boolean;
  };
}

/** Whether an environment of `product` (or the product without environments) is live. */
export function isLiveEnvironment(product: ClientProductDefinition, environment?: string): boolean {
  if (environment === undefined || environment === LIVE_ENVIRONMENT) return true;
  return product.environments?.[environment]?.live !== false;
}

/** The gatekeepers and settings a deploy of `environment` applies: the product's, then its own. */
export function gatekeeperSettings(
  product: ClientProductDefinition,
  environment?: string,
): GatekeeperSettings {
  const base = product.gatekeepers ?? {};
  const own = (environment ? product.environments?.[environment]?.gatekeepers : undefined) ?? {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(own)])) {
    out[name] = {
      ...(base as Record<string, Record<string, unknown>>)[name],
      ...(own as Record<string, Record<string, unknown>>)[name],
    };
  }
  return out as GatekeeperSettings;
}

/** The environment that keeps a product's undecorated names (`<id>-app`). */
export const LIVE_ENVIRONMENT = "live";

/** The names of a product's environments, sorted; empty when it declares none. */
export function environmentNames(product: ClientProductDefinition): string[] {
  return Object.keys(product.environments ?? {}).sort();
}

/**
 * The names a client product's host is deployed with: derived from its id (and, for an
 * environment other than `live`, the environment's name), or as it says.
 */
export function clientNames(
  product: ClientProductDefinition,
  environment?: string,
): ProductDefinition["names"] {
  if (environment === undefined || environment === LIVE_ENVIRONMENT) {
    return {
      app: `${product.id}-app`,
      runner: `${product.id}-runner`,
      gatekeeperPrefix: `${product.id}-gatekeeper-`,
      database: product.id,
      resourcePrefix: `${product.id}-`,
      ...product.names,
      ...(environment ? product.environments?.[environment]?.names : {}),
    };
  }
  const base = `${product.id}-${environment}`;
  return {
    app: `${base}-app`,
    runner: `${base}-runner`,
    gatekeeperPrefix: `${base}-gatekeeper-`,
    database: base,
    resourcePrefix: `${base}-`,
    ...product.environments?.[environment]?.names,
  };
}

/**
 * The web app's Worker name and hostname in an environment: as the environment says, else the
 * product's `web` for `live` (or no environment), else `<web.worker>-<environment>`.
 */
export function clientWeb(
  product: ClientProductDefinition,
  environment?: string,
): { worker: string; hostname?: string } | null {
  if (!product.web) return null;
  const env = environment ? product.environments?.[environment] : undefined;
  const live = environment === undefined || environment === LIVE_ENVIRONMENT;
  const worker =
    env?.web?.worker ?? (live ? product.web.worker : `${product.web.worker}-${environment}`);
  const hostname = env?.web?.hostname ?? (live ? product.web.hostname : undefined);
  return { worker, ...(hostname ? { hostname } : {}) };
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
  const seenRoles = new Set<string>();
  for (const entry of definition.mobile?.roles ?? []) {
    const { role, grants } = mobileRole(entry);
    const [pack, local] = role.split(".");
    if (!pack || !local || role.split(".").length !== 2) {
      fail(`mobile.roles: ${role} is not <pack>.<role>`);
    }
    if (!definition.packs.includes(pack as string)) {
      fail(`mobile.roles: ${role} is a role of ${pack}, which packs does not list`);
    }
    if (seenRoles.has(role)) fail(`mobile.roles: ${role} is listed twice`);
    seenRoles.add(role);
    for (const grant of grants) {
      const [grantPack, name] = grant.split(":");
      if (!grantPack || !name || grant.split(":").length !== 2) {
        fail(`mobile.roles: ${role}'s grant ${grant} is not <pack>:<permission>`);
      }
      if (!definition.packs.includes(grantPack as string)) {
        fail(
          `mobile.roles: ${role}'s grant ${grant} is of ${grantPack}, which packs does not list`,
        );
      }
    }
  }
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
  const hints = Object.keys(LOCATION_HINTS).join(", ");
  if (definition.location !== undefined && !isLocationHint(definition.location)) {
    fail(`location is a location hint (${hints})`);
  }
  for (const [env, settings] of Object.entries(definition.environments ?? {})) {
    if (
      settings.location !== undefined &&
      settings.location !== "none" &&
      !isLocationHint(settings.location)
    ) {
      fail(`environments.${env}.location is none or a location hint (${hints})`);
    }
  }
  if (definition.environments?.[LIVE_ENVIRONMENT]?.live === false) {
    fail("the live environment cannot be marked live: false");
  }
  const deployments = environmentNames(definition);
  for (const env of deployments.length ? deployments : [undefined]) {
    if (
      gatekeeperSettings(definition, env).payments?.PAYMENTS_FAKE_PROVIDER === true &&
      isLiveEnvironment(definition, env)
    ) {
      fail(
        `${env ? `environment ${env}` : "the product"} is live and turns on the fake payment provider: only an environment marked live: false may`,
      );
    }
  }
  if (definition.environments) {
    const envs = environmentNames(definition);
    if (!envs.length) fail("environments is empty: leave it out for one deployment");
    const taken = new Map<string, string>();
    for (const env of envs) {
      if (!NAME.test(env)) fail(`environment ${env} must be lowercase letters, digits and hyphens`);
      const n = clientNames(definition, env);
      for (const key of ["app", "runner", "database"] as const) {
        if (!NAME.test(n[key])) fail(`environments.${env}.names.${key} is not a name`);
      }
      for (const key of ["gatekeeperPrefix", "resourcePrefix"] as const) {
        if (!PREFIX.test(n[key])) fail(`environments.${env}.names.${key} must end with a hyphen`);
      }
      const web = clientWeb(definition, env);
      if (web && !NAME.test(web.worker))
        fail(`environments.${env}.web.worker is not a Worker name`);
      // Two environments in one account never share a Worker, a database or a prefix.
      for (const name of [
        n.app,
        n.runner,
        n.database,
        n.resourcePrefix,
        n.gatekeeperPrefix,
        web?.worker,
      ]) {
        if (!name) continue;
        const other = taken.get(name);
        if (other) fail(`environments ${other} and ${env} both use the name ${name}`);
        taken.set(name, env);
      }
    }
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
