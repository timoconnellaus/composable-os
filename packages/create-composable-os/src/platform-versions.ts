// The platform's npm packages in a client repo's package.json files (issue #177): `cos upgrade`
// moves every `@composable-os/*` dependency to the version it upgrades to, and type-checks the apps
// only once those versions are installed. A type check against the old installed packages would
// pass while copied blocks no longer compile against the new version.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ClientProductDefinition } from "@composable-os/product";

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const PLATFORM = /^@composable-os\//;

/** The package.json files of a client repo: the root's and each app's. */
export function packageFiles(root: string, product: ClientProductDefinition): string[] {
  const dirs = [".", product.web?.dir, product.mobile?.dir].filter((d): d is string => Boolean(d));
  return [...new Set(dirs.map((d) => join(root, d, "package.json")))].filter((p) => existsSync(p));
}

interface Found {
  file: string;
  name: string;
  spec: string;
}

/** Every `@composable-os/*` dependency the repo's package.json files name. */
export function platformDependencies(root: string, product: ClientProductDefinition): Found[] {
  const found: Found[] = [];
  for (const file of packageFiles(root, product)) {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const section of SECTIONS) {
      const deps = (pkg[section] ?? {}) as Record<string, string>;
      for (const [name, spec] of Object.entries(deps)) {
        if (PLATFORM.test(name)) found.push({ file, name, spec });
      }
    }
  }
  return found;
}

/**
 * The spec moved to `version`, keeping its range style (`^`, `~`, exact), or null when it is not
 * a version cos can safely rewrite: a tarball, a path, a workspace, git, a URL, an alias, a tag.
 */
export function movedSpec(spec: string, version: string): string | null {
  const match = /^([\^~]|>=|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim());
  if (!match) return null;
  return `${match[1] ?? ""}${version}`;
}

/**
 * Moves every `@composable-os/*` dependency to `version`, editing each file in place (its own
 * formatting kept). Says what moved, and what it left because it cannot safely rewrite it.
 */
export function movePlatformVersions(
  root: string,
  product: ClientProductDefinition,
  version: string,
): { moved: string[]; left: string[] } {
  const moved: string[] = [];
  const left: string[] = [];
  const byFile = new Map<string, Found[]>();
  for (const dep of platformDependencies(root, product)) {
    byFile.set(dep.file, [...(byFile.get(dep.file) ?? []), dep]);
  }
  for (const [file, deps] of byFile) {
    let text = readFileSync(file, "utf8");
    const where = relative(root, file) || "package.json";
    for (const dep of deps) {
      const next = movedSpec(dep.spec, version);
      if (next === null) {
        left.push(`${where}: ${dep.name} "${dep.spec}"`);
        continue;
      }
      if (next === dep.spec) continue;
      const pattern = new RegExp(
        `("${dep.name.replace(/[/.]/g, "\\$&")}"\\s*:\\s*")${dep.spec.replace(/[.^~*+?()[\]{}|\\$]/g, "\\$&")}(")`,
      );
      text = text.replace(pattern, `$1${next}$2`);
      moved.push(`${where}: ${dep.name} ${dep.spec} → ${next}`);
    }
    writeFileSync(file, text);
  }
  // Overrides (pnpm's, npm's, yarn's resolutions) often point at local tarballs: said, never moved.
  for (const file of packageFiles(root, product)) {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      pnpm?: { overrides?: Record<string, string> };
      overrides?: Record<string, unknown>;
      resolutions?: Record<string, unknown>;
    };
    const where = relative(root, file) || "package.json";
    for (const [key, map] of [
      ["pnpm.overrides", pkg.pnpm?.overrides],
      ["overrides", pkg.overrides],
      ["resolutions", pkg.resolutions],
    ] as const) {
      for (const [name, spec] of Object.entries(map ?? {})) {
        if (PLATFORM.test(name)) left.push(`${where}: ${key} ${name} ${JSON.stringify(spec)}`);
      }
    }
  }
  return { moved, left };
}

/** The version of `name` installed for the app at `dir`: node_modules up from it to the root. */
function installedVersion(root: string, dir: string, name: string): string | null {
  let at = dir;
  for (;;) {
    const file = join(at, "node_modules", name, "package.json");
    if (existsSync(file)) {
      return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null;
    }
    if (at === root || dirname(at) === at) return null;
    at = dirname(at);
  }
}

/**
 * The platform packages not installed at `version` (each with what is installed, if anything):
 * while any is, a type check of the apps checks them against the old packages.
 */
export function staleInstalls(
  root: string,
  product: ClientProductDefinition,
  version: string,
): string[] {
  const stale: string[] = [];
  for (const dep of platformDependencies(root, product)) {
    // A dependency cos could not move is the company's to manage: not counted.
    if (movedSpec(dep.spec, version) === null) continue;
    const installed = installedVersion(root, dirname(dep.file), dep.name);
    if (installed !== version) {
      stale.push(`${dep.name} (${installed ? `${installed} installed` : "not installed"})`);
    }
  }
  return [...new Set(stale)];
}

/** The install command the repo's lockfile names (pnpm when there is none). */
export function installAll(root: string): string {
  if (existsSync(join(root, "yarn.lock"))) return "yarn install";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
    return "bun install";
  if (existsSync(join(root, "package-lock.json"))) return "npm install";
  return "pnpm install";
}
