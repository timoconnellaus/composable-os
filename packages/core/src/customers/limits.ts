// Rate limits for calls from outside the org (stage 22, ADR 0402), on the Workers Rate Limiting
// binding (rate-limit.ts, ADR 0091):
//
// - A customer's calls are limited per account and per operation: `customer:<id>:<operation>`.
// - A request for a sign-in code is limited per address asked for: `code:<mailbox>`, the
//   normalised email address with a `+tag` (and Gmail's dots) folded away (ADR 0459). So nobody can
//   flood one person's inbox, whoever asks, nor get round the limit with tags.
// - Public calls and code requests are also limited per client address, by Cloudflare's rate
//   limiting rules at the HTTP surface (stage 23). That limit is the edge's: no client address is
//   ever passed here, stored or logged.
//
// A missing binding allows the call (rateLimit logs a warning once), as everywhere else.
import { RateLimitedError } from "../errors.ts";
import type { DevicePrincipal, OutsidePrincipal } from "../principals.ts";
import { type RateLimitBinding, rateLimit } from "../rate-limit.ts";
import { normaliseCustomerEmail } from "./accounts.ts";

function refuse(what: string, retryAfterSeconds: number): never {
  throw new RateLimitedError(`Too many ${what}; retry in ${retryAfterSeconds}s`, {
    retryAfterSeconds,
  });
}

/**
 * Counts one call by a customer, a practitioner, the public or an enrolled device. A customer (or a
 * practitioner) over their limit
 * for this operation gets a RateLimitedError, and so does a device (ADR 0781: per device and
 * operation, beside the desk origin's own limit per address). A public call has no account to
 * key on: it is limited per client address at the edge, and passes here.
 */
export async function checkOutsideRateLimit(
  binding: RateLimitBinding | undefined,
  principal: OutsidePrincipal | DevicePrincipal,
  operation: string,
): Promise<void> {
  if (principal.kind === "public") return;
  const key =
    principal.kind === "customer"
      ? `customer:${principal.customerId}:${operation}`
      : principal.kind === "practitioner"
        ? // Per account, as a customer's (ADR 0581).
          `practitioner:${principal.practitionerId}:${operation}`
        : `device:${principal.deviceId}:${operation}`;
  const result = await rateLimit(binding, key);
  if (!result.ok) refuse("calls", result.retryAfterSeconds);
}

const DOTLESS_DOMAINS: Readonly<Record<string, string>> = {
  "gmail.com": "gmail.com",
  "googlemail.com": "gmail.com",
};

/**
 * The mailbox an address most likely reaches, for counting requests only (ADR 0459): a `+tag`
 * dropped on every domain, and on Gmail the dots too (`googlemail.com` is `gmail.com`). So
 * `a+1@x.com` and `a+2@x.com` share one allowance. Never an identity: the account, the Person and
 * the address mailed stay as typed.
 */
export function mailboxKey(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  const dotless = DOTLESS_DOMAINS[domain];
  if (dotless) {
    domain = dotless;
    local = local.replaceAll(".", "") || local;
  }
  return `${local}@${domain}`;
}

/**
 * Counts one request for a sign-in code to `email`, keyed by the mailbox it reaches
 * (`mailboxKey` of the normalised address). An address that is not one is not counted (nothing
 * will be sent to it). Over the limit: RateLimitedError.
 */
export async function checkCodeRequestLimit(
  binding: RateLimitBinding | undefined,
  email: string,
): Promise<void> {
  const address = normaliseCustomerEmail(email);
  if (!address) return;
  const result = await rateLimit(binding, `code:${mailboxKey(address)}`);
  if (!result.ok) refuse("sign-in code requests", result.retryAfterSeconds);
}
