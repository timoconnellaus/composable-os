import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientDbSetupFiles, withClientDb } from "@composable-os/db/testing/vitest";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    // COS_TEST_DB=client-db: env.DB is a client's database (stage 66, ADR 0612).
    miniflare: await withClientDb({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
    }),
  }),
  setupFiles: clientDbSetupFiles(["./test/apply-migrations.ts"]),
});
