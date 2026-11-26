// ZoomInfo (or a proxy) echoing what it was sent, in its error description and its JSON:API
// errors: the gatekeeper quotes the code and description only, scrubbed of the client secret, the
// refresh token, the code and the access token, and keeps no raw body on the error.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthCode,
  refreshAccessToken,
  ZoomInfoApi,
  ZoomInfoApiError,
} from "../src/zoominfo-api";

const SECRET = "s66e-zoominfo-client-secret-Ab3dEf6hIj9";
const REFRESH = "s66e-zoominfo-refresh-Zx9Yw8Vu7Ts6Rq5";
const CODE = "s66e-zoominfo-code-Mn4Lk3Jh2Gf1Dd0";
const ACCESS = "s66e-zoominfo-access-Qw1Er2Ty3Ui4Op5";

afterEach(() => {
  vi.restoreAllMocks();
});

function echoing() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const sent = `${String(init?.body ?? "")} ${headers.get("authorization") ?? ""}`;
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: `you sent ${decodeURIComponent(sent)}`,
        errors: [{ detail: `you sent ${sent}` }],
        raw: sent,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
}

async function errorOf(work: Promise<unknown>): Promise<ZoomInfoApiError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ZoomInfoApiError);
  return error as ZoomInfoApiError;
}

describe("ZoomInfo gatekeeper errors from an echoing upstream", () => {
  it("never carry what was sent", async () => {
    echoing();
    const url = "https://zoominfo.test/token";
    const errors = [
      await errorOf(
        exchangeAuthCode(CODE, "verifier-s66e", "https://cb.example", "id", SECRET, url),
      ),
      await errorOf(refreshAccessToken(REFRESH, "id", SECRET, url)),
      await errorOf(new ZoomInfoApi(async () => ACCESS, "https://zoominfo.test").get("/lookup")),
    ];
    for (const error of errors) {
      expect(error.details).toBeUndefined();
      for (const secret of [SECRET, REFRESH, CODE, ACCESS]) {
        for (const form of [
          secret,
          encodeURIComponent(secret),
          secret.slice(0, 14),
          secret.slice(-14),
        ]) {
          expect(error.message, error.message).not.toContain(form);
        }
      }
    }
  });
});
