// The runner as a many-client host's (stage 66 step 4, ADR 0615): the committed wrangler.jsonc,
// plus what the deploy engine adds for a fleet deployment and never commits (step 7): the
// registry (REGISTRY) and every client's database (CLIENT_DB). Its suite is test-two-clients/:
// two clients on one deployment, through the runner's real entries.
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { addClientDb } from "@composable-os/db/testing/vitest";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const registryMigrationsDir = fileURLToPath(
  new URL("../../packages/db/registry-migrations", import.meta.url),
);

export default defineWorkersTestConfig({
  include: ["test-two-clients/**/*.test.ts"],
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: await addClientDb({
      d1Databases: ["REGISTRY"],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        REGISTRY_MIGRATIONS: await readD1Migrations(registryMigrationsDir),
        COS_HOST_ENVIRONMENT: "live",
        COS_BINDING_KEY: "two-client-suite-binding-key-0123456789abcdef",
        INTEGRATIONS_FAKE_PROVIDER: "false",
        TURNSTILE_SECRET_KEY: "",
      },
    }),
  }),
});
