// The operator's writes to a registry, as the tests make them. In a deployment only `cos` writes
// the registry (stage 66 step 7); these stand in for it.
import { env } from "cloudflare:workers";
import { applyMigrations } from "../src/migrate.ts";
import { REGISTRY_MIGRATIONS_TABLE } from "../src/registry.ts";

export async function migrateRegistry(registry: D1Database = env.REGISTRY): Promise<string[]> {
  return applyMigrations(registry, env.REGISTRY_MIGRATIONS, { table: REGISTRY_MIGRATIONS_TABLE });
}

/** Every client gone (their hostnames, settings and secrets with them). */
export async function emptyRegistry(registry: D1Database = env.REGISTRY): Promise<void> {
  await registry.prepare("DELETE FROM registry_clients").run();
}

export interface ClientFixture {
  id: string;
  environment?: "live" | "staging";
  status?: "active" | "paused" | "moving";
  tier?: "standard" | "bespoke";
  repository?: string | null;
  locationHint?: string | null;
  schemaVersion?: number | null;
}

export function insertClient(registry: D1Database, client: ClientFixture): D1PreparedStatement {
  return registry
    .prepare(
      "INSERT INTO registry_clients (id, environment, status, tier, repository, location_hint, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      client.id,
      client.environment ?? "live",
      client.status ?? "active",
      client.tier ?? "standard",
      client.repository ?? null,
      client.locationHint ?? null,
      client.schemaVersion === undefined ? 1 : client.schemaVersion,
    );
}

export function insertHostname(
  registry: D1Database,
  hostname: string,
  client: string,
  surface: "staff" | "web" | "desk" = "staff",
  verified = true,
): D1PreparedStatement {
  return registry
    .prepare(
      "INSERT INTO registry_hostnames (hostname, client, surface, verified) VALUES (?, ?, ?, ?)",
    )
    .bind(hostname, client, surface, verified ? 1 : 0);
}

export function insertSetting(
  registry: D1Database,
  client: string,
  name: string,
  value: string,
): D1PreparedStatement {
  return registry
    .prepare("INSERT INTO registry_settings (client, name, value) VALUES (?, ?, ?)")
    .bind(client, name, value);
}

/** A D1 database that counts the statements sent to it and the most parameters one bound. */
export function metered(db: D1Database): {
  db: D1Database;
  statements: () => number;
  mostBound: () => number;
} {
  let statements = 0;
  let mostBound = 0;
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => {
            mostBound = Math.max(mostBound, values.length);
            return wrapStatement(target.bind(...values));
          };
        }
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return (...args: unknown[]) => {
            statements += 1;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    unwrap.set(wrapped, statement);
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql));
      }
      if (key === "batch") {
        return (list: D1PreparedStatement[]) => {
          statements += list.length;
          return target.batch(list.map((s) => unwrap.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, statements: () => statements, mostBound: () => mostBound };
}
