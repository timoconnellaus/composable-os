// `cos fleet …` and `cos client <add|pause|resume|list|secret|export|import|remove> …` (stage 66
// step 7, ADR 0618): the operator's commands for a host of many clients, over the account's token.
//
//   cos fleet keys --env <live|staging> --out <file>
//   cos fleet install --env <e> --keys-file <file> --callback-hostname <h> --domain <d> [--version]
//                     [--location <hint>] [--ai on|off]
//   cos fleet upgrade --env <e> --keys-file <file> [--version] [--skip-staging] [--dry-run] [--yes]
//   cos client add <id> [--env] [--tier] [--repository] [--location] [--staff-hostname]
//                  [--web-hostname] [--setting NAME=VALUE]… [--dry-run]
//   cos client pause|resume <id>, cos client list
//   cos client secret set <id> <NAME> [--value-file <f>], cos client secret remove <id> <NAME>
//   cos client export <id> [--out <dir>] [--leaving], cos client import <id> --from <dir>
//   cos client remove <id>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, type Migration } from "@composable-os/db";
import { clientDbCallerProps, runnerCallerProps } from "@composable-os/db/client-proofs";
import { firstAdminEmail, REGISTRY_MIGRATIONS_TABLE } from "@composable-os/db/registry";
import { migrationOf } from "@composable-os/db/sql-split";
import {
  compareVersions,
  type DeploymentState,
  deployWorkers,
  FLEET_PACKAGES,
  type FleetAttach,
  type FleetDeployInput,
  type FleetEnvironment,
  fleetDeploymentNames,
  fleetNames,
  healthSmoke,
  installRelease,
  locateDeployment,
  provisionFleet,
  type ReleaseBundle,
  writeDeploymentState,
} from "@composable-os/release";
import {
  aiChoice,
  CliError,
  type Deps,
  type Flags,
  latestVersion,
  locationChoice,
  parseArgs,
  productOf,
  refuseOtherProduct,
  type Session,
  session,
  str,
  verified,
} from "../main.ts";
import {
  addClient,
  canonicalDomain,
  exportClient,
  type FleetContext,
  FleetError,
  hostnameCommand,
  importClient,
  listClientsCommand,
  packCatalogue,
  pauseClient,
  REACHABLE_WAIT_MS,
  removeClient,
  removeSecret,
  resumeClient,
  senderCommand,
  setSecret,
} from "./clients.ts";
import { d1OverRest } from "./d1-rest.ts";
import { FORCE_FAILURE_VAR, forcedFailure, withForcedMigration } from "./forced-failure.ts";
import { fleetGatekeepers } from "./gatekeepers.ts";
import { cloudflareEdge, dohTxt, reachable, setUpFleetZone, zoneOf } from "./hostnames.ts";
import {
  type KeysFile,
  keysFingerprint,
  keysMismatch,
  newFleetKeys,
  readKeysFile,
  writeKeysFile,
} from "./keys.ts";
import { openOperator, STALE_NOTE } from "./operator-client.ts";
import { lazyOperator } from "./session.ts";
import {
  addSettingsProblems,
  firstAdminCommand,
  firstAdminTokenCommand,
  fleetDomainOf,
  labelSetting,
  type SetupTokenSource,
  settingCommand,
  setupTokenSource,
} from "./settings.ts";
import { streamSettingsOf } from "./stream.ts";
import { fleetUpdate } from "./update.ts";

export const CLIENT_COMMANDS = [
  "add",
  "pause",
  "resume",
  "list",
  "secret",
  "export",
  "import",
  "remove",
  "sender",
  "setting",
  "first-admin",
  "first-admin-token",
  "hostname",
] as const;

export const FLEET_USAGE = `cos fleet: a host of many clients (stage 66, docs/deploying.md "A host of many clients")
  cos fleet keys --env <live|staging> --out <file>     the deployment's keys, into <file> (0600, outside any repository)
  cos fleet install --env <e> --keys-file <file> --callback-hostname <h> --domain <d> [--version x.y.z]
                 [--location <hint>] [--ai on|off]   (both at the first install only)
                 [--zone <zone>] [--attach custom-domains|wildcard]
                 the zone is the account's zone that holds --domain (learnt when not named);
                 wildcard: one route for the whole domain, only when it is the zone's apex and
                 the zone is the fleet's alone
                 [--stream-account-id <id> --stream-customer-code <c> --stream-signing-key-id <id>
                  --stream-token-file <f> --stream-jwk-file <f>]   the operator's Stream account
  cos fleet upgrade --env <e> --keys-file <file> [--version x.y.z] [--dry-run] [--yes] [--skip-staging]
cos client: the clients of a host of many clients (each takes --env <live|staging>, default live)
  cos client add <id> [--tier standard|bespoke] [--repository o/r] [--location oc] [--staff-hostname h]
                 [--desk | --desk-hostname h] [--web-hostname h] [--setting NAME=VALUE]… [--dry-run]
  cos client hostname add|verify|remove <id> <hostname> | hostname list <id>
                 a client's own web domain: added unverified (the DNS records it needs are
                 printed), verified once Cloudflare reports it active, then served by cos-front
  cos client pause <id> | resume <id> | list
  cos client secret set <id> <NAME> [--value-file <f>] | secret remove <id> <NAME>
  cos client export <id> [--out <dir>] [--leaving]
  cos client import <id> --from <dir> [--without-secrets] [--staff-hostname h] [--web-hostname h]
                 (no video is re-stamped: one that is not already the client's refuses it)
                 [--setting COS_PACKS=…] (needed for an export that does not carry its packs)
  cos client remove <id>
  cos client sender add|verify|unverify|remove <id> <domain>
                 a client's sender domains; verify is your confirmation that the domain is
                 onboarded to Email Sending in this account with valid records
  cos client setting list <id> | setting set <id> <NAME> <value> | setting unset <id> <NAME>
                 a running client's settings: COS_PACKS (only wider), API_ALLOWED_ORIGINS,
                 NATIVE_REDIRECT_URIS, APPROVAL_EXPIRY_DAYS, COS_PRODUCT_LABEL
  cos client first-admin-token --staff-hostname <host>
                 ON YOUR OWN MACHINE, NEVER IN CI (refused there): makes a first admin's setup
                 token, prints the link to send them and the SHA-256 for the next command
  cos client first-admin <id> --email <address> --token-sha256 <sha256> | --print-link
                 who may make the client's first account: only the token's hash is given and kept,
                 nothing printed of it or of the address; --print-link makes one and prints the
                 link, at a terminal only (refused in CI); add takes --admin <email>
                 --admin-token-sha256 <sha256> and --label <name> too
Every command takes --product <id>: a fleet is installed as the hosted product, --product composable.
Every command that removes or overwrites asks for the client's id (or --yes); --dry-run changes nothing.
One command at a time uses the operator's Worker; --take-over takes it from one that was killed.`;

function environmentOf(flags: Flags): FleetEnvironment {
  const env = str(flags, "env") ?? "live";
  if (env !== "live" && env !== "staging") throw new CliError("--env is live or staging");
  return env;
}

/** The registry's own migrations, as the CLI carries them (a checkout, or dist/platform). */
export function registryMigrations(): Migration[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "platform", "registry-migrations"),
    join(here, "..", "platform", "registry-migrations"),
    join(here, "..", "..", "..", "db", "registry-migrations"),
  ];
  const dir = candidates.find((c) => existsSync(c));
  if (!dir) throw new CliError("the registry's migrations are not with this cos");
  return readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => migrationOf(name, readFileSync(join(dir, name), "utf8")));
}

/** A release's core migrations, from its verified bundle. */
export function bundleMigrations(bundle: ReleaseBundle): Migration[] {
  return bundle.manifest.migrations.map((m) => migrationOf(m.name, bundle.migration(m.name)));
}

function fleetInput(keys: KeysFile, environment: FleetEnvironment): FleetDeployInput {
  return {
    keys,
    props: {
      clientDbApp: clientDbCallerProps(keys.propsKey, environment, "cos-app"),
      clientDbRunner: clientDbCallerProps(keys.propsKey, environment, "cos-runner"),
      runnerCaller: runnerCallerProps(keys.propsKey, environment),
    },
  };
}

function databaseName(s: Session, environment: FleetEnvironment): string {
  return environment === "staging"
    ? `${s.product.names.database}-staging`
    : s.product.names.database;
}

async function locateFleet(s: Session, environment: FleetEnvironment, deps: Deps) {
  const located = await locateDeployment(s.api, s.accountId, databaseName(s, environment));
  const state = located?.state;
  if (!located || !state?.fleet) {
    throw new CliError(
      `No ${environment} host of many clients of ${s.product.label} in this account: run cos fleet install --env ${environment} first.`,
    );
  }
  if (state.fleet.environment !== environment) {
    throw new CliError(
      `The ${databaseName(s, environment)} deployment is ${state.fleet.environment}'s`,
    );
  }
  refuseOtherProduct(state, s.product, deps, databaseName(s, environment));
  return { databaseId: located.databaseId, state };
}

async function readKeys(flags: Flags, deps: Deps, environment: FleetEnvironment) {
  const path = str(flags, "keys-file");
  if (!path)
    throw new CliError("--keys-file <file>: the deployment's keys (cos fleet keys made it)");
  const keys = await readKeysFile(path, (v) => deps.redactor.add(v));
  if (keys.environment !== environment) {
    throw new CliError(
      `${path} holds the ${keys.environment} deployment's keys, not ${environment}'s`,
    );
  }
  return keys;
}

// --- cos fleet -----------------------------------------------------------------------------------

async function fleetKeys(flags: Flags, deps: Deps): Promise<number> {
  const environment = environmentOf(flags);
  const out = str(flags, "out");
  if (!out) throw new CliError("--out <file>: where the keys are written (outside any repository)");
  const keys = await newFleetKeys(environment);
  for (const v of [keys.rootKey, keys.secretsPrivateKey, keys.bindingKey, keys.propsKey]) {
    deps.redactor.add(v);
  }
  writeKeysFile(resolve(out), keys);
  deps.io.out(`Wrote the ${environment} deployment's keys to ${resolve(out)} (mode 0600).`);
  deps.io.out(`  sealing public key: ${keys.secretsPublicKey}`);
  deps.io.out("  Keep the file as you keep the account's token: every fleet deploy reads it.");
  return 0;
}

/**
 * A fleet that exists is installed again only as it is (a re-run to finish an install that
 * stopped): another version would upload new code with no client's database migrated, and another
 * domain or callback hostname would move what clients rely on (review of #547, M1).
 */
function refuseReinstall(
  state: DeploymentState | null | undefined,
  wanted: { version: string; domain: string; callbackHostname: string },
): void {
  const fleet = state?.fleet;
  if (!state || !fleet) return;
  const differs = [
    wanted.version !== state.version &&
      `version ${state.version} (an upgrade is cos fleet upgrade, which migrates every client)`,
    wanted.domain !== fleet.domain && `domain ${fleet.domain}`,
    wanted.callbackHostname !== fleet.callbackHostname &&
      `callback hostname ${fleet.callbackHostname}`,
  ].filter(Boolean);
  if (differs.length) {
    throw new CliError(
      `This ${fleet.environment} fleet is already installed, with ${differs.join(", ")}: a re-run of cos fleet install names what is installed, and nothing was changed.`,
    );
  }
}

async function fleetInstall(flags: Flags, deps: Deps): Promise<number> {
  const environment = environmentOf(flags);
  const keys = await readKeys(flags, deps, environment);
  const callbackHostname = str(flags, "callback-hostname");
  const domain = str(flags, "domain");
  if (!callbackHostname || !domain) {
    throw new CliError("--callback-hostname <h> and --domain <d> are needed for a fleet");
  }
  // The fleet's domain in the registry's one form (case, a trailing dot, an IDN), so no other
  // spelling of it can turn off the rule that keeps clients' web apps off it (S3).
  const fleetDomain = canonicalDomain(domain);
  if (!fleetDomain) throw new CliError(`--domain ${domain} is not a hostname`);
  const { callbackHostname: canonical } = await import("@composable-os/db/callbacks");
  if (canonical({ COS_CALLBACK_HOSTNAME: callbackHostname }) !== callbackHostname) {
    throw new CliError(`${callbackHostname} is not a canonical hostname`);
  }
  const s = await session(flags, deps);
  const existing = await locateDeployment(s.api, s.accountId, databaseName(s, environment));
  if (existing?.state && !existing.state.fleet) {
    throw new CliError(
      "That deployment is a single-client one: a fleet is installed apart from it",
    );
  }
  refuseOtherProduct(existing?.state, s.product, deps, databaseName(s, environment));
  const version =
    str(flags, "version") ?? existing?.state?.version ?? (await latestVersion(s, "stable"));
  refuseReinstall(existing?.state, { version, domain: fleetDomain, callbackHostname });
  const { bundle, digest } = await verified(s, version, deps);
  const manifest = bundle.manifest;
  const app = manifest.workers.find((w) => w.role === "app");
  if (!app) throw new CliError("The release has no app Worker.");
  const names = fleetDeploymentNames(manifest, environment);
  const subdomain = await s.api.workersSubdomain(s.accountId);
  // Chosen at the first install only, as for a single-client one: a store's place is where it was
  // made, and AI's resources are made or not then (a later `--ai` or `--location` is refused).
  const ai = aiChoice(flags, deps.env);
  const location = locationChoice(flags);
  if (existing?.state && (str(flags, "ai") !== undefined || location !== undefined)) {
    throw new CliError(
      "--ai and --location are chosen at the first install of a fleet: this one exists, and nothing was changed",
    );
  }
  const state: DeploymentState = existing?.state ?? {
    version,
    accountId: s.accountId,
    hostname: `${names.workers[app.name] ?? app.name}.${subdomain ?? "workers"}.workers.dev`,
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: [],
    workerNames: names.workers,
    resourceNames: names.resources,
    vars: {},
    resources: {},
    bundleDigest: digest,
    installedAt: new Date().toISOString(),
    ...(ai === false ? { ai: false } : {}),
    ...(location && location !== "none" ? { locationHint: location } : {}),
  };
  // A fleet's gatekeepers are the platform's fixed list (ADR 0618), on a re-run too.
  state.gatekeepers = fleetGatekeepers(manifest);
  // The operator's Stream account (stage 66 step 9): its ids kept in the state, so every upload
  // sets them again; its token and signing key the app Worker's secrets, kept by every upload.
  const stream = streamSettingsOf(flags, (v) => deps.redactor.add(v));
  if (stream) state.vars[app.name] = { ...state.vars[app.name], ...stream.vars };
  // The keys file must be the one this deployment was installed with (S2): never re-keyed here.
  if (state.fleet) {
    const mismatch = keysMismatch(state.fleet, keys);
    if (mismatch) {
      throw new CliError(
        `The keys file is not this ${environment} deployment's: ${mismatch}. Nothing was changed. Use the file it was installed with.`,
      );
    }
  }
  // The zone the fleet's domain is on (stage 66 step 8, ADR 0619): where its hostnames are
  // attached. None: nothing is attached, and the commands say so.
  const attachFlag = str(flags, "attach");
  if (attachFlag && attachFlag !== "custom-domains" && attachFlag !== "wildcard") {
    throw new CliError("--attach is custom-domains or wildcard");
  }
  let zone: { id: string; name: string } | null;
  try {
    zone = await zoneOf(s.api, s.accountId, fleetDomain, str(flags, "zone"));
  } catch (error) {
    throw new CliError((error as Error).message);
  }
  const attach =
    (attachFlag as FleetAttach | undefined) ?? existing?.state?.fleet?.attach ?? "custom-domains";
  if (attach === "wildcard" && zone?.name !== fleetDomain) {
    throw new CliError(
      `--attach wildcard needs --domain to be its zone's apex (${zone?.name ?? "no zone holds it"}): Universal SSL covers only one level under the apex, and the route takes every name of the zone. Use custom-domains.`,
    );
  }
  if (zone && !callbackHostname.endsWith(`.${fleetDomain}`)) {
    throw new CliError(
      `--callback-hostname ${callbackHostname} must be under --domain ${fleetDomain}`,
    );
  }
  state.fleet = {
    environment,
    callbackHostname,
    domain: fleetDomain,
    secretsPublicKey: state.fleet?.secretsPublicKey ?? keys.secretsPublicKey,
    keysFingerprint: state.fleet?.keysFingerprint ?? keysFingerprint(keys),
    ...(zone ? { zone } : {}),
    attach,
  };
  const log = (l: string) => deps.io.out(l);
  deps.io.out(`Installing a ${environment} host of many clients of ${s.product.label} ${version}:`);
  // The registry first, migrated before any Worker binds it.
  state.resources = { ...state.resources, ...(await provisionFleet(s.api, manifest, state, log)) };
  const registryId = state.resources[`D1_ID(${fleetNames(manifest, state).registry})`] as string;
  const applied = await applyMigrations(
    d1OverRest(s.api, s.accountId, registryId),
    registryMigrations(),
    {
      table: REGISTRY_MIGRATIONS_TABLE,
    },
  );
  deps.io.out(`  registry migrations: ${applied.length ? applied.join(", ") : "up to date"}`);
  // The single-client staff secret the release declares is required of the app: a fleet derives
  // every client's, so a random one is set once and never used.
  const appSecrets: Record<string, string> = {};
  const appName = state.workerNames[app.name] ?? app.name;
  const set = (await s.api.listScripts(s.accountId)).some((sc) => sc.id === appName)
    ? await s.api.listSecrets(s.accountId, appName)
    : [];
  if (!set.includes("BETTER_AUTH_SECRET")) {
    appSecrets.BETTER_AUTH_SECRET = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex");
    deps.redactor.add(appSecrets.BETTER_AUTH_SECRET);
  }
  if (stream) {
    Object.assign(appSecrets, stream.secrets);
    deps.io.out("  Stream: the account's ids kept with the deployment, its token and key set");
  }
  const result = await installRelease({
    api: s.api,
    bundle,
    state,
    secrets: { [app.name]: appSecrets },
    fleet: fleetInput(keys, environment),
    log,
  });
  // The fleet's zone, once its Workers exist: the callback hostname, and where clients' own
  // domains point (each made once, so a re-run converges).
  if (state.fleet.zone) {
    const set = await setUpFleetZone(
      { api: s.api, accountId: s.accountId, fleet: state.fleet, ...edgeWorkers(manifest, state) },
      log,
    );
    // Whether clients' own domains can be served (Cloudflare for SaaS on the zone), kept in the
    // state so `cos client hostname add` refuses plainly until it is (ADR 0619).
    const installed = result.state.fleet ?? state.fleet;
    await writeDeploymentState(s.api, result.databaseId, {
      ...result.state,
      fleet: { ...installed, clientDomains: set.clientDomains },
    });
  } else {
    deps.io.err(
      `  no zone of this account holds ${fleetDomain}: no hostname is attached (add the zone and run this again)`,
    );
  }
  deps.io.out(
    `\nDone: the ${environment} host is ${version}. Add a client with cos client add <id> --env ${environment}.`,
  );
  void result;
  return 0;
}

async function fleetUpgrade(flags: Flags, deps: Deps): Promise<number> {
  const environment = environmentOf(flags);
  // The staging check's forced failure, refused before anything is read anywhere else.
  const forced = forcedFailure(deps.env, { environment, product: productOf(flags, deps) });
  const keys = await readKeys(flags, deps, environment);
  const s = await session(flags, deps);
  const { databaseId, state } = await locateFleet(s, environment, deps);
  const mismatch = keysMismatch(state.fleet as NonNullable<typeof state.fleet>, keys);
  if (mismatch) {
    throw new CliError(
      `The keys file is not this ${environment} deployment's: ${mismatch}. Nothing was changed. Use the file it was installed with.`,
    );
  }
  const to = str(flags, "version") ?? (await latestVersion(s, state.channel));
  if (compareVersions(to, state.version) <= 0) {
    deps.io.out(`${state.version} is installed; nothing newer.`);
    return 0;
  }
  // Staging first (decision 10): live takes a release only once staging runs it.
  if (environment === "live" && !flags["skip-staging"]) {
    const staging = await locateDeployment(s.api, s.accountId, databaseName(s, "staging"));
    if (!staging?.state || compareVersions(staging.state.version, to) < 0) {
      throw new CliError(
        `Staging is at ${staging?.state?.version ?? "nothing"}: update staging to ${to} first (or --skip-staging, deliberately).`,
      );
    }
  }
  const target = await verified(s, to, deps);
  // The new release's fleet gatekeepers (ADR 0618): a fleet installed before them gains them here.
  const upgraded = {
    ...state,
    product: target.bundle.manifest.product,
    gatekeepers: fleetGatekeepers(target.bundle.manifest),
  };
  let previous: ReleaseBundle | null = null;
  const fleet = fleetInput(keys, environment);
  return withContext(`fleet upgrade ${environment}`, flags, deps, s, state, async (context) => {
    let ctx = context;
    if (forced?.kind === "migration") {
      deps.io.err(
        `  ${FORCE_FAILURE_VAR}: ${forced.client}'s migration is made to fail (the staging check)`,
      );
      ctx = { ...context, operator: withForcedMigration(context.operator, forced.client) };
    }
    const outcome = await fleetUpdate(ctx, {
      from: state.version,
      to,
      migrations: bundleMigrations(target.bundle),
      supportedContracts: target.bundle.manifest.extensionContract.supported,
      upload: async () => {
        await deployWorkers({
          api: s.api,
          bundle: target.bundle,
          state: upgraded,
          secrets: {},
          fleet,
          log: (l) => deps.io.out(l),
        });
      },
      uploadPrevious: async () => {
        previous ??= (await verified(s, state.version, deps)).bundle;
        await deployWorkers({
          api: s.api,
          bundle: previous,
          state,
          secrets: {},
          fleet,
          log: (l) => deps.io.out(l),
        });
      },
      smoke: async (hostname) => {
        await healthSmoke(hostname, to, {
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.env.COS_HEALTH_ORIGIN ? { origin: deps.env.COS_HEALTH_ORIGIN } : {}),
          ...(deps.smokeDelayMs !== undefined ? { delayMs: deps.smokeDelayMs } : {}),
        });
        // After the real check, so the run shows the new Workers answered before the rollback.
        if (forced?.kind === "smoke") {
          throw new Error(`${FORCE_FAILURE_VAR}=smoke: made to fail (the staging check)`);
        }
      },
      recordVersion: async (version) => {
        await writeDeploymentState(s.api, databaseId, {
          ...upgraded,
          version,
          bundleDigest: target.digest,
          updatedAt: new Date().toISOString(),
        });
      },
    });
    return outcome === "succeeded" || outcome === "nothing" ? 0 : 1;
  });
}

/** cos-app's and cos-front's deployed names (the release names them from the product). */
function edgeWorkers(
  manifest: ReleaseBundle["manifest"],
  state: DeploymentState,
): { appWorker: string; frontWorker: string | null } {
  const app = manifest.workers.find((w) => w.role === "app");
  if (!app) throw new CliError("The release has no app Worker.");
  const front = manifest.workers.find((w) => w.package === FLEET_PACKAGES.front);
  return {
    appWorker: state.workerNames[app.name] ?? app.name,
    frontWorker: front ? (state.workerNames[front.name] ?? front.name) : null,
  };
}

// --- cos client ----------------------------------------------------------------------------------

/** Runs `body` with a fleet context: the registry over REST and an operator session. */
async function withContext(
  command: string,
  flags: Flags,
  deps: Deps,
  s: Session,
  state: DeploymentState,
  body: (ctx: FleetContext) => Promise<number>,
): Promise<number> {
  const fleet = state.fleet;
  if (!fleet) throw new CliError("Not a host of many clients");
  const installed = await verified(s, state.version, deps);
  const manifest = installed.bundle.manifest;
  const registryId = state.resources[`D1_ID(${fleetNames(manifest, state).registry})`];
  if (!registryId) throw new CliError("The deployment's registry was not provisioned");
  const operatorWorker = manifest.workers.find((w) => w.package === FLEET_PACKAGES.operator);
  if (!operatorWorker) throw new CliError("The release has no operator's Worker");
  const script = state.workerNames[operatorWorker.name] ?? operatorWorker.name;
  const subdomain = await s.api.workersSubdomain(s.accountId);
  const origin = deps.env.COS_OPERATOR_ORIGIN ?? `https://${script}.${subdomain}.workers.dev`;
  const registry = d1OverRest(s.api, s.accountId, registryId);
  // Opened (and the operator's session taken) only on the command's first call to it (S1).
  const operator = lazyOperator(
    registry,
    (session) =>
      openOperator({
        api: s.api,
        accountId: s.accountId,
        script,
        origin,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        redact: (v) => deps.redactor.add(v),
        stale: {
          onStale: (what, n) => n === 1 && deps.io.err(`  ${what}: ${STALE_NOTE}`),
          stillHolds: session.stillHolds,
        },
      }),
    { command, ...(flags["take-over"] ? { takeOver: true } : {}) },
  );
  const edge = cloudflareEdge({
    api: s.api,
    accountId: s.accountId,
    fleet,
    ...edgeWorkers(manifest, state),
  });
  try {
    return await body({
      registry,
      operator,
      fleet,
      ...(edge ? { edge } : {}),
      // The `_cos-client` record of a client's own domain, read over DNS over HTTPS.
      txt: dohTxt(deps.fetch ?? fetch),
      // A new hostname's DNS and certificate can take minutes: waited for, unless --no-wait.
      ...(flags["no-wait"]
        ? {}
        : {
            reach: (hostname: string) =>
              reachable(hostname, {
                ...(deps.fetch ? { fetch: deps.fetch } : {}),
                timeoutMs: REACHABLE_WAIT_MS,
              }),
          }),
      migrations: bundleMigrations(installed.bundle),
      packs: packCatalogue(installed.bundle.clientFiles),
      io: deps.io,
      yes: Boolean(flags.yes),
      dryRun: Boolean(flags["dry-run"]),
      videos: {
        creatorOf: (uid) => s.api.streamVideoCreator(s.accountId, uid),
      },
    });
  } finally {
    await operator.close().catch(() => {});
  }
}

function settingsOf(flags: Flags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (flags.setting as string[] | undefined) ?? []) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/s.exec(entry);
    if (!match) throw new CliError("--setting expects NAME=VALUE");
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

async function secretValue(flags: Flags, deps: Deps, name: string): Promise<string> {
  const file = str(flags, "value-file");
  const value = file
    ? readFileSync(file, "utf8").replace(/\r?\n$/, "")
    : deps.io.interactive
      ? await deps.io.ask(`${name}`, { secret: true })
      : "";
  if (!value) throw new CliError(`${name}: give the value with --value-file <f> or at the prompt`);
  deps.redactor.add(value);
  return value;
}

/** The first admin `cos client add --admin` names, and where its setup token comes from. */
interface FirstAdminPlan {
  email: string;
  source: SetupTokenSource;
}

/**
 * `cos client add`'s own flags of stage 66 step 9, before anything is written: `--label` as the
 * client's `COS_PRODUCT_LABEL`, `--admin` an address with its token's SHA-256
 * (`--admin-token-sha256`, or `--print-link` at a terminal), and each setting as `cos client
 * setting` checks it (the hostnames it is added with; packs against the release's catalogue).
 */
function prepareAdd(
  ctx: FleetContext,
  id: string | undefined,
  flags: Flags,
  deps: Deps,
): FirstAdminPlan | null {
  const label = str(flags, "label");
  if (label !== undefined) {
    const setting = labelSetting(label);
    flags.setting = [
      ...((flags.setting as string[] | undefined) ?? []),
      `COS_PRODUCT_LABEL=${setting.COS_PRODUCT_LABEL}`,
    ];
  }
  const ownHostnames = [
    str(flags, "staff-hostname") ?? `${id}-admin.${ctx.fleet.domain}`,
    ...(str(flags, "web-hostname") ? [str(flags, "web-hostname") as string] : []),
  ];
  const problems = addSettingsProblems(settingsOf(flags), ctx.packs, {
    ownHostnames,
    fleetDomain: fleetDomainOf(ctx),
  });
  if (problems.length) throw new CliError(problems.join("; "));
  const admin = str(flags, "admin");
  if (admin === undefined) return null;
  if (!firstAdminEmail(admin)) throw new CliError("--admin: the first admin's email address");
  return {
    email: admin,
    source: setupTokenSource(
      str(flags, "admin-token-sha256"),
      Boolean(flags["print-link"]),
      deps.env,
      "--admin-token-sha256",
    ),
  };
}

/** After `cos client add`: with `--admin`, the first admin named. */
function afterAdd(ctx: FleetContext, id: string | undefined, plan: FirstAdminPlan | null) {
  return async (code: number): Promise<number> => {
    if (code === 0 && plan && ctx.dryRun) {
      ctx.io.out("  Would name its first admin.");
      return code;
    }
    if (code !== 0 || !plan) {
      if (code === 0 && !ctx.dryRun) {
        ctx.io.out(
          "  No first admin was named: nobody can make the client's first account until you run cos client first-admin <id> --email <address> --token-sha256 <sha256>.",
        );
      }
      return code;
    }
    return firstAdminCommand(ctx, id, plan.email, { source: plan.source });
  };
}

/** `cos client <command>`. */
export async function runClientCommand(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  while (rest[0] && !rest[0].startsWith("-")) positional.push(rest.shift() as string);
  let flags: Flags;
  try {
    // --setting may be given more than once.
    const settings: string[] = [];
    const others: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--setting") settings.push(rest[++i] ?? "");
      else if (rest[i]?.startsWith("--setting=")) settings.push((rest[i] as string).slice(10));
      else others.push(rest[i] as string);
    }
    ({ flags } = parseArgs(["client", ...others]));
    if (settings.length) flags.setting = settings;
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  if (flags.help) {
    deps.io.out(FLEET_USAGE);
    return 0;
  }
  try {
    // Offline, on the owner's machine (stage 66 step 9): no registry, no Cloudflare token.
    if (command === "first-admin-token") {
      return firstAdminTokenCommand(deps.io, deps.env, str(flags, "staff-hostname"));
    }
    const environment = environmentOf(flags);
    const s = await session(flags, deps);
    const { state } = await locateFleet(s, environment, deps);
    return await withContext(`client ${command}`, flags, deps, s, state, async (ctx) => {
      // `--label` and `--admin` (stage 66 step 9), and every setting checked, before anything.
      const firstAdmin = command === "add" ? prepareAdd(ctx, positional[0], flags, deps) : null;
      switch (command) {
        case "add":
          return addClient(ctx, {
            id: positional[0] as string,
            ...(str(flags, "tier") ? { tier: str(flags, "tier") as "standard" | "bespoke" } : {}),
            ...(str(flags, "repository") ? { repository: str(flags, "repository") as string } : {}),
            ...(str(flags, "location") ? { locationHint: str(flags, "location") as string } : {}),
            ...(str(flags, "staff-hostname")
              ? { staffHostname: str(flags, "staff-hostname") as string }
              : {}),
            ...(str(flags, "web-hostname")
              ? { webHostname: str(flags, "web-hostname") as string }
              : {}),
            ...(flags.desk ? { desk: true } : {}),
            ...(str(flags, "desk-hostname")
              ? { deskHostname: str(flags, "desk-hostname") as string }
              : {}),
            settings: settingsOf(flags),
          }).then(afterAdd(ctx, positional[0], firstAdmin));
        case "hostname": {
          const [verb, id, name] = positional;
          if (!verb || !id) {
            throw new CliError("cos client hostname add|verify|remove <id> <hostname> | list <id>");
          }
          return hostnameCommand(ctx, verb, id, name, { adopt: Boolean(flags.adopt) });
        }
        case "pause":
          return pauseClient(ctx, positional[0] as string);
        case "resume":
          return resumeClient(ctx, positional[0] as string);
        case "list":
          return listClientsCommand(ctx);
        case "secret": {
          const [verb, id, name] = positional;
          if (!id || !name || (verb !== "set" && verb !== "remove")) {
            throw new CliError("cos client secret set|remove <id> <NAME>");
          }
          return verb === "set"
            ? setSecret(ctx, id, name, ctx.dryRun ? "-" : await secretValue(flags, deps, name))
            : removeSecret(ctx, id, name);
        }
        case "export":
          return exportClient(ctx, {
            id: positional[0] as string,
            ...(str(flags, "out") ? { out: str(flags, "out") as string } : {}),
            leaving: Boolean(flags.leaving),
          });
        case "import": {
          const from = str(flags, "from");
          if (!from) throw new CliError("--from <dir>: the export to import");
          return importClient(ctx, {
            id: positional[0] as string,
            from,
            withoutSecrets: Boolean(flags["without-secrets"]),
            settings: settingsOf(flags),
            ...(str(flags, "staff-hostname")
              ? { staffHostname: str(flags, "staff-hostname") as string }
              : {}),
            ...(str(flags, "web-hostname")
              ? { webHostname: str(flags, "web-hostname") as string }
              : {}),
          });
        }
        case "remove":
          return removeClient(ctx, positional[0] as string);
        case "setting": {
          const [verb, id, name, value] = positional;
          return settingCommand(ctx, ctx.packs, verb, id, name, value, {
            showEmail: Boolean(flags["show-email"]),
          });
        }
        case "first-admin":
          return firstAdminCommand(ctx, positional[0], str(flags, "email") ?? positional[1], {
            source: setupTokenSource(
              str(flags, "token-sha256"),
              Boolean(flags["print-link"]),
              deps.env,
              "--token-sha256",
            ),
          });
        case "sender": {
          const [verb, id, domain] = positional;
          if (!verb || !id || !domain) {
            throw new CliError("cos client sender add|verify|unverify|remove <id> <domain>");
          }
          return senderCommand(ctx, verb, id, domain);
        }
        default:
          throw new CliError(FLEET_USAGE);
      }
    });
  } catch (error) {
    if (error instanceof FleetError || error instanceof CliError || error instanceof Error) {
      deps.io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** `cos fleet <command>`. */
export async function runFleetCommand(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  let flags: Flags;
  try {
    ({ flags } = parseArgs(["fleet", ...rest]));
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  if (flags.help || !command) {
    deps.io.out(FLEET_USAGE);
    return command ? 0 : 2;
  }
  try {
    if (command === "keys") return await fleetKeys(flags, deps);
    if (command === "install") return await fleetInstall(flags, deps);
    if (command === "upgrade") return await fleetUpgrade(flags, deps);
    deps.io.err(FLEET_USAGE);
    return 2;
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}
