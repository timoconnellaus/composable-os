// Stage 75 step 2, acceptance criterion 1 (ADR 0960): the screens build as static files with no
// server code in them. The browser build is made here, as `pnpm build:browser` makes it, and
// read back: no server function, no HOST binding, no cookie-reading code, and a build.json that
// lists every file it wrote. The server build is made too, to show the check finds what it looks
// for: the same screens built for the Worker hold a server function and the cookie routes.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { build, createBuilder } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BuildSummary,
  contractVersion,
  hostUrlOf,
  SUMMARY_FILE,
} from "../vite.browser.config.ts";
import { SERVER_MARKS, serverCodeIn } from "./server-code.ts";

const app = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "cos-browser-build-"));
const HOST_URL = "https://admin.example.com";

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

const scripts = (dir: string) =>
  filesIn(dir)
    .filter((file) => /\.(m?js|html)$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

/**
 * A build with the real config (vite.browser.config.ts, its plugins and its checks), of the
 * app's screens or of another root's, with COS_HOST_URL set to `host` (null: not set at all).
 */
async function realBuild(root: string, outDir: string, host: string | null = HOST_URL) {
  const before = process.env.COS_HOST_URL;
  if (host === null) delete process.env.COS_HOST_URL;
  else process.env.COS_HOST_URL = host;
  try {
    await build({
      configFile: join(app, "vite.browser.config.ts"),
      logLevel: "silent",
      ...(root === app ? {} : { root }),
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (before === undefined) delete process.env.COS_HOST_URL;
    else process.env.COS_HOST_URL = before;
  }
}

beforeAll(() => realBuild(app, join(out, "browser")));

describe("the browser-only build", () => {
  it("is an index.html and hashed assets, and nothing that runs on a server", () => {
    const files = filesIn(join(out, "browser")).map((f) => relative(join(out, "browser"), f));
    expect(files).toContain("index.html");
    expect(files.filter((f) => f.startsWith("assets/")).length).toBeGreaterThan(0);
    for (const file of files.filter((f) => f.startsWith("assets/"))) {
      expect(file).toMatch(/^assets\/[\w-]+-[\w-]{8}\.(js|css)$/);
    }
    // No Worker, no server entry, no source map.
    expect(files.some((f) => /server|worker|\.map$/.test(f))).toBe(false);
    expect(serverCodeIn(scripts(join(out, "browser")))).toEqual([]);
  });

  it("calls the host it was built for, routes by hash and sends no cookie", () => {
    const code = scripts(join(out, "browser"));
    expect(code).toContain(HOST_URL);
    expect(code).toContain("/api/v1/");
    expect(code).toMatch(/credentials:\s*[`"']omit[`"']/);
    // The hash history: createHashHistory reads the address's fragment.
    expect(code).toMatch(/location\.hash|hashchange/);
  });

  it("writes build.json: the entry, each file's SHA-256 and size, and the contract version", () => {
    const dir = join(out, "browser");
    const summary = JSON.parse(readFileSync(join(dir, SUMMARY_FILE), "utf8")) as BuildSummary;
    expect(summary).toMatchObject({
      format: 1,
      build: "browser",
      entry: "index.html",
      apiVersion: contractVersion(readFileSync(join(app, "src/client/customer.ts"), "utf8")),
      hostUrl: HOST_URL,
    });
    const written = filesIn(dir)
      .map((f) => relative(dir, f).split(sep).join("/"))
      .filter((f) => f !== SUMMARY_FILE)
      .sort();
    expect(summary.files.map((f) => f.path)).toEqual(written);
    for (const file of summary.files) {
      const bytes = readFileSync(join(dir, file.path));
      expect(file.size).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("refuses, with the real config, a screen that imports server code, naming the file, and writes no build.json", async () => {
    for (const module of [
      "cloudflare:workers",
      "@tanstack/react-start/server",
      "@tanstack/start-server-core",
      "@cloudflare/vite-plugin",
      "wrangler",
      "node:fs",
    ]) {
      const root = mkdtempSync(join(tmpdir(), "cos-browser-refuse-"));
      writeFileSync(join(root, "index.html"), '<script type="module" src="./main.ts"></script>');
      writeFileSync(join(root, "main.ts"), `import * as x from "${module}";\nconsole.log(x);\n`);
      const fresh = join(root, "fresh");
      const reused = join(root, "reused");
      // A folder an earlier build wrote: its summary must not survive a build that fails.
      mkdirSync(join(reused, "assets"), { recursive: true });
      writeFileSync(join(reused, "assets", "old-00000000.js"), "old");
      writeFileSync(join(reused, SUMMARY_FILE), "{}");
      for (const outDir of [fresh, reused]) {
        const error = await realBuild(root, outDir).then(
          () => null,
          (e: unknown) => e,
        );
        expect(String(error), module).toMatch(
          new RegExp(
            `${module.replace(/[/.]/g, "\\$&")} \\(imported by .*main\\.ts\\) is server code`,
          ),
        );
        expect(existsSync(join(outDir, SUMMARY_FILE)), `${module} into ${outDir}`).toBe(false);
      }
    }
  });

  it("refuses to build without the host's address, or with one that is not a plain origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "cos-browser-host-"));
    for (const value of [null, "", "   "]) {
      await expect(realBuild(app, join(root, "out"), value)).rejects.toThrow(
        /needs the host's address\. Set COS_HOST_URL/,
      );
    }
    for (const value of [
      "admin.example.com",
      "http://admin.example.com",
      "https://admin.example.com/app",
      "https://user:pass@admin.example.com",
      "https://admin.example.com?x=1",
      "views://desktop",
    ]) {
      expect(() => hostUrlOf(value), value).toThrow(/COS_HOST_URL/);
    }
    expect(hostUrlOf("https://admin.example.com/")).toBe("https://admin.example.com");
    expect(hostUrlOf("http://localhost:5179")).toBe("http://localhost:5179");
    expect(existsSync(join(root, "out", SUMMARY_FILE))).toBe(false);
  });

  it("lists only what this build wrote, never a file an earlier build left", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "cos-browser-stale-")), "out");
    mkdirSync(join(outDir, "assets"), { recursive: true });
    writeFileSync(join(outDir, "assets", "stale-11111111.js"), "stale");
    await realBuild(app, outDir);
    const summary = JSON.parse(readFileSync(join(outDir, SUMMARY_FILE), "utf8")) as BuildSummary;
    expect(summary.files.map((f) => f.path)).not.toContain("assets/stale-11111111.js");
    expect(existsSync(join(outDir, "assets", "stale-11111111.js"))).toBe(false);
  });

  it("reads the contract version from the generated client, and refuses one without it", () => {
    expect(contractVersion('export const API_VERSION = "v3";\n')).toBe("v3");
    expect(() => contractVersion("export const operations = {};\n")).toThrow(/API_VERSION/);
  });
});

describe("the check for server code", () => {
  it("finds each kind of server code", () => {
    expect(serverCodeIn("fetch(`/_serverFn/`+e)")).toEqual(["a server function"]);
    expect(serverCodeIn("e.HOST.fetch(`https://host/api`)")).toEqual(["the HOST binding"]);
    expect(serverCodeIn('import{env}from"cloudflare:workers"')).toEqual(["the HOST binding"]);
    expect(serverCodeIn("document.cookie")).toEqual(["cookie-reading code"]);
    expect(serverCodeIn('t.headers.get("cookie")')).toEqual(["cookie-reading code"]);
    expect(serverCodeIn("r.headers.getSetCookie()")).toEqual(["cookie-reading code"]);
    expect(serverCodeIn('a("/auth/sign-in",{email:e})')).toEqual([
      "the server build's /auth routes",
    ]);
    // The token routes are the browser build's own, and are not the server build's.
    expect(serverCodeIn(`a(\`\${t}/api/v1/auth/customer/sign-in\`)`)).toEqual([]);
    expect(SERVER_MARKS).toHaveLength(4);
  });

  it("finds it in the same screens built for the Worker", async () => {
    const dir = join(out, "server");
    mkdirSync(dir, { recursive: true });
    // The server build writes the page's files and the Worker's: both are looked at.
    const builder = await createBuilder({
      configFile: join(app, "vite.config.ts"),
      root: app,
      logLevel: "silent",
      environments: {
        client: { build: { outDir: join(dir, "client") } },
        ssr: { build: { outDir: join(dir, "server") } },
      },
    });
    await builder.buildApp();
    const found = serverCodeIn(scripts(dir));
    expect(found).toContain("a server function");
    expect(found).toContain("the HOST binding");
    expect(found).toContain("cookie-reading code");
    expect(found).toContain("the server build's /auth routes");
  });
});
