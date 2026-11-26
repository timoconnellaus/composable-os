// The runner as a many-client host's (stage 66 step 4, ADR 0615): the committed wrangler.jsonc,
// plus what the deploy engine adds for a fleet deployment and never commits (step 7): the
// registry (REGISTRY) and the query path of every client's database (CLIENT_DB_QUERIES, never the raw CLIENT_DB). Its suite is test-two-clients/:
// two clients on one deployment, through the runner's real entries.
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { addClientDbService, manyClientWranglerConfig } from "@composable-os/db/testing/vitest";
import { bundleGatekeeper, FAKE_EMAIL_SERVICE } from "./vitest.gatekeepers.ts";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const registryMigrationsDir = fileURLToPath(
  new URL("../../packages/db/registry-migrations", import.meta.url),
);

export default defineWorkersTestConfig({
  include: ["test-two-clients/**/*.test.ts"],
  workers: async () => ({
    // The committed wrangler.jsonc as a many-client deployment has it: no fake gatekeeper.
    wrangler: {
      configPath: manyClientWranglerConfig(fileURLToPath(new URL(".", import.meta.url))),
    },
    miniflare: await addClientDbService(
      {
        d1Databases: ["REGISTRY"],
        // Each client's parked messages, counted and capped (client-parking.ts), as step 7 binds it.
        durableObjects: {
          CLIENT_PARKING_LEDGER: { className: "ParkingLedger", useSQLite: true },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          REGISTRY_MIGRATIONS: await readD1Migrations(registryMigrationsDir),
          COS_HOST_ENVIRONMENT: "live",
          COS_BINDING_KEY: "two-client-suite-binding-key-0123456789abcdef",
          TURNSTILE_SECRET_KEY: "",
        },
        // The email-send gatekeeper as a many-client deployment runs it (ADR 0616, "Email
        // sending per client"): SENDER_DOMAINS_PER_CLIENT set, and a deployment's list it must
        // never read; Email Service is the fake, whose outbox the suite reads.
        serviceBindings: {
          GATEKEEPER_EMAIL_SEND: {
            name: "cos-gatekeeper-email-send",
            entrypoint: "GatekeeperVendor",
          },
          TEST_EMAIL_OUTBOX: { name: "fake-email-service", entrypoint: "Outbox" },
        },
        workers: [
          {
            name: "cos-gatekeeper-email-send",
            modules: true,
            scriptPath: await bundleGatekeeper("email-send"),
            compatibilityDate: "2026-09-04",
            compatibilityFlags: ["allow_irrevocable_stub_storage"],
            bindings: {
              ALLOWED_SENDER_DOMAINS: "everyone.test",
              INTERNAL_DOMAINS: "",
              SENDER_DOMAINS_PER_CLIENT: "true",
            },
            serviceBindings: { EMAIL: { name: "fake-email-service", entrypoint: "FakeEmail" } },
            durableObjects: {
              EMAIL_SEND_GATEKEEPER: { className: "EmailSendGatekeeper", useSQLite: true },
            },
          },
          {
            name: "fake-email-service",
            modules: [{ type: "ESModule", path: "fake-email.mjs", contents: FAKE_EMAIL_SERVICE }],
            compatibilityDate: "2026-09-04",
            durableObjects: { SENT: { className: "Sent", useSQLite: true } },
          },
        ],
      },
      "cos-runner",
    ),
  }),
});
