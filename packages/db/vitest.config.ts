import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { addClientDb } from "./testing/vitest.ts";
import { workerEnvNames } from "./testing/worker-env-names.ts";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
// The registry's own migrations (stage 66 step 3), beside the host's.
const registryMigrationsDir = fileURLToPath(new URL("./registry-migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    // A client's database beside D1 (stage 66): test/client-db.test.ts runs both.
    miniflare: await addClientDb({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      // DB2: a second D1 database, the target of an import (test/sql-export.test.ts). REGISTRY: a
      // many-client host's registry (test/registry.test.ts and test/client-environment.test.ts).
      d1Databases: ["DB", "DB2", "REGISTRY"],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        REGISTRY_MIGRATIONS: await readD1Migrations(registryMigrationsDir),
        // Every name the app and the runner declare or read (test/client-env-names.test.ts).
        WORKER_ENV_NAMES: workerEnvNames(),
        PRINT_CONFORMANCE: process.env.PRINT_CONFORMANCE ?? "",
      },
    }),
  }),
});
