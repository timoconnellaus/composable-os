// The browser-only build (stage 75 step 2, ADR 0960): `pnpm build:browser` makes the same screens
// as static files in dist/browser/ (an index.html and hashed assets) with no server code in them:
// no server function, no HOST binding, no cookie. They call the host's /api/v1 with tokens and
// route by the address's hash. `vite build` (vite.config.ts) stays the server build, and the
// default deploy.
//
//   COS_HOST_URL=https://admin.example.com pnpm build:browser
//
// COS_HOST_URL is the host's address the screens call, and is required: the screens are never
// served from the host's own (staff) address, so there is no "this page's origin" to fall back to
// (issue #540). Once the build has written every file, and only then, dist/browser/build.json
// lists the entry, every file this build wrote with its SHA-256 and size, the API contract
// version the screens were built against (src/client/customer.ts) and the host address.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";

/**
 * The API contract version the generated client was made for: its `API_VERSION` line, read as
 * text (the config does not load the client, whose package is TypeScript source here).
 */
export function contractVersion(generated: string): string {
  const found = /^export const API_VERSION = "(v\d+)";$/m.exec(generated)?.[1];
  if (!found) throw new Error("src/client/customer.ts has no API_VERSION: run cos client generate");
  return found;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * COS_HOST_URL as the build takes it: an origin and nothing more (no path, no user, no query),
 * https, or http on this machine only (local development and the e2e suite). Anything else, or
 * nothing, stops the build with what to set.
 */
export function hostUrlOf(value: string | undefined): string {
  const given = (value ?? "").trim().replace(/\/+$/, "");
  const want = "Set COS_HOST_URL to the host's address, like https://admin.example.com";
  if (!given) throw new Error(`The browser build needs the host's address. ${want}.`);
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`COS_HOST_URL is not an address: ${given}. ${want}.`);
  }
  const local = url.protocol === "http:" && LOCAL.has(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.origin !== given) {
    throw new Error(
      `COS_HOST_URL must be an https origin with no path, user or query (http on localhost only): ${given}. ${want}.`,
    );
  }
  return url.origin;
}

/** What can never be in the browser build: the server's modules and the deploy tools. */
export const SERVER_ONLY = [
  /^cloudflare:/,
  /^@tanstack\/react-start(\/|$)/,
  /^@tanstack\/start-/,
  /^@cloudflare\//,
  /^wrangler(\/|$)/,
  /^node:/,
];

/** Stops the build at the first import of server-only code, naming the file that imports it. */
export function refuseServerModules(): Plugin {
  return {
    name: "cos-refuse-server-modules",
    enforce: "pre",
    resolveId(id, importer) {
      if (SERVER_ONLY.some((pattern) => pattern.test(id))) {
        this.error(
          `${id} (imported by ${importer ?? "?"}) is server code: the browser build has no server. Reach the host through the ScreenHost (src/screen-host/).`,
        );
      }
      return null;
    },
  };
}

/** One output file as the build summary lists it. */
export interface BuiltFile {
  path: string;
  sha256: string;
  size: number;
}

/** What `build.json` says (stage 75 step 3's manifest is made from it). */
export interface BuildSummary {
  format: 1;
  build: "browser";
  entry: string;
  /** The API contract version the generated client was made for (`cos client generate`). */
  apiVersion: string;
  /** The host the screens call: the COS_HOST_URL these files were built with. */
  hostUrl: string;
  files: BuiltFile[];
}

export const SUMMARY_FILE = "build.json";

/**
 * Writes build.json after the build has written its files, from what this build wrote (never
 * what an earlier one left), each file's hash from its bytes on disk. A build that fails writes
 * none, and the summary an earlier build left is removed when a build starts, so a folder whose
 * build failed has no summary to be taken for it.
 */
function buildSummary(hostUrl: string): Plugin {
  let outDir = "";
  return {
    name: "cos-build-summary",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      rmSync(join(outDir, SUMMARY_FILE), { force: true });
    },
    writeBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .sort()
        .map((path) => {
          const bytes = readFileSync(join(outDir, path));
          return {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          };
        });
      if (!files.some((file) => file.path === "index.html")) {
        this.error("The browser build wrote no index.html");
      }
      const summary: BuildSummary = {
        format: 1,
        build: "browser",
        entry: "index.html",
        apiVersion: contractVersion(readFileSync(fileURLToDir("./src/client/customer.ts"), "utf8")),
        hostUrl,
        files,
      };
      writeFileSync(join(outDir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    },
  };
}

export default defineConfig((): UserConfig => {
  const hostUrl = hostUrlOf(process.env.COS_HOST_URL);
  return {
    root: fileURLToDir("./src/browser"),
    // Relative: the same files work from any folder (a version's own path, the desktop app's).
    base: "./",
    publicDir: false,
    define: {
      __COS_BROWSER_BUILD__: "true",
      __COS_HOST_URL__: JSON.stringify(hostUrl),
    },
    plugins: [refuseServerModules(), tailwindcss(), viteReact(), buildSummary(hostUrl)],
    build: {
      outDir: fileURLToDir("./dist/browser"),
      // Every build into a folder of its own: what an earlier build wrote is removed first.
      emptyOutDir: true,
      // No source maps: a version holds what the browser runs, nothing more.
      sourcemap: false,
    },
  };
});

function fileURLToDir(path: string): string {
  return resolve(import.meta.dirname, path);
}
