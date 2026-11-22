// Secrets, which `wrangler types` cannot see (they are not in wrangler.jsonc). All are optional:
// see deploy-inputs.json.

declare namespace Cloudflare {
  interface Env {
    /** The Stripe secret API key. Without it the Stripe payment account is refused. */
    STRIPE_SECRET_KEY?: string;
    /** The signing secret (`whsec_…`) of the Stripe webhook endpoint posting to `/in/stripe`. */
    STRIPE_WEBHOOK_SECRET?: string;
    /**
     * The fake provider's signing secret, generated at deploy for an environment that turns the
     * fake on. Unset, the public default is used, and only on localhost (ADR 0485).
     */
    FAKE_WEBHOOK_SECRET?: string;
  }
}
