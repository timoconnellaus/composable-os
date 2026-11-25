// The per-client limit on code requests and sign-in attempts counts an IPv6 client by its /64
// (ADR 0459, a tightening of ADR 0419's limit): stepping through the addresses of one's own
// network does not get round it. IPv4 is counted per address, as before.
import { memoryRateLimit, rateLimit } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import {
  addressKey,
  clientAddressBucket,
  clientAddressSecret,
  validClientAddress,
} from "../src/better-auth.ts";

describe("the client address a limit counts", () => {
  it("is an IPv6 address's /64, written out in full or compressed", () => {
    expect(clientAddressBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientAddressBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64",
    );
    expect(clientAddressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientAddressBucket("2001:DB8:1:2::9%eth0")).toBe("2001:db8:1:2::/64");
    expect(clientAddressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressBucket("not-an-address")).toBe("not-an-address");
  });

  it("so two addresses in one /64 share an allowance, and another /64 has its own", async () => {
    const limit = memoryRateLimit(1);
    const key = async (ip: string) => `code-from:${await addressKey(ip, "secret")}`;
    expect((await rateLimit(limit, await key("2001:db8:1:2::1"))).ok).toBe(true);
    expect((await rateLimit(limit, await key("2001:db8:1:2:ffff::2"))).ok).toBe(false);
    expect((await rateLimit(limit, await key("2001:db8:1:3::1"))).ok).toBe(true);
    expect((await rateLimit(limit, await key("203.0.113.7"))).ok).toBe(true);
    expect((await rateLimit(limit, await key("203.0.113.8"))).ok).toBe(true);
  });
});

describe("addresses that are not what they seem (review of PR #459, F3, F5)", () => {
  it("an IPv4-mapped IPv6 address is its IPv4 address, each its own bucket", () => {
    expect(clientAddressBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientAddressBucket("::FFFF:198.51.100.9")).toBe("198.51.100.9");
    expect(clientAddressBucket("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientAddressBucket("::ffff:192.0.2.1")).not.toBe(
      clientAddressBucket("::ffff:192.0.2.2"),
    );
  });

  it("a malformed or over-long value is no address", () => {
    for (const bad of ["everyone", "1.2.3", "300.1.1.1", "1::2::3", "a".repeat(46), "", "::g"]) {
      expect(validClientAddress(bad), bad).toBeNull();
    }
    for (const good of [
      "192.0.2.1",
      "2001:db8::1",
      "::1",
      "::ffff:192.0.2.1",
      "2001:db8:1:2:3:4:5:6",
    ]) {
      expect(validClientAddress(good), good).toBe(good);
    }
  });

  it("an address is never keyed with an empty secret", async () => {
    const empty = clientAddressSecret({});
    expect(empty).not.toBe("client-address\n");
    expect(empty.length).toBeGreaterThan(40);
    expect(clientAddressSecret({})).toBe(empty);
    expect(await addressKey("192.0.2.1", "a")).not.toBe(await addressKey("192.0.2.1", "b"));
  });
});
