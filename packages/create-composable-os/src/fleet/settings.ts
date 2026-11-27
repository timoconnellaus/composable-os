// A running client's settings and its first admin (stage 66 step 9, ADR 0618 "The first client's
// day one"), over the registry only: these commands never open the operator's Worker.
//
//   cos client setting list <id>
//   cos client setting set <id> <NAME> <value>      only the names `OPERATOR_SETTINGS` lists
//   cos client setting unset <id> <NAME>
//   cos client first-admin <id> <email>             a new setup link, printed once
//
// A change is served within the registry's refresh (10 seconds). Widening `COS_PACKS` needs
// nothing more: the host installs a newly listed pack (its objects, its migrations, as
// `extension.install` does) at the client's next staff or API request, as it installs a new
// release's packs, and a pack only installs with the packs it requires, so those are named too.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ClientId,
  FIRST_ADMIN_FRAGMENT,
  FIRST_ADMIN_LINK_HOURS,
  firstAdminEmail,
  firstAdminValue,
  isClientSetting,
  labelProblem,
  OPERATOR_SETTINGS,
  operatorSettingProblem,
  parseFirstAdmin,
  validateClientId,
} from "@composable-os/db/registry";
import {
  readClient,
  readClientSettings,
  setClientSetting,
  staffHostnameOf,
} from "@composable-os/db/registry-writes";
import { type ClientKit, kitPacks, requiredPacks } from "../client-repo.ts";
import { confirmFor, type FleetContext, FleetError } from "./clients.ts";

const REFRESH_NOTE = "A running host serves the change within 10 seconds (its registry refresh).";

/** The packs the installed release carries, and what each requires (its client kit). */
export interface ReleasePacks {
  carried: ReadonlySet<string>;
  /** The packs `packs` require and do not list, followed to the end. */
  requires(packs: readonly string[]): string[];
}

/** The installed release's packs, from its verified bundle's client kit. */
export function releasePacksOf(kit: ClientKit): ReleasePacks {
  return { carried: kitPacks(kit), requires: (packs) => requiredPacks(kit, packs) };
}

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

/**
 * What is wrong with `COS_PACKS=<value>` for a client whose own row is `current` (null: it has
 * none and inherits the deployment's packs): every pack carried by the installed release, every
 * pack they require named too, and never narrower than the client's own list. Taking a pack out
 * of the list leaves it installed in the client's database, no longer updated by a release, so it
 * is refused.
 */
export function packsProblem(
  value: string,
  current: string | null,
  release: ReleasePacks,
): string | null {
  const packs = listOf(value);
  const missing = packs.filter((p) => !release.carried.has(p));
  if (missing.length) {
    return `the installed release does not carry ${missing.join(", ")} (it carries ${[...release.carried].sort().join(", ") || "none"})`;
  }
  const required = release.requires(packs);
  if (required.length) {
    return `${required.join(", ")} must be named too: a pack listed requires ${required.length > 1 ? "them" : "it"}`;
  }
  if (current !== null) {
    const dropped = listOf(current).filter((p) => !packs.includes(p));
    if (dropped.length) {
      return `a client's packs only widen: ${dropped.join(", ")} would be taken out, which leaves ${dropped.length > 1 ? "them" : "it"} installed and no longer updated`;
    }
  }
  return null;
}

/**
 * What is wrong with the settings `cos client add` was given, one line each: each value the
 * setting command would refuse, packs as above, and the first admin only through `--admin`.
 */
export function addSettingsProblems(
  settings: Record<string, string>,
  release: ReleasePacks,
): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(settings)) {
    if (name === "COS_FIRST_ADMIN") {
      problems.push("COS_FIRST_ADMIN: name the first admin with --admin <email>");
      continue;
    }
    if (!Object.hasOwn(OPERATOR_SETTINGS, name)) continue;
    const problem = operatorSettingProblem(name, value);
    if (problem) problems.push(problem);
    else if (name === "COS_PACKS") {
      const packs = packsProblem(value, null, release);
      if (packs) problems.push(`COS_PACKS: ${packs}`);
    }
  }
  return problems;
}

/** `COS_FIRST_ADMIN` as the operator reads it: who, until when; never the hash. */
function shown(name: string, value: string): string {
  if (name !== "COS_FIRST_ADMIN") return value;
  const admin = parseFirstAdmin(value);
  return admin ? `${admin.email}, its setup link until ${admin.expires}` : "(not readable: none)";
}

/** `cos client setting list|set|unset <id> [NAME] [value]`. */
export async function settingCommand(
  ctx: FleetContext,
  release: ReleasePacks,
  verb: string | undefined,
  raw: string | undefined,
  name: string | undefined,
  value: string | undefined,
): Promise<number> {
  const id = idOf(raw);
  if (verb === "list") {
    if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
    const own = await readClientSettings(ctx.registry, id);
    const names = Object.keys(own).filter(isClientSetting);
    if (!names.length) ctx.io.out(`${id} has no settings of its own: each is the deployment's.`);
    for (const n of names) ctx.io.out(`  ${n}=${shown(n, own[n] as string)}`);
    ctx.io.out(`Settings this command changes: ${Object.keys(OPERATOR_SETTINGS).join(", ")}.`);
    return 0;
  }
  if ((verb !== "set" && verb !== "unset") || !name || (verb === "set" && value === undefined)) {
    throw new FleetError(
      "cos client setting list <id> | setting set <id> <NAME> <value> | setting unset <id> <NAME>",
    );
  }
  const next = verb === "set" ? (value as string) : null;
  const problem = operatorSettingProblem(name, next);
  if (problem) throw new FleetError(problem);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  const own = await readClientSettings(ctx.registry, id);
  const current = Object.hasOwn(own, name) ? (own[name] as string) : null;
  if (name === "COS_PACKS") {
    if (next === null) {
      throw new FleetError(
        "COS_PACKS is never unset: the deployment's packs may differ from the client's, and a pack taken out stays installed and is no longer updated. Set the list instead.",
      );
    }
    const packs = packsProblem(next, current, release);
    if (packs) throw new FleetError(`COS_PACKS: ${packs}`);
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
      `${id} has had the deployment's packs until now: any of them already installed stays installed, and only the packs named are updated by a release from now on`,
    );
  } else if (current !== null) {
    await confirmFor(ctx, id, `This will ${what}`);
  }
  await setClientSetting(ctx.registry, id, name, next);
  ctx.io.out(`${next === null ? "Removed" : "Set"} ${id}'s ${name}. ${REFRESH_NOTE}`);
  if (name === "COS_PACKS") {
    ctx.io.out(
      "  The host installs each newly listed pack (its objects and migrations) at the client's next staff or API request. Its routine email stays off until an admin turns it on.",
    );
  }
  return 0;
}

/** A new setup link's token: 32 random bytes, base64url (43 characters). */
export function newSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What is wrong with a setup token the operator made, or null. Strong means at least 32 random
 * bytes, written as base64url (43 to 128 of `A-Z a-z 0-9 - _`, no padding) or as hex (64 to 128
 * of `0-9 a-f`), with no space or line inside, and not a run of a few characters (at least 16
 * different characters for base64url, 10 for hex). `openssl rand -hex 32` makes one.
 */
export function setupTokenProblem(token: string): string | null {
  if (/\s/.test(token)) return "it holds a space or a line break";
  const hex = /^[0-9a-f]{64,128}$/.test(token);
  const b64 = /^[A-Za-z0-9_-]{43,128}$/.test(token);
  if (!hex && !b64) {
    return "it is not 32 random bytes or more as hex (64 to 128 of 0-9 a-f) or base64url (43 to 128 of A-Z a-z 0-9 - _)";
  }
  if (new Set(token).size < (hex ? 10 : 16))
    return "it is not random (too few different characters)";
  return null;
}

/** The setup token in `path`, checked: one trailing line break is dropped, nothing else. */
export function readSetupToken(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new FleetError(`The setup token file ${path} cannot be read`);
  }
  const token = text.replace(/\r?\n$/, "");
  const problem = setupTokenProblem(token);
  // The value is never part of an error: it is a credential.
  if (problem) throw new FleetError(`The setup token in ${path} is refused: ${problem}`);
  return token;
}

/** Whether the command runs in CI, where what it prints lands in a log. */
export function inCi(env: { CI?: string; GITHUB_ACTIONS?: string }): boolean {
  return Boolean(env.CI || env.GITHUB_ACTIONS);
}

/**
 * Where a setup link's token comes from: a file the operator made (`--admin-token-file`,
 * `--token-file`; nothing of it is printed), or made by `cos` and printed once (`--print-link`),
 * for a person at a terminal only.
 */
export type SetupTokenSource = { file: string } | { print: true };

/**
 * The token source a command's flags name, checked before anything is written: exactly one of
 * the file or `--print-link`, and `--print-link` never in CI (`CI` or `GITHUB_ACTIONS`), where the
 * link would land in a log.
 */
export function setupTokenSource(
  file: string | undefined,
  printLink: boolean,
  env: { CI?: string; GITHUB_ACTIONS?: string },
  fileFlag: string,
): SetupTokenSource {
  if (file && printLink) throw new FleetError(`Give ${fileFlag} or --print-link, not both`);
  if (file) return { file };
  if (printLink) {
    if (inCi(env)) {
      throw new FleetError(
        `--print-link is refused in CI (CI or GITHUB_ACTIONS is set): the link would be in the log. Make a token yourself and pass ${fileFlag} <file>.`,
      );
    }
    return { print: true };
  }
  throw new FleetError(
    `The first admin's setup token: ${fileFlag} <file> (a token you made, e.g. openssl rand -hex 32), or --print-link at a terminal`,
  );
}

/**
 * `cos client first-admin <id> <email>` (and `cos client add --admin`): names who may make the
 * client's first account. The registry keeps the address and the token's SHA-256 only; a new
 * token replaces the last. With a token file, nothing of the token is printed: the operator
 * builds the link from the token they made. With `--print-link`, `cos` makes one and prints the
 * link once. It works until it expires, and does nothing once the client has its first account.
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
    /** Registers the token with the command's redactor, so no output can carry it. */
    redact?: (value: string) => void;
  },
): Promise<number> {
  const id = idOf(raw);
  const address = email ? firstAdminEmail(email) : null;
  if (!address) throw new FleetError("Name the first admin's email address: --admin <email>");
  // Read and checked first, so a dry run and every refusal check it too, and never print it.
  const supplied = "file" in options.source ? readSetupToken(options.source.file) : null;
  if (supplied) options.redact?.(supplied);
  if (!(await readClient(ctx.registry, id))) throw new FleetError(`No client ${id}`);
  const staff = await staffHostnameOf(ctx.registry, id);
  if (!staff) throw new FleetError(`${id} has no verified staff hostname to sign up at`);
  if (ctx.dryRun) {
    ctx.io.out(
      `Would name ${address} ${id}'s first admin${supplied ? ", with the token you supplied" : " and print a setup link"}. Nothing was changed (--dry-run).`,
    );
    return 0;
  }
  const now = options.now ?? ctx.now?.() ?? new Date();
  const token = supplied ?? options.token ?? newSetupToken();
  const expires = new Date(now.getTime() + FIRST_ADMIN_LINK_HOURS * 3_600_000).toISOString();
  await setClientSetting(
    ctx.registry,
    id,
    "COS_FIRST_ADMIN",
    firstAdminValue({
      email: address,
      sha256: createHash("sha256").update(token).digest("hex"),
      expires,
    }),
  );
  if (supplied) {
    ctx.io.out(
      `${address} may make ${id}'s first account until ${expires}, with the token you made:`,
    );
    ctx.io.out(`  open https://${staff}/sign-in#${FIRST_ADMIN_FRAGMENT}=<your token>`);
    ctx.io.out(
      "  cos keeps only its hash and prints nothing of it. Send the link to them yourself. It works for that address only, and does nothing once the client has its first account.",
    );
    return 0;
  }
  ctx.io.out(`${address} may make ${id}'s first account, until ${expires}, with this link:`);
  ctx.io.out(`  https://${staff}/sign-in#${FIRST_ADMIN_FRAGMENT}=${token}`);
  ctx.io.out(
    "  It is shown once and kept nowhere: send it to them yourself. It works for that address only, and does nothing once the client has its first account. A new one replaces it: cos client first-admin <id> <email>.",
  );
  return 0;
}

/** `--label` for `cos client add`: the client's own label, checked. */
export function labelSetting(label: string): Record<string, string> {
  const problem = labelProblem(label);
  if (problem) throw new FleetError(`--label: ${problem}`);
  return { COS_PRODUCT_LABEL: label };
}
