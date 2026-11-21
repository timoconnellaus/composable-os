// Development only: lets the app mount a pack's web blocks where they sit in the repository
// (`packs/<id>/blocks/<block>/`), for `/blocks` and the e2e specs that drive them (stage 41).
//
// A block imports the base layer as a sibling folder (`../ui-button/button.tsx`), as it sits once
// `cos add` has copied it into a client app (ADR 0424). In the repository the base layer is in
// `blocks/`, not beside the pack's blocks; TypeScript joins the two with `rootDirs`, and this does
// the same for Vite: such an import from a pack's block resolves to `blocks/<folder>/…`.
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { Plugin } from "vite";

export function packBlocks(root: string): Plugin {
  const base = join(root, "blocks");
  return {
    name: "cos-pack-blocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith("../")) return null;
      if (!importer.includes(`${sep}packs${sep}`) || !importer.includes(`${sep}blocks${sep}`))
        return null;
      const target = join(base, source.slice(3));
      return existsSync(target) ? target : null;
    },
  };
}
