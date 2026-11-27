// One release of several products (stage 66: the CRM and the hosted product): each product is
// built into a folder of its own (build-release.ts), then the folders are merged into the one a
// tag publishes. Each product keeps its own files (`composable-os-<product>-<version>.tar.gz` and
// `.manifest.json`), and SHA256SUMS lists them all, so `cos` finds a product's bundle by its name
// exactly as it does in a release of one product. The release workflow attests every bundle and
// manifest in the merged folder.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSums, parseSums, releaseAssetNames, sha256Hex } from "@composable-os/release";

export interface ReleasePart {
  /** The product's id. */
  product: string;
  /** The folder build-release.ts wrote for it. */
  dir: string;
}

/**
 * Merges the parts' files into `out` (emptied first) with one SHA256SUMS listing every file.
 * Refuses a part whose files are not exactly its product's bundle and manifest for `version`, a
 * file its SHA256SUMS does not list or lists with another digest, and a product given twice.
 * Returns the merged SHA256SUMS.
 */
export async function mergeReleaseParts(
  parts: readonly ReleasePart[],
  version: string,
  out: string,
): Promise<string> {
  if (!parts.length) throw new Error("no product to merge");
  const sums = new Map<string, string>();
  const files: { name: string; from: string }[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.product)) throw new Error(`${part.product} is given twice`);
    seen.add(part.product);
    const names = releaseAssetNames(part.product, version);
    const listed = parseSums(readFileSync(join(part.dir, names.sums), "utf8"));
    const present = readdirSync(part.dir)
      .filter((name) => name !== names.sums)
      .sort();
    const expected = [names.bundle, names.manifest].sort();
    if (present.join("\n") !== expected.join("\n")) {
      throw new Error(
        `${part.dir} holds ${present.join(", ") || "nothing"}, not ${part.product} ${version}'s ${expected.join(" and ")}`,
      );
    }
    if ([...listed.keys()].sort().join("\n") !== expected.join("\n")) {
      throw new Error(`${part.dir}/${names.sums} does not list exactly ${expected.join(" and ")}`);
    }
    for (const name of expected) {
      const digest = await sha256Hex(new Uint8Array(readFileSync(join(part.dir, name))));
      if (listed.get(name) !== digest) {
        throw new Error(`${part.dir}/${name} is not the file its SHA256SUMS lists`);
      }
      if (sums.has(name)) throw new Error(`${name} is in two parts`);
      sums.set(name, digest);
      files.push({ name, from: join(part.dir, name) });
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of files) copyFileSync(file.from, join(out, file.name));
  const text = formatSums(sums);
  writeFileSync(join(out, "SHA256SUMS"), text);
  return text;
}
