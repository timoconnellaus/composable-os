// The shipped extensions this deployment installs (stage 24, ADR 0422): the packs bundled with the
// release that the deployment's product lists (COS_PACKS), and the org's own extensions from its
// client repo, which `cos deploy` put in the BLOBS bucket and pinned by hash (COS_ORG_EXTENSIONS).
//
// - COS_PACKS: "*" (the default, a plain install) is the packs the release's own product lists
//   (PRODUCT_PACKS: the CRM's three for a CRM release); otherwise a comma-separated list of pack
//   ids, each of which the release must carry (it carries every pack in the repository, ADR 0420
//   as amended); "" is none, a host with base records only.
// - A listed pack the release does not carry is never dropped: it is a configuration error
//   (`UnknownPackError`), logged when the isolate starts, thrown by every read of the list (so
//   nothing is installed from a list that is wrong) and by the runner's ping, so the host's
//   /api/health says so and is degraded.
// - COS_ORG_EXTENSIONS: the sha256 of `org-extensions/<sha256>.json` in BLOBS, or "" for none.
//   The object is read and checked against the hash, so only what the deploy set is installed;
//   anything else fails closed. Its extensions are shipped extensions: they arrived by a deploy
//   a person ran, as packs do, and install without approval (ADR 0414's `shipped` source).
import { PRODUCT_PACKS, SHIPPED_EXTENSIONS } from "../generated/shipped.ts";

export type ShippedSource = (typeof SHIPPED_EXTENSIONS)[number];

export interface ShippedListEnv {
  COS_PACKS?: string;
  COS_ORG_EXTENSIONS?: string;
  BLOBS?: R2Bucket;
}

/** The R2 key of the org's extensions with this hash. */
export const orgExtensionsKey = (sha256: string) => `org-extensions/${sha256}.json`;

/** COS_PACKS names a pack this release does not carry: a deploy that is wrong, never ignored. */
export class UnknownPackError extends Error {
  constructor(readonly packs: string[]) {
    super(
      `COS_PACKS names ${packs.length === 1 ? "the pack" : "the packs"} ${packs.join(", ")}, which this release does not carry (it carries ${SHIPPED_EXTENSIONS.map((p) => p.id).join(", ") || "none"}). Nothing is installed from this list: deploy a release that has ${packs.length === 1 ? "it" : "them"}, or take ${packs.length === 1 ? "it" : "them"} out of the product's packs.`,
    );
    this.name = "UnknownPackError";
  }
}

/** The pack ids COS_PACKS names: "*" is the release product's own packs. */
function wantedPacks(value: string | undefined): string[] {
  const setting = (value ?? "*").trim();
  if (setting === "*") return [...PRODUCT_PACKS];
  return [
    ...new Set(
      setting
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/** The packs COS_PACKS lists, in the release's order. Throws `UnknownPackError` for one it lacks. */
export function listedPacks(value: string | undefined): readonly ShippedSource[] {
  const wanted = wantedPacks(value);
  const missing = wanted.filter((id) => !SHIPPED_EXTENSIONS.some((pack) => pack.id === id));
  if (missing.length) throw new UnknownPackError(missing);
  return SHIPPED_EXTENSIONS.filter((pack) => wanted.includes(pack.id));
}

/** What is wrong with this deployment's COS_PACKS, or null. Read at boot and by ping. */
export function packsProblem(value: string | undefined): string | null {
  try {
    listedPacks(value);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const orgCache = new Map<string, ShippedSource[]>();

/** The org's own extensions this deployment pins, read from BLOBS and checked. */
export async function orgExtensions(env: ShippedListEnv): Promise<ShippedSource[]> {
  const hash = env.COS_ORG_EXTENSIONS?.trim();
  if (!hash) return [];
  const cached = orgCache.get(hash);
  if (cached) return cached;
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("COS_ORG_EXTENSIONS is not a sha256");
  if (!env.BLOBS) throw new Error("COS_ORG_EXTENSIONS is set and there is no BLOBS bucket");
  const object = await env.BLOBS.get(orgExtensionsKey(hash));
  if (!object) throw new Error(`The org's extensions ${hash} are not in BLOBS: run cos deploy`);
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== hash) {
    throw new Error("The org's extensions in BLOBS do not match COS_ORG_EXTENSIONS");
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    extensions: {
      id: string;
      version: string;
      optional?: boolean;
      files: Record<string, string>;
    }[];
  };
  // `optional`, as for a pack: installed by an admin, not at boot (ADR 0246). Local dev's box
  // office fixture is one (scripts/dev-setup.mjs).
  const list: ShippedSource[] = parsed.extensions.map((e) => ({
    id: e.id,
    version: e.version,
    ...(e.optional === true ? { optional: true } : {}),
    files: e.files,
  }));
  orgCache.set(hash, list);
  return list;
}

/** Everything this deployment installs as shipped: its product's packs, then the org's own. */
export async function shippedExtensions(env: ShippedListEnv): Promise<ShippedSource[]> {
  const packs = listedPacks(env.COS_PACKS);
  const own = await orgExtensions(env);
  const taken = new Set(packs.map((p) => p.id));
  for (const extension of own) {
    if (taken.has(extension.id)) {
      throw new Error(`The org's extension ${extension.id} has a pack's id`);
    }
  }
  return [...packs, ...own];
}
