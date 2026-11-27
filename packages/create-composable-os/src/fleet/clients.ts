// The operator's commands for a host of many clients (stage 66 step 7, ADR 0618): `cos client
// add`, `pause`, `resume`, `list`, `secret set|remove`, `export`, `import` and `remove`. Each runs
// over the registry (a `D1Database`: D1's REST API from `cos`, Node's SQLite in the tests) and the
// operator's Worker (`Operator`), so the same code is what the tests drive.
//
// Every command that changes more than one thing records where it has got to in
// `registry_operations` (registry migration 0795), and a second run of the same command for the
// same client reads it and carries on: see each command's "crash and re-run" note. Every command
// that removes or overwrites asks for the client's id to be typed (or `--yes`), and `--dry-run`
// says what it would do and does nothing.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Migration, MigrationLevel } from "@composable-os/db";
import {
  type ClientId,
  type ClientStatus,
  canonicalHostname,
  clientStamp,
  isUnder,
  registrableDomain,
  validateClientId,
} from "@composable-os/db/registry";
import {
  importedSecretProblem,
  isDerivedSecretName,
  isGivenSecretName,
  removeClientSecret,
  sealingPublicKey,
  writeClientSecret,
  writeImportedSecret,
} from "@composable-os/db/registry-sealing";
import {
  addSenderDomain,
  listSenderDomains,
  removeSenderDomain,
  unverifySenderDomain,
  verifySenderDomain,
} from "@composable-os/db/registry-senders";
import {
  addClientRows,
  addHostname,
  beginOperation,
  finishOperation,
  hostnamesTaken,
  listClients,
  listHostnames,
  type NewClient,
  newClientProblems,
  readClient,
  recordSchemaVersion,
  removeClientRows,
  removeHostname,
  saveOperation,
  setClientStatus,
  unfinishedOperation,
  unfinishedOperations,
  verifyHostname,
  wasRemoved,
} from "@composable-os/db/registry-writes";
import type { ExportPart } from "@composable-os/db/sql-export";
import { type FleetState, fleetClientTarget } from "@composable-os/release";
import type { Io } from "../io.ts";
import {
  clientTxtName,
  clientTxtValue,
  type FleetEdge,
  recordsFor,
  type TxtLookup,
} from "./hostnames.ts";
import type { Operator } from "./operator-client.ts";

export class FleetError extends Error {}

export interface FleetContext {
  registry: D1Database;
  operator: Operator;
  fleet: FleetState;
  /** The installed release's core migrations: what a client's database is migrated with. */
  migrations: Migration[];
  io: Io;
  yes: boolean;
  dryRun: boolean;
  now?: () => Date;
  /**
   * Stamps a Stream video of the account with its creator (Stream's API, with the account's
   * token); false when the account has no such video. Absent: videos are left as they are.
   */
  videos?: { setCreator(uid: string, creator: string): Promise<boolean> };
  /**
   * Cloudflare's edge for the client's hostnames (stage 66 step 8, hostnames.ts): its staff and
   * desk hostnames attached to cos-app, its own domain a custom hostname routed to cos-front.
   * Absent (a fleet installed before step 8, whose zone is not known): the registry is written
   * and nothing is attached, which the command says.
   */
  edge?: FleetEdge;
  /**
   * Reads a name's TXT records (DNS over HTTPS from `cos`): how `cos client hostname verify`
   * reads the `_cos-client` record that says which client a domain is for. Absent: none found.
   */
  txt?: TxtLookup;
}

/** A refreshed registry is served within this long (packages/db `REGISTRY_REFRESH_MS`). */
const REFRESH_NOTE = "A running host serves the change within 10 seconds (its registry refresh).";

function idOf(id: string | undefined): ClientId {
  if (!id) throw new FleetError("Name the client: cos client <command> <id>");
  try {
    return validateClientId(id);
  } catch (error) {
    throw new FleetError((error as Error).message);
  }
}

/**
 * Asks the operator to type the client's id before a change that removes or overwrites; `--yes`
 * answers for them, and with no terminal and no `--yes` the command stops.
 */
export async function confirmFor(ctx: FleetContext, client: string, what: string): Promise<void> {
  if (ctx.yes) return;
  if (!ctx.io.interactive) {
    throw new FleetError(`${what}: pass --yes to confirm for ${client} (or --dry-run to see it)`);
  }
  const typed = await ctx.io.ask(`${what}. Type the client's id (${client}) to confirm`);
  if (typed !== client) throw new FleetError(`Not confirmed: nothing was changed for ${client}.`);
}

/** The schema version a level reports, or a failure that names the client. */
function versionOf(client: string, level: MigrationLevel): number {
  if (level.schemaVersion === null) {
    throw new FleetError(`${client}'s database reports no schema version after migrating`);
  }
  return level.schemaVersion;
}

/** The highest migration number of a list: the schema version a release's code expects. */
export function schemaVersionOf(migrations: Migration[]): number {
  let highest = 0;
  for (const m of migrations) {
    const n = Number.parseInt(m.name.slice(0, m.name.indexOf("_")), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest;
}

/**
 * Refuses a command that adds a client while an update is unfinished (review of #526, F-d): the
 * new client would be migrated to one release while the update moves the rest to another.
 */
async function refuseDuringUpdate(ctx: FleetContext, what: string): Promise<void> {
  const update = await unfinishedOperation<{ from: string; to: string }>(
    ctx.registry,
    "update",
    null,
  );
  if (update) {
    throw new FleetError(
      `Cannot ${what}: an update ${update.state.from} → ${update.state.to} started ${update.startedAt} has not finished. Run cos fleet upgrade again to finish or undo it first.`,
    );
  }
}

// --- add -------------------------------------------------------------------------------------------

export interface AddInput {
  id: string;
  tier?: "standard" | "bespoke";
  repository?: string;
  locationHint?: string;
  staffHostname?: string;
  webHostname?: string;
  /** A desk hostname on the fleet's domain: `<id>-desk.<domain>` (`--desk`), or this one. */
  desk?: boolean;
  deskHostname?: string;
  settings?: Record<string, string>;
  /** For `import`: added as an imported deployment (migration 0793). */
  imported?: boolean;
}

/**
 * A domain in the registry's one form: an IDN as punycode, lowercase, no trailing dot (the form
 * `canonicalHostname` holds hostnames in), or null when it is not a hostname.
 */
export function canonicalDomain(domain: string): string | null {
  let ascii: string;
  try {
    ascii = new URL(`http://${domain.trim()}/`).hostname;
  } catch {
    return null;
  }
  return canonicalHostname(ascii);
}

/** The registrable domain of a hostname (packages/db's, also what cos-front refuses under). */
export { registrableDomain };

/**
 * What is wrong with a hostname for this fleet on its surface, beyond the registry's own rules
 * (stage 66 step 8, ADR 0619; the owner's rule of 2026-11-27, ADR 0616 "Cookies"):
 * - a **web** hostname runs code the client controls, so it is on the client's own domain and
 *   never anywhere under the fleet domain's registrable domain, where a page could set cookies
 *   for the staff hostnames beside it (no Public Suffix listing is assumed: review of #526, S3);
 * - a **staff** or **desk** hostname is served by cos-app (our code only), so it is on the
 *   fleet's own domain, where `cos` attaches it;
 * - none is the fleet's CNAME target `clients.<domain>`.
 */
export function hostnameProblem(
  fleet: FleetState,
  hostname: string,
  surface: "staff" | "web" | "desk",
): string | null {
  const domain = canonicalDomain(fleet.domain) ?? fleet.domain;
  const registrable = registrableDomain(domain);
  if (hostname === fleetClientTarget(domain)) {
    return `${hostname} is where clients' own domains point, no client's hostname`;
  }
  if (surface === "web") {
    if (isUnder(hostname, registrable)) {
      return `${hostname}: a client's web hostname is never on the fleet's domain (${registrable}), where its code could set the staff hostnames' cookies; use the client's own domain`;
    }
    // A custom hostname at a domain's apex needs a CNAME at the apex to validate and route, which
    // Cloudflare for SaaS supports only with apex proxying, "only certain customers have access to
    // this feature" (ADR 0619): a subdomain, and the bare domain redirected to it by the client.
    return registrableDomain(hostname) === hostname
      ? `${hostname} is a bare domain: use a subdomain (www.${hostname}), and redirect the bare domain to it in the client's own DNS`
      : null;
  }
  return hostname.endsWith(`.${domain}`)
    ? null
    : `${hostname}: a client's ${surface} hostname is on the fleet's domain (${domain}), where cos attaches it`;
}

/** Every hostname problem of a client to add (`hostnameProblem`, one line each). */
export function fleetHostnameProblems(ctx: FleetContext, client: NewClient): string[] {
  return client.hostnames
    .map((h) => hostnameProblem(ctx.fleet, h.hostname, h.surface))
    .filter((p): p is string => p !== null);
}

/**
 * The client as it would be added: its staff hostname on the fleet's domain unless named, a desk
 * hostname there when asked for, and a web hostname (its own domain) only when one is named,
 * written **unverified**: it is served once `cos client hostname verify` finds it active.
 */
export function plannedClient(ctx: FleetContext, input: AddInput): NewClient {
  const id = input.id;
  const desk = input.deskHostname ?? (input.desk ? `${id}-desk.${ctx.fleet.domain}` : null);
  return {
    id,
    environment: ctx.fleet.environment,
    tier: input.tier ?? "standard",
    repository: input.repository ?? null,
    locationHint: input.locationHint ?? null,
    imported: input.imported ?? false,
    hostnames: [
      { hostname: input.staffHostname ?? `${id}-admin.${ctx.fleet.domain}`, surface: "staff" },
      ...(desk ? [{ hostname: desk, surface: "desk" as const }] : []),
      ...(input.webHostname
        ? [{ hostname: input.webHostname, surface: "web" as const, verified: false }]
        : []),
    ],
    settings: input.settings ?? {},
  };
}

/** The lines that tell the operator what the client adds to its DNS for its own domain. */
export function dnsInstructions(ctx: FleetContext, id: string, hostname: string): string[] {
  const target = fleetClientTarget(canonicalDomain(ctx.fleet.domain) ?? ctx.fleet.domain);
  return [
    `  ${hostname}: unverified, served nowhere yet. The client adds, at its DNS provider:`,
    ...recordsFor(hostname, target, id).map(
      (r) => `    ${r.type.padEnd(5)} ${r.name}  ${r.value}    (${r.why})`,
    ),
    `  then: cos client hostname verify ${id} ${hostname}`,
  ];
}

/**
 * Attaches a client's hostnames on Cloudflare (each call finds before it makes, so a re-run
 * converges): staff and desk to cos-app, a web hostname as a custom hostname whose DNS records
 * are printed. With no edge (no zone known), says so and attaches nothing.
 */
async function attachHostnames(ctx: FleetContext, id: string, client: NewClient): Promise<void> {
  if (!ctx.edge) {
    ctx.io.err(
      "  hostnames: not attached (this fleet's zone is not known: run cos fleet install again to learn it)",
    );
    return;
  }
  for (const h of client.hostnames) {
    if (h.surface === "web") {
      await ctx.edge.addCustomHostname(h.hostname);
      for (const line of dnsInstructions(ctx, id, h.hostname)) ctx.io.out(line);
    } else {
      ctx.io.out(`  ${await ctx.edge.attachFleetHostname(h.hostname)}`);
    }
  }
}

interface AddState {
  step: "rows" | "database" | "done";
  hostnames: string[];
}

/**
 * `cos client add <id>`: the registry's rows (the client paused, with no schema version), its
 * database placed and migrated inside the object, its schema version recorded, then the client
 * served. No Worker is uploaded. The product's packs are the deployment's (`COS_PACKS` inherited
 * unless set); its own extensions come with its repository's `cos deploy` (step 8).
 *
 * Crash and re-run: after the operation's row and before the client's rows, a re-run writes the
 * rows; after the rows, the client is paused and has no schema version, so the host serves
 * nothing of it, and a re-run places and migrates its database (both resume: migrations apply
 * only what is missing) and turns it on. A finished add is "already a client".
 */
export async function addClient(ctx: FleetContext, input: AddInput): Promise<number> {
  const started = Date.now();
  const id = idOf(input.id);
  if (!ctx.dryRun) await ctx.operator.claim?.();
  const client = plannedClient(ctx, { ...input, id });
  const problems = [
    ...newClientProblems(client, { callbackHostname: ctx.fleet.callbackHostname }),
    ...fleetHostnameProblems(ctx, client),
  ];
  if (problems.length) throw new FleetError(`Cannot add ${id}: ${problems.join("; ")}`);
  await refuseDuringUpdate(ctx, `add ${id}`);
  const unfinished = await unfinishedOperation<AddState>(ctx.registry, "add", id);
  const existing = await readClient(ctx.registry, id);
  if (!unfinished) {
    if (existing) throw new FleetError(`${id} is already a client of this deployment`);
    if (await wasRemoved(ctx.registry, id)) {
      throw new FleetError(`${id} was a client once and was removed: an id is never used again`);
    }
    const taken = await hostnamesTaken(
      ctx.registry,
      client.hostnames.map((h) => h.hostname),
    );
    if (taken.length) {
      throw new FleetError(`Taken: ${taken.map((t) => `${t.hostname} (${t.client})`).join(", ")}`);
    }
    await refuseSharedDomain(ctx, id, client);
  }
  const hostnames = client.hostnames.map(
    (h) => `${h.surface} https://${h.hostname}${h.verified === false ? " (unverified)" : ""}`,
  );
  if (ctx.dryRun) {
    ctx.io.out(`Would add ${id} (${ctx.fleet.environment}, ${client.tier}):`);
    for (const line of hostnames) ctx.io.out(`  ${line}`);
    ctx.io.out(
      `  its database migrated to schema ${schemaVersionOf(ctx.migrations)}${client.locationHint ? `, placed with hint ${client.locationHint}` : ""}; settings: ${Object.keys(client.settings ?? {}).join(", ") || "the deployment's"}`,
    );
    ctx.io.out("Nothing was changed (--dry-run).");
    return 0;
  }
  const op =
    unfinished ??
    (await beginOperation<AddState>(ctx.registry, "add", id, {
      step: "rows",
      hostnames: client.hostnames.map((h) => h.hostname),
    }));
  if (unfinished) ctx.io.out(`Carrying on the add of ${id} started ${unfinished.startedAt}.`);
  if (!(await readClient(ctx.registry, id))) {
    await addClientRows(ctx.registry, client);
    ctx.io.out(`  registry: ${id} added, paused until its database is ready`);
  }
  await saveOperation(ctx.registry, op.id, { ...op.state, step: "database" });
  // Its hostnames on Cloudflare: the client is still paused, so an attached hostname answers
  // "being updated" until the database is ready.
  await attachHostnames(ctx, id, client);
  if (client.locationHint) await ctx.operator.op("place", { client: id });
  const report = await ctx.operator.op<{
    applied: string[];
    failed: { name: string; error: string } | null;
    level: MigrationLevel;
  }>("migrate", { client: id, migrations: ctx.migrations });
  if (report.failed) {
    throw new FleetError(
      `${id}'s database stopped at migration ${report.failed.name} (${report.failed.error}); it stays paused. Run the same command again once that is fixed.`,
    );
  }
  ctx.io.out(`  database: ${report.applied.length} migrations applied`);
  await recordSchemaVersion(ctx.registry, id, versionOf(id, report.level));
  await setClientStatus(ctx.registry, id, "active", ["paused"]);
  await finishOperation(ctx.registry, op.id, "succeeded", { ...op.state, step: "done" });
  ctx.io.out(
    `\nAdded ${id} in ${((Date.now() - started) / 1000).toFixed(1)} s, with no Worker uploaded:`,
  );
  for (const line of hostnames) ctx.io.out(`  ${line}`);
  ctx.io.out(REFRESH_NOTE);
  return 0;
}

/**
 * Refuses a web hostname whose registrable domain another client already has a hostname under:
 * whoever holds a domain's DNS holds every name under it, so one domain is one client's.
 */
async function refuseSharedDomain(ctx: FleetContext, id: string, client: NewClient) {
  for (const h of client.hostnames) {
    if (h.surface !== "web") continue;
    const domain = registrableDomain(h.hostname);
    const { results } = await ctx.registry
      .prepare(
        "SELECT hostname, client FROM registry_hostnames WHERE client != ? AND (hostname = ? OR hostname LIKE ?)",
      )
      .bind(id, domain, `%.${domain}`)
      .all<{ hostname: string; client: string }>();
    const other = results.find((r) => isUnder(r.hostname, domain));
    if (other) {
      throw new FleetError(
        `${h.hostname}: ${domain} is ${other.client}'s (${other.hostname}); a domain is one client's`,
      );
    }
  }
}

// --- a client's own domain (stage 66 step 8) -----------------------------------------------------

/**
 * `cos client hostname add|verify|remove|list <id> [<hostname>]`: a client's own web domain.
 * - **add**: the registry records it unverified, and the fleet's zone gets a custom hostname for
 *   it, validated by TXT records the command prints for the client to add (ownership and the
 *   certificate) beside the CNAME that sends its visitors. Refused anywhere under the fleet's
 *   registrable domain, on a domain another client has, and for a fleet whose zone is not known.
 * - **verify**: only when Cloudflare reports the custom hostname and its certificate active: then
 *   its route to cos-front, then the registry's mark. Until then it says what is pending, and
 *   changes nothing.
 * - **remove**: asks for the id; its route and custom hostname, then the registry's row.
 * Each finds before it makes, so a re-run converges.
 */
export async function hostnameCommand(
  ctx: FleetContext,
  verb: string,
  raw: string,
  name?: string,
): Promise<number> {
  const id = idOf(raw);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  if (verb === "list") {
    for (const h of await listHostnames(ctx.registry, id)) {
      ctx.io.out(
        `  ${h.surface.padEnd(5)} ${h.hostname}  ${h.verified ? "verified" : "unverified"}${h.primary ? ", its address" : ""}`,
      );
    }
    return 0;
  }
  if (!["add", "verify", "remove"].includes(verb) || !name) {
    throw new FleetError("cos client hostname add|verify|remove <id> <hostname> | list <id>");
  }
  const hostname = canonicalDomain(name);
  if (!hostname) throw new FleetError(`${name} is not a hostname`);
  const rows = await listHostnames(ctx.registry, id);
  const row = rows.find((h) => h.hostname === hostname);
  if (verb === "add") {
    const problem = hostnameProblem(ctx.fleet, hostname, "web");
    if (problem) throw new FleetError(`Cannot add ${hostname}: ${problem}`);
    const others = rows.filter((h) => h.surface === "web" && h.hostname !== hostname);
    if (others.length) {
      throw new FleetError(
        `${id} has a web hostname already (${others.map((h) => h.hostname).join(", ")}): remove it first`,
      );
    }
    const taken = await hostnamesTaken(ctx.registry, [hostname]);
    if (taken.some((t) => t.client !== id)) {
      throw new FleetError(`Taken: ${hostname} (${taken[0]?.client})`);
    }
    await refuseSharedDomain(ctx, id, {
      id,
      environment: ctx.fleet.environment,
      tier: "standard",
      hostnames: [{ hostname, surface: "web" }],
    });
    if (!ctx.edge) {
      throw new FleetError(
        "This fleet's zone is not known: run cos fleet install again to learn it, then add the hostname",
      );
    }
    if (ctx.dryRun) {
      ctx.io.out(`Would add ${hostname} to ${id}, unverified. Nothing was changed (--dry-run).`);
      return 0;
    }
    await addHostname(ctx.registry, id, hostname, "web", {
      callbackHostname: ctx.fleet.callbackHostname,
    });
    await ctx.edge.addCustomHostname(hostname);
    ctx.io.out(`Added ${hostname} to ${id}:`);
    for (const line of dnsInstructions(ctx, id, hostname)) ctx.io.out(line);
    return 0;
  }
  if (!ctx.edge)
    throw new FleetError("This fleet's zone is not known: run cos fleet install again");
  if (verb === "remove" && !row && !ctx.dryRun) {
    // A removal a crash stopped after the registry's row: Cloudflare's side is finished now.
    const held = await hostnamesTaken(ctx.registry, [hostname]);
    if (held.length) throw new FleetError(`${hostname} is ${held[0]?.client}'s, not ${id}'s`);
    await ctx.edge.removeCustomHostname(hostname);
    ctx.io.out(
      `${hostname} is not ${id}'s in the registry; its route and custom hostname are gone.`,
    );
    return 0;
  }
  if (!row || row.surface !== "web") {
    throw new FleetError(`${hostname} is not a web hostname of ${id}`);
  }
  if (verb === "verify") {
    const state = await ctx.edge.customHostnameState(hostname);
    if (!state) {
      throw new FleetError(
        `${hostname} has no custom hostname on the fleet's zone: run cos client hostname add ${id} ${hostname} again`,
      );
    }
    // Which client the domain is for, in the domain's own DNS (ADR 0619): Cloudflare's real-time
    // validation proves only that the hostname points at the fleet.
    const txt = ctx.txt ?? (async () => []);
    let named: string[];
    try {
      named = await txt(clientTxtName(hostname));
    } catch (error) {
      throw new FleetError(
        `Could not read ${clientTxtName(hostname)}: ${(error as Error).message}`,
      );
    }
    const others = named.filter((v) => v.startsWith("cos-client=") && v !== clientTxtValue(id));
    if (others.length) {
      throw new FleetError(
        `${clientTxtName(hostname)} names another client (${others.join(", ")}): ${hostname} is not ${id}'s. Nothing was changed.`,
      );
    }
    const missing = [
      ...(state.active
        ? []
        : [
            `Cloudflare has not proved it (hostname ${state.status}, certificate ${state.certificate})`,
          ]),
      ...(named.includes(clientTxtValue(id))
        ? []
        : [`its TXT ${clientTxtName(hostname)} does not say ${clientTxtValue(id)}`]),
    ];
    if (missing.length) {
      ctx.io.out(`${hostname} is not verified: ${missing.join("; ")}. Nothing was changed.`);
      for (const line of dnsInstructions(ctx, id, hostname)) ctx.io.out(line);
      return 1;
    }
    if (ctx.dryRun) {
      ctx.io.out(`Would verify ${hostname} for ${id}. Nothing was changed (--dry-run).`);
      return 0;
    }
    // The route first, the mark last: a hostname marked verified is one cos-front is reached on.
    await ctx.edge.routeToFront(hostname);
    await verifyHostname(ctx.registry, id, hostname);
    ctx.io.out(`Verified ${hostname} for ${id}: cos-front serves it. ${REFRESH_NOTE}`);
    return 0;
  }
  if (ctx.dryRun) {
    ctx.io.out(`Would remove ${hostname} from ${id}. Nothing was changed (--dry-run).`);
    return 0;
  }
  await confirmFor(ctx, id, `This removes ${hostname} from ${id}`);
  // The mark and row first, so the host stops naming it, then Cloudflare's side.
  await removeHostname(ctx.registry, id, hostname);
  await ctx.edge.removeCustomHostname(hostname);
  ctx.io.out(`Removed ${hostname} from ${id}. ${REFRESH_NOTE}`);
  return 0;
}

/** Detaches every hostname of a client from Cloudflare (`cos client remove`). */
async function detachHostnames(ctx: FleetContext, id: ClientId): Promise<void> {
  if (!ctx.edge) {
    ctx.io.err("  hostnames: this fleet's zone is not known; none detached");
    return;
  }
  for (const h of await listHostnames(ctx.registry, id)) {
    if (h.surface === "web") {
      await ctx.edge.removeCustomHostname(h.hostname);
      ctx.io.out(`  ${h.hostname}: its route and custom hostname removed`);
    } else {
      ctx.io.out(`  ${await ctx.edge.detachFleetHostname(h.hostname)}`);
    }
  }
}

// --- pause, resume, list ---------------------------------------------------------------------------

/** `cos client pause <id>`: the host refuses it ("being updated") and parks its messages. */
export async function pauseClient(ctx: FleetContext, raw: string): Promise<number> {
  const id = idOf(raw);
  const client = await readClient(ctx.registry, id);
  if (!client) throw new FleetError(`No client ${id}`);
  // An update resumes every client it paused at its end: a pause made meanwhile would be undone
  // without a word (review of #526, N2), so none is taken then.
  const update = await unfinishedOperation<{ from: string; to: string }>(
    ctx.registry,
    "update",
    null,
  );
  if (update) {
    throw new FleetError(
      `Cannot pause ${id} while an update ${update.state.from} → ${update.state.to} (started ${update.startedAt}) is unfinished: it would resume ${id} at its end. Nothing was changed. Pause it once the update has finished, or once a run of cos fleet upgrade has finished or undone a stopped one.`,
    );
  }
  if (ctx.dryRun) {
    ctx.io.out(`Would pause ${id} (now ${client.status}). Nothing was changed (--dry-run).`);
    return 0;
  }
  const changed = await setClientStatus(ctx.registry, id, "paused", ["active"]);
  ctx.io.out(changed ? `Paused ${id}. ${REFRESH_NOTE}` : `${id} is ${client.status}: not changed.`);
  return 0;
}

/** `cos client resume <id>`: served again, unless a command of the operator's is part-way. */
export async function resumeClient(ctx: FleetContext, raw: string): Promise<number> {
  const id = idOf(raw);
  const client = await readClient(ctx.registry, id);
  if (!client) throw new FleetError(`No client ${id}`);
  const busy = (await unfinishedOperations(ctx.registry)).filter(
    (op) => op.client === id || op.kind === "update",
  );
  if (busy.length) {
    throw new FleetError(
      `${id} is part-way through ${busy.map((b) => `${b.kind} (${b.startedAt})`).join(", ")}: run that command again to finish it`,
    );
  }
  if (client.schemaVersion === null) {
    throw new FleetError(
      `${id}'s database has no schema version recorded: run cos client add ${id}`,
    );
  }
  if (ctx.dryRun) {
    ctx.io.out(`Would resume ${id} (now ${client.status}). Nothing was changed (--dry-run).`);
    return 0;
  }
  const changed = await setClientStatus(ctx.registry, id, "active", ["paused", "moving"]);
  ctx.io.out(
    changed ? `Resumed ${id}. ${REFRESH_NOTE}` : `${id} is ${client.status}: not changed.`,
  );
  return 0;
}

/** `cos client list`: every client, its status and schema, and any command part-way. */
export async function listClientsCommand(ctx: FleetContext): Promise<number> {
  const clients = await listClients(ctx.registry);
  const code = schemaVersionOf(ctx.migrations);
  ctx.io.out(
    `${clients.length} client${clients.length === 1 ? "" : "s"} (${ctx.fleet.environment}):`,
  );
  for (const c of clients) {
    const behind = c.schemaVersion === null || c.schemaVersion < code ? " (schema behind)" : "";
    ctx.io.out(
      `  ${c.id}  ${c.status}  ${c.tier}${c.imported ? "  imported" : ""}  schema ${c.schemaVersion ?? "none"}${behind}`,
    );
  }
  for (const op of await unfinishedOperations(ctx.registry)) {
    ctx.io.out(`  part-way: ${op.kind}${op.client ? ` ${op.client}` : ""} since ${op.startedAt}`);
  }
  return 0;
}

// --- secrets ---------------------------------------------------------------------------------------

/**
 * `cos client secret set <id> <NAME>`: a given secret, sealed to the host's public key, so this
 * command can write it and never read it. The value is asked for (hidden) or read from
 * `--value-file`, never from the command line. Replacing a stored value asks first.
 */
export async function setSecret(
  ctx: FleetContext,
  raw: string,
  name: string,
  value: string,
): Promise<number> {
  const id = idOf(raw);
  const client = await readClient(ctx.registry, id);
  if (!client) throw new FleetError(`No client ${id}`);
  if (!isGivenSecretName(name)) {
    throw new FleetError(
      isDerivedSecretName(name)
        ? `${name} is derived for each client, never stored (ADR 0616)`
        : `${name} is not a secret a client gives`,
    );
  }
  const stored = await ctx.registry
    .prepare("SELECT kind FROM registry_secrets WHERE client = ? AND name = ?")
    .bind(id, name)
    .first<{ kind: string }>();
  if (ctx.dryRun) {
    ctx.io.out(
      `Would ${stored ? "replace" : "store"} ${name} for ${id}, sealed. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  if (stored) await confirmFor(ctx, id, `This replaces ${id}'s ${name}`);
  await writeClientSecret(
    ctx.registry,
    await sealingPublicKey(ctx.fleet.secretsPublicKey),
    { environment: client.environment, client: id, name },
    value,
  );
  ctx.io.out(`Stored ${name} for ${id}, sealed to the host. ${REFRESH_NOTE}`);
  return 0;
}

/** `cos client secret remove <id> <NAME>`. */
export async function removeSecret(ctx: FleetContext, raw: string, name: string): Promise<number> {
  const id = idOf(raw);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  if (ctx.dryRun) {
    ctx.io.out(`Would remove ${name} of ${id}. Nothing was changed (--dry-run).`);
    return 0;
  }
  await confirmFor(ctx, id, `This removes ${id}'s ${name}`);
  await removeClientSecret(ctx.registry, id, name);
  ctx.io.out(`Removed ${name} of ${id}. ${REFRESH_NOTE}`);
  return 0;
}

// --- sender domains (issue #529) -------------------------------------------------------------------

/** The fleet's own registrable domain, which no client sends as. */
function fleetRegistrable(ctx: FleetContext): string {
  return registrableDomain(canonicalDomain(ctx.fleet.domain) ?? ctx.fleet.domain);
}

/**
 * `cos client sender add|verify|unverify|remove <id> <domain>`: a client's sender domains
 * (`@composable-os/db/registry-senders`). Added unverified. Verifying is the operator's own
 * confirmation that the domain is onboarded to Email Sending in this deployment's Cloudflare
 * account with its sending records valid (nothing checks it automatically), so it is asked for by
 * the client's id; removing asks too.
 */
export async function senderCommand(
  ctx: FleetContext,
  verb: string,
  raw: string,
  domain: string,
): Promise<number> {
  const id = idOf(raw);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  if (!["add", "verify", "unverify", "remove"].includes(verb)) {
    throw new FleetError("cos client sender add|verify|unverify|remove <id> <domain>");
  }
  if (ctx.dryRun) {
    ctx.io.out(
      `Would ${verb} the sender domain ${domain} of ${id}. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  if (verb === "add") {
    await addSenderDomain(ctx.registry, id, domain, { fleetDomain: fleetRegistrable(ctx) });
    ctx.io.out(
      `Added ${domain} to ${id}'s sender domains, unverified: it sends nothing from it yet.`,
    );
  } else if (verb === "verify") {
    await confirmFor(
      ctx,
      id,
      `This confirms that ${domain} is onboarded to Email Sending in this deployment's Cloudflare account, with its sending records valid, and lets ${id} send as it`,
    );
    await verifySenderDomain(ctx.registry, id, domain);
    ctx.io.out(`Verified ${domain} for ${id}. ${REFRESH_NOTE}`);
  } else if (verb === "unverify") {
    await unverifySenderDomain(ctx.registry, id, domain);
    ctx.io.out(`${id} no longer sends from ${domain}. ${REFRESH_NOTE}`);
  } else {
    await confirmFor(ctx, id, `This removes ${domain} from ${id}'s sender domains`);
    await removeSenderDomain(ctx.registry, id, domain);
    ctx.io.out(`Removed ${domain} from ${id}'s sender domains. ${REFRESH_NOTE}`);
  }
  return 0;
}

// --- export ----------------------------------------------------------------------------------------

export const EXPORT_FORMAT = "cos-client-export/1";

/** What an export holds, as its `manifest.json` says (the secrets are never in it). */
export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  client: string;
  environment: string;
  generation: string;
  exportedAt: string;
  schemaVersion: number | null;
  database: {
    parts: { path: string; sha256: string; statements: number }[];
    counts: Record<string, number>;
  };
  files: { key: string; size: number; sha256: string }[];
  /** Videos are not in an export yet: see the spec's Status (#522 stamps the creator). */
  videos: "not exported";
  /**
   * The client's sender domains (issue #529): an import adds them unverified, for the operator to
   * verify again where the client now sends from. Absent in an export made before.
   */
  senderDomains?: string[];
}

interface ExportState {
  exportKey: string;
  previousStatus: ClientStatus;
  step: "database" | "files" | "manifest" | "done";
  cursor: unknown;
  parts: ExportManifest["database"]["parts"];
  counts: Record<string, number>;
  fileCursor: string | null;
  files: ExportManifest["files"];
  schemaVersion: number | null;
}

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A path inside `dir` for an export's `relative` path, refused if it would leave it. */
function inside(dir: string, relative: string): string {
  const root = resolve(dir);
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new FleetError(`an export path leaves its folder: ${relative}`);
  }
  return path;
}

export interface ExportInput {
  id: string;
  /** Also download the export, and the client's secrets, to this folder. */
  out?: string;
  /** The client is leaving: it stays `moving` (served nowhere) after the export. */
  leaving?: boolean;
}

/**
 * `cos client export <id>`: the client's database as SQL parts and its files, into the exports
 * bucket under `<client>/<generation>/<stamp>/`, with a manifest of every part's and file's
 * sha256 and the database's row counts; with `--out`, downloaded and checked, and the client's
 * secrets (derived, imported and given, opened by the operator's Worker) written beside it as
 * `secrets.json` (mode 0600; never in the bucket and never printed). The client is `moving` while
 * it runs (the host serves it nowhere, so no write is lost) and goes back to what it was unless
 * `--leaving`.
 *
 * Crash and re-run: the client stays `moving`; a re-run reads the operation and carries on from
 * the last part or page recorded (a database part whose hold lapsed starts the database again),
 * then puts the client back.
 */
export async function exportClient(ctx: FleetContext, input: ExportInput): Promise<number> {
  const id = idOf(input.id);
  if (!ctx.dryRun) await ctx.operator.claim?.();
  const client = await readClient(ctx.registry, id);
  if (!client) throw new FleetError(`No client ${id}`);
  if (!client.secretGeneration) throw new FleetError(`${id} has no secret generation`);
  if (input.out && existsSync(join(input.out, "manifest.json"))) {
    throw new FleetError(`${input.out} already holds an export: name an empty folder`);
  }
  let op = await unfinishedOperation<ExportState>(ctx.registry, "export", id);
  if (ctx.dryRun) {
    ctx.io.out(
      `Would export ${id}: set it moving (now ${client.status}), its database and files into the exports bucket${input.out ? `, and down to ${input.out} with its secrets` : ""}, then ${input.leaving ? "leave it moving" : "put it back"}. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  if (!op) {
    op = await beginOperation<ExportState>(ctx.registry, "export", id, {
      exportKey: `${id}/${client.secretGeneration}/${stampOf((ctx.now ?? (() => new Date()))())}`,
      previousStatus: client.status,
      step: "database",
      cursor: null,
      parts: [],
      counts: {},
      fileCursor: null,
      files: [],
      schemaVersion: null,
    });
  } else {
    ctx.io.out(`Carrying on the export of ${id} started ${op.startedAt}.`);
  }
  const state = op.state;
  await setClientStatus(ctx.registry, id, "moving", ["active", "paused"]);
  if (state.step === "database") {
    const level = await ctx.operator.op<MigrationLevel>("level", { client: id });
    state.schemaVersion = level.schemaVersion;
    for (;;) {
      let step: {
        index: number;
        last: boolean;
        statements: number;
        sha256: string;
        path: string;
        next: unknown;
        counts?: Record<string, number>;
      };
      try {
        step = await ctx.operator.op("export-db-part", {
          client: id,
          exportKey: state.exportKey,
          cursor: state.cursor,
        });
      } catch (error) {
        if (state.cursor === null) throw error;
        // A resumed export whose hold lapsed: the database is taken again from its start.
        ctx.io.out(`  database: starting again (${(error as Error).message})`);
        state.cursor = null;
        state.parts = [];
        continue;
      }
      state.parts = [
        ...state.parts.filter((p) => p.path !== step.path),
        { path: step.path, sha256: step.sha256, statements: step.statements },
      ];
      if (step.counts) state.counts = step.counts;
      state.cursor = step.next;
      await saveOperation(ctx.registry, op.id, state);
      if (!step.next) break;
    }
    ctx.io.out(
      `  database: ${state.parts.length} parts, ${Object.keys(state.counts).length} tables`,
    );
    state.step = "files";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "files") {
    for (;;) {
      const page = await ctx.operator.op<{ files: ExportManifest["files"]; next: string | null }>(
        "export-files-page",
        {
          client: id,
          exportKey: state.exportKey,
          ...(state.fileCursor ? { cursor: state.fileCursor } : {}),
        },
      );
      const seen = new Set(page.files.map((f) => f.key));
      state.files = [...state.files.filter((f) => !seen.has(f.key)), ...page.files];
      state.fileCursor = page.next;
      await saveOperation(ctx.registry, op.id, state);
      if (!page.next) break;
    }
    ctx.io.out(`  files: ${state.files.length}`);
    state.step = "manifest";
    await saveOperation(ctx.registry, op.id, state);
  }
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    client: id,
    environment: client.environment,
    generation: client.secretGeneration,
    exportedAt: op.startedAt,
    schemaVersion: state.schemaVersion,
    database: {
      parts: [...state.parts].sort((a, b) => a.path.localeCompare(b.path)),
      counts: state.counts,
    },
    files: [...state.files].sort((a, b) => a.key.localeCompare(b.key)),
    videos: "not exported",
    senderDomains: (await listSenderDomains(ctx.registry, id)).map((d) => d.domain),
  };
  await ctx.operator.op("export-manifest", { client: id, exportKey: state.exportKey, manifest });
  if (input.out) await downloadExport(ctx, id, state.exportKey, manifest, input.out);
  if (!input.leaving) {
    await setClientStatus(ctx.registry, id, state.previousStatus, ["moving"]);
  }
  state.step = "done";
  await finishOperation(ctx.registry, op.id, "succeeded", state);
  ctx.io.out(
    `\nExported ${id}: ${state.exportKey} in the exports bucket (kept 90 days)${input.out ? `, and ${input.out}` : ""}. ${input.leaving ? `${id} stays moving: served nowhere.` : `${id} is ${state.previousStatus} again.`}`,
  );
  return 0;
}

/** Downloads an export to `out`, checking each part's and file's hash, and the secrets beside. */
async function downloadExport(
  ctx: FleetContext,
  id: string,
  exportKey: string,
  manifest: ExportManifest,
  out: string,
): Promise<void> {
  mkdirSync(out, { recursive: true });
  for (const part of manifest.database.parts) {
    const bytes = await ctx.operator.getExport(part.path);
    if (sha256(bytes) !== part.sha256) throw new FleetError(`${part.path} did not download whole`);
    const path = inside(out, part.path.slice(exportKey.length + 1));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  for (const file of manifest.files) {
    const bytes = await ctx.operator.getExport(`${exportKey}/files/${file.key}`);
    if (sha256(bytes) !== file.sha256)
      throw new FleetError(`file ${file.key} did not download whole`);
    const path = inside(out, join("files", file.key));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const local = {
    ...manifest,
    database: {
      ...manifest.database,
      parts: manifest.database.parts.map((p) => ({
        ...p,
        path: p.path.slice(exportKey.length + 1),
      })),
    },
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(local, null, 2)}\n`);
  const secrets = await ctx.operator.op<{
    derived: Record<string, string>;
    given: Record<string, string>;
    problems: string[];
  }>("secrets-export", { client: id });
  const secretsPath = join(out, "secrets.json");
  writeFileSync(
    secretsPath,
    `${JSON.stringify({ client: id, derived: secrets.derived, given: secrets.given }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(secretsPath, 0o600);
  for (const problem of secrets.problems) ctx.io.err(`  secrets: ${problem}`);
  ctx.io.out(
    `  downloaded to ${out}; secrets.json (mode 0600) holds ${Object.keys(secrets.derived).length + Object.keys(secrets.given).length} secrets by name: keep it as you keep a password`,
  );
}

// --- import ----------------------------------------------------------------------------------------

/** An export folder as `cos client import` and `cos install --import` read it: checked whole first. */
export function readExportFolder(dir: string): {
  manifest: ExportManifest;
  parts: ExportPart[];
  files: { key: string; bytes: Uint8Array }[];
  secrets: { derived: Record<string, string>; given: Record<string, string> } | null;
} {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new FleetError(`${dir} holds no manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) {
    throw new FleetError(`${dir} is not a ${EXPORT_FORMAT} export`);
  }
  const parts: ExportPart[] = [];
  for (const part of manifest.database.parts) {
    const bytes = new Uint8Array(readFileSync(inside(dir, part.path)));
    if (sha256(bytes) !== part.sha256)
      throw new FleetError(`${part.path} is not what was exported`);
    parts.push(JSON.parse(Buffer.from(bytes).toString("utf8")) as ExportPart);
  }
  if (!parts.at(-1)?.last) throw new FleetError(`${dir}'s database ends before its last part`);
  const files = manifest.files.map((file) => {
    const bytes = new Uint8Array(readFileSync(inside(dir, join("files", file.key))));
    if (sha256(bytes) !== file.sha256)
      throw new FleetError(`file ${file.key} is not what was exported`);
    return { key: file.key, bytes };
  });
  const secretsPath = join(dir, "secrets.json");
  const secrets = existsSync(secretsPath)
    ? (JSON.parse(readFileSync(secretsPath, "utf8")) as {
        derived: Record<string, string>;
        given: Record<string, string>;
      })
    : null;
  return { manifest, parts, files, secrets };
}

interface ImportState {
  step: "rows" | "database" | "views" | "files" | "secrets" | "done";
  partsDone: number;
  filesDone: number;
}

export interface ImportInput extends Omit<AddInput, "imported"> {
  from: string;
  /** Leave the export's secrets out: every secret of the client is derived (a planned sign-out). */
  withoutSecrets?: boolean;
}

/**
 * `cos client import <id> --from <folder>`: an export (of this host's client, or of a single-client
 * deployment in the same format) brought in as a new client added as `imported`: its database
 * imported part by part (each part one transaction, the schema then checked against this code's
 * migrations, the row counts against the export's), its files, and its own secrets stored sealed
 * as `imported` rows so its sessions, cards, PINs, app codes and desk enrolments carry on (given
 * secrets as given ones), then migrated to this release, its search index queued for rebuilding,
 * and served. Its videos are not copied: those its records name that this account's Stream holds
 * are re-stamped with the client's creator (`clientStamp`, `<environment>:<client>`, step 5), so
 * the host's video host serves them to it; any this account does not hold are named (issue #525).
 *
 * Crash and re-run: the client is paused until the end; a re-run carries on from the operation's
 * step (an unfinished database import resumes from its next part, files from the next one not
 * written, secrets are written again, which overwrites them with the same values).
 */
export async function importClient(ctx: FleetContext, input: ImportInput): Promise<number> {
  const id = idOf(input.id);
  if (!ctx.dryRun) await ctx.operator.claim?.();
  const folder = readExportFolder(input.from);
  const client = plannedClient(ctx, { ...input, id, imported: true });
  const problems = [
    ...newClientProblems(client, { callbackHostname: ctx.fleet.callbackHostname }),
    ...fleetHostnameProblems(ctx, client),
  ];
  if (problems.length) throw new FleetError(`Cannot import ${id}: ${problems.join("; ")}`);
  await refuseDuringUpdate(ctx, `import ${id}`);
  // Every derivable secret it brings must be strong enough to sign the client's sessions: checked
  // whole before anything is written (S5).
  if (folder.secrets && !input.withoutSecrets) {
    for (const [name, value] of Object.entries(folder.secrets.derived ?? {})) {
      if (!isDerivedSecretName(name)) continue;
      const weak = importedSecretProblem(value);
      if (weak) throw new FleetError(`Cannot import ${id}: its ${name} is too weak (${weak})`);
    }
  }
  let op = await unfinishedOperation<ImportState>(ctx.registry, "import", id);
  const existing = await readClient(ctx.registry, id);
  if (!op) {
    if (existing) {
      throw new FleetError(
        `${id} is already a client: an import only adds a new one (remove ${id} first, which keeps its id from being used again, and import under another id)`,
      );
    }
    if (await wasRemoved(ctx.registry, id)) {
      throw new FleetError(`${id} was a client once and was removed: an id is never used again`);
    }
    const taken = await hostnamesTaken(
      ctx.registry,
      client.hostnames.map((h) => h.hostname),
    );
    if (taken.length) {
      throw new FleetError(`Taken: ${taken.map((t) => `${t.hostname} (${t.client})`).join(", ")}`);
    }
    await refuseSharedDomain(ctx, id, client);
  }
  const total = Object.values(folder.manifest.database.counts).reduce((a, b) => a + b, 0);
  if (ctx.dryRun) {
    ctx.io.out(
      `Would import ${folder.manifest.client}'s export as ${id} (imported): ${folder.parts.length} database parts, ${total} rows in ${Object.keys(folder.manifest.database.counts).length} tables, ${folder.files.length} files, ${folder.secrets && !input.withoutSecrets ? "its secrets" : "no secrets (all derived)"}. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  if (!op) {
    op = await beginOperation<ImportState>(ctx.registry, "import", id, {
      step: "rows",
      partsDone: 0,
      filesDone: 0,
    });
  } else {
    ctx.io.out(`Carrying on the import of ${id} started ${op.startedAt}.`);
  }
  const state = op.state;
  if (!(await readClient(ctx.registry, id))) await addClientRows(ctx.registry, client);
  const record = await readClient(ctx.registry, id);
  if (!record?.imported) throw new FleetError(`${id} is not a client added as imported`);
  if (state.step === "rows") state.step = "database";
  if (state.step === "database") {
    for (const part of folder.parts) {
      const step = await ctx.operator.op<{ applied: boolean; done: boolean }>("import-db-part", {
        client: id,
        part,
        migrations: ctx.migrations,
      });
      state.partsDone = part.index + 1;
      await saveOperation(ctx.registry, op.id, state);
      if (step.done) break;
    }
    ctx.io.out(`  database: ${folder.parts.length} parts, ${total} rows, checked`);
    state.step = "views";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "views") {
    // No view came from the export: made again from the host's own definitions (N3).
    const made = await ctx.operator.op<{ views: number }>("rebuild-views", {
      client: id,
      migrations: ctx.migrations,
    });
    ctx.io.out(`  views: ${made.views} made from this host's definitions`);
    state.step = "files";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "files") {
    for (const [i, file] of folder.files.entries()) {
      if (i < state.filesDone) continue;
      await ctx.operator.putFile(id, file.key, file.bytes);
      state.filesDone = i + 1;
      if (i % 20 === 19) await saveOperation(ctx.registry, op.id, state);
    }
    ctx.io.out(`  files: ${folder.files.length}`);
    state.step = "secrets";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "secrets") {
    const publicKey = await sealingPublicKey(ctx.fleet.secretsPublicKey);
    const place = { environment: record.environment, client: id };
    let n = 0;
    if (folder.secrets && !input.withoutSecrets) {
      for (const [name, value] of Object.entries(folder.secrets.derived ?? {})) {
        if (!isDerivedSecretName(name) || !value) continue;
        await writeImportedSecret(ctx.registry, publicKey, { ...place, name }, value);
        n += 1;
      }
      for (const [name, value] of Object.entries(folder.secrets.given ?? {})) {
        if (!isGivenSecretName(name) || !value) continue;
        await writeClientSecret(ctx.registry, publicKey, { ...place, name }, value);
        n += 1;
      }
    }
    ctx.io.out(
      `  secrets: ${n} stored sealed${n ? "" : " (every secret is derived: staff and customers sign in again)"}`,
    );
  }
  // Its sender domains, unverified: the operator verifies each again where it now sends from.
  for (const domain of folder.manifest.senderDomains ?? []) {
    try {
      await addSenderDomain(ctx.registry, id, domain, { fleetDomain: fleetRegistrable(ctx) });
      ctx.io.out(
        `  sender domain ${domain}: added, unverified (cos client sender verify ${id} ${domain})`,
      );
    } catch (error) {
      ctx.io.err(`  sender domain ${domain}: not added (${(error as Error).message})`);
    }
  }
  // Its videos: stamped with its creator, so the video host (step 5) serves them to this client.
  const { results: videos } = await ctx.operator.op<{ results: { stream_uid: string }[] }>(
    "query",
    {
      client: id,
      sql: "SELECT stream_uid FROM core_media WHERE kind = 'video' AND stream_uid IS NOT NULL ORDER BY stream_uid",
    },
  );
  if (videos.length) {
    const creator = clientStamp(record.environment, id);
    if (!ctx.videos) {
      ctx.io.err(`  videos: ${videos.length} named, not re-stamped (no Stream access here)`);
    } else {
      const missing: string[] = [];
      for (const { stream_uid: uid } of videos) {
        if (!(await ctx.videos.setCreator(uid, creator))) missing.push(uid);
      }
      ctx.io.out(`  videos: ${videos.length - missing.length} re-stamped as ${creator}`);
      if (missing.length) {
        ctx.io.err(
          `  videos: ${missing.length} not in this account's Stream (copy them, then import again or stamp them): ${missing.join(", ")}`,
        );
      }
    }
  }
  // An export from an earlier release: brought up to this one's schema.
  const report = await ctx.operator.op<{
    applied: string[];
    failed: { name: string; error: string } | null;
    level: MigrationLevel;
  }>("migrate", { client: id, migrations: ctx.migrations });
  if (report.failed) {
    throw new FleetError(
      `${id}'s database stopped at migration ${report.failed.name}: it stays paused`,
    );
  }
  await ctx.operator.op("requeue-embeddings", { client: id });
  await attachHostnames(ctx, id, client);
  await recordSchemaVersion(ctx.registry, id, versionOf(id, report.level));
  await setClientStatus(ctx.registry, id, "active", ["paused"]);
  state.step = "done";
  await finishOperation(ctx.registry, op.id, "succeeded", state);
  ctx.io.out(`\nImported ${id}. Its search index is rebuilt by the host's embeddings tick.`);
  for (const h of client.hostnames) {
    ctx.io.out(
      `  ${h.surface} https://${h.hostname}${h.verified === false ? " (unverified)" : ""}`,
    );
  }
  ctx.io.out(REFRESH_NOTE);
  return 0;
}

// --- remove ----------------------------------------------------------------------------------------

interface RemoveState {
  step: "export" | "stores" | "hostnames" | "registry" | "done";
  exported: boolean;
}

/**
 * `cos client remove <id>`: an export kept 90 days (as `cos client export --leaving`, into the
 * exports bucket), then the client's database erased, its files, OAuth keys and search vectors
 * deleted, and last its registry rows, which keeps its id in `registry_removed_clients` for good.
 * Its Durable Objects (assistant threads, jobs, workspaces) are left as they are, unreachable: each
 * is named with the client's generation, which no later client has, and the registry never gives
 * the id again. Its parked messages are given up when they come back (the client is gone).
 *
 * Crash and re-run: before the export finished, the client is `moving` and a re-run finishes the
 * export (its own operation); after it, the client is still `moving`, served nowhere, and a re-run
 * deletes again what is left (each deletion is a page at a time and finds what is left), then
 * removes the rows. Its rows go last, so a crash never leaves stores no row speaks for.
 */
export async function removeClient(ctx: FleetContext, raw: string): Promise<number> {
  const id = idOf(raw);
  if (!ctx.dryRun) await ctx.operator.claim?.();
  const client = await readClient(ctx.registry, id);
  let op = await unfinishedOperation<RemoveState>(ctx.registry, "remove", id);
  if (!client) {
    if (op) await finishOperation(ctx.registry, op.id, "succeeded", { ...op.state, step: "done" });
    throw new FleetError(
      (await wasRemoved(ctx.registry, id)) ? `${id} is removed already` : `No client ${id}`,
    );
  }
  if (ctx.dryRun) {
    ctx.io.out(
      `Would remove ${id}: export it (kept 90 days), erase its database, delete its files, OAuth keys and search vectors, then its registry rows (its id is never used again). Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  await confirmFor(ctx, id, `This removes ${id} and everything of it (an export is kept 90 days)`);
  if (!op)
    op = await beginOperation<RemoveState>(ctx.registry, "remove", id, {
      step: "export",
      exported: false,
    });
  else ctx.io.out(`Carrying on the removal of ${id} started ${op.startedAt}.`);
  const state = op.state;
  if (state.step === "export") {
    await exportClient({ ...ctx, yes: true }, { id, leaving: true });
    state.exported = true;
    state.step = "stores";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "stores") {
    const erased = await ctx.operator.op<{ ok: boolean; error?: string }>("erase-db", {
      client: id,
    });
    if (!erased.ok) throw new FleetError(`${id}'s database was not erased: ${erased.error}`);
    for (const action of ["files-delete-page", "kv-delete-page", "vectors-delete-page"]) {
      let deleted = 0;
      for (let page = 0; page < 10_000; page += 1) {
        const step = await ctx.operator.op<{ deleted: number; more: boolean }>(action, {
          client: id,
        });
        deleted += step.deleted;
        if (!step.more) break;
      }
      ctx.io.out(`  ${action.replace("-delete-page", "")}: ${deleted} deleted`);
    }
    state.step = "hostnames";
    await saveOperation(ctx.registry, op.id, state);
  }
  if (state.step === "hostnames") {
    // Its hostnames off Cloudflare (stage 66 step 8) while its rows still name them: a re-run
    // finds what is left. The client is `moving` meanwhile, served nowhere.
    await detachHostnames(ctx, id);
    state.step = "registry";
    await saveOperation(ctx.registry, op.id, state);
  }
  await removeClientRows(ctx.registry, id);
  state.step = "done";
  await finishOperation(ctx.registry, op.id, "succeeded", state);
  ctx.io.out(`\nRemoved ${id}. Its id is never used again. ${REFRESH_NOTE}`);
  return 0;
}
