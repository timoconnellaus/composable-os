// The one redactor of provider text (src/ai/redact.ts; the second review of PR #513, S3): for every
// credential an env holds (nested JSON ones included) and every form a provider or a proxy may
// echo it in, the output never contains it; ordinary text is left alone; and a value shorter
// than 8 characters is, by rule, not redacted.
import { describe, expect, it } from "vitest";
import {
  credentialsOf,
  MIN_PREFIX_CHARS,
  MIN_RUN_CHARS,
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

  it(`cuts any run of ${MIN_RUN_CHARS} or more characters of a credential: start, middle, end, and a split key's remainder`, () => {
    const key = "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zA7bC0dE";
    const redact = redactorFor([key]);
    const echoes = {
      start: key.slice(0, 20),
      middle: key.slice(10, 30),
      end: `sk-proj-****${key.slice(-16)}`,
      "split by a line break": `${key.slice(0, 18)}\n    ${key.slice(18)}`,
      "split by a space": `${key.slice(0, 25)} ${key.slice(25)}`,
    };
    for (const [where, echo] of Object.entries(echoes)) {
      const out = redact(`Incorrect API key provided: ${echo} (401)`);
      // No 12 characters of the key survive anywhere, and no more than its last 4 stand alone.
      for (let at = 0; at + MIN_RUN_CHARS <= key.length; at++) {
        expect(out, where).not.toContain(key.slice(at, at + MIN_RUN_CHARS));
      }
      expect(out, where).toContain("Incorrect API key provided:");
      expect(out, where).toContain("(401)");
    }
    // A provider's own short form, its last 4 characters, may stay.
    expect(redact(`key sk-...${key.slice(-4)} is wrong`)).toBe(
      `key sk-...${key.slice(-4)} is wrong`,
    );
  });

  it("never blanks ordinary text for a credential holding an ordinary word or a URL", () => {
    const redact = redactorFor([
      "production-gateway-token-only",
      "https://example.com/hooks/AbC3dE5fG7hI9jK1",
    ]);
    const text =
      "A production-grade setup: see https://example.com/docs and https://example.com/hooks for more.";
    expect(redact(text)).toBe(text);
    // The credential itself, or a long piece of its secret part, is still cut.
    expect(redact("hook https://example.com/hooks/AbC3dE5fG7hI9jK1 failed")).not.toContain(
      "AbC3dE5fG7hI9jK1",
    );
    expect(redact("token production-gateway-token-only expired")).not.toContain(
      "production-gateway-token-only",
    );
  });

  it("cuts a scheme only before a token-shaped value", () => {
    const redact = redactorFor([]);
    for (const text of ["Basic auth is disabled", "Bearer realm=api", "Use Bearer tokens"]) {
      expect(redact(text)).toBe(text);
    }
    expect(redact("Authorization: Bearer abcDEF123456xyz")).toBe("Authorization: Bearer …");
    expect(redact("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe("Authorization: Basic …");
  });

  it("collects *_KEY and *_PASSWORD names, never public ones, and only the gateway's token", () => {
    const secret = "s66e-Ab3dEf6hIj9kLm2n";
    const found = credentialsOf({
      COS_CONTROL_KEY: `${secret}1`,
      COS_ROOT_KEY: `${secret}2`,
      SUPPORT_SIGNING_KEY: `${secret}3`,
      SMTP_PASSWORD: `${secret}4`,
      COS_SUPPORT_PUBLIC_KEY: `${secret}5`,
      TURNSTILE_SITE_KEY: `${secret}6`,
      STREAM_SIGNING_KEY_ID: `${secret}7`,
      AI_CUSTOMER_GATEWAY: JSON.stringify({
        accountId: "a".repeat(32),
        gatewayId: "production",
        token: `${secret}8`,
      }),
    });
    expect(found.sort()).toEqual([1, 2, 3, 4, 8].map((n) => `${secret}${n}`).sort());
    const redact = redactorFor(found);
    expect(redact("gateway production is down")).toBe("gateway production is down");
  });

  it("stays fast on large adversarial text", () => {
    const keys = Array.from({ length: 30 }, (_, n) => `s66e-${n}-${crypto.randomUUID()}-Zx9`);
    const redact = redactorFor(keys);
    const inputs = [
      `Bearer ${"a".repeat(200_000)}`,
      `api_key=${"=".repeat(200_000)}`,
      "api_key ".repeat(25_000),
      `api_key${" ".repeat(200_000)}`,
      (keys[0] as string).slice(0, 11).repeat(18_000),
      (keys[1] as string).slice(3, 15).repeat(16_000),
      "x".repeat(200_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redact(input);
      // About 1 to 3 ms on a laptop; room for a loaded CI machine, none for a quadratic regression.
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(40);
    }
  });
});
