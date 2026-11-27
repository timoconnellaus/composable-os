// A client's sender domains in the registry (registry migration 0796; ADR 0616, "Email sending
// per client"): the operator's writes, over any `D1Database` (the registry's binding in a test,
// or D1's REST API from `cos`).
//
// Exported as `@composable-os/db/registry-senders`, never from `@composable-os/db`: packages/core
// and the packs cannot name `@composable-os/db/registry*` (registry-unreachable), and no Worker of
// the host imports it. No operation, route, tool or assistant reaches it: which domains a client
// sends from is identity, set by the operator alone.
//
// A domain is added unverified, then verified once the operator has checked that it is onboarded
// to Email Sending in the deployment's Cloudflare account (its zone on Cloudflare DNS there, and
// the sending records Cloudflare adds in place). Only a verified domain reaches the client's
// environment; a running host stops or starts using a change at its next stamp check (up to
// `REGISTRY_REFRESH_MS`, 10 seconds).
import {
  type ClientId,
  canonicalSenderDomain,
  sameDomainTree,
  validateClientId,
} from "./registry.ts";

/** One of a client's sender domains, as the registry holds it. */
export interface SenderDomainRecord {
  domain: string;
  client: ClientId;
  verified: boolean;
  verifiedAt: string | null;
}

/** Why `domain` cannot be a sender domain, or null when it can. */
export function senderDomainProblem(domain: unknown): string | null {
  if (typeof domain !== "string") return "a sender domain is a string";
  if (canonicalSenderDomain(domain) !== domain) {
    return `${JSON.stringify(domain)} is not a canonical domain (lowercase, at least two labels, no trailing dot)`;
  }
  return null;
}

/**
 * Suffixes under which anyone registers a name (a country's second level, a hosting platform's
 * shared domain): a short built-in list, not the Public Suffix List. A client holding one would
 * hold every name under it, and block every other client's (issue #529, F2).
 */
export const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "co.za",
  "com.br",
  "co.jp",
  "co.in",
  "com.sg",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "blogspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "fly.dev",
  "onrender.com",
]);

/**
 * Mail domains shared by everyone who has an address there: no client sends as one (its own
 * staff's personal addresses are not its domain), nor as a name under one.
 */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "bigpond.com",
  "optusnet.com.au",
]);

/**
 * Why a client may not hold `domain` as a sender domain beyond its shape (issue #529, F2), or null:
 * a single-label top-level domain is refused by its shape already; refused here are a shared
 * suffix (`co.uk`, `github.io`), a shared mail domain (`gmail.com`) or a name under one, and the
 * fleet's own domain or a name of its tree (a client would send as the platform).
 */
export function senderDomainRefusal(
  domain: string,
  options: { fleetDomain?: string | null } = {},
): string | null {
  if (SHARED_SUFFIXES.has(domain)) {
    return `${domain} is a suffix anyone registers under, no one's sender domain`;
  }
  for (const shared of SHARED_MAIL_DOMAINS) {
    if (domain === shared || domain.endsWith(`.${shared}`)) {
      return `${domain} is a shared mail domain (${shared}), no client's`;
    }
  }
  const fleet = options.fleetDomain ? canonicalSenderDomain(options.fleetDomain) : null;
  if (fleet && sameDomainTree(fleet, domain)) {
    return `${domain} is the fleet's own domain (${fleet}), or under or over it: no client sends as the platform`;
  }
  return null;
}

function checkedDomain(domain: string): string {
  const problem = senderDomainProblem(domain);
  if (problem) throw new RangeError(`Not a sender domain: ${problem}`);
  return domain;
}

/** Every sender domain of the registry, or of one client. */
export async function listSenderDomains(
  registry: D1Database,
  client?: string,
): Promise<SenderDomainRecord[]> {
  const statement = client
    ? registry
        .prepare(
          "SELECT domain, client, verified, verified_at FROM registry_sender_domains WHERE client = ? ORDER BY domain",
        )
        .bind(validateClientId(client))
    : registry.prepare(
        "SELECT domain, client, verified, verified_at FROM registry_sender_domains ORDER BY domain",
      );
  const { results } = await statement.all<{
    domain: string;
    client: string;
    verified: number;
    verified_at: string | null;
  }>();
  return results.map((row) => ({
    domain: row.domain,
    client: row.client as ClientId,
    verified: Number(row.verified) === 1,
    verifiedAt: row.verified_at,
  }));
}

/**
 * Adds `domain` to `client`'s sender domains, unverified. Refused, before anything is written,
 * when another client holds it or a domain of its tree (one under or over it); the registry's
 * triggers refuse the same, so two operators writing at once cannot both win. Refused too: a
 * shared suffix, a shared mail domain, and the fleet's own domain (`senderDomainRefusal`).
 */
export async function addSenderDomain(
  registry: D1Database,
  client: string,
  domain: string,
  options: { fleetDomain?: string | null } = {},
): Promise<void> {
  const id = validateClientId(client);
  const name = checkedDomain(domain);
  const refused = senderDomainRefusal(name, options);
  if (refused) throw new RangeError(`Not a sender domain of ${id}: ${refused}`);
  for (const other of await listSenderDomains(registry)) {
    if (other.client === id && other.domain === name) return;
    if (other.client !== id && sameDomainTree(other.domain, name)) {
      throw new Error(
        other.domain === name
          ? `${name} is another client's sender domain (${other.client})`
          : `${name} is under or over ${other.domain}, another client's sender domain (${other.client})`,
      );
    }
  }
  await registry
    .prepare("INSERT INTO registry_sender_domains (domain, client, verified) VALUES (?, ?, 0)")
    .bind(name, id)
    .run();
}

/**
 * Marks `client`'s `domain` verified. The caller (the operator's command) has checked first that
 * the domain is onboarded to Email Sending in the deployment's account; this writes only the
 * registry. Refused when the domain is not the client's.
 */
export async function verifySenderDomain(
  registry: D1Database,
  client: string,
  domain: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  const changed = await registry
    .prepare(
      "UPDATE registry_sender_domains SET verified = 1, verified_at = ? WHERE domain = ? AND client = ?",
    )
    .bind(at, checkedDomain(domain), validateClientId(client))
    .run();
  if (!changed.meta.changes) throw new Error(`${domain} is not a sender domain of ${client}`);
}

/** Marks `client`'s `domain` unverified: the client stops sending from it. */
export async function unverifySenderDomain(
  registry: D1Database,
  client: string,
  domain: string,
): Promise<void> {
  const changed = await registry
    .prepare(
      "UPDATE registry_sender_domains SET verified = 0, verified_at = NULL WHERE domain = ? AND client = ?",
    )
    .bind(checkedDomain(domain), validateClientId(client))
    .run();
  if (!changed.meta.changes) throw new Error(`${domain} is not a sender domain of ${client}`);
}

/** Removes `client`'s `domain`. Removing a client removes its domains with it (ON DELETE CASCADE). */
export async function removeSenderDomain(
  registry: D1Database,
  client: string,
  domain: string,
): Promise<void> {
  await registry
    .prepare("DELETE FROM registry_sender_domains WHERE domain = ? AND client = ?")
    .bind(checkedDomain(domain), validateClientId(client))
    .run();
}
