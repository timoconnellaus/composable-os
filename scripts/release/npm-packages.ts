#!/usr/bin/env node
// The npm packages a client repo installs (stage 24, ADR 0423), built from the release commit:
//
//   @composable-os/client, @composable-os/sdk, @composable-os/product   compiled to dist/ (JS and
//                                        .d.ts; the SDK keeps src/ too, which `cos ext check`
//                                        type-checks extensions against)
//   @composable-os/pack-<id>             each pack: its extension and client/ hooks, compiled
//   @composable-os/cli                   the `cos` command, bundled (packages/create-composable-os)
//   create-composable-os                 `npm create composable-os`: a bin that runs `cos create`
//
// Usage: node scripts/release/npm-packages.ts --version 1.2.3 --out npm-out
//
// Writes <out>/<name>/ (the package as published) and <out>/<file>.tgz (npm pack of it). It never
// publishes: the release workflow runs `npm publish --dry-run` on each tarball, and publishes them
// only when publishing is turned on (docs/deploying.md, "Publishing to npm").
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY = "https://github.com/timoconnellaus/composable-os";

interface Compiled {
  kind: "compiled";
  dir: string;
  /** Source files compiled (relative to dir); tests and configs are never included. */
  sources: string[];
  /** Keep the TypeScript sources in the package as well (the SDK). */
  keepSource?: boolean;
}
interface Bundled {
  kind: "bundled";
  dir: string;
}
type Spec = Compiled | Bundled | { kind: "create" };

const packs = readdirSync(join(ROOT, "packs")).filter((id) =>
  existsSync(join(ROOT, "packs", id, "package.json")),
);

export const PACKAGES: Record<string, Spec> = {
  "@composable-os/client": { kind: "compiled", dir: "packages/client", sources: ["src"] },
  "@composable-os/sdk": {
    kind: "compiled",
    dir: "packages/sdk",
    sources: ["src"],
    keepSource: true,
  },
  "@composable-os/product": { kind: "compiled", dir: "packages/product", sources: ["src"] },
  ...Object.fromEntries(
    packs.map((id) => [
      `@composable-os/pack-${id}`,
      { kind: "compiled", dir: `packs/${id}`, sources: ["."] } satisfies Compiled,
    ]),
  ),
  "@composable-os/cli": { kind: "bundled", dir: "packages/create-composable-os" },
  "create-composable-os": { kind: "create" },
};

const isSource = (path: string) =>
  /\.(ts|tsx)$/.test(path) &&
  !/\.(test|config)\.ts$/.test(path) &&
  !/(^|\/)(test|tests)\//.test(path);

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".turbo", "test", "tests"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
}

/** `./src/index.ts` → `./dist/index.js` (and the `.d.ts` beside it). */
function distPath(path: string, sources: string[]): { js: string; dts: string } {
  const root = sources[0] === "." ? "" : `${sources[0]}/`;
  const rel = path
    .replace(/^\.\//, "")
    .replace(root, "")
    .replace(/\.tsx?$/, "");
  return { js: `./dist/${rel}.js`, dts: `./dist/${rel}.d.ts` };
}

function pinned(deps: Record<string, string> | undefined, version: string) {
  if (!deps) return undefined;
  return Object.fromEntries(
    Object.entries(deps).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? version : range,
    ]),
  );
}

function compile(spec: Compiled, out: string) {
  const dir = join(ROOT, spec.dir);
  const files = spec.sources.flatMap((s) =>
    walk(join(dir, s))
      .map((f) => (s === "." ? f : `${s}/${f}`))
      .filter(isSource),
  );
  const rootDir = spec.sources[0] === "." ? "." : spec.sources[0];
  const config = join(dir, "tsconfig.npm.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        lib: ["ES2023", "DOM"],
        types: [],
        declaration: true,
        noCheck: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        verbatimModuleSyntax: true,
        rootDir,
        outDir: join(out, "dist"),
      },
      files,
    }),
  );
  try {
    execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", config], {
      cwd: dir,
      stdio: "inherit",
    });
  } finally {
    rmSync(config, { force: true });
  }
  if (spec.keepSource) {
    for (const f of files) {
      mkdirSync(dirname(join(out, f)), { recursive: true });
      cpSync(join(dir, f), join(out, f));
    }
  }
}

function packageJson(name: string, spec: Spec, version: string): Record<string, unknown> {
  const common = {
    name,
    version,
    license: "FSL-1.1-ALv2",
    type: "module",
    repository: { type: "git", url: `git+${REPOSITORY}.git` },
    homepage: "https://composableos.dev",
    publishConfig: { access: "public", provenance: true },
  };
  if (spec.kind === "create") {
    return {
      ...common,
      description:
        "npm create composable-os <dir>: a new client repo for a Composable OS product (cos create).",
      bin: { "create-composable-os": "./create.js" },
      files: ["create.js"],
      dependencies: { "@composable-os/cli": version },
    };
  }
  const source = JSON.parse(readFileSync(join(ROOT, spec.dir, "package.json"), "utf8"));
  if (spec.kind === "bundled") {
    return {
      ...common,
      description:
        "cos: the Composable OS command. Create, adopt, deploy and upgrade a client repo; install a product into your own Cloudflare account from a verified release.",
      bin: { cos: "./dist/cli.js" },
      exports: { "./create": "./dist/create.js" },
      files: ["dist", "README.md"],
      engines: source.engines,
      // What `cos ext`, `cos client generate` and `cos upgrade` load at run time.
      dependencies: {
        esbuild: source.devDependencies.esbuild,
        typescript: source.devDependencies.typescript,
        "@composable-os/sdk": version,
      },
    };
  }
  const exports: Record<string, { types: string; default: string }> = {};
  for (const [key, path] of Object.entries(source.exports as Record<string, string>)) {
    const { js, dts } = distPath(path, spec.sources);
    exports[key] = { types: dts, default: js };
  }
  return {
    ...common,
    description: source.description,
    exports,
    files: spec.keepSource ? ["dist", "src"] : ["dist"],
    ...(source.composableOs ? { composableOs: source.composableOs } : {}),
    dependencies: pinned(source.dependencies, version),
  };
}

export function buildNpmPackages(version: string, outDir: string): string[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The CLI is bundled by its own build, with the platform's SDK source and migrations inside.
  execFileSync("node", ["build.mjs"], {
    cwd: join(ROOT, "packages", "create-composable-os"),
    stdio: "inherit",
  });
  const tarballs: string[] = [];
  for (const [name, spec] of Object.entries(PACKAGES)) {
    const out = join(outDir, name.replace("/", "__"));
    mkdirSync(out, { recursive: true });
    if (spec.kind === "compiled") compile(spec, out);
    if (spec.kind === "bundled") {
      cpSync(join(ROOT, spec.dir, "dist"), join(out, "dist"), { recursive: true });
      cpSync(join(ROOT, spec.dir, "README.md"), join(out, "README.md"));
    }
    if (spec.kind === "create") {
      writeFileSync(
        join(out, "create.js"),
        '#!/usr/bin/env node\n// npm create composable-os <dir>: `cos create <dir>` (stage 24).\nimport "@composable-os/cli/create";\n',
        { mode: 0o755 },
      );
    }
    cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
    writeFileSync(
      join(out, "package.json"),
      `${JSON.stringify(packageJson(name, spec, version), null, 2)}\n`,
    );
    const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
      cwd: out,
      encoding: "utf8",
    });
    tarballs.push(join(outDir, (JSON.parse(packed) as { filename: string }[])[0]?.filename ?? ""));
  }
  return tarballs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const version = args[args.indexOf("--version") + 1];
  const out = resolve(args[args.indexOf("--out") + 1] ?? "npm-out");
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error("Usage: node scripts/release/npm-packages.ts --version x.y.z --out <dir>");
    process.exit(2);
  }
  const tarballs = buildNpmPackages(version, out);
  writeFileSync(
    join(out, "tarballs.json"),
    `${JSON.stringify(
      tarballs.map((t) => relative(out, t)),
      null,
      2,
    )}\n`,
  );
  console.log(
    `npm packages ${version}:\n${tarballs.map((t) => `  ${relative(process.cwd(), t)}`).join("\n")}`,
  );
}
