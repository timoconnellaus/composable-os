// The env cos-app's `ClientApp` entrypoint runs with in tests (stage 24): the test pool's env with
// customer sign-in on, for the web app at WEB_ORIGIN, and the codes the host would email kept
// here. The entrypoint itself is the real one (test/worker.ts only hands it this env).
import { getCustomerIdentity } from "@composable-os/auth";
import { memoryRateLimit } from "@composable-os/core";
import type { ApiEnv } from "../src/server/http/api.ts";

/** The company's web app, where customer cookies live. */
export const WEB_ORIGIN = "https://shop.test";
export const BOUND_CUSTOMER_SECRET = "customer-secret-for-the-binding-789";

/** Codes the host would have emailed, by address (lower case). */
export const sentCodes = new Map<string, string>();

let cached: ApiEnv | null = null;

/** One env object for every call, so cos-app's per-env caches (and the one below) hold. */
export function boundTestEnv(base: object): ApiEnv {
  if (cached) return cached;
  const env = {
    ...base,
    IDENTITY_PROVIDER: "better-auth",
    AUTH_ALLOW_SIGNUP: "true",
    MCP_RATE_LIMIT: memoryRateLimit(10_000),
    MCP_WRITE_RATE_LIMIT: memoryRateLimit(10_000),
    CUSTOMER_AUTH_SECRET: BOUND_CUSTOMER_SECRET,
    CUSTOMER_AUTH_URL: WEB_ORIGIN,
  } as unknown as ApiEnv;
  // cos-app builds customer sign-in once per env and sends codes through the customer mail
  // connection; built here first, the same identity hands the codes to the tests instead.
  getCustomerIdentity(env, async ({ to, code }) => {
    sentCodes.set(to.toLowerCase(), code);
  });
  cached = env;
  return cached;
}
