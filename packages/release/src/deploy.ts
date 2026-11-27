// The deploy engine (ADR 0163): puts a verified release bundle into a Cloudflare account through
// the REST API. Used by `create-composable-os` (install), `cos upgrade` and the self-updater.
//
//   provision resources (find by name, else create)   idempotent
//   apply pending core migrations                      bookkept in core_migrations
//   stage every Worker                                 versions API where possible, no traffic yet
//   switch every Worker                                deployments back to back, dependencies first
//   crons, queue consumers, workers.dev / custom domain
//
// Every step looks at what exists before changing it, so a re-run after a failure (or of a
// finished install) converges instead of duplicating.
import type { ReleaseBundle } from "./bundle.ts";
import {
  CloudflareApiError,
  type CloudflareClient,
  type LocationHint,
  type ModulePart,
} from "./cloudflare.ts";
import {
  FLEET_PACKAGES,
  type FleetDeployInput,
  type FleetState,
  fleetBindings,
  fleetConsumers,
  fleetDurableObjectMigration,
  fleetSecrets,
  isFleetWorker,
} from "./fleet.ts";
import { toBase64 } from "./hash.ts";
import {
  type DurableObjectMigration,
  deployOrder,
  type Feature,
  gatekeeperBindingName,
  type ManifestBinding,
  type PlaceholderValues,
  type ReleaseManifest,
  type ResourceEntry,
  renderBindings,
  renderString,
  type WorkerEntry,
} from "./manifest.ts";
import type { Channel } from "./semver.ts";

/** What an install chose, kept in D1 (`core_install`) so upgrades redeploy the same way. */
export interface DeploymentState {
  version: string;
  accountId: string;
  hostname: string;
  /**
   * How the app is reached: its workers.dev URL, a custom domain on a zone, or (hosted SaaS,
   * ADR 0210) through the platform's dispatch Worker, which owns routing and Cron Triggers.
   */
  hostnameMode: "workers.dev" | "custom" | "dispatch";
  zoneId?: string;
  /**
   * Workers for Platforms (ADR 0210): the dispatch namespace this deployment's Workers are user
   * Workers in. Absent: ordinary Workers in the account (self-hosted, enterprise dedicated).
   */
  dispatchNamespace?: string;
  /** Script tags set on every Worker of a namespaced deployment (e.g. `tenant-t3kx9`). */
  tags?: string[];
  identityProvider: "better-auth" | "cloudflare-access";
  channel: Channel;
  /** Optional Workers (gatekeepers) installed, by manifest name. */
  gatekeepers: string[];
  /**
   * In-app AI (Workers AI and the Vectorize index, ADR 0156): false when installed with
   * `--ai off`. Absent means on.
   */
  ai?: boolean;
  /**
   * The AI Gateway every model call goes through (ADR 0180): its id, or false when installed
   * with `--ai-gateway off`. Absent means the default, named after the install.
   */
  aiGateway?: string | false;
  /** The gateway was created by this deployment (so `cos uninstall` deletes it). */
  aiGatewayCreated?: boolean;
  /** The id of the generated gateway token stored as AI_GATEWAY_TOKEN. */
  aiGatewayTokenId?: string;
  /**
   * The AI_GATEWAY_TOKEN on the Workers can call Workers AI (Workers AI Read, ADR 0330), so
   * AI_GATEWAY_REST is on. Absent for a token generated before ADR 0330 or set by hand unchecked.
   */
  aiGatewayTokenWorkersAi?: boolean;
  /** Deployed names, when they differ from the manifest's. */
  workerNames: Record<string, string>;
  /**
   * Deployed resource names (D1, R2, KV, queues, Vectorize, Workflows) when they differ from the
   * manifest's: a hosted tenant's carry its id (ADR 0210).
   */
  resourceNames?: Record<string, string>;
  /** Plain var overrides per Worker (e.g. IDENTITY_PROVIDER, APPROVAL_FLOOR). */
  vars: Record<string, Record<string, string>>;
  /**
   * Settings of a Worker's `send_email` bindings per Worker and binding name (ADR 0452): which
   * sender and destination addresses Cloudflare Email Service lets it use. Deploy-time
   * configuration, as `vars` are; the release's binding is otherwise unchanged.
   */
  sendEmail?: Record<
    string,
    Record<
      string,
      {
        allowed_sender_addresses?: string[];
        destination_address?: string;
        allowed_destination_addresses?: string[];
      }
    >
  >;
  /**
   * The location hint chosen at the first install (ADR 0580), e.g. `oc` (Oceania): sent only when
   * a D1 database or an R2 bucket is created, never to one that exists. A preference Cloudflare
   * honours best effort, not a guarantee of where data is kept. Absent: no hint (Cloudflare
   * places each store itself). Never changed after the first install: a store already made stays
   * where it is.
   */
  locationHint?: LocationHint;
  /** Resolved resource placeholders, e.g. `D1_ID(demo)` → its uuid. */
  resources: Record<string, string>;
  /** sha256 of the installed bundle. */
  bundleDigest?: string;
  /**
   * A host of many clients (stage 66, ADR 0618): its environment, callback hostname, domain and
   * sealing public key. Absent on every single-client deployment, whose uploads it never changes.
   */
  fleet?: FleetState;
  installedAt?: string;
  updatedAt?: string;
}

export type Log = (message: string) => void;

// ---- Migrations ---------------------------------------------------------------------------------

export interface MigrationRunner {
  applied(): Promise<string[]>;
  apply(name: string, sql: string): Promise<void>;
}

const MIGRATIONS_TABLE = "core_migrations";
const CREATE_MIGRATIONS = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

/**
 * Core migrations over the D1 REST API, bookkept exactly like `wrangler d1 migrations apply`
 * (same table, one query per migration with its bookkeeping row appended, which D1 runs as one
 * batch), so either tool sees what the other applied.
 */
export function d1ApiMigrations(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): MigrationRunner {
  return {
    async applied() {
      await api.queryD1(accountId, databaseId, CREATE_MIGRATIONS);
      const [first] = await api.queryD1<{ name: string }>(
        accountId,
        databaseId,
        `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`,
      );
      return (first?.results ?? []).map((row) => row.name);
    },
    async apply(name, sql) {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`unsafe migration name ${name}`);
      await api.queryD1(
        accountId,
        databaseId,
        `${sql.trimEnd()}\nINSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${name}');`,
      );
    },
  };
}

/** Applies the bundle's pending migrations in order. Returns the names applied. */
export async function applyBundleMigrations(
  bundle: ReleaseBundle,
  runner: MigrationRunner,
  log: Log = () => {},
): Promise<string[]> {
  const applied = new Set(await runner.applied());
  const pending = bundle.manifest.migrations.filter((m) => !applied.has(m.name));
  for (const migration of pending) {
    log(`  migration ${migration.name}`);
    await runner.apply(migration.name, bundle.migration(migration.name));
  }
  return pending.map((m) => m.name);
}

// ---- Deployment state in D1 ---------------------------------------------------------------------

export async function readDeploymentState(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): Promise<DeploymentState | null> {
  try {
    const [first] = await api.queryD1<{ value: string }>(
      accountId,
      databaseId,
      "SELECT value FROM core_install WHERE key = 'deployment'",
    );
    const row = first?.results[0];
    return row ? (JSON.parse(row.value) as DeploymentState) : null;
  } catch (error) {
    if (error instanceof CloudflareApiError && /no such table/i.test(error.message)) return null;
    throw error;
  }
}

export async function writeDeploymentState(
  api: CloudflareClient,
  databaseId: string,
  state: DeploymentState,
): Promise<void> {
  await api.queryD1(
    state.accountId,
    databaseId,
    "INSERT INTO core_install (key, value, updated_at) VALUES ('deployment', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [JSON.stringify(state), new Date().toISOString()],
  );
}

// ---- Resources ----------------------------------------------------------------------------------

/** Whether a feature is on in this deployment. Features are on unless turned off. */
export function featureOn(state: Pick<DeploymentState, "ai">, feature: Feature): boolean {
  return feature === "ai" ? state.ai !== false : true;
}

/**
 * The resources this deployment needs: required ones plus those of installed optional Workers,
 * minus those of features that are off.
 */
export function neededResources(
  manifest: ReleaseManifest,
  gatekeepers: string[],
  features: Pick<DeploymentState, "ai" | "fleet"> = {},
): ResourceEntry[] {
  const installed = new Set(gatekeepers);
  // A fleet's own Workers' resources are needed on a fleet only (stage 66 step 7).
  if (features.fleet) {
    for (const w of manifest.workers) if (isFleetWorker(w)) installed.add(w.name);
  }
  return manifest.resources.filter(
    (r) =>
      (!r.optional || r.usedBy.some((worker) => installed.has(worker))) &&
      (!r.feature || featureOn(features, r.feature)),
  );
}

export interface ProvisionOptions {
  /**
   * A location hint for the D1 databases and R2 buckets this call CREATES (ADR 0580). One that
   * exists is found by name and left as it is: a store's location cannot be changed by a setting.
   * KV, queues and Vectorize take no location hint in Cloudflare's API, so none is sent for them.
   */
  locationHint?: LocationHint | undefined;
}

/**
 * Finds or creates each resource by its deployed name (`names`, else the manifest's). Returns
 * resolved placeholders (`D1_ID(demo)` → id).
 */
export async function provisionResources(
  api: CloudflareClient,
  accountId: string,
  manifestResources: ResourceEntry[],
  log: Log = () => {},
  names: Record<string, string> = {},
  options: ProvisionOptions = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const hint = options.locationHint ? { locationHint: options.locationHint } : {};
  const created = options.locationHint
    ? `created (location hint ${options.locationHint})`
    : "created";
  const key = (r: ResourceEntry) => (r.placeholder ?? "").replace(/^\$/, "");
  for (const entry of manifestResources) {
    if (entry.implicit) continue;
    const resource = { ...entry, name: names[entry.name] ?? entry.name };
    switch (resource.type) {
      case "d1": {
        const existing = (await api.listD1(accountId)).find((d) => d.name === resource.name);
        const db = existing ?? (await api.createD1(accountId, resource.name, hint));
        log(`  D1 ${resource.name}: ${existing ? "exists" : created}`);
        out[key(resource)] = db.uuid;
        break;
      }
      case "r2": {
        const exists = (await api.listR2(accountId)).some((b) => b.name === resource.name);
        if (!exists) await api.createR2(accountId, resource.name, hint);
        log(`  R2 ${resource.name}: ${exists ? "exists" : created}`);
        out[key(resource)] = resource.name;
        break;
      }
      case "kv": {
        const existing = (await api.listKv(accountId)).find((n) => n.title === resource.name);
        const ns = existing ?? (await api.createKv(accountId, resource.name));
        log(`  KV ${resource.name}: ${existing ? "exists" : "created"}`);
        out[key(resource)] = ns.id;
        break;
      }
      case "queue": {
        const existing = (await api.listQueues(accountId)).find(
          (q) => q.queue_name === resource.name,
        );
        if (!existing) await api.createQueue(accountId, resource.name);
        log(`  Queue ${resource.name}: ${existing ? "exists" : "created"}`);
        out[key(resource)] = resource.name;
        break;
      }
      case "vectorize": {
        const exists = (await api.listVectorize(accountId)).some((i) => i.name === resource.name);
        const { metadataIndexes, ...indexConfig } = (resource.config ?? {}) as {
          metadataIndexes?: { propertyName: string; indexType: "string" | "number" | "boolean" }[];
        } & Record<string, unknown>;
        if (!exists) await api.createVectorize(accountId, resource.name, indexConfig);
        log(`  Vectorize ${resource.name}: ${exists ? "exists" : "created"}`);
        if (metadataIndexes?.length) {
          const have = new Set(
            (await api.listVectorizeMetadataIndexes(accountId, resource.name)).map(
              (m) => m.propertyName,
            ),
          );
          for (const m of metadataIndexes) {
            if (have.has(m.propertyName)) continue;
            await api.createVectorizeMetadataIndex(
              accountId,
              resource.name,
              m.propertyName,
              m.indexType,
            );
            log(`  Vectorize ${resource.name}: metadata index ${m.propertyName}`);
          }
        }
        out[key(resource)] = resource.name;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function databaseIdOf(manifest: ReleaseManifest, resources: Record<string, string>): string {
  const d1 = manifest.resources.find((r) => r.type === "d1");
  const key = d1?.placeholder?.slice(1);
  const id = key ? resources[key] : undefined;
  if (!id) throw new Error("the release has no D1 database, or it was not provisioned");
  return id;
}

// ---- Workers ------------------------------------------------------------------------------------

/** The Durable Object migration to send, given the tag the deployed script is at. */
export function durableObjectMigration(
  history: DurableObjectMigration[],
  currentTag: string | undefined,
): Record<string, unknown> | undefined {
  if (history.length === 0) return undefined;
  const index = currentTag === undefined ? -1 : history.findIndex((m) => m.tag === currentTag);
  if (currentTag !== undefined && index === -1) {
    throw new Error(
      `deployed Durable Object migration tag ${currentTag} is not in this release's history`,
    );
  }
  const steps = history.slice(index + 1);
  if (steps.length === 0) return undefined;
  const last = steps[steps.length - 1] as DurableObjectMigration;
  return {
    ...(currentTag !== undefined ? { old_tag: currentTag } : {}),
    new_tag: last.tag,
    steps: steps.map(({ tag: _tag, ...step }) => step),
  };
}

export interface DeployInput {
  api: CloudflareClient;
  bundle: ReleaseBundle;
  state: DeploymentState;
  /** Secret values to set in this deploy; others keep their stored values. */
  secrets: Record<string, Record<string, string>>;
  /** A fleet deployment's keys and signed props (required when `state.fleet` is set). */
  fleet?: FleetDeployInput;
  log?: Log;
}

function workerName(state: DeploymentState, name: string) {
  return state.workerNames[name] ?? name;
}

export function placeholderValues(
  state: DeploymentState,
  secretsFor: Record<string, string>,
): PlaceholderValues {
  return {
    accountId: state.accountId,
    hostname: state.hostname,
    workerName: (name) => workerName(state, name),
    resource: (kind, name) => {
      const value = state.resources[`${kind}(${name})`];
      if (value === undefined) throw new Error(`resource ${kind}(${name}) was not provisioned`);
      return value;
    },
    secret: (name) => secretsFor[name],
  };
}

/**
 * The desk origin's hostname (stage 44 step 6, ADR 0649): `desk.` before the deployment's own
 * name, on a custom domain only. A workers.dev or dispatch deployment has none (it cannot add the
 * hostname), so it has no desk signing and no enrolled devices: nothing falls back to the staff
 * origin.
 */
export function deskHostname(state: Pick<DeploymentState, "hostnameMode" | "hostname">): string {
  return state.hostnameMode === "custom" ? `desk.${state.hostname}` : "";
}

/** The bindings a Worker is uploaded with in this deployment. */
export function workerBindings(
  worker: WorkerEntry,
  manifest: ReleaseManifest,
  state: DeploymentState,
  secrets: Record<string, string>,
  fleet?: FleetDeployInput,
): ManifestBinding[] {
  const values = placeholderValues(state, secrets);
  const overrides = state.vars[worker.name] ?? {};
  const wanted = worker.bindings
    .filter((b) => !b.feature || featureOn(state, b.feature))
    .map(({ feature: _feature, ...binding }) => binding as ManifestBinding);
  const deployedNames = state.resourceNames ?? {};
  const bindings = renderBindings(wanted, values).map((binding) => {
    if (binding.type === "plain_text" && overrides[binding.name] !== undefined) {
      return { ...binding, text: overrides[binding.name] };
    }
    // The Worker that declares the desk's hostname is told it (the app): set here, never a var.
    if (binding.type === "plain_text" && binding.name === "DESK_HOSTNAME") {
      return { ...binding, text: deskHostname(state) };
    }
    const email = state.sendEmail?.[worker.name]?.[binding.name];
    if (binding.type === "send_email" && email) {
      return { ...binding, ...email } as ManifestBinding;
    }
    // Workflows are named in the binding itself, so a deployed name is written into it.
    const workflow = (binding as { workflow_name?: string }).workflow_name;
    if (binding.type === "workflow" && workflow && deployedNames[workflow]) {
      return { ...binding, workflow_name: deployedNames[workflow] } as ManifestBinding;
    }
    return binding;
  });
  for (const [name, text] of Object.entries(overrides)) {
    // A var an older release had that this one declares a secret (FAKE_WEBHOOK_SECRET, issue
    // #217) is not uploaded as plain text: it would clash with the secret kept on the Worker.
    if ((worker.secrets ?? []).some((s) => s.name === name)) continue;
    if (!bindings.some((b) => b.name === name)) bindings.push({ type: "plain_text", name, text });
  }
  if (worker.gatekeeperBindings) {
    const { prefix, entrypoint } = worker.gatekeeperBindings;
    for (const gk of manifest.workers) {
      if (gk.role !== "gatekeeper" || !gk.shortName || !state.gatekeepers.includes(gk.name))
        continue;
      const name = gatekeeperBindingName(prefix, gk.shortName);
      if (bindings.some((b) => b.name === name)) continue;
      bindings.push({ type: "service", name, service: workerName(state, gk.name), entrypoint });
    }
  }
  // A fleet's bindings (ADR 0615's list), only when the state says it is one.
  let out = bindings;
  if (state.fleet) {
    if (!fleet) throw new Error("a fleet deployment needs its keys (the operator's keys file)");
    const { add, change } = fleetBindings(worker, manifest, state, fleet, (name) =>
      workerName(state, name),
    );
    out = bindings.map(change);
    for (const binding of add) {
      if (!out.some((b) => b.name === binding.name)) out.push(binding);
    }
  }
  // Any secret value supplied but not declared in the manifest (e.g. COS_UPDATE_TOKEN set late).
  for (const [name, text] of Object.entries(secrets)) {
    if (!out.some((b) => b.name === name)) out.push({ type: "secret_text", name, text });
  }
  return out;
}

async function uploadAssets(
  input: DeployInput,
  worker: WorkerEntry,
  deployedName: string,
): Promise<string | undefined> {
  if (!worker.assets) return undefined;
  const { bundle, state } = input;
  const api = scriptsApi(input.api, state);
  const files = worker.assets.files;
  const session = await api.assetsUploadSession(state.accountId, deployedName, files);
  const byHash = new Map(Object.entries(files).map(([path, f]) => [f.hash, path]));
  let completion: string | undefined = session.buckets?.length ? undefined : session.jwt;
  for (const bucket of session.buckets ?? []) {
    const parts = bucket.map((hash) => ({
      hash,
      base64: toBase64(bundle.asset(hash)),
      contentType: contentTypeOf(byHash.get(hash) ?? ""),
    }));
    const token = await api.uploadAssets(state.accountId, session.jwt, parts);
    if (token) completion = token;
  }
  if (!completion) throw new Error(`${deployedName}: assets upload did not complete`);
  return completion;
}

export function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain",
    webmanifest: "application/manifest+json",
  };
  return types[ext] ?? "application/octet-stream";
}

export interface DeployResult {
  url: string;
  workers: { name: string; deployedAs: string; via: "version" | "upload" }[];
}

/** Workers this deployment runs: every required Worker plus installed gatekeepers. */
export function selectedWorkers(manifest: ReleaseManifest, state: DeploymentState): WorkerEntry[] {
  const ordered = deployOrder(manifest.workers).filter((w) =>
    isFleetWorker(w) ? Boolean(state.fleet) : !w.optional || state.gatekeepers.includes(w.name),
  );
  if (!state.fleet) return ordered;
  // On a fleet, cos-client-db first (the host's Workers bind its entrypoint), then cos-operator.
  const rank = (w: WorkerEntry) =>
    w.package === FLEET_PACKAGES.clientDb ? 0 : w.package === FLEET_PACKAGES.operator ? 1 : 2;
  return [...ordered].sort((a, b) => rank(a) - rank(b));
}

/**
 * The Workers a Worker's bindings name, as deployed: a service binding's Worker, a Durable Object
 * or Workflow binding's `script_name` (another Worker's class). Cloudflare refuses an upload, or a
 * version, whose service binding names a Worker that does not exist (10143).
 */
export function boundWorkers(bindings: ManifestBinding[], self: string): string[] {
  const out = new Set<string>();
  for (const b of bindings as (ManifestBinding & { service?: unknown; script_name?: unknown })[]) {
    const target =
      b.type === "service"
        ? b.service
        : b.type === "durable_object_namespace" || b.type === "workflow"
          ? b.script_name
          : undefined;
    if (typeof target === "string" && target && target !== self) out.add(target);
  }
  return [...out];
}

/** The Workflows a Worker's bindings define with its own class (no other `script_name`). */
export function ownWorkflows(
  bindings: ManifestBinding[],
  self: string,
): { name: string; className: string }[] {
  const out: { name: string; className: string }[] = [];
  for (const b of bindings as (ManifestBinding & {
    workflow_name?: unknown;
    class_name?: unknown;
    script_name?: unknown;
  })[]) {
    if (b.type !== "workflow" || typeof b.workflow_name !== "string") continue;
    if (b.script_name !== undefined && b.script_name !== self) continue;
    out.push({ name: b.workflow_name, className: String(b.class_name) });
  }
  return out;
}

/**
 * `items` ordered so every Worker comes after the Workers of this deploy it binds (`deps`, by
 * deployed name), keeping `items`' order otherwise. The release's `dependsOn` knows only the
 * bindings in each Worker's committed configuration; the engine adds others (a gatekeeper on the
 * runner, a fleet's client-db on the app), so the order is taken from what is uploaded. A cycle
 * is refused: no order uploads it (it would need a two-pass upload, which nothing needs today).
 */
export function bindingOrder<T extends { deployedName: string; deps: string[] }>(items: T[]): T[] {
  const byName = new Map(items.map((i) => [i.deployedName, i]));
  const out: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (item: T, path: string[]) => {
    const seen = state.get(item.deployedName);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new Error(
        `the Workers bind each other in a cycle (${[...path, item.deployedName].join(" → ")}): no upload order can deploy them`,
      );
    }
    state.set(item.deployedName, "visiting");
    for (const dep of item.deps) {
      const target = byName.get(dep);
      if (target) visit(target, [...path, item.deployedName]);
    }
    state.set(item.deployedName, "done");
    out.push(item);
  };
  for (const item of items) visit(item, []);
  return out;
}

/** The client for this deployment's scripts: its dispatch namespace, if it has one (ADR 0210). */
export function scriptsApi(
  api: CloudflareClient,
  state: Pick<DeploymentState, "dispatchNamespace">,
): CloudflareClient {
  return state.dispatchNamespace && api.namespace !== state.dispatchNamespace
    ? api.forNamespace(state.dispatchNamespace)
    : api;
}

/**
 * Stages every Worker of the bundle, then switches them all back to back (dependencies first),
 * then sets triggers and routes. Resources must already be provisioned into `state.resources`.
 */
export async function deployWorkers(input: DeployInput): Promise<DeployResult> {
  const { api, bundle, state } = input;
  const log = input.log ?? (() => {});
  const manifest = bundle.manifest;
  // User Workers in a dispatch namespace (ADR 0210) have no versions API: each is uploaded
  // whole, still back to back after everything is staged and checked.
  const scriptApi = scriptsApi(api, state);
  const namespaced = Boolean(state.dispatchNamespace);
  const scripts = new Map((await scriptApi.listScripts(state.accountId)).map((s) => [s.id, s]));
  const workers = selectedWorkers(manifest, state);
  const secrets: Record<string, Record<string, string>> = { ...input.secrets };
  if (state.fleet) {
    if (!input.fleet) {
      throw new Error("a fleet deployment needs its keys (the operator's keys file)");
    }
    for (const [worker, values] of Object.entries(fleetSecrets(manifest, input.fleet.keys))) {
      secrets[worker] = { ...values, ...(secrets[worker] ?? {}) };
    }
  }
  const hostWorker = (w: WorkerEntry) => w.role === "app" || w.role === "runner";

  type Staged = {
    worker: WorkerEntry;
    deployedName: string;
    versionId?: string;
    metadata: Record<string, unknown>;
    modules: ModulePart[];
  };
  const staged: Staged[] = [];

  // Each Worker's bindings as uploaded, and the order they need: a Worker after every Worker of
  // this deploy it binds, since Cloudflare refuses a binding to a Worker that does not exist yet.
  const plans = bindingOrder(
    workers.map((worker) => {
      const deployedName = workerName(state, worker.name);
      const bindings = workerBindings(
        worker,
        manifest,
        state,
        secrets[worker.name] ?? {},
        input.fleet,
      );
      return { worker, deployedName, bindings, deps: boundWorkers(bindings, deployedName) };
    }),
  );
  // A new Worker that an existing one's new version binds (a gatekeeper added to the runner) is
  // uploaded while staging, before that version is: nothing routes to it until it is bound.
  const neededEarly = new Set(
    plans.filter((p) => scripts.has(p.deployedName)).flatMap((p) => p.deps),
  );
  const putEarly = new Set<string>();

  // 1. Stage: everything is uploaded and checked before any traffic moves.
  for (const { worker, deployedName, bindings } of plans) {
    const existing = scripts.get(deployedName);
    const migration =
      state.fleet && hostWorker(worker)
        ? fleetDurableObjectMigration(
            worker.durableObjectMigrations,
            existing ? existing.migration_tag : undefined,
          )
        : durableObjectMigration(
            worker.durableObjectMigrations,
            existing ? existing.migration_tag : undefined,
          );
    const assetsJwt = await uploadAssets(input, worker, deployedName);
    const metadata: Record<string, unknown> = {
      main_module: worker.mainModule,
      compatibility_date: worker.compatibilityDate,
      compatibility_flags: worker.compatibilityFlags,
      bindings,
      // Secrets not set in this deploy keep their stored values.
      keep_bindings: ["secret_text", "secret_key"],
      ...(worker.observability ? { observability: worker.observability } : {}),
      ...(assetsJwt ? { assets: { jwt: assetsJwt, config: worker.assets?.config ?? {} } } : {}),
      annotations: {
        "workers/message": `${manifest.productLabel} ${manifest.version}`,
        "workers/tag": manifest.version,
      },
      ...(namespaced && state.tags?.length ? { tags: state.tags } : {}),
    };
    const modules: ModulePart[] = worker.modules.map((m) => ({
      name: m.name,
      type: m.type,
      bytes: bundle.module(m.sha256),
    }));
    if (existing && !migration && !namespaced) {
      const { annotations: _a, observability: _o, ...versionMetadata } = metadata;
      const versionId = await api.uploadVersion(
        state.accountId,
        deployedName,
        versionMetadata,
        modules,
      );
      log(`  staged ${deployedName} (version ${versionId.slice(0, 8)})`);
      staged.push({ worker, deployedName, versionId, metadata, modules });
    } else {
      if (migration) metadata.migrations = migration;
      if (!existing && neededEarly.has(deployedName)) {
        await scriptApi.putScript(state.accountId, deployedName, metadata, modules);
        putEarly.add(deployedName);
        log(`  staged ${deployedName} (new Worker, uploaded now: an existing Worker binds it)`);
      } else {
        log(`  staged ${deployedName} (${existing ? "Durable Object migration" : "new Worker"})`);
      }
      staged.push({ worker, deployedName, metadata, modules });
    }
  }

  // 2. Switch: back to back, dependencies first.
  const result: DeployResult["workers"] = [];
  for (const item of staged) {
    if (putEarly.has(item.deployedName)) {
      result.push({ name: item.worker.name, deployedAs: item.deployedName, via: "upload" });
      log(`  switched ${item.deployedName} (uploaded while staging)`);
    } else if (item.versionId) {
      await scriptApi.deployVersion(
        state.accountId,
        item.deployedName,
        item.versionId,
        `${manifest.productLabel} ${manifest.version}`,
      );
      result.push({ name: item.worker.name, deployedAs: item.deployedName, via: "version" });
    } else {
      await scriptApi.putScript(state.accountId, item.deployedName, item.metadata, item.modules);
      result.push({ name: item.worker.name, deployedAs: item.deployedName, via: "upload" });
    }
    log(`  switched ${item.deployedName}`);
  }

  // 3. Triggers, consumers and routes.
  const values = placeholderValues(state, {});
  const queues =
    manifest.resources.some((r) => r.type === "queue") || state.fleet
      ? await api.listQueues(state.accountId)
      : [];
  for (const { worker, deployedName, metadata } of staged) {
    // A namespaced deployment's crons are run by the platform's dispatch Worker (ADR 0210).
    if (!namespaced) await api.putSchedules(state.accountId, deployedName, worker.crons);
    // Each Workflow whose class this Worker exports: uploading the Worker does not create it
    // (the Workflows API reference; wrangler's deploy makes this call too, `triggersDeploy`).
    if (!namespaced) {
      for (const flow of ownWorkflows(metadata.bindings as ManifestBinding[], deployedName)) {
        await api.putWorkflow(state.accountId, flow.name, {
          class_name: flow.className,
          script_name: deployedName,
        });
      }
    }
    // A fleet's own queues and every dead-letter queue (ADR 0615), named as deployed.
    const fleetQueues = fleetConsumers(worker, manifest, state).map((c) => ({
      ...c,
      deployed: true,
    }));
    for (const consumer of [...worker.queueConsumers, ...fleetQueues]) {
      const deployed = "deployed" in consumer;
      const queueName = deployed ? consumer.queue : renderString(consumer.queue, values);
      const queue = queues.find((q) => q.queue_name === queueName);
      if (!queue) throw new Error(`queue ${queueName} does not exist`);
      const existing = queue.consumers?.find(
        (c) => (c.script_name ?? c.script) === deployedName,
      )?.consumer_id;
      await api.putQueueConsumer(
        state.accountId,
        queue.queue_id,
        deployedName,
        consumer.settings,
        existing,
        consumer.deadLetterQueue
          ? deployed
            ? consumer.deadLetterQueue
            : renderString(consumer.deadLetterQueue, values)
          : undefined,
      );
    }
    if (namespaced) continue;
    const onWorkersDev = worker.public && state.hostnameMode === "workers.dev";
    await api.setWorkersDev(state.accountId, deployedName, onWorkersDev);
    if (worker.public && state.hostnameMode === "custom" && state.zoneId) {
      await api.putDomain(state.accountId, state.hostname, deployedName, state.zoneId);
      // The desk origin, on the same Worker (ADR 0649), for the Worker that serves it.
      if (worker.bindings.some((b) => b.type === "plain_text" && b.name === "DESK_HOSTNAME")) {
        await api.putDomain(state.accountId, deskHostname(state), deployedName, state.zoneId);
      }
    }
  }
  return { url: `https://${state.hostname}`, workers: result };
}

/**
 * Resolves the public hostname for workers.dev mode: `<app>.<subdomain>.workers.dev`. An account
 * with no workers.dev subdomain gets `<subdomainPrefix>-<start of the account id>`.
 */
export async function workersDevHostname(
  api: CloudflareClient,
  accountId: string,
  appWorker: string,
  subdomainPrefix: string,
): Promise<string> {
  let subdomain = await api.workersSubdomain(accountId);
  if (!subdomain) {
    subdomain = await api.createWorkersSubdomain(
      accountId,
      `${subdomainPrefix}-${accountId.slice(0, 8).toLowerCase()}`,
    );
  }
  return `${appWorker}.${subdomain}.workers.dev`;
}
