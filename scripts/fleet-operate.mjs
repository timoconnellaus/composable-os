#!/usr/bin/env node
// The operator's commands against a REAL host of many clients, from GitHub Actions only
// (.github/workflows/fleet-operate.yml; docs/deploying.md, "Operating a host of many clients from
// GitHub"): nobody holds the fleet's Cloudflare token or its keys file on a laptop.
//
//   node scripts/fleet-operate.mjs validate    the dispatch's inputs, checked; no secret is read
//   node scripts/fleet-operate.mjs run         the one command they name, through the built cos
//
// Every input arrives as an environment variable (`OP_*`), never in a shell line, and is checked
// against a strict pattern before anything else. The command is one of a fixed list, and each maps
// to fixed `cos` arguments: no free-form command line. Where a command has a dry run it is the
// default; a command that removes, overwrites, or vouches for something (and an upgrade of live)
// gets `--yes` only when `OP_CONFIRM` is the client's id (or the version). A command with no dry
// run is only planned (printed, not run) while `OP_DRY_RUN` is true.
//
// The fleet's keys file (FLEET_KEYS, base64, an environment secret) is written only for `fleet
// install` and `fleet upgrade`, to a 0600 file in a 0700 temporary folder outside the checkout,
// and deleted when the command ends, on an error, and on SIGINT and SIGTERM. A client's secret
// value (SECRET_VALUE, from the environment secret CLIENT_<ID>_<NAME>) goes to cos the same way,
// with `--value-file`. Nothing here prints either; the job summary and the log have the token, the
// account id, its workers.dev subdomain, the keys and the value cut out.
//
// It operates the repository's product only (cos's default, never `--product-file`), always from a
// published, attested release (never `--bundle-dir` or `--unverified`), and refuses anything that
// names the staging check's throwaway prefix (`cosstg-`): the staging check and this never meet.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = process.env;

/** The staging check's throwaway prefix (scripts/fleet-staging-check.mjs): never operated here. */
export const THROWAWAY = "cosstg";

const LOCATIONS = ["oc", "apac", "wnam", "enam", "weur", "eeur"];
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-beta\.\d{1,4})?$/;
const CLIENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SETTING_VALUE = /^[A-Za-z0-9,._:/@+-]{0,512}$/;

/**
 * Every command offered, and how it maps to cos. `dry`: `flag` (cos takes `--dry-run`), `read`
 * (changes nothing), `none` (no dry run: only planned while dry_run is on). `confirm`: what
 * `OP_CONFIRM` must be for cos to get `--yes` (null: never given `--yes` by this workflow, except
 * a staging upgrade, which needs it to run at all). `needs`: a word cos's own help must show (a
 * command that arrives with a later PR is refused, with that said, until cos has it).
 */
export const COMMANDS = Object.freeze({
  "fleet-install": { dry: "none", keys: true, fields: ["version", "domain", "callback"] },
  "fleet-upgrade": { dry: "flag", keys: true, fields: ["version"], confirm: upgradeConfirm },
  "client-list": { dry: "read", fields: [] },
  "client-add": { dry: "flag", fields: ["client"] },
  "client-pause": {
    dry: "flag",
    fields: ["client"],
    confirm: (i) => (i.env === "live" ? i.client : null),
  },
  "client-resume": { dry: "flag", fields: ["client"] },
  "client-secret-set": {
    dry: "flag",
    fields: ["client", "secretName"],
    secret: true,
    confirm: (i) => i.client,
    optionalConfirm: true,
  },
  "client-secret-remove": {
    dry: "flag",
    fields: ["client", "secretName"],
    confirm: (i) => i.client,
  },
  "client-export": { dry: "flag", fields: ["client"] },
  "client-remove": { dry: "flag", fields: ["client"], confirm: (i) => i.client },
  "sender-add": { dry: "flag", fields: ["client", "senderDomain"] },
  "sender-verify": { dry: "flag", fields: ["client", "senderDomain"], confirm: (i) => i.client },
  "sender-unverify": { dry: "flag", fields: ["client", "senderDomain"], confirm: (i) => i.client },
  "sender-remove": { dry: "flag", fields: ["client", "senderDomain"], confirm: (i) => i.client },
  "hostname-add": { dry: "flag", fields: ["client", "hostname"], needs: "cos client hostname" },
  "hostname-verify": { dry: "flag", fields: ["client", "hostname"], needs: "cos client hostname" },
  "hostname-remove": {
    dry: "flag",
    fields: ["client", "hostname"],
    confirm: (i) => i.client,
    needs: "cos client hostname",
  },
  "hostname-list": { dry: "read", fields: ["client"], needs: "cos client hostname" },
});

function upgradeConfirm(i) {
  return i.env === "live" ? i.version : null;
}

export class InputError extends Error {}

const words = (s) => String(s ?? "").trim();
const bool = (s, fallback) => {
  const v = words(s).toLowerCase();
  if (v === "") return fallback;
  if (v === "true" || v === "false") return v === "true";
  throw new InputError("a yes/no input is true or false");
};

/**
 * The dispatch's inputs from the environment, every one checked; throws an InputError naming each
 * problem. Pure: reads only `env`. `knownSettings` and `isSecretName` are the registry's own rules.
 */
export function readInputs(env, { knownSettings, isSecretName, clientIdProblem }) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const i = {
    env: words(env.OP_ENV),
    command: words(env.OP_COMMAND),
    client: words(env.OP_CLIENT),
    version: words(env.OP_VERSION),
    domain: words(env.OP_DOMAIN).toLowerCase(),
    callback: words(env.OP_CALLBACK_HOSTNAME).toLowerCase(),
    zone: words(env.OP_ZONE).toLowerCase(),
    location: words(env.OP_LOCATION),
    ai: words(env.OP_AI) || "as-installed",
    settings: [],
    hostname: words(env.OP_HOSTNAME).toLowerCase(),
    senderDomain: words(env.OP_SENDER_DOMAIN).toLowerCase(),
    secretName: words(env.OP_SECRET_NAME),
    confirm: words(env.OP_CONFIRM),
    dryRun: true,
    takeOver: false,
  };
  try {
    i.dryRun = bool(env.OP_DRY_RUN, true);
    i.takeOver = bool(env.OP_TAKE_OVER, false);
  } catch (error) {
    fail(error.message);
  }
  if (i.env !== "staging" && i.env !== "live") fail("env is staging or live");
  const command = COMMANDS[i.command];
  if (!command) fail(`command is one of ${Object.keys(COMMANDS).join(", ")}`);
  const need = new Set(command?.fields ?? []);
  const check = (field, ok, what) => {
    const value = i[field];
    if (need.has(field) && !value) fail(`${what} is needed for ${i.command}`);
    else if (value && !ok(value)) fail(`${what} is not valid`);
    else if (value && !need.has(field) && field !== "location" && field !== "zone") {
      fail(`${what} is not taken by ${i.command}`);
    }
  };
  check("client", (v) => CLIENT.test(v) && !clientIdProblem(v), "client");
  check("version", (v) => VERSION.test(v), "version (x.y.z or x.y.z-beta.n)");
  check("domain", (v) => HOSTNAME.test(v), "domain");
  check("callback", (v) => HOSTNAME.test(v), "callback_hostname");
  check("hostname", (v) => HOSTNAME.test(v), "hostname");
  check("senderDomain", (v) => HOSTNAME.test(v), "sender_domain");
  check("secretName", (v) => isSecretName(v), "secret_name (a given secret's name)");
  if (i.zone && !HOSTNAME.test(i.zone)) fail("zone is not valid");
  if (i.zone && i.command !== "fleet-install") fail(`zone is not taken by ${i.command}`);
  if (i.location && !LOCATIONS.includes(i.location))
    fail(`location is one of ${LOCATIONS.join(", ")}`);
  if (i.location && i.command !== "fleet-install" && i.command !== "client-add") {
    fail(`location is not taken by ${i.command}`);
  }
  if (!["on", "off", "as-installed"].includes(i.ai)) fail("ai is on, off or as-installed");
  if (i.confirm && !/^[a-z0-9.-]{1,64}$/.test(i.confirm)) fail("confirm is not valid");
  for (const pair of words(env.OP_SETTINGS).split(/\s+/).filter(Boolean)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(pair);
    if (!m || !knownSettings.includes(m[1]) || !SETTING_VALUE.test(m[2])) {
      fail(
        `setting ${pair.split("=")[0]} is not NAME=VALUE with a client setting's name (${knownSettings.join(", ")})`,
      );
    } else i.settings.push(`${m[1]}=${m[2]}`);
  }
  if (i.settings.length && i.command !== "client-add")
    fail(`settings are not taken by ${i.command}`);
  // The secret's environment secret is CLIENT_<ID>_<NAME>: a name has no hyphen.
  if (i.command === "client-secret-set" && i.client.includes("-")) {
    fail(
      "client-secret-set needs a client id without a hyphen (its value is the environment secret CLIENT_<ID>_<NAME>)",
    );
  }
  // The staging check's throwaway names are never operated here (and it never operates these).
  for (const [field, value] of Object.entries(i)) {
    if (typeof value === "string" && value.toLowerCase().includes(THROWAWAY)) {
      fail(
        `${field} names the staging check's throwaway prefix (${THROWAWAY}-): never operated here`,
      );
    }
  }
  if (problems.length) throw new InputError(problems.join("; "));
  return i;
}

/** Refuses a product that is, or names, the staging check's throwaway one. */
export function checkProduct(product) {
  const names = [product.id, ...Object.values(product.names ?? {})];
  if (names.some((n) => String(n).toLowerCase().startsWith(THROWAWAY))) {
    throw new InputError(
      `the product ${product.id} is the staging check's throwaway kind: never operated here`,
    );
  }
}

/**
 * What to run: cos's arguments (the keys and value files as placeholders), whether to run or only
 * plan, and why. Pure. Throws an InputError when a confirmation is missing.
 */
export function plan(i) {
  const c = COMMANDS[i.command];
  const id = i.client;
  const base = {
    "fleet-install": () => [
      "fleet",
      "install",
      "--keys-file",
      KEYS,
      "--callback-hostname",
      i.callback,
      "--domain",
      i.domain,
      "--version",
      i.version,
      // At a first install only: a re-run that names it is refused, so as-installed passes none.
      ...(i.ai === "as-installed" ? [] : ["--ai", i.ai]),
      ...(i.location ? ["--location", i.location] : []),
      ...(i.zone ? ["--zone", i.zone] : []),
    ],
    "fleet-upgrade": () => ["fleet", "upgrade", "--keys-file", KEYS, "--version", i.version],
    "client-list": () => ["client", "list"],
    "client-add": () => [
      "client",
      "add",
      id,
      ...(i.location ? ["--location", i.location] : []),
      ...i.settings.flatMap((s) => ["--setting", s]),
    ],
    "client-pause": () => ["client", "pause", id],
    "client-resume": () => ["client", "resume", id],
    "client-secret-set": () => ["client", "secret", "set", id, i.secretName, "--value-file", VALUE],
    "client-secret-remove": () => ["client", "secret", "remove", id, i.secretName],
    // Never `--out` (it writes the client's secrets in plain text) nor `--leaving`: the export
    // stays in the fleet's exports bucket, 90 days.
    "client-export": () => ["client", "export", id],
    "client-remove": () => ["client", "remove", id],
    "sender-add": () => ["client", "sender", "add", id, i.senderDomain],
    "sender-verify": () => ["client", "sender", "verify", id, i.senderDomain],
    "sender-unverify": () => ["client", "sender", "unverify", id, i.senderDomain],
    "sender-remove": () => ["client", "sender", "remove", id, i.senderDomain],
    "hostname-add": () => ["client", "hostname", "add", id, i.hostname],
    "hostname-verify": () => ["client", "hostname", "verify", id, i.hostname],
    "hostname-remove": () => ["client", "hostname", "remove", id, i.hostname],
    "hostname-list": () => ["client", "hostname", "list", id],
  }[i.command]();
  const argv = [...base, "--env", i.env, ...(i.takeOver ? ["--take-over"] : [])];
  if (c.dry === "read") return { argv, run: true, why: "changes nothing" };
  if (i.dryRun) {
    if (c.dry === "none") {
      return {
        argv,
        run: false,
        why: `${i.command} has no dry run: planned only; run it with dry_run false`,
      };
    }
    return { argv: [...argv, "--dry-run"], run: true, why: "dry run: cos changes nothing" };
  }
  const wanted = c.confirm ? c.confirm(i) : null;
  if (wanted !== null && wanted !== undefined) {
    if (i.confirm === wanted)
      return { argv: [...argv, "--yes"], run: true, why: `confirmed (${wanted})` };
    if (!c.optionalConfirm) {
      throw new InputError(
        `${i.command}${i.env === "live" ? " on live" : ""} runs only with confirm set to ${i.command === "fleet-upgrade" ? "the version" : "the client's id"} (${wanted}): nothing was run`,
      );
    }
    // A secret set without confirm: a new value is stored, a stored one is not replaced (cos
    // asks, and with no terminal and no --yes it stops).
    return { argv, run: true, why: "not confirmed: a stored value is not replaced" };
  }
  // A staging upgrade pauses every client: cos asks, so it needs --yes to run at all.
  if (i.command === "fleet-upgrade")
    return { argv: [...argv, "--yes"], run: true, why: "staging upgrade" };
  return { argv, run: true, why: "runs" };
}

/** Placeholders `run` swaps for the real temporary files. */
export const KEYS = "<keys file>";
export const VALUE = "<value file>";

/** Cuts every secret out of a text. */
export function sanitize(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

/**
 * Runs `fn` with temporary files holding `contents` (by name), each 0600 in a fresh 0700 folder
 * under `base`, and deletes the folder when `fn` ends, throws, or the process gets SIGINT or
 * SIGTERM. Returns `fn`'s result.
 */
export async function withSecretFiles(base, contents, fn, proc = process) {
  const names = Object.keys(contents);
  if (!names.length) return fn({});
  const dir = mkdtempSync(join(base, "fleet-operate-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = (signal) => {
    remove();
    proc.exit(signal === "SIGINT" ? 130 : 143);
  };
  proc.once("SIGINT", onSignal);
  proc.once("SIGTERM", onSignal);
  try {
    const paths = {};
    for (const name of names) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], contents[name], { mode: 0o600 });
    }
    return await fn(paths);
  } finally {
    remove();
    proc.removeListener("SIGINT", onSignal);
    proc.removeListener("SIGTERM", onSignal);
  }
}

/** The keys file from FLEET_KEYS (base64 of the JSON `cos fleet keys` wrote), checked. */
export function decodeKeys(base64, env) {
  let text;
  let keys;
  try {
    text = Buffer.from(String(base64).trim(), "base64").toString("utf8");
    keys = JSON.parse(text);
  } catch {
    throw new InputError(
      "FLEET_KEYS is not the base64 of a keys file (base64 -w0 of cos fleet keys' file)",
    );
  }
  if (keys?.environment !== env) {
    throw new InputError(
      `FLEET_KEYS holds ${keys?.environment ?? "no"} environment's keys, not ${env}'s`,
    );
  }
  const values = Object.values(keys).filter((v) => typeof v === "string" && v.length >= 16);
  return { text, values };
}

/**
 * `run`: the command, through `deps.cos(argv, env)` (the built cos). Writes the summary, returns
 * cos's exit code (2 for a refusal before cos).
 */
export async function operate(env, deps) {
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.GITHUB_TOKEN].filter(
    Boolean,
  );
  for (const s of secrets) deps.mask(s);
  const lines = [];
  const say = (line) => {
    const clean = sanitize(line, secrets);
    lines.push(clean);
    deps.log(clean);
  };
  const finish = (code, i, shown, outcome, output = "") => {
    deps.log(sanitize(`Result: ${outcome}`, secrets));
    deps.writeSummary(
      sanitize(
        [
          `## Fleet operation: ${i?.command ?? "?"} on ${i?.env ?? "?"}`,
          "",
          `- by: ${env.GITHUB_ACTOR ?? "?"}`,
          `- client: ${i?.client || "none"}`,
          `- dry run: ${i?.dryRun ?? "?"}`,
          `- cos ${shown ?? "(nothing run)"}`,
          `- result: ${outcome}`,
          ...(output ? ["", "```", output.trimEnd().split("\n").slice(-80).join("\n"), "```"] : []),
        ].join("\n"),
        secrets,
      ),
    );
    return code;
  };
  let i;
  try {
    i = readInputs(env, deps.rules);
    checkProduct(deps.product);
  } catch (error) {
    say(`Refused: ${error.message}`);
    return finish(2, i, null, `refused before cos: ${error.message}`);
  }
  let p;
  try {
    p = plan(i);
  } catch (error) {
    say(`Refused: ${error.message}`);
    return finish(2, i, null, `refused before cos: ${error.message}`);
  }
  const shown = p.argv.join(" ");
  if (!p.run) {
    say(`Planned, not run (${p.why}): cos ${shown}`);
    return finish(0, i, shown, `planned only: ${p.why}`);
  }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return finish(2, i, shown, "refused: the fleet environment's Cloudflare secrets are not set");
  }
  const command = COMMANDS[i.command];
  if (command.needs && !(await deps.help()).includes(command.needs)) {
    return finish(
      2,
      i,
      shown,
      `refused: this cos has no "${command.needs}" yet (it arrives with PR #543)`,
    );
  }
  if (i.zone && !(await deps.help()).includes("--zone")) {
    return finish(
      2,
      i,
      shown,
      "refused: this cos's fleet install takes no --zone yet (it arrives with PR #543)",
    );
  }
  const files = {};
  if (command.keys) {
    if (!env.FLEET_KEYS)
      return finish(2, i, shown, "refused: FLEET_KEYS is not set in this environment");
    let keys;
    try {
      keys = decodeKeys(env.FLEET_KEYS, i.env);
    } catch (error) {
      return finish(2, i, shown, `refused: ${error.message}`);
    }
    secrets.push(env.FLEET_KEYS, keys.text, ...keys.values);
    for (const v of keys.values) deps.mask(v);
    files.keys = keys.text;
  }
  if (command.secret && !i.dryRun) {
    if (!env.SECRET_VALUE) {
      return finish(
        2,
        i,
        shown,
        `refused: the environment secret CLIENT_${i.client.toUpperCase()}_${i.secretName} is not set`,
      );
    }
    secrets.push(env.SECRET_VALUE);
    deps.mask(env.SECRET_VALUE);
    files.value = env.SECRET_VALUE;
  }
  const subdomain = await deps.subdomain().catch(() => null);
  if (subdomain) {
    secrets.push(subdomain);
    deps.mask(subdomain);
  }
  const result = await withSecretFiles(
    deps.tmp,
    files,
    async (paths) => {
      const argv = p.argv.map((a) =>
        a === KEYS ? paths.keys : a === VALUE ? (paths.value ?? "-") : a,
      );
      // A dry-run secret set needs no value: cos takes "-" (and reads nothing).
      const real =
        i.command === "client-secret-set" && i.dryRun
          ? argv.filter((a, n) => !(a === "--value-file" || argv[n - 1] === "--value-file"))
          : argv;
      say(`$ cos ${shown} (${p.why})`);
      return deps.cos(real, childEnv(env));
    },
    deps.process,
  );
  const output = sanitize(result.out, secrets);
  for (const line of output.split("\n")) if (line.trim()) deps.log(`    ${line}`);
  return finish(
    result.code,
    i,
    shown,
    result.code === 0 ? "succeeded" : `failed (exit ${result.code})`,
    output,
  );
}

/**
 * cos's environment: the Cloudflare secrets and GitHub's own, never the dispatch's inputs, the
 * keys or the secret value (those go by file), and never a test switch or a test address.
 */
export function childEnv(env) {
  const out = {};
  for (const name of [
    "PATH",
    "HOME",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "RUNNER_TEMP",
  ]) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  return out;
}

/** cos's arguments every run adds: the published, attested release, checked with gh too. */
export const ALWAYS = Object.freeze(["--require-gh"]);

async function main(argv) {
  const [command] = argv;
  const { CLIENT_SETTINGS, clientIdProblem } = await import("../packages/db/src/registry.ts");
  const { isGivenSecretName } = await import("../packages/db/src/registry-sealing.ts");
  const rules = {
    knownSettings: Object.keys(CLIENT_SETTINGS),
    isSecretName: isGivenSecretName,
    clientIdProblem,
  };
  if (command === "validate") {
    try {
      const i = readInputs(ENV, rules);
      plan(i);
      console.log(`Inputs valid: ${i.command} on ${i.env}${i.client ? ` for ${i.client}` : ""}.`);
      return 0;
    } catch (error) {
      console.log(`::error::${error.message}`);
      return 1;
    }
  }
  if (command !== "run") {
    console.error(
      "usage: node scripts/fleet-operate.mjs validate|run (inputs as OP_* environment variables)",
    );
    return 2;
  }
  const { DEFAULT_PRODUCT, products } = await import("../products/index.ts");
  const { CloudflareClient } = await import("../packages/release/src/cloudflare.ts");
  const cli = join(ROOT, "packages/create-composable-os/dist/cli.js");
  const runCos = (args, env) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      child.on("close", (code) => done({ code: code ?? 1, out }));
    });
  return operate(ENV, {
    rules,
    product: products[DEFAULT_PRODUCT],
    cos: (args, env) => runCos([...args, ...ALWAYS], env),
    help: async () => {
      const a = await runCos(["fleet", "--help"], childEnv(ENV));
      const b = await runCos(["client", "--help"], childEnv(ENV));
      return `${a.out}\n${b.out}`;
    },
    subdomain: async () =>
      new CloudflareClient({ token: ENV.CLOUDFLARE_API_TOKEN }).workersSubdomain(
        ENV.CLOUDFLARE_ACCOUNT_ID,
      ),
    tmp: ENV.RUNNER_TEMP || tmpdir(),
    log: (l) => console.log(l),
    mask: (v) => {
      if (v && ENV.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${v}\n`);
    },
    writeSummary: async (text) => {
      if (ENV.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(ENV.GITHUB_STEP_SUMMARY, `${text}\n`);
      }
    },
    process,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
