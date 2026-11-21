// Stage 24: `cos` in a company's own repository, against the fake Cloudflare API and a fake GitHub
// serving fixture releases whose client kit is the real one (scripts/release/client-kit.ts).
//
// - 1 (deploy part): `cos create` then `cos deploy` yields a host and a web app bound to it. The
//   sign-in on the web app's hostname is apps/app/test/company-web.test.ts, which runs the
//   template's own host module against the real host.
// - 2: `cos init` in an Astro-on-a-Worker repo with its own D1 and an Expo app adds only its
//   files, shows every change to one that exists, and afterwards both apps' calls compile, typed.
// - 3 (config part): a web app with a database binding of its own is refused.
// - 7: a product with no packs deploys a host told to install none.
// - 8: an org extension is installed by deploy (pinned in BLOBS); a failing one stops the deploy
//   with nothing changed.
// - 10: `cos add` copies a block from the matching release and writes the lock; `cos diff` shows
//   upstream changes without touching a local edit.
// - 11: `cos upgrade` to a release that changes an operation reports the type error and deploys
//   nothing.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildFixtureRelease } from "@composable-os/release/testing";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectClientKit } from "../../../scripts/release/client-kit.ts";
import { runIn, startWorld, type World } from "./world.ts";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
// Scratch repos inside the package, so module resolution finds the workspace packages.
const scratchRoot = join(here, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const scratch = () => mkdtempSync(join(scratchRoot, "repo-"));

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The real client kit, as text, with `change` applied. */
function kit(change: (files: Record<string, string>) => void = () => {}) {
  const files = Object.fromEntries(
    [...collectClientKit(root, ["deals", "leads", "lifecycle"])].map(([p, b]) => [p, decode(b)]),
  );
  // A block, so cos add and cos diff have one to work on in every fixture release.
  files["blocks/greeting/block.json"] = JSON.stringify({
    name: "greeting",
    pack: null,
    skin: "web",
    operations: ["me.get"],
    files: ["greeting.tsx"],
    dependsOn: [],
  });
  files["blocks/greeting/greeting.tsx"] =
    "export function Greeting({ name }: { name: string }) {\n  return <p>Hello, {name}</p>;\n}\n";
  change(files);
  return files;
}

let world: World;
let cwd = "";
const cos = (...argv: string[]) => runIn(world, ...argv, ...(cwd ? ["--dir", cwd] : []));

beforeEach(async () => {
  world = await startWorld();
  cwd = "";
});
afterEach(() => world.server.close());

async function publish(version: string, change?: (files: Record<string, string>) => void) {
  await world.github.publish(await buildFixtureRelease({ version, client: kit(change) }));
}

/** A created repo with a stand-in build of its web app (vite is not run in these tests). */
async function created(): Promise<string> {
  const dir = join(scratch(), "shop");
  const made = await runIn(world, "create", dir, "--label", "Shop", "--version", "1.0.0");
  expect(made.code, made.output).toBe(0);
  const server = join(dir, "apps", "web", "dist", "server");
  mkdirSync(join(dir, "apps", "web", "dist", "client"), { recursive: true });
  mkdirSync(server, { recursive: true });
  writeFileSync(join(server, "index.js"), "export default { fetch: () => new Response('shop') };");
  writeFileSync(
    join(server, "wrangler.json"),
    JSON.stringify({
      name: "shop-web",
      main: "index.js",
      compatibility_date: "2026-10-01",
      services: [{ binding: "HOST", service: "demo-app", entrypoint: "ClientApp" }],
      assets: { directory: "../client" },
    }),
  );
  writeFileSync(join(dir, "apps", "web", "dist", "client", "favicon.svg"), "<svg/>");
  cwd = dir;
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const mutating = () => world.cf.calls.filter((c) => c.method !== "GET");

describe("cos create", () => {
  it("writes a client repo from the release's template, named for it", async () => {
    await publish("1.0.0");
    const dir = await created();
    expect(read(dir, "product.ts")).toContain('platform: { version: "1.0.0", release: "demo"');
    expect(read(dir, "product.ts")).toContain('id: "shop"');
    const web = JSON.parse(read(dir, "apps/web/package.json"));
    expect(web.name).toBe("shop-web");
    expect(web.dependencies["@composable-os/client"]).toBe("1.0.0");
    const wrangler = read(dir, "apps/web/wrangler.jsonc");
    expect(wrangler).toContain('"name": "shop-web"');
    expect(wrangler).toContain('"service": "demo-app", "entrypoint": "ClientApp"');
    expect(wrangler).not.toMatch(/d1_databases|r2_buckets|kv_namespaces/);
    expect(read(dir, ".gitignore")).toContain("node_modules");
    expect(existsSync(join(dir, "skills", "start-client-app", "SKILL.md"))).toBe(true);
    // The typed client is generated for this product: no pack is on, so no pack's tools.
    const client = read(dir, "apps/web/src/client/customer.ts");
    expect(client).toContain('"me.get"');
    expect(client).not.toContain("x.deals.");
    expect(read(dir, "AGENTS.md")).toContain("Never open a database");
  });

  it("says the edge rule is a step to do before opening to the public", async () => {
    await publish("1.0.0");
    const made = await runIn(world, "create", join(scratch(), "two"));
    expect(made.output).toContain("rate limiting rule");
  });

  it("refuses a folder that is not empty", async () => {
    await publish("1.0.0");
    const dir = scratch();
    writeFileSync(join(dir, "x"), "");
    expect((await runIn(world, "create", dir)).code).toBe(1);
  });
});

describe("cos deploy", () => {
  it("deploys the host from the release and the web app bound to it (criteria 1 and 7)", async () => {
    await publish("1.0.0");
    await created();
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    for (const worker of ["demo-app", "demo-runner", "shop-web"]) {
      expect(world.cf.scripts.has(worker), worker).toBe(true);
    }
    // One binding, to the host's ClientApp entrypoint, and nothing else.
    expect(world.cf.liveBinding("shop-web", "HOST")).toEqual({
      type: "service",
      name: "HOST",
      service: "demo-app",
      entrypoint: "ClientApp",
    });
    // No pack listed: the runner is told to install none (base records only).
    expect(world.cf.liveBinding("demo-runner", "COS_PACKS")?.text).toBe("");
    expect(deployed.output).toContain("Web app: https://shop-web.acme.workers.dev");
  });

  it("refuses a web app with a database of its own (criterion 3)", async () => {
    await publish("1.0.0");
    const dir = await created();
    const config = join(dir, "apps", "web", "dist", "server", "wrangler.json");
    const built = JSON.parse(readFileSync(config, "utf8"));
    writeFileSync(config, JSON.stringify({ ...built, d1_databases: [{ binding: "DB" }] }));
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("never opens a database");
    expect(world.cf.scripts.has("shop-web")).toBe(false);
  });

  it("installs the org's own extension, pinned in BLOBS (criterion 8)", async () => {
    await publish("1.0.0");
    const dir = await created();
    cpSync(join(root, "packs", "lifecycle"), join(dir, "extensions", "lifecycle"), {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code, deployed.output).toBe(0);
    const hash = world.cf.liveBinding("demo-runner", "COS_ORG_EXTENSIONS")?.text ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = world.cf.r2Objects.get(`demo-blobs/org-extensions/${hash}.json`);
    const parsed = JSON.parse(decode(stored ?? new Uint8Array()));
    expect(parsed.extensions.map((e: { id: string }) => e.id)).toEqual(["lifecycle"]);
    expect(Object.keys(parsed.extensions[0].files)).toContain("index.ts");
  });

  it("stops before anything changes when an extension fails cos ext check (criterion 8)", async () => {
    await publish("1.0.0");
    const dir = await created();
    mkdirSync(join(dir, "extensions", "broken"), { recursive: true });
    writeFileSync(
      join(dir, "extensions", "broken", "index.ts"),
      'import { defineExtension } from "@composable-os/sdk";\nexport default defineExtension({ id: "Broken!", version: "1", objects: {} } as never);\n',
    );
    world.cf.calls.length = 0;
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("nothing was deployed");
    expect(world.cf.calls).toEqual([]);
  });

  it("refuses a pack the release does not have", async () => {
    await publish("1.0.0", (files) => {
      files["packs.json"] = '["deals"]\n';
    });
    const dir = await created();
    writeFileSync(
      join(dir, "product.ts"),
      read(dir, "product.ts").replace("packs: [],", 'packs: ["tickets"],'),
    );
    const deployed = await cos("deploy", "--skip-build", "--no-typecheck");
    expect(deployed.code).toBe(1);
    expect(deployed.output).toContain("has no pack tickets");
    expect(mutating()).toEqual([]);
  });
});

/** A web app whose code calls me.get, with a tsconfig that resolves the runtime from source. */
function compilingApp(dir: string) {
  writeFileSync(
    join(dir, "apps", "web", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        lib: ["ES2023"],
        types: [],
        paths: { "@composable-os/client": [join(root, "packages", "client", "src", "index.ts")] },
      },
      include: ["src/account.ts"],
    }),
  );
  writeFileSync(
    join(dir, "apps", "web", "src", "account.ts"),
    'import { createCustomerClient } from "./client/customer.ts";\n' +
      'export const me = (fetch: Parameters<typeof createCustomerClient>[0]["fetch"]) =>\n' +
      '  createCustomerClient({ baseUrl: "https://host", ...(fetch ? { fetch } : {}) }).call("me.get", {});\n',
  );
}

describe("cos upgrade in a client repo (criterion 11)", () => {
  it("reports the type error a changed operation makes, and deploys nothing", async () => {
    await publish("1.0.0");
    // 1.1.0's me.get takes a required input.
    await publish("1.1.0", (files) => {
      const contract = JSON.parse(files["contract/customer.json"] as string);
      const me = contract.operations.find((op: { name: string }) => op.name === "me.get");
      me.input = {
        type: "object",
        properties: { include: { type: "string" } },
        required: ["include"],
      };
      files["contract/customer.json"] = JSON.stringify(contract);
    });
    const dir = await created();
    compilingApp(dir);
    world.cf.calls.length = 0;
    const upgraded = await cos("upgrade", "--version", "1.1.0");
    expect(upgraded.code).toBe(1);
    expect(upgraded.output).toMatch(/apps\/web\/src\/account\.ts:3: .*include/);
    expect(upgraded.output).toContain("Nothing was deployed.");
    expect(world.cf.calls).toEqual([]);
    expect(read(dir, "product.ts")).toContain('version: "1.1.0"');
  });

  it("moves product.ts, regenerates the client and replaces skills when the apps compile", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["skills/start-client-app/SKILL.md"] = "# start-client-app, as of 1.1.0\n";
    });
    const dir = await created();
    compilingApp(dir);
    const upgraded = await cos("upgrade");
    expect(upgraded.code, upgraded.output).toBe(0);
    expect(read(dir, "product.ts")).toContain('version: "1.1.0"');
    expect(read(dir, "skills/start-client-app/SKILL.md")).toContain("as of 1.1.0");
    expect(upgraded.output).toContain("Nothing is deployed yet");
  });
});

describe("blocks (criterion 10)", () => {
  it("cos add copies from the matching release; cos diff shows upstream changes and keeps edits", async () => {
    await publish("1.0.0");
    await publish("1.1.0", (files) => {
      files["blocks/greeting/greeting.tsx"] =
        'export function Greeting({ name }: { name: string }) {\n  return <p className="greeting">Hello, {name}!</p>;\n}\n';
    });
    const dir = await created();
    const added = await cos("add", "greeting");
    expect(added.code, added.output).toBe(0);
    const file = join(dir, "apps", "web", "src", "blocks", "greeting", "greeting.tsx");
    expect(readFileSync(file, "utf8")).toContain("<p>Hello, {name}</p>");
    const lock = JSON.parse(read(dir, "blocks.lock.json"));
    expect(lock.greeting).toMatchObject({ version: "1.0.0", app: "apps/web" });

    // The client restyles its copy.
    const edited = readFileSync(file, "utf8").replace("<p>", '<p style={{ color: "teal" }}>');
    writeFileSync(file, edited);
    const diff = await cos("diff", "greeting", "--version", "1.1.0");
    expect(diff.code, diff.output).toBe(0);
    expect(diff.output).toContain("greeting.tsx: edited here since it was copied");
    expect(diff.output).toContain('+   return <p className="greeting">Hello, {name}!</p>;');
    expect(diff.output).toContain("-   return <p>Hello, {name}</p>;");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect((await cos("diff", "greeting")).output).toContain("No upstream change");
  });

  it("refuses a block of a pack the product does not list", async () => {
    await publish("1.0.0", (files) => {
      files["blocks/deal-card/block.json"] = JSON.stringify({
        name: "deal-card",
        pack: "deals",
        skin: "web",
        operations: [],
        files: [],
        dependsOn: [],
      });
    });
    await created();
    const added = await cos("add", "deal-card");
    expect(added.code).toBe(1);
    expect(added.output).toContain("the deals pack, which product.ts does not list");
  });
});

describe("cos init in a repo shaped like the first client's (criterion 2)", () => {
  function fixture(): string {
    const dir = join(scratch(), "movement");
    cpSync(join(here, "fixtures", "adopt"), dir, { recursive: true });
    return dir;
  }
  const snapshot = (dir: string, paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, read(dir, p)]));
  const existing = [
    "package.json",
    "wrangler.jsonc",
    "AGENTS.md",
    "src/pages/index.astro",
    "src/lib/account.ts",
    "mobile/package.json",
    "mobile/app.json",
    "mobile/src/account.ts",
  ];

  function compiles(dir: string, files: string[]): string[] {
    const program = ts.createProgram(
      files.map((f) => join(dir, f)),
      {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        lib: ["lib.es2023.d.ts"],
        types: [],
        paths: { "@composable-os/client": [join(root, "packages", "client", "src", "index.ts")] },
      },
    );
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }

  it("adds its files, changes no existing file without showing the diff, then applies with --yes", async () => {
    await publish("1.0.0");
    const dir = fixture();
    const before = snapshot(dir, existing);
    expect(compiles(dir, ["src/lib/account.ts", "mobile/src/account.ts"]).join("\n")).toMatch(
      /composable-os\/customer/,
    );
    cwd = dir;
    const first = await cos("init", "--web", ".", "--mobile", "mobile");
    expect(first.code, first.output).toBe(0);
    // Nothing that existed changed: every change is shown instead.
    expect(snapshot(dir, existing)).toEqual(before);
    for (const path of ["package.json", "AGENTS.md", "wrangler.jsonc", "mobile/package.json"]) {
      expect(first.output).toContain(`--- ${path}`);
    }
    expect(first.output).toContain(
      '+   "services": [{ "binding": "HOST", "service": "demo-app", "entrypoint": "ClientApp" }]',
    );
    expect(first.output).toContain("Not changed.");
    // Only its own files are new.
    for (const path of [
      "product.ts",
      "skills/start-client-app/SKILL.md",
      "src/composable-os/customer.ts",
      "mobile/src/composable-os/customer.ts",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    // Both apps' calls now compile against their typed client.
    expect(compiles(dir, ["src/lib/account.ts", "mobile/src/account.ts"])).toEqual([]);

    // Told to, it applies exactly the diffs it showed; the site keeps its own D1.
    rmSync(join(dir, "product.ts"));
    const second = await cos("init", "--web", ".", "--mobile", "mobile", "--yes");
    expect(second.code, second.output).toBe(0);
    expect(read(dir, "wrangler.jsonc")).toContain('"database_name": "movement"');
    expect(read(dir, "wrangler.jsonc")).toContain('"entrypoint": "ClientApp"');
    expect(read(dir, "AGENTS.md").startsWith(before["AGENTS.md"] as string)).toBe(true);
    expect(read(dir, "AGENTS.md")).toContain("Never open a database");
    expect(JSON.parse(read(dir, "package.json")).dependencies).toEqual(
      JSON.parse(before["package.json"] as string).dependencies,
    );
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@composable-os/cli"]).toBe(
      "1.0.0",
    );
    expect(JSON.parse(read(dir, "mobile/package.json")).dependencies["@composable-os/client"]).toBe(
      "1.0.0",
    );
    expect(read(dir, "src/pages/index.astro")).toBe(before["src/pages/index.astro"]);
  });

  it("the adopted apps call me.get, typed: the Worker over its binding, the Expo app over HTTPS", async () => {
    await publish("1.0.0");
    const dir = fixture();
    cwd = dir;
    expect((await cos("init", "--web", ".", "--mobile", "mobile", "--yes")).code).toBe(0);
    const { build } = await import("esbuild");
    const run = async (entry: string) => {
      const out = join(dir, `${entry.replace(/\W/g, "_")}.mjs`);
      await build({
        entryPoints: [join(dir, entry)],
        outfile: out,
        bundle: true,
        format: "esm",
        platform: "neutral",
        logLevel: "error",
        alias: { "@composable-os/client": join(root, "packages", "client", "src", "index.ts") },
      });
      return import(out);
    };
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const host = {
      fetch: async (url: string, init?: { headers: Record<string, string> }) => {
        sent.push({ url, headers: init?.headers ?? {} });
        return new Response(JSON.stringify({ data: { displayName: "Ada Lovelace" } }), {
          status: 200,
        });
      },
    };
    const site = await run("src/lib/account.ts");
    expect(await site.displayName(host, "theme=dark; cos-customer.session_token=abc.sig")).toBe(
      "Ada Lovelace",
    );
    expect(sent[0]).toMatchObject({
      url: "https://host/api/v1/op/me.get",
      headers: { cookie: "cos-customer.session_token=abc.sig" },
    });
    const mobile = await run("mobile/src/account.ts");
    expect(
      await mobile.displayName("https://admin.movement.example", "cos_at_token", host.fetch),
    ).toBe("Ada Lovelace");
    expect(sent[1]).toMatchObject({
      url: "https://admin.movement.example/api/v1/op/me.get",
      headers: { authorization: "Bearer cos_at_token" },
    });
  });
});
