#!/usr/bin/env node
// Deploys, or removes, the proof of stage 66 (docs/deploying.md, "Proving a client's database on
// Cloudflare"): two Workers and a D1 database. Run by .github/workflows/client-db-proof.yml, by hand
// only. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (never printed).
// COS_PRODUCT picks the product whose names are used (default: products/active.ts).
//
//   node scripts/deploy.mjs            deploy (needs PROOF_KEY; LOCATION_HINT, default oc)
//   node scripts/deploy.mjs --remove   delete both Workers and the D1 database, by exact name
//
// The names, from the product (for the CRM):
//   crm-client-db-proof      the proof Worker (apps/client-db-proof), on workers.dev
//   crm-client-db-proof-db   the Worker that holds the clients' databases: apps/client-db, the
//                            same code as the host's `cos-client-db`, under the proof's own name, so
//                            the proof never deploys over, or removes, a real host's Worker
//   crm-client-db-proof      the D1 database
//
// Deploy:
// 1. The D1 database of exactly its name is found, or created with the location hint.
// 2. apps/client-db is deployed first as crm-client-db-proof-db (its class `ClientDb`, migration
//    tag v1, a fresh namespace of its own), since the proof Worker binds it by script name.
// 3. The proof Worker is deployed, its bindings pointed at crm-client-db-proof-db. Its migration
//    v2 deletes the `ClientDb` class step 1's proof exported itself, with every object of it (the
//    earlier runs' seeded databases; nothing else was ever in them).
// 4. PROOF_KEY is set as the proof Worker's secret.
// 5. Each Worker's "Worker Startup Time" and upload size, from wrangler's output, are written to
//    PROOF_DEPLOY_FILE for the run's summary: the cold start of a client's database is the
//    startup of the Worker its class is in.
// 6. The proof Worker's URL names the account's workers.dev subdomain, and the repository is
//    public: it is masked in the Actions log before wrangler's output is printed, never printed by
//    this script, and written only to PROOF_URL_FILE for the next step.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const clientDbDir = fileURLToPath(new URL("../../client-db/", import.meta.url));
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
const LOCAL_DB_WORKER = "cos-client-db-proof-db";
const name = deployedName(product, LOCAL);
const dbWorker = deployedName(product, LOCAL_DB_WORKER);
if (!/^[a-z0-9-]+-client-db-proof$/.test(name)) throw new Error(`unexpected proof name ${name}`);
if (dbWorker !== `${name}-db`) throw new Error(`unexpected database Worker name ${dbWorker}`);

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

/** Masks every workers.dev address in `text`, and the account's subdomain in it. */
function maskAddresses(text) {
  for (const host of text.match(/[a-z0-9.-]+\.workers\.dev/g) ?? []) {
    mask(host);
    mask(`https://${host}`);
    const subdomain = host.split(".").slice(1, -2).join(".");
    if (subdomain) mask(subdomain);
  }
}

/** Deletes the Worker named exactly `worker`; true when it is gone. */
function deleteWorker(worker) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "delete", worker], {
    cwd: here,
    encoding: "utf8",
    input: "y\n",
  });
  const said = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  maskAddresses(said);
  process.stdout.write(said);
  if (result.status !== 0)
    console.log(`The Worker ${worker} was not deleted (exit ${result.status}).`);
  return result.status === 0;
}

if (remove) {
  console.log(
    `Removing the proof: the Workers ${name} and ${dbWorker}, and the D1 database ${name}, by exact name`,
  );
  // The proof Worker first: it binds the other by script name.
  const proofGone = deleteWorker(name);
  const dbGone = deleteWorker(dbWorker);
  if (findDatabase()) {
    wrangler(["d1", "delete", name, "--skip-confirmation"], { stdio: "inherit" });
  } else {
    console.log(`No D1 database named ${name}.`);
  }
  process.exit(proofGone && dbGone ? 0 : 1);
}

const location = process.env.LOCATION_HINT || "oc";
if (!Object.hasOwn(LOCATION_HINTS, location)) {
  throw new Error(`LOCATION_HINT must be one of ${Object.keys(LOCATION_HINTS).join(", ")}`);
}
console.log(
  `Product ${product.id}: Workers ${dbWorker} then ${name}, D1 database ${name}, location hint ${location}`,
);

let database = findDatabase();
if (!database) {
  wrangler(["d1", "create", name, "--location", location], { stdio: "inherit" });
  database = findDatabase();
}
if (!database?.uuid) throw new Error(`could not find or create the D1 database ${name}`);

/** A wrangler.jsonc whose comments are whole lines; the rest is JSON. */
const readConfig = (path) =>
  JSON.parse(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );

/** Deploys the config in `dir` (wrangler.deploy.jsonc, gitignored), returning wrangler's output. */
function deploy(dir, config) {
  delete config.$schema;
  writeFileSync(`${dir}/wrangler.deploy.jsonc`, `${JSON.stringify(config, null, 2)}\n`);
  const result = spawnSync("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.deploy.jsonc"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  maskAddresses(output);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
  return output;
}

/** What wrangler said about a Worker's startup and size. */
function report(worker, output) {
  const startup =
    /Worker Startup Time:\s*([\d.]+\s*ms)/i.exec(output)?.[1] ?? "not printed by wrangler";
  const upload = /Total Upload:\s*([^\n]+)/i.exec(output)?.[1]?.trim() ?? "not printed by wrangler";
  return `${worker}: Worker Startup Time ${startup}; Total Upload ${upload}`;
}

// 2. The Worker that holds the clients' databases, first.
const dbConfig = readConfig(`${clientDbDir}/wrangler.jsonc`);
dbConfig.name = dbWorker;
const dbOutput = deploy(clientDbDir, dbConfig);

// 3. The proof Worker, bound to it by script name.
const config = readConfig(`${here}/wrangler.jsonc`);
config.name = name;
config.vars = { ...config.vars, LOCATION_HINT: location };
config.d1_databases = config.d1_databases.map((db) =>
  db.binding === "DB" ? { ...db, database_name: name, database_id: database.uuid } : db,
);
config.services = config.services.map((service) =>
  service.service === LOCAL_DB_WORKER ? { ...service, service: dbWorker } : service,
);
config.durable_objects.bindings = config.durable_objects.bindings.map((binding) =>
  binding.script_name === LOCAL_DB_WORKER ? { ...binding, script_name: dbWorker } : binding,
);
const output = deploy(here, config);
const url = new RegExp(`https://${name}\\.[a-z0-9.-]+\\.workers\\.dev`).exec(output)?.[0];
if (!url) throw new Error("deployed, but wrangler printed no workers.dev address");

// 4. The run's key.
const secret = spawnSync(
  "pnpm",
  ["exec", "wrangler", "secret", "put", "PROOF_KEY", "-c", "wrangler.deploy.jsonc"],
  { cwd: here, input: process.env.PROOF_KEY, encoding: "utf8" },
);
if (secret.status !== 0) {
  process.stderr.write(secret.stderr ?? "");
  process.exit(secret.status ?? 1);
}

// 5. What the summary shows of the deploy.
const deployed = [report(dbWorker, dbOutput), report(name, output)].join("\n");
console.log(deployed);
if (process.env.PROOF_DEPLOY_FILE) writeFileSync(process.env.PROOF_DEPLOY_FILE, `${deployed}\n`);

console.log("Deployed; the address is masked and passed to the next step.");
if (process.env.PROOF_URL_FILE) writeFileSync(process.env.PROOF_URL_FILE, url);
