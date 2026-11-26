// The one redactor of provider text (src/ai/redact.ts; the second review of PR #513, S3): for every
// credential an env holds (nested JSON ones included) and every form a provider or a proxy may
// echo it in, the output never contains it; ordinary text is left alone; and a value shorter
// than 8 characters is, by rule, not redacted.
import { describe, expect, it } from "vitest";
import {
  credentialsOf,
  MIN_PREFIX_CHARS,
  MIN_SECRET_CHARS,
  redactError,
  redactorFor,
  redactorForEnv,
  withoutKeys,
} from "../src/index.ts";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const b64url = (text: string) =>
  b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Every form of `key` a provider might send back, by name. */
function encodings(key: string): Record<string, string> {
  return {
    plain: key,
    url: encodeURIComponent(key),
    json: JSON.stringify(key).slice(1, -1),
    "json-slashes": JSON.stringify(key).slice(1, -1).replace(/\//g, "\\/"),
    base64: b64(key),
    base64url: b64url(key),
    "basic user:key": b64(`user:${key}`),
    "basic apikey:key, url-safe": b64url(`apikey:${key}`),
    "basic :key": b64(`:${key}`),
    "first 20 characters": key.slice(0, 20),
    [`first ${MIN_PREFIX_CHARS} characters`]: key.slice(0, MIN_PREFIX_CHARS),
  };
}

/** Fake credentials of every shape a provider uses: `+ / =`, dashes, long JSON keys. */
const KEYS: [string, string, string, string] = [
  `sk-proj-s66e${"A1b2C3d4E5f6".repeat(3)}`,
  "s66e/fake+key=with/slashes+and=pluses0123456789",
  "AIzaS66eFakeGoogleKey_0123456789abcdefghij",
  `s66e-${crypto.randomUUID()}-${crypto.randomUUID()}`,
];

const GATEWAY_TOKEN = `s66e-gateway-token-${crypto.randomUUID()}`;

const env = {
  AI_KEY_OPENAI: KEYS[0],
  AI_KEY_CUSTOM: KEYS[1],
  AI_KEY_GOOGLE: KEYS[2],
  TYPESAFE_API_KEY: KEYS[3],
  AI_CUSTOMER_GATEWAY: JSON.stringify({
    accountId: "0123456789abcdef0123456789abcdef",
    gatewayId: "s66e-gateway",
    token: GATEWAY_TOKEN,
  }),
  // Not credentials: never collected.
  AI_PROVIDERS: "openai,google",
  COS_PRODUCT_LABEL: "Composable OS",
};

describe("the provider-text redactor", () => {
  it("finds every credential of an env, the ones nested in its JSON values included", () => {
    const found = credentialsOf(env);
    for (const key of [...KEYS, GATEWAY_TOKEN]) expect(found, key).toContain(key);
    expect(found).not.toContain("openai,google");
    expect(found).not.toContain("Composable OS");
  });

  it("never lets any form of any credential through", () => {
    const redact = redactorForEnv(env);
    for (const key of [...KEYS, GATEWAY_TOKEN]) {
      for (const [form, text] of Object.entries(encodings(key))) {
        const out = redact(`The provider said: ${text} (status 401)`);
        expect(out, `${form} of ${key}`).not.toContain(text);
        // Nor any 12 characters running on from the key's start.
        expect(out, `${form} of ${key}`).not.toContain(key.slice(0, MIN_PREFIX_CHARS));
        expect(out).toContain("The provider said:");
      }
    }
    // As a header, a query string, a JSON body and an error object.
    const echoed = [
      `authorization: Bearer ${KEYS[0]}`,
      `Authorization: Basic ${b64(`user:${KEYS[1]}`)}`,
      `https://api.example/v1?key=${encodeURIComponent(KEYS[2])}&alt=json`,
      `{"error":{"message":"bad key ${JSON.stringify(KEYS[1]).slice(1, -1).replace(/\//g, "\\/")}"}}`,
      `cf-aig-authorization: ${GATEWAY_TOKEN}`,
    ];
    for (const line of echoed) {
      const out = redact(line);
      for (const key of [...KEYS, GATEWAY_TOKEN]) {
        for (const text of Object.values(encodings(key))) expect(out, line).not.toContain(text);
      }
    }
    const error = withoutKeys(new TypeError(`fetch failed for ${KEYS[3]}`), env);
    expect(error.message).not.toContain(KEYS[3]);
    expect(error.name).toBe("TypeError");
  });

  it("leaves ordinary text alone, and keeps an error that holds no credential", () => {
    const redact = redactorForEnv(env);
    const text =
      "The summarise role cannot use that model: OpenAI gpt-4.1-mini is not in the model catalogue (429 rate limited, retry in 30 s).";
    expect(redact(text)).toBe(text);
    const plain = new RangeError("no key here");
    expect(redactError(plain, redact)).toBe(plain);
  });

  it(`does not redact a value shorter than ${MIN_SECRET_CHARS} characters (it would cut ordinary words)`, () => {
    expect(MIN_SECRET_CHARS).toBe(8);
    const redact = redactorFor(["short1"]);
    expect(redact("a short1 value")).toBe("a short1 value");
    expect(credentialsOf({ AI_KEY_X: "abc" })).toEqual([]);
  });
});
