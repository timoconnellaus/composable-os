// Secrets, which `wrangler types` cannot see (they are not in wrangler.jsonc). Both are optional:
// see deploy-inputs.json.

declare namespace Cloudflare {
  interface Env {
    /** The Stripe secret API key. Without it the Stripe payment account is refused. */
    STRIPE_SECRET_KEY?: string;
    /** The signing secret (`whsec_…`) of the Stripe webhook endpoint posting to `/in/stripe`. */
    STRIPE_WEBHOOK_SECRET?: string;
  }
}
