import type { Migration } from "../src/migrate.ts";

declare global {
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
