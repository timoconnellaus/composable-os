// The client kit a release carries (stage 24, ADR 0422): what `cos create`, `cos init`,
// `cos add`, `cos diff` and `cos upgrade` take from the release that matches a client repo's
// platform version, verified with the rest of the bundle.
//
//   template/**             templates/client: the client repo `cos create` writes
//   skills/<name>/SKILL.md  skills/, as a client repo reads them (clientSkill below)
//   blocks/<name>/**        every folder with a block.json: packs/*/blocks/* and blocks/*
//   packs.json              the ids of every pack the release carries
//   contract/roles.json     the carried packs' roles and the operations each may call
//   contract/<audience>.json  packages/core/api/v1: the union of what a host of this release can
//                           serve: core operations, and every carried pack's tools, each named
//                           with its `pack` (a deployment serves those of the packs it installs)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Never part of the kit: build output, dependencies, local state. */
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".turbo", ".tanstack", ".expo"]);

function walk(dir: string, base: string, out: Map<string, Uint8Array>, prefix: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, base, out, prefix);
    else if (entry.isFile()) {
      out.set(`${prefix}${relative(base, path).split("\\").join("/")}`, readFileSync(path));
    }
  }
}

/**
 * A platform skill as a client repo reads it: the paragraph between `<!-- platform-repo -->`
 * and `<!-- /platform-repo -->` is replaced by the one between `<!-- client-repo` and `-->`.
 * In a client repo the agent cannot change the platform, so closing a gap means stopping that
 * part and saying what the platform needs (ADR 0405's consequence, ADR 0401).
 */
export function clientSkill(text: string): string {
  return text.replace(
    /<!-- platform-repo -->[\s\S]*?<!-- \/platform-repo -->\s*<!-- client-repo\n([\s\S]*?)-->/g,
    (_all, client: string) => client.trimEnd(),
  );
}

/** Folders holding a block: a `block.json` beside its files. */
export function blockDirs(root: string): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  const scan = (parent: string) => {
    if (!existsSync(parent)) return;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dir = join(parent, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, "block.json"))) {
        found.push({ name: entry.name, dir });
      }
    }
  };
  scan(join(root, "blocks"));
  if (existsSync(join(root, "packs"))) {
    for (const pack of readdirSync(join(root, "packs"))) scan(join(root, "packs", pack, "blocks"));
  }
  const names = new Set<string>();
  for (const { name } of found) {
    if (names.has(name)) throw new Error(`two blocks are called ${name}`);
    names.add(name);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export function collectClientKit(root: string, packs: readonly string[]): Map<string, Uint8Array> {
  const kit = new Map<string, Uint8Array>();
  // The packs this release carries (every packs/<id>/, which the runner bundles): a client repo's
  // product may list any of them, and `cos deploy` trusts only this list (ADR 0422 as amended).
  kit.set("packs.json", new TextEncoder().encode(`${JSON.stringify([...packs].sort())}\n`));
  walk(join(root, "templates", "client"), join(root, "templates", "client"), kit, "template/");
  const skills = join(root, "skills");
  for (const name of readdirSync(skills)) {
    const file = join(skills, name, "SKILL.md");
    if (!statSync(join(skills, name)).isDirectory() || !existsSync(file)) continue;
    kit.set(
      `skills/${name}/SKILL.md`,
      new TextEncoder().encode(clientSkill(readFileSync(file, "utf8"))),
    );
  }
  // Blocks are MIT (ADR 0401): each carries the licence of the folder it ships from.
  for (const { name, dir } of blockDirs(root)) {
    walk(dir, dir, kit, `blocks/${name}/`);
    const licence = join(dir, "..", "LICENSE");
    if (!existsSync(licence))
      throw new Error(`${relative(root, dir)} has no MIT LICENSE beside it`);
    kit.set(`blocks/${name}/LICENSE`, readFileSync(licence));
  }
  const api = join(root, "packages", "core", "api", "v1");
  // The contract per audience, and the carried packs' roles with what each may call (ADR 0451).
  for (const file of ["customer", "public", "staff", "roles"]) {
    kit.set(`contract/${file}.json`, readFileSync(join(api, `${file}.json`)));
  }
  return new Map([...kit].sort(([a], [b]) => a.localeCompare(b)));
}
