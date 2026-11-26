// The host's proofs (review of #512, S1): the synchronous SHA-256 and HMAC agree with WebCrypto,
// and a proof is bound to its purpose, its parts and the key.
import { describe, expect, it } from "vitest";
import {
  bindingProof,
  hmacSha256,
  hostBindingKey,
  isBindingProof,
  PROOF,
  sha256,
} from "../src/client-proofs.ts";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("SHA-256 and HMAC-SHA256", () => {
  it("agree with WebCrypto for every length around the block edges", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(length));
      expect(hex(sha256(data)), String(length)).toBe(
        hex(await crypto.subtle.digest("SHA-256", data)),
      );
      for (const keyLength of [16, 64, 100]) {
        const key = crypto.getRandomValues(new Uint8Array(keyLength));
        const webKey = await crypto.subtle.importKey(
          "raw",
          key,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        expect(hex(hmacSha256(key, data))).toBe(
          hex(await crypto.subtle.sign("HMAC", webKey, data)),
        );
      }
    }
    expect(hex(sha256(encoder.encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("a binding proof", () => {
  const key = "k".repeat(40);
  it("is bound to its purpose, its parts and the key", () => {
    const proof = bindingProof(key, PROOF.clientApp, "gym-a");
    expect(isBindingProof(key, proof, PROOF.clientApp, "gym-a")).toBe(true);
    expect(isBindingProof(key, proof, PROOF.clientApp, "gym-b")).toBe(false);
    expect(isBindingProof(key, proof, PROOF.callback, "gym-a")).toBe(false);
    expect(isBindingProof(`${key}x`, proof, PROOF.clientApp, "gym-a")).toBe(false);
    expect(isBindingProof(null, proof, PROOF.clientApp, "gym-a")).toBe(false);
    expect(isBindingProof(key, undefined, PROOF.clientApp, "gym-a")).toBe(false);
    // Parts are length-prefixed: moving a separator gives another proof.
    expect(bindingProof(key, PROOF.object, "gym-a", "b:c")).not.toBe(
      bindingProof(key, PROOF.object, "gym-a:b", "c"),
    );
  });

  it("needs a host key of 32 characters at least", () => {
    expect(hostBindingKey({ COS_BINDING_KEY: "short" })).toBeNull();
    expect(hostBindingKey({})).toBeNull();
    expect(hostBindingKey({ COS_BINDING_KEY: key })).toBe(key);
  });
});
