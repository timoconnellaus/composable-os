// The sender-address resource: `email-send://sender/<url-encoded address>`.

import { domainOf, isEmailAddress, parseDomainList } from "./address";

export const SENDER_URL_PATTERN = "email-send://sender/:address";
const SENDER_URL_PREFIX = "email-send://sender/";
const MAX_URL_LENGTH = 1024;

/** The resource URL for a sender address. */
export function senderUrl(address: string): string {
  return SENDER_URL_PREFIX + encodeURIComponent(address);
}

/** The sender address a resource URL names, domain lower-cased. Throws on anything else. */
export function senderFromUrl(url: unknown): string {
  if (
    typeof url !== "string" ||
    url.length > MAX_URL_LENGTH ||
    !url.startsWith(SENDER_URL_PREFIX)
  ) {
    throw new TypeError(`Not a sender address URL; expected ${SENDER_URL_PATTERN}.`);
  }
  let address: string;
  try {
    address = decodeURIComponent(url.slice(SENDER_URL_PREFIX.length));
  } catch {
    throw new TypeError("The sender address URL is not validly encoded.");
  }
  if (!isEmailAddress(address)) {
    throw new TypeError("The sender address URL does not name a plain email address.");
  }
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

/**
 * Whether this gatekeeper serves a host of many clients (`SENDER_DOMAINS_PER_CLIENT`, stage 66):
 * then a sender is allowed only on the domains the host gives for the client of the session, the
 * bind or the apply, and `ALLOWED_SENDER_DOMAINS` is never read (it would be every client's).
 */
export function sendsPerClient(env: { SENDER_DOMAINS_PER_CLIENT?: string }): boolean {
  return env.SENDER_DOMAINS_PER_CLIENT === "true";
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_CLIENT_DOMAINS = 100;

/**
 * The client's verified sender domains as the host gave them (a list of lowercase domains), or
 * null when it gave none or anything else: never a guess, so a malformed answer allows nothing.
 */
export function clientSenderDomains(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CLIENT_DOMAINS) return null;
  const out: string[] = [];
  for (const domain of value) {
    if (typeof domain !== "string" || domain.length > 253 || !DOMAIN.test(domain)) return null;
    out.push(domain);
  }
  return out;
}

/** The refusal when the host gave no domain for the client: nothing is sent. */
export const NO_CLIENT_SENDER_DOMAINS =
  "Refused: this business has no verified sender domain, so email is not sent from it. The " +
  "operator verifies a sender domain for the business first. Nothing was sent.";

/**
 * Throws unless the sender's domain is one of the client's verified `domains` (exactly: not a
 * subdomain). Null or empty: refused. The refusal names only the client's own domains.
 */
export function assertSenderOfClient(sender: string, domains: string[] | null): void {
  if (!domains || domains.length === 0) throw new Error(NO_CLIENT_SENDER_DOMAINS);
  const domain = domainOf(sender);
  if (!domains.includes(domain)) {
    throw new Error(
      `Refused: email can't be sent from ${domain}: it is not one of this business's verified ` +
        `sender domains (${domains.join(", ")}). Nothing was sent.`,
    );
  }
}

/** Throws unless the sender's domain is one of the comma-separated `allowedDomains`. */
export function assertSenderAllowed(sender: string, allowedDomains: string | undefined): void {
  const allowed = parseDomainList(allowedDomains);
  if (allowed.length === 0) {
    throw new Error(
      "No sender domains are configured for email sending: an administrator must set " +
        "ALLOWED_SENDER_DOMAINS on the cos-gatekeeper-email-send Worker.",
    );
  }
  const domain = domainOf(sender);
  if (!allowed.includes(domain)) {
    throw new Error(
      `Email can't be sent from ${domain}. Allowed sender domains: ${allowed.join(", ")}.`,
    );
  }
}
