#!/usr/bin/env node
// The staging check of a host of many clients (stage 66; .github/workflows/fleet-staging-check.yml):
// a throwaway staging fleet on the fleet's account, run through every operator command on real
// Cloudflare, then deleted. Run by hand only, from GitHub Actions.
//
//   node scripts/fleet-staging-check.mjs prepare  --run <id>            no secret: the throwaway
//        product's files, and two releases built for it (<version>, then <version + 1>)
//   node scripts/fleet-staging-check.mjs check    --run <id> [--location oc] [--zone z]
//        [--sending-domain d] [--ai off|on]                            steps 1 to 8, each timed
//   node scripts/fleet-staging-check.mjs teardown --run <id>            step 9: delete it all
//   node scripts/fleet-staging-check.mjs remove   --target <run id | cosstg-<run id>>
//        what a failed run left, by the same rule, and what remains
//
// Everything the run makes is named from one throwaway prefix, `cosstg-<run id>` (the product's id,
// so every Worker, database, bucket, queue, namespace and index is `cosstg-<run id>-…`), and the
// hostnames are under `cosstg-<run id>.<zone>`. Teardown deletes only what is named so: the names
// recorded as the run went (`ledger.json`) and what the account lists under the prefix, by exact
// name. Nothing else in the account is touched.
//
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read from the environment of `check`,
// `teardown` and `remove` only. Nothing here prints them, the account's workers.dev subdomain, a
// key or a password: each is masked in the log (`::add-mask::`) and cut out of every line written.
// The keys file and the exports are in RUNNER_TEMP, outside the checkout, and deleted at the end.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

// --- the account's inventory and its teardown -----------------------------------------------------

/**
 * Everything in the account named with `prefix`: Workers (their Durable Object namespaces, secrets
 * and workers.dev routes go with them), Custom Domains (by hostname label or Worker), D1 databases,
 * R2 buckets, KV namespaces, queues, Vectorize indexes, Workflows and AI Gateways. Each kind that
 * cannot be listed is named in `unlisted` (the token may lack its permission).
 */
export async function inventory(api, accountId, prefix) {
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

/** The order things are deleted in: what routes to a Worker, the Workers, then what they bound. */
const ORDER = ["domain", "worker", "queue", "workflow", "r2", "d1", "kv", "vectorize", "gateway"];

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
  return item.kind === "domain" ? item.name.split(".").includes(prefix) : owned(item.name, prefix);
}

/**
 * Deletes what the run made: the items recorded as it went and what the account lists under the
 * prefix now (each by its exact name; an id is looked up again, as an object may have been made
 * again since). Then lists the prefix once more: `remaining` is what is still there.
 */
export async function teardown(api, accountId, prefix, recorded = []) {
  const now = await inventory(api, accountId, prefix);
  const byKey = new Map(now.items.map((i) => [key(i), i]));
  // A recorded item of a kind the account listed, and no longer listed, is gone already. One of a
  // kind it could not list is deleted by the name (and id) recorded. One that is not the run's is
  // never touched.
  for (const item of recorded) {
    if (!isRuns(item, prefix) || byKey.has(key(item))) continue;
    byKey.set(key(item), { ...item, gone: !now.unlistedKinds.includes(item.kind) });
  }
  const deleted = [];
  let failed = [];
  let todo = [...byKey.values()]
    .filter((item) => !item.gone) // recorded, and no longer listed: already gone
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  // Twice: something another of the run's things still used may go once that one has gone.
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    failed = [];
    for (const item of todo) {
      try {
        const objects = await deleteItem(api, accountId, item);
        deleted.push({
          kind: item.kind,
          name: item.name,
          ...(typeof objects === "number" ? { objects } : {}),
        });
      } catch (error) {
        failed.push({ item, kind: item.kind, name: item.name, error: firstError(error.message) });
      }
    }
    todo = failed.map((f) => f.item);
  }
  failed = failed.map(({ item: _item, ...f }) => f);
  const after = await inventory(api, accountId, prefix);
  return {
    deleted,
    failed,
    remaining: after.items.map((i) => ({ kind: i.kind, name: i.name })),
    unlisted: after.unlisted,
  };
}

/** The teardown's report, for the job summary. */
export function teardownReport(result, prefix) {
  const lines = [`### Teardown of ${prefix}`, ""];
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
      : `Nothing with the prefix ${prefix} is left in the account.`,
  );
  if (result.unlisted.length) {
    lines.push("", `Could not list (so not checked): ${result.unlisted.map(md).join("; ")}`);
  }
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

/** Attaches the hostnames to the app Worker as Custom Domains (cos attaches none). */
async function attach(ctx, hostnames) {
  if (!ctx.zoneId) return;
  for (const hostname of hostnames) {
    await ctx.api.putDomain(ctx.accountId, hostname, workerName(ctx.prefix, "app"), ctx.zoneId);
    ctx.record({ kind: "domain", name: hostname });
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
  return { status: answer.status, text };
}

async function clientList(ctx) {
  const run = await must(ctx, ["client", "list"]);
  return parseClientList(run.out);
}

/** The export's manifest: its row counts and its files' hashes. */
function exportFacts(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return {
    counts: manifest.database?.counts ?? {},
    files: (manifest.files ?? []).map((f) => `${f.key} ${f.sha256}`).sort(),
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

/** Steps 1 to 8 (docs/deploying.md, "Proving a host of many clients on Cloudflare"). */
export function checkSteps() {
  const { a, b, imported, late } = CLIENTS;
  const needZone = (ctx) => {
    if (!ctx.zoneId)
      return {
        status: "skipped",
        note: "no zone given: no client hostname is reachable without one (see the first step)",
      };
    return null;
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
            "no zone given: cos attaches no hostname to the host, so without a zone no client is reachable; the steps that need one are skipped",
          );
        }
        const before = await inventory(ctx.api, ctx.accountId, ctx.prefix);
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
          ctx.ai,
          "--yes",
        ]);
        await ctx.snapshot();
        await attach(ctx, [ctx.hosts.callback]);
        const notes = [
          `installed ${VERSIONS.from} in ${(install.ms / 1000).toFixed(0)} s (AI ${ctx.ai}, location ${ctx.location})`,
        ];
        if (ctx.zoneId) {
          const health = await hostHealth(ctx, VERSIONS.from);
          if (!health.ok)
            fail(
              `the host's health on the callback hostname did not answer ${VERSIONS.from} (last: ${health.status}${health.error ? ` ${health.error}` : ""})`,
            );
          notes.push("the callback hostname answers the host's health");
        }
        return { note: notes.join("; ") };
      },
    },
    {
      id: "add",
      needs: ["install"],
      name: "2. cos client add, two clients",
      async run(ctx) {
        const first = await must(ctx, [
          "client",
          "add",
          a,
          "--location",
          ctx.location,
          "--web-hostname",
          ctx.hosts.web,
          "--yes",
        ]);
        const second = await must(ctx, ["client", "add", b, "--location", ctx.location, "--yes"]);
        await attach(ctx, [ctx.hosts.staff[a], ctx.hosts.staff[b]]);
        const reported = (out) => /Added \S+ in ([\d.]+) s/.exec(out)?.[1];
        return {
          note: `${a}: ${reported(first.out) ?? "?"} s inside cos, ${(first.ms / 1000).toFixed(1)} s for the command (with --web-hostname ${ctx.hosts.web}, accepted without DNS); ${b}: ${reported(second.out) ?? "?"} s, ${(second.ms / 1000).toFixed(1)} s`,
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
        const skip = needZone(ctx);
        if (skip) return { status: "partial", note: `${notes.join("; ")}; ${skip.note}` };
        for (const id of [a, b]) {
          const page = await waitFor(
            ctx.fetch,
            `https://${ctx.hosts.staff[id]}/sign-in`,
            (x) => x.status === 200,
            { timeoutMs: ctx.waitMs, sleep: ctx.sleep },
          );
          if (!page.ok)
            fail(
              `${id}'s staff sign-in page did not answer 200 (last: ${page.status}${page.error ? ` ${page.error}` : ""})`,
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
        const other = await staffOp(ctx, ctx.hosts.staff[b], ctx.staff[a].cookie, "person.list");
        const none = await staffOp(ctx, ctx.hosts.staff[b], "", "person.list");
        if (other.status < 400 || other.status !== none.status || other.text !== none.text) {
          fail(
            `${a}'s session at ${b}'s address answered ${other.status}, not as no session (${none.status})`,
          );
        }
        const crossed = await signIn(
          ctx,
          ctx.hosts.staff[a],
          ctx.staff[b].email,
          ctx.staff[b].password,
        );
        if (crossed.status === 200) fail(`${b}'s staff signed in at ${a}'s address`);
        notes.push(
          `each client's staff session works at its own address; ${a}'s is no session at ${b}'s, and ${b}'s password signs in nowhere at ${a}'s (${crossed.status})`,
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
        notes.push(
          upload.status >= 200 && upload.status < 300
            ? `a picture uploaded at ${a}`
            : `the picture upload at ${a} answered ${upload.status} (the export then carries no file)`,
        );
        return { note: notes.join("; ") };
      },
    },
    {
      id: "sender",
      needs: ["add"],
      name: "4. cos client sender add, verify; sending",
      async run(ctx) {
        await must(ctx, ["client", "sender", "add", a, ctx.hosts.sender, "--yes"]);
        await must(ctx, ["client", "sender", "verify", a, ctx.hosts.sender, "--yes"]);
        await must(ctx, ["client", "sender", "unverify", a, ctx.hosts.sender, "--yes"]);
        const notes = [
          `${ctx.hosts.sender} added to ${a} unverified, verified, then unverified again`,
        ];
        // `cos fleet install` installs no gatekeeper (a fleet's state lists none), so there is no
        // email-send Worker to send from, verified domain or not.
        notes.push(
          "a send (refused for an unverified domain, or a real one) is not checked: a fleet is installed with no gatekeepers, so no email-send Worker is deployed to send from",
        );
        if (ctx.sendingDomain)
          notes.push(
            `the sending domain ${ctx.sendingDomain} was given and not used, for the same reason`,
          );
        else notes.push("no sending domain was given");
        return { status: "partial", note: notes.join("; ") };
      },
    },
    {
      id: "upgrade",
      needs: ["add"],
      name: "5. cos fleet upgrade: a failed migration, a failed smoke check, then a success",
      async run(ctx) {
        const notes = [];
        const before = await clientList(ctx);
        const upgrade = (env) =>
          ctx.cos(
            ["fleet", "upgrade", "--keys-file", ctx.keysFile, "--version", VERSIONS.to, "--yes"],
            env ? { env } : {},
          );
        // 1. bravo's migration fails: alpha (migrated first) and bravo restored, nothing uploaded.
        const one = await upgrade({ COS_FLEET_FORCE_FAILURE: `migration:${b}` });
        if (one.code === 0) fail("the upgrade with a failing migration succeeded");
        if (!/stopped before any upload/.test(one.out))
          fail(
            `the failed migration did not stop the update before the upload: ${firstError(one.out)}`,
          );
        const restored = /stopped before any upload: (.*?) restored/.exec(one.out)?.[1] ?? "";
        if (!restored.includes(a) || !restored.includes(b))
          fail(`not every client was restored (${restored})`);
        const afterOne = await clientList(ctx);
        for (const id of [a, b]) {
          if (
            afterOne[id]?.status !== before[id]?.status ||
            afterOne[id]?.schema !== before[id]?.schema
          ) {
            fail(
              `${id} is ${JSON.stringify(afterOne[id])} after the failed migration, was ${JSON.stringify(before[id])}`,
            );
          }
        }
        if (ctx.zoneId) {
          const health = await hostHealth(ctx, VERSIONS.from);
          if (!health.ok)
            fail(`after the failed migration the host does not answer ${VERSIONS.from}`);
        }
        notes.push(
          `a failing migration on ${b}: stopped (${(one.ms / 1000).toFixed(0)} s), ${restored} restored, both as they were, nothing uploaded${ctx.zoneId ? ` (${VERSIONS.from} still answers)` : ""}`,
        );
        // 2. The smoke check fails after the upload: the previous Workers again, everyone restored.
        const two = await upgrade({ COS_FLEET_FORCE_FAILURE: "smoke" });
        if (two.code === 0) fail("the upgrade with a failing smoke check succeeded");
        if (!/Rolled back/.test(two.out))
          fail(`the failed smoke check was not rolled back: ${firstError(two.out)}`);
        if (ctx.zoneId) {
          const health = await hostHealth(ctx, VERSIONS.from);
          if (!health.ok) fail(`after the rollback the host does not answer ${VERSIONS.from}`);
        }
        notes.push(
          `a failing smoke check: rolled back (${(two.ms / 1000).toFixed(0)} s)${ctx.zoneId ? `, ${VERSIONS.from} answers again` : ""}`,
        );
        // 3. A real one.
        if (!ctx.zoneId) {
          notes.push(
            `the successful upgrade is not run: its smoke check needs the callback hostname, which needs a zone`,
          );
          return { status: "partial", note: notes.join("; ") };
        }
        const three = await upgrade(null);
        if (three.code !== 0)
          fail(`the upgrade to ${VERSIONS.to} failed: ${firstError(three.out)}`);
        const health = await hostHealth(ctx, VERSIONS.to);
        if (!health.ok) fail(`after the upgrade the host does not answer ${VERSIONS.to}`);
        const after = await clientList(ctx);
        for (const id of [a, b])
          if (after[id]?.status !== "active")
            fail(`${id} is ${after[id]?.status} after the upgrade`);
        for (const id of [a, b]) {
          const page = await waitFor(
            ctx.fetch,
            `https://${ctx.hosts.staff[id]}/sign-in`,
            (x) => x.status === 200,
            { timeoutMs: ctx.waitMs, sleep: ctx.sleep },
          );
          if (!page.ok) fail(`${id}'s sign-in page answers ${page.status} after the upgrade`);
        }
        notes.push(
          `then ${VERSIONS.from} → ${VERSIONS.to} (${(three.ms / 1000).toFixed(0)} s): ${VERSIONS.to} answers, both clients served`,
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
        await attach(ctx, [ctx.hosts.staff[imported]]);
        await must(ctx, ["client", "export", imported, "--out", ctx.reexportDir, "--yes"]);
        const first = exportFacts(ctx.exportDir);
        const again = exportFacts(ctx.reexportDir);
        const problems = compareExports(first, again);
        if (problems.length)
          fail(`the imported client differs: ${problems.slice(0, 5).join("; ")}`);
        const notes = [
          `${a} exported (${Object.keys(first.counts).length} tables, ${Object.values(first.counts).reduce((x, y) => x + y, 0)} rows, ${first.files.length} files), imported as ${imported}, exported again: the same row counts and file hashes`,
        ];
        if (ctx.zoneId) {
          const page = await waitFor(
            ctx.fetch,
            `https://${ctx.hosts.staff[imported]}/sign-in`,
            (x) => x.status === 200,
            { timeoutMs: ctx.waitMs, sleep: ctx.sleep },
          );
          if (!page.ok) fail(`${imported}'s sign-in page answered ${page.status}`);
          notes.push(`${imported}'s sign-in page answers`);
        }
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
        const first = ctx.cos(["client", "add", late, "--yes"], {
          onOutput: (out) => {
            if (/registry: /.test(out)) started();
          },
        });
        await Promise.race([holding, first]);
        const second = await ctx.cos(["client", "export", b, "--yes"]);
        const firstRun = await first;
        if (second.code === 0) fail("the second command was not refused");
        if (!/Another operator's command/.test(second.out))
          fail(`the second command failed otherwise: ${firstError(second.out)}`);
        if (firstRun.code !== 0) fail(`the first command failed: ${firstError(firstRun.out)}`);
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
        const skip = needZone(ctx);
        if (skip) return { status: "partial", note: `${a} removed, ${b} active; ${skip.note}` };
        // The host serves the change within its registry refresh (10 s).
        const gone = await waitFor(
          ctx.fetch,
          `https://${ctx.hosts.staff[a]}/sign-in`,
          (x) => x.status === 404,
          { timeoutMs: 120000, sleep: ctx.sleep },
        );
        if (!gone.ok) fail(`${a}'s address still answers ${gone.status}`);
        const page = await request(ctx.fetch, `https://${ctx.hosts.staff[b]}/sign-in`);
        if (page.status !== 200) fail(`${b}'s sign-in page answers ${page.status}`);
        if (ctx.staff[b]) {
          const own = await staffOp(ctx, ctx.hosts.staff[b], ctx.staff[b].cookie, "person.list");
          if (own.status !== 200) fail(`${b}'s staff session answers ${own.status}`);
        }
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

function account() {
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
  return { api, accountId, token };
}

/** `prepare`: the product's files and the two releases, merged into one folder. No secret. */
async function prepare(opts) {
  const run = opts.run;
  const dir = workDir(run);
  const product = productDefinition(run, ENV.GITHUB_REPOSITORY || undefined);
  writeFileSync(join(dir, "product.json"), `${JSON.stringify(product, null, 2)}\n`);
  writeFileSync(
    join(dir, "product.ts"),
    `export const product = ${JSON.stringify(product, null, 2)};\n`,
  );
  const bundles = join(dir, "bundles");
  mkdirSync(bundles, { recursive: true });
  let sums = "";
  for (const [i, version] of [VERSIONS.from, VERSIONS.to].entries()) {
    const out = join(dir, `release-${version}`);
    const argv = [
      "scripts/release/build-release.ts",
      "--version",
      version,
      "--product",
      join(dir, "product.ts"),
      "--out",
      out,
    ];
    // The second build reuses the first's Workers: only the version differs.
    if (i > 0) argv.push("--skip-build");
    const code = await new Promise((done) => {
      spawn(process.execPath, argv, { cwd: ROOT, stdio: "inherit" }).on("close", done);
    });
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
  const ai = opts.ai || "off";
  if (ai !== "on" && ai !== "off") throw new Error("--ai is on or off");
  const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const zone = (opts.zone || "").trim().toLowerCase();
  if (zone && !hostname.test(zone)) throw new Error("--zone is a domain name");
  const sendingDomain = (opts["sending-domain"] || "").trim().toLowerCase();
  if (sendingDomain && !hostname.test(sendingDomain))
    throw new Error("--sending-domain is a domain name");
  return { run: String(opts.run), prefix: prefixOf(opts.run), location, ai, zone, sendingDomain };
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
      for (const item of (await inventory(api, accountId, options.prefix)).items) record(item);
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
      `Location ${options.location}, AI ${options.ai}, zone ${options.zone || "none"}, releases ${VERSIONS.from} and ${VERSIONS.to} built from this commit for the throwaway product.`,
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
  const result = await teardown(api, accountId, prefix, recorded);
  const report = teardownReport(result, prefix);
  log(report);
  writeSummary(report);
  return result.remaining.length || result.failed.length ? 1 : 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = args(rest);
  const log = (line) => console.log(line);
  if (command === "prepare") return prepare(opts);
  if (command === "check") {
    const options = checkOptions(opts);
    const { api, accountId, token } = account();
    const dir = workDir(options.run);
    const secrets = new Set([token, accountId]);
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
    return results.some((r) => r.status === "fail") ? 1 : 0;
  }
  if (command === "teardown") {
    const prefix = prefixOf(opts.run);
    const { api, accountId } = account();
    const dir = workDir(opts.run);
    const code = await teardownCommand(prefix, { api, accountId, dir, writeSummary: summary, log });
    // The keys file, the exports (with their secrets.json) and the releases: deleted.
    rmSync(dir, { recursive: true, force: true });
    log(`Deleted the run's local folder (keys file, exports, releases).`);
    return code;
  }
  if (command === "remove") {
    const prefix = targetPrefix(opts.target);
    const { api, accountId } = account();
    return teardownCommand(prefix, { api, accountId, dir: null, writeSummary: summary, log });
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
