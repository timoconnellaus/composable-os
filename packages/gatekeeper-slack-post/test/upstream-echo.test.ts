// Slack (or a proxy) putting what it was sent into its `error` field: the gatekeeper quotes an
// error code only, so the bot token, a refresh token or the client secret never reaches its error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { callSlack, SlackApiError } from "../src/slack-api";

const TOKEN = "xoxb-s66e-bot-token-Ab3dEf6hIj9kLm2n";
const SECRET = "s66e-slack-post-client-secret-Zx9Yw8";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Slack posting errors from an echoing upstream", () => {
  it("quote an error code only, never what was sent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const sent = `${String(init?.body ?? "")} ${headers.get("authorization") ?? ""}`;
      return new Response(JSON.stringify({ ok: false, error: `invalid: ${sent}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const error = await callSlack(
      { apiBase: "https://slack.test/api", oauthBase: "https://slack.test/oauth" },
      "oauth.v2.access",
      { client_secret: SECRET, refresh_token: "xoxe-s66e-refresh-1234567890" },
      TOKEN,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SlackApiError);
    const message = (error as Error).message;
    expect(message).toBe("Slack oauth.v2.access failed: unknown_error");
    for (const secret of [TOKEN, SECRET, "xoxe-s66e-refresh-1234567890"]) {
      expect(message).not.toContain(secret);
    }
  });
});
