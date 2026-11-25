// Stage 47 (ADR 0660): the shipped packs' staff screens, built into the admin. The registry is
// generated from the packs' own declarations (the admin's source names no pack); every declared
// screen's block and export resolve where they sit; one missing fails the build; and a production
// build puts each screen in a lazily loaded chunk of its own, none of it in the entry the admin's
// first load downloads (criteria 1, 9, 10 and 11). The e2e suite runs on the dev server, so this
// is the check that the production bundle holds and routes the screens.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { packBlocks } from "../pack-blocks-plugin.ts";
import {
  builtSource,
  bundleProblems,
  declaredScreens,
  exportsName,
  packScreens,
  readPackScreens,
  registrySource,
  resolveScreen,
  resolveScreens,
  SCREENS_MODULE,
} from "../screens-plugin.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A repository with one pack declaring one screen, its block laid out as `files` says. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cos-screens-fixture-"));
  temps.push(root);
  const all: Record<string, string> = {
    "packs/desk/package.json": JSON.stringify({ name: "fixture", version: "0.1.0" }),
    "packs/desk/index.ts": `export default { id: "desk", screens: { front: { label: "Front", block: "desk-front", export: "FrontDesk", opens: ["day"] } } };`,
    "packs/desk/client/index.ts":
      "export function createDeskHooks() { return {}; }\nexport const DESK_HOOKS_CALL = {};\n",
    "packs/desk/blocks/desk-front/block.json": JSON.stringify({
      name: "desk-front",
      pack: "desk",
      skin: "web",
      files: ["front.tsx", "LICENSE"],
    }),
    "packs/desk/blocks/desk-front/front.tsx": "export function FrontDesk() { return null; }\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("the screens registry (ADR 0660)", () => {
  it("is read from the shipped packs' declarations, and every screen resolves", async () => {
    const screens = await resolveScreens(ROOT);
    expect(screens.map((s) => `${s.pack}/${s.key}`)).toEqual([
      "bookings/classList",
      "bookings/desk",
      "courses/builder",
      "dailychecks/history",
      "dailychecks/today",
      "knowledge/procedures",
      "knowledge/reader",
      "knowledge/readStatus",
      "knowledge/toRead",
      "memberships/holdings",
      "programs/bank",
      "programs/builder",
      "programs/client",
      "rostering/checklists",
      "rostering/myCalendar",
      "rostering/myShifts",
      "rostering/myTimeOff",
      "rostering/offers",
      "rostering/patterns",
      "rostering/pay",
      "rostering/qualifications",
      "rostering/roster",
      "rostering/timeOff",
    ]);
    for (const screen of screens) {
      expect(screen.file).toContain(join("packs", screen.pack, "blocks", screen.block));
      expect(screen.createHooks).toMatch(/^create[A-Z]\w*Hooks$/);
    }
    // One lazy import per screen; nothing else.
    const source = registrySource(screens);
    expect(source.match(/import\(/g)).toHaveLength(screens.length * 2);
    expect(source).not.toMatch(/^import /m);
  });

  it("the admin's source names no pack: the registry is generated (criterion 10)", () => {
    // No file of the app imports a pack: its blocks and hooks come from the generated registry.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const importing = files(join(ROOT, "apps/app/src")).filter((path) =>
      /from\s+["']@composable-os\/pack-/.test(readFileSync(path, "utf8")),
    );
    // One reviewed exception (stage 29 step 4, ADR 0728): the form page the host serves at
    // /f/<slug> and /form is the Forms pack's, drawn on the server, not a screen of the admin.
    expect(importing.map((path) => path.slice(ROOT.length))).toEqual([
      "apps/app/src/server/http/form-page.ts",
    ]);
    // And the screens' own files name none, in code or in words.
    const ids = new RegExp(
      readdirSync(join(ROOT, "packs"))
        // "content" is also an ordinary word of HTML (a meta tag's), so it is left out.
        .filter((id) => !id.startsWith(".") && id !== "content")
        .map((id) => `\\b${id}\\b`)
        .join("|"),
      "i",
    );
    for (const path of [
      "src/components/screens/screens.tsx",
      "src/components/screens/screens-nav.tsx",
      "src/components/screens/fixed-role-shell.tsx",
      "src/components/not-found.tsx",
      "src/routes/_app/s.$pack.$screen.tsx",
      "src/lib/staff-client.ts",
    ]) {
      expect(readFileSync(join(ROOT, "apps/app", path), "utf8"), path).not.toMatch(ids);
    }
  });

  it("fails on a declared screen whose block or export is missing (criterion 9)", async () => {
    const declared = { pack: "desk", key: "front", block: "desk-front", export: "FrontDesk" };
    expect(resolveScreen(fixture({}), declared).file).toMatch(/front\.tsx$/);
    expect(() => resolveScreen(fixture({}), { ...declared, block: "desk-gone" })).toThrow(
      "Screen desk/front: no block desk-gone",
    );
    expect(() => resolveScreen(fixture({}), { ...declared, export: "BackDesk" })).toThrow(
      "Screen desk/front: desk-front has no export BackDesk",
    );
    const native = fixture({
      "packs/desk/blocks/desk-front/block.json": JSON.stringify({
        name: "desk-front",
        pack: "desk",
        skin: "native",
        files: ["front.tsx"],
      }),
    });
    expect(() => resolveScreen(native, declared)).toThrow("is not a web block of desk");
    const noHooks = fixture({ "packs/desk/client/index.ts": "export const x = 1;\n" });
    expect(() => resolveScreen(noHooks, declared)).toThrow("exports no create…Hooks");
    // Read from the pack's own index.ts, and the build fails on it.
    const missing = fixture({ "packs/desk/blocks/desk-front/front.tsx": "export const x = 1;\n" });
    expect(await declaredScreens(missing)).toEqual([declared]);
    await expect(resolveScreens(missing)).rejects.toThrow("has no export FrontDesk");
    await expect(buildRegistry(missing)).rejects.toThrow("has no export FrontDesk");
  }, 120_000);

  it("finds an export however it is written", () => {
    expect(exportsName("export function Desk() {}", "Desk")).toBe(true);
    expect(exportsName("export const Desk = () => null;", "Desk")).toBe(true);
    expect(exportsName("function A() {}\nexport { A as Desk, B };", "Desk")).toBe(true);
    expect(exportsName("export function DeskTwo() {}", "Desk")).toBe(false);
    expect(exportsName("// export function Desk() {}", "Desk")).toBe(false);
  });

  it("hands the host each pack's gate fingerprint, from the same reading of the packs", async () => {
    const { screens, fingerprints } = await readPackScreens(ROOT);
    expect(Object.keys(fingerprints).sort()).toEqual(
      [...new Set(screens.map((s) => s.pack))].sort(),
    );
    const source = builtSource(fingerprints);
    expect(source).toMatch(/^export const BUILT_SCREENS = \{/);
    // No code: data only, no import.
    expect(source).not.toMatch(/^import |import\(/m);
  });

  it("the bundle check refuses a block loaded first, a missing one, and any in the server", async () => {
    const screens = await resolveScreens(ROOT);
    const [first] = screens;
    if (!first) throw new Error("no screens");
    const entry = (imports: string[], modules: string[] = []) => ({
      type: "chunk" as const,
      fileName: "entry.js",
      isEntry: true,
      imports,
      dynamicImports: ["screen.js"],
      moduleIds: modules,
    });
    const lazy = {
      type: "chunk" as const,
      fileName: "screen.js",
      moduleIds: screens.map((s) => s.file),
    };
    expect(bundleProblems("client", [entry([]), lazy], screens)).toEqual([]);
    // The screen's chunk imported statically by the entry: it loads with the first page.
    expect(bundleProblems("client", [entry(["screen.js"]), lazy], screens)[0]).toMatch(
      /loads with the first page/,
    );
    // A block's code in the entry itself.
    expect(
      bundleProblems("client", [entry([], [first.file]), lazy], screens).some((p) =>
        p.includes("loaded first, holds a block's code"),
      ),
    ).toBe(true);
    expect(bundleProblems("client", [entry([])], screens)[0]).toMatch(/its block is in no chunk/);
    expect(bundleProblems("server", [entry([], [first.file])], screens)).toEqual([
      "the server's entry.js holds a block's code",
    ]);
    expect(bundleProblems("server", [entry([])], screens)).toEqual([]);
  });

  it("a production build gives each screen its own lazy chunk, none in the entry (criterion 11)", async () => {
    const output = await buildRegistry(ROOT);
    const chunks = output.filter((o): o is Rollup.OutputChunk => o.type === "chunk");
    const entry = chunks.find((c) => c.isEntry);
    expect(entry).toBeDefined();
    const screens = await resolveScreens(ROOT);
    for (const screen of screens) {
      // The screen's block is in a chunk the entry only imports dynamically.
      const home = chunks.find((c) => Object.keys(c.modules).includes(screen.file));
      expect(home, `${screen.pack}/${screen.key}`).toBeDefined();
      expect(home?.isEntry).toBe(false);
      expect(entry?.imports).not.toContain(home?.fileName);
      expect(entry?.dynamicImports).toContain(home?.fileName);
    }
    // No block's code is in the entry: only the loaders.
    expect(Object.keys(entry?.modules ?? {}).some((id) => id.includes("/blocks/"))).toBe(false);
  }, 120_000);
});

/** A client build of an entry that imports the registry, with the admin's two plugins. */
async function buildRegistry(root: string): Promise<(Rollup.OutputChunk | Rollup.OutputAsset)[]> {
  const dir = mkdtempSync(join(tmpdir(), "cos-screens-build-"));
  temps.push(dir);
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export { SCREENS } from "${SCREENS_MODULE}";\n`);
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: "silent",
    plugins: [packBlocks(root), packScreens(root)],
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "entry" },
      rollupOptions: {
        external: (id) =>
          !id.startsWith(".") &&
          !id.startsWith("/") &&
          !id.startsWith("\0") &&
          !id.startsWith("virtual:"),
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((o) => ("output" in o ? o.output : []));
}
