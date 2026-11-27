// Blocks in a client repo (stage 24, ADR 0424): `cos add <block>` copies one from the release that
// matches product.ts into an app and records it in blocks.lock.json; after that the files are the
// client's. `cos diff <block>` shows what changed upstream between the recorded version and the
// current one, for a person or an agent to apply by hand. Nothing updates a copied block.
//
// My account (stage 48, ADR 0710): once an app has the account shell (`web-account`,
// `native-account`), every `cos add` also copies the section blocks of each pack product.ts lists
// that declares a section of My account (the release's roles.json `portal`), and writes the app's
// `src/blocks/account-sections.gen.ts` naming them; `cos upgrade` writes it again. The page imports
// that file, so its own source names no pack. A section is wired only when the client's copy
// exports what the release's section names; one copied from an older release that does not is
// left out and said (`cos diff <block>`), so an upgrade never breaks the app's build. `cos
// upgrade` also lists every copied block whose upstream files changed since it was copied.
//
// A block in the release's client kit is `blocks/<name>/`: its files and a block.json:
//   { "name", "pack": "deals" | null, "skin": "web" | "native", "operations": [...],
//     "files": [...], "dependsOn": [...] }
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  const expo =
    (existsSync(appJson) && /"expo"\s*:/.test(readFileSync(appJson, "utf8"))) ||
    ["app.config.ts", "app.config.js"].some((f) => existsSync(join(root, app, f)));
  if (expo) {
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

/** Whether `child` is strictly inside `parent` (both resolved). */
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/**
 * An app folder `blocks.lock.json` (or product.ts) names, resolved and refused unless it is inside
 * the repo: the lock is a file anyone can edit, and cos reads, writes and deletes by it.
 */
function appPath(root: string, app: string): string {
  const base = resolve(root);
  const path = resolve(base, app);
  if (!inside(base, path)) {
    throw new CliError(
      `${LOCK} names the app folder ${app}, outside this repo. Nothing was changed.`,
    );
  }
  return path;
}

/**
 * A file of a copied block as `blocks.lock.json` records it, resolved and refused unless it is
 * inside the block's own folder (`<app>/src/blocks/<name>/`) in the repo: a `../` in a recorded file
 * or app would otherwise reach any file.
 */
function copiedPath(root: string, app: string, name: string, file: string): string {
  const dir = resolve(appPath(root, app), "src", "blocks", name);
  const path = resolve(dir, file);
  if (!inside(dir, path)) {
    throw new CliError(
      `${LOCK} records ${file} for ${name}, outside ${blockDir(app, name)}. Nothing was changed: correct the lock (or take the entry out).`,
    );
  }
  return path;
}

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

/** Whether a module's text exports `name` (a function, a const or a class). */
const exportsName = (text: string, name: string) =>
  new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`).test(text) ||
  new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text);

/** The file of a block (as the release has it) that exports `name`, or null. */
function fileExporting(kit: ClientKit, block: string, name: string): string | null {
  for (const file of blockManifest(kit, block).files) {
    const bytes = kit.get(`blocks/${block}/${file}`);
    if (bytes && /\.[jt]sx?$/.test(file) && exportsName(decode(bytes), name)) return file;
  }
  return null;
}

/** A section with the file of the client's copy its component is imported from. */
type ResolvedSection = WiredSection & { file: string };

/**
 * A pack's section the app's copy cannot draw yet: the release's section names an export the
 * client's copied block does not have (it was copied from an older release, or edited).
 */
export interface UnwiredSection {
  key: string;
  label: string;
  block: string;
  file: string;
  export: string;
  app: string;
  /** The shell whose `cos add` wires the section again. */
  shell: string;
}

/** The text of an app's `account-sections.gen.ts`: each section's component and hooks. */
export function accountSectionsSource(
  sections: readonly ResolvedSection[],
  skin: "web" | "native",
): string {
  const shell = ACCOUNT_SHELLS[skin];
  const shellFile = skin === "web" ? "account.tsx" : "account-screen.tsx";
  const entryType = skin === "web" ? "WebSectionEntry" : "NativeSectionEntry";
  const hooks = [...new Map(sections.map((s) => [s.pack, s.hooks])).entries()];
  const components = sections;
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

/** What writing the sections found: section blocks not copied yet, and copies that cannot be wired. */
export interface SectionsWritten {
  /** Section blocks of the listed packs this app has not copied yet (`cos add` copies them). */
  missing: string[];
  /** Copied section blocks older than the release's section: left out of the wiring. */
  unwired: UnwiredSection[];
}

/**
 * Writes `account-sections.gen.ts` in each app whose account shell is copied, naming the sections
 * whose blocks are copied too. A section is wired only when the client's own copy exports what the
 * release's section names: a copy from an older release that does not is left out, so the app
 * still compiles, and returned to be said. The copy itself is never changed.
 */
export function writeAccountSections(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  lock: Readonly<Record<string, { app: string }>>,
): SectionsWritten {
  const packs = [...product.packs, ...requiredPacks(kit, product.packs)];
  const missing: string[] = [];
  const unwired: UnwiredSection[] = [];
  for (const skin of ["web", "native"] as const) {
    const shell = lock[ACCOUNT_SHELLS[skin]];
    if (!shell) continue;
    const sections = sectionsFor(kit, packs, skin);
    for (const s of sections) if (!lock[s.block]) missing.push(s.block);
    const wired: ResolvedSection[] = [];
    for (const s of sections) {
      const copy = lock[s.block];
      if (!copy) continue;
      const file = fileExporting(kit, s.block, s.export);
      if (!file) throw new CliError(`The release's ${s.block} exports no ${s.export}.`);
      const path = copiedPath(root, copy.app, s.block, file);
      if (existsSync(path) && exportsName(readFileSync(path, "utf8"), s.export)) {
        wired.push({ ...s, file });
      } else {
        unwired.push({
          key: s.key,
          label: s.label,
          block: s.block,
          file,
          export: s.export,
          app: copy.app,
          shell: ACCOUNT_SHELLS[skin],
        });
      }
    }
    const file = join(appPath(root, shell.app), "src", "blocks", ACCOUNT_SECTIONS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, accountSectionsSource(wired, skin));
  }
  return { missing, unwired };
}

/** What to tell the client about sections left out of the wiring: which block, and what to run. */
export function unwiredWords(unwired: readonly UnwiredSection[]): string[] {
  return unwired.map(
    (s) =>
      `My account's "${s.label}" section is not wired: your copy of ${s.block} (${blockDir(s.app, s.block)}/${s.file}) does not export ${s.export}, which this release's section draws, so the copy is older than the release's block (or was edited). cos diff ${s.block} shows what changed upstream; apply it by hand, then run cos add ${s.shell} to wire the section. Until then the shell leaves it out.`,
  );
}

/** One copied block whose release files differ from what was copied (or last accepted). */
export interface ChangedBlock {
  name: string;
  /** Files changed, added or removed upstream. */
  files: string[];
  /** Blocks it now depends on that this repo has not copied. */
  newDependencies: string[];
  /** The release has no such block any more. */
  gone: boolean;
}

/**
 * The copied blocks whose files in `kit` differ from what `blocks.lock.json` recorded (the copy as
 * made, or as merged up to with `cos diff --accept`), with any block they now depend on that is
 * not copied. Compared by content, so it holds for a kit rebuilt at the same version too.
 */
export function changedBlocks(root: string, kit: ClientKit): ChangedBlock[] {
  const lock = readLock(root);
  const out: ChangedBlock[] = [];
  for (const [name, entry] of Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))) {
    if (!kit.get(`blocks/${name}/block.json`)) {
      out.push({ name, files: [], newDependencies: [], gone: true });
      continue;
    }
    const manifest = blockManifest(kit, name);
    const files = [...new Set([...Object.keys(entry.files), ...manifest.files])]
      .sort()
      .filter((file) => {
        const bytes = kit.get(`blocks/${name}/${file}`);
        return !bytes || sha(bytes) !== entry.files[file];
      });
    const newDependencies = manifest.dependsOn.filter((dep) => !lock[dep]);
    if (files.length || newDependencies.length) {
      out.push({ name, files, newDependencies, gone: false });
    }
  }
  return out;
}

/** `changedBlocks` in words, for `cos upgrade`: nothing is changed, `cos diff` shows each. */
export function changedBlocksWords(changed: readonly ChangedBlock[], version: string): string[] {
  if (!changed.length) return [];
  return [
    `\nCopied blocks that changed upstream in ${version} since they were copied. Your copies are not touched; cos diff <block> shows each change:`,
    ...changed.map((b) =>
      b.gone
        ? `  ${b.name}: no longer in the release`
        : `  ${b.name}: ${[
            b.files.length ? `${b.files.join(", ")} changed` : "",
            ...b.newDependencies.map((dep) => `now depends on ${dep} (cos add ${dep})`),
          ]
            .filter(Boolean)
            .join("; ")}`,
    ),
  ];
}

/** What copying a block (and the blocks it depends on) did. */
export interface Copied {
  added: string[];
  /** npm packages the copied files import, at the versions to install. */
  needs: Map<string, string>;
  /** The apps that got files. */
  apps: string[];
}

/**
 * Copies each of `names` and the blocks it depends on into their apps, recording each in `lock`
 * (not written here), and, once an account shell is copied, the listed packs' section blocks and
 * the app's section wiring (ADR 0710). A block already in the lock is left as it is: the copy is
 * the client's.
 *
 * `check`: every refusal a copy can make (no such block in the release, its pack or app not in
 * product.ts, a file already there that no copied block owns), and nothing written: `lock` is a
 * copy the caller throws away. `owned` names files that will be gone by the copy (a block being
 * replaced), which are not in the way.
 */
export function copyBlocks(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  version: string,
  names: readonly string[],
  lock: Lock,
  options: { check?: boolean; owned?: ReadonlySet<string> } = {},
): Copied & SectionsWritten {
  // The packs product.ts lists and those they bring (Courses: Content, whose rich text its
  // player draws with): `cos deploy` installs both, so a block may be either's.
  const packs = [...product.packs, ...requiredPacks(kit, product.packs)];
  const added: string[] = [];
  const needs = new Map<string, string>();
  const apps: string[] = [];
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
    // A block that calls no operation (Content's rich text renderer, which Knowledge's blocks
    // draw with, ADR 0708) needs nothing of its pack on the host: it is copied whatever
    // product.ts lists when another block brings it, now or already copied (`cos upgrade` names a
    // new dependency to add by name, and a deleted one can be added back). Asked for by name with
    // no copied block depending on it, or calling the host, its pack must be listed.
    const renderer =
      manifest.operations.length === 0 &&
      (trail.length > 0 ||
        Object.keys(lock).some((copied) => {
          try {
            return blockManifest(kit, copied).dependsOn.includes(block);
          } catch {
            return false;
          }
        }));
    if (manifest.pack && !packs.includes(manifest.pack) && !renderer) {
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
      if (existsSync(target) && !options.owned?.has(resolve(target))) {
        throw new CliError(`${target} exists and is not a copied block.`);
      }
      if (!options.check) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
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
  for (const name of names) visit(name, []);
  let written: SectionsWritten = { missing: [], unwired: [] };
  if (!options.check && Object.values(ACCOUNT_SHELLS).some((shell) => lock[shell])) {
    for (const block of writeAccountSections(root, product, kit, lock).missing) visit(block, []);
    written = writeAccountSections(root, product, kit, lock);
  }
  return { added, needs, apps, ...written };
}

/** What `cos add --replace` will take away, worked out before anything is touched. */
interface ReplacePlan {
  /** The recorded files there now, resolved inside the block's folder: deleted by the replace. */
  paths: string[];
  /** Recorded files that differ from what was copied: the client's edits. */
  edited: string[];
  /** Recorded files no longer there: the release's copy brings them back. */
  missing: string[];
}

/**
 * Plans a replace of a copied block, refusing before any change: a recorded path outside the
 * block's folder (S1), a block folder or file that is a symbolic link (deleting through it would
 * reach its target), and, by a check run of the copy itself, everything the copy would refuse
 * (the release has no such block, its pack or app is not in product.ts, a new file of the release
 * would land on one of the client's own). Nothing is deleted here.
 */
function planReplace(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  version: string,
  lock: Lock,
  name: string,
): ReplacePlan {
  const entry = lock[name] as LockEntry;
  const dir = resolve(appPath(root, entry.app), "src", "blocks", name);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new CliError(
      `${blockDir(entry.app, name)} is a symbolic link: cos add --replace deletes only a block's own files. Nothing was changed.`,
    );
  }
  const plan: ReplacePlan = { paths: [], edited: [], missing: [] };
  for (const [file, hash] of Object.entries(entry.files).sort(([a], [b]) => a.localeCompare(b))) {
    const path = copiedPath(root, entry.app, name, file);
    if (!existsSync(path)) {
      plan.missing.push(file);
      continue;
    }
    if (lstatSync(path).isSymbolicLink()) {
      throw new CliError(
        `${file} of ${name} is a symbolic link: cos add --replace deletes only a block's own files. Nothing was changed.`,
      );
    }
    if (sha(readFileSync(path)) !== hash) plan.edited.push(file);
    plan.paths.push(path);
  }
  // The copy, run as a check on a lock without this block: throws what the real one would.
  const without = structuredClone(lock);
  delete without[name];
  copyBlocks(root, product, kit, version, [name], without, {
    check: true,
    owned: new Set(plan.paths),
  });
  return plan;
}

/** Writes `blocks.lock.json` after `copyBlocks` (for `cos create`). */
export const saveLock = writeLock;

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
  // `--replace`: the copy is the client's, so a block already copied is left alone unless asked.
  // Asked, everything is checked first and a refusal changes nothing; edits to the copy are named
  // and need --yes; only then are its copied files taken away and the release's copied in their
  // place. The blocks it depends on stay as they are (each is replaced by name).
  let replaced: ReplacePlan | null = null;
  if (flags.replace && lock[name]) {
    replaced = planReplace(root, product, kit, version, lock, name);
    if (replaced.edited.length && !flags.yes) {
      deps.io.err(
        `Your copy of ${name} has edits in ${replaced.edited.join(", ")}. cos add --replace would delete them, and cos cannot tell whether you committed them. Nothing was changed. See them with cos diff ${name}, keep what you want, then run cos add ${name} --replace --yes.`,
      );
      return 1;
    }
    for (const path of replaced.paths) rmSync(path);
    delete lock[name];
  }
  const { added, needs, apps, unwired } = copyBlocks(root, product, kit, version, [name], lock);
  writeLock(root, lock);
  if (replaced) {
    deps.io.out(
      [
        `Replaced your copy of ${name} with ${version}'s.`,
        replaced.edited.length
          ? ` Your edits to ${replaced.edited.join(", ")} were deleted: only a commit made before this has them.`
          : "",
        replaced.missing.length
          ? ` ${replaced.missing.join(", ")}, deleted here, ${replaced.missing.length > 1 ? "are" : "is"} back.`
          : "",
      ].join(""),
    );
    const dependents = Object.keys(lock).filter((other) => {
      try {
        return blockManifest(kit, other).dependsOn.includes(name);
      } catch {
        return false;
      }
    });
    if (dependents.length) {
      deps.io.out(
        `${dependents.join(", ")} ${dependents.length > 1 ? "depend" : "depends"} on ${name}: check ${dependents.length > 1 ? "they still build" : "it still builds"} against the new copy.`,
      );
    }
  }
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
      : `${name} is already copied (${LOCK}). To take the release's copy in place of yours, run cos add ${name} --replace (it stops first if you edited the copy: cos diff ${name} shows the edits).`,
  );
  for (const shell of Object.values(ACCOUNT_SHELLS).filter((s) => lock[s])) {
    const app = lock[shell]?.app ?? "";
    deps.io.out(
      `My account's sections: ${join(app, "src", "blocks", ACCOUNT_SECTIONS_FILE)} names the packs' sections; written again by cos add and cos upgrade.`,
    );
  }
  for (const line of unwiredWords(unwired)) deps.io.out(line);
  return 0;
}

/**
 * `cos upgrade`: each app's `account-sections.gen.ts` written again from the new release, the
 * section blocks of the listed packs not copied yet named (`cos add` copies them), and every
 * copied block whose upstream files changed since it was copied listed. A section whose copied
 * block is older than the release's section is left unwired and said; the upgrade goes on, since
 * the copy is the client's to bring up to date by hand (ADR 0424), and what fails an upgrade is
 * the apps' type check, which the wiring then passes.
 */
export function rewriteAccountSections(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  version: string,
  io: { out(line: string): void },
): void {
  const lock = readLock(root);
  if (Object.values(ACCOUNT_SHELLS).some((shell) => lock[shell])) {
    const { missing, unwired } = writeAccountSections(root, product, kit, lock);
    io.out(
      missing.length
        ? `My account's sections written again; the release has sections not copied yet (${missing.join(", ")}): run cos add web-account to copy them.`
        : "My account's sections written again.",
    );
    for (const line of unwiredWords(unwired)) io.out(line);
  }
  for (const line of changedBlocksWords(changedBlocks(root, kit), version)) io.out(line);
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
    const path = copiedPath(root, entry.app, name, file);
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
      const path = copiedPath(root, entry.app, name, file);
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
