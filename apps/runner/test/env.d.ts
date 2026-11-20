import type { Migration } from "@composable-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      /** The fake Email Service behind the email-send gatekeeper (vitest.config.ts). */
      TEST_EMAIL_OUTBOX: Fetcher & {
        list(): Promise<{ from: string; to: string[]; subject: string; text?: string }[]>;
      };
    }
  }
  // Vite's glob import, as same-issues.test.ts uses it (source text of the fixture extensions).
  interface ImportMeta {
    glob<T>(
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, T>;
  }
}
