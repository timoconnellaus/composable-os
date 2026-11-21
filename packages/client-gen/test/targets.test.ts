// Stage 23, acceptance criterion 5, second half (ADR 0418): the runtime and a generated client
// build, and their scenario runs, under two targets:
//
// - Workers: the same generated client and scenario, committed in packages/client, run in workerd
//   by its Workers test pool (test/generated.test.ts there).
// - React Native: bundled to ES2019 as one script, the syntax level Hermes takes, and run in a V8
//   context holding only ECMAScript's own globals plus what React Native gives an app (`fetch`,
//   `setTimeout`): no `window`, no `document`, no `process`, no `crypto` (React Native has none
//   without a polyfill, so the app passes `randomKey`). It is not Hermes itself; HERMES_BIN, when
//   set, runs the same script in a real Hermes binary too.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildContract, defineOperation } from "@composable-os/core";
import deals from "@composable-os/pack-deals";
import leads from "@composable-os/pack-leads";
import lifecycle from "@composable-os/pack-lifecycle";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { productContract, renderClient } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "..", "..", "client", "src", "index.ts");
const scratchRoot = join(here, "..", ".scratch-targets");
mkdirSync(scratchRoot, { recursive: true });
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const contract = buildContract([
  defineOperation({
    name: "fixture.greet",
    description: "Fixture: greets the caller by name. Used by the target tests. Writes nothing.",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    permission: "records:read",
    risk: "read",
    audiences: ["customer"],
    handler: async () => ({ greeting: "hi" }),
  }),
  defineOperation({
    name: "fixture.save",
    description: "Fixture: saves a note for the caller. Used by the target tests. A write.",
    input: z.object({ text: z.string() }),
    output: z.object({ id: z.string() }),
    permission: "records:read",
    risk: "write",
    audiences: ["customer"],
    handler: async () => ({ id: "x" }),
  }),
]);

/**
 * The scenario: a generated client against a host stub that drops the first write and answers
 * the retry. It reports what happened; `report` is how each target hands the result back.
 */
const SCENARIO = `import { createCustomerClient } from "./customer.ts";
import { UpgradeRequiredError } from "@composable-os/client";

export async function scenario() {
  const sent = [];
  let n = 0;
  const fetch = async (url, init) => {
    sent.push({ url, key: init.headers["idempotency-key"] || null, body: init.body });
    n += 1;
    if (url.endsWith("/op/fixture.save") && n === 2) throw new TypeError("dropped");
    const old = url.includes("/op/fixture.old");
    const body = old
      ? { error: { code: "upgrade_required", message: "Update the app" } }
      : url.endsWith("greet")
        ? { data: { greeting: "Hello, " + JSON.parse(init.body).name } }
        : { data: { id: "rec_1" } };
    return { status: old ? 426 : 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  let k = 0;
  const api = createCustomerClient({
    baseUrl: "https://host.example",
    fetch,
    randomKey: () => "key-" + ++k + "-0123456789abcdef",
    sleep: async () => {},
  });
  const greeting = await api.call("fixture.greet", { name: "Ada" });
  const query = api.query("fixture.greet", { name: "Ada" });
  const saved = await api.mutation("fixture.save").mutationFn({ text: "hi" });
  let upgrade = false;
  try {
    await api.call("fixture.old", {});
  } catch (error) {
    upgrade = error instanceof UpgradeRequiredError || (error && error.code === "unknown_operation");
  }
  return { greeting, key: query.queryKey, saved, sent, upgrade };
}
`;

async function bundle(format: "esm" | "iife", target: string): Promise<string> {
  const dir = mkdtempSync(join(scratchRoot, "b-"));
  const files = renderClient(contract, { product: "fixture" });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "scenario.ts"), SCENARIO);
  const entry =
    format === "esm"
      ? `import { scenario } from "./scenario.ts";
export default { async fetch() { return new Response(JSON.stringify(await scenario())); } };`
      : `import { scenario } from "./scenario.ts";
scenario().then((r) => report(JSON.stringify(r)), (e) => report(JSON.stringify({ error: String(e && e.stack || e) })));`;
  writeFileSync(join(dir, "entry.ts"), entry);
  const out = await build({
    entryPoints: [join(dir, "entry.ts")],
    bundle: true,
    write: false,
    format,
    target,
    platform: "neutral",
    alias: { "@composable-os/client": runtime },
    logLevel: "error",
  });
  return out.outputFiles[0]?.text ?? "";
}

function expectScenario(result: Record<string, unknown>) {
  expect(result.error).toBeUndefined();
  expect(result.greeting).toEqual({ greeting: "Hello, Ada" });
  expect(result.key).toEqual(["fixture.greet", { name: "Ada" }]);
  expect(result.saved).toEqual({ id: "rec_1" });
  const sent = result.sent as { url: string; key: string | null }[];
  // The dropped write and its retry carried the same key; the read carried none.
  expect(sent.map((s) => s.key)).toEqual([
    null,
    "key-1-0123456789abcdef",
    "key-1-0123456789abcdef",
  ]);
  expect(sent[0]?.url).toBe("https://host.example/api/v1/op/fixture.greet");
}

describe("the generated client's targets", () => {
  it("Workers: the client packages/client runs in workerd is this generator's output", () => {
    // packages/client/test/generated.test.ts runs this scenario on this generated client inside
    // workerd. They are committed there (the runtime cannot depend on the generator), and this
    // keeps them the generator's current output. UPDATE_CLIENT_FIXTURE=1 rewrites them.
    const dir = join(here, "..", "..", "client", "test", "generated");
    const files = {
      "customer.ts": renderClient(contract, { product: "fixture" })["customer.ts"] as string,
      "scenario.ts": `// Generated by packages/client-gen/test/targets.test.ts. Do not edit.\n// @ts-nocheck: plain JavaScript, so the same text bundles for every target.\n${SCENARIO}`,
    };
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, name);
      if (process.env.UPDATE_CLIENT_FIXTURE === "1") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, text);
      }
      expect(readFileSync(path, "utf8"), `${path} is stale: UPDATE_CLIENT_FIXTURE=1`).toBe(text);
    }
  });

  it("the client template's committed client is the CRM's current customer client", () => {
    // The template's web app (templates/client/apps/web) commits its generated client, as a
    // client repo does, and apps/app's company-web fixture runs the template's code against the
    // real host (stage 24). This keeps the copy current, so it is refreshed on purpose:
    // UPDATE_CLIENT_FIXTURE=1 rewrites it. `cos create` writes a fresh one for its product.
    const root = join(here, "..", "..", "..");
    const text = renderClient(productContract([deals, leads, lifecycle]), { product: "crm" })[
      "customer.ts"
    ] as string;
    for (const app of ["web", "mobile"]) {
      const file = join(root, "templates", "client", "apps", app, "src", "client", "customer.ts");
      if (process.env.UPDATE_CLIENT_FIXTURE === "1") writeFileSync(file, text);
      expect(
        readFileSync(file, "utf8"),
        `${file} is not the CRM's current customer client: an operation open to customers changed. ` +
          "Regenerate it on purpose with UPDATE_CLIENT_FIXTURE=1 pnpm --filter @composable-os/client-gen test",
      ).toBe(text);
    }
  });

  it("React Native: runs as ES2019 with only ECMAScript's globals, fetch and setTimeout", async () => {
    const script = await bundle("iife", "es2019");
    // Syntax a Hermes build of this era refuses is lowered: no `?.`, `??` or class fields.
    expect(script).not.toMatch(/\?\.|\?\?/);
    let reported = "";
    const done = new Promise<void>((resolve) => {
      const context = vm.createContext({
        report: (text: string) => {
          reported = text;
          resolve();
        },
        setTimeout,
      });
      // Nothing of the host is in the context: no window, document, process, crypto or fetch.
      expect(
        vm.runInContext(
          "typeof window + typeof document + typeof process + typeof crypto",
          context,
        ),
      ).toBe("undefinedundefinedundefinedundefined");
      vm.runInContext(script, context);
    });
    await done;
    expectScenario(JSON.parse(reported) as Record<string, unknown>);
  });

  it("React Native: the template's mobile host module signs in by tokens and writes with no crypto (ADR 0451)", async () => {
    // The template's own host module, against a stand-in of the host's token routes (ADR 0455)
    // and its HTTP surface, in the same bare context: no crypto, so writes need the app's random.
    const root = join(here, "..", "..", "..");
    const dir = mkdtempSync(join(scratchRoot, "m-"));
    writeFileSync(
      join(dir, "entry.ts"),
      `import { hostSession } from ${JSON.stringify(join(root, "templates", "client", "apps", "mobile", "src", "host.ts"))};
const sent = [];
const answer = (data, status = 200) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(status === 200 ? { data } : { error: data }) });
const fetch = async (url, init) => {
  sent.push({ url, headers: init.headers, body: init.body });
  if (url.endsWith("/api/v1/auth/customer/code")) return answer({ ok: true });
  if (url.endsWith("/api/v1/auth/customer/sign-in")) {
    const body = JSON.parse(init.body);
    if (body.code !== "123456") return answer({ code: "forbidden", message: "That code did not work", details: { reason: "invalid_code" } }, 401);
    return answer({ accessToken: "cos_at_1", refreshToken: "cos_rt_1", accessExpiresAt: "2999-01-01T00:00:00.000Z", sessionId: "dvs_1", account: "ready" });
  }
  if (url.endsWith("/api/v1/op/me.update")) return answer({ id: "per_1" });
  return answer({ code: "unknown_operation", message: "no" }, 404);
};
let saved = null;
const store = { load: async () => saved, save: async (t) => { saved = t; } };
let n = 0;
const random = { bytes: (k) => { const out = new Uint8Array(k); for (let i = 0; i < k; i++) out[i] = (n++ * 7) & 255; return out; }, sha256: async () => new Uint8Array(32) };
async function run() {
  let refused = "";
  try { hostSession({ hostUrl: "https://admin.gym.example", store, deviceName: "Phone", fetch }); } catch (e) { refused = String(e.message); }
  const app = hostSession({ hostUrl: "https://admin.gym.example", store, deviceName: "Phone", fetch, random });
  await app.requestCode("ada@example.com");
  const wrong = await app.signIn("ada@example.com", "000000");
  const right = await app.signIn("ada@example.com", "123456");
  const updated = await app.api.call("me.update", { givenName: "Ada" });
  return { refused, wrong, right, saved, updated, sent };
}
run().then((r) => report(JSON.stringify(r)), (e) => report(JSON.stringify({ error: String(e && e.stack || e) })));
`,
    );
    const out = await build({
      entryPoints: [join(dir, "entry.ts")],
      bundle: true,
      write: false,
      format: "iife",
      target: "es2019",
      platform: "neutral",
      alias: { "@composable-os/client": runtime },
      logLevel: "error",
    });
    let reported = "";
    await new Promise<void>((resolve) => {
      const context = vm.createContext({
        report: (text: string) => {
          reported = text;
          resolve();
        },
        setTimeout,
      });
      expect(vm.runInContext("typeof crypto", context)).toBe("undefined");
      vm.runInContext(out.outputFiles[0]?.text ?? "", context);
    });
    const result = JSON.parse(reported) as {
      error?: string;
      refused: string;
      wrong: boolean;
      right: boolean;
      saved: Record<string, string>;
      updated: unknown;
      sent: { url: string; headers: Record<string, string>; body: string }[];
    };
    expect(result.error).toBeUndefined();
    // Said at start-up, not at the first write.
    expect(result.refused).toMatch(/needs the app's secure random source/);
    expect(result.wrong).toBe(false);
    expect(result.right).toBe(true);
    // Tokens, never a cookie; the account flag is not kept.
    expect(result.saved).toEqual({
      accessToken: "cos_at_1",
      refreshToken: "cos_rt_1",
      accessExpiresAt: "2999-01-01T00:00:00.000Z",
      sessionId: "dvs_1",
    });
    expect(JSON.parse(result.sent[1]?.body ?? "{}")).toMatchObject({ deviceName: "Phone" });
    // The write carried the access token and a key from the app's random source.
    const write = result.sent.find((s) => s.url.endsWith("/op/me.update"));
    expect(write?.headers.authorization).toBe("Bearer cos_at_1");
    expect(write?.headers["idempotency-key"]).toMatch(/^[0-9a-f]{32}$/);
    expect(
      result.sent.some((s) => JSON.stringify(s.headers).toLowerCase().includes("cookie")),
    ).toBe(false);
  });

  it.skipIf(!process.env.HERMES_BIN)("Hermes: the same script in a Hermes binary", async () => {
    const script = await bundle("iife", "es2019");
    const file = join(mkdtempSync(join(scratchRoot, "h-")), "scenario.js");
    writeFileSync(
      file,
      `var __out; function report(t) { __out = t; print(t); }
var setTimeout = function (fn) { Promise.resolve().then(fn); };
${script}`,
    );
    const output = execFileSync(process.env.HERMES_BIN as string, ["-Xes6-promise", file], {
      encoding: "utf8",
    });
    expectScenario(JSON.parse(output.trim().split("\n").pop() ?? "{}") as Record<string, unknown>);
  });
});
