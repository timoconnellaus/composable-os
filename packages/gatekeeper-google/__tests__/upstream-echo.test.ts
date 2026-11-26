// A Google endpoint (or a proxy) that echoes what it was sent, in its error description and in its
// body: the gatekeeper's error quotes only Google's code and description, scrubbed of the client
// secret, the refresh token, the code and the access token, and never the raw body.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarApi } from "../src/calendar-api";
import { exchangeAuthCode, getAccessToken } from "../src/google-api";

const SECRET = "s66e-google-client-secret-Ab3dEf6hIj9";
const REFRESH = "1//s66e-refresh-token-Zx9Yw8Vu7Ts6Rq5";
const CODE = "4/s66e-auth-code-Mn4Lk3Jh2Gf1Dd0";
const ACCESS = "ya29.s66e-access-token-Qw1Er2Ty3Ui4";

/** A stub that answers 400 with everything it was sent, as JSON or as plain text. */
function echoing(json: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    const sent = `${String(init?.body ?? "")} ${[...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("; ")}`;
    const body = json
      ? JSON.stringify({ error: "invalid_request", error_description: `You sent ${sent}`, raw: sent, error_uri: String(input) })
      : `upstream proxy echo: ${sent}`;
    return new Response(body, {
      status: 400,
      headers: { "content-type": json ? "application/json" : "text/plain" },
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function messageOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

const forms = (s: string) => [s, encodeURIComponent(s), s.slice(0, 14), s.slice(-14)];

describe("Google gatekeeper errors from an echoing upstream", () => {
  for (const json of [true, false]) {
    it(`never carry what was sent (${json ? "JSON" : "plain text"} body)`, async () => {
      echoing(json);
      const messages = [
        await messageOf(exchangeAuthCode(CODE, "client-id", SECRET, "https://cb.example/oauth")),
        await messageOf(getAccessToken(REFRESH, "client-id", SECRET)),
        await messageOf(new GoogleCalendarApi(async () => ACCESS).listCalendars()),
      ];
      for (const message of messages) {
        expect(message).toMatch(/failed: 400/);
        expect(message).not.toContain("upstream proxy echo");
        for (const secret of [SECRET, REFRESH, CODE, ACCESS]) {
          for (const form of forms(secret)) expect(message, `${form} in ${message}`).not.toContain(form);
        }
      }
    });
  }
});
