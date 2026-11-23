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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

export const SCREENS_MODULE = "virtual:cos-screens";
const RESOLVED = `\0${SCREENS_MODULE}`;

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

/**
 * Every screen the repository's packs declare, read from each pack's extension (bundled with
 * esbuild in one build and imported). Sorted by pack, then key.
 */
export async function declaredScreens(root: string): Promise<DeclaredScreen[]> {
  const ids = packIds(root);
  if (!ids.length) return [];
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "cos-screens-"));
  try {
    await build({
      entryPoints: ids.map((id) => ({ in: join(root, "packs", id, "index.ts"), out: id })),
      outdir: out,
      bundle: true,
      splitting: true,
      platform: "node",
      format: "esm",
      outExtension: { ".js": ".mjs" },
      logLevel: "error",
    });
    const screens: DeclaredScreen[] = [];
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
    }
    return screens.sort((a, b) => `${a.pack}/${a.key}`.localeCompare(`${b.pack}/${b.key}`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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

/** The Vite plugin. `root` is the repository's root. */
export function packScreens(root: string): Plugin {
  let registry: Promise<string> | null = null;
  return {
    name: "cos-pack-screens",
    resolveId(id) {
      return id === SCREENS_MODULE ? RESOLVED : null;
    },
    async load(id) {
      if (id !== RESOLVED) return null;
      // No screen renders on the server: its build holds none of their code.
      if (this.environment?.config.consumer === "server") {
        return "export const SCREENS = {};\nexport const PACK_HOOKS = {};\n";
      }
      registry ??= resolveScreens(root).then(
        (screens) => registrySource(screens) + packHooksSource(allPackHooks(root)),
      );
      return registry;
    },
  };
}
