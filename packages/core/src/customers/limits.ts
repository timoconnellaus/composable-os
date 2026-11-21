// Rate limits for calls from outside the org (stage 22, ADR 0402), on the Workers Rate Limiting
// binding (rate-limit.ts, ADR 0091):
//
// - A customer's calls are limited per account and per operation: `customer:<id>:<operation>`.
// - A request for a sign-in code is limited per address asked for: `code:<address>`, the
//   normalised email address. So nobody can flood one person's inbox, whoever asks.
// - Public calls and code requests are also limited per client address, by Cloudflare's rate
//   limiting rules at the HTTP surface (stage 23). That limit is the edge's: no client address is
//   ever passed here, stored or logged.
//
// A missing binding allows the call (rateLimit logs a warning once), as everywhere else.
import { RateLimitedError } from "../errors.ts";
import type { OutsidePrincipal } from "../principals.ts";
import { type RateLimitBinding, rateLimit } from "../rate-limit.ts";
import { normaliseCustomerEmail } from "./accounts.ts";

function refuse(what: string, retryAfterSeconds: number): never {
  throw new RateLimitedError(`Too many ${what}; retry in ${retryAfterSeconds}s`, {
    retryAfterSeconds,
  });
}

/**
 * Counts one call by a customer or the public. A customer over their limit for this operation
 * gets a RateLimitedError. A public call has no account to key on: it is limited per client
 * address at the edge, and passes here.
 */
export async function checkOutsideRateLimit(
  binding: RateLimitBinding | undefined,
  principal: OutsidePrincipal,
  operation: string,
): Promise<void> {
  if (principal.kind !== "customer") return;
  const result = await rateLimit(binding, `customer:${principal.customerId}:${operation}`);
  if (!result.ok) refuse("calls", result.retryAfterSeconds);
}

/**
 * Counts one request for a sign-in code to `email`, keyed by the normalised address. An address
 * that is not one is not counted (nothing will be sent to it). Over the limit: RateLimitedError.
 */
export async function checkCodeRequestLimit(
  binding: RateLimitBinding | undefined,
  email: string,
): Promise<void> {
  const address = normaliseCustomerEmail(email);
  if (!address) return;
  const result = await rateLimit(binding, `code:${address}`);
  if (!result.ok) refuse("sign-in code requests", result.retryAfterSeconds);
}
