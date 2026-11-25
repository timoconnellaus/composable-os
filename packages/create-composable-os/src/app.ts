// `cos app` in a client repo (stage 63, ADRs 0900, 0901 and 0905): the mobile app on its way to the
// phone app stores, from the client's own store accounts.
//
//   cos app check          everything a store build needs, before any build: ids, icon, listing,
//                          nothing bought in the app, account deletion, no key file in the repo
//   cos app credentials    the CI secrets the workflow needs and the command that sets each; never
//                          a value (--check: fail on any one missing, for one job)
//   cos app build-info     the next build number and the API version of the app's generated client
//   cos app record         writes the builds a run uploaded into the host's core_app_build
//   cos app upload         the Android build (and its listing) to the store's internal testing track
//                          (app-upload.ts)
//
// Nothing here releases to the public: a person does that in each store's console, after the
// client's yes (decision 4). Keys are never read from or written to the repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type AppBuild,
  appBuild,
  type ClientProductDefinition,
  clientNames,
  contrastRatio,
  environmentNames,
  LIVE_ENVIRONMENT,
} from "@composable-os/product";
import { DEFAULT_PRODUCT, products } from "@composable-os/products";
import {
  APP_PLATFORMS,
  type AppBuildRecord,
  AppBuildRefused,
  type AppPlatform,
  appBuildsViaApi,
  CloudflareClient,
  locateDeployment,
  nextBuildNumber,
  recordAppBuildViaApi,
  recordedIdProblem,
} from "@composable-os/release";
import { loadClientProduct } from "./client-repo.ts";
import { CliError, type Deps, type Flags, parseArgs, str } from "./main.ts";
import { scanPurchases } from "./purchase-rules.ts";

export const APP_USAGE = `Usage:
  cos app check [--dir <repo>]
  cos app credentials [--check --for ios|android|record]
  cos app build-info [--env <name>] [--json]
  cos app record [--env <name>] --platform ios,android --build <n> [--commit <sha>]
  cos app upload --platform android [--env <name>] --file <app.aab> [--listing] [--draft]`;

// ---- The brand ----------------------------------------------------------------------------------

/** The platform's default look (blocks/brand.ts), for an app whose product.ts has no mobile.app. */
const DEFAULT_BRAND = {
  primary: "#18181b",
  onPrimary: "#fafafa",
  background: "#ffffff",
  text: "#18181b",
};

/** Where the app's brand lives: beside its copied blocks, where native-base/theme.ts reads it. */
export function brandPath(product: ClientProductDefinition): string | null {
  return product.mobile ? join(product.mobile.dir, "src", "blocks", "brand.ts") : null;
}

/** The text on the primary colour: white or near-black, whichever reads better on it. */
function onPrimary(primary: string): string {
  return contrastRatio("#ffffff", primary) >= contrastRatio("#18181b", primary)
    ? "#ffffff"
    : "#18181b";
}

/** `brand.ts` as cos writes it from product.ts's `mobile.app.colours` (stage 63, ADR 0900). */
export function brandText(product: ClientProductDefinition): string {
  const colours = product.mobile?.app?.colours;
  const brand = colours ? { ...colours, onPrimary: onPrimary(colours.primary) } : DEFAULT_BRAND;
  return `// Written by cos from product.ts (mobile.app.colours): do not edit. Change product.ts and run
// \`pnpm cos client generate\`. The native base theme reads it (native-base/theme.ts).
export const brand = {
  primary: ${JSON.stringify(brand.primary)},
  onPrimary: ${JSON.stringify(brand.onPrimary)},
  background: ${JSON.stringify(brand.background)},
  text: ${JSON.stringify(brand.text)},
} as const;
`;
}

/** Writes the app's brand.ts; returns its path, or null when the product has no mobile app. */
export function writeBrand(root: string, product: ClientProductDefinition): string | null {
  const path = brandPath(product);
  if (!path) return null;
  const text = brandText(product);
  const file = join(root, path);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return path;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return path;
}

// ---- What cos app check reads -------------------------------------------------------------------

/** The store listing's files, per locale, and the stores' limits (the lower of the two). */
export const LISTING_FILES = [
  { file: "name.txt", max: 30, what: "the name in the store" },
  {
    file: "subtitle.txt",
    max: 30,
    what: "the subtitle (the Android store's short description too)",
  },
  { file: "description.txt", max: 4000, what: "the description" },
  { file: "keywords.txt", max: 100, what: "the keywords, comma separated (iPhone store)" },
  { file: "release-notes.txt", max: 500, what: "what is new in this version" },
  { file: "support-url.txt", url: true, what: "the support page's address" },
  { file: "privacy-url.txt", url: true, what: "the privacy policy's address" },
] as const;

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The listing's locales: the folders under it named like `en-AU`. */
export function listingLocales(root: string, listing: string): string[] {
  const dir = join(root, listing);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LOCALE.test(name) && statSync(join(dir, name)).isDirectory())
    .sort();
}

/** One listing file's text, trimmed, or null when absent. */
export function listingText(root: string, listing: string, locale: string, file: string) {
  const path = join(root, listing, locale, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function listingProblems(root: string, listing: string): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const locales = listingLocales(root, listing);
  if (!locales.length) {
    problems.push(
      `${listing} has no locale folder (${listing}/en-AU/ with ${LISTING_FILES.map((f) => f.file).join(", ")})`,
    );
    return { problems, notes };
  }
  for (const locale of locales) {
    for (const field of LISTING_FILES) {
      const where = `${listing}/${locale}/${field.file}`;
      const text = listingText(root, listing, locale, field.file);
      if (!text) {
        problems.push(`${where} is missing or empty: ${field.what}`);
        continue;
      }
      if ("url" in field) {
        if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(text))
          problems.push(`${where} is not an https:// address`);
        continue;
      }
      const length = [...text].length;
      if (length > field.max) {
        problems.push(`${where} is ${length} characters: the stores take at most ${field.max}`);
      }
    }
    const shots = join(root, listing, locale, "screenshots");
    if (!existsSync(shots) || !readdirSync(shots).some((f) => /\.(png|jpe?g)$/i.test(f))) {
      notes.push(
        `${listing}/${locale}/screenshots/ has none: the testing tracks take a build without them, a store review does not`,
      );
    }
  }
  return { problems, notes };
}

/** A PNG's size and whether it can hold transparency, or null when it is not a PNG. */
export function pngInfo(
  bytes: Uint8Array,
): { width: number; height: number; alpha: boolean } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colourType = bytes[25];
  // Colour types 4 and 6 carry an alpha channel; a tRNS chunk makes a colour transparent.
  let alpha = colourType === 4 || colourType === 6;
  for (let at = 8; at + 8 <= bytes.length && !alpha; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "tRNS") alpha = true;
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  return { width, height, alpha };
}

function imageProblem(
  root: string,
  path: string,
  what: string,
  rule: { size?: number; opaque?: boolean },
): string | null {
  const file = join(root, path);
  if (!existsSync(file)) return `${what} ${path} is not in the repo`;
  const info = pngInfo(new Uint8Array(readFileSync(file)));
  if (!info) return `${what} ${path} is not a PNG`;
  if (rule.size && (info.width !== rule.size || info.height !== rule.size)) {
    return `${what} ${path} is ${info.width} by ${info.height}: it must be ${rule.size} by ${rule.size}`;
  }
  if (rule.opaque && info.alpha) {
    return `${what} ${path} can be transparent (an alpha channel): the iPhone store refuses an icon that is not opaque`;
  }
  return null;
}

/** Never in the repo: build output, dependencies, native projects the build makes. */
const SKIP = new Set(["node_modules", ".git", "dist", ".expo", ".wrangler", ".turbo", "build"]);

function walk(dir: string, base: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, base, out);
    else if (entry.isFile()) out.push(relative(base, path).split("\\").join("/"));
  }
}

/** The repo's files: what git tracks or would add, else every file outside build output. */
function repoFiles(root: string): string[] {
  try {
    const listed = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return listed
      .split("\0")
      .filter(Boolean)
      .filter((f) => existsSync(join(root, f)) && !f.split("/").some((p) => SKIP.has(p)));
  } catch {
    const out: string[] = [];
    walk(root, root, out);
    return out;
  }
}

/** A signing key, a store key or a keystore by its name. */
const KEY_FILE =
  /(^|\/)AuthKey_[A-Za-z0-9]+\.p8$|\.(p8|p12|pfx|jks|keystore|mobileprovision|provisionprofile)$/i;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const SERVICE_ACCOUNT =
  /"type"\s*:\s*"service_account"[\s\S]*"private_key"|"private_key"[\s\S]*"type"\s*:\s*"service_account"/;

/** Files in the repo that look like a key: never in a repository (ADR 0901). */
export function keyFiles(root: string): string[] {
  const found: string[] = [];
  for (const file of repoFiles(root)) {
    if (KEY_FILE.test(file)) {
      found.push(file);
      continue;
    }
    const path = join(root, file);
    if (statSync(path).size > 1_000_000) continue;
    const text = readFileSync(path, "latin1");
    if (PRIVATE_KEY.test(text) || SERVICE_ACCOUNT.test(text)) found.push(file);
  }
  return found;
}

/** The app's own code: every script file in its folder but the generated client. */
function appCode(root: string, product: ClientProductDefinition): string[] {
  const mobile = product.mobile as NonNullable<ClientProductDefinition["mobile"]>;
  const generated = join(mobile.dir, mobile.clientDir ?? "src/client")
    .split("\\")
    .join("/");
  const files: string[] = [];
  walk(join(root, mobile.dir), root, files);
  return files.filter(
    (f) =>
      /\.(tsx?|jsx?|mjs|cjs)$/.test(f) &&
      !f.startsWith(`${generated}/`) &&
      !/^(android|ios)\//.test(f.slice(mobile.dir.length + 1)),
  );
}

/** The operation stage 48's "Delete my account" section calls. */
const DELETE_ACCOUNT = /["'`]me\.deleteAccount["'`]/;

// ---- The host's records -------------------------------------------------------------------------

/** The environment a command is for: as appBuild takes it (none for a product without any). */
export function envFlag(product: ClientProductDefinition, flags: Flags): string | undefined {
  const env = str(flags, "env") ?? str(flags, "environment");
  if (!environmentNames(product).length && env === LIVE_ENVIRONMENT) return undefined;
  return env;
}

export function buildFor(
  product: ClientProductDefinition,
  environment: string | undefined,
): AppBuild {
  try {
    return appBuild(product, environment);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

interface Host {
  api: CloudflareClient;
  accountId: string;
  databaseId: string;
}

/**
 * The environment's host database, read and written with the deploy credential, as `cos deploy`
 * finds it; null when no Cloudflare token is given.
 */
async function hostOf(
  flags: Flags,
  deps: Deps,
  product: ClientProductDefinition,
  build: AppBuild,
): Promise<Host | null> {
  const env = deps.env as Record<string, string | undefined>;
  const token = str(flags, "token") ?? env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  deps.redactor.add(token);
  const api = new CloudflareClient({
    token,
    ...(env.COS_CLOUDFLARE_API ? { apiBase: env.COS_CLOUDFLARE_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  let accountId = str(flags, "account") ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await api.listAccounts();
    if (accounts.length !== 1)
      throw new CliError("Pass --account <id> (or CLOUDFLARE_ACCOUNT_ID).");
    accountId = (accounts[0] as { id: string }).id;
  }
  const named = environmentNames(product).length ? build.environment : undefined;
  let located = await locateDeployment(api, accountId, clientNames(product, named).database);
  // A live host deployed before client names keeps the release's (as cos deploy finds it).
  if (!located?.state && build.environment === LIVE_ENVIRONMENT) {
    const known = deps.products ?? { all: products, default: DEFAULT_PRODUCT };
    const release = known.all[product.platform.release];
    if (release) located = await locateDeployment(api, accountId, release.names.database);
  }
  if (!located?.state) {
    throw new CliError(
      `There is no ${build.environment} host in this account to record builds in: deploy it first (cos deploy${named ? ` --env ${named}` : ""}).`,
    );
  }
  return { api, accountId, databaseId: located.databaseId };
}

/** The API version the app's generated client calls (`API_VERSION` in its customer.ts). */
export function generatedApiVersion(root: string, product: ClientProductDefinition): string {
  const mobile = product.mobile as NonNullable<ClientProductDefinition["mobile"]>;
  const file = join(root, mobile.dir, mobile.clientDir ?? "src/client", "customer.ts");
  const found = existsSync(file)
    ? /export const API_VERSION = "([^"]+)"/.exec(readFileSync(file, "utf8"))
    : null;
  if (!found) {
    throw new CliError(
      `${relative(root, file)} has no API_VERSION: run pnpm cos client generate first.`,
    );
  }
  return found[1] as string;
}

function storeOf(build: AppBuild): NonNullable<AppBuild["store"]> {
  if (!build.store) {
    throw new CliError(
      "product.ts gives no mobile.app: the app's name, version, store ids, icon, splash, colours and listing (docs: the start-client-app skill).",
    );
  }
  return build.store;
}

// ---- The commands -------------------------------------------------------------------------------

async function check(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  const mobile = product.mobile;
  if (!mobile) throw new CliError("product.ts has no mobile app (mobile: { dir }).");
  const problems: string[] = [];
  const notes: string[] = [];
  if (!mobile.app) {
    problems.push(
      "product.ts gives no mobile.app: the app's name, version, store ids, icon, splash, colours and listing",
    );
  }
  const envs = environmentNames(product);
  const builds = (envs.length ? envs : [undefined]).map((env) => buildFor(product, env));
  const listings = new Set<string>();
  const images = new Set<string>();
  for (const build of mobile.app ? builds : []) {
    const store = build.store as NonNullable<AppBuild["store"]>;
    const where = envs.length ? `environment ${build.environment}` : "the app";
    if (!build.hostUrl) {
      problems.push(
        envs.length
          ? `${where}: product.ts gives the host no hostname (environments.${build.environment}.hostname), so the app would not know its host`
          : "product.ts declares no environments with a hostname, so the app would not know its host's address",
      );
    }
    for (const [path, what, rule] of [
      [store.icon, "The icon", { size: 1024, opaque: true }],
      [store.splash.image, "The splash image", {}],
    ] as const) {
      if (images.has(path)) continue;
      images.add(path);
      const problem = imageProblem(root, path, what, rule);
      if (problem) problems.push(problem);
    }
    if (!listings.has(store.listing)) {
      listings.add(store.listing);
      const listed = listingProblems(root, store.listing);
      problems.push(...listed.problems);
      notes.push(...listed.notes);
    }
  }
  if (!existsSync(join(root, mobile.dir, "app.config.ts"))) {
    problems.push(
      `${mobile.dir} has no app.config.ts: the app's name, ids and host come from product.ts through it (the template's app.config.ts)`,
    );
  }
  const brand = brandPath(product) as string;
  if (
    !existsSync(join(root, brand)) ||
    readFileSync(join(root, brand), "utf8") !== brandText(product)
  ) {
    problems.push(`${brand} is not product.ts's colours: run pnpm cos client generate`);
  }
  // Nothing is bought in the app (decision 8, ADR 0905), and a person can delete their account in
  // it, as the stores require of an app accounts are made in (stage 48's account shell).
  const code = appCode(root, product);
  let deletes = false;
  for (const file of code) {
    const text = readFileSync(join(root, file), "utf8");
    for (const p of scanPurchases(text)) {
      problems.push(
        `${file}:${p.line} names ${p.names}: nothing is bought in the app (ADR 0490); buying and billing stay on the website`,
      );
    }
    if (DELETE_ACCOUNT.test(text)) deletes = true;
  }
  if (!deletes) {
    problems.push(
      `${mobile.dir} has no "Delete my account" (nothing in it calls me.deleteAccount): the stores require it of an app accounts are made in. Add the native account shell's delete section (stage 48)`,
    );
  }
  for (const file of keyFiles(root)) {
    problems.push(
      `${file} looks like a signing or store key: keys are CI secrets a person sets, never in the repository (cos app credentials). Remove it, and revoke the key if it was ever pushed`,
    );
  }
  // A store id never changes once published: compared with each environment's recorded builds.
  if (mobile.app) {
    const env = deps.env as Record<string, string | undefined>;
    if (str(flags, "token") ?? env.CLOUDFLARE_API_TOKEN) {
      for (const build of builds) {
        const host = await hostOf(flags, deps, product, build).catch((error: unknown) => {
          notes.push(`${build.environment}: recorded builds not read: ${(error as Error).message}`);
          return null;
        });
        if (!host) continue;
        const recorded = await appBuildsViaApi(
          host.api,
          host.accountId,
          host.databaseId,
          build.environment,
        );
        for (const platform of APP_PLATFORMS) {
          const store = build.store as NonNullable<AppBuild["store"]>;
          const problem = recordedIdProblem(recorded ?? [], platform, store.ids[platform]);
          if (problem) problems.push(`${build.environment}: ${problem}`);
        }
      }
    } else {
      notes.push(
        "Store ids not compared with recorded builds: no Cloudflare token (CLOUDFLARE_API_TOKEN). cos app record compares them too.",
      );
    }
  }
  for (const note of notes) io.out(`note: ${note}`);
  for (const problem of problems) io.err(`✗ ${problem}`);
  if (problems.length) {
    io.err(
      `cos app check: ${problems.length} problem${problems.length > 1 ? "s" : ""}. No store build until each is fixed.`,
    );
    return 1;
  }
  io.out(
    `cos app check: ready for the stores' testing tracks (${builds.map((b) => `${b.environment}: ${b.name}, ${b.store?.ids.ios} / ${b.store?.ids.android}`).join("; ")}).`,
  );
  return 0;
}

/** A CI secret the workflow needs: set by a person, never read back, never in the repo. */
export interface AppSecret {
  name: string;
  /** The workflow job that holds it. */
  job: "ios" | "android" | "record";
  what: string;
  /** The command a person runs to set it (GitHub's CLI), reading the value from a file or a prompt. */
  set: string;
}

/** The workflow's protected CI environments: a person approves each run that uses one. */
export const UPLOAD_ENVIRONMENT = "app-upload";
export const RECORD_ENVIRONMENT = "app-record";

const prompt = (name: string, environment: string) =>
  `gh secret set ${name} --env ${environment}   (asks for the value)`;

/** Every secret templates/client/.github/workflows/app.yml reads (stage 63, ADR 0901). */
export const APP_SECRETS: readonly AppSecret[] = [
  {
    name: "IOS_STORE_API_KEY",
    job: "ios",
    what: "the iPhone store's API key (.p8), made in the client's account with a role that may upload",
    set: `gh secret set IOS_STORE_API_KEY --env ${UPLOAD_ENVIRONMENT} < AuthKey_<key id>.p8`,
  },
  {
    name: "IOS_STORE_API_KEY_ID",
    job: "ios",
    what: "that key's id",
    set: prompt("IOS_STORE_API_KEY_ID", UPLOAD_ENVIRONMENT),
  },
  {
    name: "IOS_STORE_API_ISSUER_ID",
    job: "ios",
    what: "the issuer id shown beside the client's API keys",
    set: prompt("IOS_STORE_API_ISSUER_ID", UPLOAD_ENVIRONMENT),
  },
  {
    name: "IOS_TEAM_ID",
    job: "ios",
    what: "the client's developer team id",
    set: prompt("IOS_TEAM_ID", UPLOAD_ENVIRONMENT),
  },
  {
    name: "IOS_DISTRIBUTION_CERTIFICATE",
    job: "ios",
    what: "the distribution certificate and its private key, exported as .p12, in base64",
    set: `base64 < distribution.p12 | gh secret set IOS_DISTRIBUTION_CERTIFICATE --env ${UPLOAD_ENVIRONMENT}`,
  },
  {
    name: "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD",
    job: "ios",
    what: "the .p12's password",
    set: prompt("IOS_DISTRIBUTION_CERTIFICATE_PASSWORD", UPLOAD_ENVIRONMENT),
  },
  {
    name: "ANDROID_UPLOAD_KEYSTORE",
    job: "android",
    what: "the Android upload key (a keystore with the key under the alias upload), in base64; the store keeps the app's own signing key",
    set: `base64 < upload.jks | gh secret set ANDROID_UPLOAD_KEYSTORE --env ${UPLOAD_ENVIRONMENT}`,
  },
  {
    name: "ANDROID_UPLOAD_KEYSTORE_PASSWORD",
    job: "android",
    what: "the keystore's password (the key's too)",
    set: prompt("ANDROID_UPLOAD_KEYSTORE_PASSWORD", UPLOAD_ENVIRONMENT),
  },
  {
    name: "ANDROID_STORE_SERVICE_ACCOUNT",
    job: "android",
    what: "the Android store's upload account key (JSON), invited to the client's account with the release role for testing tracks",
    set: `gh secret set ANDROID_STORE_SERVICE_ACCOUNT --env ${UPLOAD_ENVIRONMENT} < service-account.json`,
  },
  {
    name: "CLOUDFLARE_API_TOKEN",
    job: "record",
    what: "the deploy credential, to read and record builds in the host's database: only the small Linux jobs that run cos hold it, never a build job",
    set: prompt("CLOUDFLARE_API_TOKEN", RECORD_ENVIRONMENT),
  },
  {
    name: "CLOUDFLARE_ACCOUNT_ID",
    job: "record",
    what: "the Cloudflare account the host is in",
    set: prompt("CLOUDFLARE_ACCOUNT_ID", RECORD_ENVIRONMENT),
  },
];

const JOBS = ["ios", "android", "record"] as const;

async function credentials(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const job = str(flags, "for");
  if (job && !(JOBS as readonly string[]).includes(job)) {
    throw new CliError(`--for is one of ${JOBS.join(", ")}.`);
  }
  const wanted = APP_SECRETS.filter((s) => !job || s.job === job);
  if (flags.check) {
    const env = deps.env as Record<string, string | undefined>;
    const missing = wanted.filter((s) => !env[s.name]?.trim());
    if (!missing.length) {
      io.out(`Every secret ${job ? `the ${job} job needs` : "the workflow needs"} is set.`);
      return 0;
    }
    io.err(
      `Missing ${missing.length === 1 ? "a secret" : `${missing.length} secrets`}${job ? ` for the ${job} job` : ""}: ${missing.map((s) => s.name).join(", ")}. A person sets each (never an AI, never in the repository):`,
    );
    for (const s of missing) io.err(`  ${s.name}: ${s.what}\n    ${s.set}`);
    return 1;
  }
  io.out(
    `The app workflow's secrets (stage 63). Each is made in the client's own store or Cloudflare account and set by a person as a secret of a protected CI environment (${UPLOAD_ENVIRONMENT} for the build jobs, ${RECORD_ENVIRONMENT} for the jobs that read and record builds). cos never prints a value.`,
  );
  for (const j of JOBS) {
    const list = wanted.filter((s) => s.job === j);
    if (!list.length) continue;
    io.out(
      `\n${j === "record" ? "build numbers and records" : `${j} build and upload`} (${j === "record" ? RECORD_ENVIRONMENT : UPLOAD_ENVIRONMENT}):`,
    );
    for (const s of list) io.out(`  ${s.name}: ${s.what}\n    ${s.set}`);
  }
  return 0;
}

async function buildInfo(flags: Flags, deps: Deps): Promise<number> {
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  if (!product.mobile) throw new CliError("product.ts has no mobile app (mobile: { dir }).");
  const build = buildFor(product, envFlag(product, flags));
  const store = storeOf(build);
  const apiVersion = generatedApiVersion(root, product);
  const host = await hostOf(flags, deps, product, build);
  if (!host) {
    throw new CliError(
      "The next build number is read from the host's recorded builds: give the deploy credential (CLOUDFLARE_API_TOKEN).",
    );
  }
  const recorded = await appBuildsViaApi(
    host.api,
    host.accountId,
    host.databaseId,
    build.environment,
  );
  const info = {
    environment: build.environment,
    version: build.version,
    build: nextBuildNumber(recorded ?? []),
    apiVersion,
    ids: store.ids,
  };
  if (flags.json) deps.io.out(JSON.stringify(info));
  else {
    deps.io.out(
      `${build.name} (${info.environment}) ${info.version}, build ${info.build}, API ${info.apiVersion}: ${info.ids.ios} / ${info.ids.android}`,
    );
  }
  return 0;
}

/** `--platform ios,android` as a list. */
function platformsOf(flags: Flags): AppPlatform[] {
  const list = (str(flags, "platform") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = list.filter((p) => !(APP_PLATFORMS as readonly string[]).includes(p));
  if (!list.length || bad.length) {
    throw new CliError(
      `--platform is ios, android or both (ios,android)${bad.length ? `, not ${bad.join(", ")}` : ""}.`,
    );
  }
  return [...new Set(list)] as AppPlatform[];
}

function commitOf(flags: Flags, deps: Deps, root: string): string | null {
  const given = str(flags, "commit") ?? (deps.env as Record<string, string | undefined>).GITHUB_SHA;
  if (given) {
    if (!/^[0-9a-f]{7,40}$/.test(given)) throw new CliError("--commit is a commit's sha.");
    return given;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function record(flags: Flags, deps: Deps): Promise<number> {
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  if (!product.mobile) throw new CliError("product.ts has no mobile app (mobile: { dir }).");
  const build = buildFor(product, envFlag(product, flags));
  const store = storeOf(build);
  const platforms = platformsOf(flags);
  const number = Number(str(flags, "build"));
  if (!Number.isInteger(number) || number < 1) {
    throw new CliError("--build is the build number the run used (cos app build-info).");
  }
  const apiVersion = generatedApiVersion(root, product);
  const host = await hostOf(flags, deps, product, build);
  if (!host) {
    throw new CliError(
      "cos app record writes the host's database: give the deploy credential (CLOUDFLARE_API_TOKEN).",
    );
  }
  const commit = commitOf(flags, deps, root);
  const uploadedAt = new Date().toISOString();
  for (const platform of platforms) {
    const row: AppBuildRecord = {
      environment: build.environment,
      platform,
      app_version: build.version,
      build_number: number,
      api_version: apiVersion,
      app_id: store.ids[platform],
      commit_sha: commit,
      uploaded_at: uploadedAt,
      supported: 1,
    };
    let result: "recorded" | "already";
    try {
      result = await recordAppBuildViaApi(host.api, host.accountId, host.databaseId, row);
    } catch (error) {
      if (error instanceof AppBuildRefused) throw new CliError(`Not recorded: ${error.message}.`);
      throw error;
    }
    deps.io.out(
      `${result === "recorded" ? "Recorded" : "Already recorded"}: ${platform} build ${number} of ${build.name} ${build.version} (${row.app_id}, API ${apiVersion}) for ${build.environment}.`,
    );
  }
  return 0;
}

/** `cos app <command>`. */
export async function runApp(argv: string[], deps: Deps): Promise<number> {
  const commands: Record<string, (flags: Flags, deps: Deps) => Promise<number>> = {
    check,
    credentials,
    "build-info": buildInfo,
    record,
    upload: async (flags, d) => (await import("./app-upload.ts")).upload(flags, d),
  };
  const command = commands[argv[0] ?? ""];
  if (!command) {
    deps.io.err(APP_USAGE);
    return 2;
  }
  let flags: Flags;
  try {
    flags = parseArgs([argv[0] as string, ...argv.slice(1)]).flags;
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  try {
    return await command(flags, deps);
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}
