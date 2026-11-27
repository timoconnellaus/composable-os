// The browser-only build (stage 75 step 2, ADR 0960): `pnpm build:browser` makes the same screens
// as static files in dist/browser/ (an index.html and hashed assets) with no server code in them:
// no server function, no HOST binding, no cookie. They call the host's /api/v1 with tokens and
// route by the address's hash. `vite build` (vite.config.ts) stays the server build, and the
// default deploy.
//
//   COS_HOST_URL=https://admin.example.com pnpm build:browser
//
// COS_HOST_URL is the host's address the screens call; left out, the page's own origin. Beside
// the files, dist/browser/build.json lists the entry, every file with its SHA-256 and size, and
// the API contract version the screens were built against (src/client/customer.ts).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The API contract version the generated client was made for: its `API_VERSION` line, read as
 * text (the config does not load the client, whose package is TypeScript source here).
 */
export function contractVersion(generated: string): string {
  const found = /^export const API_VERSION = "(v\d+)";$/m.exec(generated)?.[1];
  if (!found) throw new Error("src/client/customer.ts has no API_VERSION: run cos client generate");
  return found;
}

/** What can never be in the browser build: the server's modules. */
const SERVER_ONLY = [/^cloudflare:/, /^@tanstack\/react-start(\/|$)/, /^node:/];

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
  /** The host the screens call; "" for the page's own origin. */
  hostUrl: string;
  files: BuiltFile[];
}

export const SUMMARY_FILE = "build.json";

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

/** Writes build.json once every file is written: each file's hash, from the bytes on disk. */
function buildSummary(hostUrl: string): Plugin {
  let outDir = "";
  return {
    name: "cos-build-summary",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = filesIn(outDir)
        .map((path) => relative(outDir, path).split(sep).join("/"))
        .filter((path) => path !== SUMMARY_FILE)
        .sort()
        .map((path) => {
          const bytes = readFileSync(join(outDir, path));
          return {
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
          };
        });
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

const hostUrl = (process.env.COS_HOST_URL ?? "").replace(/\/+$/, "");
if (hostUrl && !/^https?:\/\/[^/]+$/.test(hostUrl)) {
  throw new Error(`COS_HOST_URL must be an origin, like https://admin.example.com: ${hostUrl}`);
}

export default defineConfig({
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
    emptyOutDir: true,
    // No source maps: a version holds what the browser runs, nothing more.
    sourcemap: false,
  },
});

function fileURLToDir(path: string): string {
  return resolve(import.meta.dirname, path);
}
