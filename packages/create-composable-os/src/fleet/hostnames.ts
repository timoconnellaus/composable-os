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
//   fleet's zone, validated by TXT records the client adds (ownership and certificate), and once
//   Cloudflare reports both active, a route `<hostname>/*` to cos-front. The client points a CNAME
//   at `clients.<domain>`, the zone's fallback origin (`fleetClientTarget`).
//
// Every call here finds before it makes, so a re-run of any command converges.
import type {
  CloudflareClient,
  CustomHostname,
  FleetAttach,
  FleetState,
} from "@composable-os/release";
import { fleetClientTarget } from "@composable-os/release";

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
  /** Ownership and certificate both active: the hostname may be verified and routed. */
  active: boolean;
  records: DnsRecordLine[];
}

/** What the commands need of Cloudflare for hostnames. */
export interface FleetEdge {
  /** A hostname on the fleet's domain, to cos-app. */
  attachFleetHostname(hostname: string): Promise<string>;
  detachFleetHostname(hostname: string): Promise<string>;
  /** A client's own domain, as a custom hostname (made once). */
  addCustomHostname(hostname: string): Promise<CustomHostnameState>;
  customHostnameState(hostname: string): Promise<CustomHostnameState | null>;
  /** Its route to cos-front (made once the hostname is active). */
  routeToFront(hostname: string): Promise<void>;
  /** Its route and its custom hostname, gone. */
  removeCustomHostname(hostname: string): Promise<void>;
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

/** The DNS records a custom hostname asks its owner for. */
export function recordsOf(found: CustomHostname, target: string): DnsRecordLine[] {
  const out: DnsRecordLine[] = [];
  const own = found.ownership_verification;
  if (own?.name && own.value) {
    out.push({
      type: "TXT",
      name: own.name,
      value: own.value,
      why: "proves the domain is the client's (Cloudflare's ownership check)",
    });
  }
  for (const r of found.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value) {
      out.push({
        type: "TXT",
        name: r.txt_name,
        value: r.txt_value,
        why: "lets Cloudflare issue the hostname's certificate",
      });
    }
  }
  out.push({
    type: "CNAME",
    name: found.hostname,
    value: target,
    why: "sends its visitors to the host (DNS only; on a bare domain, Cloudflare DNS flattens it)",
  });
  return out;
}

function stateOf(found: CustomHostname, target: string): CustomHostnameState {
  const status = found.status;
  const certificate = found.ssl?.status ?? "unknown";
  return {
    status,
    certificate,
    active: status === "active" && certificate === "active",
    records: recordsOf(found, target),
  };
}

/** The edge over Cloudflare's API, or null for a fleet whose zone is not known. */
export function cloudflareEdge(input: EdgeInput): FleetEdge | null {
  const { api, accountId, fleet, appWorker, frontWorker } = input;
  const zone = fleet.zone;
  if (!zone) return null;
  const attach: FleetAttach = fleet.attach ?? "custom-domains";
  const target = fleetClientTarget(fleet.domain);
  const front = () => {
    if (!frontWorker) {
      throw new Error("the installed release has no cos-front: upgrade the fleet first");
    }
    return frontWorker;
  };
  return {
    async attachFleetHostname(hostname) {
      if (attach === "wildcard") return `${hostname}: reached through the fleet's wildcard route`;
      await api.putDomain(accountId, hostname, appWorker, zone.id);
      return `${hostname}: a Custom Domain of ${appWorker}`;
    },
    async detachFleetHostname(hostname) {
      if (attach === "wildcard") return `${hostname}: nothing to detach (the wildcard route)`;
      const found = (await api.listDomains(accountId)).filter((d) => d.hostname === hostname);
      for (const d of found) await api.deleteDomain(accountId, d.id);
      return found.length ? `${hostname}: detached` : `${hostname}: was not attached`;
    },
    async addCustomHostname(hostname) {
      const found =
        (await api.findCustomHostname(zone.id, hostname)) ??
        (await api.createTxtCustomHostname(zone.id, hostname));
      return stateOf(found, target);
    },
    async customHostnameState(hostname) {
      const found = await api.findCustomHostname(zone.id, hostname);
      return found ? stateOf(found, target) : null;
    },
    async routeToFront(hostname) {
      await api.putRoute(zone.id, `${hostname}/*`, front());
    },
    async removeCustomHostname(hostname) {
      await api.deleteRoute(zone.id, `${hostname}/*`);
      const found = await api.findCustomHostname(zone.id, hostname);
      if (found) await api.deleteCustomHostname(zone.id, found.id);
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

/**
 * What `cos fleet install` sets on the fleet's zone, each made once: the callback hostname to
 * cos-app (a Custom Domain, or the wildcard route and record), and for clients' own domains the
 * CNAME target `clients.<domain>` (a proxied placeholder record), the zone's fallback origin set to
 * it, and its route to cos-front (so a proxied CNAME from a client's Cloudflare zone, which reaches
 * the target's route, is answered by cos-front too, and the target itself is a 404 there).
 */
export async function setUpFleetZone(input: EdgeInput, log: (line: string) => void): Promise<void> {
  const { api, fleet, appWorker, frontWorker } = input;
  const zone = fleet.zone;
  if (!zone) return;
  const attach = fleet.attach ?? "custom-domains";
  if (attach === "wildcard") {
    const made = await api.ensureProxiedPlaceholder(zone.id, `*.${fleet.domain}`);
    await api.putRoute(zone.id, `*.${fleet.domain}/*`, appWorker);
    log(`  zone ${zone.name}: *.${fleet.domain} (${made}) routed to ${appWorker}`);
  } else {
    await api.putDomain(input.accountId, fleet.callbackHostname, appWorker, zone.id);
    log(`  zone ${zone.name}: ${fleet.callbackHostname}, a Custom Domain of ${appWorker}`);
  }
  if (!frontWorker) {
    log("  clients' own domains: this release has no cos-front; none can be added yet");
    return;
  }
  const target = fleetClientTarget(fleet.domain);
  const made = await api.ensureProxiedPlaceholder(zone.id, target);
  await api.putFallbackOrigin(zone.id, target);
  await api.putRoute(zone.id, `${target}/*`, frontWorker);
  log(
    `  clients' own domains: CNAME to ${target} (${made}), the zone's fallback origin, routed to ${frontWorker}`,
  );
}
