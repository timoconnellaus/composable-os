// Bundles the CLI (and @composable-os/release, which is not published) into dist/, with no
// dependencies for everything `npx create-composable-os` does. `cos ext` (the extension check)
// is split into its own chunk, loaded only when asked for; it needs typescript and esbuild at
// run time, which a checkout of the repository has.
import { chmodSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [join(here, "src", "cli.ts"), join(here, "src", "create.ts")],
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
chmodSync(join(here, "dist", "create.js"), 0o755);
// What `cos ext check` needs outside a checkout (stage 24): the SDK's source, which extensions are
// type-checked against, and the core migrations, which its dry-run reconcile applies. Both are
// this CLI's version's, which is the platform version a client repo is on.
const root = join(here, "..", "..");
cpSync(join(root, "packages", "sdk", "src"), join(here, "dist", "platform", "sdk"), {
  recursive: true,
  filter: (src) => !/\.test\.ts$/.test(src),
});
cpSync(join(root, "packages", "db", "migrations"), join(here, "dist", "platform", "migrations"), {
  recursive: true,
});
// The registry's own migrations, which `cos fleet install` applies (stage 66 step 7).
cpSync(
  join(root, "packages", "db", "registry-migrations"),
  join(here, "dist", "platform", "registry-migrations"),
  { recursive: true },
);
