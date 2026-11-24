// The one SHA-256 helper: text and bytes give the same digest, as the copies it replaced did.
import { describe, expect, it } from "vitest";
import { sha256Hex, toHex } from "../src/digest.ts";

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
