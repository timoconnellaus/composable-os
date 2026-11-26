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
  a: { id: "gym-a", hostname: "gym-a.test" },
  b: { id: "gym-b", hostname: "gym-b.test" },
  /** Known, not served: paused, moving, and one whose schema the operator never recorded. */
  paused: { id: "gym-paused", hostname: "gym-paused.test" },
  moving: { id: "gym-moving", hostname: "gym-moving.test" },
  behind: { id: "gym-behind", hostname: "gym-behind.test" },
} as const;

/** Hostnames that reach no client: an unverified one and gym-a's web and desk hostnames. */
export const NOT_STAFF_HOSTNAMES = {
  unverified: "pending.gym-b.test",
  web: "shop.gym-a.test",
  desk: "desk.gym-a.test",
} as const;

interface TwoClientBindings {
  REGISTRY: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
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
  const client = (id: string, status: string, schema: number | null) =>
    registry
      .prepare(
        "INSERT INTO registry_clients (id, environment, status, tier, repository, location_hint, schema_version) VALUES (?, 'live', ?, 'standard', NULL, NULL, ?)",
      )
      .bind(id, status, schema);
  const hostname = (name: string, id: string, surface: string, verified = 1) =>
    registry
      .prepare(
        "INSERT INTO registry_hostnames (hostname, client, surface, verified) VALUES (?, ?, ?, ?)",
      )
      .bind(name, id, surface, verified);
  const { a, b, paused, moving, behind } = TWO_CLIENTS;
  await registry.batch([
    client(a.id, "active", CORE_SCHEMA_VERSION),
    client(b.id, "active", CORE_SCHEMA_VERSION),
    client(paused.id, "paused", CORE_SCHEMA_VERSION),
    client(moving.id, "moving", CORE_SCHEMA_VERSION),
    client(behind.id, "active", null),
    ...[a, b, paused, moving, behind].map((c) => hostname(c.hostname, c.id, "staff")),
    hostname(NOT_STAFF_HOSTNAMES.unverified, b.id, "staff", 0),
    hostname(NOT_STAFF_HOSTNAMES.web, a.id, "web"),
    hostname(NOT_STAFF_HOSTNAMES.desk, a.id, "desk"),
  ]);
  for (const id of [a.id, b.id, paused.id, moving.id]) {
    await env.CLIENT_DB.get(env.CLIENT_DB.idFromName(id)).migrate(env.TEST_MIGRATIONS);
  }
}
