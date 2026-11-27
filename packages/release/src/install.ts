// A non-interactive install of a release bundle from a complete deployment state: the same steps
// `create-composable-os` runs (ADR 0165), for callers that have already made every choice. The
// hosted control plane provisions each customer this way (ADR 0210).
//
//   provision resources → AI Gateway → core migrations → record the state → deploy every Worker
//
// Each step finds what exists before creating anything, so a re-run after a failure converges.
import type { ReleaseBundle } from "./bundle.ts";
import type { CloudflareClient } from "./cloudflare.ts";
import {
  applyBundleMigrations,
  assertSameProduct,
  type DeploymentState,
  type DeployResult,
  d1ApiMigrations,
  databaseIdOf,
  deployWorkers,
  type Log,
  neededResources,
  provisionResources,
  writeDeploymentState,
} from "./deploy.ts";
import { type FleetDeployInput, provisionFleet } from "./fleet.ts";
import { mergeSecrets, provisionAiGateway, suppliedGatewayToken } from "./gateway.ts";

export interface InstallReleaseInput {
  api: CloudflareClient;
  bundle: ReleaseBundle;
  /** Every choice made; `resources` may be empty (they are found or created by name). */
  state: DeploymentState;
  /** Secret values to set, per manifest Worker name. */
  secrets: Record<string, Record<string, string>>;
  /** A fleet deployment's keys and signed props (stage 66 step 7), when `state.fleet` is set. */
  fleet?: FleetDeployInput;
  log?: Log;
}

export interface InstallReleaseResult {
  state: DeploymentState;
  databaseId: string;
  migrations: string[];
  deploy: DeployResult;
  warnings: string[];
}

export async function installRelease(input: InstallReleaseInput): Promise<InstallReleaseResult> {
  const { api, bundle } = input;
  const log = input.log ?? (() => {});
  const manifest = bundle.manifest;
  assertSameProduct(input.state, manifest.product);
  const resources = {
    ...input.state.resources,
    ...(await provisionResources(
      api,
      input.state.accountId,
      neededResources(manifest, input.state.gatekeepers, input.state),
      log,
      input.state.resourceNames,
      { locationHint: input.state.locationHint },
    )),
    // A fleet's own: the registry, the exports bucket, its queues (stage 66 step 7).
    ...(input.state.fleet ? await provisionFleet(api, manifest, input.state, log) : {}),
  };
  const base: DeploymentState = { ...input.state, product: manifest.product, resources };
  const gateway = await provisionAiGateway({
    api,
    manifest,
    state: base,
    ...suppliedGatewayToken(input.secrets),
    log,
  });
  const state: DeploymentState = { ...base, vars: gateway.vars, ...gateway.state };
  const databaseId = databaseIdOf(manifest, resources);
  const migrations = await applyBundleMigrations(
    bundle,
    d1ApiMigrations(api, state.accountId, databaseId),
    log,
  );
  await writeDeploymentState(api, databaseId, state);
  const deploy = await deployWorkers({
    api,
    bundle,
    state,
    secrets: mergeSecrets(input.secrets, gateway.secrets),
    ...(input.fleet ? { fleet: input.fleet } : {}),
    log,
  });
  return { state, databaseId, migrations, deploy, warnings: gateway.warnings };
}
