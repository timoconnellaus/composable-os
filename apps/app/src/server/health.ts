// GET /api/health: version, commit, D1 migration level, a cos-runner ping, and the rate limits.
import { identityProviderKind } from "@composable-os/auth";
import { PUBLIC_LIMIT_BINDING_NAMES, PUBLIC_LIMIT_DOWN_NOTICE } from "@composable-os/core";
import { getMigrationLevel, type MigrationLevel } from "@composable-os/db";
import { readRegistryStamp } from "@composable-os/db/registry";
import { runner } from "./runner.ts";

export interface HealthEnv {
  DB: D1Database;
  /** The installed release (stage 8); empty for a source deploy. */
  COS_RELEASE_VERSION?: string;
  IDENTITY_PROVIDER?: string;
  RUNNER: Fetcher;
}

/**
 * The limits on calls from outside (ADR 0940): bindings missing from this deployment (calls then go
 * through unlimited), and the last day a count could not be made or a client app named no visitor.
 */
export interface PublicLimitsHealth {
  ok: boolean;
  missing: string[];
  lastDown: string | null;
  lastNoVisitor: string | null;
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  commit: string;
  identityProvider: string;
  database: ({ ok: boolean } & MigrationLevel) | { ok: false; error: string };
  runner: { ok: true; worker: string; latencyMs: number } | { ok: false; error: string };
  publicLimits: PublicLimitsHealth;
}

const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
const COMMIT = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "unknown";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The dedupe key of the admins' notice that a client app names no visitor (bound.ts). */
const NO_VISITOR_NOTICE = "public_limit.no_visitor:";

async function lastNotice(db: D1Database, prefix: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(
        "SELECT max(dedupe_key) AS k FROM core_notifications WHERE dedupe_key >= ? AND dedupe_key < ?",
      )
      .bind(prefix, `${prefix}~`)
      .first<{ k: string | null }>();
    return row?.k ? row.k.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

async function publicLimitsHealth(env: HealthEnv): Promise<PublicLimitsHealth> {
  const bound = env as unknown as Record<string, unknown>;
  const missing = PUBLIC_LIMIT_BINDING_NAMES.filter((name) => !bound[name]);
  const [lastDown, lastNoVisitor] = await Promise.all([
    lastNotice(env.DB, PUBLIC_LIMIT_DOWN_NOTICE),
    lastNotice(env.DB, NO_VISITOR_NOTICE),
  ]);
  return { ok: missing.length === 0, missing, lastDown, lastNoVisitor };
}

export async function getHealth(env: HealthEnv): Promise<Health> {
  const [database, runnerHealth, publicLimits] = await Promise.all([
    getMigrationLevel(env.DB).then(
      (level) => ({ ok: level.upToDate, ...level }),
      (error: unknown) => ({ ok: false as const, error: message(error) }),
    ),
    (async () => {
      const started = Date.now();
      try {
        const pong = await runner(env).ping();
        return { ok: true as const, worker: pong.worker, latencyMs: Date.now() - started };
      } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    })(),
    publicLimitsHealth(env),
  ]);

  let identityProvider: string;
  try {
    identityProvider = identityProviderKind(env);
  } catch (error) {
    identityProvider = `invalid: ${message(error)}`;
  }

  return {
    status: database.ok && runnerHealth.ok ? "ok" : "degraded",
    // The release version when installed from a release, so smoke checks can see the switch.
    version: env.COS_RELEASE_VERSION || VERSION,
    commit: COMMIT,
    identityProvider,
    database,
    runner: runnerHealth,
    publicLimits,
  };
}

/** Where a host of many clients answers for itself (stage 66 step 7): on its callback hostname. */
export const HOST_HEALTH_PATH = "/api/health";

/**
 * A host of many clients' own health, on its callback hostname, before any client is decided
 * (stage 66 step 7, ADR 0618): the version these Workers run and whether the registry answers.
 * What `cos fleet upgrade` smoke-checks, so the check reaches the new Workers while every client
 * is paused ("being updated"). It reads one registry row (the stamp) and nothing of a client's.
 */
export async function hostHealthResponse(env: {
  REGISTRY?: D1Database;
  COS_RELEASE_VERSION?: string;
}): Promise<Response> {
  let registry: { ok: true } | { ok: false; error: string };
  try {
    if (!env.REGISTRY) throw new Error("no registry bound");
    await readRegistryStamp(env.REGISTRY);
    registry = { ok: true };
  } catch (error) {
    registry = { ok: false, error: message(error) };
  }
  const status = registry.ok ? "ok" : "degraded";
  return Response.json(
    { status, version: env.COS_RELEASE_VERSION || VERSION, commit: COMMIT, host: true, registry },
    { status: registry.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

export async function healthResponse(env: HealthEnv): Promise<Response> {
  const health = await getHealth(env);
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
