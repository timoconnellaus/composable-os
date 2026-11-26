// Lets the app mount a pack's web blocks where they sit in the repository
// (`packs/<id>/blocks/<block>/`): for `/blocks` and the e2e specs that drive them in development
// (stage 41), and for the shipped packs' staff screens in the production build too (stage 47,
// screens-plugin.ts).
//
// A block imports the blocks it depends on as sibling folders (`../ui-button/button.tsx`), as
// they sit once `cos add` has copied them into a client app (ADR 0424). In the repository the base
// layer is in `blocks/`, and another pack's block (Content's rich text renderer, which Knowledge's
// blocks draw with, ADR 0708) in that pack's `blocks/`, not beside the importing pack's blocks;
// TypeScript joins them with `rootDirs`, and this does the same for Vite: such an import from a
// pack's block resolves to `blocks/<folder>/…`, else to the one pack whose `blocks/<folder>/` has
// it. An import of a folder beside it in its own pack is left to Vite.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";

export function packBlocks(root: string): Plugin {
  const base = join(root, "blocks");
  const packs = join(root, "packs");
  return {
    name: "cos-pack-blocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith("../")) return null;
      if (!importer.includes(`${sep}packs${sep}`) || !importer.includes(`${sep}blocks${sep}`))
        return null;
      const target = join(base, source.slice(3));
      if (existsSync(target)) return target;
      // A folder beside it in its own pack: Vite resolves it as written.
      if (existsSync(resolve(dirname(importer), source))) return null;
      const found = existsSync(packs)
        ? readdirSync(packs)
            .map((pack) => join(packs, pack, "blocks", source.slice(3)))
            .filter((path) => existsSync(path))
        : [];
      return found.length === 1 ? (found[0] as string) : null;
    },
  };
}
