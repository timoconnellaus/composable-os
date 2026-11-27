#!/usr/bin/env node
// Acceptance criterion 9 of stage 24 (ADR 0423): the npm packages built from the release commit
// are enough to make and build a client repo, in a fresh folder with no access to this
// repository. It installs the CLI from its tarball, runs `cos create` against the release built
// in the same run (`--bundle-dir`), installs the new repo with every @composable-os package taken
// from the tarballs, then type-checks it and builds its web app.
//
// Usage: node scripts/release/check-npm-packages.ts --npm npm-out --bundle-dir release-out
//          --version 1.2.3 [--release crm] [--keep]
//
// Third-party packages (React, TanStack, Vite, wrangler) come from the npm registry; nothing comes
// from this checkout.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PRODUCT } from "@composable-os/products";

function arg(name: string, fallback?: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  const value = at >= 0 ? args[at + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const npmDir = resolve(arg("npm"));
const bundleDir = resolve(arg("bundle-dir"));
const version = arg("version");
const release = arg("release", DEFAULT_PRODUCT);
const keep = process.argv.includes("--keep");

const tarballs = JSON.parse(readFileSync(join(npmDir, "tarballs.json"), "utf8")) as string[];
/** Package name → `file:` tarball, read from each tarball's own package.json. */
const overrides: Record<string, string> = {};
for (const file of tarballs) {
  const listing = execFileSync("tar", ["-xOzf", join(npmDir, file), "package/package.json"], {
    encoding: "utf8",
  });
  overrides[(JSON.parse(listing) as { name: string }).name] = `file:${join(npmDir, file)}`;
}

const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}   (in ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true", ...env } });
};

const work = mkdtempSync(join(tmpdir(), "cos-npm-check-"));
try {
  // 1. The CLI, from its tarball alone.
  const tool = join(work, "tool");
  mkdirSync(tool, { recursive: true });
  writeFileSync(
    join(tool, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@composable-os/cli": overrides["@composable-os/cli"] },
      overrides,
    }),
  );
  run("npm", ["install", "--no-audit", "--no-fund"], tool);

  // 2. A new client repo from the release, as `npm create composable-os` makes it.
  run(
    "node",
    [
      join(tool, "node_modules", "@composable-os", "cli", "dist", "cli.js"),
      "create",
      "shop",
      "--release",
      release,
      "--version",
      version,
      "--bundle-dir",
      bundleDir,
      "--unverified",
      "--with-mobile",
      "--yes",
    ],
    work,
  );

  // 3. Installed with the platform's packages from the tarballs, then checked and built.
  const shop = join(work, "shop");
  const pkg = JSON.parse(readFileSync(join(shop, "package.json"), "utf8"));
  pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides };
  writeFileSync(join(shop, "package.json"), JSON.stringify(pkg, null, 2));
  // An org extension (the lifecycle pack's source, as test data), checked by the installed `cos`
  // with the SDK source and migrations it carries.
  mkdirSync(join(shop, "extensions", "lifecycle"), { recursive: true });
  writeFileSync(
    join(shop, "extensions", "lifecycle", "index.ts"),
    readFileSync(join(import.meta.dirname, "..", "..", "packs", "lifecycle", "index.ts"), "utf8"),
  );
  writeFileSync(
    join(shop, "extensions", "lifecycle", "package.json"),
    JSON.stringify({ name: "lifecycle", version: "0.1.0", private: true, type: "module" }),
  );
  run("pnpm", ["install", "--no-frozen-lockfile"], shop);
  run("pnpm", ["cos", "ext", "check", "extensions/lifecycle"], shop);
  run("pnpm", ["--dir", "apps/web", "typecheck"], shop);
  run("pnpm", ["--dir", "apps/mobile", "typecheck"], shop);
  run("pnpm", ["--dir", "apps/web", "build"], shop);
  // The same screens as static files (stage 75 step 2): no server code, checked by its tests.
  // It requires the host's address: an example one, as nothing here is deployed.
  run("pnpm", ["--dir", "apps/web", "build:browser"], shop, {
    COS_HOST_URL: "https://admin.example.com",
  });
  run("pnpm", ["--dir", "apps/web", "test"], shop);
  console.log(
    `\nnpm packages ${version}: a fresh client repo installs them, type-checks and builds.`,
  );
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
