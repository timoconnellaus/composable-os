#!/usr/bin/env node
// The staging check of a host of many clients (stage 66; .github/workflows/fleet-staging-check.yml):
// a throwaway staging fleet on the fleet's account, run through every operator command on real
// Cloudflare, then deleted. Run by hand only, from GitHub Actions.
//
//   node scripts/fleet-staging-check.mjs prepare  --run <id>            no secret: the throwaway
//        product's files, and two releases built for it (0.1.0, then 0.1.1 with one more migration)
//   node scripts/fleet-staging-check.mjs check    --run <id> [--location oc] [--zone z]
//        [--client-zone z2] [--sending-domain d]                        steps 0 to 8, each timed
//   node scripts/fleet-staging-check.mjs teardown --run <id>            step 9: delete it all
//   node scripts/fleet-staging-check.mjs remove   --target <run id | cosstg-<run id>>
//        [--zone z] [--client-zone z2]
//        what a failed run left, by the same rule, and what remains
//
// cos attaches the fleet's hostnames itself (stage 66 step 8): `cos fleet install --zone` the
// callback hostname and `clients.<domain>`, `cos client add` each staff hostname; the check only
// confirms them. Step 3b checks cos-front (an unknown hostname's 404, a change from a sibling
// client refused, and with --client-zone a client's own domain proved by its TXT records and
// served). On those zones the teardown also deletes the run's routes, DNS records and custom
// hostnames, by a hostname label exactly the prefix.
//
// Everything the run makes is named from one throwaway prefix, `cosstg-<run id>` (the product's id,
// so every Worker, database, bucket, queue, namespace and index is `cosstg-<run id>-…`), and the
// hostnames are under `cosstg-<run id>.<zone>`. Teardown deletes only what is named so: what the
// account lists under the prefix, by exact name, and, of a kind it cannot list, the names the run
// recorded as it went (`ledger.json`). Nothing else in the account is touched, and a kind that
// cannot be listed fails the teardown. A step that proves less than it says is `partial`, which
// fails the check as `fail` does.
//
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read from the environment of `check`,
// `teardown` and `remove` only. Nothing here prints them, the account's workers.dev subdomain, a
// key or a password: each is masked in the log (`::add-mask::`) and cut out of every line written.
// The keys file and the exports are in RUNNER_TEMP, outside the checkout, and deleted at the end.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClient } from "../packages/release/src/cloudflare.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The workflow's environment: RUNNER_TEMP, GITHUB_*, and the two Cloudflare secrets. */
const ENV = process.env;

/** Every throwaway product's id starts with this (and cos's forced-failure switch checks it). */
export const PREFIX_ROOT = "cosstg-";
/** The two releases: installed, then upgraded to. */
export const VERSIONS = Object.freeze({ from: "0.1.0", to: "0.1.1" });
/**
 * The migration only the second release has (written into the checkout for its build, then
 * removed): each client's upgrade to it changes its schema and its rows, so a restore undoes
 * something and a success shows (review of #541, F5).
 */
export const STAGING_MIGRATION = Object.freeze({
  file: "9000_staging_check_marker.sql",
  schema: 9000,
  table: "core_staging_check",
  sql: "CREATE TABLE core_staging_check (id INTEGER PRIMARY KEY, release TEXT NOT NULL);\nINSERT INTO core_staging_check (release) VALUES ('0.1.1');\n",
});
/** The clients the check adds, in the registry's order (the forced migration fails on the last). */
export const CLIENTS = Object.freeze({
  a: "alpha",
  b: "bravo",
  imported: "charlie",
  late: "delta",
});
const LOCATIONS = ["oc", "apac", "wnam", "enam", "weur", "eeur"];
/** A 1×1 PNG: the file a client's export carries. */
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// --- names ----------------------------------------------------------------------------------------

/** The run's throwaway prefix, from a run id (digits only). */
export function prefixOf(run) {
  if (!/^\d{1,20}$/.test(String(run))) throw new Error(`a run id is digits, not ${run}`);
  return `${PREFIX_ROOT}${run}`;
}

/** The prefix a `remove` targets: a run id, or `cosstg-<run id>`; nothing broader. */
export function targetPrefix(target) {
  const value = String(target ?? "").trim();
  const match = /^(?:cosstg-)?(\d{1,20})$/.exec(value);
  if (!match) throw new Error(`the target is a run id or ${PREFIX_ROOT}<run id>, not "${value}"`);
  return prefixOf(match[1]);
}

/** Whether a name is the run's: the prefix itself, or the prefix and a hyphen. Exact, no pattern. */
export function owned(name, prefix) {
  return typeof name === "string" && (name === prefix || name.startsWith(`${prefix}-`));
}

/** The throwaway product: names only, as a product.ts holds them. */
export function productDefinition(run, repository = "timoconnellaus/composable-os") {
  const prefix = prefixOf(run);
  return {
    id: prefix,
    label: `Staging check ${run}`,
    names: {
      app: `${prefix}-app`,
      runner: `${prefix}-runner`,
      gatekeeperPrefix: `${prefix}-gatekeeper-`,
      database: prefix,
      resourcePrefix: `${prefix}-`,
    },
    packs: ["deals", "leads", "lifecycle"],
    updateRepository: repository,
    billingUrl: "https://billing.invalid/",
    strings: { name: "Staging check" },
  };
}

/** The fleet's hostnames: under `<prefix>.<zone>`, or a domain nothing resolves without a zone. */
export function hostnamesOf(prefix, zone) {
  const domain = zone ? `${prefix}.${zone}` : `${prefix}.invalid`;
  const staff = (id) => `${id}-admin.${domain}`;
  return {
    domain,
    callback: `callback.${domain}`,
    staff: Object.fromEntries(Object.values(CLIENTS).map((id) => [id, staff(id)])),
    // A client's web hostname is on its own domain, never the fleet's (`.example` is reserved).
    web: `${prefix}-${CLIENTS.a}.example`,
    sender: `${prefix}-mail.example`,
  };
}

/** The deployed name of one of the staging fleet's Workers (`<release name>-staging`). */
export function workerName(prefix, role) {
  return `${prefix}-${role}-staging`;
}

// --- output ---------------------------------------------------------------------------------------

/** Cuts every secret out of a text; each is masked in the Actions log as well. */
export function sanitize(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * What a failed command most likely needed, in a line: a feature the account may not have, or a
 * permission the token may lack. Null when nothing matches; the first error line is shown then.
 */
export function explainFailure(output) {
  const text = String(output);
  const rules = [
    [
      /workers\.dev/i,
      /subdomain/i,
      "The account has no workers.dev subdomain (Workers & Pages shows one once set): the operator's Worker is reached there.",
    ],
    [
      /queue/i,
      /(plan|paid|subscription|entitle|upgrade)/i,
      "Queues are not available on this account's plan (they may need Workers Paid).",
    ],
    [
      /durable object/i,
      /(plan|paid|subscription|entitle|sqlite)/i,
      "Durable Objects of this kind are not available on this account's plan.",
    ],
    [
      /(dispatch namespace|workers for platforms)/i,
      /./,
      "Workers for Platforms is not enabled on this account.",
    ],
    [
      /vectorize/i,
      /(plan|paid|limit|entitle)/i,
      "Vectorize is not available on this account's plan, or its limit is reached.",
    ],
    [
      /(zone|domains)/i,
      /(not found|9109|10000|permission|forbidden|unauthori)/i,
      "The zone is not in this account, or the token has no Workers Routes, DNS or SSL permission on it.",
    ],
    [
      /(Authentication error|10000|9109|permission|forbidden|unauthori)/i,
      /./,
      "The token lacks a permission this needs (the first error line says which call).",
    ],
  ];
  for (const [a, b, why] of rules) if (a.test(text) && b.test(text)) return why;
  return null;
}

/** The first line of an output that says what went wrong. */
export function firstError(output) {
  const lines = String(output)
    .split("\n")
    .map((l) => l.trim());
  return (
    lines.find((l) => /^Error:/.test(l)) ??
    lines.find((l) => /(failed|refused|cannot|not )/i.test(l)) ??
    lines.find((l) => l) ??
    ""
  ).slice(0, 300);
}

/** `cos client list`'s lines, by client: its status and schema. */
export function parseClientList(output) {
  const out = {};
  for (const line of String(output).split("\n")) {
    const m = /^\s{2}([a-z0-9-]+)\s{2}(\w+)\s{2}.*?\bschema (\d+|none)\b/.exec(line);
    if (m) out[m[1]] = { status: m[2], schema: m[3] };
  }
  return out;
}

const md = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The job summary's table of steps. */
export function summaryTable(results) {
  const rows = results.map(
    (r) =>
      `| ${md(r.name)} | ${r.status === "pass" ? "pass" : r.status === "fail" ? "**fail**" : r.status} | ${r.ms === null ? "" : `${(r.ms / 1000).toFixed(1)} s`} | ${md(r.note ?? "")} |`,
  );
  return ["| Step | Result | Time | Notes |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/**
 * What a run proved. Every step must pass: a `partial` step (it ran, and proved less than its name
 * says) fails the run as `fail` and `skipped` do (review of #541, F5). A step `not checked` names
 * what this check cannot check at all (a send); it is listed, and fails nothing.
 */
export function verdict(results) {
  const short = results.filter((r) => r.status !== "pass" && r.status !== "not checked");
  const unchecked = results.filter((r) => r.status === "not checked");
  const line = short.length
    ? `**Not proved.** ${short.map((r) => `${r.name.split(" ")[0].replace(/\.$/, "")} ${r.status}`).join(", ")}: see each note.`
    : "**Proved:** every step passed.";
  return {
    proved: short.length === 0,
    line: unchecked.length
      ? `${line} Not checked here at all: ${unchecked.map((r) => r.name).join("; ")}.`
      : line,
  };
}

// --- the account's inventory and its teardown -----------------------------------------------------

/**
 * Everything in the account named with `prefix`: Workers (their secrets and workers.dev routes go
 * with them), their Durable Object namespaces, Custom Domains (by hostname label or Worker), D1
 * databases, R2 buckets, KV namespaces, queues, Vectorize indexes, Workflows and AI Gateways. Each
 * kind that cannot be listed is named in `unlisted` (the token may lack its permission, or the API
 * may refuse): nothing of that kind is known to be gone.
 */
export async function inventory(api, accountId, prefix, zones = []) {
  const items = [];
  const unlisted = [];
  const unlistedKinds = [];
  const kinds = [
    [
      "domain",
      () => api.listDomains(accountId),
      (d) =>
        owned(d.service, prefix) || d.hostname.split(".").includes(prefix)
          ? { name: d.hostname, id: d.id }
          : null,
    ],
    [
      "worker",
      () => api.listScripts(accountId),
      (s) => (owned(s.id, prefix) ? { name: s.id, id: s.id } : null),
    ],
    [
      // Each defined by one of the run's Workers, and deleted with it (`?force=true`): listed so
      // the teardown knows they went (review of #541, F6).
      "durable_object",
      () => api.listDurableObjectNamespaces(accountId),
      (n) => (owned(n.script, prefix) ? { name: n.name, id: n.id, script: n.script } : null),
    ],
    [
      "queue",
      () => api.listQueues(accountId),
      (q) => (owned(q.queue_name, prefix) ? { name: q.queue_name, id: q.queue_id } : null),
    ],
    [
      "workflow",
      () => api.listWorkflows(accountId),
      (w) => (owned(w.name, prefix) ? { name: w.name, id: w.name } : null),
    ],
    [
      "r2",
      () => api.listR2(accountId),
      (b) => (owned(b.name, prefix) ? { name: b.name, id: b.name } : null),
    ],
    [
      "d1",
      () => api.listD1(accountId),
      (d) => (owned(d.name, prefix) ? { name: d.name, id: d.uuid } : null),
    ],
    [
      "kv",
      () => api.listKv(accountId),
      (n) => (owned(n.title, prefix) ? { name: n.title, id: n.id } : null),
    ],
    [
      "vectorize",
      () => api.listVectorize(accountId),
      (i) => (owned(i.name, prefix) ? { name: i.name, id: i.name } : null),
    ],
    [
      "gateway",
      () => api.listAiGateways(accountId),
      (g) => (owned(g.id, prefix) ? { name: g.id, id: g.id } : null),
    ],
  ];
  // On each zone the run used (stage 66 step 8: cos puts these itself): Workers routes, DNS
  // records and Cloudflare for SaaS custom hostnames, each by a label exactly the prefix (or, for
  // a route, a run's Worker). Only the zones named: another zone is never listed or touched.
  for (const zone of [...new Set(zones.filter(Boolean))]) {
    kinds.push(
      [
        "route",
        () => api.listRoutes(zone),
        (r) =>
          labelled(r.pattern.replace(/\/.*$/, ""), prefix) || owned(r.script ?? "", prefix)
            ? { name: r.pattern, id: r.id, zone }
            : null,
      ],
      [
        "dns",
        () => api.listAllDnsRecords(zone),
        (d) => (labelled(d.name, prefix) ? { name: `${d.name}#${d.type}`, id: d.id, zone } : null),
      ],
      [
        "custom_hostname",
        () => api.listCustomHostnames(zone),
        (h) => (labelled(h.hostname, prefix) ? { name: h.hostname, id: h.id, zone } : null),
      ],
    );
  }
  for (const [kind, list, pick] of kinds) {
    let found;
    try {
      found = await list();
    } catch (error) {
      unlisted.push(`${kind}: ${firstError(error.message)}`);
      unlistedKinds.push(kind);
      continue;
    }
    for (const entry of found ?? []) {
      const item = pick(entry);
      if (item) items.push({ kind, ...item });
    }
  }
  return { items, unlisted, unlistedKinds };
}

/** Whether a hostname (or a DNS record's `name#type`) has a label exactly the prefix. */
function labelled(name, prefix) {
  return String(name).split("#")[0].split(".").includes(prefix);
}

/** The zones the run used, from what it recorded (each zone-held item carries its zone). */
export function zonesOf(recorded) {
  return [...new Set(recorded.map((i) => i.zone).filter(Boolean))];
}

/** The order things are deleted in: what routes to a Worker, the Workers, then what they bound. */
const ORDER = [
  "route",
  "custom_hostname",
  "dns",
  "domain",
  "worker",
  "durable_object",
  "queue",
  "workflow",
  "r2",
  "d1",
  "kv",
  "vectorize",
  "gateway",
];

/**
 * The kinds deleted by their name. The others (`d1`, `kv`, `queue`, `domain`) are deleted by an
 * id: only one the account listed just now under the run's name, never one from the ledger, which
 * nothing checks against the name (review of #541, F7).
 */
const BY_NAME = new Set(["worker", "workflow", "r2", "vectorize", "gateway"]);

async function emptyBucket(api, accountId, bucket) {
  let removed = 0;
  for (let round = 0; round < 1000; round++) {
    const { keys } = await api.listR2Objects(accountId, bucket, null);
    if (keys.length === 0) return removed;
    for (const key of keys) {
      await api.deleteR2Object(accountId, bucket, key);
      removed++;
    }
  }
  throw new Error(`${bucket} still holds objects after 1000 rounds`);
}

async function deleteItem(api, accountId, item) {
  switch (item.kind) {
    case "route":
      return api.request("DELETE", `/zones/${item.zone}/workers/routes/${item.id}`);
    case "custom_hostname":
      return api.deleteCustomHostname(item.zone, item.id);
    case "dns":
      return api.deleteDnsRecord(item.zone, item.id);
    case "domain":
      return api.deleteDomain(accountId, item.id);
    case "worker":
      return api.deleteScript(accountId, item.name);
    case "queue":
      return api.deleteQueue(accountId, item.id);
    case "workflow":
      return api.deleteWorkflow(accountId, item.name);
    case "r2": {
      const objects = await emptyBucket(api, accountId, item.name);
      await api.deleteR2(accountId, item.name);
      return objects;
    }
    case "d1":
      return api.deleteD1(accountId, item.id);
    case "kv":
      return api.deleteKv(accountId, item.id);
    case "vectorize":
      return api.deleteVectorize(accountId, item.name);
    case "gateway":
      return api.deleteAiGateway(accountId, item.id);
    default:
      throw new Error(`no way to delete a ${item.kind}`);
  }
}

const key = (i) => `${i.kind}:${i.name}`;

/** Whether an item is named with the run's prefix (a hostname: one of its labels is the prefix). */
export function isRuns(item, prefix) {
  if (item.kind === "route") return labelled(item.name.replace(/\/.*$/, ""), prefix);
  return ["domain", "dns", "custom_hostname"].includes(item.kind)
    ? labelled(item.name, prefix)
    : owned(item.name, prefix);
}

/**
 * Deletes what the run made: what the account lists under the prefix now, by its exact name (an
 * id only as the listing gave it with that name), and, of a kind the account could not list, the
 * names the run recorded as it went (those deleted by name only). A Durable Object namespace is
 * not deleted on its own: it goes with its Worker. Then lists the prefix once more: `remaining` is
 * what is still there, and `unlisted` the kinds nobody could check.
 */
export async function teardown(api, accountId, prefix, recorded = [], zones = []) {
  // The zones the run recorded using, and any named: their routes, records and custom hostnames.
  const allZones = [...new Set([...zonesOf(recorded), ...zones])];
  const now = await inventory(api, accountId, prefix, allZones);
  const byKey = new Map(now.items.map((i) => [key(i), i]));
  const failed = [];
  // A recorded item of a kind the account listed, and no longer listed, is gone already. One that
  // is not the run's is never touched.
  for (const item of recorded) {
    if (!isRuns(item, prefix) || byKey.has(key(item))) continue;
    if (!now.unlistedKinds.includes(item.kind)) continue;
    if (BY_NAME.has(item.kind))
      byKey.set(key(item), { kind: item.kind, name: item.name, id: item.name });
    else {
      failed.push({
        kind: item.kind,
        name: item.name,
        error:
          "not deleted: its kind could not be listed, and it is deleted by an id that cannot be checked against its name",
      });
    }
  }
  const deleted = [];
  let todo = [...byKey.values()]
    .filter((item) => item.kind !== "durable_object") // goes with its Worker
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  let failing = [];
  // Twice: something another of the run's things still used may go once that one has gone.
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    failing = [];
    for (const item of todo) {
      try {
        const objects = await deleteItem(api, accountId, item);
        deleted.push({
          kind: item.kind,
          name: item.name,
          ...(typeof objects === "number" ? { objects } : {}),
        });
      } catch (error) {
        failing.push({ item, kind: item.kind, name: item.name, error: firstError(error.message) });
      }
    }
    todo = failing.map((f) => f.item);
  }
  failed.push(...failing.map(({ item: _item, ...f }) => f));
  const after = await inventory(api, accountId, prefix, allZones);
  return {
    deleted,
    failed,
    remaining: after.items.map((i) => ({ kind: i.kind, name: i.name })),
    unlisted: after.unlisted,
  };
}

/** Whether a teardown left the account clean, as far as anyone can tell. */
export function teardownClean(result) {
  return !result.remaining.length && !result.failed.length && !result.unlisted.length;
}

/** The teardown's report, for the job summary: what was not checked first. */
export function teardownReport(result, prefix) {
  const lines = [`### Teardown of ${prefix}`, ""];
  if (result.unlisted.length) {
    lines.push(
      `**Not checked: ${result.unlisted.length} kind${result.unlisted.length === 1 ? "" : "s"} could not be listed, so the account may still hold things of the run's of ${result.unlisted.length === 1 ? "it" : "them"}.** ${result.unlisted.map(md).join("; ")}. Look in the dashboard, or run mode remove once listing works.`,
      "",
    );
  }
  lines.push(
    result.deleted.length
      ? `Deleted (${result.deleted.length}): ${result.deleted.map((d) => `${d.kind} \`${d.name}\`${d.objects ? ` (${d.objects} objects)` : ""}`).join(", ")}`
      : "Deleted: nothing (nothing was there).",
  );
  if (result.failed.length) {
    lines.push("", `Could not delete (${result.failed.length}):`);
    for (const f of result.failed) lines.push(`- ${f.kind} \`${f.name}\`: ${md(f.error)}`);
  }
  lines.push(
    "",
    result.remaining.length
      ? `**Still there with the prefix (${result.remaining.length}):** ${result.remaining.map((r) => `${r.kind} \`${r.name}\``).join(", ")}`
      : result.unlisted.length
        ? `Nothing with the prefix ${prefix} is left among the kinds that could be listed.`
        : `Nothing with the prefix ${prefix} is left in the account.`,
  );
  return lines.join("\n");
}

// --- running cos and requests ---------------------------------------------------------------------

/** Runs the built cos with the check's product and releases; never throws on a failing command. */
export function cosRunner({ cli, productFile, bundleDir, env, secrets, log }) {
  return (args, options = {}) =>
    new Promise((done) => {
      const started = Date.now();
      const argv = [
        cli,
        ...args,
        "--product-file",
        productFile,
        "--bundle-dir",
        bundleDir,
        "--unverified",
        "--no-gh",
        "--env",
        "staging",
      ];
      const child = spawn(process.execPath, argv, {
        env: { ...env, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const take = (chunk) => {
        const text = sanitize(chunk.toString(), secrets());
        out += text;
        options.onOutput?.(out);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("close", (code) => {
        log(
          `$ cos ${args.join(" ")}  (exit ${code}, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
        );
        for (const line of out.split("\n")) if (line.trim()) log(`    ${line}`);
        done({ code: code ?? 1, out, ms: Date.now() - started });
      });
    });
}

/** A request with a time limit; a network error is an answer of status 0. */
export async function request(fetchImpl, url, init = {}, timeoutMs = 20000) {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, response };
  } catch (error) {
    return { status: 0, error: error?.cause?.code ?? error?.message ?? String(error) };
  }
}

/** Polls until `ok(answer)` or the time is up; returns the last answer. */
export async function waitFor(
  fetchImpl,
  url,
  ok,
  { timeoutMs = 600000, intervalMs = 5000, sleep } = {},
) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await request(fetchImpl, url);
    if (await ok(last)) return { ...last, ok: true };
    if (Date.now() > until) return { ...last, ok: false };
    await sleep(intervalMs);
  }
}

/**
 * The DNS records `cos client hostname add` printed for a client's own domain: `TXT <name> <value>`
 * and `CNAME <name> <target>` lines (packages/create-composable-os clients.ts `dnsInstructions`).
 */
export function printedRecords(out) {
  const records = [];
  for (const line of String(out).split("\n")) {
    const m = /^\s+(TXT|CNAME)\s+(\S+)\s+(\S+)\s+\(/.exec(line);
    if (m) records.push({ type: m[1], name: m[2], content: m[3] });
  }
  return records;
}

function cookiesOf(response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

// --- the check ------------------------------------------------------------------------------------

/**
 * Runs `steps` in order. A step whose `needs` did not pass is skipped; one that throws is a
 * failure and the rest still run. Each result has its time.
 */
export async function runSteps(steps, ctx, onResult = () => {}) {
  const results = [];
  const passed = new Set();
  for (const step of steps) {
    const missing = (step.needs ?? []).filter((n) => !passed.has(n));
    if (missing.length) {
      const result = {
        id: step.id,
        name: step.name,
        status: "skipped",
        ms: null,
        note: `needs ${missing.join(", ")}`,
      };
      results.push(result);
      onResult(result);
      continue;
    }
    const started = Date.now();
    let result;
    try {
      const outcome = (await step.run(ctx)) ?? {};
      const status = outcome.status ?? "pass";
      result = {
        id: step.id,
        name: step.name,
        status,
        ms: Date.now() - started,
        note: outcome.note ?? "",
      };
      // A partial step did its work (a fleet installed, clients added), so what needs that runs;
      // it still fails the run's verdict (`verdict`).
      if (status === "pass" || status === "partial") passed.add(step.id);
    } catch (error) {
      result = {
        id: step.id,
        name: step.name,
        status: "fail",
        ms: Date.now() - started,
        note: error.message,
      };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}

class StepFailure extends Error {}
const fail = (message) => {
  throw new StepFailure(message);
};
/** A cos command that must succeed, or the step fails with its error (and what it needed). */
async function must(ctx, args, options) {
  const run = await ctx.cos(args, options);
  if (run.code !== 0) {
    const why = explainFailure(run.out);
    fail(
      `cos ${args.slice(0, 2).join(" ")} exited ${run.code}: ${firstError(run.out)}${why ? ` (${why})` : ""}`,
    );
  }
  return run;
}

/**
 * Checks that cos attached the hostnames to the app Worker as Custom Domains (stage 66 step 8: the
 * fleet's domain is below its zone's apex, so `custom-domains`), and records them for the teardown.
 */
async function attached(ctx, hostnames) {
  if (!ctx.zoneId) return;
  const app = workerName(ctx.prefix, "app");
  const domains = await ctx.api.listDomains(ctx.accountId);
  for (const hostname of hostnames) {
    const found = domains.find((d) => d.hostname === hostname);
    if (!found || found.service !== app) {
      fail(
        `cos did not attach ${hostname} to ${app} (${found ? `it is ${found.service}'s` : "no Custom Domain"})`,
      );
    }
    ctx.record({ kind: "domain", name: hostname, id: found.id });
  }
}

/** The host's health on the callback hostname. */
async function hostHealth(ctx, version) {
  const url = `https://${ctx.hosts.callback}/api/health`;
  const answer = await waitFor(
    ctx.fetch,
    url,
    async (a) => {
      if (a.status !== 200) return false;
      const body = await a.response
        .clone()
        .json()
        .catch(() => ({}));
      return body.host === true && (!version || body.version === version);
    },
    { timeoutMs: ctx.waitMs, sleep: ctx.sleep },
  );
  return answer;
}

async function signUp(ctx, hostname, email, password) {
  const origin = `https://${hostname}`;
  const answer = await request(ctx.fetch, `${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password, name: "Staging check" }),
  });
  if (answer.status !== 200) {
    fail(
      `staff sign-up at ${hostname} answered ${answer.status}${answer.error ? ` (${answer.error})` : ""}`,
    );
  }
  return cookiesOf(answer.response);
}

async function signIn(ctx, hostname, email, password) {
  const origin = `https://${hostname}`;
  return request(ctx.fetch, `${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
}

/** An operation called with a cookie: its status, and its error's code when the body is JSON. */
async function staffOp(ctx, hostname, cookie, name) {
  const origin = `https://${hostname}`;
  const answer = await request(ctx.fetch, `${origin}/api/v1/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: "{}",
  });
  const text = answer.response ? await answer.response.text() : "";
  let code = null;
  try {
    const body = JSON.parse(text);
    code = body?.error?.code ?? body?.code ?? null;
  } catch {
    code = null;
  }
  return { status: answer.status, code };
}

async function clientList(ctx) {
  const run = await must(ctx, ["client", "list"]);
  return parseClientList(run.out);
}

/** The app Worker's deployed release, from its bindings (works with no zone). */
async function deployedVersion(ctx) {
  const bindings = await ctx.api.scriptBindings(ctx.accountId, workerName(ctx.prefix, "app"));
  return bindings.find((b) => b.name === "COS_RELEASE_VERSION")?.text ?? null;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * What an export folder holds, checked here and not only as cos says: each database part's and
 * each file's sha256 against its manifest, recomputed from the bytes on disk (review of #541, F5).
 */
export function exportFacts(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const problems = [];
  for (const part of manifest.database?.parts ?? []) {
    const path = join(dir, part.path);
    if (!existsSync(path)) problems.push(`part ${part.path} is missing`);
    else if (sha256(readFileSync(path)) !== part.sha256) problems.push(`part ${part.path} differs`);
  }
  for (const file of manifest.files ?? []) {
    const path = join(dir, "files", file.key);
    if (!existsSync(path)) problems.push(`file ${file.key} is missing`);
    else if (sha256(readFileSync(path)) !== file.sha256) problems.push(`file ${file.key} differs`);
  }
  return {
    counts: manifest.database?.counts ?? {},
    files: (manifest.files ?? []).map((f) => `${f.key} ${f.sha256}`).sort(),
    problems,
  };
}

/** Rows counted in one export and not the other, or counted differently. */
export function compareExports(a, b) {
  const problems = [];
  for (const table of new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])) {
    if ((a.counts[table] ?? 0) !== (b.counts[table] ?? 0)) {
      problems.push(`${table}: ${a.counts[table] ?? 0} rows, then ${b.counts[table] ?? 0}`);
    }
  }
  const fa = new Set(a.files);
  const fb = new Set(b.files);
  for (const f of fa)
    if (!fb.has(f)) problems.push(`file ${f.split(" ")[0]} not imported as it was`);
  for (const f of fb)
    if (!fa.has(f)) problems.push(`file ${f.split(" ")[0]} was not in the export`);
  return problems;
}

/** Steps 0 to 8 (docs/deploying.md, "Proving a host of many clients on Cloudflare"). */
export function checkSteps() {
  const { a, b, imported, late } = CLIENTS;
  const noZone =
    "no zone given: no client hostname is reachable without one (see step 0), so this is not proved";
  const page = (ctx, id) =>
    waitFor(ctx.fetch, `https://${ctx.hosts.staff[id]}/sign-in`, (x) => x.status === 200, {
      timeoutMs: ctx.waitMs,
      sleep: ctx.sleep,
    });
  /** Every client of `ids` as it was in `before`: its status and its schema. */
  const asBefore = (now, before, ids, when) => {
    for (const id of ids) {
      if (now[id]?.status !== before[id]?.status || now[id]?.schema !== before[id]?.schema) {
        fail(`${id} is ${JSON.stringify(now[id])} ${when}, was ${JSON.stringify(before[id])}`);
      }
    }
  };
  return [
    {
      id: "account",
      name: "0. The account: workers.dev, the zone, nothing of this run there yet",
      async run(ctx) {
        const notes = [];
        const subdomain = await ctx.api.workersSubdomain(ctx.accountId);
        if (!subdomain)
          fail(
            "The account has no workers.dev subdomain: the operator's Worker is reached there. Set one (Workers & Pages) and run again.",
          );
        // It names the account: masked, and cut out of everything written.
        ctx.addSecret(subdomain);
        ctx.subdomain = subdomain;
        if (ctx.zone) {
          const zones = await ctx.api.listZones(ctx.accountId);
          const zone = zones.find((z) => z.name === ctx.zone);
          if (!zone)
            fail(
              `The zone ${ctx.zone} is not an active zone of this account (or the token cannot read it).`,
            );
          ctx.zoneId = zone.id;
          notes.push(`zone ${ctx.zone} found; the fleet's domain is ${ctx.hosts.domain}`);
        } else {
          notes.push(
            "no zone given: cos has no zone to attach the fleet's hostnames on, so no client is reachable, and the steps that need one are partial",
          );
        }
        if (ctx.clientZone) {
          const zones = await ctx.api.listZones(ctx.accountId);
          const zone = zones.find((z) => z.name === ctx.clientZone);
          if (!zone)
            fail(`The client zone ${ctx.clientZone} is not an active zone of this account.`);
          ctx.clientZoneId = zone.id;
          notes.push(`client zone ${ctx.clientZone} found, for a client's own domain`);
        }
        const before = await inventory(ctx.api, ctx.accountId, ctx.prefix, [
          ctx.zoneId,
          ctx.clientZoneId,
        ]);
        if (before.unlisted.length)
          fail(
            `the account cannot be fully listed (${before.unlisted.join("; ")}): the teardown could not prove it left nothing, so nothing is made`,
          );
        if (before.items.length)
          fail(
            `the account already holds ${before.items.length} things named ${ctx.prefix}: run the workflow with mode remove first`,
          );
        return { note: notes.join("; ") };
      },
    },
    {
      id: "install",
      needs: ["account"],
      name: "1. cos fleet keys, cos fleet install",
      async run(ctx) {
        await must(ctx, ["fleet", "keys", "--out", ctx.keysFile]);
        const install = await must(ctx, [
          "fleet",
          "install",
          "--keys-file",
          ctx.keysFile,
          "--callback-hostname",
          ctx.hosts.callback,
          "--domain",
          ctx.hosts.domain,
          "--version",
          VERSIONS.from,
          "--location",
          ctx.location,
          "--ai",
          "off",
          // The zone the fleet's domain is on: cos attaches its hostnames there (stage 66 step 8).
          ...(ctx.zone ? ["--zone", ctx.zone] : []),
          "--yes",
        ]);
        await ctx.snapshot();
        const version = await deployedVersion(ctx);
        if (version !== VERSIONS.from) fail(`the app Worker runs ${version}, not ${VERSIONS.from}`);
        await attached(ctx, [ctx.hosts.callback]);
        const notes = [
          `installed ${VERSIONS.from} in ${(install.ms / 1000).toFixed(0)} s (AI off, location ${ctx.location}); the app Worker runs it`,
        ];
        if (!ctx.zoneId) {
          return {
            status: "partial",
            note: `${notes.join("; ")}; the host's health on the callback hostname is not checked: ${noZone}`,
          };
        }
        const health = await hostHealth(ctx, VERSIONS.from);
        if (!health.ok)
          fail(
            `the host's health on the callback hostname did not answer ${VERSIONS.from} (last: ${health.status}${health.error ? ` ${health.error}` : ""})`,
          );
        notes.push("the callback hostname answers the host's health");
        return { note: notes.join("; ") };
      },
    },
    {
      id: "add",
      needs: ["install"],
      name: "2. cos client add, two clients",
      async run(ctx) {
        // A client's own domain is step 4b's (cos-front): `--web-hostname` would make a custom
        // hostname on a domain nobody can prove (`.example`).
        const first = await must(ctx, ["client", "add", a, "--location", ctx.location, "--yes"]);
        const second = await must(ctx, ["client", "add", b, "--location", ctx.location, "--yes"]);
        const list = await clientList(ctx);
        for (const id of [a, b]) {
          if (list[id]?.status !== "active") fail(`${id} is ${list[id]?.status} after its add`);
        }
        await attached(ctx, [ctx.hosts.staff[a], ctx.hosts.staff[b]]);
        const reported = (out) => /Added \S+ in ([\d.]+) s/.exec(out)?.[1];
        return {
          note: `${a}: ${reported(first.out) ?? "?"} s inside cos, ${(first.ms / 1000).toFixed(1)} s for the command, its staff hostname attached by cos; ${b}: ${reported(second.out) ?? "?"} s, ${(second.ms / 1000).toFixed(1)} s; both active, schema ${list[a]?.schema}`,
        };
      },
    },
    {
      id: "requests",
      needs: ["add"],
      name: "3. Requests: sign-in pages, A never serves B, the host's health",
      async run(ctx) {
        const notes = [];
        // The app's own workers.dev address decides no client: a client is reached by its hostname.
        const dev = await request(
          ctx.fetch,
          `https://${workerName(ctx.prefix, "app")}.${ctx.subdomain}.workers.dev/sign-in`,
        );
        notes.push(
          `the app's workers.dev address answers ${dev.status}${dev.status === 404 ? " (the unknown hostname's answer: a client is decided by its hostname only)" : ""}`,
        );
        if (!ctx.zoneId) return { status: "partial", note: `${notes.join("; ")}; ${noZone}` };
        for (const id of [a, b]) {
          const answer = await page(ctx, id);
          if (!answer.ok)
            fail(
              `${id}'s staff sign-in page did not answer 200 (last: ${answer.status}${answer.error ? ` ${answer.error}` : ""})`,
            );
        }
        notes.push("both staff sign-in pages answer 200");
        for (const id of [a, b]) {
          const email = `staff-${id}-${ctx.run}@staging-check.invalid`;
          const password = randomBytes(18).toString("base64url");
          ctx.addSecret(password);
          ctx.staff[id] = {
            email,
            password,
            cookie: await signUp(ctx, ctx.hosts.staff[id], email, password),
          };
          ctx.addSecret(ctx.staff[id].cookie);
        }
        for (const id of [a, b]) {
          const own = await staffOp(ctx, ctx.hosts.staff[id], ctx.staff[id].cookie, "person.list");
          if (own.status !== 200) fail(`${id}'s staff session at ${id} answered ${own.status}`);
        }
        // A's cookie at B is answered as no cookie is: the same refusal (status and code; the
        // bodies may differ in a request id).
        const other = await staffOp(ctx, ctx.hosts.staff[b], ctx.staff[a].cookie, "person.list");
        const none = await staffOp(ctx, ctx.hosts.staff[b], "", "person.list");
        if (none.status < 400) fail(`${b} answered ${none.status} to an operation with no session`);
        if (other.status !== none.status || other.code !== none.code) {
          fail(
            `${a}'s session at ${b}'s address answered ${other.status} ${other.code}, not as no session (${none.status} ${none.code})`,
          );
        }
        // B's password at A is a wrong password there: 401, never a rate limit or an error.
        const crossed = await signIn(
          ctx,
          ctx.hosts.staff[a],
          ctx.staff[b].email,
          ctx.staff[b].password,
        );
        if (crossed.status !== 401)
          fail(`${b}'s password at ${a}'s address answered ${crossed.status}, not 401`);
        notes.push(
          `each client's staff session works at its own address; ${a}'s is no session at ${b}'s (${none.status}), and ${b}'s password is a wrong one at ${a}'s (401)`,
        );
        const health = await hostHealth(ctx, VERSIONS.from);
        if (!health.ok)
          fail(`the host's health on the callback hostname answered ${health.status}`);
        notes.push("the host's health answers on the callback hostname");
        // A file of A's own, for the export to carry (step 6).
        const origin = `https://${ctx.hosts.staff[a]}`;
        const upload = await request(ctx.fetch, `${origin}/api/media?name=probe.png`, {
          method: "POST",
          headers: {
            "content-type": "image/png",
            origin,
            cookie: ctx.staff[a].cookie,
            "idempotency-key": crypto.randomUUID(),
          },
          body: PROBE_PNG,
        });
        if (upload.status < 200 || upload.status >= 300)
          fail(`the picture upload at ${a} answered ${upload.status}`);
        ctx.uploaded = sha256(PROBE_PNG);
        notes.push(`a picture uploaded at ${a}`);
        return { note: notes.join("; ") };
      },
    },
    {
      id: "front",
      needs: ["add"],
      name: "3b. cos-front, and a change from a sibling client refused",
      async run(ctx) {
        if (!ctx.zoneId) return { status: "partial", note: noZone };
        const notes = [];
        // A hostname cos-front reaches that is no client's: the CNAME target itself.
        const target = `https://clients.${ctx.hosts.domain}/`;
        const unknown = await waitFor(ctx.fetch, target, (x) => x.status === 404, {
          timeoutMs: ctx.waitMs,
          sleep: ctx.sleep,
        });
        if (!unknown.ok) fail(`${target} did not answer 404 (last: ${unknown.status})`);
        const policy = unknown.response?.headers.get("content-security-policy") ?? "";
        if (!policy.includes("frame-ancestors 'none'"))
          fail(`cos-front's 404 has no frame-ancestors policy (${policy || "none"})`);
        notes.push("an unknown hostname at cos-front answers 404 with its policy");
        // Rule (b): a POST to A's staff hostname from B's is refused before any route.
        const sibling = await request(
          ctx.fetch,
          `https://${ctx.hosts.staff[a]}/api/v1/op/person.list`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: `https://${ctx.hosts.staff[b]}`,
            },
            body: "{}",
          },
        );
        if (sibling.status !== 403)
          fail(`a POST to ${a} from ${b}'s hostname answered ${sibling.status}, not 403`);
        notes.push(`a POST to ${a} from ${b}'s hostname is refused (403)`);
        if (!ctx.clientZoneId) {
          return {
            status: "partial",
            note: `${notes.join("; ")}; a verified client's own domain is not checked: give --client-zone (a second spare zone)`,
          };
        }
        // A client's own domain: added, its records written into the client zone, verified once
        // Cloudflare proves it, then served by cos-front, then removed.
        const own = `www.${ctx.prefix}.${ctx.clientZone}`;
        const added = await must(ctx, ["client", "hostname", "add", a, own]);
        const records = printedRecords(added.out);
        if (!records.some((r) => r.type === "CNAME"))
          fail(`cos client hostname add printed no CNAME for ${own}`);
        for (const r of records) {
          const made = await ctx.api.createDnsRecord(ctx.clientZoneId, {
            type: r.type,
            name: r.name,
            content: r.content,
            ttl: 60,
            ...(r.type === "CNAME" ? { proxied: false } : {}),
          });
          ctx.record({
            kind: "dns",
            name: `${r.name}#${r.type}`,
            id: made.id,
            zone: ctx.clientZoneId,
          });
        }
        const until = Date.now() + ctx.waitMs;
        for (;;) {
          const verified = await ctx.cos(["client", "hostname", "verify", a, own, "--yes"]);
          if (verified.code === 0) break;
          if (Date.now() > until)
            fail(`${own} was not proved in time: ${firstError(verified.out)}`);
          await ctx.sleep(30000);
        }
        const served = await waitFor(ctx.fetch, `https://${own}/`, (x) => x.status === 200, {
          timeoutMs: ctx.waitMs,
          sleep: ctx.sleep,
        });
        if (!served.ok) fail(`${own} did not answer 200 once verified (last: ${served.status})`);
        const body = (await served.response?.text()) ?? "";
        if (!body.includes("Coming soon")) fail(`${own} did not serve the holding page`);
        notes.push(`${a}'s own domain, proved by its TXT records, serves the holding page`);
        await must(ctx, ["client", "hostname", "remove", a, own, "--yes"]);
        notes.push("and is removed again");
        return { note: notes.join("; ") };
      },
    },
    {
      id: "sender",
      needs: ["add"],
      name: "4. cos client sender add, verify, unverify",
      async run(ctx) {
        await must(ctx, ["client", "sender", "add", a, ctx.hosts.sender, "--yes"]);
        await must(ctx, ["client", "sender", "verify", a, ctx.hosts.sender, "--yes"]);
        await must(ctx, ["client", "sender", "unverify", a, ctx.hosts.sender, "--yes"]);
        return {
          note: `${ctx.hosts.sender} added to ${a} unverified, verified, then unverified again`,
        };
      },
    },
    {
      id: "send",
      name: "4b. A send (refused unverified, or real)",
      async run(ctx) {
        // `cos fleet install` installs no gatekeeper (a fleet's state lists none), so there is no
        // email-send Worker to send from, verified domain or not.
        return {
          status: "not checked",
          note: `a fleet is installed with no gatekeepers, so no email-send Worker is deployed to send from; ${ctx.sendingDomain ? `the sending domain ${ctx.sendingDomain} was given and not used` : "no sending domain was given"}`,
        };
      },
    },
    {
      id: "upgrade",
      needs: ["add"],
      name: "5. cos fleet upgrade: a failed migration, a failed smoke check, then a success",
      async run(ctx) {
        const notes = [];
        const before = await clientList(ctx);
        for (const id of [a, b]) {
          if (before[id]?.schema === String(STAGING_MIGRATION.schema))
            fail(`${id} is already at schema ${STAGING_MIGRATION.schema} before the upgrade`);
        }
        const upgrade = (env) =>
          ctx.cos(
            ["fleet", "upgrade", "--keys-file", ctx.keysFile, "--version", VERSIONS.to, "--yes"],
            env ? { env } : {},
          );
        // 1. bravo's migration fails after alpha's has really applied (0.1.1 adds one): alpha and
        //    bravo restored, nothing uploaded.
        const one = await upgrade({ COS_FLEET_FORCE_FAILURE: `migration:${b}` });
        if (one.code === 0) fail("the upgrade with a failing migration succeeded");
        if (!/stopped before any upload/.test(one.out))
          fail(
            `the failed migration did not stop the update before the upload: ${firstError(one.out)}`,
          );
        const restored = /stopped before any upload: (.*?) restored/.exec(one.out)?.[1] ?? "";
        if (!restored.split(", ").includes(a) || !restored.split(", ").includes(b))
          fail(`not every client was restored (${restored})`);
        asBefore(await clientList(ctx), before, [a, b], "after the failed migration");
        const afterOne = await deployedVersion(ctx);
        if (afterOne !== VERSIONS.from)
          fail(
            `after the failed migration the app Worker runs ${afterOne}: something was uploaded`,
          );
        if (ctx.zoneId && !(await hostHealth(ctx, VERSIONS.from)).ok)
          fail(`after the failed migration the host does not answer ${VERSIONS.from}`);
        notes.push(
          `a failing migration on ${b} after ${a}'s had applied: stopped (${(one.ms / 1000).toFixed(0)} s), ${restored} restored to schema ${before[a]?.schema}, the app Worker still ${VERSIONS.from}`,
        );
        // 2. The smoke check fails after the upload: the previous Workers again, everyone restored.
        const two = await upgrade({ COS_FLEET_FORCE_FAILURE: "smoke" });
        if (two.code === 0) fail("the upgrade with a failing smoke check succeeded");
        if (!/Rolled back/.test(two.out))
          fail(`the failed smoke check was not rolled back: ${firstError(two.out)}`);
        // Without a zone the real smoke check fails first (no callback hostname), and the switch
        // is never reached: a rollback all the same, but not the one asked for.
        const switched = /COS_FLEET_FORCE_FAILURE=smoke: made to fail/.test(two.out);
        asBefore(await clientList(ctx), before, [a, b], "after the rollback");
        const afterTwo = await deployedVersion(ctx);
        if (afterTwo !== VERSIONS.from)
          fail(`after the rollback the app Worker runs ${afterTwo}, not ${VERSIONS.from}`);
        if (ctx.zoneId && !(await hostHealth(ctx, VERSIONS.from)).ok)
          fail(`after the rollback the host does not answer ${VERSIONS.from}`);
        notes.push(
          `a failing smoke check: rolled back (${(two.ms / 1000).toFixed(0)} s), both clients as they were, the app Worker ${VERSIONS.from} again${switched ? "" : " (the real smoke check failed first: the switch was not reached)"}`,
        );
        if (!ctx.zoneId) {
          notes.push(
            `the successful upgrade is not run: its smoke check is on the callback hostname, which needs a zone`,
          );
          return { status: "partial", note: notes.join("; ") };
        }
        if (!switched) fail("the smoke check failed for real before the switch was reached");
        // 3. A real one.
        const three = await upgrade(null);
        if (three.code !== 0)
          fail(`the upgrade to ${VERSIONS.to} failed: ${firstError(three.out)}`);
        if (!(await hostHealth(ctx, VERSIONS.to)).ok)
          fail(`after the upgrade the host does not answer ${VERSIONS.to}`);
        const afterThree = await deployedVersion(ctx);
        if (afterThree !== VERSIONS.to) fail(`after the upgrade the app Worker runs ${afterThree}`);
        const after = await clientList(ctx);
        for (const id of [a, b]) {
          if (after[id]?.status !== "active")
            fail(`${id} is ${after[id]?.status} after the upgrade`);
          if (after[id]?.schema !== String(STAGING_MIGRATION.schema))
            fail(`${id} is at schema ${after[id]?.schema}, not ${STAGING_MIGRATION.schema}`);
        }
        for (const id of [a, b]) {
          const answer = await page(ctx, id);
          if (!answer.ok) fail(`${id}'s sign-in page answers ${answer.status} after the upgrade`);
        }
        ctx.upgraded = true;
        notes.push(
          `then ${VERSIONS.from} → ${VERSIONS.to} (${(three.ms / 1000).toFixed(0)} s): both clients at schema ${STAGING_MIGRATION.schema} and served, ${VERSIONS.to} answers`,
        );
        return { note: notes.join("; ") };
      },
    },
    {
      id: "export",
      needs: ["add"],
      name: "6. cos client export, then import as a third client",
      async run(ctx) {
        await must(ctx, ["client", "export", a, "--out", ctx.exportDir, "--yes"]);
        await must(ctx, ["client", "import", imported, "--from", ctx.exportDir, "--yes"]);
        await attached(ctx, [ctx.hosts.staff[imported]]);
        await must(ctx, ["client", "export", imported, "--out", ctx.reexportDir, "--yes"]);
        const first = exportFacts(ctx.exportDir);
        const again = exportFacts(ctx.reexportDir);
        const problems = [
          ...first.problems.map((p) => `${a}'s export: ${p}`),
          ...again.problems.map((p) => `${imported}'s export: ${p}`),
          ...compareExports(first, again),
        ];
        const rows = Object.values(first.counts).reduce((x, y) => x + y, 0);
        if (!Object.keys(first.counts).length || rows === 0)
          problems.push(`${a}'s export counts no rows`);
        if (ctx.upgraded && first.counts[STAGING_MIGRATION.table] !== 1)
          problems.push(`${STAGING_MIGRATION.table} (the upgrade's row) is not in the export`);
        if (ctx.uploaded && !first.files.some((f) => f.endsWith(` ${ctx.uploaded}`)))
          problems.push(`the picture uploaded at ${a} is not in its export`);
        if (problems.length)
          fail(
            `the export or the import is not as it should be: ${problems.slice(0, 5).join("; ")}`,
          );
        const notes = [
          `${a} exported (${Object.keys(first.counts).length} tables, ${rows} rows, ${first.files.length} files, every hash recomputed from the bytes), imported as ${imported}, exported again: the same row counts and file hashes`,
        ];
        if (!ctx.zoneId) {
          return {
            status: "partial",
            note: `${notes.join("; ")}; ${imported}'s sign-in page is not checked and the export carries no uploaded file: ${noZone}`,
          };
        }
        const answer = await page(ctx, imported);
        if (!answer.ok) fail(`${imported}'s sign-in page answered ${answer.status}`);
        notes.push(`${imported}'s sign-in page answers`);
        return { note: notes.join("; ") };
      },
    },
    {
      id: "concurrent",
      needs: ["add"],
      name: "7. Two operator commands at once: the second is refused",
      async run(ctx) {
        let started;
        const holding = new Promise((resolve) => {
          started = resolve;
        });
        let firstEnded = null;
        const first = ctx
          .cos(["client", "add", late, "--yes"], {
            onOutput: (out) => {
              if (/registry: /.test(out)) started();
            },
          })
          .then((r) => {
            firstEnded = Date.now();
            return r;
          });
        await Promise.race([holding, first]);
        const secondStarted = Date.now();
        const second = await ctx.cos(["client", "export", b, "--yes"]);
        const firstRun = await first;
        if (firstRun.code !== 0) fail(`the first command failed: ${firstError(firstRun.out)}`);
        if (second.code === 0) {
          // The add finished before the export began: no overlap, so nothing was shown.
          if (firstEnded !== null && firstEnded <= secondStarted) {
            return {
              status: "partial",
              note: `cos client add ${late} finished before cos client export ${b} started: the two did not overlap, so the refusal is not shown`,
            };
          }
          fail("the second command was not refused while the first held the operator's Worker");
        }
        if (!/Another operator's command/.test(second.out))
          fail(`the second command failed otherwise: ${firstError(second.out)}`);
        return {
          note: `cos client add ${late} held the operator's Worker; cos client export ${b} beside it was refused before it changed anything; the add finished`,
        };
      },
    },
    {
      id: "remove",
      needs: ["add"],
      name: "8. cos client remove: its hostnames stop answering, the other is untouched",
      async run(ctx) {
        await must(ctx, ["client", "remove", a, "--yes"]);
        const list = await clientList(ctx);
        if (list[a]) fail(`${a} is still listed after the remove`);
        if (list[b]?.status !== "active") fail(`${b} is ${list[b]?.status} after ${a} was removed`);
        if (!ctx.zoneId) return { status: "partial", note: `${a} removed, ${b} active; ${noZone}` };
        // The host serves the change within its registry refresh (10 s).
        const gone = await waitFor(
          ctx.fetch,
          `https://${ctx.hosts.staff[a]}/sign-in`,
          (x) => x.status === 404,
          { timeoutMs: 120000, sleep: ctx.sleep },
        );
        if (!gone.ok) fail(`${a}'s address still answers ${gone.status}`);
        const answer = await request(ctx.fetch, `https://${ctx.hosts.staff[b]}/sign-in`);
        if (answer.status !== 200) fail(`${b}'s sign-in page answers ${answer.status}`);
        if (!ctx.staff[b]) fail(`${b} has no staff session to check (step 3 did not make one)`);
        const own = await staffOp(ctx, ctx.hosts.staff[b], ctx.staff[b].cookie, "person.list");
        if (own.status !== 200) fail(`${b}'s staff session answers ${own.status}`);
        return {
          note: `${a}'s address answers the unknown hostname's 404; ${b} answers and its staff stay signed in`,
        };
      },
    },
  ];
}

// --- commands -------------------------------------------------------------------------------------

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--"))
      out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "" : (argv[++i] ?? "");
  }
  return out;
}

function workDir(run) {
  const dir = join(ENV.RUNNER_TEMP || tmpdir(), `fleet-staging-${prefixOf(run)}`);
  if (dir.startsWith(`${ROOT}/`)) throw new Error("the work folder must be outside the checkout");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function summary(text) {
  if (ENV.GITHUB_STEP_SUMMARY) appendFileSync(ENV.GITHUB_STEP_SUMMARY, `${text}\n\n`);
}

const mask = (value) => {
  if (value && ENV.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${value}\n`);
};

/** The account's client, and what names it (the token, its id, its workers.dev subdomain), masked. */
async function account() {
  const token = ENV.CLOUDFLARE_API_TOKEN;
  const accountId = ENV.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId)
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed");
  mask(token);
  mask(accountId);
  const api = new CloudflareClient({
    token,
    ...(ENV.COS_CLOUDFLARE_API ? { apiBase: ENV.COS_CLOUDFLARE_API } : {}),
  });
  const secrets = [token, accountId];
  const subdomain = await api.workersSubdomain(accountId).catch(() => null);
  if (subdomain) {
    mask(subdomain);
    secrets.push(subdomain);
  }
  return { api, accountId, secrets };
}

/** `prepare`: the product's files and the two releases, merged into one folder. No secret. */
async function prepare(opts) {
  const dir = workDir(opts.run);
  const product = productDefinition(opts.run, ENV.GITHUB_REPOSITORY || undefined);
  writeFileSync(join(dir, "product.json"), `${JSON.stringify(product, null, 2)}\n`);
  writeFileSync(
    join(dir, "product.ts"),
    `export const product = ${JSON.stringify(product, null, 2)};\n`,
  );
  const bundles = join(dir, "bundles");
  mkdirSync(bundles, { recursive: true });
  let sums = "";
  const migration = join(ROOT, "packages/db/migrations", STAGING_MIGRATION.file);
  if (existsSync(migration))
    throw new Error(`${STAGING_MIGRATION.file} is already in the checkout`);
  const node = (argv) =>
    new Promise((done) => {
      spawn(process.execPath, argv, { cwd: ROOT, stdio: "inherit" }).on("close", done);
    });
  for (const [i, version] of [VERSIONS.from, VERSIONS.to].entries()) {
    const out = join(dir, `release-${version}`);
    // The second release carries one more migration, so its upgrade migrates every client for
    // real: it is built in full, since the code's schema version follows the migrations.
    if (i > 0) writeFileSync(migration, STAGING_MIGRATION.sql);
    let code;
    try {
      code = await node([
        "scripts/release/build-release.ts",
        "--version",
        version,
        "--product",
        join(dir, "product.ts"),
        "--out",
        out,
      ]);
    } finally {
      if (i > 0) {
        rmSync(migration, { force: true });
        await node(["packages/db/scripts/schema-version.mjs"]);
      }
    }
    if (code !== 0) throw new Error(`building ${version} failed (exit ${code})`);
    for (const name of readdirSync(out)) {
      if (name === "SHA256SUMS") sums += readFileSync(join(out, name), "utf8");
      else copyFileSync(join(out, name), join(bundles, name));
    }
  }
  writeFileSync(join(bundles, "SHA256SUMS"), sums);
  console.log(`Prepared ${product.id}: ${VERSIONS.from} and ${VERSIONS.to} in ${bundles}`);
}

/** Reads and validates the check's options. */
export function checkOptions(opts) {
  const location = opts.location || "oc";
  if (!LOCATIONS.includes(location))
    throw new Error(`--location is one of ${LOCATIONS.join(", ")}`);
  // AI stays off: an install with it makes an account API token and creates or changes the
  // account-wide custom AI provider, which no teardown deletes or puts back (review of #541, F1).
  if (opts.ai !== undefined && opts.ai !== "off") {
    throw new Error(
      "--ai: the check installs without AI only (with it, an account API token and the account's custom AI provider would outlive the teardown)",
    );
  }
  const ai = "off";
  const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const zone = (opts.zone || "").trim().toLowerCase();
  if (zone && !hostname.test(zone)) throw new Error("--zone is a domain name");
  const sendingDomain = (opts["sending-domain"] || "").trim().toLowerCase();
  if (sendingDomain && !hostname.test(sendingDomain))
    throw new Error("--sending-domain is a domain name");
  // A second spare zone of the account, for a client's own domain (stage 66 step 8): never the
  // fleet's zone, since a client's web hostname is never under the fleet's registrable domain.
  const clientZone = (opts["client-zone"] || "").trim().toLowerCase();
  if (clientZone && !hostname.test(clientZone)) throw new Error("--client-zone is a domain name");
  if (clientZone && clientZone === zone)
    throw new Error("--client-zone is a zone apart from --zone");
  return {
    run: String(opts.run),
    prefix: prefixOf(opts.run),
    location,
    ai,
    zone,
    clientZone,
    sendingDomain,
  };
}

/** `check`: steps 1 to 8, each into the summary; the ledger and results are kept for teardown. */
export async function check(options, deps) {
  const { api, accountId, cos, fetchImpl, dir, log, writeSummary } = deps;
  // Shared with the cos runner, which cuts every one of them out of what it logs.
  const secrets = deps.secrets ?? new Set();
  const ledger = new Map();
  const record = (item) => ledger.set(key(item), item);
  const saveLedger = () =>
    writeFileSync(join(dir, "ledger.json"), JSON.stringify([...ledger.values()], null, 2));
  const ctx = {
    ...options,
    api,
    accountId,
    cos,
    fetch: fetchImpl,
    hosts: hostnamesOf(options.prefix, options.zone),
    zoneId: null,
    clientZoneId: null,
    keysFile: join(dir, "keys.json"),
    exportDir: join(dir, "export-a"),
    reexportDir: join(dir, "export-c"),
    staff: {},
    waitMs: deps.waitMs ?? 600000,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    subdomain: null,
    secrets: () => [...secrets],
    addSecret(value) {
      if (!value) return;
      secrets.add(value);
      deps.mask?.(value);
    },
    record(item) {
      record(item);
      saveLedger();
    },
    async snapshot() {
      const zones = [this.zoneId, this.clientZoneId];
      for (const item of (await inventory(api, accountId, options.prefix, zones)).items) {
        record(item);
      }
      saveLedger();
    },
  };
  const results = await runSteps(checkSteps(), ctx, (r) => {
    log(
      `${r.status.toUpperCase()}  ${r.name}${r.ms !== null ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}${r.note ? `: ${sanitize(r.note, ctx.secrets())}` : ""}`,
    );
    ctx.snapshot().catch(() => {});
  });
  await ctx.snapshot().catch(() => {});
  for (const r of results) r.note = sanitize(r.note, ctx.secrets());
  writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2));
  writeSummary(
    [
      `## Staging check of a host of many clients: ${options.prefix}`,
      "",
      verdict(results).line,
      ...(options.zone
        ? []
        : [
            "",
            "**No zone:** no client hostname was reachable, so the requests (3), the successful upgrade (5) and the remove's answers (8) are not proved.",
          ]),
      "",
      `Location ${options.location}, AI off, zone ${options.zone || "none"}, releases ${VERSIONS.from} and ${VERSIONS.to} (with migration ${STAGING_MIGRATION.file}) built from this commit for the throwaway product.`,
      "",
      summaryTable(results),
    ].join("\n"),
  );
  return results;
}

/** `teardown` / `remove`: deletes the run's things; fails when anything with the prefix is left. */
export async function teardownCommand(prefix, deps) {
  const { api, accountId, dir, writeSummary, log } = deps;
  const ledgerFile = dir ? join(dir, "ledger.json") : null;
  const recorded =
    ledgerFile && existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : [];
  // Zones named for a run whose ledger is gone (`remove --zone z --client-zone z2`), by their ids.
  const named = (deps.zones ?? []).filter(Boolean);
  const zoneIds = named.length
    ? (await api.listZones(accountId)).filter((z) => named.includes(z.name)).map((z) => z.id)
    : [];
  const result = await teardown(api, accountId, prefix, recorded, zoneIds);
  // Cloudflare's errors name the account in their paths: cut out, as everywhere (review of #541, F8).
  const report = sanitize(teardownReport(result, prefix), [...(deps.secrets ?? [])]);
  log(report);
  writeSummary(report);
  // A kind nobody could list is not known to be gone: that fails too (review of #541, F6).
  return teardownClean(result) ? 0 : 1;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = args(rest);
  const log = (line) => console.log(line);
  if (command === "prepare") return prepare(opts);
  if (command === "check") {
    const options = checkOptions(opts);
    const { api, accountId, secrets: known } = await account();
    const dir = workDir(options.run);
    const secrets = new Set(known);
    const cos = cosRunner({
      cli: join(ROOT, "packages/create-composable-os/dist/cli.js"),
      productFile: join(dir, "product.json"),
      bundleDir: join(dir, "bundles"),
      env: process.env,
      secrets: () => [...secrets],
      log,
    });
    const results = await check(options, {
      api,
      accountId,
      cos,
      fetchImpl: fetch,
      dir,
      log,
      secrets,
      mask,
      writeSummary: summary,
    });
    return verdict(results).proved ? 0 : 1;
  }
  if (command === "teardown") {
    const prefix = prefixOf(opts.run);
    const { api, accountId, secrets } = await account();
    const dir = workDir(opts.run);
    const code = await teardownCommand(prefix, {
      api,
      accountId,
      dir,
      secrets,
      writeSummary: summary,
      log,
    });
    // The keys file, the exports (with their secrets.json) and the releases: deleted.
    rmSync(dir, { recursive: true, force: true });
    log(`Deleted the run's local folder (keys file, exports, releases).`);
    return code;
  }
  if (command === "remove") {
    const prefix = targetPrefix(opts.target);
    const { api, accountId, secrets } = await account();
    return teardownCommand(prefix, {
      api,
      accountId,
      dir: null,
      secrets,
      // The zones the run used: their routes, records and custom hostnames are looked at too.
      zones: [opts.zone, opts["client-zone"]],
      writeSummary: summary,
      log,
    });
  }
  console.error(
    "usage: node scripts/fleet-staging-check.mjs prepare|check|teardown|remove (see the top of this file)",
  );
  return 2;
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
