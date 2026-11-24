import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackLog, fakeSlackFetch, resetSlack, slack } from "./fake-slack";
import { connect, newHost, WORKSPACE_URL } from "./helpers";
import { submissions } from "./worker";

beforeEach(() => {
  resetSlack();
  submissions.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeSlackFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a revoked bot token", () => {
  it("expires a grant with no refresh token and tells the Workshop once", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    await host.open(accountId, WORKSPACE_URL);
    await host.call("post", [{ channel: "#general", text: "one" }]);
    await host.call("post", [{ channel: "#general", text: "two" }]);
    callbackLog.length = 0;
    // The workspace revokes the app: Slack refuses the only token there is.
    slack.tokens.clear();

    await expect(host.apply(1)).rejects.toThrow(/has expired\. Reconnect it/);
    await expect(host.apply(2)).rejects.toThrow(/has expired\. Reconnect it/);
    expect(callbackLog).toEqual([{ kind: "expired" }]);
    expect(slack.posts).toEqual([]);
  });
});
