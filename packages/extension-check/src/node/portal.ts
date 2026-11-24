// What `cos ext check` reads of a pack's sections of My account beyond its manifest (stage 48,
// ADR 0710): each section's blocks, from their block.json in the pack's `blocks/` folder. A block
// must be there, be this pack's, be of the skin the section names it for, export the component
// named, and call only what a customer or the public may: every operation its block.json lists is
// in the platform's customer or public contract (packages/core/api/v1), or is one of this pack's
// own tools open to customers or the public. The manifest's own rules (names, `has`, order) are
// the contract's `portalIssues`, which the host runs too.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckIssue } from "@composable-os/core/extension-check";

interface PortalSection {
  web?: { block: string; export: string };
  native?: { block: string; export: string };
}

interface Manifest {
  id: string;
  tools?: Record<string, { audiences?: readonly string[] }>;
  portal?: Record<string, PortalSection>;
}

interface BlockJson {
  name?: unknown;
  pack?: unknown;
  skin?: unknown;
  operations?: unknown;
  files?: unknown;
}

/** The operation names of the platform's customer and public contracts, or null when absent. */
function openOperations(platformRoot: string): Set<string> | null {
  const names = new Set<string>();
  for (const audience of ["customer", "public"]) {
    const file = join(platformRoot, "packages", "core", "api", "v1", `${audience}.json`);
    if (!existsSync(file)) return null;
    const contract = JSON.parse(readFileSync(file, "utf8")) as { operations?: { name: string }[] };
    for (const op of contract.operations ?? []) names.add(op.name);
  }
  return names;
}

/** Every code file of a block folder, its subfolders' too. */
function codeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...codeFiles(path));
    else if (/\.(tsx?|jsx?)$/.test(name)) found.push(path);
  }
  return found;
}

/** The issues of a pack's `portal` blocks, read from `dir/blocks/<block>/block.json`. */
export function portalBlockIssues(
  dir: string,
  manifest: Manifest,
  platformRoot: string,
): CheckIssue[] {
  const sections = Object.entries(manifest.portal ?? {});
  if (!sections.length) return [];
  const issues: CheckIssue[] = [];
  const issue = (path: string, message: string) =>
    issues.push({ stage: "contract", code: "contract", path, message });
  const open = openOperations(platformRoot);
  // This pack's own tools open to customers or the public, as `x.<id>.<tool>`.
  const own = new Set(
    Object.entries(manifest.tools ?? {})
      .filter(([, tool]) => (tool.audiences ?? ["staff"]).some((a) => a !== "staff"))
      .map(([name]) => `x.${manifest.id}.${name}`),
  );
  for (const [key, section] of sections) {
    for (const skin of ["web", "native"] as const) {
      const named = section[skin];
      if (!named) continue;
      const path = `portal.${key}.${skin}.block`;
      const folder = join(dir, "blocks", named.block);
      const file = join(folder, "block.json");
      if (!existsSync(file)) {
        issue(
          path,
          `"${named.block}" is not a block of this pack: no blocks/${named.block}/block.json`,
        );
        continue;
      }
      let block: BlockJson;
      try {
        block = JSON.parse(readFileSync(file, "utf8")) as BlockJson;
      } catch {
        issue(path, `blocks/${named.block}/block.json does not parse`);
        continue;
      }
      if (block.pack !== manifest.id) {
        issue(
          path,
          `"${named.block}" is not this pack's block: its block.json names pack ${JSON.stringify(block.pack)}`,
        );
      }
      if (block.skin !== skin) {
        issue(
          path,
          `"${named.block}" is a ${String(block.skin)} block, named for the ${skin} section`,
        );
      }
      const operations = Array.isArray(block.operations) ? (block.operations as unknown[]) : [];
      if (!open) {
        issue(
          path,
          "The platform's customer and public contracts (packages/core/api/v1) could not be read to check what the block calls",
        );
      } else {
        for (const op of operations) {
          if (typeof op !== "string" || (!open.has(op) && !own.has(op))) {
            issue(
              path,
              `"${named.block}" calls ${String(op)}, which no customer may call: a section of My account calls only customer or public operations`,
            );
          }
        }
      }
      const exported = new RegExp(`\\bexport\\s+(?:function|const)\\s+${named.export}\\b`);
      const found = codeFiles(folder).some((f) => exported.test(readFileSync(f, "utf8")));
      if (!found) {
        issue(
          `portal.${key}.${skin}.export`,
          `"${named.block}" exports no component ${named.export}`,
        );
      }
    }
  }
  return issues;
}
