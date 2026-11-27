// A running client's settings and its first admin (stage 66 step 9, ADR 0618 "The first client's
// day one"), over the registry only: these commands never open the operator's Worker.
//
//   cos client setting list <id> [--show-email]
//   cos client setting set <id> <NAME> <value>      only the names `OPERATOR_SETTINGS` lists
//   cos client setting unset <id> <NAME>
//   cos client first-admin <id> --email <addr> --token-sha256 <hex>
//   cos client first-admin-token --staff-hostname <host>       offline, on the owner's machine
//
// A change is served within the registry's refresh (10 seconds). Widening `COS_PACKS` needs
// nothing more: the host installs a newly listed pack (its objects, its migrations, as
// `extension.install` does) at the client's next staff or API request, as it installs a new
// release's packs, and a pack only installs with the packs it requires, so those are named too.
//
// The first admin's setup token never reaches the operator's commands: the owner makes it on his
// own machine (`first-admin-token`), keeps the link, and gives the registry command only its
// SHA-256, so nothing that could make the client's first account is in a workflow, its inputs or
// its log (the fleet's commands run in a public repository's Actions).
import { createHash, randomBytes } from "node:crypto";
import {
  type ClientId,
  canonicalHostname,
  FIRST_ADMIN_FRAGMENT,
  FIRST_ADMIN_LINK_HOURS,
  firstAdminEmail,
  firstAdminValue,
  isClientSetting,
  labelProblem,
  OPERATOR_SETTINGS,
  operatorSettingProblem,
  parseFirstAdmin,
  type SettingContext,
  validateClientId,
} from "@composable-os/db/registry";
import {
  readClient,
  readClientSettings,
  setClientSetting,
  setFirstAdmin,
  staffHostnameOf,
} from "@composable-os/db/registry-writes";
import type { Io } from "../io.ts";
import {
  confirmFor,
  type FleetContext,
  FleetError,
  type PackCatalogue,
  packsProblems,
  registrableDomain,
} from "./clients.ts";

const REFRESH_NOTE = "A running host serves the change within 10 seconds (its registry refresh).";

function idOf(raw: string | undefined): ClientId {
  if (!raw) throw new FleetError("Name the client: cos client <command> <id>");
  try {
    return validateClientId(raw);
  } catch (error) {
    throw new FleetError((error as Error).message);
  }
}

const listOf = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** The fleet's registrable domain, which no other client's hostname may be under. */
export function fleetDomainOf(ctx: Pick<FleetContext, "fleet">): string {
  return registrableDomain(ctx.fleet.domain);
}

/**
 * What is wrong with `COS_PACKS=<value>` for a client whose own row is `current` (null: it has
 * none, so no packs): `add`'s own check (`packsProblems`, the release's catalogue: `*` refused,
 * every pack carried, every pack they require listed), then never narrower than the client's
 * list. Taking a pack out leaves it installed in the client's database, no longer updated by a
 * release, so it is refused.
 */
export function packsProblem(
  value: string,
  current: string | null,
  catalogue: PackCatalogue | null | undefined,
): string | null {
  const packs = listOf(value);
  const problems = packsProblems({ settings: { COS_PACKS: value } }, catalogue);
  if (problems.length) return problems.join("; ");
  if (current !== null) {
    const dropped = listOf(current).filter((p) => !packs.includes(p));
    if (dropped.length) {
      return `a client's packs only widen: ${dropped.join(", ")} would be taken out, which leaves ${dropped.length > 1 ? "them" : "it"} installed and no longer updated`;
    }
  }
  return null;
}

/**
 * What is wrong with the settings `cos client add` was given, one line each: exactly the setting
 * command's names and checks (every other name refused, the first admin only through `--admin`),
 * against the hostnames the client is added with, and packs as above.
 */
export function addSettingsProblems(
  settings: Record<string, string>,
  catalogue: PackCatalogue | null | undefined,
  context: SettingContext = {},
): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(settings)) {
    if (name === "COS_FIRST_ADMIN") {
      problems.push("COS_FIRST_ADMIN: name the first admin with --admin <email>");
      continue;
    }
    const problem = operatorSettingProblem(name, value, context);
    if (problem) problems.push(problem);
    else if (name === "COS_PACKS") {
      const packs = packsProblem(value, null, catalogue);
      if (packs) problems.push(packs);
    }
  }
  return problems;
}

/**
 * `COS_FIRST_ADMIN` as the operator reads it: that it is set and until when, the address only when
 * asked (`--show-email`: in a public log it is a client's personal data); never the hash.
 */
function shown(name: string, value: string, showEmail: boolean): string {
  if (name !== "COS_FIRST_ADMIN") return value;
  const admin = parseFirstAdmin(value);
  if (!admin) return "(not readable: none)";
  return `set${showEmail ? ` for ${admin.email}` : ""}, its setup link until ${admin.expires}`;
}

/** `cos client setting list|set|unset <id> [NAME] [value]`. */
export async function settingCommand(
  ctx: FleetContext,
  catalogue: PackCatalogue | null | undefined,
  verb: string | undefined,
  raw: string | undefined,
  name: string | undefined,
  value: string | undefined,
  options: { showEmail?: boolean } = {},
): Promise<number> {
  const id = idOf(raw);
  if (verb === "list") {
    if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
    const own = await readClientSettings(ctx.registry, id);
    const names = Object.keys(own).filter(isClientSetting);
    if (!names.length) ctx.io.out(`${id} has no settings of its own: each is the deployment's.`);
    for (const n of names) {
      ctx.io.out(`  ${n}=${shown(n, own[n] as string, Boolean(options.showEmail))}`);
    }
    ctx.io.out(`Settings this command changes: ${Object.keys(OPERATOR_SETTINGS).join(", ")}.`);
    return 0;
  }
  if ((verb !== "set" && verb !== "unset") || !name || (verb === "set" && value === undefined)) {
    throw new FleetError(
      "cos client setting list <id> | setting set <id> <NAME> <value> | setting unset <id> <NAME>",
    );
  }
  const next = verb === "set" ? (value as string) : null;
  // The name first, before any registry read.
  const named = operatorSettingProblem(name, null);
  if (named) throw new FleetError(named);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  const fleetDomain = fleetDomainOf(ctx);
  const ownHostnames = await clientHostnames(ctx, id);
  const problem = operatorSettingProblem(name, next, { ownHostnames, fleetDomain });
  if (problem) throw new FleetError(problem);
  const own = await readClientSettings(ctx.registry, id);
  const current = Object.hasOwn(own, name) ? (own[name] as string) : null;
  if (name === "COS_PACKS") {
    if (next === null) {
      throw new FleetError(
        "COS_PACKS is never unset: a client's packs are always an explicit list (what a client with none gets is the deployment's choice, and a pack taken out stays installed and is no longer updated). Set the list instead.",
      );
    }
    const packs = packsProblem(next, current, catalogue);
    if (packs) throw new FleetError(packs);
  }
  if (next !== null && current === next) {
    ctx.io.out(`${id}'s ${name} is already ${next}. Nothing was changed.`);
    return 0;
  }
  if (next === null && current === null) {
    ctx.io.out(`${id} has no ${name} of its own. Nothing was changed.`);
    return 0;
  }
  const what =
    next === null
      ? `remove ${id}'s ${name} (${current}); it becomes the deployment's, or none`
      : `${current === null ? "set" : `replace ${current} with`} ${next} as ${id}'s ${name}`;
  if (ctx.dryRun) {
    ctx.io.out(`Would ${what}. Nothing was changed (--dry-run).`);
    return 0;
  }
  if (name === "COS_PACKS" && current === null) {
    await confirmFor(
      ctx,
      id,
      `${id} has no pack list of its own until now: any pack already installed in its database stays installed, and only the packs named are updated by a release from now on`,
    );
  } else if (current !== null) {
    await confirmFor(ctx, id, `This will ${what}`);
  }
  await setClientSetting(ctx.registry, id, name, next, { fleetDomain });
  ctx.io.out(`${next === null ? "Removed" : "Set"} ${id}'s ${name}. ${REFRESH_NOTE}`);
  if (name === "COS_PACKS") {
    ctx.io.out(
      "  The host installs each newly listed pack (its objects and migrations) at the client's next staff or API request. Its routine email stays off until an admin turns it on.",
    );
  }
  return 0;
}

/** A client's hostnames in the registry, verified or not. */
async function clientHostnames(ctx: FleetContext, id: ClientId): Promise<string[]> {
  const { results } = await ctx.registry
    .prepare("SELECT hostname FROM registry_hostnames WHERE client = ?")
    .bind(id)
    .all<{ hostname: string }>();
  return results.map((r) => r.hostname);
}

// --- The first admin ------------------------------------------------------------------------------

/** A new setup token: 32 random bytes, base64url (43 characters), what the sign-in page reads. */
export function newSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

const sha256Hex = (token: string) => createHash("sha256").update(token).digest("hex");

/** What is wrong with a setup token's SHA-256 as the operator gives it, or null: 64 hex. */
export function tokenHashProblem(value: string): string | null {
  return /^[0-9a-f]{64}$/.test(value) ? null : "it is not a SHA-256: 64 lowercase hex characters";
}

/** Whether the command runs in CI, where what it prints lands in a log. */
export function inCi(env: { CI?: string; GITHUB_ACTIONS?: string }): boolean {
  return Boolean(env.CI || env.GITHUB_ACTIONS);
}

/**
 * Where a first admin's setup token comes from: its SHA-256 the owner made with
 * `first-admin-token` (`--token-sha256`; nothing of the token is in the command at all), or a
 * token `cos` makes and prints with the link (`--print-link`), for a person at a terminal only.
 */
export type SetupTokenSource = { sha256: string } | { print: true };

/**
 * The token source a command's flags name, checked before anything is written: exactly one of the
 * hash or `--print-link`, a hash of 64 hex, and `--print-link` never in CI (`CI` or
 * `GITHUB_ACTIONS`), where the link would land in a log.
 */
export function setupTokenSource(
  sha256: string | undefined,
  printLink: boolean,
  env: { CI?: string; GITHUB_ACTIONS?: string },
  hashFlag: string,
): SetupTokenSource {
  if (sha256 !== undefined && printLink) {
    throw new FleetError(`Give ${hashFlag} or --print-link, not both`);
  }
  if (sha256 !== undefined) {
    const problem = tokenHashProblem(sha256);
    if (problem) throw new FleetError(`${hashFlag} is refused: ${problem}`);
    return { sha256 };
  }
  if (printLink) {
    if (inCi(env)) {
      throw new FleetError(
        `--print-link is refused in CI (CI or GITHUB_ACTIONS is set): the link would be in the log. Make the token on your own machine with cos client first-admin-token, and pass ${hashFlag} <its sha256>.`,
      );
    }
    return { print: true };
  }
  throw new FleetError(
    `The first admin's setup token: ${hashFlag} <sha256> (from cos client first-admin-token, run on your own machine), or --print-link at a terminal`,
  );
}

/**
 * `cos client first-admin <id> --email <addr>` (and `cos client add --admin`): names who may make
 * the client's first account. The registry keeps the address and the token's SHA-256 only; a new
 * one replaces the last. With `--token-sha256`, nothing of the token exists here and nothing
 * names the admin in what is printed (the address is a client's personal data, and the log may be
 * public): only that the setting was stored, and until when. With `--print-link`, `cos` makes the
 * token and prints the link once. It works until it expires, and does nothing once the client has
 * its first account; whether it has one is in the client's database, which these registry
 * commands do not read.
 */
export async function firstAdminCommand(
  ctx: FleetContext,
  raw: string | undefined,
  email: string | undefined,
  options: {
    source: SetupTokenSource;
    now?: Date;
    /** The token `--print-link` uses (tests only). */
    token?: string;
  },
): Promise<number> {
  const id = idOf(raw);
  const address = email ? firstAdminEmail(email) : null;
  if (!address) throw new FleetError("Name the first admin's email address: --email <address>");
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  const staff = await staffHostnameOf(ctx.registry, id);
  if (!staff) throw new FleetError(`${id} has no verified staff hostname to sign up at`);
  const hashed = "sha256" in options.source;
  if (ctx.dryRun) {
    ctx.io.out(
      `Would name ${id}'s first admin${hashed ? "" : " and print a setup link"}. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  const now = options.now ?? ctx.now?.() ?? new Date();
  const token = "sha256" in options.source ? null : (options.token ?? newSetupToken());
  const sha256 = "sha256" in options.source ? options.source.sha256 : sha256Hex(token as string);
  const expires = new Date(now.getTime() + FIRST_ADMIN_LINK_HOURS * 3_600_000).toISOString();
  await setFirstAdmin(ctx.registry, id, firstAdminValue({ email: address, sha256, expires }));
  if (!token) {
    ctx.io.out(
      `Stored ${id}'s first admin; its setup link works until ${expires}, for the address you named, once.`,
    );
    return 0;
  }
  ctx.io.out(`${address} may make ${id}'s first account, until ${expires}, with this link:`);
  ctx.io.out(`  https://${staff}/sign-in#${FIRST_ADMIN_FRAGMENT}=${token}`);
  ctx.io.out(
    "  It is shown once and kept nowhere: send it to them yourself. It works for that address only, and does nothing once the client has its first account.",
  );
  return 0;
}

/**
 * `cos client first-admin-token --staff-hostname <host>`: for the owner, on his own machine, never
 * in CI (refused there). No registry and no Cloudflare token: it makes a setup token and prints
 * the link to send the client's first admin and the SHA-256 to give `cos client add --admin …
 * --admin-token-sha256` or `cos client first-admin … --token-sha256`.
 */
export function firstAdminTokenCommand(
  io: Io,
  env: { CI?: string; GITHUB_ACTIONS?: string },
  staffHostname: string | undefined,
  token: string = newSetupToken(),
): number {
  if (inCi(env)) {
    throw new FleetError(
      "cos client first-admin-token runs on your own machine, never in CI (CI or GITHUB_ACTIONS is set): what it prints makes the client's first account",
    );
  }
  const host = staffHostname ? canonicalHostname(staffHostname) : null;
  if (!host) {
    throw new FleetError(
      "--staff-hostname <host>: the client's staff hostname (<id>-admin.<domain>)",
    );
  }
  io.out("The link, for the client's first admin only (send it to them yourself):");
  io.out(`  https://${host}/sign-in#${FIRST_ADMIN_FRAGMENT}=${token}`);
  io.out("The SHA-256, for the operator's command (cos keeps only this; it opens nothing):");
  io.out(`  ${sha256Hex(token)}`);
  io.out(
    `Give it to cos client add <id> --admin <email> --admin-token-sha256 <sha256>, or cos client first-admin <id> --email <email> --token-sha256 <sha256>. The link then works for ${FIRST_ADMIN_LINK_HOURS} hours.`,
  );
  return 0;
}

/** `--label` for `cos client add`: the client's own label, checked. */
export function labelSetting(label: string): Record<string, string> {
  const problem = labelProblem(label);
  if (problem) throw new FleetError(`--label: ${problem}`);
  return { COS_PRODUCT_LABEL: label };
}
