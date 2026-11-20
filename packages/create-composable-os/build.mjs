// Bundles the CLI (and @composable-os/release, which is not published) into dist/, with no
// dependencies for everything `npx create-composable-os` does. `cos ext` (the extension check)
// is split into its own chunk, loaded only when asked for; it needs typescript and esbuild at
// run time, which a checkout of the repository has.
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [join(here, "src", "cli.ts")],
  outdir: join(here, "dist"),
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  external: ["typescript", "esbuild"],
});
chmodSync(join(here, "dist", "cli.js"), 0o755);
