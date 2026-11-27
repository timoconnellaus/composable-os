// A host of many clients on Cloudflare's edge (stage 66 step 8, ADR 0619): how the hostnames the
// registry records reach the right Worker, set by `cos` alone with the account's token.
//
// - **The fleet's own hostnames** (each client's staff and desk hostnames, and the deployment's
//   callback hostname, all on the fleet's domain) reach cos-app, which decides the client from the
//   registry (ADR 0615). Two ways, chosen at `cos fleet install` (`--attach`):
//   - `custom-domains` (the default): a Workers Custom Domain per hostname, one API call each,
//     made by `cos client add` and removed by `cos client remove`. Cloudflare makes its DNS record
//     and its certificate, at any depth; at most 100 a zone (Cloudflare's limit).
//   - `wildcard`: one proxied `*.<domain>` record and one `*.<domain>/*` route to cos-app, made
//     at install; nothing per client. Only where the domain is the zone's apex (Universal SSL
//     covers one level under it) and the zone is the fleet's alone (the route takes every name).
// - **A client's own domain** (its web hostname) is a Cloudflare for SaaS custom hostname on the
//   fleet's zone, validated in real time once the client's CNAME to `clients.<domain>` (the zone's
//   fallback origin, `fleetClientTarget`) exists, its certificate by HTTP; and once Cloudflare
//   reports both active and the client's `_cos-client` TXT names it (`recordsFor`), a route
//   `<hostname>/*` to cos-front.
//
// Every call here finds before it makes, so a re-run of any command converges.
import type {
  CloudflareClient,
  CustomHostname,
  FleetAttach,
  FleetState,
} from "@composable-os/release";
import { fleetClientTarget, RouteTakenError } from "@composable-os/release";

/** What the client adds to its DNS for its own domain, line by line. */
export interface DnsRecordLine {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  why: string;
}

/** A client's own domain as Cloudflare sees it. */
export interface CustomHostnameState {
  status: string;
  certificate: string;
  /** Hostname and certificate both active at Cloudflare. */
  active: boolean;
}

/**
 * A custom hostname on the zone that this deployment did not make (another deployment's on the
 * same zone, live beside staging, or someone's own): never adopted, re-pointed or deleted.
 */
export class NotOursError extends Error {
  override name = "NotOursError";
}

/**
 * What the commands need of Cloudflare for hostnames. A client's own domain is this deployment's
 * only by the custom hostname id its registry recorded when it made it (registry migration 0799;
 * custom metadata, which could carry an owner, is Enterprise only), and its route only while the
 * route's Worker is this deployment's cos-front.
 */
export interface FleetEdge {
  /** Whether the zone serves clients' own domains (Cloudflare for SaaS set up, `clientDomains`). */
  readonly clientDomains: boolean;
  /** A hostname on the fleet's domain, to cos-app. */
  attachFleetHostname(hostname: string): Promise<string>;
  /** Detaches it, only from this deployment's cos-app. */
  detachFleetHostname(hostname: string): Promise<string>;
  /**
   * A client's own domain as a custom hostname: made, or the one `ours` names. One already on the
   * zone that is not `ours` is refused (`NotOursError`), unless `adopt` (the operator's word that
   * this deployment made it and lost its id to a crash).
   */
  addCustomHostname(
    hostname: string,
    ours: string | null,
    adopt?: boolean,
  ): Promise<{ id: string; state: CustomHostnameState }>;
  /** Its state, when the zone's custom hostname is `ours`; null when there is none. */
  customHostnameState(hostname: string, ours: string): Promise<CustomHostnameState | null>;
  /** Its route to cos-front, made once; another Worker's route of it is refused (`NotOursError`). */
  routeToFront(hostname: string): Promise<void>;
  /** Its route (when cos-front's) and its custom hostname (when `ours`) gone: what was done. */
  removeCustomHostname(hostname: string, ours: string | null): Promise<string>;
}

export interface EdgeInput {
  api: CloudflareClient;
  accountId: string;
  fleet: FleetState;
  /** cos-app's deployed name. */
  appWorker: string;
  /** cos-front's deployed name, or null when the installed release has none. */
  frontWorker: string | null;
}

/** The name of the TXT record that says which client a hostname is for. */
export function clientTxtName(hostname: string): string {
  return `_cos-client.${hostname}`;
}

/**
 * The value of that record for a client of one environment: `cos-client=<environment>:<client>`,
 * the client's stamp (packages/db `clientStamp`). The environment is in it because live and
 * staging are two registries with the same client ids, and a staging verify must never pass on
 * live's record (review of #543, M1).
 */
export function clientTxtValue(environment: string, client: string): string {
  return `cos-client=${environment}:${client}`;
}

/**
 * The DNS records a client's own domain needs, in its own DNS (ADR 0619):
 * - a CNAME to the fleet's target, DNS only: with it Cloudflare validates the hostname in real
 *   time and issues its certificate over HTTP (pre-validation by TXT is not supported for a
 *   hostname whose zone is on Cloudflare, and a proxied CNAME, Orange-to-Orange, puts the client's
 *   zone settings first and carries no WebSockets);
 * - a TXT `_cos-client.<hostname>` naming the client, which `cos client hostname verify` reads
 *   itself: Cloudflare's validation proves the hostname points at the fleet, not which client it
 *   is for, so without this a hostname another client's DNS already points at the target could be
 *   claimed for the wrong client.
 */
export function recordsFor(
  hostname: string,
  target: string,
  environment: string,
  client: string,
): DnsRecordLine[] {
  return [
    {
      type: "CNAME",
      name: hostname,
      value: target,
      why: "sends its visitors to the host; DNS only (grey cloud), not proxied",
    },
    {
      type: "TXT",
      name: clientTxtName(hostname),
      value: clientTxtValue(environment, client),
      why: "says which client of the host, and which environment, the domain is for",
    },
  ];
}

function stateOf(found: CustomHostname): Omit<CustomHostnameState, "records"> {
  const status = found.status;
  const certificate = found.ssl?.status ?? "unknown";
  return { status, certificate, active: status === "active" && certificate === "active" };
}

/** A TXT lookup: every TXT value at `name` (strings of one record joined), or []. */
export type TxtLookup = (name: string) => Promise<string[]>;

/** TXT records over DNS over HTTPS (Cloudflare's public resolver, JSON). */
export function dohTxt(fetchImpl: typeof fetch = fetch): TxtLookup {
  return async (name) => {
    const response = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!response.ok) throw new Error(`DNS lookup of ${name} failed (HTTP ${response.status})`);
    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? [])
      .filter((a) => a.type === 16)
      .map((a) => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(""));
  };
}

/**
 * Waits until `https://<hostname>/` answers over HTTPS (any HTTP status: DNS and the certificate
 * work) `times` times running, polling every `intervalMs` for up to `timeoutMs`. One answer is not
 * enough: in the staging check's third run a new staff hostname answered its sign-in page and then
 * failed (no answer at all) on a later request, as its DNS and certificate reached Cloudflare's
 * edges one by one.
 */
export async function reachable(
  hostname: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    intervalMs?: number;
    times?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ ok: boolean; seconds: number; last: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const times = options.times ?? 3;
  const start = now();
  let streak = 0;
  let last = "no answer yet";
  for (;;) {
    try {
      const response = await fetchImpl(`https://${hostname}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      await response.body?.cancel();
      streak += 1;
      last = `HTTP ${response.status}`;
    } catch (error) {
      streak = 0;
      last = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    }
    const seconds = (now() - start) / 1000;
    if (streak >= times) return { ok: true, seconds, last };
    // Time runs out only while it does not answer: a run of answers is let finish.
    if (streak === 0 && now() - start >= (options.timeoutMs ?? 15 * 60 * 1000)) {
      return { ok: false, seconds, last };
    }
    await sleep(streak ? 3_000 : (options.intervalMs ?? 10_000));
  }
}

/** The edge over Cloudflare's API, or null for a fleet whose zone is not known. */
export function cloudflareEdge(input: EdgeInput): FleetEdge | null {
  const { api, accountId, fleet, appWorker, frontWorker } = input;
  const zone = fleet.zone;
  if (!zone) return null;
  const attach: FleetAttach = fleet.attach ?? "custom-domains";
  const front = () => {
    if (!frontWorker) {
      throw new Error("the installed release has no cos-front: upgrade the fleet first");
    }
    return frontWorker;
  };
  return {
    clientDomains: fleet.clientDomains === true,
    async attachFleetHostname(hostname) {
      if (attach === "wildcard") return `${hostname}: reached through the fleet's wildcard route`;
      const held = (await api.listDomains(accountId)).find((d) => d.hostname === hostname);
      if (held && held.service !== appWorker) {
        throw new NotOursError(
          `${hostname} is a Custom Domain of ${held.service}, not of ${appWorker}: never re-pointed`,
        );
      }
      await api.putDomain(accountId, hostname, appWorker, zone.id);
      return `${hostname}: a Custom Domain of ${appWorker}`;
    },
    async detachFleetHostname(hostname) {
      if (attach === "wildcard") return `${hostname}: nothing to detach (the wildcard route)`;
      const found = (await api.listDomains(accountId)).filter((d) => d.hostname === hostname);
      const ours = found.filter((d) => d.service === appWorker);
      for (const d of ours) await api.deleteDomain(accountId, d.id);
      if (ours.length) return `${hostname}: detached`;
      return found.length
        ? `${hostname}: another Worker's Custom Domain (${found.map((d) => d.service).join(", ")}), left as it is`
        : `${hostname}: was not attached`;
    },
    async addCustomHostname(hostname, ours, adopt = false) {
      const found = await api.findCustomHostname(zone.id, hostname);
      if (found) {
        if (found.id === ours || (adopt && ours === null)) {
          return { id: found.id, state: stateOf(found) };
        }
        throw new NotOursError(
          `${hostname} is already a custom hostname on ${zone.name}, which this deployment did not make (another deployment's on the same zone, or someone's own): it is never taken over. Nothing was changed.`,
        );
      }
      const made = await api.createCustomHostnameForCname(zone.id, hostname);
      return { id: made.id, state: stateOf(made) };
    },
    async customHostnameState(hostname, ours) {
      const found = await api.findCustomHostname(zone.id, hostname);
      if (!found) return null;
      if (found.id !== ours) {
        throw new NotOursError(
          `${hostname}'s custom hostname on ${zone.name} is not the one this deployment made: nothing was changed`,
        );
      }
      return stateOf(found);
    },
    async routeToFront(hostname) {
      try {
        await api.putRoute(zone.id, `${hostname}/*`, front());
      } catch (error) {
        if (error instanceof RouteTakenError) throw new NotOursError(error.message);
        throw error;
      }
    },
    async removeCustomHostname(hostname, ours) {
      const routed = frontWorker
        ? await api.deleteRoute(zone.id, `${hostname}/*`, frontWorker)
        : false;
      const found = ours ? await api.findCustomHostname(zone.id, hostname) : null;
      const deleted = Boolean(found && found.id === ours);
      if (found && deleted) await api.deleteCustomHostname(zone.id, found.id);
      return `${hostname}: ${routed ? "its route" : "no route of this deployment's"} and ${
        deleted
          ? "its custom hostname removed"
          : "no custom hostname of this deployment's to remove"
      }`;
    },
  };
}

/**
 * The zone of the account the fleet's domain is on: the longest zone name the domain is or is
 * under, or the one named (which must hold it). Null when no zone of the account holds it.
 */
export async function zoneOf(
  api: CloudflareClient,
  accountId: string,
  domain: string,
  named?: string,
): Promise<{ id: string; name: string } | null> {
  const zones = await api.listZones(accountId);
  const holds = (z: { name: string }) => domain === z.name || domain.endsWith(`.${z.name}`);
  if (named) {
    const zone = zones.find((z) => z.name === named);
    if (!zone) throw new Error(`no active zone ${named} in this account`);
    if (!holds(zone)) throw new Error(`the zone ${named} does not hold ${domain}`);
    return { id: zone.id, name: zone.name };
  }
  const best = zones.filter(holds).sort((a, b) => b.name.length - a.name.length)[0];
  return best ? { id: best.id, name: best.name } : null;
}

/** What the operator does to let a fleet serve clients' own domains (ADR 0619). */
export function saasStep(zoneName: string): string {
  return `enable Cloudflare for SaaS on the zone ${zoneName} in the dashboard (the zone's Custom Hostnames page, Enable; a payment method on file), then run cos fleet install again`;
}

/**
 * What `cos fleet install` sets on the fleet's zone, each made once, so a re-run converges:
 * - the callback hostname to cos-app (a Custom Domain, or the wildcard route and record);
 * - for clients' own domains, only when the zone has Cloudflare for SaaS: the CNAME target
 *   `clients.<domain>` (a proxied placeholder record), the zone's fallback origin set to it, and
 *   its route to cos-front (so a proxied CNAME from a client's Cloudflare zone, which reaches the
 *   target's route, is answered by cos-front too, and the target itself is a 404 there).
 * On a zone without Cloudflare for SaaS (Cloudflare answers 1456 or 1404) none of the second part
 * is made: the fleet's own hostnames work, it says what to do, and returns false. cos-front is
 * deployed with the release either way and is reached by nothing until then.
 */
export async function setUpFleetZone(
  input: EdgeInput,
  log: (line: string) => void,
): Promise<{ clientDomains: boolean }> {
  const { api, fleet, appWorker, frontWorker } = input;
  const zone = fleet.zone;
  if (!zone) return { clientDomains: false };
  const attach = fleet.attach ?? "custom-domains";
  if (attach === "wildcard") {
    const made = await api.ensureProxiedPlaceholder(zone.id, `*.${fleet.domain}`);
    await api.putRoute(zone.id, `*.${fleet.domain}/*`, appWorker);
    log(`  zone ${zone.name}: *.${fleet.domain} (${made}) routed to ${appWorker}`);
  } else {
    const held = (await api.listDomains(input.accountId)).find(
      (d) => d.hostname === fleet.callbackHostname,
    );
    if (held && held.service !== appWorker) {
      throw new NotOursError(
        `${fleet.callbackHostname} is a Custom Domain of ${held.service}, not of ${appWorker}: never re-pointed`,
      );
    }
    await api.putDomain(input.accountId, fleet.callbackHostname, appWorker, zone.id);
    log(`  zone ${zone.name}: ${fleet.callbackHostname}, a Custom Domain of ${appWorker}`);
  }
  if (!frontWorker) {
    log("  clients' own domains: this release has no cos-front; none can be added yet");
    return { clientDomains: false };
  }
  if (!(await api.saasEnabled(zone.id))) {
    log(
      `  clients' own domains: not set up, Cloudflare for SaaS is not enabled on ${zone.name}. The fleet's own hostnames work. To serve clients' own domains, ${saasStep(zone.name)}.`,
    );
    return { clientDomains: false };
  }
  const target = fleetClientTarget(fleet.domain);
  const made = await api.ensureProxiedPlaceholder(zone.id, target);
  // A zone's fallback origin is the zone's, not the fleet's alone: one set to something else that
  // has a record on the zone is left as it is (a route on each verified hostname reaches cos-front
  // before any origin); one whose record is gone (a deleted fleet's, a staging check's) is
  // replaced, and said.
  const fallback = await api.getFallbackOrigin(zone.id);
  let note: string;
  if (!fallback || fallback === target) {
    await api.putFallbackOrigin(zone.id, target);
    note = `is ${target}`;
  } else if ((await api.listDnsRecords(zone.id, fallback)).length === 0) {
    await api.putFallbackOrigin(zone.id, target);
    note = `was ${fallback}, which has no DNS record on the zone: replaced by ${target}`;
  } else {
    note = `stays ${fallback} (another's, not changed)`;
  }
  try {
    await api.putRoute(zone.id, `${target}/*`, frontWorker);
  } catch (error) {
    if (error instanceof RouteTakenError) throw new NotOursError(error.message);
    throw error;
  }
  log(
    `  clients' own domains: CNAME to ${target} (${made}), routed to ${frontWorker}; the zone's fallback origin ${note}`,
  );
  return { clientDomains: true };
}
