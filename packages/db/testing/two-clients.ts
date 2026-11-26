// The two-client suites' deployment (stage 66 step 4, ADR 0615): one host, a registry and every
// client's database, as a many-client host has them. apps/app and apps/runner run their
// `test-two-clients/` suites on it (vitest.two-client.config.ts). The registry rows stand in for
// the operator's `cos client add` (step 7).
import type { ClientDb } from "../src/client-db.ts";
import { applyMigrations, CORE_SCHEMA_VERSION, type Migration } from "../src/migrate.ts";
import { REGISTRY_MIGRATIONS_TABLE } from "../src/registry.ts";

/** The clients of the suites' host, with each one's staff hostname. */
export const TWO_CLIENTS = {
  /** Served. */
  a: { id: "gym-a", hostname: "gym-a.test", generation: "a1".repeat(16) },
  b: { id: "gym-b", hostname: "gym-b.test", generation: "b2".repeat(16) },
  /** Known, not served: paused, moving, and one whose schema the operator never recorded. */
  paused: { id: "gym-paused", hostname: "gym-paused.test", generation: "c3".repeat(16) },
  moving: { id: "gym-moving", hostname: "gym-moving.test", generation: "d4".repeat(16) },
  behind: { id: "gym-behind", hostname: "gym-behind.test", generation: "e5".repeat(16) },
} as const;

/**
 * The trigger of registry migration 0793 that keeps a client's secret generation the registry's
 * own. The suites' clients are added with known generations (so their web apps' props, set in the
 * vitest config, can carry the host's proof of them): the stand-in drops the trigger for its
 * inserts and puts it back as the migration made it. No deployment's registry is written so.
 */
const GENERATION_TRIGGER = `CREATE TRIGGER registry_clients_secret_generation_ours
BEFORE INSERT ON registry_clients
WHEN NEW.secret_generation IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a client''s secret generation is written by the registry, never supplied');
END`;

/** Hostnames that reach no client: an unverified one and gym-a's web and desk hostnames. */
export const NOT_STAFF_HOSTNAMES = {
  unverified: "pending.gym-b.test",
  web: "shop.gym-a.test",
  desk: "desk.gym-a.test",
} as const;

interface TwoClientBindings {
  REGISTRY: D1Database;
  /** The operator's raw namespace (testing/vitest.ts, `addClientDbService`): step 7's stand-in. */
  OPERATOR_CLIENT_DB: DurableObjectNamespace<ClientDb>;
  TEST_MIGRATIONS: Migration[];
  REGISTRY_MIGRATIONS: Migration[];
}

let ready: Promise<void> | undefined;

/** The registry and the clients' databases, made once per test file's isolate. */
export function setUpTwoClients(env: object): Promise<void> {
  ready ??= setUp(env as TwoClientBindings);
  return ready;
}

async function setUp(env: TwoClientBindings): Promise<void> {
  const { REGISTRY: registry } = env;
  await applyMigrations(registry, env.REGISTRY_MIGRATIONS, { table: REGISTRY_MIGRATIONS_TABLE });
  await registry.prepare("DELETE FROM registry_clients").run();
  await registry.prepare("DELETE FROM registry_removed_clients").run();
  const client = (c: { id: string; generation: string }, status: string, schema: number | null) =>
    registry
      .prepare(
        "INSERT INTO registry_clients (id, environment, status, tier, repository, location_hint, schema_version, secret_generation) VALUES (?, 'live', ?, 'standard', NULL, NULL, ?, ?)",
      )
      .bind(c.id, status, schema, c.generation);
  const hostname = (name: string, id: string, surface: string, verified = 1) =>
    registry
      .prepare(
        "INSERT INTO registry_hostnames (hostname, client, surface, verified) VALUES (?, ?, ?, ?)",
      )
      .bind(name, id, surface, verified);
  const { a, b, paused, moving, behind } = TWO_CLIENTS;
  await registry.batch([
    registry.prepare("DROP TRIGGER registry_clients_secret_generation_ours"),
    client(a, "active", CORE_SCHEMA_VERSION),
    client(b, "active", CORE_SCHEMA_VERSION),
    client(paused, "paused", CORE_SCHEMA_VERSION),
    client(moving, "moving", CORE_SCHEMA_VERSION),
    client(behind, "active", null),
    registry.prepare(GENERATION_TRIGGER),
    ...[a, b, paused, moving, behind].map((c) => hostname(c.hostname, c.id, "staff")),
    hostname(NOT_STAFF_HOSTNAMES.unverified, b.id, "staff", 0),
    hostname(NOT_STAFF_HOSTNAMES.web, a.id, "web"),
    hostname(NOT_STAFF_HOSTNAMES.desk, a.id, "desk"),
    // Staff may sign up at each served client, so the suites can sign one in by password.
    ...[a.id, b.id].map((id) =>
      registry
        .prepare(
          "INSERT INTO registry_settings (client, name, value) VALUES (?, 'AUTH_ALLOW_SIGNUP', 'true')",
        )
        .bind(id),
    ),
  ]);
  for (const id of [a.id, b.id, paused.id, moving.id]) {
    // As the operator's `cos client add` will (step 7): the raw namespace, which the host's
    // Workers never bind.
    const operator = env.OPERATOR_CLIENT_DB;
    await operator.get(operator.idFromName(id)).migrate(env.TEST_MIGRATIONS);
  }
}
