// SPIKE: the core suite with env.DB served by a Durable Object per client.
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    main: "./test/spike/worker.ts",
    miniflare: {
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["MEDIA_TEST"],
      durableObjects: { CLIENT_DB: { className: "ClientDb", useSQLite: true } },
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        PRINT_API_CONTRACT: "",
      },
    },
  }),
  setupFiles: ["./test/spike/swap.ts", "./test/apply-migrations.ts"],
});
