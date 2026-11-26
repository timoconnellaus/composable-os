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
      // REGISTRY: a many-client host's registry (test/registry.test.ts and
      // test/client-environment.test.ts).
      d1Databases: ["DB", "REGISTRY"],
      // The shared bindings a many-client host keeps apart (test/client-bindings.test.ts).
      r2Buckets: ["BLOBS"],
      kvNamespaces: ["OAUTH_KV"],
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
