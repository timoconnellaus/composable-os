import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { productAlias } from "@composable-os/product/node";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devSecrets } from "./dev-secrets.ts";
import { packBlocks } from "./pack-blocks-plugin.ts";
import pkg from "./package.json" with { type: "json" };
import { configuratorSpecs } from "./src/components/integrations/configurator/vite-plugin.ts";

function gitCommit(): string {
  // Workers Builds sets WORKERS_CI_COMMIT_SHA; fall back to the local checkout.
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GIT_COMMIT;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const PORT = Number(process.env.PORT ?? 5173);

/**
 * Local dev's own org extensions (stage 27): the box office fixture, which scripts/dev-setup.mjs
 * puts in local BLOBS under this hash, as `cos deploy` would. Empty when it has not run.
 */
function devOrgExtensions(): string {
  try {
    return readFileSync(
      new URL("./.wrangler/org-extensions.sha256", import.meta.url),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

/** The packs a client-shaped local runner installs (COS_DEV_PACKS), or "" for the CRM's "*". */
function devPacks(): string {
  try {
    return readFileSync(new URL("./.wrangler/cos-packs", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
}

export default defineConfig(({ command }) => ({
  // `#/…` is src/ (tsconfig paths), as in `import { callOp } from "#/lib/operations"`.
  // COS_PRODUCT builds for another product: the active product module becomes its definition.
  resolve: {
    alias: { "#": fileURLToPath(new URL("./src", import.meta.url)), ...productAlias() },
  },
  server: { port: PORT, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    // Pack web blocks mounted where they sit (development, /blocks and e2e).
    ...(command === "serve" ? [packBlocks(fileURLToPath(new URL("../..", import.meta.url)))] : []),
    // cos-runner runs in the same local runtime as an auxiliary Worker, so `pnpm dev` starts both
    // and the RUNNER service binding resolves locally.
    cloudflare({
      // scripts/deploy.mjs builds with a generated config that adds the AI bindings (ADR 0150).
      ...(process.env.COS_WRANGLER_CONFIG ? { configPath: process.env.COS_WRANGLER_CONFIG } : {}),
      viteEnvironment: { name: "ssr" },
      // Local dev only: declared secrets would otherwise keep optional ones in .dev.vars (provider
      // keys and the like) from reaching the Worker. Builds keep wrangler.jsonc's declaration, so
      // deploys still require BETTER_AUTH_SECRET (dev-secrets.ts, docs/deploying.md).
      ...(command === "serve"
        ? {
            config: (app) => {
              const secrets = devSecrets(app.secrets, dirname(fileURLToPath(import.meta.url)));
              if (secrets) app.secrets = secrets;
            },
          }
        : {}),
      auxiliaryWorkers:
        command === "serve"
          ? [
              {
                configPath: "../runner/wrangler.jsonc",
                // Local dev and e2e also run our inbound webhook gatekeeper (ADR 0113), bound
                // as a deployment would bind it, so webhook-triggered automations run locally.
                config: (runner) => ({
                  vars: {
                    ...runner.vars,
                    COS_ORG_EXTENSIONS: devOrgExtensions(),
                    // A client-shaped local runner (COS_DEV_PACKS, scripts/dev-setup.mjs).
                    ...(devPacks() ? { COS_PACKS: devPacks() } : {}),
                  },
                  services: [
                    ...(runner.services ?? []),
                    {
                      binding: "GATEKEEPER_WEBHOOK",
                      service: "cos-gatekeeper-webhook",
                      entrypoint: "GatekeeperVendor",
                    },
                    // Stage 25: the payments gatekeeper with its fake provider (no Stripe keys).
                    {
                      binding: "GATEKEEPER_PAYMENTS",
                      service: "cos-gatekeeper-payments",
                      entrypoint: "GatekeeperVendor",
                    },
                  ],
                }),
              },
              {
                configPath: "../../packages/gatekeeper-webhook/wrangler.jsonc",
                devOnly: true,
                config: (webhook) => ({
                  vars: {
                    ...webhook.vars,
                    BASE_URL: `http://localhost:${PORT}/gatekeeper/webhook`,
                  },
                  durable_objects: {
                    bindings: [
                      ...(webhook.durable_objects?.bindings ?? []),
                      // Reached only as a facet in production; declared so the local runtime
                      // registers the class (as the package's own tests do).
                      {
                        name: "WEBHOOK_ENDPOINT_GATEKEEPER",
                        class_name: "WebhookEndpointGatekeeper",
                      },
                    ],
                  },
                }),
              },
              {
                configPath: "../../packages/gatekeeper-payments/wrangler.jsonc",
                devOnly: true,
                config: (payments) => ({
                  vars: {
                    ...payments.vars,
                    BASE_URL: `http://localhost:${PORT}/gatekeeper/payments`,
                    // Local dev and e2e only: the fake provider's hosted page and webhook.
                    PAYMENTS_FAKE_PROVIDER: "true",
                  },
                  durable_objects: {
                    bindings: [
                      ...(payments.durable_objects?.bindings ?? []),
                      // Reached only as a facet in production; declared so the local runtime
                      // registers the class.
                      { name: "PAYMENTS_GATEKEEPER", class_name: "PaymentsGatekeeper" },
                    ],
                  },
                }),
              },
            ]
          : [{ configPath: "../runner/wrangler.jsonc" }],
    }),
    tailwindcss(),
    // Gatekeeper resource pickers: the vendored configurator specs, rendered with our runtime.
    configuratorSpecs(),
    tanstackStart(),
    viteReact(),
  ],
}));
