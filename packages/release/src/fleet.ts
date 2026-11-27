// What a fleet deployment, a host of many clients, binds (stage 66 step 7, ADR 0618; the list is
// ADR 0615's "What a many-client deployment binds, and where it comes from"). The deploy engine
// adds all of it to a deployment whose state has `fleet`, and to no other: the committed
// wrangler.jsonc of the app and the runner, which self-hosted installs use, never has any of it,
// and a single-client deployment's uploads are byte for byte what they were.
//
// Live and staging are two deployments, each with every item here of its own: its own Workers
// (staging's names end in `-staging`), registry, queues, cos-client-db and keys.
//
// The keys are never in the deployment state: the operator's keys file holds them (`cos`, which
// writes it only where the operator says, never into a repository), and each fleet deploy reads
// it, because the props each host Worker's bindings carry are signed with the props key. Secrets
// already set stay (`keep_bindings`); a deploy sets them again only with the same values.
import type { CloudflareClient } from "./cloudflare.ts";
import { type DeploymentState, type Log, provisionResources } from "./deploy.ts";
import type {
  DurableObjectMigration,
  ManifestBinding,
  ReleaseManifest,
  ResourceEntry,
  WorkerEntry,
} from "./manifest.ts";

/** The packages of a release's fleet Workers, deployed only on a fleet deployment. */
export const FLEET_PACKAGES = Object.freeze({
  clientDb: "apps/client-db",
  operator: "apps/operator",
});

export type FleetEnvironment = "live" | "staging";

/** What a fleet deployment chose, kept in its state. No key is here. */
export interface FleetState {
  environment: FleetEnvironment;
  /** The deployment's one callback hostname (ADR 0616): every gatekeeper's BASE_URL is under it. */
  callbackHostname: string;
  /** The fleet's own domain, under which `cos client add` names a client's hostnames. */
  domain: string;
  /** The public key given secrets are sealed to (ADR 0616): public, the operator's command's. */
  secretsPublicKey: string;
  /**
   * A SHA-256 of the root, binding and props keys the fleet was installed with (keys.ts
   * `keysFingerprint`), so a deploy refuses any other keys file before it sets a key (review of
   * #526, S2). It says nothing of the keys: each is 32 random bytes.
   */
  keysFingerprint?: string;
}

/** The host's keys, from the operator's keys file: each 32 random bytes as base64url. */
export interface FleetKeys {
  rootKey: string;
  secretsPrivateKey: string;
  secretsPrivateKeyPrevious?: string;
  /** Names objects; never rotated in place (ADR 0615, S4). */
  bindingKey: string;
  /** Signs every props proof and every call on cos-client-db; rotates with a previous one. */
  propsKey: string;
  propsKeyPrevious?: string;
}

/**
 * The props of the bindings the engine adds, signed with the props key by the caller (`cos`,
 * with packages/db's `clientDbCallerProps` and `runnerCallerProps`): this package names no key
 * scheme of its own.
 */
export interface FleetProps {
  clientDbApp: Record<string, string>;
  clientDbRunner: Record<string, string>;
  runnerCaller: Record<string, string>;
}

export interface FleetDeployInput {
  keys: FleetKeys;
  props: FleetProps;
}

/** The fan-out and parking queues' consumer settings (packages/db `FANOUT_CONSUMER`). */
export const FLEET_CONSUMER_SETTINGS = Object.freeze({
  batch_size: 1,
  max_wait_time_ms: 1000,
  max_retries: 3,
});

/** The class a fleet's app and runner each export for parking (packages/db `ParkingLedger`). */
export const PARKING_LEDGER_CLASS = "ParkingLedger";

const STAGING_SUFFIX = "-staging";

export function isFleetWorker(worker: Pick<WorkerEntry, "package" | "role">): boolean {
  return (
    worker.role === "fleet" ||
    worker.package === FLEET_PACKAGES.clientDb ||
    worker.package === FLEET_PACKAGES.operator
  );
}

function roleWorker(manifest: ReleaseManifest, role: "app" | "runner"): WorkerEntry {
  const worker = manifest.workers.find((w) => w.role === role);
  if (!worker) throw new Error(`the release has no ${role} Worker`);
  return worker;
}

function packageWorker(manifest: ReleaseManifest, pkg: string): WorkerEntry {
  const worker = manifest.workers.find((w) => w.package === pkg);
  if (!worker) {
    throw new Error(`the release has no ${pkg} Worker: it cannot be deployed as a fleet`);
  }
  return worker;
}

/** The release's resource prefix (`cos-` in the repository, `<product>-` in a release). */
function prefixOf(manifest: ReleaseManifest): string {
  const app = roleWorker(manifest, "app").name;
  return app.endsWith("app") ? app.slice(0, -"app".length) : `${app}-`;
}

/** A fleet's own resource name, with staging's suffix. */
function named(state: Pick<DeploymentState, "fleet">, name: string): string {
  return state.fleet?.environment === "staging" ? `${name}${STAGING_SUFFIX}` : name;
}

/** The names of what a fleet adds, as deployed. */
export function fleetNames(manifest: ReleaseManifest, state: Pick<DeploymentState, "fleet">) {
  const p = prefixOf(manifest);
  const n = (rest: string) => named(state, `${p}${rest}`);
  return {
    registry: n("registry"),
    exportsBucket: n("exports"),
    queues: {
      appFanout: n("app-fanout"),
      appParking: n("app-parking"),
      runnerFanout: n("runner-fanout"),
      runnerParking: n("runner-parking"),
    },
  };
}

/**
 * The deployed names of a fleet deployment's Workers and of the release's own resources: the
 * release's for live, each with `-staging` for staging, so the two deployments share nothing.
 */
export function fleetDeploymentNames(
  manifest: ReleaseManifest,
  environment: FleetEnvironment,
): { workers: Record<string, string>; resources: Record<string, string> } {
  if (environment === "live") return { workers: {}, resources: {} };
  const workers: Record<string, string> = {};
  for (const w of manifest.workers) workers[w.name] = `${w.name}${STAGING_SUFFIX}`;
  const resources: Record<string, string> = {};
  for (const r of manifest.resources) {
    if (r.type === "durable_object") continue;
    resources[r.name] = `${r.name}${STAGING_SUFFIX}`;
  }
  return { workers, resources };
}

const placeholderKey = (kind: string, name: string) => `${kind}(${name})`;

/** The resources a fleet adds: the registry, the exports bucket, and its queues and their DLQs. */
export function fleetResources(
  manifest: ReleaseManifest,
  state: Pick<DeploymentState, "fleet">,
): ResourceEntry[] {
  const names = fleetNames(manifest, state);
  const app = roleWorker(manifest, "app").name;
  const runner = roleWorker(manifest, "runner").name;
  const queue = (name: string, by: string): ResourceEntry => ({
    type: "queue",
    name,
    placeholder: `$${placeholderKey("QUEUE_NAME", name)}`,
    implicit: false,
    usedBy: [by],
    optional: false,
  });
  return [
    {
      type: "d1",
      name: names.registry,
      placeholder: `$${placeholderKey("D1_ID", names.registry)}`,
      implicit: false,
      usedBy: [app, runner],
      optional: false,
    },
    {
      type: "r2",
      name: names.exportsBucket,
      placeholder: `$${placeholderKey("R2_NAME", names.exportsBucket)}`,
      implicit: false,
      usedBy: [],
      optional: false,
    },
    ...[names.queues.appFanout, names.queues.appParking].flatMap((q) => [
      queue(q, app),
      queue(`${q}-dlq`, app),
    ]),
    ...[names.queues.runnerFanout, names.queues.runnerParking].flatMap((q) => [
      queue(q, runner),
      queue(`${q}-dlq`, runner),
    ]),
  ];
}

/** The resources the release's own bindings name, as deployed (for the bindings added below). */
function resourceOf(state: DeploymentState, kind: string, name: string): string {
  const value = state.resources[placeholderKey(kind, name)];
  if (value === undefined) throw new Error(`resource ${kind}(${name}) was not provisioned`);
  return value;
}

/** The deployed name of the release's resource named `name` in the manifest. */
function deployedResource(state: DeploymentState, name: string): string {
  return state.resourceNames?.[name] ?? name;
}

function bindingOf(worker: WorkerEntry, name: string): ManifestBinding | undefined {
  return worker.bindings.find((b) => b.name === name);
}

/** The secrets of the host's keys a Worker of a fleet holds. */
function keySecrets(keys: FleetKeys, which: "host" | "client-db" | "operator") {
  const out: Record<string, string> = {};
  if (which === "host" || which === "operator") {
    out.COS_ROOT_KEY = keys.rootKey;
    out.COS_SECRETS_PRIVATE_KEY = keys.secretsPrivateKey;
    if (keys.secretsPrivateKeyPrevious) {
      out.COS_SECRETS_PRIVATE_KEY_PREVIOUS = keys.secretsPrivateKeyPrevious;
    }
  }
  if (which === "host") out.COS_BINDING_KEY = keys.bindingKey;
  if (which === "host" || which === "client-db") {
    out.COS_PROPS_KEY = keys.propsKey;
    if (keys.propsKeyPrevious) out.COS_PROPS_KEY_PREVIOUS = keys.propsKeyPrevious;
  }
  return out;
}

/**
 * The secrets a fleet deploy sets on each Worker, by the release's Worker name: the host's keys
 * where each belongs (ADR 0615 and 0616). Never logged: `cos` hands every value to its redactor.
 */
export function fleetSecrets(
  manifest: ReleaseManifest,
  keys: FleetKeys,
): Record<string, Record<string, string>> {
  if (keys.bindingKey === keys.propsKey) {
    throw new Error("COS_BINDING_KEY and COS_PROPS_KEY must differ (ADR 0615, S4)");
  }
  return {
    [roleWorker(manifest, "app").name]: keySecrets(keys, "host"),
    [roleWorker(manifest, "runner").name]: keySecrets(keys, "host"),
    [packageWorker(manifest, FLEET_PACKAGES.clientDb).name]: keySecrets(keys, "client-db"),
    [packageWorker(manifest, FLEET_PACKAGES.operator).name]: keySecrets(keys, "operator"),
  };
}

/**
 * The bindings a fleet adds to (or changes on) one Worker, after the release's own are rendered.
 * `workerName` gives a Worker's deployed name.
 */
export function fleetBindings(
  worker: WorkerEntry,
  manifest: ReleaseManifest,
  state: DeploymentState,
  fleet: FleetDeployInput,
  workerName: (name: string) => string,
): { add: ManifestBinding[]; change: (binding: ManifestBinding) => ManifestBinding } {
  const f = state.fleet;
  if (!f) return { add: [], change: (b) => b };
  const names = fleetNames(manifest, state);
  const app = roleWorker(manifest, "app");
  const runner = roleWorker(manifest, "runner");
  const clientDb = packageWorker(manifest, FLEET_PACKAGES.clientDb);
  const operator = packageWorker(manifest, FLEET_PACKAGES.operator);
  const env = (name: string, text: string): ManifestBinding => ({ type: "plain_text", name, text });
  const registry: ManifestBinding = {
    type: "d1",
    name: "REGISTRY",
    database_id: resourceOf(state, "D1_ID", names.registry),
  };
  const add: ManifestBinding[] = [];
  let change = (b: ManifestBinding) => b;
  if (worker.name === app.name || worker.name === runner.name) {
    const isApp = worker.name === app.name;
    const q = isApp
      ? { fanout: names.queues.appFanout, parking: names.queues.appParking }
      : { fanout: names.queues.runnerFanout, parking: names.queues.runnerParking };
    add.push(
      registry,
      env("COS_HOST_ENVIRONMENT", f.environment),
      env("COS_CALLBACK_HOSTNAME", f.callbackHostname),
      {
        type: "service",
        name: "CLIENT_DB_QUERIES",
        service: workerName(clientDb.name),
        entrypoint: "ClientDbQueries",
        props: isApp ? fleet.props.clientDbApp : fleet.props.clientDbRunner,
      },
      { type: "queue", name: "CLIENT_FANOUT", queue_name: q.fanout },
      { type: "queue", name: "CLIENT_PARKING", queue_name: q.parking },
      {
        type: "durable_object_namespace",
        name: "CLIENT_PARKING_LEDGER",
        class_name: PARKING_LEDGER_CLASS,
      },
    );
    if (isApp) {
      // The app's binding to the runner carries the props without which callAs refuses.
      change = (b) =>
        b.type === "service" && b.name === "RUNNER" ? { ...b, props: fleet.props.runnerCaller } : b;
    }
  } else if (worker.name === clientDb.name) {
    add.push(env("COS_HOST_ENVIRONMENT", f.environment));
  } else if (worker.name === operator.name) {
    const blobs = bindingOf(app, "BLOBS");
    const kv = bindingOf(app, "OAUTH_KV");
    const index = bindingOf(app, "VECTORIZE");
    add.push(registry, env("COS_HOST_ENVIRONMENT", f.environment), {
      type: "r2_bucket",
      name: "EXPORTS",
      bucket_name: names.exportsBucket,
    });
    if (blobs) {
      const bucket = String(blobs.bucket_name).match(/^\$R2_NAME\((.+)\)$/)?.[1];
      if (bucket) {
        add.push({
          type: "r2_bucket",
          name: "BLOBS",
          bucket_name: resourceOf(state, "R2_NAME", bucket),
        });
      }
    }
    if (kv) {
      const title = String(kv.namespace_id).match(/^\$KV_ID\((.+)\)$/)?.[1];
      if (title) {
        add.push({
          type: "kv_namespace",
          name: "OAUTH_KV",
          namespace_id: resourceOf(state, "KV_ID", title),
        });
      }
    }
    if (index && state.ai !== false) {
      const name = String(index.index_name).match(/^\$VECTORIZE_NAME\((.+)\)$/)?.[1];
      if (name) {
        add.push({
          type: "vectorize",
          name: "VECTORIZE",
          index_name: resourceOf(state, "VECTORIZE_NAME", name),
        });
      }
    }
  } else if (worker.role === "gatekeeper" && worker.shortName) {
    // Every gatekeeper's BASE_URL is under the one callback address (ADR 0616).
    const base = `https://${f.callbackHostname}/gatekeeper/${worker.shortName}`;
    change = (b) => (b.type === "plain_text" && b.name === "BASE_URL" ? { ...b, text: base } : b);
    // Email sending takes each client's own sender domains, never the deployment's list (ADR
    // 0616, "Email sending per client"; issue #529).
    if (worker.shortName === "email-send") {
      const flag: ManifestBinding = {
        type: "plain_text",
        name: "SENDER_DOMAINS_PER_CLIENT",
        text: "true",
      };
      const before = change;
      change = (b) => (b.type === "plain_text" && b.name === flag.name ? flag : before(b));
      add.push(flag);
    }
  }
  return { add, change };
}

/** The queues a fleet's Worker consumes besides the release's: its own and every DLQ. */
export function fleetConsumers(
  worker: WorkerEntry,
  manifest: ReleaseManifest,
  state: DeploymentState,
): { queue: string; settings: Record<string, unknown>; deadLetterQueue?: string }[] {
  if (!state.fleet) return [];
  const names = fleetNames(manifest, state);
  const app = roleWorker(manifest, "app");
  const runner = roleWorker(manifest, "runner");
  if (worker.name !== app.name && worker.name !== runner.name) return [];
  const own =
    worker.name === app.name
      ? [names.queues.appFanout, names.queues.appParking]
      : [names.queues.runnerFanout, names.queues.runnerParking];
  // The release's own consumers' dead-letter queues, as deployed.
  const releaseDlqs = worker.queueConsumers
    .map((c) => c.deadLetterQueue?.match(/^\$QUEUE_NAME\((.+)\)$/)?.[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => deployedResource(state, name));
  return [
    ...own.map((queue) => ({
      queue,
      settings: { ...FLEET_CONSUMER_SETTINGS },
      deadLetterQueue: `${queue}-dlq`,
    })),
    ...[...own.map((q) => `${q}-dlq`), ...releaseDlqs].map((queue) => ({
      queue,
      settings: { batch_size: 10, max_wait_time_ms: 5000, max_retries: 3 },
    })),
  ];
}

/** The tag of a fleet's own Durable Object step, after the release's `tag` (none: `fleet`). */
export function fleetTag(tag: string | undefined): string {
  return tag === undefined ? "fleet" : `${tag}+fleet`;
}

/**
 * The Durable Object migration to send to a fleet's app or runner: the release's history, with the
 * fleet's own step (the `ParkingLedger` class, new SQLite) added once. A fleet Worker's deployed tag
 * is `<release tag>+fleet` once that step is in; the release's later steps follow it.
 */
export function fleetDurableObjectMigration(
  history: DurableObjectMigration[],
  currentTag: string | undefined,
): Record<string, unknown> | undefined {
  const fleetDone = currentTag === "fleet" || (currentTag?.endsWith("+fleet") ?? false);
  const releaseTag =
    currentTag === "fleet"
      ? undefined
      : fleetDone
        ? (currentTag as string).slice(0, -"+fleet".length)
        : currentTag;
  const index = releaseTag === undefined ? -1 : history.findIndex((m) => m.tag === releaseTag);
  if (releaseTag !== undefined && index === -1) {
    throw new Error(
      `deployed Durable Object migration tag ${currentTag} is not in this release's history`,
    );
  }
  const steps: Record<string, unknown>[] = history
    .slice(index + 1)
    .map(({ tag: _tag, ...step }) => step);
  if (!fleetDone) steps.push({ new_sqlite_classes: [PARKING_LEDGER_CLASS] });
  if (steps.length === 0) return undefined;
  return {
    ...(currentTag !== undefined ? { old_tag: currentTag } : {}),
    new_tag: fleetTag(history.at(-1)?.tag),
    steps,
  };
}

/** How long the exports bucket keeps what it holds: a removed client's export, 90 days. */
export const EXPORTS_KEPT_DAYS = 90;

/**
 * Finds or creates what a fleet adds (the registry, the exports bucket with its 90-day expiry, the
 * fan-out and parking queues and their dead-letter queues). Returns the resolved placeholders.
 */
export async function provisionFleet(
  api: CloudflareClient,
  manifest: ReleaseManifest,
  state: DeploymentState,
  log: Log = () => {},
): Promise<Record<string, string>> {
  const resources = await provisionResources(
    api,
    state.accountId,
    fleetResources(manifest, state),
    log,
    {},
    { locationHint: state.locationHint },
  );
  const exportsBucket = fleetNames(manifest, state).exportsBucket;
  await api.putR2ExpiryRule(
    state.accountId,
    exportsBucket,
    "exports-kept-90-days",
    EXPORTS_KEPT_DAYS,
  );
  log(`  R2 ${exportsBucket}: objects deleted after ${EXPORTS_KEPT_DAYS} days`);
  return resources;
}
