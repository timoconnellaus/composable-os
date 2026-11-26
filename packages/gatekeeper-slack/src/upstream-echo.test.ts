// Slack (or a proxy) putting what it was sent into its `error` field: the gatekeeper quotes an
// error code only, so a token, a refresh token or the client secret never reaches its error text.
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode, refreshAccessToken, SlackApi, slackCode } from "./slack-api";

const SECRET = "s66e-slack-client-secret-Ab3dEf6hIj9";
const REFRESH = "xoxe-1-s66e-refresh-Zx9Yw8Vu7Ts6Rq5";
const TOKEN = "xoxp-s66e-user-token-Qw1Er2Ty3Ui4";

afterEach(() => vi.unstubAllGlobals());

function echoing() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const sent = `${String(init?.body ?? "")} ${headers.get("authorization") ?? ""}`;
      return new Response(JSON.stringify({ ok: false, error: `bad request: ${sent}` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function messageOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("Slack gatekeeper errors from an echoing upstream", () => {
  it("quote an error code only, never what was sent", async () => {
    echoing();
    const messages = [
      await messageOf(exchangeAuthCode("s66e-code-1234567890", "client-id", SECRET, "https://cb.example")),
      await messageOf(refreshAccessToken(REFRESH, "client-id", SECRET)),
      await messageOf(new SlackApi(async () => TOKEN).getUser("U0123")),
    ];
    for (const message of messages) {
      for (const secret of [SECRET, REFRESH, TOKEN, "s66e-code-1234567890"]) {
        expect(message, message).not.toContain(secret);
        expect(message, message).not.toContain(encodeURIComponent(secret));
      }
    }
    expect(slackCode("channel_not_found")).toBe("channel_not_found");
    expect(slackCode(`echo ${SECRET}`)).toBeUndefined();
  });
});
