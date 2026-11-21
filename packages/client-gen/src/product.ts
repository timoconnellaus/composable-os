// A product's contract, from its own registry (ADR 0418): the platform's operations, and the tools
// of the extensions the product ships (its packs and the org's own extensions). An extension the
// product does not include is not in its contract, so its client does not type it.
import { buildContract, coreRegistry, forPacks, toolOperation } from "@composable-os/core";
import type { ApiContract } from "@composable-os/core/http-contract";
import { type Extension, toManifest } from "@composable-os/sdk";

/**
 * A client repo's contract (stage 24, ADR 0422), from the release it deploys rather than from
 * this command's own registry: the release's contract per audience (its client kit's
 * `contract/<audience>.json`), without the tools of packs the product does not list, plus the
 * tools of the org's own extensions. So the client is typed against the host it will call.
 */
export function releaseContract(
  perAudience: readonly ApiContract[],
  packs: readonly string[],
  extensions: readonly Extension[],
): ApiContract {
  const merged = new Map<string, ApiContract["operations"][number]>();
  const own = new Set(extensions.map((e) => toManifest(e).id));
  // The release's files are the union over every pack it carries, each tool named with its pack:
  // the host this repo deploys serves the core operations and the product's packs' tools.
  for (const contract of perAudience.map((c) => forPacks(c, packs))) {
    for (const op of contract.operations) {
      const seen = merged.get(op.name);
      merged.set(
        op.name,
        seen
          ? {
              ...seen,
              audiences: [...new Set([...seen.audiences, ...op.audiences])].sort(),
              invalidates: [...new Set([...seen.invalidates, ...op.invalidates])].sort(),
            }
          : { ...op },
      );
    }
  }
  for (const name of [...merged.keys()]) {
    const [first, id] = name.split(".");
    // An org extension's tools come from its own source below, never from the release's file.
    if (first === "x" && id && own.has(id)) merged.delete(name);
  }
  const tools = extensions.flatMap((extension) => {
    const manifest = toManifest(extension);
    return Object.entries(manifest.tools).map(([name, tool]) =>
      toolOperation(manifest, name, tool, "shipped"),
    );
  });
  for (const op of buildContract(tools).operations) merged.set(op.name, op);
  const version = perAudience[0]?.version ?? "v1";
  return {
    version,
    operations: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function productContract(extensions: readonly Extension[]): ApiContract {
  const tools = extensions.flatMap((extension) => {
    const manifest = toManifest(extension);
    return Object.entries(manifest.tools).map(([name, tool]) =>
      toolOperation(manifest, name, tool, "shipped"),
    );
  });
  return buildContract([...coreRegistry.list(), ...tools]);
}
