// The box office fixture extension (test/fixtures/boxoffice, stage 27, ADR 0435) as a manifest the
// host's tests reconcile under a fresh id.
import { type ExtensionManifest, toManifest } from "@composable-os/sdk";
import { manifest } from "./extension-helpers.ts";
import boxOffice from "./fixtures/boxoffice/index.ts";

/** The box office as a manifest, under the extension id `id` (its relations follow). */
export function boxOfficeManifest(id: string): ExtensionManifest {
  const json = JSON.stringify(toManifest(boxOffice)).replaceAll('"boxoffice', `"${id}`);
  const { id: _id, ...rest } = JSON.parse(json) as ExtensionManifest;
  return manifest(id, rest);
}
