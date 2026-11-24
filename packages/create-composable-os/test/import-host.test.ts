// The import door's host client (src/import-door/host.ts): what a person reads when a call fails.
import { describe, expect, it } from "vitest";
import { sessionHost } from "../src/import-door/host.ts";

const page = (status: number) =>
  (async () =>
    new Response("<html><body>Bad gateway</body></html>", {
      status,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

describe("sessionHost", () => {
  it("names the call and the status when the host answers with an error page, not JSON", async () => {
    const host = sessionHost("https://admin.example.com", async () => ({}), page(502));
    const slow = sessionHost("https://admin.example.com", async () => ({}), page(524));
    await expect(host.call("record.import", {})).rejects.toThrow("record.import: HTTP 502");
    await expect(slow.upload(new Uint8Array([1]), "cover.png")).rejects.toThrow(
      "cover.png: HTTP 524",
    );
  });
});
