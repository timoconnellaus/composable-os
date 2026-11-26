import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientDbSetupFiles, withClientDb } from "@composable-os/db/testing/vitest";
import { build } from "esbuild";
import { mergeConfig } from "vitest/config";
import { configuratorSpecs } from "./src/components/integrations/configurator/vite-plugin.ts";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/**
 * ASSEMBLYAI_LIVE=1 only (test/voice-live.test.ts): the key from .dev.vars, which the pool's
 * `secrets.required` declaration would otherwise drop. CI never sets it, so it never needs a key.
 */
function liveVoiceBindings(): Record<string, string> {
  if (process.env.ASSEMBLYAI_LIVE !== "1" || !existsSync(".dev.vars")) return {};
  const line = /^AI_KEY_ASSEMBLYAI=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"));
  return line?.[1] ? { ASSEMBLYAI_LIVE: "1", AI_KEY_ASSEMBLYAI: line[1].trim() } : {};
}

// A stand-in cos-runner for the RUNNER service binding: the real one is tested in apps/runner and
// end to end by the Playwright smoke test.
const RUNNER_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async ping() { return { ok: true, worker: "cos-runner", time: new Date().toISOString() }; }
  async installShipped() { return []; }
  async shipped() { return []; }
  async listWorkspace() { return []; }
  // Echoes extension tool calls (the real runtime is tested in apps/runner).
  async runTool(input) { return { ok: true, value: { tool: input.tool, input: input.input, caller: input.caller.actor }, runId: "xrn_stub" }; }
  // A saved card (the real run is tested in apps/runner).
  async runProducer(input) {
    if (String(input.ref).startsWith("briefing.")) {
      return { ok: true, durationMs: 1, value: { a2ui: 1, root: { type: "emptyState", title: "Nothing on today" } } };
    }
    const record = { object: "person", id: "per_01KA8ZQ7Y2V3N4M5P6R7S8T9W0", label: "Ada" };
    return { ok: true, durationMs: 1, value: { a2ui: 1, root: { type: "taskList", title: "From the stub runner", tasks: [{ id: "tsk_1", title: "Call Ada", record }] } } };
  }
}`;

/**
 * A stand-in for a company's own web app (stage 24): test/fixtures/company-web, bundled as one
 * module. It binds to this Worker's ClientApp entrypoint and has no other binding.
 */
async function companyWebScript(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./test/fixtures/company-web/worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  return result.outputFiles[0]?.text ?? "";
}

export default mergeConfig(
  defineWorkersTestConfig({
    include: ["src/**/*.test.ts", "test/**/*.test.{ts,tsx}"],
    workers: async () => ({
      // Bindings and vars come from wrangler.jsonc; main is TanStack Start's entry, which these
      // tests do not load (they exercise src/server/* directly).
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./test/worker.ts",
      // COS_TEST_DB=client-db: env.DB is a client's database (stage 66, ADR 0612).
      miniflare: await withClientDb({
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
          // The scripted stand-ins answer every model role (the assistant's conversation object
          // reads its env from here; tests that need "no AI" pass their own env).
          AI_FAKE_MODEL: "true",
          AI_FAKE_VOICE: "true",
          ...liveVoiceBindings(),
        },
        serviceBindings: {
          RUNNER: "cos-runner",
          // The company-web fixture, and the same binding it holds (to call it as that Worker).
          COMPANY_WEB: "company-web",
          COMPANY_WEB_HOST: { name: "cos-app", entrypoint: "ClientApp" },
        },
        // The fake Cloudflare account's D1 database in the self-updater tests.
        d1Databases: { UPDATER_FAKE_D1: "updater-fake-d1" },
        workers: [
          {
            name: "cos-runner",
            modules: true,
            script: RUNNER_STUB,
            compatibilityDate: "2026-10-01",
          },
          {
            // The company's web app: a service binding to cos-app's ClientApp entrypoint (this
            // test Worker exports the real class) and nothing else, as the template's has.
            name: "company-web",
            modules: true,
            script: await companyWebScript(),
            compatibilityDate: "2026-10-01",
            // The pool renames the Worker under test to its runner (`vitest-plugin-runner-` and
            // the project's name, which is empty here); an auxiliary Worker binds to it by that.
            serviceBindings: { HOST: { name: "vitest-plugin-runner-", entrypoint: "ClientApp" } },
          },
        ],
      }),
    }),
    setupFiles: clientDbSetupFiles(["./test/apply-migrations.ts"]),
  }),
  {
    // Gatekeeper resource pickers: the vendored configurator specs, rendered with our runtime.
    plugins: [
      configuratorSpecs(),
      // The admin build's screen fingerprints (screens-plugin.ts): none in these tests, so
      // screens.mine lists nothing here; packages/core/test/screens.test.ts sets its own.
      {
        name: "cos-screens-built-stub",
        resolveId: (id: string) =>
          id === "virtual:cos-screens-built" ? "\0cos-screens-built" : null,
        load: (id: string) =>
          id === "\0cos-screens-built" ? "export const BUILT_SCREENS = {};" : null,
      },
    ],
    resolve: {
      alias: {
        "#/server/call-operation": fileURLToPath(
          new URL("./test/stubs/call-operation.ts", import.meta.url),
        ),
        "#": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify("0.0.0-test"),
      __APP_COMMIT__: JSON.stringify("test"),
    },
  },
);
