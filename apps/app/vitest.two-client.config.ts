// cos-app as a many-client host's (stage 66 step 4, ADR 0615): the committed wrangler.jsonc, plus
// what the deploy engine adds for a fleet deployment and never commits (step 7): the registry
// (REGISTRY) and the query path of every client's database (CLIENT_DB_QUERIES, never the raw CLIENT_DB). Its suite is test-two-clients/: two clients
// on one deployment, through the app's real entries (src/server/entry.ts; TanStack Start itself
// needs its build, so the suite stands a recorder in its place).
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientAppProps } from "@composable-os/db/client-proofs";
import { TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { addClientDbService, TEST_PROPS_KEY } from "@composable-os/db/testing/vitest";
import { mergeConfig } from "vitest/config";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const registryMigrationsDir = fileURLToPath(
  new URL("../../packages/db/registry-migrations", import.meta.url),
);

// A stand-in cos-runner that answers `callAs` with the client it was called as, so the suite sees
// what the app's RUNNER wrapper sends (the real runner's entries are apps/runner's suite).
const RUNNER_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async callAs(client, method, args) { return { client, method, args }; }
  async gatekeeperCallback(vendor) { return new Response("callback for " + vendor); }
  async ping() { throw new Error("a many-client host's runner is called as a client"); }
}`;

// A client's web app as step 8 will upload it: its one binding, HOST, to ClientApp, the client
// fixed in the binding's props. It forwards every request as it came, Host header and all.
const WEB_APP = `export default { fetch: (request, env) => env.HOST.fetch(request) };`;

/** An Ed25519 key pair standing in for the control plane's support key (ADR 0212). */
const SUPPORT_KEYS = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: jwk.x,
    privateJwk: JSON.stringify(privateKey.export({ format: "jwk" })),
  };
})();

/** The suite's host binding key (a real deployment's is a long random secret of the operator's). */
export const BINDING_KEY_FOR_TESTS = "two-client-suite-binding-key-0123456789abcdef";

/** A web app's props for `client`, as step 8's deploy writes them: with its generation (S3). */
const propsFor = (client: { id: string; generation: string }) =>
  clientAppProps(TEST_PROPS_KEY, "live", client.id, client.generation);

/** The pool's name for the Worker under test, which auxiliary Workers bind to. */
const SELF_WORKER = "vitest-plugin-runner-";

const webApp = (name: string, props?: Record<string, string>) => ({
  name,
  modules: true,
  script: WEB_APP,
  compatibilityDate: "2026-10-01",
  serviceBindings: {
    HOST: { name: SELF_WORKER, entrypoint: "ClientApp", ...(props ? { props } : {}) },
  },
});

export default mergeConfig(
  defineWorkersTestConfig({
    include: ["test-two-clients/**/*.test.ts"],
    workers: async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./test-two-clients/worker.ts",
      miniflare: await addClientDbService({
        d1Databases: ["REGISTRY"],
        // Each client's parked messages, counted and capped (client-parking.ts), as step 7 binds it.
        durableObjects: {
          CLIENT_PARKING_LEDGER: { className: "ParkingLedger", useSQLite: true },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          REGISTRY_MIGRATIONS: await readD1Migrations(registryMigrationsDir),
          // Which of its clients' environments this deployment holds (ADR 0613).
          COS_HOST_ENVIRONMENT: "live",
          // The host's object-naming key (client-proofs.ts); its props key is addClientDbService's.
          COS_BINDING_KEY: BINDING_KEY_FOR_TESTS,
          // The deployment's one callback address (step 6, ADR 0616; entry.ts routes it first).
          COS_CALLBACK_HOSTNAME: "callbacks.test",
          // The root every client's auth, desk and support secrets are derived from (ADR 0616).
          COS_ROOT_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString(
            "base64url",
          ),
          // The control plane's support key (ADR 0212): the public half the host checks with, and
          // for the suite the private half it signs support tokens with.
          COS_SUPPORT_PUBLIC_KEY: SUPPORT_KEYS.publicKey,
          SUPPORT_TEST_PRIVATE_JWK: SUPPORT_KEYS.privateJwk,
          // The deployment's own: a client's environment never holds it (step 6 derives each
          // client's). The suite shows a client's sign-in refuses without its own.
          BETTER_AUTH_SECRET: "the-host-wide-secret-the-host-wide-secret",
          AI_FAKE_MODEL: "true",
        },
        serviceBindings: {
          RUNNER: "cos-runner",
          WEB_GYM_A: "web-gym-a",
          WEB_NO_CLIENT: "web-no-client",
          WEB_PAUSED: "web-paused",
          WEB_NOBODY: "web-nobody",
          WEB_FORGED: "web-forged",
          WEB_UNPROVEN: "web-unproven",
          WEB_EARLIER: "web-earlier",
        },
        workers: [
          {
            name: "cos-runner",
            modules: true,
            script: RUNNER_STUB,
            compatibilityDate: "2026-10-01",
          },
          webApp("web-gym-a", propsFor(TWO_CLIENTS.a)),
          webApp("web-no-client"),
          webApp("web-paused", propsFor(TWO_CLIENTS.paused)),
          webApp("web-nobody", clientAppProps(TEST_PROPS_KEY, "live", "gym-nobody", null)),
          // gym-b named with gym-a's proof, and gym-b with none: what code without the key mints.
          webApp("web-forged", { client: "gym-b", proof: propsFor(TWO_CLIENTS.a).proof }),
          webApp("web-unproven", { client: "gym-b" }),
          // gym-a's props as they were for an earlier client of the id (another generation, S3).
          webApp("web-earlier", clientAppProps(TEST_PROPS_KEY, "live", "gym-a", "f6".repeat(16))),
        ],
      }),
    }),
  }),
  {
    plugins: [
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
