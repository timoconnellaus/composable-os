import type { Migration } from "@composable-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      /** The fake Email Service behind the email-send gatekeeper (vitest.config.ts). */
      TEST_EMAIL_OUTBOX: Fetcher & {
        list(): Promise<{ from: string; to: string[]; subject: string; text?: string }[]>;
      };
      /** The fake accounting books' controls (packages/gatekeeper-accounting, vitest.config.ts). */
      TEST_ACCOUNTING_BOOKS: Fetcher & {
        reset(
          books: string,
          overrides?: { baseCurrency?: string; lockDate?: string | null },
        ): Promise<void>;
        writesOf(books: string, reference: string): Promise<number>;
        state(books: string): Promise<{ records: { reference: string | null; kind: string }[] }>;
      };
      /** The fake text provider's phones (packages/gatekeeper-text, vitest.config.ts). */
      TEST_TEXT_PHONES: Fetcher & {
        sent(): Promise<{ providerRef: string; from: string; to: string; text: string }[]>;
        codeFor(to: string): Promise<string | null>;
        refuse(to: string, refuse: boolean): Promise<void>;
      };
      /** The text gatekeeper's vendor; its fetch serves the provider's webhook. */
      GATEKEEPER_TEXT: Fetcher;
      /** The fake booking system's controls (packages/gatekeeper-booking-system, vitest.config.ts). */
      TEST_BOOKING_SYSTEM: Fetcher & {
        reset(site: string, options?: { now?: string }): Promise<void>;
        callCount(site: string): Promise<{ used: number; byMethod: Record<string, number> }>;
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
