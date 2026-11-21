// What a deployment installs as shipped (stage 24, ADR 0422): the packs its product lists
// (COS_PACKS) and the org's own extensions, pinned by hash in BLOBS (COS_ORG_EXTENSIONS).
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  listedPacks,
  orgExtensionsKey,
  packsProblem,
  shippedExtensions,
  UnknownPackError,
} from "../src/extensions/shipped-list.ts";
import { PRODUCT_PACKS, SHIPPED_EXTENSIONS } from "../src/generated/shipped.ts";
import Runner from "../src/index.ts";

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
  it("the release carries every pack in the repository, Ticketing among them", () => {
    const carried = SHIPPED_EXTENSIONS.map((p) => p.id);
    expect(carried).toEqual(expect.arrayContaining(["deals", "leads", "lifecycle", "ticketing"]));
    // This runner is built for the CRM: its product's packs are what "*" installs.
    expect([...PRODUCT_PACKS]).toEqual(["deals", "leads", "lifecycle"]);
  });

  it('"*" is the release product\'s packs (the CRM\'s, as before); a list is those; "" is none', () => {
    expect(listedPacks("*").map((p) => p.id)).toEqual(["deals", "leads", "lifecycle"]);
    expect(listedPacks(undefined).map((p) => p.id)).toEqual(["deals", "leads", "lifecycle"]);
    // A CRM deployment has none of Ticketing until a deploy names it.
    expect(listedPacks("*").map((p) => p.id)).not.toContain("ticketing");
    expect(listedPacks("deals, lifecycle").map((p) => p.id)).toEqual(["deals", "lifecycle"]);
    expect(listedPacks("ticketing").map((p) => p.id)).toEqual(["ticketing"]);
    expect(listedPacks("")).toEqual([]);
  });

  it('a listed pack is installed at boot: `optional` holds only for the release product\'s "*"', () => {
    const optional = (value: string, id: string) =>
      listedPacks(value).find((p) => p.id === id)?.optional;
    // The CRM's own catalogue: lifecycle stays an admin's choice (ADR 0246).
    expect(optional("*", "lifecycle")).toBe(true);
    // A product that names it, or Content and Programs, gets them installed.
    expect(optional("lifecycle", "lifecycle")).toBeUndefined();
    expect(optional("content,programs", "content")).toBeUndefined();
    expect(optional("content,programs", "programs")).toBeUndefined();
  });

  it("a pack the release does not carry is a loud failure, never dropped", async () => {
    expect(() => listedPacks("deals, tickets")).toThrow(UnknownPackError);
    expect(() => listedPacks("tickets")).toThrow(
      /COS_PACKS names the pack tickets, which this release does not carry/,
    );
    expect(packsProblem("tickets")).toMatch(/does not carry/);
    expect(packsProblem("deals")).toBeNull();
    // Nothing is installed from a list that is wrong: the whole read fails.
    await expect(shippedExtensions({ COS_PACKS: "deals,tickets" })).rejects.toThrow(
      UnknownPackError,
    );
  });

  it("the runner's ping fails with it, so /api/health is degraded, and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = new Runner(createExecutionContext(), { ...env, COS_PACKS: "tickets" } as Env);
    await expect(runner.ping()).rejects.toThrow(/COS_PACKS names the pack tickets/);
    expect(errors.mock.calls.flat().join("\n")).toMatch(
      /cos-runner: COS_PACKS names the pack tickets/,
    );
    errors.mockRestore();
    const fine = new Runner(createExecutionContext(), { ...env, COS_PACKS: "ticketing" } as Env);
    await expect(fine.ping()).resolves.toMatchObject({ ok: true });
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

  it("keep `optional`, so an admin installs one (local dev's box office, stage 27)", async () => {
    const hash = await putOrg([{ ...renewals, id: "optin", optional: true } as typeof renewals]);
    const list = await shippedExtensions({
      COS_PACKS: "",
      COS_ORG_EXTENSIONS: hash,
      BLOBS: env.BLOBS,
    });
    expect(list).toEqual([{ ...renewals, id: "optin", optional: true }]);
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
