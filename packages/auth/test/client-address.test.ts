// The per-client limit on code requests and sign-in attempts counts an IPv6 client by its /64
// (ADR 0459, a tightening of ADR 0419's limit): stepping through the addresses of one's own
// network does not get round it. IPv4 is counted per address, as before.
import { memoryRateLimit, rateLimit } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import { addressKey, clientAddressBucket } from "../src/better-auth.ts";

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
