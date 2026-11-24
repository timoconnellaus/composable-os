// Secrets, which `wrangler types` cannot see (they are not in wrangler.jsonc). See
// deploy-inputs.json.

declare namespace Cloudflare {
  interface Env {
    /**
     * The fake provider's signing secret, generated at deploy for an environment that turns the
     * fake on. Unset, the public default is used, and only on localhost.
     */
    FAKE_WEBHOOK_SECRET?: string;
  }
}
