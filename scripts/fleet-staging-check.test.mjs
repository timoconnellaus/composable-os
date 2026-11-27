// The staging check's logic (fleet-staging-check.mjs) against the fake Cloudflare API the CLI's
// tests use: the names, what teardown lists and deletes (and refuses to touch), a run that fails
// half-way, and that no secret reaches what is written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineProduct } from "../packages/product/src/index.ts";
import { CloudflareClient } from "../packages/release/src/cloudflare.ts";
import { FakeCloudflare } from "../packages/release/src/testing/fake-cloudflare.ts";
import { nodeSqliteEngine } from "../packages/release/src/testing/node-sqlite.ts";
import {
  check,
  checkOptions,
  compareExports,
  explainFailure,
  hostnamesOf,
  inventory,
  owned,
  parseClientList,
  prefixOf,
  productDefinition,
  runSteps,
  sanitize,
  summaryTable,
  targetPrefix,
  teardown,
  teardownCommand,
} from "./fleet-staging-check.mjs";

const TOKEN = "fake-token-0123456789";
const ACCOUNT = "acc0000000000000000000000000stg";
const PREFIX = prefixOf("123");

function world() {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: nodeSqliteEngine,
    subdomain: "secret-subdomain",
    zones: [{ id: "zone000000000000000000000000001", name: "fleet.example", status: "active" }],
  });
  const api = new CloudflareClient({
    token: TOKEN,
    apiBase: "https://api.fake/client/v4",
    fetch: (input, init) => cf.fetch(input, init),
  });
  return { cf, api };
}

const script = (name) => ({
  name,
  versions: [],
  secrets: new Map(),
  schedules: [],
  workersDev: false,
  bindings: [],
  tags: [],
});

/** What an install of the run's fleet makes, and one thing of another product's beside it. */
async function seed(cf, api, prefix = PREFIX) {
  for (const name of [
    `${prefix}-app-staging`,
    `${prefix}-runner-staging`,
    `${prefix}-operator-staging`,
    "crm-app",
  ]) {
    cf.scripts.set(name, script(name));
  }
  await api.createD1(ACCOUNT, `${prefix}-registry-staging`);
  await api.createD1(ACCOUNT, `${prefix}-staging`);
  await api.createD1(ACCOUNT, "crm");
  await api.createR2(ACCOUNT, `${prefix}-exports-staging`);
  await api.createR2(ACCOUNT, `${prefix}-blobs-staging`);
  await api.createR2(ACCOUNT, "crm-blobs");
  await api.createKv(ACCOUNT, `${prefix}-oauth-staging`);
  const queue = await api.createQueue(ACCOUNT, `${prefix}-app-fanout-staging`);
  await api.createQueue(ACCOUNT, "crm-events");
  await api.putQueueConsumer(ACCOUNT, queue.queue_id, `${prefix}-app-staging`, {});
  cf.workflows.set(`${prefix}-automation-staging`, {
    className: "AutomationWorkflow",
    script: `${prefix}-runner-staging`,
  });
  cf.workflows.set("crm-automation", { className: "AutomationWorkflow", script: "crm-runner" });
  await api.putDomain(
    ACCOUNT,
    `alpha-admin.${prefix}.fleet.example`,
    `${prefix}-app-staging`,
    "zone000000000000000000000000001",
  );
  await api.putDomain(ACCOUNT, "crm.fleet.example", "crm-app", "zone000000000000000000000000001");
  // The exports bucket holds an export (more than a page of keys); the blobs bucket a picture.
  for (let i = 0; i < 3; i++)
    cf.r2Objects.set(`${prefix}-exports-staging/alpha/g/s/database/${i}.json`, new Uint8Array([i]));
  cf.r2Objects.set(`${prefix}-blobs-staging/clients/alpha/media/probe.png`, new Uint8Array([1]));
  cf.r2Objects.set("crm-blobs/media/keep.png", new Uint8Array([2]));
}

const others = (cf) => ({
  scripts: [...cf.scripts.keys()].filter((n) => !owned(n, PREFIX)),
  d1: [...cf.d1.values()].map((d) => d.name).filter((n) => !owned(n, PREFIX)),
  r2: [...cf.r2].filter((n) => !owned(n, PREFIX)),
  queues: [...cf.queues.values()].map((q) => q.name).filter((n) => !owned(n, PREFIX)),
  workflows: [...cf.workflows.keys()].filter((n) => !owned(n, PREFIX)),
  domains: cf.domains.map((d) => d.hostname).filter((h) => !h.split(".").includes(PREFIX)),
  objects: [...cf.r2Objects.keys()].filter((k) => !owned(k.split("/")[0], PREFIX)),
});

test("names: one throwaway prefix from the run id, exact, and a product cos and the build accept", () => {
  assert.equal(PREFIX, "cosstg-123");
  assert.throws(() => prefixOf("12; rm -rf"), /digits/);
  assert.equal(targetPrefix("123"), "cosstg-123");
  assert.equal(targetPrefix("cosstg-123"), "cosstg-123");
  for (const bad of ["", "cosstg-", "crm", "cosstg-12*", "cos", "cosstg-123-app"]) {
    assert.throws(() => targetPrefix(bad), /run id/, bad);
  }
  assert.ok(owned("cosstg-123-app-staging", PREFIX));
  assert.ok(owned("cosstg-123", PREFIX));
  // A longer run id is another run's.
  assert.ok(!owned("cosstg-1234-app", PREFIX));
  assert.ok(!owned("crm-app", PREFIX));
  const product = defineProduct(productDefinition("123"));
  assert.equal(product.id, PREFIX);
  for (const name of Object.values(product.names)) assert.ok(name.startsWith(`${PREFIX}`), name);
  const hosts = hostnamesOf(PREFIX, "fleet.example");
  assert.equal(hosts.domain, "cosstg-123.fleet.example");
  assert.equal(hosts.callback, "callback.cosstg-123.fleet.example");
  assert.equal(hosts.staff.alpha, "alpha-admin.cosstg-123.fleet.example");
  // A client's web hostname is never under the fleet's domain.
  assert.ok(!hosts.web.endsWith("fleet.example"));
  assert.equal(hostnamesOf(PREFIX, "").domain, "cosstg-123.invalid");
});

test("the inputs are checked", () => {
  assert.deepEqual(checkOptions({ run: "9" }), {
    run: "9",
    prefix: "cosstg-9",
    location: "oc",
    ai: "off",
    zone: "",
    sendingDomain: "",
  });
  assert.throws(() => checkOptions({ run: "9", location: "mars" }), /location/);
  assert.throws(() => checkOptions({ run: "9", ai: "maybe" }), /ai/);
  assert.throws(() => checkOptions({ run: "9", zone: "not a zone" }), /zone/);
  assert.throws(() => checkOptions({ run: "9", "sending-domain": "x;y" }), /sending/);
  assert.throws(() => checkOptions({ run: "x" }), /digits/);
});

test("the inventory lists every kind the run made, and nothing of anyone else's", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const { items, unlisted } = await inventory(api, ACCOUNT, PREFIX);
  assert.deepEqual(unlisted, []);
  assert.deepEqual(items.map((i) => `${i.kind} ${i.name}`).sort(), [
    "d1 cosstg-123-registry-staging",
    "d1 cosstg-123-staging",
    "domain alpha-admin.cosstg-123.fleet.example",
    "kv cosstg-123-oauth-staging",
    "queue cosstg-123-app-fanout-staging",
    "r2 cosstg-123-blobs-staging",
    "r2 cosstg-123-exports-staging",
    "worker cosstg-123-app-staging",
    "worker cosstg-123-operator-staging",
    "worker cosstg-123-runner-staging",
    "workflow cosstg-123-automation-staging",
  ]);
});

test("teardown deletes all of it (buckets emptied first), lists nothing left, and touches nothing else", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const before = others(cf);
  const result = await teardown(api, ACCOUNT, PREFIX);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.deleted.length, 11);
  // In order: the domain before its Worker, the Workers before what they bound.
  assert.equal(result.deleted[0].kind, "domain");
  assert.ok(
    result.deleted.findIndex((d) => d.kind === "worker") <
      result.deleted.findIndex((d) => d.kind === "queue"),
  );
  assert.equal(result.deleted.find((d) => d.name === `${PREFIX}-exports-staging`).objects, 3);
  assert.deepEqual(others(cf), before);
  // Nothing of the run remains in any store of the fake.
  assert.ok(![...cf.r2Objects.keys()].some((k) => k.startsWith(PREFIX)));
  // A second teardown finds nothing and deletes nothing.
  const again = await teardown(api, ACCOUNT, PREFIX);
  assert.deepEqual(again.deleted, []);
  assert.deepEqual(again.remaining, []);
});

test("teardown names what it could not delete and what is left, and the command fails", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const registry = [...cf.d1].find(([, d]) => d.name === `${PREFIX}-registry-staging`)[0];
  cf.failOn = (method, path) =>
    method === "DELETE" && path.endsWith(`/d1/database/${registry}`)
      ? new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 7500, message: "internal error" }],
            result: null,
          }),
          { status: 500 },
        )
      : undefined;
  let written = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir: null,
    log: () => {},
    writeSummary: (t) => {
      written += t;
    },
  });
  assert.equal(code, 1);
  assert.match(written, /Could not delete \(1\):/);
  assert.match(written, /d1 `cosstg-123-registry-staging`: .*internal error/);
  assert.match(written, /Still there with the prefix \(1\):\*\* d1 `cosstg-123-registry-staging`/);
  // Everything else went.
  assert.equal((await inventory(api, ACCOUNT, PREFIX)).items.length, 1);
});

test("teardown never deletes a recorded name that is not the run's", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const recorded = [
    { kind: "worker", name: "crm-app" },
    { kind: "domain", name: "crm.fleet.example" },
    { kind: "worker", name: `${PREFIX}-app-staging` },
  ];
  await teardown(api, ACCOUNT, PREFIX, recorded);
  assert.ok(cf.scripts.has("crm-app"));
  assert.ok(cf.domains.some((d) => d.hostname === "crm.fleet.example"));
});

test("a run that fails half-way: the later steps are skipped, the summary says why, and teardown leaves nothing", async () => {
  const { cf, api } = world();
  const dir = mkdtempSync(join(tmpdir(), "s66s7-stg-"));
  const commands = [];
  // cos as it would behave on an account whose plan has no Queues: the install makes some of the
  // fleet, then the first client's add fails.
  const cos = async (args) => {
    commands.push(args.join(" "));
    if (args[0] === "fleet" && args[1] === "keys") {
      writeFileSync(args[3], "{}", { mode: 0o600 });
      return { code: 0, out: "Wrote the staging deployment's keys", ms: 5 };
    }
    if (args[0] === "fleet" && args[1] === "install") {
      await seed(cf, api);
      return { code: 0, out: "Done: the staging host is 0.1.0.", ms: 50 };
    }
    if (args[0] === "client" && args[1] === "add") {
      return {
        code: 1,
        out: `Error: POST /accounts/${ACCOUNT}/queues failed (HTTP 403): 11001: Queues are not entitled on this plan`,
        ms: 7,
      };
    }
    return { code: 0, out: "", ms: 1 };
  };
  let summary = "";
  const secrets = new Set([TOKEN, ACCOUNT]);
  const results = await check(checkOptions({ run: "123" }), {
    api,
    accountId: ACCOUNT,
    cos,
    fetchImpl: async () => new Response("Not found", { status: 404 }),
    dir,
    log: () => {},
    secrets,
    writeSummary: (t) => {
      summary += t;
    },
    sleep: async () => {},
    waitMs: 0,
  });
  const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
  assert.deepEqual(status, {
    account: "pass",
    install: "pass",
    add: "fail",
    requests: "skipped",
    sender: "skipped",
    upgrade: "skipped",
    export: "skipped",
    concurrent: "skipped",
    remove: "skipped",
  });
  const add = results.find((r) => r.id === "add");
  assert.match(add.note, /Queues are not available on this account's plan/);
  // The account id was in cos's error: it is never in the note or the summary.
  assert.ok(!add.note.includes(ACCOUNT));
  assert.ok(!summary.includes(ACCOUNT));
  assert.ok(!summary.includes("secret-subdomain"));
  assert.match(summary, /\| 2\. cos client add, two clients \| \*\*fail\*\* \|/);
  assert.match(summary, /\| 3\. Requests.* \| skipped \| {2}\| needs add \|/);
  // What the install made was recorded as the run went, by exact name.
  const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
  assert.ok(ledger.some((i) => i.kind === "d1" && i.name === `${PREFIX}-registry-staging`));
  assert.ok(!ledger.some((i) => i.name === "crm"));
  // Teardown, from the ledger and the listing: nothing of the run is left, nothing else touched.
  const before = others(cf);
  let report = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir,
    log: () => {},
    writeSummary: (t) => {
      report += t;
    },
  });
  assert.equal(code, 0, report);
  assert.match(report, /Nothing with the prefix cosstg-123 is left in the account\./);
  assert.deepEqual(others(cf), before);
  assert.ok(commands.every((c) => !c.includes(TOKEN)));
});

test("a run that finds the prefix already in the account stops before installing", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const ran = [];
  const results = await check(checkOptions({ run: "123" }), {
    api,
    accountId: ACCOUNT,
    cos: async (args) => {
      ran.push(args.join(" "));
      return { code: 0, out: "", ms: 1 };
    },
    fetchImpl: async () => new Response("", { status: 404 }),
    dir: mkdtempSync(join(tmpdir(), "s66s7-stg-")),
    log: () => {},
    writeSummary: () => {},
  });
  assert.equal(results[0].status, "fail");
  assert.match(results[0].note, /mode remove first/);
  assert.deepEqual(ran, []);
});

test("runSteps: a failure is recorded with its time, and only what needs it is skipped", async () => {
  const results = await runSteps(
    [
      { id: "a", name: "A", run: async () => ({ note: "ok" }) },
      {
        id: "b",
        name: "B",
        needs: ["a"],
        run: async () => {
          throw new Error("broke");
        },
      },
      { id: "c", name: "C", needs: ["b"], run: async () => ({}) },
      { id: "d", name: "D", needs: ["a"], run: async () => ({ status: "partial", note: "half" }) },
      { id: "e", name: "E", needs: ["d"], run: async () => ({}) },
    ],
    {},
  );
  assert.deepEqual(
    results.map((r) => `${r.id}:${r.status}`),
    ["a:pass", "b:fail", "c:skipped", "d:partial", "e:pass"],
  );
  assert.equal(results[1].note, "broke");
  assert.equal(typeof results[1].ms, "number");
  assert.equal(results[2].ms, null);
  assert.match(summaryTable(results), /\| B \| \*\*fail\*\* \| 0\.0 s \| broke \|/);
});

test("what a failure needed, said plainly; secrets cut out; cos's list and exports read", () => {
  assert.match(explainFailure("Error: no workers.dev subdomain"), /workers\.dev subdomain/);
  assert.match(
    explainFailure("POST /accounts/x/workers/dispatch/namespaces failed: Workers for Platforms"),
    /Workers for Platforms/,
  );
  assert.match(
    explainFailure(
      "PUT /accounts/x/workers/domains failed (HTTP 403): 10000: Authentication error",
    ),
    /zone/,
  );
  assert.match(
    explainFailure("GET /accounts/x/d1/database failed (HTTP 403): 10000: Authentication error"),
    /permission/,
  );
  assert.equal(explainFailure("Error: something else"), null);
  assert.equal(
    sanitize(`token ${TOKEN} account ${ACCOUNT}`, [TOKEN, ACCOUNT]),
    "token *** account ***",
  );
  assert.deepEqual(
    parseClientList(
      "2 clients (staging):\n  alpha  active  standard  schema 795\n  bravo  paused  standard  imported  schema none (schema behind)",
    ),
    { alpha: { status: "active", schema: "795" }, bravo: { status: "paused", schema: "none" } },
  );
  const a = { counts: { core_settings: 3, core_user: 1 }, files: ["media/x abc"] };
  assert.deepEqual(compareExports(a, a), []);
  assert.deepEqual(compareExports(a, { counts: { core_settings: 2, core_user: 1 }, files: [] }), [
    "core_settings: 3 rows, then 2",
    "file media/x not imported as it was",
  ]);
});
