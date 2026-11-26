import type { Migration } from "../src/migrate.ts";

declare global {
  /** Vite's glob import: the test that reads the Workers' source (secrets-unreachable). */
  interface ImportMeta {
    glob<T = unknown>(
      pattern: string,
      options: { query?: string; import?: string; eager: true },
    ): Record<string, T>;
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      REGISTRY: D1Database;
      BLOBS: R2Bucket;
      OAUTH_KV: KVNamespace;
      TEST_MIGRATIONS: Migration[];
      REGISTRY_MIGRATIONS: Migration[];
      WORKER_ENV_NAMES: string[];
    }
  }
}
