import type { Migration } from "@composable-os/db";

declare global {
  /**
   * Vite's glob import: the test that reads the source (visibility-one-seam), and every pack the
   * release carries (release-packs.ts).
   */
  interface ImportMeta {
    glob<T = unknown>(
      pattern: string,
      options: { query?: string; import?: string; eager: true },
    ): Record<string, T>;
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: Migration[];
    }
  }
}
