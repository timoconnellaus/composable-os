// A product's contract, from its own registry (ADR 0418): the platform's operations, and the tools
// of the extensions the product ships (its packs and the org's own extensions). An extension the
// product does not include is not in its contract, so its client does not type it.
import { buildContract, coreRegistry, toolOperation } from "@composable-os/core";
import type { ApiContract } from "@composable-os/core/http-contract";
import { type Extension, toManifest } from "@composable-os/sdk";

export function productContract(extensions: readonly Extension[]): ApiContract {
  const tools = extensions.flatMap((extension) => {
    const manifest = toManifest(extension);
    return Object.entries(manifest.tools).map(([name, tool]) =>
      toolOperation(manifest, name, tool, "shipped"),
    );
  });
  return buildContract([...coreRegistry.list(), ...tools]);
}
