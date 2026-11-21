import type { Migration } from "@composable-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      UPDATER_FAKE_D1: D1Database;
      /** The company-web fixture Worker (stage 24). */
      COMPANY_WEB: Fetcher;
      /** cos-app's ClientApp entrypoint, as the company-web fixture holds it. */
      COMPANY_WEB_HOST: Fetcher;
    }
  }
}
