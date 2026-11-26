#!/usr/bin/env node
// Deploys the proof Worker of stage 66 step 1 (docs/deploying.md, "Proving a client's database on
// Cloudflare"). Run by .github/workflows/client-db-proof.yml, by hand only. Needs
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (never printed) and PROOF_KEY,
// the key the Worker will ask for. COS_PRODUCT picks the product whose names are used (default:
// products/active.ts); LOCATION_HINT where the databases are created (default oc).
//
// 1. Names: cos-client-db-proof becomes the product's (`crm-client-db-proof` for the CRM).
// 2. The D1 database of that name is found, or created with the location hint.
// 3. wrangler.deploy.jsonc (gitignored) is written from wrangler.jsonc with those names and the
//    database's id, and deployed. The Worker's URL is printed (and written to $GITHUB_OUTPUT).
// 4. PROOF_KEY is set as the Worker's secret.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PROOF_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set; nothing deployed.`);
    process.exit(1);
  }
}

const { deployedName, defineProduct } = await import(
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
const location = process.env.LOCATION_HINT || "oc";
console.log(`Product ${product.id}: Worker and D1 database ${name}, location hint ${location}`);

const wrangler = (args, options = {}) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: here, encoding: "utf8", ...options });

function findDatabase() {
  const list = JSON.parse(wrangler(["d1", "list", "--json"]));
  return list.find((db) => db.name === name) ?? null;
}
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
process.stdout.write(deployed.stdout ?? "");
process.stderr.write(deployed.stderr ?? "");
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
const url = /https:\/\/\S+\.workers\.dev/.exec(deployed.stdout ?? "")?.[0];

const secret = spawnSync(
  "pnpm",
  ["exec", "wrangler", "secret", "put", "PROOF_KEY", "-c", "wrangler.deploy.jsonc"],
  { cwd: here, input: process.env.PROOF_KEY, encoding: "utf8" },
);
if (secret.status !== 0) {
  process.stderr.write(secret.stderr ?? "");
  process.exit(secret.status ?? 1);
}

if (!url) throw new Error("deployed, but wrangler printed no workers.dev address");
console.log(`Deployed: ${url}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
