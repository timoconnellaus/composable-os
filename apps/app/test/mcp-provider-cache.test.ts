// The OAuth providers an isolate keeps (the second review of #512, minor; #515): one per
// environment and origin, at most `OAUTH_ORIGINS_KEPT` origins, the least recently used dropped
// first. A request's origin is its Host, which a caller chooses, so without a bound the cache
// would grow with every name sent.
import { describe, expect, it } from "vitest";
import { keptFor, OAUTH_ORIGINS_KEPT } from "../src/server/mcp/handler.ts";
import { appFor, ORIGIN, testEnv } from "./mcp-helpers.ts";

describe("the OAuth provider cache", () => {
  it("keeps at most OAUTH_ORIGINS_KEPT origins, dropping the least recently used", () => {
    const map = new Map<string, number>();
    let made = 0;
    const get = (key: string) => keptFor(map, key, () => ++made);
    expect(get("first")).toBe(1);
    for (let i = 0; i < OAUTH_ORIGINS_KEPT - 1; i++) get(`o-${i}`);
    expect(map.size).toBe(OAUTH_ORIGINS_KEPT);
    // Used again: it is the most recent, so the next new origin drops `o-0`, not it.
    expect(get("first")).toBe(1);
    get("one-more");
    expect(map.size).toBe(OAUTH_ORIGINS_KEPT);
    expect(map.has("first")).toBe(true);
    expect(map.has("o-0")).toBe(false);
    // A dropped one is made again on its next use.
    const before = made;
    get("o-0");
    expect(made).toBe(before + 1);
  });

  it("answers as before at an origin dropped from the cache", async () => {
    const fetchApp = appFor(testEnv());
    const metadata = (origin: string) =>
      fetchApp(new Request(`${origin}/.well-known/oauth-authorization-server`));
    const first = await (await metadata(ORIGIN)).json();
    for (let i = 0; i <= OAUTH_ORIGINS_KEPT; i++) await metadata(`https://h${i}.example`);
    expect(await (await metadata(ORIGIN)).json()).toEqual(first);
  });
});
