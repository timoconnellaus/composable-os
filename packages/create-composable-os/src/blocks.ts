// Blocks in a client repo (stage 24, ADR 0424): `cos add <block>` copies one from the release that
// matches product.ts into an app and records it in blocks.lock.json; after that the files are the
// client's. `cos diff <block>` shows what changed upstream between the recorded version and the
// current one, for a person or an agent to apply by hand. Nothing updates a copied block.
//
// My account (stage 48, ADR 0710): once an app has the account shell (`web-account`,
// `native-account`), every `cos add` also copies the section blocks of each pack product.ts lists
// that declares a section of My account (the release's roles.json `portal`), and writes the app's
// `src/blocks/account-sections.gen.ts` naming them; `cos upgrade` writes it again. The page imports
// that file, so its own source names no pack.
//
// A block in the release's client kit is `blocks/<name>/`: its files and a block.json:
//   { "name", "pack": "deals" | null, "skin": "web" | "native", "operations": [...],
//     "files": [...], "dependsOn": [...] }
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PortalPackFile } from "@composable-os/core/http-contract";
import type { ClientProductDefinition } from "@composable-os/product";
import { type ClientKit, fetchKit, loadClientProduct, requiredPacks } from "./client-repo.ts";
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

/** The account shell of each skin, whose sections `cos add` wires (ADR 0710). */
export const ACCOUNT_SHELLS = { web: "web-account", native: "native-account" } as const;
/** The file in `<app>/src/blocks/` that names the copied sections. */
export const ACCOUNT_SECTIONS_FILE = "account-sections.gen.ts";

/** The release's packs' sections of My account; none in a release older than stage 48. */
function kitPortal(kit: ClientKit): Record<string, PortalPackFile> {
  const file = kit.get("contract/roles.json");
  if (!file) return {};
  return (JSON.parse(decode(file)) as { portal?: Record<string, PortalPackFile> }).portal ?? {};
}

/** One pack section an app's shell shows: what it is and the block that draws it. */
interface WiredSection {
  key: string;
  pack: string;
  label: string;
  order: number;
  block: string;
  export: string;
  hooks: string;
}

/** The sections of `packs` (in product order) whose pack has a block for `skin`. */
function sectionsFor(
  kit: ClientKit,
  packs: readonly string[],
  skin: "web" | "native",
): WiredSection[] {
  const portal = kitPortal(kit);
  return packs
    .flatMap((pack) =>
      Object.entries(portal[pack]?.sections ?? {}).flatMap(([key, section]) => {
        const named = section[skin];
        if (!named) return [];
        return [
          {
            key: `${pack}.${key}`,
            pack,
            label: section.label,
            order: section.order,
            block: named.block,
            export: named.export,
            hooks: portal[pack]?.hooks as string,
          },
        ];
      }),
    )
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** The file of a block (as the release has it) that exports `name`, or null. */
function fileExporting(kit: ClientKit, block: string, name: string): string | null {
  const exported = new RegExp(`\\bexport\\s+(?:function|const)\\s+${name}\\b`);
  for (const file of blockManifest(kit, block).files) {
    const bytes = kit.get(`blocks/${block}/${file}`);
    if (bytes && /\.[jt]sx?$/.test(file) && exported.test(decode(bytes))) return file;
  }
  return null;
}

/** The text of an app's `account-sections.gen.ts`: each section's component and hooks. */
export function accountSectionsSource(
  kit: ClientKit,
  sections: readonly WiredSection[],
  skin: "web" | "native",
): string {
  const shell = ACCOUNT_SHELLS[skin];
  const shellFile = skin === "web" ? "account.tsx" : "account-screen.tsx";
  const entryType = skin === "web" ? "WebSectionEntry" : "NativeSectionEntry";
  const hooks = [...new Map(sections.map((s) => [s.pack, s.hooks])).entries()];
  const components = sections.map((s) => {
    const file = fileExporting(kit, s.block, s.export);
    if (!file) throw new CliError(`The release's ${s.block} exports no ${s.export}.`);
    return { ...s, file };
  });
  const lines = [
    "// Generated by `cos add` and `cos upgrade` from the packs product.ts lists (stage 48, ADR 0710):",
    "// each section of My account a pack declares, as its copied block's component and the pack's",
    "// hooks. Do not edit: it is written again. The blocks it names are yours (cos diff <block>).",
    ...hooks.map(
      ([pack, factory]) => `import { ${factory} } from "@composable-os/pack-${pack}/client";`,
    ),
    ...components.map((c) => `import { ${c.export} } from "./${c.block}/${c.file}";`),
    `import type { ${entryType} } from "./${shell}/${shellFile}";`,
    "",
    `export const ACCOUNT_SECTIONS: readonly ${entryType}[] = [`,
    ...components.flatMap((c) => [
      "  {",
      `    key: ${JSON.stringify(c.key)},`,
      `    pack: ${JSON.stringify(c.pack)},`,
      `    label: ${JSON.stringify(c.label)},`,
      `    order: ${c.order},`,
      `    component: ${c.export},`,
      `    hooks: ${c.hooks},`,
      "  },",
    ]),
    "];",
    "",
  ];
  return lines.join("\n");
}

/**
 * Writes `account-sections.gen.ts` in each app whose account shell is copied, naming the sections
 * whose blocks are copied too; returns the section blocks of the listed packs not copied yet.
 */
export function writeAccountSections(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  lock: Readonly<Record<string, { app: string }>>,
): string[] {
  const packs = [...product.packs, ...requiredPacks(kit, product.packs)];
  const missing: string[] = [];
  for (const skin of ["web", "native"] as const) {
    const shell = lock[ACCOUNT_SHELLS[skin]];
    if (!shell) continue;
    const sections = sectionsFor(kit, packs, skin);
    for (const s of sections) if (!lock[s.block]) missing.push(s.block);
    const copied = sections.filter((s) => lock[s.block]);
    const file = join(root, shell.app, "src", "blocks", ACCOUNT_SECTIONS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, accountSectionsSource(kit, copied, skin));
  }
  return missing;
}

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
  // The packs product.ts lists and those they bring (Courses: Content, whose rich text its
  // player draws with): `cos deploy` installs both, so a block may be either's.
  const packs = [...product.packs, ...requiredPacks(kit, product.packs)];
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
    if (manifest.pack && !packs.includes(manifest.pack)) {
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
  // My account: with a shell copied, the listed packs' section blocks come too, and the app's
  // section wiring is written again (ADR 0710).
  const shells = Object.values(ACCOUNT_SHELLS).filter((shell) => lock[shell]);
  if (shells.length) {
    for (const block of writeAccountSections(root, product, kit, lock)) visit(block, []);
    writeAccountSections(root, product, kit, lock);
  }
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
  for (const shell of shells) {
    const app = lock[shell]?.app ?? "";
    deps.io.out(
      `My account's sections: ${join(app, "src", "blocks", ACCOUNT_SECTIONS_FILE)} names the packs' sections; written again by cos add and cos upgrade.`,
    );
  }
  return 0;
}

/**
 * `cos upgrade`: each app's `account-sections.gen.ts` written again from the new release, and
 * the section blocks of the listed packs not copied yet named (`cos add` copies them).
 */
export function rewriteAccountSections(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  io: { out(line: string): void },
): void {
  const lock = readLock(root);
  if (!Object.values(ACCOUNT_SHELLS).some((shell) => lock[shell])) return;
  const missing = writeAccountSections(root, product, kit, lock);
  io.out(
    missing.length
      ? `My account's sections written again; the release has sections not copied yet (${missing.join(", ")}): run cos add web-account to copy them.`
      : "My account's sections written again.",
  );
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
  // `--accept`: the upstream changes shown were applied here by hand. Recorded only against the
  // kit of the version the repo is on, so a later diff starts from there (issue #177).
  const accept = Boolean(flags.accept);
  if (accept && target !== product.platform.version) {
    throw new CliError(
      `cos diff --accept records a block as merged up to the version product.ts is on (${product.platform.version}), not ${target}. Run cos upgrade first, or leave out --version.`,
    );
  }
  const accepted = (kit: Map<string, Uint8Array>) => {
    if (!accept) return;
    const manifest = blockManifest(kit, name);
    const files: Record<string, string> = {};
    for (const file of manifest.files) {
      const bytes = kit.get(`blocks/${name}/${file}`);
      if (bytes) files[file] = sha(bytes);
    }
    const lock = readLock(root);
    lock[name] = { ...entry, version: target, files };
    writeLock(root, lock);
    io.out(
      `\nAccepted: ${name} is recorded as merged up to ${target} (${LOCK}). Your files are not changed; a later cos diff shows only what changes after this.`,
    );
  };
  // Local edits are the client's; they are said, never touched.
  for (const [file, hash] of Object.entries(entry.files)) {
    const path = join(root, blockDir(entry.app, name), file);
    if (!existsSync(path)) io.out(`${file}: removed here`);
    else if (sha(readFileSync(path)) !== hash) io.out(`${file}: edited here since it was copied`);
  }
  const fetch = (version: string) =>
    fetchKit(flags, deps, product.platform.release, product.platform.repository, version, {
      bundleOnly: true,
    });
  if (target === entry.version) {
    // Compared by content, not by version: a kit rebuilt at the same version (local tarballs)
    // may differ from what was copied. What was copied is known by its hashes, and is the file
    // here when that is unedited.
    const { kit } = await fetch(target);
    const now = blockManifest(kit, name);
    let changed = false;
    for (const file of [...new Set([...Object.keys(entry.files), ...now.files])].sort()) {
      const bytes = kit.get(`blocks/${name}/${file}`);
      const upstream = bytes ? decode(bytes) : "";
      if (bytes && sha(bytes) === entry.files[file]) continue;
      changed = true;
      const path = join(root, blockDir(entry.app, name), file);
      const here = existsSync(path) ? readFileSync(path, "utf8") : "";
      const unedited = existsSync(path) && sha(readFileSync(path)) === entry.files[file];
      io.out(
        `\n--- ${file} (${unedited ? `as copied from ${entry.version}` : "here, edited"})\n+++ ${file} (${target} as the release has it now${bytes ? "" : ", absent"})`,
      );
      for (const line of lineDiff(here, upstream)) io.out(line);
    }
    io.out(
      changed
        ? `${name}'s files in ${target} changed since it was copied (the release was rebuilt at the same version). Apply by hand; nothing is changed.`
        : `No upstream change: ${name} was copied from ${entry.version}, the version product.ts is on.`,
    );
    if (changed) accepted(kit);
    return 0;
  }
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
  accepted(to.kit);
  return 0;
}
