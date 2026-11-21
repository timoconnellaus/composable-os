#!/usr/bin/env node
// The web base layer's blocks (stage 24, ADR 0424): packages/ui's shadcn-style components, as
// blocks a client app copies. Each is the component's own source with its import of `cn` pointed
// at the ui-utils block beside it, so a copied block needs nothing from this repository.
//
//   node blocks/web-base.mjs          writes blocks/ui-*/ from packages/ui
//   node blocks/web-base.mjs --check  fails when they differ (part of the blocks' tests)
//
// The primitives under them are Radix (radix-ui), as in packages/ui; blocks are written against
// the styled layer, so a later move to Base UI changes these files and not the blocks above them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "packages", "ui", "src");
const uiPackage = JSON.parse(
  readFileSync(join(here, "..", "packages", "ui", "package.json"), "utf8"),
);

/** The components in the base layer, and the npm packages each needs. */
const COMPONENTS = {
  button: ["class-variance-authority", "radix-ui"],
  input: [],
  label: ["radix-ui"],
  card: [],
};

function block(name, files, packages, dependsOn) {
  return `${JSON.stringify(
    {
      name,
      pack: null,
      skin: "web",
      operations: [],
      files: [...files, "LICENSE"],
      dependsOn,
      packages: Object.fromEntries(packages.map((p) => [p, uiPackage.dependencies[p]])),
    },
    null,
    2,
  )}\n`;
}

export function webBase() {
  const out = new Map();
  out.set("ui-utils/utils.ts", readFileSync(join(ui, "lib", "utils.ts"), "utf8"));
  out.set("ui-utils/block.json", block("ui-utils", ["utils.ts"], ["clsx", "tailwind-merge"], []));
  for (const [name, packages] of Object.entries(COMPONENTS)) {
    const source = readFileSync(join(ui, "components", `${name}.tsx`), "utf8").replace(
      'from "@composable-os/ui/lib/utils"',
      'from "../ui-utils/utils.ts"',
    );
    out.set(`ui-${name}/${name}.tsx`, source);
    out.set(`ui-${name}/block.json`, block(`ui-${name}`, [`${name}.tsx`], packages, ["ui-utils"]));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [path, text] of webBase()) {
    const target = join(here, path);
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== text) stale.push(path);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  if (stale.length) {
    console.error(
      `blocks/${stale.join(", blocks/")} differ from packages/ui: run node blocks/web-base.mjs`,
    );
    process.exitCode = 1;
  } else console.log(check ? "web base layer: up to date" : "web base layer: written");
}
