// What a deployment installs as shipped (stage 24, ADR 0422): the packs its product lists
// (COS_PACKS) and the org's own extensions, pinned by hash in BLOBS (COS_ORG_EXTENSIONS).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  listedPacks,
  orgExtensionsKey,
  shippedExtensions,
} from "../src/extensions/shipped-list.ts";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function putOrg(
  extensions: { id: string; version: string; files: Record<string, string> }[],
) {
  const text = JSON.stringify({ extensions });
  const hash = await sha256Hex(text);
  await env.BLOBS.put(orgExtensionsKey(hash), text);
  return hash;
}

const renewals = {
  id: "renewals",
  version: "0.1.0",
  files: { "index.ts": "export default {}" },
};

describe("the packs a deployment installs", () => {
  it('"*" is every pack in the release; a list is those; "" is none', () => {
    expect(listedPacks("*").map((p) => p.id)).toEqual(["deals", "leads", "lifecycle"]);
    expect(listedPacks(undefined).map((p) => p.id)).toEqual(["deals", "leads", "lifecycle"]);
    expect(listedPacks("deals, lifecycle").map((p) => p.id)).toEqual(["deals", "lifecycle"]);
    expect(listedPacks("")).toEqual([]);
  });
});

describe("the org's own extensions", () => {
  it("are read from BLOBS by the pinned hash and installed after the packs", async () => {
    const hash = await putOrg([renewals]);
    const list = await shippedExtensions({
      COS_PACKS: "",
      COS_ORG_EXTENSIONS: hash,
      BLOBS: env.BLOBS,
    });
    expect(list).toEqual([renewals]);
    const withPacks = await shippedExtensions({
      COS_PACKS: "deals",
      COS_ORG_EXTENSIONS: hash,
      BLOBS: env.BLOBS,
    });
    expect(withPacks.map((e) => e.id)).toEqual(["deals", "renewals"]);
  });

  it("fail closed when the object is not the one the deploy pinned", async () => {
    // A pinned object no call has read yet (a read one is kept for the isolate).
    const hash = await putOrg([{ ...renewals, version: "0.2.0" }]);
    // Someone with access to the bucket replaced it.
    await env.BLOBS.put(orgExtensionsKey(hash), JSON.stringify({ extensions: [] }));
    await expect(shippedExtensions({ COS_ORG_EXTENSIONS: hash, BLOBS: env.BLOBS })).rejects.toThrow(
      /do not match/,
    );
    await expect(
      shippedExtensions({ COS_ORG_EXTENSIONS: "0".repeat(64), BLOBS: env.BLOBS }),
    ).rejects.toThrow(/not in BLOBS/);
  });

  it("may not take a pack's id", async () => {
    const hash = await putOrg([{ ...renewals, id: "deals" }]);
    await expect(
      shippedExtensions({ COS_PACKS: "*", COS_ORG_EXTENSIONS: hash, BLOBS: env.BLOBS }),
    ).rejects.toThrow(/has a pack's id/);
  });

  it("are none when nothing is pinned", async () => {
    expect((await shippedExtensions({ COS_PACKS: "" })).length).toBe(0);
  });
});
