// Every pack the release carries (every packs/<id>/, ADR 0420 as amended), for the tests that
// generate and check the release's committed files: open-operations.json and api/v1/*.json. A
// pack added to the repository is in those files without anyone listing it here.
import { toManifest } from "@composable-os/sdk";
import { toolOperation } from "../src/extensions/tools.ts";
import type { AnyOperation } from "../src/index.ts";

type PackExtension = Parameters<typeof toManifest>[0];

const entries = import.meta.glob<PackExtension>("../../../packs/*/index.ts", {
  eager: true,
  import: "default",
});
const packages = import.meta.glob("../../../packs/*/package.json", { eager: true });

const idOf = (path: string) => path.split("/").at(-2) as string;

/** The ids of the packs the release carries, sorted. */
export const releasePackIds: string[] = Object.keys(packages).map(idOf).sort();

/** Each carried pack's extension, in pack id order. */
export const releasePackExtensions: PackExtension[] = Object.entries(entries)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, extension]) => {
    if (toManifest(extension).id !== idOf(path)) {
      throw new Error(`packs/${idOf(path)} declares the extension id ${toManifest(extension).id}`);
    }
    return extension;
  });

/** Every carried pack's tools as operations (`x.<pack>.<tool>`), as a host that installs it has. */
export const releasePackTools: AnyOperation[] = releasePackExtensions.flatMap((extension) => {
  const manifest = toManifest(extension);
  return Object.entries(manifest.tools).map(([name, tool]) =>
    toolOperation(manifest, name, tool, "shipped"),
  );
});
