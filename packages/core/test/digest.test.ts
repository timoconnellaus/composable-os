// Bytes as text and SHA-256, one helper each: text and bytes give the same digest, and base64url
// round-trips with no padding, as the copies they replaced did.
import { describe, expect, it } from "vitest";
import { base64url, fromBase64url, sha256Hex, toHex } from "../src/digest.ts";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes text as UTF-8, and bytes as they are", async () => {
    expect(await sha256Hex("abc")).toBe(ABC);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC);
    expect(await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]).buffer)).toBe(ABC);
    expect(await sha256Hex("é")).toBe(await sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });

  it("writes bytes as two lowercase hex characters each", () => {
    expect(toHex(new Uint8Array([0, 10, 255]))).toBe("000aff");
    expect(toHex(new Uint8Array([1, 2, 3]).buffer)).toBe("010203");
  });
});

describe("base64url", () => {
  it("writes the URL alphabet with no padding, and reads it back padded or not", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x01]);
    expect(base64url(bytes)).toBe("-__-AQ");
    expect(base64url(bytes.buffer)).toBe("-__-AQ");
    expect([...fromBase64url("-__-AQ")]).toEqual([...bytes]);
    expect([...fromBase64url("+//+AQ==")]).toEqual([...bytes]);
  });
});
