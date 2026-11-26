// `cos` in a company's own repository (stage 24, ADR 0422): create one from the template, adopt an
// existing one, deploy it, upgrade it, and copy blocks into it. Everything a client repo takes from
// the platform comes from one verified release: the one its product.ts names.
//
//   cos create <dir>       a new client repo from the release's template
//   cos init               adopts the repo it is run in: adds files, shows every change to one
//   cos deploy             the host from the release (with the product's packs and the org's own
//                          extensions), then the web app with its binding
//   cos upgrade            (in a client repo) moves product.ts to a newer platform version
//   cos add <block>, cos diff <block>   (blocks.ts)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApiContract, PackRolesFile } from "@composable-os/core/http-contract";
import {
  type ClientProductDefinition,
  clientLocation,
  clientNameMaps,
  clientNames,
  clientWeb,
  defineClientProduct,
  environmentNames,
  gatekeeperSettings,
  isLiveEnvironment,
  LIVE_ENVIRONMENT,
  mobileRole,
  type ProductDefinition,
} from "@composable-os/product";
import { DEFAULT_PRODUCT, products } from "@composable-os/products";
import {
  assetHash,
  CloudflareClient,
  contentTypeOf,
  type DeploymentState,
  locateDeployment,
  type ModulePart,
  type ReleaseManifest,
  releaseAssetNames,
  sha256Hex,
  toBase64,
} from "@composable-os/release";
import { writeBrand } from "./app.ts";
import { lineDiff } from "./diff.ts";
import { HOST_MODULES, recordHostModules, STATE_FILE, upgradeHostModules } from "./host-modules.ts";
import type { Io } from "./io.ts";
import {
  CliError,
  type Deps,
  type Flags,
  install,
  latestVersion,
  releaseSource,
  str,
  upgrade as upgradeHost,
  verified,
} from "./main.ts";
import { installAll, movePlatformVersions, staleInstalls } from "./platform-versions.ts";

/** The web app's routes that reach the host: the template's, unless product.ts says others. */
export function hostRoutes(product?: Pick<ClientProductDefinition, "web">): string[] {
  return [
    product?.web?.routes?.signIn ?? "/auth/",
    product?.web?.routes?.operations ?? "/api/v1/op/",
  ];
}

/**
 * The edge rule worth adding for a web app open to the public (ADR 0415, ADR 0421, ADR 0940), as a
 * step to do. The host limits calls itself, per visitor and per caller; this stops floods before
 * they reach the Workers, at a level a shared network does not reach. It names only the routes that
 * reach the host (the sign-in route and the operation route), so on a site with its own API it
 * does not throttle the site's own routes for everyone behind one address.
 */
export function edgeRuleStep(
  product?: Pick<ClientProductDefinition, "web"> & { packs?: readonly string[] },
): string {
  const expression = [
    ...hostRoutes(product).map((route) => `starts_with(http.request.uri.path, "${route}")`),
    // With Forms, the form page the site forwards to the host (stage 29, ADR 0728): a form's own
    // page and a personal link's, which post to the host as the operation route does.
    ...(product?.packs?.includes("forms")
      ? ['starts_with(http.request.uri.path, "/f/")', 'http.request.uri.path eq "/form"']
      : []),
  ].join(" or ");
  return `The host limits calls from the web app itself, per visitor (ADR 0940). Against floods, also
add a rate limiting rule on the web app's zone (Security > WAF > Rate limiting rules): calls over
the binding do not pass the host's zone. It names only the routes that reach the host (web.routes in
product.ts), so the site's own pages and API are not limited by it:
  Expression:  (${expression})
  Counting:    IP (ip.src), 300 requests per 10 seconds; action Block for 10 seconds`;
}

/** Where the client kit's files are inside it. */
const KIT = { template: "template/", skills: "skills/", blocks: "blocks/", contract: "contract/" };

export type ClientKit = Map<string, Uint8Array>;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function releaseProduct(deps: Deps, id: string): ProductDefinition {
  const known = deps.products ?? { all: products, default: DEFAULT_PRODUCT };
  const product = known.all[id];
  if (!product) {
    throw new CliError(`No platform product ${id}. Known: ${Object.keys(known.all).join(", ")}.`);
  }
  return product;
}

/** The client kit of one release, downloaded and verified like a release for install. */
export async function fetchKit(
  flags: Flags,
  deps: Deps,
  releaseId: string,
  repository: string | undefined,
  version: string | undefined,
  options: { bundleOnly?: boolean } = {},
): Promise<{
  kit: ClientKit;
  version: string;
  manifest: ReleaseManifest;
  release: ProductDefinition;
}> {
  const release = releaseProduct(deps, releaseId);
  const source = releaseSource(repository ? { ...flags, repo: repository } : flags, deps, release);
  const chosen = version ?? (await latestVersion(source, "stable"));
  // With --bundle-dir and `bundleOnly` (cos diff), a release is read from the folder or not at
  // all: never quietly downloaded from GitHub instead.
  if (options.bundleOnly && source.bundleDir) {
    const file = releaseAssetNames(release.id, chosen).bundle;
    if (!existsSync(join(source.bundleDir, file))) {
      throw new CliError(
        `${file} is not in --bundle-dir ${source.bundleDir}: put ${chosen}'s bundle and its SHA256SUMS there, or leave out --bundle-dir to download it.`,
      );
    }
  }
  const { bundle } = await verified(source, chosen, deps);
  if (!bundle.clientFiles.size) {
    throw new CliError(`${release.label} ${chosen} has no client kit: it is older than stage 24.`);
  }
  return { kit: bundle.clientFiles, version: chosen, manifest: bundle.manifest, release };
}

/** The host's app Worker in a release: what a web app's HOST binding names. */
function appWorker(manifest: ReleaseManifest): string {
  const app = manifest.workers.find((w) => w.role === "app");
  if (!app) throw new CliError("The release has no app Worker.");
  return app.name;
}

// ---- product.ts --------------------------------------------------------------------------------

/**
 * A client repo's product.ts, loaded without its dependencies installed: bundled with esbuild,
 * with `@composable-os/product` standing in as plain functions, then checked here.
 */
export async function loadClientProduct(root: string): Promise<ClientProductDefinition> {
  const file = join(root, "product.ts");
  if (!existsSync(file)) {
    throw new CliError("No product.ts here: run cos init to adopt this repository, or cos create.");
  }
  const { build } = await import("esbuild");
  const out = join(mkdtemp("cos-product-"), "product.mjs");
  await build({
    entryPoints: [file],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    plugins: [
      {
        name: "product",
        setup(b) {
          b.onResolve({ filter: /^@composable-os\/product$/ }, () => ({
            path: "product",
            namespace: "cos",
          }));
          b.onLoad({ filter: /.*/, namespace: "cos" }, () => ({
            contents:
              "export const defineClientProduct = (d) => d; export const defineProduct = (d) => d;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = (await import(pathToFileURL(out).href)) as { product?: ClientProductDefinition };
  if (!module.product?.platform) {
    throw new CliError(`${file} does not export a client product (defineClientProduct).`);
  }
  try {
    return defineClientProduct(module.product);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

function mkdtemp(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Rewrites `platform.version` in product.ts, leaving the rest of the file as it is. */
function setPlatformVersion(root: string, version: string) {
  const file = join(root, "product.ts");
  const text = readFileSync(file, "utf8");
  // `platform: { version: "…" }` as the template writes it, or `"platform": { "version": "…" }` as
  // cos init does.
  const next = text.replace(
    /(["']?platform["']?\s*:\s*\{[^}]*["']?version["']?\s*:\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (next === text && !text.includes(`"${version}"`)) {
    throw new CliError("Could not find platform.version in product.ts to change it.");
  }
  writeFileSync(file, next);
}

// ---- The typed client ---------------------------------------------------------------------------

/** The org's own extensions: every folder in extensions/ with an index.ts. */
function orgExtensionDirs(root: string): string[] {
  const dir = join(root, "extensions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "index.ts")))
    .sort();
}

/** Where an app's generated client lives: `<app>/<clientDir>/customer.ts`. */
function appClients(product: ClientProductDefinition): string[] {
  const out: string[] = [];
  if (product.web) out.push(join(product.web.dir, product.web.clientDir ?? "src/client"));
  if (product.mobile) out.push(join(product.mobile.dir, product.mobile.clientDir ?? "src/client"));
  return out;
}

/**
 * Writes each app's typed client from the release's contract: the operations the host of this
 * release serves to customers and the public, the product's packs' tools and the org's own.
 */
export async function generateClients(
  root: string,
  product: ClientProductDefinition,
  kit: ClientKit,
  io: Io,
): Promise<string[]> {
  const { releaseContract, renderClient } = await import("@composable-os/client-gen");
  const { loadExtension } = await import("@composable-os/client-gen/cli");
  const perAudience = ["customer", "public", "staff"].map((audience) => {
    const bytes = kit.get(`${KIT.contract}${audience}.json`);
    if (!bytes) throw new CliError(`The release's client kit has no ${audience} contract.`);
    return JSON.parse(decode(bytes));
  });
  const extensions = await Promise.all(orgExtensionDirs(root).map((dir) => loadExtension(dir)));
  const contract = releaseContract(perAudience, product.packs, extensions);
  const files = renderClient(contract, { product: product.id });
  const written: string[] = [];
  for (const dir of appClients(product)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "customer.ts"), files["customer.ts"] as string);
    written.push(join(dir, "customer.ts"));
  }
  // A client per pack role the mobile app's staff sign in with (ADR 0451): only that role's
  // operations, from the release's roles.json and its staff contract. Never the staff client.
  // And the owner's client, when the app has it (ADR 0872): Today's short list, from the same file.
  const roles = product.mobile?.roles ?? [];
  const owner = product.mobile?.owner === true;
  if ((roles.length || owner) && product.mobile) {
    const { renderOwnerClient, renderRoleClient } = await import("@composable-os/client-gen");
    const rolesFile = kit.get(`${KIT.contract}roles.json`);
    if (!rolesFile) {
      throw new CliError(
        "The release's client kit has no roles.json: it is older than role clients. Upgrade the platform version first.",
      );
    }
    const parsed = JSON.parse(decode(rolesFile)) as PackRolesFile;
    const declared = parsed.roles;
    const staff = perAudience[2] as ApiContract;
    const dir = join(product.mobile.dir, product.mobile.clientDir ?? "src/client", "roles");
    mkdirSync(join(root, dir), { recursive: true });
    if (owner) {
      if (!parsed.owner) {
        throw new CliError(
          "The release's roles.json has no owner's client (mobile.owner): it is older than it. Upgrade the platform version first.",
        );
      }
      writeFileSync(
        join(root, dir, "owner.ts"),
        renderOwnerClient(staff, parsed.owner, { product: product.id }),
      );
      written.push(join(dir, "owner.ts"));
    }
    for (const entry of roles) {
      const { role: name, grants } = mobileRole(entry);
      const role = declared.find((r) => r.name === name);
      if (!role) {
        throw new CliError(
          `The release has no pack role ${name}. Its roles: ${declared.map((r) => r.name).join(", ") || "none"}.`,
        );
      }
      // A role with grants (ADR 0600): its client also holds the tools each grant opens.
      const granted: string[] = [];
      for (const permission of grants) {
        const grant = parsed.grants?.find((g) => g.permission === permission);
        if (!grant) {
          throw new CliError(
            `The release has no grantable permission ${permission}. Its grantable permissions: ${(parsed.grants ?? []).map((g) => g.permission).join(", ") || "none (the release is older than role clients with grants)"}.`,
          );
        }
        if (grant.restricted) {
          io.out(
            `Note: ${name}'s client includes ${permission}, a restricted permission: the host still decides every call, and only an account an admin granted it may use those screens.`,
          );
        }
        granted.push(...grant.operations);
      }
      const withGrants = granted.length
        ? { ...role, operations: [...new Set([...role.operations, ...granted])].sort() }
        : role;
      writeFileSync(
        join(root, dir, `${name}.ts`),
        renderRoleClient(staff, withGrants, { product: product.id, grants }),
      );
      written.push(join(dir, `${name}.ts`));
    }
  }
  if (written.length) io.out(`Typed client: ${written.join(", ")}`);
  // The app's brand from product.ts, beside its copied blocks (stage 63, ADR 0900).
  const brand =
    product.mobile && existsSync(join(root, product.mobile.dir)) ? writeBrand(root, product) : null;
  if (brand) written.push(brand);
  return written;
}

/** The type errors in each app, with its own tsconfig, before anything is deployed. */
export async function typeErrors(
  root: string,
  product: ClientProductDefinition,
): Promise<string[]> {
  const apps = [product.web?.dir, product.mobile?.dir].filter((d): d is string => Boolean(d));
  const errors: string[] = [];
  let ts: typeof import("typescript");
  try {
    ts = (await import("typescript")).default;
  } catch {
    throw new CliError("TypeScript is not installed here: pnpm add -D typescript");
  }
  for (const app of apps) {
    const config = join(root, app, "tsconfig.json");
    if (!existsSync(config)) continue;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      config,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      },
    );
    if (!parsed) continue;
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const where = d.file
        ? `${relative(root, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
        : app;
      errors.push(`${where}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    }
  }
  return errors;
}

/** Writes the release's skills into skills/, replacing the ones there (a client repo's copy). */
function writeSkills(root: string, kit: ClientKit): number {
  let count = 0;
  for (const [path, bytes] of kit) {
    if (!path.startsWith(KIT.skills)) continue;
    const target = join(root, "skills", path.slice(KIT.skills.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    count += 1;
  }
  return count;
}

// ---- cos create ---------------------------------------------------------------------------------

interface Values {
  id: string;
  label: string;
  version: string;
  release: string;
  repository: string;
  appWorker: string;
}

function render(text: string, values: Values): string {
  return text
    .replaceAll("{{id}}", values.id)
    .replaceAll("{{label}}", values.label)
    .replaceAll("{{version}}", values.version)
    .replaceAll("{{release}}", values.release)
    .replaceAll("{{repository}}", values.repository);
}

/** A package.json of the template, for this repo: its name, and the platform's packages pinned. */
function appPackage(text: string, name: string, version: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  pkg.name = name;
  delete pkg.description;
  // The template mobile app is type-checked here with the platform's own blocks
  // (tsconfig.platform.json, not in the kit); a client repo has them copied, and its own config.
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts?.typecheck?.includes("tsconfig.platform.json")) scripts.typecheck = "tsc --noEmit";
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = pkg[key] as Record<string, string> | undefined;
    for (const [dep, range] of Object.entries(deps ?? {})) {
      if (range.startsWith("workspace:")) (deps as Record<string, string>)[dep] = version;
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** The template's files as this repo has them: path → text. */
export function templateFiles(kit: ClientKit, values: Values): Map<string, string> {
  const files = new Map<string, string>();
  for (const [path, bytes] of kit) {
    if (!path.startsWith(KIT.template)) continue;
    let rel = path.slice(KIT.template.length);
    let text = decode(bytes);
    if (/(^|\/)src\/client\/customer\.ts$/.test(rel)) continue; // generated for this product
    if (rel.endsWith(".template")) {
      rel = rel.slice(0, -".template".length);
      if (basename(rel) === "gitignore") rel = join(dirname(rel), ".gitignore");
      text = render(text, values);
    }
    const app = /^apps\/([^/]+)\/(package\.json|wrangler\.jsonc)$/.exec(rel);
    if (app?.[2] === "package.json")
      text = appPackage(text, `${values.id}-${app[1]}`, values.version);
    if (app?.[2] === "wrangler.jsonc") {
      text = text
        .replace(/"name":\s*"client-web"/, `"name": "${values.id}-web"`)
        .replace(/"service":\s*"cos-app"/, `"service": "${values.appWorker}"`);
    }
    files.set(rel.replace(/^\.\//, ""), text);
  }
  return files;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The template's workflow that builds the app and sends it to the stores' testing tracks. */
const APP_WORKFLOW = ".github/workflows/app.yml";

/** What `cos create --with-mobile` adds to product.ts: the app, and its identity to fill in. */
const MOBILE_ENTRY = `  mobile: {
    dir: "apps/mobile",
    // The app's identity in the phone app stores (stage 63): app.config.ts and the app's brand are
    // made from it. Fill it in before the first store build, then run \`pnpm cos app check\`.
    // app: {
    //   name: "Example", // under the icon, at most 30 characters
    //   version: "1.0.0",
    //   ids: { ios: "com.example.app", android: "com.example.app" }, // never change once published
    //   icon: "apps/mobile/assets/icon.png", // 1024 by 1024, no transparency
    //   splash: { image: "apps/mobile/assets/splash.png", background: "#ffffff" },
    //   colours: { primary: "#18181b", background: "#ffffff", text: "#18181b" },
    //   listing: "apps/mobile/store", // <locale>/name.txt, subtitle.txt, description.txt, …
    //   purchases: "none",
    // },
    // A staging app installs beside the live one with its own name, ids and scheme:
    // environments.staging.mobile: { scheme: "example-staging", app: { name, ids } }.
  },`;

export async function create(argv: string[], flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const target = argv[0];
  if (!target) throw new CliError("Usage: cos create <dir> [--version x.y.z] [--label <name>]");
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length) {
    throw new CliError(
      `${target} is not empty. cos create starts a new repo; cos init adopts one.`,
    );
  }
  const id = str(flags, "id") ?? slug(basename(root));
  const releaseId = str(flags, "release") ?? deps.products?.default ?? DEFAULT_PRODUCT;
  const { kit, version, release } = await fetchKit(
    flags,
    deps,
    releaseId,
    str(flags, "repo"),
    str(flags, "version"),
  );
  const values: Values = {
    id,
    label:
      str(flags, "label") ??
      id.replace(
        /(^|-)([a-z])/g,
        (_m, s: string, c: string) => `${s ? " " : ""}${c.toUpperCase()}`,
      ),
    version,
    release: release.id,
    repository: str(flags, "repo") ?? release.updateRepository,
    // The host is named for the product (issue #155): `cos deploy` installs it as <id>-app.
    appWorker: `${id}-app`,
  };
  const files = templateFiles(kit, values);
  // The mobile app is optional (--with-mobile): without it, its folder is left out and product.ts
  // names only the web app.
  const mobile = Boolean(flags["with-mobile"]);
  // Without it, its folder and its CI workflow (stage 63) are left out and product.ts names only
  // the web app.
  for (const path of [...files.keys()])
    if (!mobile && (path.startsWith("apps/mobile/") || path === APP_WORKFLOW)) files.delete(path);
  if (mobile) {
    const product = files.get("product.ts") as string;
    files.set("product.ts", product.replace(/(\n\s*web: \{[^\n]*\},)/, `$1\n${MOBILE_ENTRY}`));
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const skills = writeSkills(root, kit);
  const product = await loadClientProduct(root);
  // The mobile app's Account tab is My account's native shell (stage 48 criterion 12): copied
  // with its sections as `cos add native-account` copies it, so it is the client's from the start.
  if (mobile && product.mobile && kit.has("blocks/native-account/block.json")) {
    const { copyBlocks, saveLock } = await import("./blocks.ts");
    const lock = {};
    copyBlocks(root, product, kit, version, ["native-account"], lock);
    saveLock(root, lock);
  }
  await generateClients(root, product, kit, io);
  // What cos wrote of the host modules, so cos upgrade can tell an edited one (ADR 0451).
  recordHostModules(root, product, kit, version);
  // A repository from the start, so copied blocks and generated files can be committed.
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  } catch {}
  io.out(
    `Created ${values.label} in ${target}: ${files.size} files and ${skills} skills from ${release.label} ${version}.`,
  );
  io.out(`\nNext:\n  cd ${target}\n  pnpm install\n  pnpm cos deploy\n\n${edgeRuleStep(product)}`);
  return 0;
}

// ---- cos init -----------------------------------------------------------------------------------

/** One change to an existing file: shown as a diff, applied only when told. */
interface Change {
  path: string;
  before: string;
  after: string;
}

function readIf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** A JSON file with `entries` added to `key` (dependencies), keeping the file's own formatting. */
function withDependencies(text: string, key: string, entries: Record<string, string>): string {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const deps = { ...(pkg[key] ?? {}) };
  let changed = false;
  for (const [name, range] of Object.entries(entries)) {
    if (!deps[name]) {
      deps[name] = range;
      changed = true;
    }
  }
  if (!changed) return text;
  pkg[key] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  const indent = /^\s+/m.exec(text.split("\n")[1] ?? "  ")?.[0] ?? "  ";
  return `${JSON.stringify(pkg, null, indent)}\n`;
}

/**
 * A tsconfig that lets the app import `.ts` files by name (`allowImportingTsExtensions`, which
 * needs `noEmit`), keeping the rest. Unchanged when it already does, or is not plain JSON.
 */
export function withTsExtensions(text: string): string {
  let config: { compilerOptions?: Record<string, unknown> };
  try {
    config = JSON.parse(text);
  } catch {
    return text;
  }
  const options = config.compilerOptions ?? {};
  if (options.allowImportingTsExtensions === true && options.noEmit === true) return text;
  config.compilerOptions = { ...options, allowImportingTsExtensions: true, noEmit: true };
  const indent = /^\s+/m.exec(text.split("\n")[1] ?? "  ")?.[0] ?? "  ";
  return `${JSON.stringify(config, null, indent)}\n`;
}

/** The index of the `}` that closes the `{` at `open`, skipping strings and comments. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * A wrangler config with the HOST service binding added under its environment `env` (JSONC
 * `"env": { "<env>": { … } }` or TOML `[env.<env>]`), or null when the config has no such
 * environment. Wrangler does not inherit `services` into an environment, so it goes there.
 */
export function withEnvBinding(
  path: string,
  text: string,
  env: string,
  service: string,
): string | null {
  const entry = `{ "binding": "HOST", "service": "${service}", "entrypoint": "ClientApp" }`;
  if (path.endsWith(".toml")) {
    if (!new RegExp(`^\\[env\\.${env}\\]`, "m").test(text)) return null;
    if (new RegExp(`\\[\\[env\\.${env}\\.services\\]\\][^[]*binding\\s*=\\s*"HOST"`).test(text))
      return text;
    return `${text.trimEnd()}\n\n# The ${env} host (Composable OS): customers and the public, over the ClientApp entrypoint.\n[[env.${env}.services]]\nbinding = "HOST"\nservice = "${service}"\nentrypoint = "ClientApp"\n`;
  }
  const envKey = /"env"\s*:\s*\{/.exec(text);
  if (!envKey) return null;
  const envOpen = envKey.index + envKey[0].length - 1;
  const envClose = closingBrace(text, envOpen);
  const named = new RegExp(`"${env}"\\s*:\\s*\\{`).exec(text.slice(envOpen, envClose));
  if (!named) return null;
  const open = envOpen + named.index + named[0].length - 1;
  const close = closingBrace(text, open);
  const block = text.slice(open, close);
  if (/"HOST"/.test(block) && block.includes("ClientApp")) return text;
  const services = /"services"\s*:\s*\[/.exec(block);
  if (services) {
    const at = open + services.index + services[0].length;
    return `${text.slice(0, at)}${entry}, ${text.slice(at)}`;
  }
  const body = text.slice(open + 1, close).trim();
  const indent = /\n([ \t]*)\S/.exec(text.slice(open, close))?.[1] ?? "      ";
  return `${text.slice(0, open + 1)}\n${indent}"services": [${entry}]${body ? "," : ""}${text.slice(open + 1)}`;
}

function wranglerConfig(dir: string): string | null {
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export async function init(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const root = resolve(str(flags, "dir") ?? process.cwd());
  if (existsSync(join(root, "product.ts"))) {
    throw new CliError("This repo already has a product.ts: it is adopted. Use cos upgrade.");
  }
  const id = str(flags, "id") ?? slug(basename(root));
  const ask = async (question: string, found: string | undefined) => {
    if (flags.yes || !io.interactive) return found ?? "";
    return (await io.ask(`${question} (empty for none)`, { default: found ?? "" })).trim();
  };
  const guessWeb = wranglerConfig(root) ? "." : undefined;
  const guessMobile = ["mobile", "app", "apps/mobile"].find((d) =>
    ["app.json", "app.config.ts", "app.config.js"].some((f) => existsSync(join(root, d, f))),
  );
  const webDir = str(flags, "web") ?? (await ask("Where is the web app (its Worker)?", guessWeb));
  const mobileDir = str(flags, "mobile") ?? (await ask("Where is the mobile app?", guessMobile));
  const releaseId = str(flags, "release") ?? deps.products?.default ?? DEFAULT_PRODUCT;
  const { kit, version, release } = await fetchKit(
    flags,
    deps,
    releaseId,
    str(flags, "repo"),
    str(flags, "version"),
  );
  const repository = str(flags, "repo") ?? release.updateRepository;
  const clientDir = "src/composable-os";
  // The web app keeps its own Worker, its name and the way it deploys today.
  const webConfig = webDir ? wranglerConfig(join(root, webDir)) : null;
  const existingName = webConfig
    ? /"?name"?\s*[:=]\s*"([a-z0-9-]+)"/.exec(readFileSync(webConfig, "utf8"))?.[1]
    : undefined;

  // The packs to turn on (--packs), each one the release carries.
  const list = (flag: string) =>
    (str(flags, flag) ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  const packs = list("packs");
  const carried = kitPacks(kit);
  const unknown = packs.filter((p) => !carried.has(p));
  if (unknown.length) {
    throw new CliError(
      `${release.label} ${version} does not carry the pack${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (it carries ${[...carried].sort().join(", ") || "none"}). Nothing was written.`,
    );
  }
  // The environments to declare (--envs staging,live, ADR 0450); none is one deployment.
  const envs = list("envs");

  // New files: never over one that exists.
  const product: ClientProductDefinition = {
    id,
    label: str(flags, "label") ?? id,
    platform: { version, release: release.id, repository },
    packs,
    ...(envs.length ? { environments: Object.fromEntries(envs.map((e) => [e, {}])) } : {}),
    ...(webDir
      ? {
          web: {
            dir: webDir,
            worker: existingName ?? `${id}-web`,
            clientDir,
            deploy: "own" as const,
            // The routes the site serves to reach the host: what the edge rule names.
            ...(str(flags, "sign-in-route") || str(flags, "operation-route")
              ? {
                  routes: {
                    ...(str(flags, "sign-in-route") ? { signIn: str(flags, "sign-in-route") } : {}),
                    ...(str(flags, "operation-route")
                      ? { operations: str(flags, "operation-route") }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(mobileDir ? { mobile: { dir: mobileDir, clientDir } } : {}),
  };
  const productText = `// This product: what the host is deployed from, which packs are on, and where the apps are.
// Added by cos init; cos deploy reads it and cos upgrade moves platform.version. See AGENTS.md.
import { defineClientProduct } from "@composable-os/product";

export const product = defineClientProduct(${JSON.stringify(product, null, 2)});
`;
  writeFileSync(join(root, "product.ts"), productText);
  const added = ["product.ts"];
  const skills = writeSkills(root, kit);
  added.push(`skills/ (${skills} skills)`);
  added.push(...(await generateClients(root, defineClientProduct(product), kit, io)));
  // Each app's host module, beside its client: the template's, which does the binding or the
  // HTTPS sign-in, and keeps a signed-in customer signed in. New files only.
  const hostModules: [string | undefined, string, string[]][] = [
    [webDir, "web", HOST_MODULES.web],
    [mobileDir, "mobile", HOST_MODULES.mobile],
  ];
  for (const [app, kind, files] of hostModules) {
    if (!app) continue;
    for (const file of files) {
      const source = kit.get(`${KIT.template}apps/${kind}/src/${file}`);
      const target = join(root, app, clientDir, file);
      if (!source || existsSync(target)) continue;
      writeFileSync(target, decode(source).replaceAll("./client/customer.ts", "./customer.ts"));
      added.push(join(app, clientDir, file));
    }
  }
  // What cos wrote of them, so cos upgrade can replace an unedited one (ADR 0451). One that was
  // there already, and differs, is the company's: not recorded.
  recordHostModules(root, defineClientProduct(product), kit, version);
  added.push(STATE_FILE);

  // Changes to files that exist: each shown, applied only when told.
  const changes: Change[] = [];
  const consider = (path: string, after: (before: string | null) => string) => {
    const full = join(root, path);
    const before = readIf(full);
    const next = after(before);
    if (before === null) {
      writeFileSync(full, next);
      added.push(path);
    } else if (next !== before) changes.push({ path, before, after: next });
  };
  const rules = decode(kit.get(`${KIT.template}AGENTS.md`) ?? new Uint8Array());
  consider("AGENTS.md", (before) =>
    before === null
      ? rules
      : before.includes("composable-os: client repo rules")
        ? before
        : `${before.trimEnd()}\n\n${rules}`,
  );
  consider("package.json", (before) =>
    withDependencies(before ?? `{ "name": "${id}", "private": true }\n`, "devDependencies", {
      "@composable-os/cli": version,
      "@composable-os/product": version,
    }),
  );
  const mobileTemplate = kit.get(`${KIT.template}apps/mobile/package.json`);
  // The native modules the mobile host module uses: the secure store and the secure random source.
  const mobileDeps = mobileTemplate
    ? ((JSON.parse(decode(mobileTemplate)).dependencies ?? {}) as Record<string, string>)
    : {};
  for (const app of [webDir, mobileDir].filter((d): d is string => Boolean(d))) {
    if (!existsSync(join(root, app, "package.json"))) continue;
    const needs: Record<string, string> = { "@composable-os/client": version };
    if (app === mobileDir) {
      for (const name of ["expo-secure-store", "expo-crypto"]) {
        const range = mobileDeps[name];
        if (range) needs[name] = range;
      }
    }
    if (app === ".") {
      // The root package.json is also the web app's: one change for both.
      const index = changes.findIndex((c) => c.path === "package.json");
      const current = index >= 0 ? (changes[index] as Change) : null;
      const after = withDependencies(
        current?.after ?? readFileSync(join(root, "package.json"), "utf8"),
        "dependencies",
        needs,
      );
      const before = readFileSync(join(root, "package.json"), "utf8");
      if (current) current.after = after;
      else if (after !== before) changes.push({ path: "package.json", before, after });
      continue;
    }
    consider(join(app, "package.json"), (before) =>
      withDependencies(before as string, "dependencies", needs),
    );
  }
  // The host module and the native blocks import with `.ts`/`.tsx` extensions, which an app on
  // expo/tsconfig.base refuses (TS5097) until it allows them: shown as a diff like the others.
  if (mobileDir && existsSync(join(root, mobileDir, "tsconfig.json"))) {
    consider(join(mobileDir, "tsconfig.json"), (before) => withTsExtensions(before as string));
  }
  // Apps in folders of their own install with the root's pnpm install.
  const members = [webDir, mobileDir].filter((d): d is string => Boolean(d) && d !== ".");
  if (members.length && !existsSync(join(root, "pnpm-workspace.yaml"))) {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      `packages:\n${members.map((m) => `  - ${m}\n`).join("")}`,
    );
    added.push("pnpm-workspace.yaml");
  }
  if (webDir) {
    const config = webConfig;
    const own = config
      ? OWN_RESOURCES.filter((key) =>
          new RegExp(`"?${key}"?\\s*[:=]|\\[\\[${key}\\]\\]`).test(readFileSync(config, "utf8")),
        )
      : [];
    if (own.length) {
      io.out(
        `Note: the web app has data of its own (${own.join(", ")}). It keeps them and keeps deploying itself (web.deploy "own"). Customers' records live in the host: what moves there, and when, is the company's decision, not an agent's.`,
      );
    }
    // The adopted site deploys itself, perhaps on every push to its main branch: a HOST binding
    // to a host that does not exist yet would fail that deploy. So nothing is added to its
    // top-level config. Under an environment of its own config that matches one of product.ts's,
    // the binding is shown as a diff (that environment is deployed only when someone says so);
    // everything else is printed, to add once that environment's host exists (cos deploy).
    const defined = defineClientProduct(product);
    const later: string[] = [];
    for (const env of envs.length ? envs : [undefined]) {
      const host = clientNames(defined, env).app;
      const text = config ? readFileSync(config, "utf8") : null;
      const under = config && text && env ? withEnvBinding(config, text, env, host) : null;
      if (config && under !== null) {
        const path = relative(root, config);
        const pending = changes.find((c) => c.path === path);
        if (pending)
          pending.after =
            withEnvBinding(config, pending.after, env as string, host) ?? pending.after;
        else if (under !== text) changes.push({ path, before: text as string, after: under });
      } else {
        later.push(
          `  ${env ? `${env}: ` : ""}${hostBindingText(host, env)}${config ? "" : ` (no wrangler config in ${webDir})`}`,
        );
      }
    }
    if (later.length) {
      io.out(
        `\nThe site's Worker config needs the HOST binding${envs.length > 1 ? " in each environment" : ""}. Add it only after cos deploy${envs.length ? " --env <name>" : ""} has made that host, before the site's next deploy:\n${later.join("\n")}`,
      );
    }
  }
  if (!existsSync(join(root, "package.json"))) added.push("package.json");

  io.out(`Added: ${added.join(", ")}`);
  for (const change of changes) {
    io.out(`\n--- ${change.path}\n+++ ${change.path} (cos init)`);
    for (const line of lineDiff(change.before, change.after)) io.out(line);
  }
  if (changes.length) {
    const apply =
      Boolean(flags.yes) ||
      (io.interactive && /^y/i.test(await io.ask("Apply these changes? (y/N)", { default: "n" })));
    if (apply) {
      for (const change of changes) writeFileSync(join(root, change.path), change.after);
      io.out(`\nChanged: ${changes.map((c) => c.path).join(", ")}`);
    } else {
      io.out("\nNot changed. Apply the diffs above by hand, or run cos init again with --yes.");
    }
  }
  io.out(`\nNext: pnpm install, then pnpm cos deploy.\n\n${edgeRuleStep(product)}`);
  return 0;
}

// ---- cos deploy ---------------------------------------------------------------------------------

/** The org's extensions as the runner reads them from BLOBS (shipped-list.ts). */
function orgExtensionSources(root: string) {
  const SKIP = new Set(["node_modules", "test", "tests", "dist", ".turbo"]);
  const files = (dir: string, base: string, out: Record<string, string>) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) files(path, base, out);
      } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|config)\.(ts|js)$/.test(entry.name)) {
        out[relative(base, path).split("\\").join("/")] = readFileSync(path, "utf8");
      }
    }
    return out;
  };
  return orgExtensionDirs(root).map((dir) => {
    const pkg = existsSync(join(dir, "package.json"))
      ? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string })
      : {};
    return { id: basename(dir), version: pkg.version ?? "0.0.0", files: files(dir, dir, {}) };
  });
}

/** Runs `cos ext check` on each of the org's extensions. Problems stop the deploy. */
async function checkOrgExtensions(root: string, io: Io): Promise<boolean> {
  const dirs = orgExtensionDirs(root);
  if (!dirs.length) return true;
  const { runExt } = await import("@composable-os/extension-check/cli");
  let ok = true;
  for (const dir of dirs) {
    io.out(`cos ext check ${relative(root, dir)}`);
    if ((await runExt(["check", dir], io)) !== 0) ok = false;
  }
  return ok;
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path, base));
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
}

const OWN_RESOURCES = [
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "queues",
  "vectorize",
  "hyperdrive",
];

interface BuiltWeb {
  out: string;
  config: Record<string, unknown>;
}

/**
 * Builds the web app and checks its build, before anything in the account changes: TanStack
 * Start's output (the template's) in `dist/server`, with no binding of its own but HOST.
 */
function buildWeb(root: string, product: ClientProductDefinition, flags: Flags, io: Io): BuiltWeb {
  const web = product.web as NonNullable<ClientProductDefinition["web"]>;
  const dir = join(root, web.dir);
  if (!flags["skip-build"]) {
    io.out(`Building ${web.dir}…`);
    execFileSync("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });
  }
  const out = join(dir, "dist", "server");
  const configPath = join(out, "wrangler.json");
  if (!existsSync(configPath))
    throw new CliError(
      `No build at ${relative(root, out)}/wrangler.json. cos deploy uploads a web app built the way the template's is (TanStack Start with the Cloudflare Vite plugin). A web app that deploys itself (an adopted site) sets web.deploy: "own" in product.ts. Nothing was deployed.`,
    );
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  for (const key of OWN_RESOURCES) {
    if (Array.isArray(config[key]) && (config[key] as unknown[]).length) {
      throw new CliError(
        `The web app has its own ${key}: a client app reaches the host only through HOST and never opens a database (AGENTS.md).`,
      );
    }
  }
  const services = (config.services as { binding: string }[] | undefined) ?? [];
  if (services.some((s) => s.binding !== "HOST")) {
    throw new CliError("The web app may have one service binding, HOST, to the host.");
  }
  return { out, config };
}

/** Uploads the built web app with its one binding, HOST, to the host's ClientApp entrypoint. */
async function deployWeb(
  api: CloudflareClient,
  accountId: string,
  web: { worker: string; hostname?: string },
  host: string,
  { out, config }: BuiltWeb,
): Promise<string> {
  const modules: ModulePart[] = walkFiles(out)
    .filter((f) => f !== "wrangler.json" && !f.endsWith(".map") && !f.startsWith("."))
    .map((name) => ({
      name,
      type: /\.(m?js)$/.test(name) ? "esm" : "text",
      bytes: new Uint8Array(readFileSync(join(out, name))),
    }));
  const main = String(config.main ?? "index.js");
  let assetsJwt: string | undefined;
  const assetsDir = (config.assets as { directory?: string } | undefined)?.directory;
  if (assetsDir && existsSync(join(out, assetsDir))) {
    const base = join(out, assetsDir);
    const manifest: Record<string, { hash: string; size: number }> = {};
    const bytesOf = new Map<string, Uint8Array>();
    for (const file of walkFiles(base).filter((f) => !f.startsWith("."))) {
      const bytes = new Uint8Array(readFileSync(join(base, file)));
      const hash = await assetHash(bytes, `/${file}`);
      manifest[`/${file}`] = { hash, size: bytes.length };
      bytesOf.set(hash, bytes);
    }
    const session = await api.assetsUploadSession(accountId, web.worker, manifest);
    const pathOf = new Map(Object.entries(manifest).map(([p, f]) => [f.hash, p]));
    assetsJwt = session.buckets?.length ? undefined : session.jwt;
    for (const bucket of session.buckets ?? []) {
      const token = await api.uploadAssets(
        accountId,
        session.jwt,
        bucket.map((hash) => ({
          hash,
          base64: toBase64(bytesOf.get(hash) as Uint8Array),
          contentType: contentTypeOf(pathOf.get(hash) ?? ""),
        })),
      );
      if (token) assetsJwt = token;
    }
  }
  const metadata: Record<string, unknown> = {
    main_module: main,
    compatibility_date: config.compatibility_date ?? "2026-10-01",
    compatibility_flags: config.compatibility_flags ?? ["nodejs_compat"],
    bindings: [{ type: "service", name: "HOST", service: host, entrypoint: "ClientApp" }],
    ...(assetsJwt ? { assets: { jwt: assetsJwt } } : {}),
  };
  await api.putScript(accountId, web.worker, metadata, modules);
  if (web.hostname) {
    const zones = await api.listZones(accountId);
    const zone = zones
      .filter((z) => web.hostname === z.name || web.hostname?.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) throw new CliError(`No zone in this account covers ${web.hostname}.`);
    await api.putDomain(accountId, web.hostname, web.worker, zone.id);
    return `https://${web.hostname}`;
  }
  await api.setWorkersDev(accountId, web.worker, true);
  const sub = await api.workersSubdomain(accountId);
  return `https://${web.worker}.${sub ?? "<subdomain>"}.workers.dev`;
}

function blobsBucket(manifest: ReleaseManifest, state: DeploymentState): string {
  // The BLOBS bucket the runner reads the org's extensions from (shipped-list.ts).
  const bucket = manifest.resources.find((r) => r.type === "r2" && r.name.endsWith("-blobs"));
  if (!bucket) throw new CliError("The release has no BLOBS bucket for the org's extensions.");
  return state.resourceNames?.[bucket.name] ?? bucket.name;
}

/**
 * The environment a deploy is for (ADR 0450): none when product.ts declares none (and --env is
 * not given); the one --env names; the only one; else a refusal that lists them.
 */
export function chooseEnvironment(
  product: ClientProductDefinition,
  flag: string | undefined,
): string | undefined {
  const envs = environmentNames(product);
  if (!envs.length) {
    if (flag) {
      throw new CliError(
        `product.ts declares no environments, so there is no ${flag}: leave out --env, or add environments to product.ts.`,
      );
    }
    return undefined;
  }
  if (flag) {
    if (!envs.includes(flag)) {
      throw new CliError(
        `product.ts has no environment ${flag}. Its environments: ${envs.join(", ")}.`,
      );
    }
    return flag;
  }
  if (envs.length === 1) return envs[0];
  throw new CliError(
    `product.ts has ${envs.length} environments: say which with --env (${envs.join(", ")}). Nothing was deployed.`,
  );
}

/**
 * The platform's own command-line door, `cos content import` (ADR 0470): a browser sign-in handed
 * back to a port on this computer, any port (ADR 0457). Listed on every host `cos deploy` makes.
 */
export const IMPORT_LOOPBACK_REDIRECT = "http://127.0.0.1/cos-sign-in";

/**
 * Where the host may send a staff member's browser sign-in back to, in an environment: the
 * command-line door always, and the mobile app's `<scheme>://staff-sign-in` when the product has
 * one. Comma separated, as NATIVE_REDIRECT_URIS takes it.
 */
export function nativeRedirectUris(
  product: ClientProductDefinition,
  environment: string | undefined,
): string {
  return [
    IMPORT_LOOPBACK_REDIRECT,
    ...(product.mobile ? [nativeRedirectUri(product, environment)] : []),
  ].join(",");
}

/**
 * Where the host sends a staff member's browser sign-in back to the mobile app in an environment:
 * `<scheme>://staff-sign-in`, the scheme as product.ts declares it for that environment.
 */
export function nativeRedirectUri(
  product: ClientProductDefinition,
  environment: string | undefined,
): string {
  const scheme =
    (environment ? product.environments?.[environment]?.mobile?.scheme : undefined) ??
    product.mobile?.scheme ??
    product.id;
  return `${scheme}://staff-sign-in`;
}

type ManifestWorker = ReleaseManifest["workers"][number];

/**
 * What a deploy applies of product.ts's gatekeeper settings (ADR 0452): the gatekeepers to
 * install and, per the release's Worker name, the plain vars and send_email limits each takes.
 * A setting the gatekeeper does not declare, a secret, a derived value, or the fake payment
 * provider in a live environment is a problem, said before anything changes.
 */
export function gatekeeperPlan(
  manifest: ReleaseManifest,
  product: ClientProductDefinition,
  environment: string | undefined,
):
  | {
      workers: ManifestWorker[];
      vars: Record<string, Record<string, string>>;
      sendEmail: NonNullable<DeploymentState["sendEmail"]>;
    }
  | { problem: string } {
  const settings = gatekeeperSettings(product, environment) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const where = environment ? `environment ${environment}` : "product.ts";
  const gatekeepers = manifest.workers.filter((w) => w.role === "gatekeeper");
  const workers: ManifestWorker[] = [];
  const vars: Record<string, Record<string, string>> = {};
  const sendEmail: NonNullable<DeploymentState["sendEmail"]> = {};
  for (const [short, values] of Object.entries(settings)) {
    const worker = gatekeepers.find((w) => w.shortName === short);
    if (!worker) {
      return {
        problem: `${where} names the gatekeeper ${short}, which this release does not have (it has ${gatekeepers.map((w) => w.shortName).join(", ")}).`,
      };
    }
    workers.push(worker);
    const declared = worker.bindings
      .filter((b) => b.type === "plain_text")
      .map((b) => b.name)
      // Derived from the environment's own host: never set by hand.
      .filter((name) => name !== "BASE_URL");
    const secrets = (worker.secrets ?? []).map((s) => s.name);
    for (const [key, value] of Object.entries(values ?? {})) {
      if (key === "sendEmail") {
        const email = worker.bindings.find((b) => b.type === "send_email");
        if (!email) return { problem: `${short} has no send_email binding to set.` };
        const v = value as {
          allowedSenderAddresses?: string[];
          destinationAddress?: string;
          allowedDestinationAddresses?: string[];
        };
        sendEmail[worker.name] = {
          [email.name]: {
            ...(v.allowedSenderAddresses
              ? { allowed_sender_addresses: v.allowedSenderAddresses }
              : {}),
            ...(v.destinationAddress ? { destination_address: v.destinationAddress } : {}),
            ...(v.allowedDestinationAddresses
              ? { allowed_destination_addresses: v.allowedDestinationAddresses }
              : {}),
          },
        };
        continue;
      }
      if (secrets.includes(key)) {
        return {
          problem: `${key} is a secret of ${short}: it never goes in product.ts. Take it out, and set it with npx wrangler secret put ${key} --name <the deployed ${short} Worker>.`,
        };
      }
      if (key === "BASE_URL") {
        return {
          problem: `${short}'s BASE_URL is derived from the host's hostname: take it out of ${where}.`,
        };
      }
      if (!declared.includes(key)) {
        return {
          problem: `${short} takes no setting ${key}. It takes: ${declared.join(", ") || "none"}.`,
        };
      }
      vars[worker.name] = { ...vars[worker.name], [key]: String(value) };
    }
    const fake =
      vars[worker.name]?.PAYMENTS_FAKE_PROVIDER === "true"
        ? "the fake payment provider"
        : vars[worker.name]?.TEXT_PROVIDER === "fake"
          ? "the fake text provider"
          : null;
    if (fake && isLiveEnvironment(product, environment)) {
      return {
        problem: `${where} is live and turns on ${fake}: only an environment marked live: false may.`,
      };
    }
  }
  return { workers, vars, sendEmail };
}

/** The HOST binding an adopted site's own Worker config needs in an environment, as text. */
export function hostBindingText(host: string, environment: string | undefined): string {
  const entry = `{ "binding": "HOST", "service": "${host}", "entrypoint": "ClientApp" }`;
  return environment && environment !== LIVE_ENVIRONMENT
    ? `"env": { "${environment}": { "services": [${entry}] } }   (TOML: [[env.${environment}.services]] binding = "HOST", service = "${host}", entrypoint = "ClientApp")`
    : `"services": [${entry}]   (TOML: [[services]] binding = "HOST", service = "${host}", entrypoint = "ClientApp")`;
}

export async function deploy(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  // Which deployment: refused before anything else when product.ts has several and none is named.
  const environment = chooseEnvironment(product, str(flags, "env"));
  const envLabel = environment ? ` (${environment})` : "";
  const web = clientWeb(product, environment);
  // Checked first: a failure stops the deploy before anything in the account changes.
  if (!(await checkOrgExtensions(root, io))) {
    io.err("An extension in extensions/ failed cos ext check: nothing was deployed.");
    return 1;
  }
  const errors = flags["no-typecheck"] ? [] : await typeErrors(root, product);
  if (errors.length) {
    for (const e of errors) io.err(e);
    io.err("The apps have type errors: nothing was deployed.");
    return 1;
  }
  // The web app is built and checked before the host is touched.
  const built =
    product.web && product.web.deploy !== "own" ? buildWeb(root, product, flags, io) : null;
  io.out(
    `Checked: ${orgExtensionDirs(root).length} extension(s) with cos ext check${flags["no-typecheck"] ? "" : ", the apps' types"}.`,
  );
  const release = releaseProduct(deps, product.platform.release);
  const own = orgExtensionSources(root);
  for (const extension of own) {
    if (product.packs.includes(extension.id)) {
      throw new CliError(`extensions/${extension.id} has the id of a pack this product lists.`);
    }
  }
  const ownBytes = new TextEncoder().encode(JSON.stringify({ extensions: own }));
  const ownHash = own.length ? await sha256Hex(ownBytes) : "";
  const envSettings = environment ? product.environments?.[environment] : undefined;
  const hostFlags: Flags = {
    ...flags,
    product: release.id,
    repo: product.platform.repository,
    version: product.platform.version,
    yes: flags.yes ?? true,
    packs: product.packs.join(","),
    "org-extensions": ownHash,
    ...(envSettings?.hostname && !str(flags, "hostname") ? { hostname: envSettings.hostname } : {}),
  };
  const scoped: Deps = {
    ...deps,
    products: { all: { [release.id]: release }, default: release.id },
  };
  // Checks the release's packs against the product's before anything changes: the packs the
  // release carries are its client kit's packs.json, and nothing else (ADR 0422 as amended).
  const source = releaseSource(hostFlags, scoped, release);
  const { bundle } = await verified(source, product.platform.version, scoped);
  const manifest = bundle.manifest;
  const inRelease = kitPacks(bundle.clientFiles);
  // A listed pack brings the packs it requires (Courses: Programs and Content): the host installs
  // them too, as the pack cannot install without them.
  const brought = requiredPacks(bundle.clientFiles, product.packs);
  const missing = [...product.packs, ...brought].filter((pack) => !inRelease.has(pack));
  if (missing.length) {
    io.err(
      `${release.label} ${product.platform.version} does not carry the pack${missing.length > 1 ? "s" : ""} ${missing.join(", ")} that product.ts lists${brought.some((p) => missing.includes(p)) ? " or its packs require" : ""} (it carries ${[...inRelease].sort().join(", ") || "none"}): the platform needs it in a release first. Nothing was deployed.`,
    );
    return 1;
  }
  if (brought.length) {
    hostFlags.packs = [...product.packs, ...brought].join(",");
    const them = brought.length > 1 ? "them" : "it";
    io.out(
      `Installing ${brought.join(", ")} too: a pack product.ts lists requires ${them}. Add ${them} to packs in product.ts to say so there.`,
    );
  }
  // The gatekeepers product.ts turns on here and their settings, checked against what each
  // declares in this release before anything changes (ADR 0452).
  const gatekeepers = gatekeeperPlan(manifest, product, environment);
  if ("problem" in gatekeepers) {
    io.err(`${gatekeepers.problem} Nothing was deployed.`);
    return 1;
  }
  if (gatekeepers.workers.length) {
    hostFlags.gatekeepers = gatekeepers.workers.map((w) => w.name).join(",");
    hostFlags["gatekeeper-vars"] = JSON.stringify(gatekeepers.vars);
    if (Object.keys(gatekeepers.sendEmail).length) {
      hostFlags["send-email"] = JSON.stringify(gatekeepers.sendEmail);
    }
  }

  const token = str(flags, "token") ?? deps.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new CliError("A Cloudflare API token is needed: --token or CLOUDFLARE_API_TOKEN.");
  deps.redactor.add(token);
  const api = new CloudflareClient({
    token,
    ...(deps.env.COS_CLOUDFLARE_API ? { apiBase: deps.env.COS_CLOUDFLARE_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  let accountId = str(flags, "account") ?? deps.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await api.listAccounts();
    if (accounts.length !== 1) throw new CliError("Pass --account <id>.");
    accountId = (accounts[0] as { id: string }).id;
  }
  hostFlags.account = accountId;

  // The host's names (issue #155): a first install takes the client product's (derived from its
  // id and, for an environment other than live, the environment's name; or as product.ts says),
  // through the deployment state's name maps, so the verified release is deployed unchanged. A
  // host that exists keeps the names it has: one deployed before client names (under the
  // release's) is found under those and never renamed. Only the live environment (or a product
  // without environments) can be such a host.
  const names = clientNames(product, environment);
  const ownHost = await locateDeployment(api, accountId, names.database);
  const mayBeLegacy = environment === undefined || environment === LIVE_ENVIRONMENT;
  const legacyHost =
    ownHost?.state || !mayBeLegacy
      ? null
      : await locateDeployment(api, accountId, release.names.database);
  const database = legacyHost?.state ? release.names.database : names.database;
  hostFlags.database = database;
  hostFlags.label = product.label;
  if (!ownHost?.state && !legacyHost?.state) {
    hostFlags.names = JSON.stringify(clientNameMaps(release, names, manifest));
  }
  const deployedWorker = (name: string) =>
    (ownHost?.state ?? legacyHost?.state)?.workerNames[name] ??
    (legacyHost?.state ? name : (clientNameMaps(release, names, manifest).workers[name] ?? name));
  const hostWorker = deployedWorker(appWorker(manifest));

  // Customer sign-in on the web app's hostname (ADR 0421): the host is told the web app's
  // origin, and makes its own customer secret once. A product with no web app gets neither.
  let webOrigin: string | undefined;
  if (web) {
    webOrigin = web.hostname
      ? `https://${web.hostname}`
      : `https://${web.worker}.${(await api.workersSubdomain(accountId)) ?? "<subdomain>"}.workers.dev`;
    hostFlags["customer-auth-url"] = webOrigin;
  }

  // Staff sign in through the system browser (ADRs 0451, 0455, 0457): the host sends a sign-in
  // back only to the platform's command-line door on this computer and, with a mobile app, to
  // this environment's app redirect. Set on every deploy, so the list is always the product's.
  hostFlags["native-redirect-uris"] = nativeRedirectUris(product, environment);

  // Where the host's database and buckets are made (ADR 0580): product.ts's location hint, sent
  // only when they are created at the first install. A host that exists is never moved: the
  // install step says so when product.ts names a hint other than the one it was made with. Always
  // passed, so a client host's location is product.ts's and the installer never asks.
  hostFlags.location = clientLocation(product, environment) ?? "none";
  const found = ownHost?.state ? ownHost : legacyHost;

  // The host: install, upgrade to the product's version, or repair; vars set for the product.
  if (found?.state && found.state.version !== product.platform.version) {
    io.out(
      `The host${envLabel} is on ${found.state.version}; moving it to ${product.platform.version}.`,
    );
    // The install step below speaks for the location; the upgrade does not repeat it.
    const { location: _location, ...upgradeFlags } = hostFlags;
    const code = await upgradeHost(upgradeFlags, scoped);
    if (code !== 0) return code;
  }
  const code = await install(hostFlags, scoped);
  if (code !== 0) return code;

  // The org's own extensions, pinned by hash: the runner installs them as shipped.
  if (own.length) {
    const located = await locateDeployment(api, accountId, database);
    if (!located?.state) throw new CliError("The host's deployment state is missing.");
    const bucket = blobsBucket(manifest, located.state);
    await api.putR2Object(accountId, bucket, `org-extensions/${ownHash}.json`, ownBytes);
    io.out(`Org extensions: ${own.map((e) => e.id).join(", ")} (${ownHash.slice(0, 12)}…)`);
  }

  // The gatekeepers' secrets: set by a person, never by product.ts. Which are missing, and how.
  // A generated one (FAKE_WEBHOOK_SECRET, made by the deploy when it is needed) is not a person's.
  for (const worker of gatekeepers.workers) {
    const deployedAs = deployedWorker(worker.name);
    const set = await api.listSecrets(accountId, deployedAs);
    const missing = (worker.secrets ?? []).filter(
      (s) => s.source !== "generated" && !set.includes(s.name),
    );
    if (!missing.length) continue;
    io.out(`\n${deployedAs} has no ${missing.map((s) => s.name).join(", ")}. A person sets each:`);
    for (const secret of missing) {
      io.out(
        `  npx wrangler secret put ${secret.name} --name ${deployedAs}${secret.description ? `\n    (${secret.description})` : ""}`,
      );
    }
  }

  if (built && web) {
    const url = await deployWeb(api, accountId, web, hostWorker, built);
    io.out(`Web app${envLabel}: ${url}, bound to ${hostWorker} (ClientApp).`);
  } else if (product.web?.deploy === "own" && web) {
    io.out(
      `Web app${envLabel}: ${product.web.dir} deploys itself (web.deploy "own"): deploy it as you do today.\n` +
        `  Its Worker (${web.worker})${environment ? ` in its ${environment} environment` : ""} needs this service binding, now that the host exists:\n` +
        `    ${hostBindingText(hostWorker, environment)}\n` +
        `  HOST's target is ${hostWorker}, entrypoint ClientApp. Customer sign-in expects the site at ${webOrigin}.`,
    );
  }
  io.out(
    `\nThe host's staff admin${envLabel}: ${hostWorker}'s address (printed above); open /setup there to create the first admin. Then a human admin, in Settings → Users, chooses the host's mail connection and turns on "Send sign-in codes without review" for it: until then sign-in by code (customers and staff) answers that it is not set up. cos deploy does not do this step.`,
  );
  io.out(`\n${edgeRuleStep(product)}`);
  return 0;
}

// ---- cos upgrade (in a client repo) ---------------------------------------------------------------

export async function upgradeRepo(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  const { kit, version, manifest } = await fetchKit(
    flags,
    deps,
    product.platform.release,
    product.platform.repository,
    str(flags, "version"),
  );
  if (version === product.platform.version) {
    // Compared by content: a kit rebuilt at the same version can still change the host modules.
    io.out(`Already on ${version}. Checking the host modules against its template.`);
    upgradeHostModules(root, product, kit, version, io);
    const { rewriteAccountSections } = await import("./blocks.ts");
    rewriteAccountSections(root, product, kit, version, io);
    // And the packages: run again after installing, this is where the type check happens.
    return packagesAndTypes(root, product, version, io);
  }
  io.out(`Moving from ${product.platform.version} to ${version}.`);
  // The updater's preflight for the org's extensions: the new host must speak their contract.
  const { CONTRACT_VERSION } = await import("@composable-os/sdk");
  if (
    orgExtensionDirs(root).length &&
    !manifest.extensionContract.supported.includes(CONTRACT_VERSION)
  ) {
    io.err(
      `${version} does not support extension contract ${CONTRACT_VERSION}, which extensions/ is written against: nothing changed.`,
    );
    return 1;
  }
  const missing = product.packs.filter((pack) => !kitPacks(kit).has(pack));
  if (missing.length) {
    io.err(`${version} has no pack ${missing.join(", ")}: nothing changed.`);
    return 1;
  }
  setPlatformVersion(root, version);
  const moved = await loadClientProduct(root);
  await generateClients(root, moved, kit, io);
  io.out(`Skills: ${writeSkills(root, kit)} replaced.`);
  // My account's section wiring, from the new release's packs (ADR 0710). Loaded late: blocks.ts
  // imports this file.
  const { rewriteAccountSections } = await import("./blocks.ts");
  rewriteAccountSections(root, moved, kit, version, io);
  // The host modules: unedited ones replaced, edited ones shown as a diff (ADR 0451).
  upgradeHostModules(root, moved, kit, version, io);
  return packagesAndTypes(root, moved, version, io);
}

/**
 * Moves the repo's `@composable-os/*` dependencies to `version`, then type-checks the apps, but
 * only against packages installed at `version`: against the old ones a check would pass while
 * copied blocks no longer compile (issue #177). cos never installs; it says what to run.
 */
async function packagesAndTypes(
  root: string,
  product: ClientProductDefinition,
  version: string,
  io: Io,
): Promise<number> {
  const { moved, left } = movePlatformVersions(root, product, version);
  if (moved.length) io.out(`\nPackages moved to ${version}:\n  ${moved.join("\n  ")}`);
  if (left.length) {
    io.out(
      `\nLeft as they are (not a version cos can safely rewrite: a tarball, a path, a workspace, a tag). Point them at ${version} yourself:\n  ${left.join("\n  ")}`,
    );
  }
  const stale = staleInstalls(root, product, version);
  if (stale.length) {
    io.out(
      `\nThe type check was skipped: ${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} not installed at ${version}, so it would check the apps against the old packages. Install, then run cos upgrade again to type-check:\n  ${installAll(root)}\n  pnpm cos upgrade`,
    );
    io.out(`\nOn ${version}, not yet type-checked. Nothing is deployed.`);
    return 0;
  }
  const errors = await typeErrors(root, product);
  if (errors.length) {
    io.err(`\nThe apps do not compile against ${version}. Fix these, then cos deploy:`);
    for (const e of errors) io.err(`  ${e}`);
    io.err("Nothing was deployed.");
    return 1;
  }
  io.out(
    `\nUpgraded to ${version}; the apps type-check against it. Nothing is deployed yet: run cos deploy.`,
  );
  return 0;
}

/**
 * The packs a release carries: its client kit's `packs.json`, and nothing else. The release's API
 * contract is the union over every pack in the repository it was built from, so a tool named in it
 * says nothing about what the release's runner bundles; packs.json is written from the same list
 * the runner's bundle is (ADR 0422 as amended). A kit without it carries none.
 */
export function kitPacks(kit: ClientKit): Set<string> {
  const listed = kit.get("packs.json");
  if (!listed) return new Set();
  return new Set(JSON.parse(decode(listed)) as string[]);
}

/**
 * The packs a product's packs require and it does not list, from the release's roles.json (each
 * pack's `requires`, ADR 0478), followed to the end: Courses brings Programs and Content. A kit
 * older than the list brings none.
 */
export function requiredPacks(kit: ClientKit, packs: readonly string[]): string[] {
  const file = kit.get(`${KIT.contract}roles.json`);
  const requires = file
    ? ((JSON.parse(decode(file)) as { requires?: Record<string, string[]> }).requires ?? {})
    : {};
  const brought: string[] = [];
  const visit = (pack: string) => {
    for (const needed of requires[pack] ?? []) {
      if (packs.includes(needed) || brought.includes(needed)) continue;
      brought.push(needed);
      visit(needed);
    }
  };
  for (const pack of packs) visit(pack);
  return brought;
}

/** `cos client generate` in a client repo: each app's typed client from its release, again. */
export async function regenerate(flags: Flags, deps: Deps): Promise<number> {
  const root = resolve(str(flags, "dir") ?? process.cwd());
  const product = await loadClientProduct(root);
  const { kit } = await fetchKit(
    flags,
    deps,
    product.platform.release,
    product.platform.repository,
    product.platform.version,
  );
  const written = await generateClients(root, product, kit, deps.io);
  if (!written.length) deps.io.out("product.ts names no app: nothing to generate.");
  return 0;
}

/** True when the repo the command runs in is a client repo (its product.ts is a client product). */
export function isClientRepo(dir: string): boolean {
  const file = join(dir, "product.ts");
  return existsSync(file) && readFileSync(file, "utf8").includes("defineClientProduct");
}
