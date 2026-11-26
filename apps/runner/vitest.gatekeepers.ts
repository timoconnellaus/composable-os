// The runner suites' gatekeepers (vitest.config.ts, vitest.two-client.config.ts): our own
// gatekeepers bundled to run beside the runner as auxiliary Workers, and a stand-in for Email
// Service's send_email binding.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Our own gatekeepers (packages/gatekeeper-webhook, packages/gatekeeper-email-send), bundled to
 * run next to the runner as auxiliary Workers, so tests drive the real gatekeepers through the
 * integration host. `accounting-fake` is the fake accounting system's gatekeeper (stage 61,
 * packages/gatekeeper-accounting/src/fake-worker.ts) and `booking-system-fake` the fake booking
 * system's (stage 65, packages/gatekeeper-booking-system/src/fake-worker.ts), bound only here and
 * in local development.
 */
export type GatekeeperName =
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
export function bundleGatekeeper(name: GatekeeperName): Promise<string> {
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
export const FAKE_EMAIL_SERVICE = `
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
