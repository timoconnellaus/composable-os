// Blocks in a client repo (stage 24, ADR 0424): `cos add <block>` copies one from the release that
// matches product.ts into an app and records it in blocks.lock.json; after that the files are the
// client's. `cos diff <block>` shows what changed upstream between the recorded version and the
// current one, for a person or an agent to apply by hand. Nothing updates a copied block.
//
// A block in the release's client kit is `blocks/<name>/`: its files and a block.json:
//   { "name", "pack": "deals" | null, "skin": "web" | "native", "operations": [...],
//     "files": [...], "dependsOn": [...] }
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ClientKit, fetchKit, loadClientProduct } from "./client-repo.ts";
import { lineDiff } from "./diff.ts";
import { CliError, type Deps, type Flags, str } from "./main.ts";

export interface BlockManifest {
  name: string;
  /** The pack it is a screen for, or null for a base-layer block. */
  pack: string | null;
  skin: "web" | "native";
  /** The operations it calls: what it needs the host to serve. */
  operations: string[];
  /** Its files, relative to its folder. */
  files: string[];
  /** Blocks it imports, copied with it. */
  dependsOn: string[];
  /** npm packages its files import, with the versions the platform uses. */
  packages?: Record<string, string>;
}

interface LockEntry {
  version: string;
  app: string;
  /** sha256 of each file as copied, to tell a local edit from an upstream change. */
  files: Record<string, string>;
}

type Lock = Record<string, LockEntry>;

const LOCK = "blocks.lock.json";
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

function readLock(root: string): Lock {
  const path = join(root, LOCK);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Lock) : {};
}

function writeLock(root: string, lock: Lock) {
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(root, LOCK), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Every block in a release, one line each: name, skin, pack, operations, depends on. */
export function listBlocks(kit: ClientKit): string {
  const lines = [...kit.keys()]
    .filter((p) => /^blocks\/[^/]+\/block\.json$/.test(p))
    .sort()
    .map((p) => {
      const b = JSON.parse(decode(kit.get(p) as Uint8Array)) as BlockManifest;
      const parts = [
        `${b.skin}`,
        b.pack ? `pack ${b.pack}` : "base",
        b.operations.length ? `calls ${b.operations.join(", ")}` : "",
        b.dependsOn.length ? `with ${b.dependsOn.join(", ")}` : "",
      ].filter(Boolean);
      return `  ${b.name.padEnd(16)} ${parts.join("; ")}`;
    });
  return `Blocks (cos add <name>):\n${lines.join("\n")}`;
}

export function blockManifest(kit: ClientKit, name: string): BlockManifest {
  const bytes = kit.get(`blocks/${name}/block.json`);
  if (!bytes) throw new CliError(`No block ${name} in this release.\n${listBlocks(kit)}`);
  return JSON.parse(decode(bytes)) as BlockManifest;
}

/**
 * The install command that fits the app: `npx expo install` in an Expo app (it picks native
 * modules' versions for the app's SDK), else the package manager the repo's lockfile names.
 */
export function installCommand(root: string, app: string, packages: string[]): string {
  const cd = app && app !== "." ? `cd ${app} && ` : "";
  const appJson = join(root, app, "app.json");
  if (existsSync(appJson) && /"expo"\s*:/.test(readFileSync(appJson, "utf8"))) {
    return `${cd}npx expo install ${packages.join(" ")}`;
  }
  const at = (file: string) => existsSync(join(root, file)) || existsSync(join(root, app, file));
  const manager = at("pnpm-lock.yaml")
    ? "pnpm add"
    : at("yarn.lock")
      ? "yarn add"
      : at("bun.lock") || at("bun.lockb")
        ? "bun add"
        : at("package-lock.json")
          ? "npm install"
          : "pnpm add";
  return `${cd}${manager} ${packages.join(" ")}`;
}

/** Where a block's files go: `<app>/src/blocks/<name>/`. */
const blockDir = (app: string, name: string) => join(app, "src", "blocks", name);

export async function add(argv: string[], flags: Flags, deps: Deps): Promise<number> {
  const name = argv[0];
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  const { kit, version } = await fetchKit(
    flags,
    deps,
    product.platform.release,
    product.platform.repository,
    product.platform.version,
  );
  if (!name) {
    deps.io.out(listBlocks(kit));
    return 0;
  }
  const lock = readLock(root);
  const added: string[] = [];
  const needs = new Map<string, string>();
  const visit = (block: string, trail: string[]) => {
    if (lock[block] || added.includes(block)) return;
    if (trail.includes(block))
      throw new CliError(`Blocks depend on each other: ${trail.join(" > ")}`);
    const manifest = blockManifest(kit, block);
    const app = manifest.skin === "web" ? product.web?.dir : product.mobile?.dir;
    if (!app) {
      throw new CliError(
        `${block} is a ${manifest.skin} block and this repo has no ${manifest.skin === "web" ? "web" : "mobile"} app in product.ts.`,
      );
    }
    if (manifest.pack && !product.packs.includes(manifest.pack)) {
      throw new CliError(
        `${block} is a block of the ${manifest.pack} pack, which product.ts does not list.`,
      );
    }
    for (const dep of manifest.dependsOn) visit(dep, [...trail, block]);
    const files: Record<string, string> = {};
    for (const file of manifest.files) {
      const bytes = kit.get(`blocks/${block}/${file}`);
      if (!bytes) throw new CliError(`The release's ${block} has no ${file}.`);
      const target = join(root, blockDir(app, block), file);
      if (existsSync(target)) throw new CliError(`${target} exists and is not a copied block.`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      files[file] = sha(bytes);
    }
    lock[block] = { version, app, files };
    added.push(block);
    for (const [pkg, range] of Object.entries(manifest.packages ?? {})) {
      // The platform's own packages at this release's version, never `*`.
      needs.set(pkg, pkg.startsWith("@composable-os/") ? version : range);
    }
    if (!apps.includes(app)) apps.push(app);
  };
  const apps: string[] = [];
  visit(name, []);
  writeLock(root, lock);
  if (needs.size) {
    const app = apps[0] as string;
    deps.io.out(
      `They import ${[...needs.keys()].join(", ")}. Install them in ${app}:\n  ${installCommand(
        root,
        app,
        [...needs].map(([p, v]) => `${p}@${v}`),
      )}`,
    );
  }
  deps.io.out(
    added.length
      ? `Copied ${added.join(", ")} (${version}) into ${added.map((b) => blockDir(lock[b]?.app ?? "", b)).join(", ")}. The files are yours now; ${LOCK} records where they came from.`
      : `${name} is already copied (${LOCK}).`,
  );
  return 0;
}

export async function diff(argv: string[], flags: Flags, deps: Deps): Promise<number> {
  const name = argv[0];
  if (!name) throw new CliError("Usage: cos diff <block>");
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  const entry = readLock(root)[name];
  if (!entry) throw new CliError(`${name} was not copied with cos add (${LOCK}).`);
  const { io } = deps;
  const target = str(flags, "version") ?? product.platform.version;
  // Local edits are the client's; they are said, never touched.
  for (const [file, hash] of Object.entries(entry.files)) {
    const path = join(root, blockDir(entry.app, name), file);
    if (!existsSync(path)) io.out(`${file}: removed here`);
    else if (sha(readFileSync(path)) !== hash) io.out(`${file}: edited here since it was copied`);
  }
  if (target === entry.version) {
    io.out(
      `No upstream change: ${name} was copied from ${entry.version}, the version product.ts is on.`,
    );
    return 0;
  }
  const fetch = (version: string) =>
    fetchKit(flags, deps, product.platform.release, product.platform.repository, version);
  const [from, to] = [await fetch(entry.version), await fetch(target)];
  const before = blockManifest(from.kit, name);
  const after = blockManifest(to.kit, name);
  io.out(
    `Upstream changes to ${name}, ${entry.version} → ${target} (apply by hand; nothing is changed):`,
  );
  let changed = false;
  for (const file of [...new Set([...before.files, ...after.files])].sort()) {
    const a = from.kit.get(`blocks/${name}/${file}`);
    const b = to.kit.get(`blocks/${name}/${file}`);
    const textA = a ? decode(a) : "";
    const textB = b ? decode(b) : "";
    if (textA === textB) continue;
    changed = true;
    io.out(
      `\n--- ${file} (${entry.version}${a ? "" : ", absent"})\n+++ ${file} (${target}${b ? "" : ", absent"})`,
    );
    for (const line of lineDiff(textA, textB)) io.out(line);
  }
  if (!changed) io.out("  none");
  for (const dep of after.dependsOn.filter((d) => !before.dependsOn.includes(d))) {
    io.out(`It now depends on ${dep}: cos add ${dep}`);
  }
  return 0;
}
