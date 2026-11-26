#!/usr/bin/env node
// Deploys, or removes, the proof Worker of stage 66 step 1 (docs/deploying.md, "Proving a
// client's database on Cloudflare"). Run by .github/workflows/client-db-proof.yml, by hand only.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (never printed).
// COS_PRODUCT picks the product whose names are used (default: products/active.ts).
//
//   node scripts/deploy.mjs            deploy (needs PROOF_KEY; LOCATION_HINT, default oc)
//   node scripts/deploy.mjs --remove   delete the proof's own Worker and D1 database, by exact name
//
// Deploy:
// 1. Names: cos-client-db-proof becomes the product's (`crm-client-db-proof` for the CRM).
// 2. The D1 database of exactly that name is found, or created with the location hint.
// 3. wrangler.deploy.jsonc (gitignored) is written from wrangler.jsonc with those names and the
//    database's id, and deployed.
// 4. PROOF_KEY is set as the Worker's secret.
// 5. The Worker's URL names the account's workers.dev subdomain, and the repository is public: it
//    is masked in the Actions log before wrangler's output is printed, never printed by this
//    script, and written only to PROOF_URL_FILE for the next step.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const remove = process.argv.includes("--remove");
for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  ...(remove ? [] : ["PROOF_KEY"]),
]) {
  if (!process.env[name]) {
    console.error(`${name} is not set; nothing done.`);
    process.exit(1);
  }
}

const { deployedName, defineProduct, LOCATION_HINTS } = await import(
  pathToFileURL(fileURLToPath(new URL("../../../packages/product/src/index.ts", import.meta.url)))
    .href
);
const { chosenProductFile } = await import(
  pathToFileURL(fileURLToPath(new URL("../../../packages/product/src/node.ts", import.meta.url)))
    .href
);
const productModule =
  chosenProductFile() ?? fileURLToPath(new URL("../../../products/active.ts", import.meta.url));
const product = defineProduct((await import(pathToFileURL(productModule).href)).product);

const LOCAL = "cos-client-db-proof";
const name = deployedName(product, LOCAL);
if (!/^[a-z0-9-]+-client-db-proof$/.test(name)) throw new Error(`unexpected proof name ${name}`);

const wrangler = (args, options = {}) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: here, encoding: "utf8", ...options });

/** The D1 database named exactly `name`, or null. */
function findDatabase() {
  const list = JSON.parse(wrangler(["d1", "list", "--json"]));
  return list.find((db) => db.name === name) ?? null;
}

/** Masks a value in the GitHub Actions log from here on. */
function mask(value) {
  if (process.env.GITHUB_ACTIONS === "true" && value) console.log(`::add-mask::${value}`);
}

if (remove) {
  console.log(`Removing the proof's Worker and D1 database, both named exactly ${name}`);
  const worker = spawnSync("pnpm", ["exec", "wrangler", "delete", name], {
    cwd: here,
    encoding: "utf8",
    input: "y\n",
  });
  const said = `${worker.stdout ?? ""}${worker.stderr ?? ""}`;
  // wrangler names the Worker's URL in some messages: mask anything on workers.dev first.
  for (const host of said.match(/[a-z0-9.-]+\.workers\.dev/g) ?? []) mask(host);
  process.stdout.write(said);
  if (worker.status !== 0) console.log(`The Worker was not deleted (exit ${worker.status}).`);
  if (findDatabase()) {
    wrangler(["d1", "delete", name, "--skip-confirmation"], { stdio: "inherit" });
  } else {
    console.log(`No D1 database named ${name}.`);
  }
  process.exit(worker.status === 0 ? 0 : 1);
}

const location = process.env.LOCATION_HINT || "oc";
if (!Object.hasOwn(LOCATION_HINTS, location)) {
  throw new Error(`LOCATION_HINT must be one of ${Object.keys(LOCATION_HINTS).join(", ")}`);
}
console.log(`Product ${product.id}: Worker and D1 database ${name}, location hint ${location}`);

let database = findDatabase();
if (!database) {
  wrangler(["d1", "create", name, "--location", location], { stdio: "inherit" });
  database = findDatabase();
}
if (!database?.uuid) throw new Error(`could not find or create the D1 database ${name}`);

// wrangler.jsonc's comments are whole lines; the rest is JSON.
const config = JSON.parse(
  readFileSync(`${here}/wrangler.jsonc`, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);
config.name = name;
config.vars = { ...config.vars, LOCATION_HINT: location };
config.d1_databases = config.d1_databases.map((db) =>
  db.binding === "DB" ? { ...db, database_name: name, database_id: database.uuid } : db,
);
delete config.$schema;
writeFileSync(`${here}/wrangler.deploy.jsonc`, `${JSON.stringify(config, null, 2)}\n`);

const deployed = spawnSync("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.deploy.jsonc"], {
  cwd: here,
  encoding: "utf8",
});
const output = `${deployed.stdout ?? ""}\n${deployed.stderr ?? ""}`;
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
if (url) {
  const host = new URL(url).hostname;
  mask(url);
  mask(host);
  // The account's own subdomain, alone: `<worker>.<subdomain>.workers.dev`.
  mask(host.split(".").slice(1, -2).join("."));
}
for (const other of output.match(/[a-z0-9.-]+\.workers\.dev/g) ?? []) mask(other);
process.stdout.write(deployed.stdout ?? "");
process.stderr.write(deployed.stderr ?? "");
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
if (!url) throw new Error("deployed, but wrangler printed no workers.dev address");

const secret = spawnSync(
  "pnpm",
  ["exec", "wrangler", "secret", "put", "PROOF_KEY", "-c", "wrangler.deploy.jsonc"],
  { cwd: here, input: process.env.PROOF_KEY, encoding: "utf8" },
);
if (secret.status !== 0) {
  process.stderr.write(secret.stderr ?? "");
  process.exit(secret.status ?? 1);
}

console.log("Deployed; the address is masked and passed to the next step.");
if (process.env.PROOF_URL_FILE) writeFileSync(process.env.PROOF_URL_FILE, url);
