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
 * triggers refuse the same, so two operators writing at once cannot both win.
 */
export async function addSenderDomain(
  registry: D1Database,
  client: string,
  domain: string,
): Promise<void> {
  const id = validateClientId(client);
  const name = checkedDomain(domain);
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
