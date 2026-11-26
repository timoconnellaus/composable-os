// create-composable-os / cos: install, upgrade, roll back and inspect a deployment of a Composable OS product in your own
// Cloudflare account, from a verified release bundle, with the Cloudflare REST API only
// (ADR 0163). Every command is safe to re-run.
//
//   npx @composable-os/cli install                      install (interactive)
//   npx @composable-os/cli install --yes --token … …    install (non-interactive, e.g. CI)
//   cos upgrade [--version X.Y.Z]       same steps as Settings → Updates
//   cos rollback                        undo the last update (redeploy + restore the bookmark)
//   cos status                          what is installed and what is available

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Pure data and functions (no Worker imports), bundled into the CLI by esbuild.
import {
  modelRolesVar,
  PROVIDER_INFO,
  ROLE_PRESETS,
  RoleLayerError,
} from "@composable-os/core/ai-roles";
import { PRODUCT_LABEL_VAR, type ProductDefinition } from "@composable-os/product";
import { DEFAULT_PRODUCT, products } from "@composable-os/products";
import {
  apiKillSwitchStore,
  appliedMigrationsViaApi,
  applyBundleMigrations,
  CHANNELS,
  type Channel,
  CloudflareClient,
  compareVersions,
  type DeploymentState,
  d1ApiMigrations,
  databaseIdOf,
  deployWorkers,
  type ExtraVerifier,
  fetchReleaseManifest,
  fetchVerifiedRelease,
  GATEWAY_TOKEN_SECRET,
  type GitHubOptions,
  gatewayProviderSlug,
  getRelease,
  healthSmoke,
  installedExtensionsViaApi,
  isLocationHint,
  JUDGE_BYOK_VAR,
  JUDGE_GATEWAY_PROVIDER,
  killSwitchControl,
  LOCATION_HINTS,
  type LocationHint,
  listReleases,
  locateDeployment,
  MODEL_ROLES_VAR,
  mergeSecrets,
  neededResources,
  newRunId,
  openBundle,
  type PreflightResult,
  preflight,
  provisionAiGateway,
  provisionResources,
  type ReleaseBundle,
  type RunRecord,
  releaseAssetNames,
  retireGatewayToken,
  rollbackTarget,
  runRollback,
  runsViaApi,
  runUpdate,
  saveRunViaApi,
  toHex,
  varWorkers,
  verifyBundleBytes,
  withByokProvider,
  withDeploymentVar,
  workersDevHostname,
  writeDeploymentState,
} from "@composable-os/release";
import { choose, type Io, type Redactor } from "./io.ts";

export const HELP = `cos: the Composable OS command. One command for a company's own repository and for
installing a product with no repository.

A client repo (stage 24)
  cos create <dir> [--label <name>] [--with-mobile] [--version x.y.z]
                                         a new client repo from the release's template (also
                                         \`npm create composable-os <dir>\`)
  cos init [--web <dir>] [--mobile <dir>] [--id <id>] [--label <name>] [--packs <list>]
           [--envs staging,live] [--yes]
                                         adopt the repo you are in: adds product.ts, skills/, each
                                         app's typed client and host module and the rules in
                                         AGENTS.md; shows a diff of every change to a file that
                                         exists and applies it with --yes. The id and label default
                                         to the folder's name; an adopted web app keeps its Worker
                                         and deploys itself (web.deploy "own"); --envs declares
                                         environments and binds HOST under the site's own ones
  cos deploy [--env <name>]              the host from the release in product.ts, with its packs and
                                         the org's own extensions (checked first), then the web app;
                                         with environments in product.ts, the one --env names
                                         (--rotate-customer-auth-secret: a new customer secret,
                                         which signs every customer out)
  cos upgrade [--version X.Y.Z]          in a client repo: move product.ts to a newer platform
                                         version, regenerate the client, replace skills/, report type
                                         errors; deploys nothing
  cos add <block>, cos diff <block> [--accept]
                                         copy a block from the release; show its upstream changes
                                         (--accept: record them as merged by hand)
                                         (cos add with no block lists them, with their skins)
  cos client generate                    in a client repo: each app's typed client, again (and
                                         the mobile app's brand.ts from product.ts)
  cos app check                          the mobile app before a store build: ids, icon, listing,
                                         nothing bought in the app, "Delete my account", no key
                                         file in the repo (stage 63, docs/app-publishing.md)
  cos app credentials [--check --for ios|android|record]
                                         the app workflow's secrets and how a person sets each;
                                         never a value (--check: fail on any one missing)
  cos app build-info [--env <name>] [--json]
                                         the next build number (the host's records) and the API
                                         version of the app's generated client
  cos app record [--env <name>] --platform ios,android --build <n> [--commit <sha>]
                                         record the builds a run sent to the testing tracks
  cos app upload --platform android [--env <name>] --file <app.aab> [--listing] [--draft]
                                         the Android build to the store's internal testing track;
                                         nothing is released to the public
  cos content import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes]
                                         load posts and their pictures into the host as you,
                                         signed in for the run (by code with --email, else in the
                                         browser); checks everything first and writes nothing on a
                                         problem; a re-run creates nothing twice; --publish
                                         publishes (or schedules) them with their own dates
                                         (docs/importing.md)
  cos courses import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes]
                     [--wait <minutes>]
                                         load courses, bundles, their videos (to Stream) and the
                                         students' access, completions and lesson progress from an
                                         old course platform, as you; checks first, uploads nothing
                                         twice on a re-run, keeps a student's own progress
                                         (docs/importing.md)
  cos subscriptions offers import <offers.csv> --host <url> --plan <object>[:<id>]
                     [--email <you>] [--dry-run] [--invite] [--reissue]
                                         continuation offers for people subscribed on another
                                         platform (email, paid-up date): each signs in and
                                         subscribes again, free until that date; people come
                                         first, none is created; --invite lets them sign in under
                                         any sign-up setting; --reissue gives an address staff
                                         withdrew a fresh offer (docs/importing.md)
  cos subscriptions offers report --host <url> [--status taken] [--out <file.csv>]
                                         who has taken their offer and when they are charged from,
                                         so you end exactly those old subscriptions
  cos programs import <folder> --host <url> [--email <you>] [--dry-run]
                                         load exercises, class types, programs in the pack's
                                         shorthand and past training (sessions and their sets), as
                                         you; checks everything first, a re-run makes nothing
                                         twice, an edit since is kept; what it brings in starts no
                                         automation and sends no message (docs/importing.md)
  cos rostering import <roster.csv> --host <url> [--email <you>] [--apply]
                                         duties and who works them (weekly patterns, one-off
                                         shifts); the host checks every date for someone on two
                                         shifts at once and names it; a dry run unless --apply;
                                         staff are invited first, never made (docs/importing.md)

Installing a product with no client repo
  cos install [options]                  install, or repair an existing install (idempotent)
  cos upgrade [--version X.Y.Z]          update to a newer release (preflight, bookmark, migrate,
                                         switch all Workers, smoke check; rolls back on failure)
  cos rollback                           redeploy the previous release and restore its bookmark
  cos status                             installed version, channel, URL and available releases
  cos uninstall                          delete the Workers, database, bucket and namespace (asks)
  cos ext check <dir> | test <dir>       in a checkout of the repository: check an extension with
                                         the checks the host runs, and run its tests
  cos client generate --out <dir>        in a checkout: write a product's typed client (customer.ts
                                         and staff.ts) from its registry; see cos client --help

A host of many clients (stage 66; docs/deploying.md "A host of many clients")
  cos fleet keys --env <live|staging> --out <file>
                                         the deployment's keys, written only to <file> (mode
                                         0600, refused inside a git working tree), never printed
  cos fleet install --env <e> --keys-file <f> --callback-hostname <h> --domain <d>
                                         the host, its registry, cos-client-db and the operator's
                                         Worker, with every binding a fleet needs
  cos fleet upgrade --env <e> --keys-file <f> [--version x.y.z] [--dry-run] [--yes]
                                         every client paused, bookmarked and migrated, the Workers
                                         uploaded once, smoke checked, resumed; a client whose
                                         migration fails is restored and nothing is uploaded; live
                                         only after staging (--skip-staging, deliberately)
  cos client add <id> [--env e] [--tier t] [--location oc] [--setting NAME=VALUE]… [--dry-run]
                                         a client: its registry rows, its database made and
                                         migrated, its two hostnames; no Worker uploaded
  cos client pause|resume <id>, cos client list
  cos client secret set|remove <id> <NAME> [--value-file f]
                                         a client's given secret, sealed (this command cannot
                                         read one back)
  cos client export <id> [--out <dir>] [--leaving]
                                         its database, files (and with --out its secrets) for a
                                         move or a leaving client; kept 90 days in the host
  cos client import <id> --from <dir>    an export brought in as a new, imported client
  cos client remove <id>                 exported (kept 90 days), then erased; its id is never
                                         used again
  Each asks for the client's id before removing or overwriting (or --yes); a re-run after a
  failure carries on where it stopped.

Options
  --token <t>            Cloudflare API token (or CLOUDFLARE_API_TOKEN). Needs, on the account:
                         Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV
                         Storage Edit, Queues Edit, Vectorize Edit, Account Settings Read; with AI
                         on, AI Gateway Edit, Account API Tokens Edit (to generate the gateway's
                         token) and Secrets Store Edit (for --provider-key); and for a custom
                         hostname, Zone Read + Workers Routes Edit on that zone.
  --account <id>         account id (or CLOUDFLARE_ACCOUNT_ID); asked when the token sees several
  --version <x.y.z>      release to install or upgrade to (default: newest on the channel)
  --channel <c>          stable (default) or beta
  --hostname <h>         "workers.dev" (default) or a hostname on one of your zones
  --zone <name>          the zone of a custom hostname (default: inferred from it)
  --identity <i>         better-auth (default) or cloudflare-access
  --location <hint>      a location hint for the D1 database and R2 buckets a first install
                         creates: none (default), or ${Object.keys(LOCATION_HINTS).join(", ")}
                         (oc is Oceania). A preference Cloudflare follows where it can, not a
                         guarantee; KV, queues and Vectorize take none. An existing install is
                         never moved (docs/deploying.md "Where data is stored")
  --gatekeepers <list>   optional gatekeeper Workers to install, e.g. google,email-send
  --ai <on|off>          in-app AI: Workers AI and the demo-records Vectorize index (default on,
                         or COS_AI). Off: AI features say "AI is not configured". Upgrades keep
                         the choice; re-run install with --ai to change it
  --ai-gateway <id|off>  AI Gateway every model call goes through (default: one named after the
                         install, e.g. crm, created with logging and authentication on and its
                         token, with AI Gateway Run and Workers AI Read, stored as
                         AI_GATEWAY_TOKEN). Workers AI then goes through it over REST with
                         prompt and response logging off. off: call Workers AI directly over
                         the binding
  --provider-key P=KEY   store a provider key in the gateway as BYOK (repeatable), e.g.
                         deepseek=… or openai=… (a custom provider by its slug; typesafe=… is
                         the judge's key, Jev, and sets JUDGE_BYOK). Never logged.
                         Keys can also be added later in Settings → AI
  --model-roles <m>      this deployment's model roles (the AI_MODEL_ROLES layer): a preset
                         (${Object.keys(ROLE_PRESETS).join(", ")}), a JSON file, inline JSON, or
                         default (the shipped Workers AI roles). Kept by upgrades; Settings → AI
                         overrides still win
  --ai-admin-token <t>   Settings → AI's token (or COS_AI_ADMIN_TOKEN), stored on demo-app as
                         CLOUDFLARE_API_TOKEN; permissions in docs/deploying.md "In-app AI"
  --secret NAME=VALUE    a secret to set (repeatable); WORKER:NAME=VALUE for a gatekeeper's
  --update-token <t>     store a scoped token so Settings → Updates can update in place
  --store-update-token   store --token itself for one-click updates
  --product <id>         the product to install (default ${DEFAULT_PRODUCT}; one of ${Object.keys(products).join(", ")})
  --repo <owner/repo>    where releases come from (default: the product's own repository)
  --no-gh                skip \`gh attestation verify\` even if gh is installed
  --require-gh           fail unless \`gh attestation verify\` passes (full Sigstore check)
  --wait                 after install, wait until /api/health answers
  --import <dir>         a client's export (cos client export --out) installed as this new
                         deployment: its database, files and secrets; staff and customers stay
                         signed in, and its search index is rebuilt (stage 66)
  --bundle-dir <dir>     use composable-os-<product>-<version>.tar.gz and SHA256SUMS from <dir> instead of downloading
                         (still verified against its build attestation)
  --yes                  don't ask; fail on anything that would need an answer
  -h, --help

Nothing is sent anywhere except the Cloudflare API and GitHub Releases. No telemetry.
`;

export interface Flags {
  [key: string]: string | boolean | string[] | undefined;
  secret?: string[];
}

export function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (!command) command = arg;
      else throw new Error(`unexpected argument ${arg}`);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const takesValue = ![
      "yes",
      "help",
      "no-gh",
      "require-gh",
      "wait",
      "store-update-token",
      "json",
      "unverified",
      "skip-build",
      "no-typecheck",
      "rotate-customer-auth-secret",
      "accept",
      "with-mobile",
      "dry-run",
      "publish",
      "invite",
      "reissue",
      "apply",
      "check",
      "listing",
      "draft",
      "leaving",
      "without-secrets",
      "skip-staging",
    ].includes(key);
    let value: string | boolean = true;
    if (takesValue) {
      value = inline ?? (argv[++i] as string);
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    if (key === "secret") flags.secret = [...(flags.secret ?? []), String(value)];
    else if (key === "provider-key")
      flags["provider-key"] = [...((flags["provider-key"] as string[]) ?? []), String(value)];
    else flags[key] = value;
  }
  return { command, flags };
}

export interface Env {
  /** Cloudflare API base (tests: the fake). */
  COS_CLOUDFLARE_API?: string;
  /** GitHub API base and download origin (tests: the fake). */
  COS_GITHUB_API?: string;
  /** Origin that answers /api/health instead of https://<hostname> (tests). */
  COS_HEALTH_ORIGIN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GITHUB_TOKEN?: string;
  /** The GitHub CLI's name for the same (`gh auth token`). */
  GH_TOKEN?: string;
  /** "off" installs without Workers AI and Vectorize (same as scripts/deploy.mjs). */
  COS_AI?: string;
  /** Settings → AI's token, stored as demo-app's CLOUDFLARE_API_TOKEN secret. */
  COS_AI_ADMIN_TOKEN?: string;
  /** Where the operator's Worker answers instead of its workers.dev address (tests). */
  COS_OPERATOR_ORIGIN?: string;
}

export interface Deps {
  /** The products `--product` may name, and the default one. Tests pass a fixture product. */
  products?: { all: Record<string, ProductDefinition>; default: string };
  io: Io;
  redactor: Redactor;
  env: Env;
  fetch?: typeof fetch;
  ghVerifier?: ExtraVerifier | null;
  smokeDelayMs?: number;
}

export class CliError extends Error {}

/** The runner's vars a client repo's deploy sets (apps/runner/src/extensions/shipped-list.ts). */
export const PACKS_VAR = "COS_PACKS";
/** The customer sessions' signing secret (ADR 0421): generated once per deployment by cos deploy. */
export const CUSTOMER_SECRET = "CUSTOMER_AUTH_SECRET";
/** The desk origin's own secret (stage 44 step 6, ADR 0649), made once on a custom domain. */
export const DESK_SECRET = "DESK_SECRET";
export const ORG_EXTENSIONS_VAR = "COS_ORG_EXTENSIONS";

export function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

/** Where a product's releases come from, and how they are verified: no Cloudflare needed. */
export interface ReleaseSource {
  /** The product being installed or operated on (`--product`): its names and its repository. */
  product: ProductDefinition;
  github: GitHubOptions;
  repository: string;
  extra: ExtraVerifier | undefined;
  /** Use bundles from this directory (composable-os-<product>-<version>.tar.gz + SHA256SUMS) instead of downloading. */
  bundleDir?: string;
  /** With bundleDir: skip the attestation check (local test builds only). */
  unverified: boolean;
}

export interface Session extends ReleaseSource {
  api: CloudflareClient;
  accountId: string;
}

/** `--product`, or the default product. */
export function productOf(flags: Flags, deps: Deps): ProductDefinition {
  const known = deps.products ?? { all: products, default: DEFAULT_PRODUCT };
  const id = str(flags, "product") ?? known.default;
  const product = known.all[id];
  if (!product) {
    throw new CliError(`Unknown product ${id}. Known: ${Object.keys(known.all).join(", ")}.`);
  }
  return product;
}

export async function session(flags: Flags, deps: Deps): Promise<Session> {
  const { io, env } = deps;
  const product = productOf(flags, deps);
  let token = str(flags, "token") ?? env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    if (!io.interactive || flags.yes)
      throw new CliError("A Cloudflare API token is needed: --token or CLOUDFLARE_API_TOKEN.");
    io.out(
      "Create a token at https://dash.cloudflare.com/profile/api-tokens with the permissions in `--help`.",
    );
    token = await io.ask("Cloudflare API token", { secret: true });
  }
  deps.redactor.add(token);
  const api = new CloudflareClient({
    token,
    ...(env.COS_CLOUDFLARE_API ? { apiBase: env.COS_CLOUDFLARE_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  let accountId = str(flags, "account") ?? env.CLOUDFLARE_ACCOUNT_ID;
  await api.verifyToken(accountId);
  if (!accountId) {
    const accounts = await api.listAccounts();
    if (accounts.length === 0) throw new CliError("The token cannot see any account.");
    if (accounts.length > 1 && (flags.yes || !io.interactive)) {
      throw new CliError("The token sees several accounts; pass --account <id>.");
    }
    const label = await choose(
      io,
      "Which account?",
      accounts.map((a) => `${a.name} (${a.id})`),
    );
    accountId = accounts.find((a) => label.endsWith(`(${a.id})`))?.id as string;
  }
  const source = releaseSource(flags, deps, product);
  return { ...source, api, accountId };
}

/**
 * A GitHub token from the environment (GITHUB_TOKEN, else GH_TOKEN), only to raise GitHub's rate
 * limit. Given to the redactor first, so nothing cos prints can show it.
 */
function githubToken(deps: Deps): string | undefined {
  const token = deps.env.GITHUB_TOKEN || deps.env.GH_TOKEN || undefined;
  if (token) deps.redactor.add(token);
  return token;
}

/** Where `product`'s releases come from (`--repo`, `--bundle-dir`, gh), without Cloudflare. */
export function releaseSource(flags: Flags, deps: Deps, product: ProductDefinition): ReleaseSource {
  const { env } = deps;
  const repository = str(flags, "repo") ?? product.updateRepository;
  const github: GitHubOptions = {
    repository,
    product: product.id,
    ...(env.COS_GITHUB_API ? { apiBase: env.COS_GITHUB_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(githubToken(deps) ? { token: githubToken(deps) as string } : {}),
  };
  const bundleDir = str(flags, "bundle-dir");
  if (flags.unverified && !bundleDir)
    throw new CliError("--unverified only applies to --bundle-dir");
  let extra: ExtraVerifier | undefined;
  if (!flags["no-gh"] && deps.ghVerifier) extra = deps.ghVerifier;
  if (flags["require-gh"] && !deps.ghVerifier) {
    throw new CliError("--require-gh: the GitHub CLI (gh) is not installed.");
  }
  return {
    product,
    github,
    repository,
    extra,
    ...(bundleDir ? { bundleDir } : {}),
    unverified: Boolean(flags.unverified),
  };
}

export async function verified(s: ReleaseSource, version: string, deps: Deps) {
  const local = s.bundleDir
    ? join(s.bundleDir, releaseAssetNames(s.product.id, version).bundle)
    : null;
  if (local && existsSync(local)) {
    // A release built locally or in the release workflow before publishing (--bundle-dir).
    deps.io.out(`Verifying the local bundle ${local}…`);
    const bytes = new Uint8Array(readFileSync(local));
    const sums = readFileSync(join(s.bundleDir as string, "SHA256SUMS"), "utf8");
    if (s.unverified) deps.io.err("  WARNING: --unverified: skipping the build attestation check.");
    const { digest } = await verifyBundleBytes({
      bytes,
      product: s.product.id,
      version,
      sums,
      repository: s.repository,
      github: s.github,
      skipProvenance: s.unverified,
      ...(s.extra && !s.unverified ? { extra: s.extra } : {}),
    });
    const bundle = await openBundle(bytes);
    if (bundle.manifest.version !== version) {
      throw new CliError(`${local} holds ${bundle.manifest.version}, not ${version}`);
    }
    if (bundle.manifest.product !== s.product.id) {
      throw new CliError(
        `${local} is a release of ${bundle.manifest.product}, not ${s.product.id}`,
      );
    }
    return { bundle, digest };
  }
  deps.io.out(`Downloading ${s.product.label} ${version} and verifying it…`);
  const release = await fetchVerifiedRelease(version, {
    ...s.github,
    ...(s.extra ? { extra: s.extra } : {}),
  });
  deps.io.out(
    `  sha256 ${release.digest} matches SHA256SUMS and its build attestation (${s.repository}, release workflow, v${version})${s.extra ? "; gh attestation verify passed" : ""}`,
  );
  return release;
}

function parseSecrets(
  flags: Flags,
  redactor: Redactor,
  appWorker: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const entry of flags.secret ?? []) {
    const match = /^(?:([\w-]+):)?([A-Z][A-Z0-9_]*)=(.*)$/s.exec(entry);
    if (!match) throw new CliError(`--secret expects NAME=VALUE or WORKER:NAME=VALUE`);
    const worker = match[1] ?? appWorker;
    out[worker] ??= {};
    (out[worker] as Record<string, string>)[match[2] as string] = match[3] as string;
    redactor.add(match[3]);
  }
  return out;
}

/** `--provider-key PROVIDER=KEY` entries. Keys go to the redactor before anything can print them. */
function parseProviderKeys(flags: Flags, redactor: Redactor): { provider: string; key: string }[] {
  const out: { provider: string; key: string }[] = [];
  for (const entry of (flags["provider-key"] as string[] | undefined) ?? []) {
    const match = /^([a-z0-9][a-z0-9-]*)=(.+)$/is.exec(entry);
    if (match?.[2]) redactor.add(match[2]);
    if (!match) throw new CliError("--provider-key expects PROVIDER=KEY, e.g. deepseek=…");
    out.push({ provider: (match[1] as string).toLowerCase(), key: match[2] as string });
  }
  return out;
}

/**
 * `--model-roles`: the AI_MODEL_ROLES value ("" for the shipped defaults), or undefined when not
 * given. A preset name, `default`, inline JSON, or a path to a JSON file. Checked against the
 * model registry here, so a typo fails the install instead of being ignored at run time.
 */
function modelRolesChoice(flags: Flags): string | undefined {
  const raw = str(flags, "model-roles")?.trim();
  if (raw === undefined) return undefined;
  const isFile = raw !== "default" && !ROLE_PRESETS[raw] && !/^[[{]/.test(raw);
  if (isFile && !existsSync(raw)) {
    throw new CliError(
      `--model-roles: no preset or file "${raw}" (presets: ${Object.keys(ROLE_PRESETS).join(", ")}, or default)`,
    );
  }
  try {
    return modelRolesVar(isFile ? readFileSync(raw, "utf8") : raw);
  } catch (error) {
    if (error instanceof RoleLayerError) throw new CliError(`--model-roles: ${error.message}`);
    throw error;
  }
}

/** The registry provider a gateway provider slug stores a key for (`deepseek` → deepseek). */
function registryProvider(slug: string): string | undefined {
  return Object.values(PROVIDER_INFO).find((p) => p.gatewaySlug === slug && p.needsKey)?.id;
}

/** `--ai` / COS_AI: true, false, or undefined when neither says. */
function aiChoice(flags: Flags, env: Env): boolean | undefined {
  const value = (str(flags, "ai") ?? env.COS_AI)?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new CliError("--ai is on or off");
}

/**
 * `--location`: a location hint for the stores a first install creates (ADR 0580), `none` for no
 * hint, or undefined when not given.
 */
function locationChoice(flags: Flags): LocationHint | "none" | undefined {
  const value = str(flags, "location")?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "none" || isLocationHint(value)) return value;
  throw new CliError(
    `--location is none or a location hint: ${Object.keys(LOCATION_HINTS).join(", ")}`,
  );
}

/** What a hint is, in a line: "oc (Oceania)", or "none". */
export function describeLocation(hint: LocationHint | undefined): string {
  return hint ? `${hint} (${LOCATION_HINTS[hint]})` : "none";
}

function randomSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The fake payment provider's switch and its signing secret (issue #217, ADR 0485). */
const FAKE_PROVIDER_VAR = "PAYMENTS_FAKE_PROVIDER";
const FAKE_SECRET = "FAKE_WEBHOOK_SECRET";

/** Whether a gatekeeper's vars turn on its fake provider: payments' switch, or texts' (ADR 0672). */
function fakeProviderOn(vars: Record<string, string> | undefined): boolean {
  return vars?.[FAKE_PROVIDER_VAR] === "true" || vars?.TEXT_PROVIDER === "fake";
}

/**
 * Gives a gatekeeper that turns a fake provider on (payments', or texts', ADR 0672) its own
 * signing secret: generated once, when none is stored on the Worker and none is supplied (`--secret`), never printed (the
 * redactor hides it) and never written anywhere but the Worker. Later deploys keep the stored one
 * (`keep_bindings`). The default secret is public, so without this the fake runs on localhost
 * only. Which environments may turn the fake on is cos deploy's check (a live one may not).
 * Also drops a plain var of the same name an older deployment state carried: it is a secret now.
 */
export function generateFakePaymentsSecrets(
  manifest: { workers: { name: string; secrets?: { name: string }[] }[] },
  gatekeepers: string[],
  vars: Record<string, Record<string, string>>,
  secrets: Record<string, Record<string, string>>,
  stored: Map<string, string[]>,
  redactor: { add(value: string): void },
): void {
  for (const name of gatekeepers) {
    const worker = manifest.workers.find((w) => w.name === name);
    if (!worker?.secrets?.some((s) => s.name === FAKE_SECRET)) continue;
    if (vars[name] && FAKE_SECRET in vars[name]) {
      const { [FAKE_SECRET]: _plain, ...rest } = vars[name];
      vars[name] = rest;
    }
    if (!fakeProviderOn(vars[name])) continue;
    if (stored.get(name)?.includes(FAKE_SECRET) || secrets[name]?.[FAKE_SECRET]) continue;
    const secret = randomSecret();
    redactor.add(secret);
    secrets[name] = { ...secrets[name], [FAKE_SECRET]: secret };
  }
}

export async function latestVersion(s: ReleaseSource, channel: Channel): Promise<string> {
  const releases = await listReleases(channel, s.github);
  const latest = releases[0];
  if (!latest) throw new CliError(`No ${channel} release is published in ${s.repository} yet.`);
  return latest.version;
}

// ---- install ------------------------------------------------------------------------------------

/**
 * The database a deployment's state is in: the release product's, or a client product's (`cos
 * deploy` passes `--database`, issue #155).
 */
function deploymentDatabase(flags: Flags, s: Session): string {
  return str(flags, "database") ?? s.product.names.database;
}

/**
 * The names a first install deploys with, when they are not the release's (`--names`, a JSON
 * `{ workers, resources }` of release name → deployed name, which `cos deploy` passes for a
 * client product, issue #155). They go into the deployment state's maps (ADR 0193), so the
 * verified release is deployed unchanged, and upgrades keep them. Ignored for a deployment that
 * exists: nothing deployed is renamed.
 */
function firstInstallNames(flags: Flags): {
  workers: Record<string, string>;
  resources: Record<string, string>;
} {
  const text = str(flags, "names");
  if (!text) return { workers: {}, resources: {} };
  const parsed = JSON.parse(text) as {
    workers?: Record<string, string>;
    resources?: Record<string, string>;
  };
  const ok = (map: unknown) =>
    map === undefined ||
    (typeof map === "object" &&
      map !== null &&
      Object.values(map).every((v) => typeof v === "string" && /^[a-z0-9-]+$/.test(v)));
  if (!ok(parsed.workers) || !ok(parsed.resources))
    throw new CliError("--names is { workers, resources } of names");
  return { workers: parsed.workers ?? {}, resources: parsed.resources ?? {} };
}

export async function install(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const existing = await locateDeployment(s.api, s.accountId, deploymentDatabase(flags, s));
  const found = existing?.state ?? null;
  const names = found ? null : firstInstallNames(flags);
  const channelFlag = str(flags, "channel");
  if (channelFlag && !CHANNELS.includes(channelFlag as Channel))
    throw new CliError("--channel is stable or beta");
  const channel = (channelFlag as Channel | undefined) ?? found?.channel ?? "stable";
  const version = str(flags, "version") ?? found?.version ?? (await latestVersion(s, channel));
  if (found && compareVersions(version, found.version) > 0) {
    throw new CliError(
      `${s.product.label} ${found.version} is already installed here. Run \`cos upgrade --version ${version}\` to update it.`,
    );
  }
  if (found)
    io.out(
      `Found an existing install (${found.version}); re-running it to repair anything missing.`,
    );
  // A client's export from a host of many clients, installed here (stage 66 step 7, criterion
  // 13): checked whole before anything is made, and only into a new install.
  const importDir = str(flags, "import");
  if (importDir && found) {
    throw new CliError("--import makes a new install: this account has one already");
  }
  const folder = importDir
    ? (await import("./fleet/clients.ts")).readExportFolder(importDir)
    : null;
  const { bundle, digest } = await verified(s, version, deps);
  const manifest = bundle.manifest;
  const previous = found;
  const app = manifest.workers.find((w) => w.role === "app");
  if (!app) throw new CliError("The release has no app Worker.");

  // Hostname.
  let hostnameMode: DeploymentState["hostnameMode"] = previous?.hostnameMode ?? "workers.dev";
  let hostname = previous?.hostname;
  let zoneId = previous?.zoneId;
  if (!previous) {
    let choice = str(flags, "hostname");
    if (!choice && io.interactive && !flags.yes) {
      choice = await io.ask(
        "Hostname (workers.dev, or e.g. crm.example.com on one of your zones)",
        {
          default: "workers.dev",
        },
      );
    }
    if (!choice || choice === "workers.dev") {
      hostname = await workersDevHostname(
        s.api,
        s.accountId,
        names?.workers[app.name] ?? app.name,
        deploymentDatabase(flags, s),
      );
    } else {
      hostnameMode = "custom";
      hostname = choice.toLowerCase();
      const zones = await s.api.listZones(s.accountId);
      const zoneName = str(flags, "zone");
      const zone = zoneName
        ? zones.find((z) => z.name === zoneName)
        : zones
            .filter((z) => hostname === z.name || hostname?.endsWith(`.${z.name}`))
            .sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) throw new CliError(`No active zone in this account covers ${hostname}.`);
      zoneId = zone.id;
    }
  }
  if (!hostname) throw new CliError("No hostname.");

  // Identity adapter.
  let identity =
    previous?.identityProvider ?? (str(flags, "identity") as DeploymentState["identityProvider"]);
  if (!identity) {
    identity =
      io.interactive && !flags.yes
        ? ((await choose(
            io,
            "Sign-in:",
            ["better-auth", "cloudflare-access"],
            "better-auth",
          )) as DeploymentState["identityProvider"])
        : "better-auth";
  }
  if (identity !== "better-auth" && identity !== "cloudflare-access") {
    throw new CliError("--identity is better-auth or cloudflare-access");
  }

  // Where new stores are made (ADR 0580): a location hint sent when the D1 database and the R2
  // buckets are created, chosen at the first install. An install that exists keeps what it was
  // made with: a database or a bucket cannot be moved by a setting, so nothing is sent to one.
  const locationFlag = locationChoice(flags);
  let locationHint: LocationHint | undefined = previous?.locationHint;
  if (!previous) {
    let choice = locationFlag;
    if (choice === undefined && io.interactive && !flags.yes) {
      choice = (await choose(
        io,
        "Data location hint for the new database and file bucket (a preference Cloudflare follows where it can, not a guarantee; oc is Oceania):",
        ["none", ...Object.keys(LOCATION_HINTS)],
        "none",
      )) as LocationHint | "none";
    }
    locationHint = choice === undefined || choice === "none" ? undefined : choice;
  } else if (
    locationFlag !== undefined &&
    (locationFlag === "none" ? undefined : locationFlag) !== previous.locationHint
  ) {
    io.out(
      `Location: this host exists, made with location hint ${describeLocation(previous.locationHint)}. Its database and file buckets stay where Cloudflare put them: a setting cannot move them (moving one is an export into a new install). --location ${locationFlag} changes nothing here.`,
    );
  }

  // Gatekeepers.
  const optional = manifest.workers.filter((w) => w.optional);
  const requested = (str(flags, "gatekeepers") ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) =>
      g.startsWith(s.product.names.gatekeeperPrefix)
        ? g
        : `${s.product.names.gatekeeperPrefix}${g}`,
    );
  for (const name of requested) {
    if (!optional.some((w) => w.name === name)) throw new CliError(`Unknown gatekeeper ${name}.`);
  }
  const gatekeepers = [...new Set([...(previous?.gatekeepers ?? []), ...requested])].sort();

  // In-app AI (Workers AI + Vectorize): on unless turned off, now or by an earlier install.
  const ai = aiChoice(flags, deps.env) ?? previous?.ai ?? true;
  // AI Gateway: the one chosen now or before; by default one named after the install.
  const gatewayFlag = str(flags, "ai-gateway")?.trim();
  if (
    gatewayFlag !== undefined &&
    gatewayFlag !== "off" &&
    !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(gatewayFlag)
  ) {
    throw new CliError("--ai-gateway is a gateway id (letters, digits, - and _) or off");
  }
  const aiGateway: DeploymentState["aiGateway"] =
    gatewayFlag === "off" ? false : (gatewayFlag ?? previous?.aiGateway);
  const providerKeys = parseProviderKeys(flags, deps.redactor);
  if (providerKeys.length && (!ai || aiGateway === false)) {
    throw new CliError("--provider-key stores keys in AI Gateway: it needs AI and a gateway on");
  }
  const modelRoles = modelRolesChoice(flags);
  if (modelRoles && !ai) throw new CliError("--model-roles needs in-app AI on (--ai on)");

  // Secrets: values only for what this run sets; stored ones are kept.
  const secrets = parseSecrets(flags, deps.redactor, app.name);
  secrets[app.name] ??= {};
  const appSecrets = secrets[app.name] as Record<string, string>;
  if (folder) {
    // The client's own secrets, so its staff and customers stay signed in (never printed).
    const { exportedAppSecrets } = await import("./fleet/install-import.ts");
    const exported = exportedAppSecrets(folder);
    for (const [name, value] of Object.entries(exported.secrets)) {
      deps.redactor.add(value);
      appSecrets[name] ??= value;
    }
    if (exported.leftOut.length) {
      io.out(
        `  not set from the export (not a single-client Worker secret): ${exported.leftOut.join(", ")}`,
      );
    }
  }
  const scripts = new Set((await s.api.listScripts(s.accountId)).map((sc) => sc.id));
  // Secrets are on the Worker as deployed, which a client product names (issue #155): looking
  // under the release's name would find none and make a new staff secret on every deploy.
  const deployedAs = (name: string) => (previous?.workerNames ?? names?.workers)?.[name] ?? name;
  const appSet = scripts.has(deployedAs(app.name))
    ? await s.api.listSecrets(s.accountId, deployedAs(app.name))
    : [];
  if (!appSet.includes("BETTER_AUTH_SECRET") && !appSecrets.BETTER_AUTH_SECRET) {
    appSecrets.BETTER_AUTH_SECRET = randomSecret();
    deps.redactor.add(appSecrets.BETTER_AUTH_SECRET);
  }
  appSecrets.BETTER_AUTH_URL ??= `https://${hostname}`;
  // Signing at the desk (stage 44 step 6, ADR 0649): the desk origin is `desk.` before a custom
  // domain (deploy.ts adds it and sets DESK_HOSTNAME); its codes, device credentials and session
  // tokens are kept under their own secret, made once per deployment, never another's.
  if (hostnameMode === "custom" && !appSet.includes(DESK_SECRET) && !appSecrets[DESK_SECRET]) {
    let secret = randomSecret();
    while (secret === appSecrets.BETTER_AUTH_SECRET) secret = randomSecret();
    appSecrets[DESK_SECRET] = secret;
    deps.redactor.add(secret);
  }
  // Customer sign-in on the company's web app (ADR 0421), set by `cos deploy` for a product with
  // a web app (ADR 0450): CUSTOMER_AUTH_URL is the web app's origin; CUSTOMER_AUTH_SECRET is
  // generated once per deployment, never printed or written anywhere but the Worker, and never
  // changed by a later deploy unless --rotate-customer-auth-secret says so.
  const customerAuthUrl = str(flags, "customer-auth-url");
  if (customerAuthUrl !== undefined) {
    if (!/^https?:\/\/[^/]+$/.test(customerAuthUrl)) {
      throw new CliError("--customer-auth-url is the web app's origin, https://host");
    }
    if (
      flags["rotate-customer-auth-secret"] ||
      (!appSet.includes(CUSTOMER_SECRET) && !appSecrets[CUSTOMER_SECRET])
    ) {
      let secret = randomSecret();
      while (secret === appSecrets.BETTER_AUTH_SECRET) secret = randomSecret();
      appSecrets[CUSTOMER_SECRET] = secret;
      deps.redactor.add(secret);
    }
  }
  const updateToken =
    str(flags, "update-token") ??
    (flags["store-update-token"]
      ? (str(flags, "token") ?? deps.env.CLOUDFLARE_API_TOKEN)
      : undefined);
  if (updateToken) {
    deps.redactor.add(updateToken);
    appSecrets.COS_UPDATE_TOKEN = updateToken;
  }
  const aiAdminToken = str(flags, "ai-admin-token") ?? deps.env.COS_AI_ADMIN_TOKEN;
  if (aiAdminToken) {
    deps.redactor.add(aiAdminToken);
    appSecrets.CLOUDFLARE_API_TOKEN = aiAdminToken;
  }
  if (identity === "cloudflare-access") {
    for (const name of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]) {
      if (appSecrets[name] || appSet.includes(name)) continue;
      if (flags.yes || !io.interactive)
        throw new CliError(`Cloudflare Access needs --secret ${name}=…`);
      appSecrets[name] = await io.ask(
        name === "CF_ACCESS_AUD" ? "Access application AUD tag" : "Access team domain",
      );
    }
  }
  // The secrets already stored on each chosen gatekeeper, as deployed.
  const gatekeeperSet = new Map<string, string[]>();
  for (const name of gatekeepers) {
    const worker = manifest.workers.find((w) => w.name === name);
    const set = scripts.has(deployedAs(name))
      ? await s.api.listSecrets(s.accountId, deployedAs(name))
      : [];
    gatekeeperSet.set(name, set);
    for (const secret of worker?.secrets ?? []) {
      if (!secret.required || set.includes(secret.name) || secrets[name]?.[secret.name]) continue;
      if (flags.yes || !io.interactive) {
        throw new CliError(`${name} needs --secret ${name}:${secret.name}=…`);
      }
      const value = await io.ask(
        `${name} ${secret.name}${secret.description ? ` (${secret.description})` : ""}`,
        {
          secret: true,
        },
      );
      deps.redactor.add(value);
      secrets[name] = { ...secrets[name], [secret.name]: value };
    }
  }

  let vars: DeploymentState["vars"] = { ...(previous?.vars ?? {}) };
  if (identity !== "better-auth")
    vars[app.name] = { ...vars[app.name], IDENTITY_PROVIDER: identity };
  if (modelRoles !== undefined) {
    // Per deployment, in the deployment state: upgrades keep it (ADR 0192).
    vars = withDeploymentVar(vars, manifest, MODEL_ROLES_VAR, modelRoles);
  }
  // A client repo's deploy (stage 24, ADR 0422): the packs its product lists and the org's own
  // extensions pinned by hash. Set as given, "" included (no packs); kept by upgrades.
  for (const [flag, name] of [
    ["packs", PACKS_VAR],
    ["org-extensions", ORG_EXTENSIONS_VAR],
  ] as const) {
    const value = str(flags, flag);
    if (value === undefined) continue;
    for (const worker of varWorkers(manifest, name))
      vars[worker] = { ...vars[worker], [name]: value };
  }
  if (customerAuthUrl !== undefined) {
    vars[app.name] = { ...vars[app.name], CUSTOMER_AUTH_URL: customerAuthUrl };
  }
  // The mobile app staff sign in to through the system browser (ADR 0451, ADR 0455): the
  // redirects a sign-in may be sent back to, set by cos deploy from product.ts.
  const nativeRedirects = str(flags, "native-redirect-uris");
  if (nativeRedirects !== undefined) {
    vars[app.name] = { ...vars[app.name], NATIVE_REDIRECT_URIS: nativeRedirects };
  } else if (vars[app.name]?.NATIVE_REDIRECT_URIS === undefined) {
    // A plain install (the CRM's own installer): the platform's command-line door, `cos content
    // import`'s browser sign-in on this computer (ADR 0457). One set by hand is kept.
    vars[app.name] = { ...vars[app.name], NATIVE_REDIRECT_URIS: "http://127.0.0.1/cos-sign-in" };
  }
  // A client product's gatekeeper settings (ADR 0452): plain vars the gatekeeper declares, by
  // the release's Worker name, checked by cos deploy against the manifest. Kept by upgrades.
  const gatekeeperVars = str(flags, "gatekeeper-vars");
  if (gatekeeperVars !== undefined) {
    const parsed = JSON.parse(gatekeeperVars) as Record<string, Record<string, string>>;
    for (const [worker, values] of Object.entries(parsed)) {
      if (!manifest.workers.some((w) => w.name === worker && w.role === "gatekeeper")) {
        throw new CliError(`--gatekeeper-vars names ${worker}, not a gatekeeper of this release`);
      }
      vars[worker] = { ...vars[worker], ...values };
    }
  }
  generateFakePaymentsSecrets(manifest, gatekeepers, vars, secrets, gatekeeperSet, deps.redactor);
  const sendEmailFlag = str(flags, "send-email");
  const sendEmail: DeploymentState["sendEmail"] = {
    ...(previous?.sendEmail ?? {}),
    ...(sendEmailFlag ? (JSON.parse(sendEmailFlag) as DeploymentState["sendEmail"]) : {}),
  };
  // A client product's label (issue #155): every surface that shows the product's name reads it.
  const label = str(flags, "label");
  if (label !== undefined) {
    for (const worker of varWorkers(manifest, PRODUCT_LABEL_VAR)) {
      vars[worker] = { ...vars[worker], [PRODUCT_LABEL_VAR]: label };
    }
  }
  if (aiGateway === false) {
    // Turned off: clear a gateway an earlier install set.
    for (const [worker, values] of Object.entries(vars)) {
      if (values.AI_GATEWAY_ID === undefined && values.AI_GATEWAY_REST === undefined) continue;
      // Workers AI goes back to the binding, unchanged (ADR 0330).
      const { AI_GATEWAY_ID: _gone, AI_GATEWAY_REST: _rest, ...rest } = values;
      vars[worker] = rest;
    }
  }

  io.out(
    `\nInstalling ${s.product.label} ${version} into account ${s.accountId} at https://${hostname}`,
  );
  if (!ai) io.out("In-app AI is off (--ai off): no Workers AI or Vectorize bindings.");
  if (!previous && locationHint) {
    io.out(
      `Location hint: ${describeLocation(locationHint)}, sent when the D1 database and R2 buckets are created. Cloudflare follows it where it can; it is not a guarantee of where data is kept, and KV, queues, Vectorize and logs take no hint.`,
    );
  }
  io.out("Resources:");
  const resources = {
    ...(previous?.resources ?? {}),
    ...(await provisionResources(
      s.api,
      s.accountId,
      neededResources(manifest, gatekeepers, { ai }),
      (l) => io.out(l),
      previous?.resourceNames ?? names?.resources,
      { locationHint },
    )),
  };
  const base: DeploymentState = {
    version,
    accountId: s.accountId,
    hostname,
    hostnameMode,
    ...(zoneId ? { zoneId } : {}),
    identityProvider: identity,
    channel,
    gatekeepers,
    ai,
    ...(aiGateway !== undefined ? { aiGateway } : {}),
    ...(previous?.aiGatewayCreated ? { aiGatewayCreated: true } : {}),
    ...(previous?.aiGatewayTokenId ? { aiGatewayTokenId: previous.aiGatewayTokenId } : {}),
    ...(previous?.aiGatewayTokenWorkersAi ? { aiGatewayTokenWorkersAi: true } : {}),
    workerNames: previous?.workerNames ?? names?.workers ?? {},
    ...(previous?.resourceNames
      ? { resourceNames: previous.resourceNames }
      : names && Object.keys(names.resources).length
        ? { resourceNames: names.resources }
        : {}),
    vars,
    ...(sendEmail && Object.keys(sendEmail).length ? { sendEmail } : {}),
    ...(locationHint ? { locationHint } : {}),
    resources,
    bundleDigest: digest,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (ai && aiGateway !== false) io.out("AI Gateway:");
  const suppliedToken = Object.values(secrets).find((v) => v[GATEWAY_TOKEN_SECRET])?.[
    GATEWAY_TOKEN_SECRET
  ];
  const gateway = await provisionAiGateway({
    api: s.api,
    manifest,
    state: base,
    ...(suppliedToken ? { token: suppliedToken } : {}),
    log: (l) => io.out(l),
  });
  for (const values of Object.values(gateway.secrets)) {
    for (const value of Object.values(values)) deps.redactor.add(value);
  }
  Object.assign(secrets, mergeSecrets(secrets, gateway.secrets));
  const state: DeploymentState = { ...base, vars: gateway.vars, ...gateway.state };
  if (providerKeys.length) {
    if (!gateway.gatewayId) {
      throw new CliError("--provider-key: no AI Gateway could be set up (see the warning above).");
    }
    for (const { provider, key } of providerKeys) {
      const slug = gatewayProviderSlug(manifest, provider);
      await s.api.setGatewayProviderKey(s.accountId, gateway.gatewayId, slug, key);
      io.out(`  provider key ${slug}: stored in AI Gateway ${gateway.gatewayId} (BYOK)`);
      // Tell the model registry the gateway holds this provider's key (AI_GATEWAY_BYOK).
      const registry = registryProvider(slug);
      if (registry) state.vars = withByokProvider(state.vars, manifest, registry);
      // TypeSafe's key is the judge's, not a model role's (ADR 0230): JUDGE_BYOK turns it on.
      if (slug === JUDGE_GATEWAY_PROVIDER) {
        state.vars = withDeploymentVar(state.vars, manifest, JUDGE_BYOK_VAR, "true");
      }
    }
  }
  if (modelRoles !== undefined) {
    const name = str(flags, "model-roles")?.trim() ?? "";
    const what = !modelRoles ? "the shipped defaults" : ROLE_PRESETS[name] ? name : "custom JSON";
    const on = varWorkers(manifest, MODEL_ROLES_VAR).join(" and ");
    io.out(`Model roles (${MODEL_ROLES_VAR} on ${on}): ${what}`);
  }
  const databaseId = databaseIdOf(manifest, resources);
  if (folder) {
    const imports = await import("./fleet/install-import.ts");
    io.out(`Importing ${folder.manifest.client}'s export:`);
    await imports.importIntoD1({
      api: s.api,
      accountId: s.accountId,
      databaseId,
      bundle,
      folder,
      log: (l) => io.out(l),
    });
    await imports.importFiles({
      api: s.api,
      accountId: s.accountId,
      bucket: imports.filesBucketOf(manifest, resources),
      folder,
      log: (l) => io.out(l),
    });
  }
  io.out("Core migrations:");
  const applied = await applyBundleMigrations(
    bundle,
    d1ApiMigrations(s.api, s.accountId, databaseId),
    (l) => io.out(l),
  );
  if (!applied.length) io.out("  up to date");
  await writeDeploymentState(s.api, databaseId, state);
  io.out("Workers:");
  for (const [worker, values] of Object.entries(secrets)) {
    if (Object.keys(values).length)
      io.out(`  setting secrets on ${worker}: ${Object.keys(values).sort().join(", ")}`);
  }
  const result = await deployWorkers({ api: s.api, bundle, state, secrets, log: (l) => io.out(l) });
  // A gateway token this run replaced (ADR 0330) is deleted only now that the new one is deployed.
  await retireGatewayToken(s.api, s.accountId, gateway.retiredTokenId, (l) => io.out(l));
  if (flags.wait) {
    io.out("Waiting for /api/health…");
    await healthSmoke(hostname, version, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.env.COS_HEALTH_ORIGIN ? { origin: deps.env.COS_HEALTH_ORIGIN } : {}),
      ...(deps.smokeDelayMs !== undefined ? { delayMs: deps.smokeDelayMs } : {}),
    });
  }
  io.out(`\nDone. ${s.product.label} ${version} is at ${result.url}`);
  io.out(`Open ${result.url}/setup to create the first admin and finish setting up.`);
  if (!updateToken) {
    io.out(
      "Updates: run `npx @composable-os/cli upgrade` (or store a token with --update-token for Settings → Updates).",
    );
  }
  return 0;
}

// ---- upgrade ------------------------------------------------------------------------------------

async function locate(s: Session, flags: Flags = {}) {
  const located = await locateDeployment(s.api, s.accountId, deploymentDatabase(flags, s));
  if (!located?.state) {
    throw new CliError(
      `No ${s.product.label} installed from a release was found in this account. Run \`npx @composable-os/cli install\` first.`,
    );
  }
  return { databaseId: located.databaseId, state: located.state };
}

function printPreflight(io: Io, result: PreflightResult) {
  io.out(`Preflight ${result.from ?? "?"} → ${result.to}: ${result.ok ? "OK" : "BLOCKED"}`);
  io.out(`  migrations: ${result.migrations.length ? result.migrations.join(", ") : "none"}`);
  const gk = result.gatekeepers;
  if (gk.added.length || gk.changed.length || gk.removed.length) {
    io.out(
      `  gatekeepers: +${gk.added.join(",") || "-"} ~${gk.changed.join(",") || "-"} -${gk.removed.join(",") || "-"}`,
    );
  }
  for (const secret of result.secrets) {
    io.out(
      `  secret ${secret.worker} ${secret.name}${secret.required ? " (required)" : ""}: ${secret.set === null ? "?" : secret.set ? "set" : "not set"}`,
    );
  }
  for (const extension of result.extensions) {
    io.out(
      `  extension ${extension.id}: contract ${extension.contractVersion} ${extension.compatible ? "ok" : "INCOMPATIBLE"}`,
    );
  }
  for (const w of result.warnings) io.out(`  note: ${w.message}`);
  for (const b of result.blockers) io.err(`  blocked: ${b.message}`);
}

async function currentManifest(s: Session, version: string) {
  try {
    return await fetchReleaseManifest(await getRelease(version, s.github), s.github);
  } catch {
    return null;
  }
}

export async function upgrade(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { databaseId, state: found } = await locate(s, flags);
  const locationFlag = locationChoice(flags);
  if (locationFlag !== undefined) {
    io.out(
      `Location: an upgrade never changes where data is stored. This host was made with location hint ${describeLocation(found.locationHint)}; its database and file buckets stay where they are (moving one is an export into a new install). --location changes nothing.`,
    );
  }
  const channel = found.channel;
  const target = str(flags, "version") ?? (await latestVersion(s, channel));
  if (compareVersions(target, found.version) <= 0) {
    io.out(
      `${s.product.label} ${found.version} is installed; nothing newer on the ${channel} channel.`,
    );
    return 0;
  }
  const release = await verified(s, target, deps);
  const state = found;
  const secretsSet: Record<string, string[]> = {};
  const scripts = new Set((await s.api.listScripts(s.accountId)).map((x) => x.id));
  for (const worker of release.bundle.manifest.workers) {
    const deployed = state.workerNames[worker.name] ?? worker.name;
    if (scripts.has(deployed))
      secretsSet[worker.name] = await s.api.listSecrets(s.accountId, deployed);
  }
  const result = preflight({
    currentVersion: state.version,
    current: await currentManifest(s, state.version),
    target: release.bundle.manifest,
    appliedMigrations: await appliedMigrationsViaApi(s.api, s.accountId, databaseId),
    extensions: await installedExtensionsViaApi(s.api, s.accountId, databaseId),
    installedGatekeepers: state.gatekeepers,
    secretsSet,
  });
  printPreflight(io, result);
  if (!result.ok) return 1;
  if (!flags.yes && io.interactive) {
    const answer = await io.ask(`Update ${state.version} → ${target}? (yes/no)`, { default: "no" });
    if (answer.toLowerCase() !== "yes") return 1;
  }
  const run: RunRecord = {
    id: newRunId(),
    kind: "update",
    from_version: state.version,
    to_version: target,
    status: "running",
    step: null,
    bookmark: null,
    bundle_digest: release.digest,
    preflight: JSON.stringify(result),
    error: null,
    started_by: null,
    surface: "cli",
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  await saveRunViaApi(s.api, s.accountId, databaseId, run);
  let previousBundle: ReleaseBundle | null = null;
  const outcome = await runUpdate({
    api: s.api,
    state,
    databaseId,
    target: release.bundle,
    targetDigest: release.digest,
    previous: async () => {
      previousBundle ??= (await verified(s, state.version, deps)).bundle;
      return previousBundle;
    },
    migrations: d1ApiMigrations(s.api, s.accountId, databaseId),
    // Stage 5's kill switch, reversibly: on before migrating, off after the smoke check or rollback.
    automations: killSwitchControl(apiKillSwitchStore(s.api, s.accountId, databaseId)),
    smoke: (hostname, version) =>
      healthSmoke(hostname, version, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.env.COS_HEALTH_ORIGIN ? { origin: deps.env.COS_HEALTH_ORIGIN } : {}),
        ...(deps.smokeDelayMs !== undefined ? { delayMs: deps.smokeDelayMs } : {}),
      }),
    onStep: async (step, o) => {
      run.step = step;
      run.bookmark = o?.bookmark ?? run.bookmark;
      if (step === "done") {
        run.status = o?.status ?? "failed";
        run.error = o?.rollbackError
          ? `${o.error}; rollback failed: ${o.rollbackError}`
          : (o?.error ?? null);
        run.finished_at = new Date().toISOString();
      }
      if (step === "pause" || step === "bookmark" || step === "restored" || step === "done") {
        await saveRunViaApi(s.api, s.accountId, databaseId, run);
      }
    },
    log: (l) => io.out(l),
  });
  if (outcome.status === "succeeded") {
    io.out(
      `\nUpdated to ${s.product.label} ${target}. Migrations applied: ${outcome.migrations.join(", ") || "none"}.`,
    );
    return 0;
  }
  io.err(`\nUpdate failed: ${outcome.error}`);
  io.err(
    outcome.status === "rolled_back"
      ? `Rolled back to ${state.version} and restored the database to bookmark ${outcome.bookmark}.`
      : `Rollback did not complete (${outcome.rollbackError ?? "no bookmark"}). Run \`cos rollback\`, or see docs/deploying.md.`,
  );
  return 1;
}

// ---- rollback -----------------------------------------------------------------------------------

async function rollback(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { databaseId, state } = await locate(s, flags);
  const runs = await runsViaApi(s.api, s.accountId, databaseId, 20);
  const last = rollbackTarget(runs);
  if (!last?.from_version) {
    io.err("There is no completed update to roll back.");
    return 1;
  }
  if (!flags.yes && io.interactive) {
    const answer = await io.ask(
      `Roll back ${state.version} → ${last.from_version} and restore the database to before the update (changes since then are lost)? (yes/no)`,
      { default: "no" },
    );
    if (answer.toLowerCase() !== "yes") return 1;
  }
  const previous = await verified(s, last.from_version, deps);
  const record: RunRecord = {
    id: newRunId(),
    kind: "rollback",
    from_version: state.version,
    to_version: last.from_version,
    status: "running",
    step: null,
    bookmark: last.bookmark,
    bundle_digest: previous.digest,
    preflight: null,
    error: null,
    started_by: null,
    surface: "cli",
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  await runRollback({
    api: s.api,
    state,
    databaseId,
    previous: previous.bundle,
    previousDigest: previous.digest,
    bookmark: last.bookmark,
    automations: killSwitchControl(apiKillSwitchStore(s.api, s.accountId, databaseId)),
    log: (l) => io.out(l),
  });
  // The restore rewound core_update_runs too: record both runs again.
  await saveRunViaApi(s.api, s.accountId, databaseId, { ...last, status: "rolled_back" });
  await saveRunViaApi(s.api, s.accountId, databaseId, {
    ...record,
    status: "succeeded",
    finished_at: new Date().toISOString(),
  });
  io.out(`Rolled back to ${s.product.label} ${last.from_version}.`);
  return 0;
}

// ---- status -------------------------------------------------------------------------------------

async function status(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { state, databaseId } = await locate(s, flags);
  const releases = await listReleases(state.channel, s.github).catch(() => []);
  const newer = releases.filter((r) => compareVersions(r.version, state.version) > 0);
  const runs = await runsViaApi(s.api, s.accountId, databaseId, 5);
  if (flags.json) {
    io.out(
      JSON.stringify(
        { state: { ...state, resources: undefined }, available: newer.map((r) => r.version), runs },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    `${s.product.label} ${state.version} (${state.channel} channel) at https://${state.hostname}`,
  );
  io.out(
    `  sign-in: ${state.identityProvider}; gatekeepers: ${state.gatekeepers.join(", ") || "none"}; AI: ${state.ai === false ? "off" : "on"}`,
  );
  io.out(
    `  location hint at install: ${describeLocation(state.locationHint)} (a preference, not a guarantee)`,
  );
  io.out(
    newer.length
      ? `  available: ${newer.map((r) => r.version).join(", ")} (run \`cos upgrade\`)`
      : "  up to date",
  );
  for (const run of runs) {
    io.out(
      `  ${run.started_at} ${run.kind} ${run.from_version ?? "?"} → ${run.to_version}: ${run.status} (${run.surface})`,
    );
  }
  return 0;
}

// ---- uninstall ----------------------------------------------------------------------------------

async function uninstall(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { state } = await locate(s, flags);
  if (!flags.yes) {
    if (!io.interactive) throw new CliError("uninstall deletes everything; pass --yes");
    const answer = await io.ask(
      `This deletes the Workers, the database and every record of https://${state.hostname}. Type the hostname to confirm`,
    );
    if (answer !== state.hostname) return 1;
  }
  const names = [
    ...new Set(
      [s.product.names.app, ...state.gatekeepers, s.product.names.runner].map(
        (n) => state.workerNames[n] ?? n,
      ),
    ),
  ];
  const failures: string[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      io.out(`  deleted ${label}`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
    }
  };
  for (const name of names)
    await attempt(`Worker ${name}`, () => s.api.deleteScript(s.accountId, name));
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(state.resources)) {
    const kind = key.slice(0, key.indexOf("("));
    if (seen.has(`${kind}:${value}`)) continue;
    seen.add(`${kind}:${value}`);
    if (kind === "D1_ID") await attempt(`D1 ${key}`, () => s.api.deleteD1(s.accountId, value));
    if (kind === "KV_ID") await attempt(`KV ${key}`, () => s.api.deleteKv(s.accountId, value));
    if (kind === "R2_NAME") await attempt(`R2 ${value}`, () => s.api.deleteR2(s.accountId, value));
    if (kind === "VECTORIZE_NAME") {
      await attempt(`Vectorize ${value}`, () => s.api.deleteVectorize(s.accountId, value));
    }
    if (kind === "QUEUE_NAME") {
      const queue = (await s.api.listQueues(s.accountId)).find((q) => q.queue_name === value);
      if (queue)
        await attempt(`Queue ${value}`, () => s.api.deleteQueue(s.accountId, queue.queue_id));
    }
  }
  if (typeof state.aiGateway === "string" && state.aiGatewayCreated) {
    const gatewayId = state.aiGateway;
    await attempt(`AI Gateway ${gatewayId}`, () => s.api.deleteAiGateway(s.accountId, gatewayId));
  }
  if (state.aiGatewayTokenId) {
    const tokenId = state.aiGatewayTokenId;
    await attempt("the AI Gateway token", () => s.api.deleteAccountToken(s.accountId, tokenId));
  }
  for (const failure of failures) io.err(`  could not delete ${failure}`);
  return failures.length ? 1 : 0;
}

/**
 * `cos ext check|test <dir>` (ADR 0405). Its code is loaded only when asked for: it needs the
 * TypeScript compiler and esbuild, which a Composable OS checkout has and `npx
 * create-composable-os` does not install.
 */
async function ext(argv: string[], deps: Deps): Promise<number> {
  let runExt: typeof import("@composable-os/extension-check/cli").runExt;
  try {
    ({ runExt } = await import("@composable-os/extension-check/cli"));
    return await runExt(argv, deps.io);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      deps.io.err(
        "cos ext runs in a checkout of the Composable OS repository, after pnpm install: " +
          "pnpm cos ext check <dir>",
      );
      return 2;
    }
    throw error;
  }
}

/**
 * `cos client generate` (ADR 0418): a product's typed client. Loaded only when asked for, like
 * `cos ext`: it reads extension source with esbuild, which a checkout has.
 */
async function client(argv: string[], deps: Deps): Promise<number> {
  // In a client repo (stage 24): each app's client, from the release product.ts names.
  if (argv[0] === "generate" && !argv.includes("--out")) {
    const repo = await import("./client-repo.ts");
    const parsed = parseArgs(["client", ...argv.slice(1)]);
    const dir = str(parsed.flags, "dir") ?? process.cwd();
    if (repo.isClientRepo(dir)) {
      try {
        return await repo.regenerate(parsed.flags, deps);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        deps.io.err(error.message);
        return 1;
      }
    }
  }
  try {
    const { runClient } = await import("@composable-os/client-gen/cli");
    return await runClient(argv, deps.io);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      deps.io.err(
        "cos client runs in a checkout of the Composable OS repository, after pnpm install: " +
          "pnpm cos client generate --out <dir>",
      );
      return 2;
    }
    throw error;
  }
}

/** `cos content import <folder>` (ADR 0470): the import door, as the person running it. */
async function content(argv: string[], deps: Deps): Promise<number> {
  if (argv[0] !== "import") {
    deps.io.err(
      "Usage: cos content import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes]",
    );
    return 2;
  }
  const rest = argv.slice(1);
  const positional = rest[0] && !rest[0].startsWith("-") ? [rest[0]] : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(["import", ...rest.slice(positional.length)]);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  const { contentImport } = await import("./content-import/run.ts");
  try {
    return await contentImport(
      positional,
      {
        ...(str(parsed.flags, "host") ? { host: str(parsed.flags, "host") } : {}),
        ...(str(parsed.flags, "email") ? { email: str(parsed.flags, "email") } : {}),
        dryRun: Boolean(parsed.flags["dry-run"]),
        publish: Boolean(parsed.flags.publish),
        yes: Boolean(parsed.flags.yes),
      },
      deps.io,
    );
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/** `cos courses import <folder>` (stage 42, ADR 0495): the import door for a course platform. */
async function courses(argv: string[], deps: Deps): Promise<number> {
  const usage =
    "Usage: cos courses import <folder> --host <url> [--email <you>] [--dry-run] [--publish] [--yes] [--wait <minutes>]";
  if (argv[0] !== "import") {
    deps.io.err(usage);
    return 2;
  }
  const rest = argv.slice(1);
  const positional = rest[0] && !rest[0].startsWith("-") ? [rest[0]] : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(["import", ...rest.slice(positional.length)]);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  const wait = str(parsed.flags, "wait");
  if (wait !== undefined && !/^\d{1,4}$/.test(wait)) {
    deps.io.err("--wait is minutes, a whole number");
    return 2;
  }
  const { coursesImport } = await import("./courses-import/run.ts");
  try {
    return await coursesImport(
      positional,
      {
        ...(str(parsed.flags, "host") ? { host: str(parsed.flags, "host") } : {}),
        ...(str(parsed.flags, "email") ? { email: str(parsed.flags, "email") } : {}),
        dryRun: Boolean(parsed.flags["dry-run"]),
        publish: Boolean(parsed.flags.publish),
        yes: Boolean(parsed.flags.yes),
        ...(wait !== undefined ? { wait: Number(wait) } : {}),
      },
      deps.io,
    );
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/** `cos programs import <folder>` (stage 41): exercises, class types, programs, past training. */
async function programsCommand(argv: string[], deps: Deps): Promise<number> {
  const { PROGRAMS_USAGE, programsImport } = await import("./programs-import/run.ts");
  if (argv[0] !== "import") {
    deps.io.err(PROGRAMS_USAGE);
    return 2;
  }
  const rest = argv.slice(1);
  const positional = rest[0] && !rest[0].startsWith("-") ? [rest[0]] : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(["import", ...rest.slice(positional.length)]);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  try {
    return await programsImport(
      positional,
      {
        ...(str(parsed.flags, "host") ? { host: str(parsed.flags, "host") } : {}),
        ...(str(parsed.flags, "email") ? { email: str(parsed.flags, "email") } : {}),
        dryRun: Boolean(parsed.flags["dry-run"]),
      },
      deps.io,
    );
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * `cos rostering import <roster.csv>` (stage 45 step 7): duties and who works them, as weekly
 * patterns and one-off shifts, checked by the host's own dry run; a dry run unless --apply.
 */
async function rostering(argv: string[], deps: Deps): Promise<number> {
  const { ROSTER_USAGE, rosteringImport } = await import("./rostering-import/run.ts");
  if (argv[0] !== "import") {
    deps.io.err(ROSTER_USAGE);
    return 2;
  }
  const rest = argv.slice(1);
  const positional = rest[0] && !rest[0].startsWith("-") ? [rest[0]] : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(["import", ...rest.slice(positional.length)]);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  try {
    return await rosteringImport(
      positional,
      {
        ...(str(parsed.flags, "host") ? { host: str(parsed.flags, "host") } : {}),
        ...(str(parsed.flags, "email") ? { email: str(parsed.flags, "email") } : {}),
        apply: Boolean(parsed.flags.apply),
      },
      deps.io,
    );
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * `cos subscriptions offers import <offers.csv>` and `cos subscriptions offers report` (stage 32a,
 * ADRs 0491 and 0492): continuation offers for subscribers moving from another platform.
 */
async function subscriptions(argv: string[], deps: Deps): Promise<number> {
  const { OFFERS_USAGE, offersImport, offersReport } = await import("./offers-import/run.ts");
  if (argv[0] !== "offers" || (argv[1] !== "import" && argv[1] !== "report")) {
    deps.io.err(OFFERS_USAGE);
    return 2;
  }
  const rest = argv.slice(2);
  const positional = argv[1] === "import" && rest[0] && !rest[0].startsWith("-") ? [rest[0]] : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs([argv[1] as string, ...rest.slice(positional.length)]);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  const flag = (name: string) => {
    const value = str(parsed.flags, name);
    return value !== undefined ? { [name]: value } : {};
  };
  try {
    if (argv[1] === "report") {
      return await offersReport(
        { ...flag("host"), ...flag("email"), ...flag("status"), ...flag("out") },
        deps.io,
      );
    }
    return await offersImport(
      positional,
      {
        ...flag("host"),
        ...flag("email"),
        ...flag("plan"),
        dryRun: Boolean(parsed.flags["dry-run"]),
        invite: Boolean(parsed.flags.invite),
        reissue: Boolean(parsed.flags.reissue),
      },
      deps.io,
    );
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

export async function runCli(argv: string[], input: Deps): Promise<number> {
  const deps = input;
  if (argv[0] === "content") return content(argv.slice(1), deps);
  if (argv[0] === "courses") return courses(argv.slice(1), deps);
  if (argv[0] === "subscriptions") return subscriptions(argv.slice(1), deps);
  if (argv[0] === "rostering") return rostering(argv.slice(1), deps);
  if (argv[0] === "programs") return programsCommand(argv.slice(1), deps);
  if (argv[0] === "ext") return ext(argv.slice(1), deps);
  if (argv[0] === "fleet")
    return (await import("./fleet/run.ts")).runFleetCommand(argv.slice(1), deps);
  if (argv[0] === "client") {
    const fleet = await import("./fleet/run.ts");
    if ((fleet.CLIENT_COMMANDS as readonly string[]).includes(argv[1] ?? "")) {
      return fleet.runClientCommand(argv.slice(1), deps);
    }
    return client(argv.slice(1), deps);
  }
  if (argv[0] === "app") return (await import("./app.ts")).runApp(argv.slice(1), deps);
  // Commands that take one argument before their flags (stage 24).
  const positional =
    ["create", "add", "diff"].includes(argv[0] ?? "") && argv[1] && !argv[1].startsWith("-")
      ? [argv[1]]
      : [];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(positional.length ? [argv[0] as string, ...argv.slice(2)] : argv);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  if (parsed.flags.help || !argv.length) {
    deps.io.out(HELP);
    return argv.length ? 0 : 2;
  }
  const repo = await import("./client-repo.ts");
  const blocks = await import("./blocks.ts");
  const commands: Record<string, (flags: Flags, deps: Deps) => Promise<number>> = {
    install,
    // In a client repo (its product.ts is a client product), `cos upgrade` moves the repo to a
    // newer platform version; anywhere else it updates an installed deployment, as before.
    upgrade: (flags, d) =>
      repo.isClientRepo(str(flags, "dir") ?? process.cwd())
        ? repo.upgradeRepo(flags, d)
        : upgrade(flags, d),
    rollback,
    status,
    uninstall,
    create: (flags, d) => repo.create(positional, flags, d),
    init: repo.init,
    deploy: repo.deploy,
    add: (flags, d) => blocks.add(positional, flags, d),
    diff: (flags, d) => blocks.diff(positional, flags, d),
  };
  const command = commands[parsed.command];
  if (!command) {
    deps.io.err(`Unknown command ${parsed.command}.\n\n${HELP}`);
    return 2;
  }
  try {
    return await command(parsed.flags, deps);
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}
