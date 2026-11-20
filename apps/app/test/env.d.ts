import type { Migration } from "@composable-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      UPDATER_FAKE_D1: D1Database;
    }
  }
}
