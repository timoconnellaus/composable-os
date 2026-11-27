// The operator's writes to the registry (stage 66 step 7, ADR 0618): what `cos client add`, the
// update, `export`, `import`, `remove`, `pause` and `resume` change, over any `D1Database` (the
// registry's binding in a test, or D1's REST API from `cos`, packages/release `d1OverRest`).
//
// Exported as `@composable-os/db/registry-writes`, never from `@composable-os/db`: packages/core
// and the packs cannot name `@composable-os/db/registry*` (registry-unreachable), and no Worker of
// the host imports it (secrets-unreachable reads their sources for `registry-writes`). Each change
// that is more than one row is one batch, so it is all or nothing. Inputs are checked here before
// anything is written, with the same rules the registry's CHECKs and the reader hold.
import { callbackHostname } from "./callbacks.ts";
import {
  CLIENT_ENVIRONMENTS,
  type ClientEnvironmentName,
  type ClientId,
  type ClientRecord,
  type ClientStatus,
  type ClientTier,
  canonicalHostname,
  clientIdProblem,
  type HostnameSurface,
  isClientSetting,
  validateClientId,
} from "./registry.ts";

/** Where a client's database is created the first time it is reached (a Durable Object hint). */
export const CLIENT_LOCATION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
] as const;

/** A client to add: its row, its hostnames (verified, each its surface's address) and settings. */
export interface NewClient {
  id: string;
  environment: ClientEnvironmentName;
  tier: ClientTier;
  repository?: string | null;
  locationHint?: string | null;
  /** Added as an imported single-client deployment (migration 0793): set now, never after. */
  imported?: boolean;
  hostnames: { hostname: string; surface: HostnameSurface }[];
  /** Deploy-time settings by env name (`CLIENT_SETTINGS`). */
  settings?: Record<string, string>;
}

/**
 * What is wrong with `client` as a new client of a deployment, one line each; none when it can be
 * added. The deployment's callback hostname (`COS_CALLBACK_HOSTNAME`) is no client's.
 */
export function newClientProblems(
  client: NewClient,
  deployment: { callbackHostname?: string | null } = {},
): string[] {
  const problems: string[] = [];
  const idProblem = clientIdProblem(client.id);
  if (idProblem) problems.push(`the id: ${idProblem}`);
  if (!CLIENT_ENVIRONMENTS.includes(client.environment)) {
    problems.push("the environment is live or staging");
  }
  if (client.tier !== "standard" && client.tier !== "bespoke") {
    problems.push("the tier is standard or bespoke");
  }
  if (client.repository != null && !/^[\w.-]+\/[\w.-]+$/.test(client.repository)) {
    problems.push("the repository is owner/name");
  }
  if (
    client.locationHint != null &&
    !(CLIENT_LOCATION_HINTS as readonly string[]).includes(client.locationHint)
  ) {
    problems.push(`the location hint is one of ${CLIENT_LOCATION_HINTS.join(", ")}`);
  }
  const callback = deployment.callbackHostname
    ? callbackHostname({ COS_CALLBACK_HOSTNAME: deployment.callbackHostname })
    : null;
  const seen = new Set<string>();
  const surfaces = new Set<string>();
  for (const { hostname, surface } of client.hostnames) {
    const canonical = canonicalHostname(hostname);
    if (canonical !== hostname) problems.push(`${hostname} is not a canonical hostname`);
    if (surface !== "staff" && surface !== "web" && surface !== "desk") {
      problems.push(`${hostname}: the surface is staff, web or desk`);
    }
    if (callback && hostname === callback) {
      problems.push(`${hostname} is the deployment's callback hostname, no client's`);
    }
    if (seen.has(hostname)) problems.push(`${hostname} is named twice`);
    if (surfaces.has(surface)) problems.push(`two ${surface} hostnames: name one`);
    seen.add(hostname);
    surfaces.add(surface);
  }
  if (!surfaces.has("staff")) problems.push("a client needs a staff hostname");
  for (const name of Object.keys(client.settings ?? {})) {
    if (!isClientSetting(name)) problems.push(`${name} is not a client setting`);
  }
  return problems;
}

/** A client's row as the operator reads it: the reader's record and its status. */
export async function readClient(
  registry: D1Database,
  id: ClientId,
): Promise<(ClientRecord & { status: ClientStatus }) | null> {
  const row = await registry
    .prepare(
      "SELECT id, environment, status, tier, repository, location_hint, schema_version, secret_generation, imported FROM registry_clients WHERE id = ?",
    )
    .bind(validateClientId(id))
    .first<{
      id: string;
      environment: ClientEnvironmentName;
      status: ClientStatus;
      tier: ClientTier;
      repository: string | null;
      location_hint: DurableObjectLocationHint | null;
      schema_version: number | null;
      secret_generation: string | null;
      imported: number;
    }>();
  if (!row) return null;
  return {
    id: row.id as ClientId,
    environment: row.environment,
    status: row.status,
    tier: row.tier,
    repository: row.repository,
    locationHint: row.location_hint,
    schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
    secretGeneration: row.secret_generation,
    imported: Number(row.imported) === 1,
  };
}

/** Every client of the registry, with its status, in id order. */
export async function listClients(
  registry: D1Database,
): Promise<(ClientRecord & { status: ClientStatus })[]> {
  const { results } = await registry
    .prepare("SELECT id FROM registry_clients ORDER BY id")
    .all<{ id: string }>();
  const out: (ClientRecord & { status: ClientStatus })[] = [];
  for (const { id } of results) {
    if (clientIdProblem(id)) continue;
    const client = await readClient(registry, id as ClientId);
    if (client) out.push(client);
  }
  return out;
}

/** Whether `id` was a client once and was removed: never used again (migration 0794). */
export async function wasRemoved(registry: D1Database, id: string): Promise<boolean> {
  const row = await registry
    .prepare("SELECT 1 AS one FROM registry_removed_clients WHERE id = ?")
    .bind(id)
    .first();
  return row !== null;
}

/** Hostnames of `hostnames` the registry already holds, with the client that holds each. */
export async function hostnamesTaken(
  registry: D1Database,
  hostnames: string[],
): Promise<{ hostname: string; client: string }[]> {
  const out: { hostname: string; client: string }[] = [];
  for (const hostname of hostnames) {
    const row = await registry
      .prepare("SELECT client FROM registry_hostnames WHERE hostname = ?")
      .bind(hostname)
      .first<{ client: string }>();
    if (row) out.push({ hostname, client: row.client });
  }
  return out;
}

/**
 * Adds a client's rows in one batch: its row **paused** with no schema version (so the host
 * serves nothing of it until its database is made and migrated, and `activateClient` turns it
 * on), its hostnames verified and each its surface's address, and its settings. The registry
 * writes its secret generation itself and refuses a removed id (migrations 0792 to 0794).
 */
export async function addClientRows(registry: D1Database, client: NewClient): Promise<void> {
  const problems = newClientProblems(client);
  if (problems.length) throw new RangeError(`Not a client to add: ${problems.join("; ")}`);
  const id = validateClientId(client.id);
  await registry.batch([
    registry
      .prepare(
        "INSERT INTO registry_clients (id, environment, status, tier, repository, location_hint, imported) VALUES (?, ?, 'paused', ?, ?, ?, ?)",
      )
      .bind(
        id,
        client.environment,
        client.tier,
        client.repository ?? null,
        client.locationHint ?? null,
        client.imported ? 1 : 0,
      ),
    ...client.hostnames.map(({ hostname, surface }) =>
      registry
        .prepare(
          "INSERT INTO registry_hostnames (hostname, client, surface, verified, is_primary) VALUES (?, ?, ?, 1, 1)",
        )
        .bind(hostname, id, surface),
    ),
    ...Object.entries(client.settings ?? {}).map(([name, value]) =>
      registry
        .prepare("INSERT INTO registry_settings (client, name, value) VALUES (?, ?, ?)")
        .bind(id, name, value),
    ),
  ]);
}

/**
 * Records the schema version the operator's command saw on a client's database (ADR 0613): what
 * the host compares with its code (`isSchemaBehind`).
 */
export async function recordSchemaVersion(
  registry: D1Database,
  id: ClientId,
  version: number | null,
): Promise<void> {
  if (version !== null && (!Number.isInteger(version) || version < 0)) {
    throw new RangeError("A schema version is a whole number");
  }
  await registry
    .prepare(
      "UPDATE registry_clients SET schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(version, validateClientId(id))
    .run();
}

/**
 * Sets a client's status, only from one of `from` (every status when left out). Returns whether
 * it changed: false when the client is not in one of `from`, or not there at all.
 */
export async function setClientStatus(
  registry: D1Database,
  id: ClientId,
  status: ClientStatus,
  from?: readonly ClientStatus[],
): Promise<boolean> {
  const client = validateClientId(id);
  const allowed: readonly ClientStatus[] = from ?? ["active", "paused", "moving"];
  const row = await registry
    .prepare("SELECT status FROM registry_clients WHERE id = ?")
    .bind(client)
    .first<{ status: ClientStatus }>();
  if (!row || row.status === status || !allowed.includes(row.status)) return false;
  // Only from the status just read: a change made meanwhile is not overwritten.
  await registry
    .prepare(
      "UPDATE registry_clients SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?",
    )
    .bind(status, client, row.status)
    .run();
  const after = await registry
    .prepare("SELECT status FROM registry_clients WHERE id = ?")
    .bind(client)
    .first<{ status: ClientStatus }>();
  return after?.status === status;
}

/** Sets one deploy-time setting of a client (`CLIENT_SETTINGS`), or removes it with null. */
export async function setClientSetting(
  registry: D1Database,
  id: ClientId,
  name: string,
  value: string | null,
): Promise<void> {
  if (!isClientSetting(name)) throw new RangeError(`${name} is not a client setting`);
  const client = validateClientId(id);
  if (value === null) {
    await registry
      .prepare("DELETE FROM registry_settings WHERE client = ? AND name = ?")
      .bind(client, name)
      .run();
    return;
  }
  await registry
    .prepare(
      "INSERT INTO registry_settings (client, name, value) VALUES (?, ?, ?) ON CONFLICT (client, name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(client, name, value)
    .run();
}

/**
 * Removes a client's rows in one batch: its secrets, settings and hostnames, then its row, whose
 * DELETE trigger keeps its id in `registry_removed_clients` for good (migration 0794). The host
 * stops serving it within `REGISTRY_REFRESH_MS`.
 */
export async function removeClientRows(registry: D1Database, id: ClientId): Promise<void> {
  const client = validateClientId(id);
  await registry.batch(
    [
      "DELETE FROM registry_secrets WHERE client = ?",
      "DELETE FROM registry_settings WHERE client = ?",
      "DELETE FROM registry_hostnames WHERE client = ?",
      "DELETE FROM registry_clients WHERE id = ?",
    ].map((sql) => registry.prepare(sql).bind(client)),
  );
}

// --- Operations: a command's progress, so a re-run carries on (migration 0795) -------------------

export type OperationKind = "add" | "update" | "export" | "import" | "remove";
export type OperationOutcome = "succeeded" | "undone" | "failed";

export interface Operation<S> {
  id: string;
  kind: OperationKind;
  client: string | null;
  state: S;
  startedAt: string;
}

function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `op-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The unfinished run of `kind` for `client` (null: an update), or null when there is none. */
export async function unfinishedOperation<S>(
  registry: D1Database,
  kind: OperationKind,
  client: string | null,
): Promise<Operation<S> | null> {
  const row = await registry
    .prepare(
      "SELECT id, kind, client, state, started_at FROM registry_operations WHERE kind = ? AND coalesce(client, '') = ? AND finished_at IS NULL",
    )
    .bind(kind, client ?? "")
    .first<{
      id: string;
      kind: OperationKind;
      client: string | null;
      state: string;
      started_at: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    client: row.client,
    state: JSON.parse(row.state) as S,
    startedAt: row.started_at,
  };
}

/** Every unfinished run, of any kind: what `cos client list` shows. */
export async function unfinishedOperations(
  registry: D1Database,
): Promise<{ id: string; kind: OperationKind; client: string | null; startedAt: string }[]> {
  const { results } = await registry
    .prepare(
      "SELECT id, kind, client, started_at FROM registry_operations WHERE finished_at IS NULL ORDER BY started_at",
    )
    .all<{ id: string; kind: OperationKind; client: string | null; started_at: string }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    client: r.client,
    startedAt: r.started_at,
  }));
}

/** Starts a run; refused (the unique index) while another run of the kind for it is unfinished. */
export async function beginOperation<S>(
  registry: D1Database,
  kind: OperationKind,
  client: string | null,
  state: S,
): Promise<Operation<S>> {
  const id = operationId();
  await registry
    .prepare("INSERT INTO registry_operations (id, kind, client, state) VALUES (?, ?, ?, ?)")
    .bind(id, kind, client, JSON.stringify(state))
    .run();
  return { id, kind, client, state, startedAt: new Date().toISOString() };
}

/** Records where a run has got to. */
export async function saveOperation<S>(registry: D1Database, id: string, state: S): Promise<void> {
  await registry
    .prepare(
      "UPDATE registry_operations SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND finished_at IS NULL",
    )
    .bind(JSON.stringify(state), id)
    .run();
}

/** Ends a run, with its outcome and its last state. */
export async function finishOperation<S>(
  registry: D1Database,
  id: string,
  outcome: OperationOutcome,
  state: S,
): Promise<void> {
  await registry
    .prepare(
      "UPDATE registry_operations SET state = ?, outcome = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND finished_at IS NULL",
    )
    .bind(JSON.stringify(state), outcome, id)
    .run();
}

// --- The operator's Worker, one command at a time (migration 0795; review of #526, S1) -----------

/** Who holds the operator's Worker now, when another command does. */
export interface OperatorSessionHeld {
  command: string;
  until: number;
}

/**
 * Takes the operator's Worker for one command's run (`holder`), until `now + ttlMs`: refused while
 * another run holds it and its time has not run out, unless `takeOver` (the operator's deliberate
 * choice, when a command was killed). The run that holds it renews it with the same call.
 */
export async function takeOperatorSession(
  registry: D1Database,
  holder: string,
  command: string,
  ttlMs: number,
  options: { now?: number; takeOver?: boolean } = {},
): Promise<{ taken: true } | { taken: false; held: OperatorSessionHeld }> {
  const now = options.now ?? Date.now();
  await registry
    .prepare(
      `INSERT INTO registry_operator_session (id, holder, command, until) VALUES ('operator', ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, command = excluded.command, until = excluded.until
       WHERE registry_operator_session.holder = excluded.holder OR registry_operator_session.until < ? OR ? = 1`,
    )
    .bind(holder, command, now + ttlMs, now, options.takeOver ? 1 : 0)
    .run();
  const row = await registry
    .prepare("SELECT holder, command, until FROM registry_operator_session WHERE id = 'operator'")
    .first<{ holder: string; command: string; until: number }>();
  if (row?.holder === holder) return { taken: true };
  return {
    taken: false,
    held: { command: row?.command ?? "another command", until: Number(row?.until ?? 0) },
  };
}

/** Whether `holder` holds the operator's Worker now. */
export async function holdsOperatorSession(registry: D1Database, holder: string): Promise<boolean> {
  const row = await registry
    .prepare("SELECT holder FROM registry_operator_session WHERE id = 'operator'")
    .first<{ holder: string }>();
  return row?.holder === holder;
}

/** Gives the operator's Worker back, if `holder` still holds it. */
export async function releaseOperatorSession(registry: D1Database, holder: string): Promise<void> {
  await registry
    .prepare("DELETE FROM registry_operator_session WHERE id = 'operator' AND holder = ?")
    .bind(holder)
    .run();
}

// --- A client's settings, read back (stage 66 step 9, `cos client setting list`) -----------------

/** A client's own settings rows, by name (none: every setting inherited or empty). */
export async function readClientSettings(
  registry: D1Database,
  id: ClientId,
): Promise<Record<string, string>> {
  const { results } = await registry
    .prepare("SELECT name, value FROM registry_settings WHERE client = ? ORDER BY name")
    .bind(validateClientId(id))
    .all<{ name: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.name, r.value]));
}

/** A client's staff hostname: its marked verified one, else any verified one, else null. */
export async function staffHostnameOf(registry: D1Database, id: ClientId): Promise<string | null> {
  const row = await registry
    .prepare(
      "SELECT hostname FROM registry_hostnames WHERE client = ? AND surface = 'staff' AND verified = 1 ORDER BY is_primary DESC, hostname LIMIT 1",
    )
    .bind(validateClientId(id))
    .first<{ hostname: string }>();
  return row?.hostname ?? null;
}
