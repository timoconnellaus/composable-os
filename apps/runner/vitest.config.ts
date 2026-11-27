import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientDbSetupFiles, withClientDb } from "@composable-os/db/testing/vitest";
import { bundleGatekeeper, FAKE_EMAIL_SERVICE } from "./vitest.gatekeepers.ts";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    // COS_TEST_DB=client-db: env.DB is a client's database (stage 66, ADR 0612).
    miniflare: await withClientDb({
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        // Stage 6a: the fake OAuth provider and gatekeeper (fake transports only, no accounts).
        INTEGRATIONS_FAKE_PROVIDER: "true",
        APP_ORIGIN: "http://crm.test",
        // No Turnstile secret, whatever .dev.vars says (local dev sets Cloudflare's test key,
        // scripts/dev-setup.mjs): the forms tests answer as a runner with none.
        TURNSTILE_SECRET_KEY: "",
      },
      serviceBindings: {
        GATEKEEPER_WEBHOOK: { name: "cos-gatekeeper-webhook", entrypoint: "GatekeeperVendor" },
        GATEKEEPER_EMAIL_SEND: {
          name: "cos-gatekeeper-email-send",
          entrypoint: "GatekeeperVendor",
        },
        GATEKEEPER_PAYMENTS: { name: "cos-gatekeeper-payments", entrypoint: "GatekeeperVendor" },
        // What a test does to the fake provider's payouts, as the provider would (stage 52 step 4).
        TEST_PAYMENTS: { name: "cos-gatekeeper-payments", entrypoint: "FakePaymentsControl" },
        GATEKEEPER_TEXT: { name: "cos-gatekeeper-text", entrypoint: "GatekeeperVendor" },
        // What the fake text provider "sent" and the codes, as a member's phone shows them.
        TEST_TEXT_PHONES: { name: "cos-gatekeeper-text", entrypoint: "FakeTextControl" },
        GATEKEEPER_ACCOUNTING_FAKE: {
          name: "cos-gatekeeper-accounting-fake",
          entrypoint: "GatekeeperVendor",
        },
        GATEKEEPER_BOOKING_SYSTEM_FAKE: {
          name: "cos-gatekeeper-booking-system-fake",
          entrypoint: "GatekeeperVendor",
        },
        TEST_EMAIL_OUTBOX: { name: "fake-email-service", entrypoint: "Outbox" },
        // What a test does to the fake books, as a bookkeeper (or a failing network) would.
        TEST_ACCOUNTING_BOOKS: {
          name: "cos-gatekeeper-accounting-fake",
          entrypoint: "FakeBooksControl",
        },
        // What a test does to the fake booking site, as the business (or a failing network) would.
        TEST_BOOKING_SYSTEM: {
          name: "cos-gatekeeper-booking-system-fake",
          entrypoint: "FakeBookingSystemControl",
        },
      },
      workers: [
        {
          name: "cos-gatekeeper-webhook",
          modules: true,
          scriptPath: await bundleGatekeeper("webhook"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: { BASE_URL: "http://crm.test/gatekeeper/webhook" },
          durableObjects: {
            WEBHOOK_ENDPOINT: { className: "WebhookEndpoint", useSQLite: true },
            // Facet classes must be declared to be instantiated (see the package's tests).
            WEBHOOK_ENDPOINT_GATEKEEPER: {
              className: "WebhookEndpointGatekeeper",
              useSQLite: true,
            },
          },
        },
        {
          name: "cos-gatekeeper-email-send",
          modules: true,
          scriptPath: await bundleGatekeeper("email-send"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: { ALLOWED_SENDER_DOMAINS: "example.com", INTERNAL_DOMAINS: "example.com" },
          serviceBindings: { EMAIL: { name: "fake-email-service", entrypoint: "FakeEmail" } },
          durableObjects: {
            EMAIL_SEND_GATEKEEPER: { className: "EmailSendGatekeeper", useSQLite: true },
          },
        },
        {
          name: "cos-gatekeeper-payments",
          modules: true,
          scriptPath: await bundleGatekeeper("payments"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: {
            BASE_URL: "http://crm.test/gatekeeper/payments",
            PAYMENTS_FAKE_PROVIDER: "true",
            FAKE_WEBHOOK_SECRET: "fake-payments-test-secret",
            STRIPE_API_BASE: "",
            STRIPE_ACCOUNT: "",
          },
          durableObjects: {
            PAYMENTS_EVENTS: { className: "PaymentsEvents", useSQLite: true },
            FAKE_PAYMENTS: { className: "FakePaymentsLedger", useSQLite: true },
            PAYMENTS_GATEKEEPER: { className: "PaymentsGatekeeper", useSQLite: true },
          },
        },
        {
          name: "cos-gatekeeper-text",
          modules: true,
          scriptPath: await bundleGatekeeper("text"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: {
            BASE_URL: "http://crm.test/gatekeeper/text",
            TEXT_PROVIDER: "fake",
            TEXT_SENDER_NUMBER: "+61400000999",
            FAKE_WEBHOOK_SECRET: "fake-text-test-secret",
          },
          durableObjects: {
            TEXT_EVENTS: { className: "TextEvents", useSQLite: true },
            FAKE_TEXT_LEDGER: { className: "FakeTextLedger", useSQLite: true },
            TEXT_GATEKEEPER: { className: "TextGatekeeper", useSQLite: true },
          },
        },
        {
          name: "cos-gatekeeper-accounting-fake",
          modules: true,
          scriptPath: await bundleGatekeeper("accounting-fake"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          durableObjects: {
            FAKE_BOOKS: { className: "FakeAccountingBooks", useSQLite: true },
            // Reached only as a facet; declared so the runtime registers the class.
            FAKE_ACCOUNTING_GATEKEEPER: {
              className: "FakeAccountingGatekeeper",
              useSQLite: true,
            },
          },
        },
        {
          name: "cos-gatekeeper-booking-system-fake",
          modules: true,
          scriptPath: await bundleGatekeeper("booking-system-fake"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          durableObjects: {
            FAKE_BOOKING_SITE: { className: "FakeBookingSite", useSQLite: true },
            // Reached only as a facet; declared so the runtime registers the class.
            FAKE_BOOKING_SYSTEM_GATEKEEPER: {
              className: "FakeBookingSystemGatekeeper",
              useSQLite: true,
            },
          },
        },
        {
          name: "fake-email-service",
          modules: [{ type: "ESModule", path: "fake-email.mjs", contents: FAKE_EMAIL_SERVICE }],
          compatibilityDate: "2026-09-04",
          durableObjects: { SENT: { className: "Sent", useSQLite: true } },
        },
      ],
    }),
  }),
  setupFiles: clientDbSetupFiles(["./test/apply-migrations.ts"]),
});
