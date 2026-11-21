// ADR 0455, amended by ADR 0470: where the native staff sign-in may send its one-time code. A
// listed address, exactly; or, for a command-line tool that listens on a port of its own
// (`cos content import`), a listed loopback address with no port, on any port (RFC 8252, 7.3).
import { describe, expect, it } from "vitest";
import { nativeRedirectAllowed } from "../src/index.ts";

describe("native sign-in redirects", () => {
  const listed = ["gym://staff-sign-in", "http://127.0.0.1/cos-sign-in"];

  it("takes a listed address exactly, and a listed loopback address on any port", () => {
    expect(nativeRedirectAllowed(listed, "gym://staff-sign-in")).toBe(true);
    expect(nativeRedirectAllowed(listed, "http://127.0.0.1:53211/cos-sign-in")).toBe(true);
    expect(
      nativeRedirectAllowed(["http://[::1]/cos-sign-in"], "http://[::1]:4000/cos-sign-in"),
    ).toBe(true);
  });

  it("refuses anything else: another host, a name, https, another path, a query, no port", () => {
    for (const asked of [
      "gym://staff-sign-in/x",
      "http://localhost:53211/cos-sign-in",
      "http://127.0.0.2:53211/cos-sign-in",
      "https://127.0.0.1:53211/cos-sign-in",
      "http://127.0.0.1:53211/other",
      "http://127.0.0.1:53211/cos-sign-in?next=https://evil.test",
      "http://127.0.0.1:53211/cos-sign-in#x",
      "http://user@127.0.0.1:53211/cos-sign-in",
      "http://127.0.0.1/cos-sign-in/../evil",
      "http://evil.test:53211/cos-sign-in",
      "not a url",
    ]) {
      expect(nativeRedirectAllowed(listed, asked), asked).toBe(false);
    }
    // A loopback address is not taken on any port unless one is listed with no port.
    expect(
      nativeRedirectAllowed(
        ["http://127.0.0.1:8080/cos-sign-in"],
        "http://127.0.0.1:9090/cos-sign-in",
      ),
    ).toBe(false);
    expect(nativeRedirectAllowed([], "http://127.0.0.1:53211/cos-sign-in")).toBe(false);
  });
});
