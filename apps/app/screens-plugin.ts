// The shipped packs' staff screens, built into the admin (stage 47, ADR 0660). Used by
// vite.config.ts in development and in the production build; never imported by app code.
//
// A shipped pack declares its screens in its manifest (`screens`: a label, the web block and the
// component it exports, where it sits, and the tools that gate it). At build time this plugin
// reads every pack's declaration (packs/<id>/index.ts, bundled with esbuild and imported, as
// `cos client generate` reads one), finds each screen's block where it sits
// (packs/<id>/blocks/<block>/) and the export in one of its files, and the pack's hooks factory in
// its headless entry (packs/<id>/client/index.ts), and emits `virtual:cos-screens`: a registry
// keyed `<pack>/<screen>` whose every entry is a lazy `import()`, so each screen is its own chunk
// and the admin's first load downloads none of them. The admin's source names no pack.
//
// A declared screen whose block, export or pack hooks are missing fails the build (and the dev
// server), naming it. Nothing is loaded at run time from an extension's files: the blocks are code
// in this repository, reviewed like the rest of it. The server's build gets an empty registry: no
// screen is rendered on the server, so no screen's code or data is in server-rendered HTML.
//
// The blocks' base-layer sibling imports (`../ui-button/button.tsx`) are joined to `blocks/` by
// pack-blocks-plugin.ts, which runs in the build as well as in development.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";

export const SCREENS_MODULE = "virtual:cos-screens";
const RESOLVED = `\0${SCREENS_MODULE}`;
/** The host's view: each pack's gate fingerprint (screens.mine lists only what the build holds). */
export const BUILT_MODULE = "virtual:cos-screens-built";
const RESOLVED_BUILT = `\0${BUILT_MODULE}`;

/** One screen as a pack's manifest declares it (the parts the build needs). */
export interface DeclaredScreen {
  pack: string;
  key: string;
  block: string;
  export: string;
}

/** A declared screen, found: the block's file with the export, and the pack's hooks. */
export interface ResolvedScreen extends DeclaredScreen {
  /** The block file exporting the component. */
  file: string;
  /** The pack's headless entry (packs/<id>/client/index.ts). */
  client: string;
  /** Its hooks factory (`createBookingsHooks`) and the operations each hook calls. */
  createHooks: string;
  calls: string;
}

/** The packs in the repository: each folder of `packs/` with a package.json and index.ts. */
function packIds(root: string): string[] {
  const dir = join(root, "packs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => {
      try {
        return (
          statSync(join(dir, id, "package.json")).isFile() &&
          statSync(join(dir, id, "index.ts")).isFile()
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

type ScreensOf = Record<string, { block?: unknown; export?: unknown }>;

/** The SDK the build reads manifests with: this repository's, wherever the packs are. */
const SDK_ENTRY = fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url));

/** What the build reads of the packs: their declared screens and each one's gate fingerprint. */
export interface PackScreens {
  screens: DeclaredScreen[];
  /** `screenGateFingerprint` of each pack that declares screens, by pack id. */
  fingerprints: Record<string, string>;
}

/**
 * Every screen the repository's packs declare, and each pack's gate fingerprint, read from each
 * pack's extension (bundled with esbuild in one build, with the SDK, and imported). Sorted by
 * pack, then key.
 */
export async function readPackScreens(root: string): Promise<PackScreens> {
  const ids = packIds(root);
  if (!ids.length) return { screens: [], fingerprints: {} };
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "cos-screens-"));
  try {
    const sdkEntry = join(out, "sdk-entry.ts");
    writeFileSync(
      sdkEntry,
      `export { screenGateFingerprint, toManifest } from ${JSON.stringify(SDK_ENTRY)};\n`,
    );
    await build({
      entryPoints: [
        ...ids.map((id) => ({ in: join(root, "packs", id, "index.ts"), out: id })),
        { in: sdkEntry, out: "cos-sdk" },
      ],
      outdir: out,
      bundle: true,
      splitting: true,
      platform: "node",
      format: "esm",
      outExtension: { ".js": ".mjs" },
      logLevel: "error",
    });
    const sdk = (await import(pathToFileURL(join(out, "cos-sdk.mjs")).href)) as {
      toManifest: (extension: unknown) => unknown;
      screenGateFingerprint: (manifest: unknown) => string | null;
    };
    const screens: DeclaredScreen[] = [];
    const fingerprints: Record<string, string> = {};
    for (const id of ids) {
      const module = (await import(pathToFileURL(join(out, `${id}.mjs`)).href)) as {
        default?: { id?: string; screens?: ScreensOf };
      };
      const extension = module.default;
      if (!extension) throw new Error(`packs/${id}/index.ts has no default export`);
      for (const [key, screen] of Object.entries(extension.screens ?? {})) {
        screens.push({
          pack: id,
          key,
          block: String(screen.block ?? ""),
          export: String(screen.export ?? ""),
        });
      }
      const fingerprint = sdk.screenGateFingerprint(sdk.toManifest(extension));
      if (fingerprint) fingerprints[id] = fingerprint;
    }
    screens.sort((a, b) => `${a.pack}/${a.key}`.localeCompare(`${b.pack}/${b.key}`));
    return { screens, fingerprints };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Every screen the repository's packs declare. */
export async function declaredScreens(root: string): Promise<DeclaredScreen[]> {
  return (await readPackScreens(root)).screens;
}

/** Whether `source` exports a binding named `name` (a function, const or class, or a list). */
export function exportsName(source: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  const direct = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${escaped}\\b`,
    "m",
  );
  if (direct.test(source)) return true;
  const lists = source.matchAll(/^export\s*\{([^}]*)\}/gm);
  for (const list of lists) {
    const names = (list[1] ?? "").split(",").map((part) =>
      part
        .trim()
        .split(/\s+as\s+/)
        .at(-1),
    );
    if (names.includes(name)) return true;
  }
  return false;
}

/**
 * The screen, found where it sits, or an error naming what is missing: the block's folder, a web
 * block of this pack, the export in one of its files, the pack's hooks factory.
 */
export function resolveScreen(root: string, screen: DeclaredScreen): ResolvedScreen {
  const name = `Screen ${screen.pack}/${screen.key}`;
  const dir = join(root, "packs", screen.pack, "blocks", screen.block);
  const meta = join(dir, "block.json");
  if (!existsSync(meta)) {
    throw new Error(
      `${name}: no block ${screen.block} (packs/${screen.pack}/blocks/${screen.block}/block.json)`,
    );
  }
  const block = JSON.parse(readFileSync(meta, "utf8")) as {
    pack?: string;
    skin?: string;
    files?: string[];
  };
  if (block.skin !== "web" || block.pack !== screen.pack) {
    throw new Error(`${name}: ${screen.block} is not a web block of ${screen.pack}`);
  }
  const files = (block.files ?? []).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f));
  const file = files.find(
    (path) => existsSync(path) && exportsName(readFileSync(path, "utf8"), screen.export),
  );
  if (!file) throw new Error(`${name}: ${screen.block} has no export ${screen.export}`);
  const hooks = packHooksOf(root, screen.pack);
  if (!hooks) {
    throw new Error(
      `${name}: packs/${screen.pack}/client/index.ts exports no create…Hooks and …_HOOKS_CALL`,
    );
  }
  return { ...screen, file, ...hooks };
}

type PackHooks = { client: string; createHooks: string; calls: string };

/** A pack's headless entry and its hooks factory, or null when it has none. */
export function packHooksOf(root: string, pack: string): PackHooks | null {
  const client = join(root, "packs", pack, "client", "index.ts");
  const entry = existsSync(client) ? readFileSync(client, "utf8") : "";
  const createHooks = /^export function (create[A-Z]\w*Hooks)\b/m.exec(entry)?.[1];
  const calls = /^export const ([A-Z][A-Z0-9_]*_HOOKS_CALL)\b/m.exec(entry)?.[1];
  return createHooks && calls ? { client, createHooks, calls } : null;
}

/** Every pack's hooks, for the development page (`/blocks`), which mounts any pack's block. */
export function allPackHooks(root: string): ({ pack: string } & PackHooks)[] {
  return packIds(root).flatMap((pack) => {
    const hooks = packHooksOf(root, pack);
    return hooks ? [{ pack, ...hooks }] : [];
  });
}

/** The development page's map of every pack's hooks, each a lazy import of its headless entry. */
export function packHooksSource(packs: readonly ({ pack: string } & PackHooks)[]): string {
  const entries = packs.map(
    (p) =>
      `  ${JSON.stringify(p.pack)}: () => import(${JSON.stringify(p.client)}).then((client) => ({ ` +
      `createHooks: client[${JSON.stringify(p.createHooks)}], calls: client[${JSON.stringify(p.calls)}] })),`,
  );
  return `export const PACK_HOOKS = {\n${entries.join("\n")}\n};\n`;
}

/** The registry module for the browser: one lazy import per screen, keyed `<pack>/<screen>`. */
export function registrySource(screens: readonly ResolvedScreen[]): string {
  const entries = screens.map((s) => {
    const load =
      `() => Promise.all([import(${JSON.stringify(s.file)}), import(${JSON.stringify(s.client)})])` +
      `.then(([block, client]) => ({ Component: block[${JSON.stringify(s.export)}], ` +
      `createHooks: client[${JSON.stringify(s.createHooks)}], calls: client[${JSON.stringify(s.calls)}] }))`;
    return `  ${JSON.stringify(`${s.pack}/${s.key}`)}: ${load},`;
  });
  return `// Generated by screens-plugin.ts.\nexport const SCREENS = {\n${entries.join("\n")}\n};\n`;
}

/** Every declared screen, resolved; throws on the first one that cannot be (failing the build). */
export async function resolveScreens(root: string): Promise<ResolvedScreen[]> {
  return (await declaredScreens(root)).map((screen) => resolveScreen(root, screen));
}

/** The host's module: each pack's gate fingerprint, for `setBuiltScreens` (no screen's code). */
export function builtSource(fingerprints: Record<string, string>): string {
  return `export const BUILT_SCREENS = ${JSON.stringify(fingerprints)};\n`;
}

/** A chunk of a build, as far as the bundle check reads one (Rollup's and Rolldown's shape). */
export interface BuiltChunk {
  type: "chunk" | "asset";
  fileName: string;
  isEntry?: boolean;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  moduleIds?: readonly string[];
  modules?: Record<string, unknown>;
}

const isBlockModule = (id: string) => /[\\/]packs[\\/][^\\/]+[\\/]blocks[\\/]/.test(id);

/**
 * What is wrong with a build's output, or nothing: the browser's build holds each screen's block
 * in a chunk of its own that no entry imports statically (so the first load downloads none), and
 * the server's holds no block code at all. Checked on every real build of the admin.
 */
export function bundleProblems(
  consumer: "client" | "server",
  chunks: readonly BuiltChunk[],
  screens: readonly ResolvedScreen[],
): string[] {
  const list = chunks.filter((c) => c.type === "chunk");
  const ids = (c: BuiltChunk) => [...(c.moduleIds ?? []), ...Object.keys(c.modules ?? {})];
  if (consumer === "server") {
    return list.flatMap((c) =>
      ids(c).some(isBlockModule) ? [`the server's ${c.fileName} holds a block's code`] : [],
    );
  }
  const byName = new Map(list.map((c) => [c.fileName, c]));
  // Everything an entry loads before the page can run: the entries and what they import statically.
  const eager = new Set<string>();
  const visit = (name: string) => {
    if (eager.has(name)) return;
    eager.add(name);
    for (const next of byName.get(name)?.imports ?? []) visit(next);
  };
  for (const c of list) if (c.isEntry) visit(c.fileName);
  const problems: string[] = [];
  for (const s of screens) {
    const home = list.find((c) => ids(c).includes(s.file));
    if (!home) problems.push(`screen ${s.pack}/${s.key}: its block is in no chunk`);
    else if (eager.has(home.fileName)) {
      problems.push(
        `screen ${s.pack}/${s.key}: its block loads with the first page (${home.fileName})`,
      );
    }
  }
  for (const name of eager) {
    const c = byName.get(name);
    if (c && ids(c).some(isBlockModule))
      problems.push(`${name}, loaded first, holds a block's code`);
  }
  return problems;
}

/** The Vite plugin. `root` is the repository's root. */
export function packScreens(root: string): Plugin {
  let read: Promise<{ screens: ResolvedScreen[]; fingerprints: Record<string, string> }> | null =
    null;
  const resolved = () =>
    (read ??= readPackScreens(root).then(({ screens, fingerprints }) => ({
      screens: screens.map((screen) => resolveScreen(root, screen)),
      fingerprints,
    })));
  return {
    name: "cos-pack-screens",
    resolveId(id) {
      if (id === SCREENS_MODULE) return RESOLVED;
      if (id === BUILT_MODULE) return RESOLVED_BUILT;
      return null;
    },
    async load(id) {
      if (id === RESOLVED_BUILT) return builtSource((await resolved()).fingerprints);
      if (id !== RESOLVED) return null;
      // No screen renders on the server: its build holds none of their code.
      if (this.environment?.config.consumer === "server") {
        return "export const SCREENS = {};\nexport const PACK_HOOKS = {};\n";
      }
      return registrySource((await resolved()).screens) + packHooksSource(allPackHooks(root));
    },
    async generateBundle(_options, bundle) {
      const consumer = this.environment?.config.consumer === "server" ? "server" : "client";
      const problems = bundleProblems(
        consumer,
        Object.values(bundle) as unknown as BuiltChunk[],
        (await resolved()).screens,
      );
      if (problems.length) this.error(`The admin's screens: ${problems.join("; ")}`);
    },
  };
}
