import type { Migration } from "@composable-os/db";

declare global {
  /** Vite's glob import, used by the test that reads the source (visibility-one-seam). */
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, unknown>;
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: Migration[];
    }
  }
}
