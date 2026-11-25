import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { build } from "esbuild";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/**
 * Our own gatekeepers (packages/gatekeeper-webhook, packages/gatekeeper-email-send), bundled to
 * run next to the runner as auxiliary Workers, so tests drive the real gatekeepers through the
 * integration host. `accounting-fake` is the fake accounting system's gatekeeper (stage 61,
 * packages/gatekeeper-accounting/src/fake-worker.ts) and `booking-system-fake` the fake booking
 * system's (stage 65, packages/gatekeeper-booking-system/src/fake-worker.ts), bound only here and
 * in local development.
 */
type GatekeeperName =
  | "webhook"
  | "email-send"
  | "payments"
  | "text"
  | "accounting-fake"
  | "booking-system-fake";

const FAKE_ENTRIES: Partial<Record<GatekeeperName, string>> = {
  "accounting-fake": "../../packages/gatekeeper-accounting/src/fake-worker.ts",
  "booking-system-fake": "../../packages/gatekeeper-booking-system/src/fake-worker.ts",
};
function bundleGatekeeper(name: GatekeeperName): Promise<string> {
  // Once per run. `workers` below is called again for each test file, and rebuilding in place
  // lets a pool that is starting read a half-written bundle (it then has no GatekeeperVendor).
  let bundle = gatekeeperBundles.get(name);
  if (!bundle) {
    bundle = buildGatekeeper(name);
    gatekeeperBundles.set(name, bundle);
  }
  return bundle;
}

const gatekeeperBundles = new Map<string, Promise<string>>();

async function buildGatekeeper(name: GatekeeperName): Promise<string> {
  const outfile = fileURLToPath(
    new URL(`./.wrangler/test-gatekeepers/${name}.js`, import.meta.url),
  );
  const entry = FAKE_ENTRIES[name] ?? `../../packages/gatekeeper-${name}/src/worker.ts`;
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    loader: { ".txt": "text" },
    // types.txt is a symlink to types.d.ts: load it as text, not as the .d.ts it points to.
    preserveSymlinks: true,
    logLevel: "error",
  });
  return outfile;
}

/**
 * Stands in for Cloudflare Email Service's `send_email` binding of the email-send gatekeeper
 * (stage 6b notification tests): `FakeEmail.send()` keeps each message; the runner's tests read
 * them through `TEST_EMAIL_OUTBOX` (`Outbox.list()`).
 */
const FAKE_EMAIL_SERVICE = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Sent extends DurableObject {
  async add(message) {
    const list = (await this.ctx.storage.get("sent")) ?? [];
    list.push(message);
    await this.ctx.storage.put("sent", list);
  }
  async list() {
    return (await this.ctx.storage.get("sent")) ?? [];
  }
}
export class FakeEmail extends WorkerEntrypoint {
  async send(message) {
    await this.env.SENT.getByName("all").add(JSON.parse(JSON.stringify(message)));
    return { messageId: "fake-" + Date.now() };
  }
}
export class Outbox extends WorkerEntrypoint {
  async list() {
    return this.env.SENT.getByName("all").list();
  }
}
export default { fetch: () => new Response("fake email service") };
`;

export default defineWorkersTestConfig({
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
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
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
