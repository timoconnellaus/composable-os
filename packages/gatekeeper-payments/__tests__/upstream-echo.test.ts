// Stripe (or a proxy) echoing what it was sent, in its error message, type and code: the
// gatekeeper quotes the HTTP status and Stripe's error type and code only when each is an
// identifier, so the secret key never reaches its error text.
import { describe, expect, it } from "vitest";
import { StripeProvider } from "../src/stripe.js";

const KEY = "sk_test_s66eStripeSecretAb3dEf6hIj9kLm2n";

describe("Stripe errors naming a long parameter", () => {
  it("keep the parameter (it is not taken for no parameter at all)", async () => {
    const param = "line_items[0][price_data][product_data][tax_code][s66e_long_parameter_name]";
    const provider = new StripeProvider({
      secretKey: KEY,
      webhookSecret: "whsec_s66e_webhook_secret_1234567890",
      apiBase: "https://stripe.test",
      account: "",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", code: "resource_missing", param },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const error = await provider.getPayment("cs_test_s66e").then(
      () => null,
      (e: unknown) => e as { param?: unknown },
    );
    expect(param.length).toBeGreaterThan(60);
    expect(error?.param).toBe(param);
  });
});

describe("Stripe errors from an echoing upstream", () => {
  it("never carry the secret key", async () => {
    const provider = new StripeProvider({
      secretKey: KEY,
      webhookSecret: "whsec_s66e_webhook_secret_1234567890",
      apiBase: "https://stripe.test",
      account: "",
      fetch: async (_input, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            error: {
              type: `invalid ${auth}`,
              code: auth,
              param: auth,
              message: `Invalid API Key provided: ${auth}`,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
    });
    const error = await provider.getPayment("cs_test_s66e").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    const all = JSON.stringify({ message: error?.message, ...(error as object) });
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(-16));
    expect(error?.message).toMatch(/HTTP 401/);
  });
});
