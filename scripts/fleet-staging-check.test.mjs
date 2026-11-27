// The staging check's logic (fleet-staging-check.mjs) against the fake Cloudflare API the CLI's
// tests use: the names, what teardown lists and deletes (and refuses to touch), a run that fails
// half-way, what each step demands before it passes, and that no secret reaches what is written.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { defineProduct } from "../packages/product/src/index.ts";
import { CloudflareClient } from "../packages/release/src/cloudflare.ts";
import { FakeCloudflare } from "../packages/release/src/testing/fake-cloudflare.ts";
import { nodeSqliteEngine } from "../packages/release/src/testing/node-sqlite.ts";
import {
  CLIENTS,
  check,
  checkOptions,
  checkSteps,
  compareExports,
  describeFetchError,
  explainFailure,
  exportFacts,
  FIRST_OP_BOUND_MS,
  hostnamesOf,
  inventory,
  owned,
  parseClientList,
  prefixOf,
  productDefinition,
  runSteps,
  STAGING_MIGRATION,
  sanitize,
  settled,
  summaryTable,
  targetPrefix,
  teardown,
  teardownCommand,
  teardownReport,
  VERSIONS,
  verdict,
  workflowProblems,
} from "./fleet-staging-check.mjs";

const TOKEN = "fake-token-0123456789";
const ACCOUNT = "acc0000000000000000000000000stg";
const PREFIX = prefixOf("123");
const ZONE = "zone000000000000000000000000001";

function world() {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: nodeSqliteEngine,
    subdomain: "secret-subdomain",
    zones: [{ id: ZONE, name: "fleet.example", status: "active" }],
  });
  const api = new CloudflareClient({
    token: TOKEN,
    apiBase: "https://api.fake/client/v4",
    fetch: (input, init) => cf.fetch(input, init),
  });
  return { cf, api };
}

/** A Worker in the fake, live with these bindings (a class of its own makes a namespace). */
const script = (name, bindings = []) => ({
  name,
  versions: [{ id: `v-${name}`, metadata: { bindings }, modules: [], sources: {} }],
  current: `v-${name}`,
  secrets: new Map(),
  schedules: [],
  workersDev: false,
  bindings: [],
  tags: [],
});
const ownClass = (className) => ({
  type: "durable_object_namespace",
  name: className,
  class_name: className,
});

/** What an install of the run's fleet makes, and things of another product's beside it. */
async function seed(cf, api, prefix = PREFIX) {
  // As the first real run left them: the app binds its fan-out queue to send to it, and consumes
  // it with a dead-letter queue; the runner consumes its own (run 45966813610).
  cf.scripts.set(
    `${prefix}-app-staging`,
    script(`${prefix}-app-staging`, [
      ownClass("ParkingLedger"),
      { type: "queue", name: "CLIENT_FANOUT", queue_name: `${prefix}-app-fanout-staging` },
    ]),
  );
  cf.scripts.set(
    `${prefix}-runner-staging`,
    script(`${prefix}-runner-staging`, [
      {
        type: "service",
        name: "GATEKEEPER_EMAIL_SEND",
        service: `${prefix}-gatekeeper-email-send-staging`,
      },
    ]),
  );
  cf.scripts.set(
    `${prefix}-client-db-staging`,
    script(`${prefix}-client-db-staging`, [ownClass("ClientDb")]),
  );
  cf.scripts.set(`${prefix}-operator-staging`, script(`${prefix}-operator-staging`));
  // The fleet's email-send gatekeeper (ADR 0618, "A fleet's gatekeepers"), with its own class.
  cf.scripts.set(
    `${prefix}-gatekeeper-email-send-staging`,
    script(`${prefix}-gatekeeper-email-send-staging`, [
      ownClass("EmailSendGatekeeper"),
      { type: "plain_text", name: "SENDER_DOMAINS_PER_CLIENT", text: "true" },
    ]),
  );
  cf.scripts.set("crm-app", script("crm-app", [ownClass("ParkingLedger")]));
  await api.createD1(ACCOUNT, `${prefix}-registry-staging`);
  await api.createD1(ACCOUNT, `${prefix}-staging`);
  await api.createD1(ACCOUNT, "crm");
  await api.createR2(ACCOUNT, `${prefix}-exports-staging`);
  await api.createR2(ACCOUNT, `${prefix}-blobs-staging`);
  await api.createR2(ACCOUNT, "crm-blobs");
  await api.createKv(ACCOUNT, `${prefix}-oauth-staging`);
  const queue = await api.createQueue(ACCOUNT, `${prefix}-app-fanout-staging`);
  await api.createQueue(ACCOUNT, `${prefix}-app-fanout-staging-dlq`);
  const runnerQueue = await api.createQueue(ACCOUNT, `${prefix}-routine-delivery-staging`);
  const crmQueue = await api.createQueue(ACCOUNT, "crm-events");
  await api.putQueueConsumer(
    ACCOUNT,
    queue.queue_id,
    `${prefix}-app-staging`,
    {},
    undefined,
    `${prefix}-app-fanout-staging-dlq`,
  );
  await api.putQueueConsumer(ACCOUNT, runnerQueue.queue_id, `${prefix}-runner-staging`, {});
  // Another product's consumer: never removed.
  await api.putQueueConsumer(ACCOUNT, crmQueue.queue_id, "crm-app", {});
  cf.workflows.set(`${prefix}-automation-staging`, {
    className: "AutomationWorkflow",
    script: `${prefix}-runner-staging`,
  });
  cf.workflows.set(`${prefix}-hello-staging`, {
    className: "HelloWorkflow",
    script: `${prefix}-runner-staging`,
  });
  cf.workflows.set("crm-automation", { className: "AutomationWorkflow", script: "crm-runner" });
  await api.putDomain(
    ACCOUNT,
    `alpha-admin.${prefix}.fleet.example`,
    `${prefix}-app-staging`,
    ZONE,
  );
  await api.putDomain(ACCOUNT, "crm.fleet.example", "crm-app", ZONE);
  // Near misses of the run's hostname label: another run's, and a longer label.
  await api.putDomain(ACCOUNT, `alpha-admin.${prefix}4.fleet.example`, "crm-app", ZONE);
  await api.putDomain(ACCOUNT, `${prefix}x.fleet.example`, "crm-app", ZONE);
  // The exports bucket holds an export; the blobs bucket a picture.
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

const refuse = (code, message, status = 403) =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), {
    status,
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
  // cos takes a product from a file only when every name is its id's (review of #541, F4).
  for (const name of Object.values(product.names)) {
    assert.ok(name === PREFIX || name.startsWith(`${PREFIX}-`), name);
  }
  const hosts = hostnamesOf(PREFIX, "fleet.example");
  assert.equal(hosts.domain, "cosstg-123.fleet.example");
  assert.equal(hosts.callback, "callback.cosstg-123.fleet.example");
  assert.equal(hosts.staff.alpha, "alpha-admin.cosstg-123.fleet.example");
  // A client's web hostname is never under the fleet's domain.
  assert.ok(!hosts.web.endsWith("fleet.example"));
  assert.equal(hostnamesOf(PREFIX, "").domain, "cosstg-123.invalid");
});

test("the inputs are checked, and AI is never on (review of #541, F1)", () => {
  assert.deepEqual(checkOptions({ run: "9" }), {
    run: "9",
    prefix: "cosstg-9",
    location: "oc",
    ai: "off",
    zone: "",
    clientZone: "",
    sendingDomain: "",
  });
  assert.throws(
    () => checkOptions({ run: "9", zone: "z.example", "client-zone": "z.example" }),
    /apart/,
  );
  assert.throws(() => checkOptions({ run: "9", "client-zone": "x;y" }), /client-zone/);
  assert.equal(checkOptions({ run: "9", ai: "off" }).ai, "off");
  assert.throws(() => checkOptions({ run: "9", ai: "on" }), /without AI only/);
  assert.throws(() => checkOptions({ run: "9", location: "mars" }), /location/);
  assert.throws(() => checkOptions({ run: "9", zone: "not a zone" }), /zone/);
  assert.throws(() => checkOptions({ run: "9", "sending-domain": "x;y" }), /sending/);
  assert.throws(() => checkOptions({ run: "x" }), /digits/);
});

test("the inventory lists every kind the run made, its Durable Object namespaces too, and nothing of anyone else's", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const { items, unlisted } = await inventory(api, ACCOUNT, PREFIX);
  assert.deepEqual(unlisted, []);
  assert.deepEqual(items.map((i) => `${i.kind} ${i.name}`).sort(), [
    "d1 cosstg-123-registry-staging",
    "d1 cosstg-123-staging",
    "domain alpha-admin.cosstg-123.fleet.example",
    "durable_object cosstg-123-app-staging_ParkingLedger",
    "durable_object cosstg-123-client-db-staging_ClientDb",
    "durable_object cosstg-123-gatekeeper-email-send-staging_EmailSendGatekeeper",
    "kv cosstg-123-oauth-staging",
    "queue cosstg-123-app-fanout-staging",
    "queue cosstg-123-app-fanout-staging-dlq",
    "queue cosstg-123-routine-delivery-staging",
    "r2 cosstg-123-blobs-staging",
    "r2 cosstg-123-exports-staging",
    "worker cosstg-123-app-staging",
    "worker cosstg-123-client-db-staging",
    "worker cosstg-123-gatekeeper-email-send-staging",
    "worker cosstg-123-operator-staging",
    "worker cosstg-123-runner-staging",
    "workflow cosstg-123-automation-staging",
    "workflow cosstg-123-hello-staging",
  ]);
});

test("the install's Workflows: both of the run's must be listed, paged as the real API pages them", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  assert.deepEqual(await workflowProblems(api, ACCOUNT, PREFIX), []);
  // More Workflows than one page holds, of another product: the run's are still found.
  for (let i = 0; i < 60; i++) cf.workflows.set(`aaa-other-${i}`, { className: "X", script: "x" });
  for (const name of [`${PREFIX}-automation-staging`, `${PREFIX}-hello-staging`]) {
    const flow = cf.workflows.get(name);
    cf.workflows.delete(name);
    cf.workflows.set(name, flow); // listed last, on the second page
  }
  assert.deepEqual(await workflowProblems(api, ACCOUNT, PREFIX), []);
  cf.workflows.delete(`${PREFIX}-hello-staging`);
  assert.deepEqual(await workflowProblems(api, ACCOUNT, PREFIX), [
    `no Workflow ${PREFIX}-hello-staging in the account: the runner's Workflows were not created`,
  ]);
});

test("teardown deletes all of it (buckets emptied first, namespaces with their Workers), lists nothing left, and touches nothing else", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const before = others(cf);
  const result = await teardown(api, ACCOUNT, PREFIX);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.unlisted, []);
  // The namespaces are not deleted on their own: they went with their Workers.
  assert.ok(!result.deleted.some((d) => d.kind === "durable_object"));
  // The run's queues' consumers first (with the dead-letter link), never another's.
  assert.deepEqual(
    result.deleted.filter((d) => d.kind === "consumer").map((d) => d.name),
    [
      `${PREFIX}-app-fanout-staging ← ${PREFIX}-app-staging`,
      `${PREFIX}-routine-delivery-staging ← ${PREFIX}-runner-staging`,
    ],
  );
  assert.equal(result.deleted.filter((d) => d.kind !== "consumer").length, 16);
  // In order: the consumers, the domain before its Worker, the Workers before what they bound.
  assert.equal(result.deleted[0].kind, "consumer");
  assert.equal(result.deleted[2].kind, "domain");
  assert.ok(
    result.deleted.findLastIndex((d) => d.kind === "worker") <
      result.deleted.findIndex((d) => d.kind === "queue"),
  );
  assert.equal([...cf.queues.values()].find((q) => q.name === "crm-events").consumers.length, 1);
  assert.equal(result.deleted.find((d) => d.name === `${PREFIX}-exports-staging`).objects, 3);
  assert.deepEqual(others(cf), before);
  assert.ok(![...cf.r2Objects.keys()].some((k) => k.startsWith(PREFIX)));
  assert.match(
    teardownReport(result, PREFIX),
    /Nothing with the prefix cosstg-123 is left in the account\./,
  );
  // A second teardown finds nothing and deletes nothing.
  const again = await teardown(api, ACCOUNT, PREFIX);
  assert.deepEqual(again.deleted, []);
  assert.deepEqual(again.remaining, []);
});

test("mode remove cleans up what run 45966813610 left, from the prefix listing alone (no ledger)", async () => {
  const { cf, api } = world();
  const prefix = prefixOf("45966813610");
  // What that run left: the app and the runner (each consuming queues, binding them to send,
  // with dead-letter queues), their Durable Object namespaces, twelve queues; beside another
  // product's queue and Worker.
  const queue = async (name) => (await api.createQueue(ACCOUNT, name)).queue_id;
  const bindings = { app: [], runner: [] };
  for (const [worker, names] of [
    ["app", ["app-fanout-staging", "app-parking-staging"]],
    ["runner", ["runner-fanout-staging", "runner-parking-staging"]],
  ]) {
    for (const name of names) {
      const id = await queue(`${prefix}-${name}`);
      await queue(`${prefix}-${name}-dlq`);
      await api.putQueueConsumer(
        ACCOUNT,
        id,
        `${prefix}-${worker}-staging`,
        {},
        undefined,
        `${prefix}-${name}-dlq`,
      );
      bindings[worker].push({
        type: "queue",
        name: name.toUpperCase(),
        queue_name: `${prefix}-${name}`,
      });
    }
  }
  for (const name of ["automation-events", "routine-delivery"]) {
    const id = await queue(`${prefix}-${name}-staging`);
    await queue(`${prefix}-${name}-dlq-staging`);
    await api.putQueueConsumer(
      ACCOUNT,
      id,
      `${prefix}-runner-staging`,
      {},
      undefined,
      `${prefix}-${name}-dlq-staging`,
    );
    bindings.app.push({
      type: "queue",
      name: name.toUpperCase(),
      queue_name: `${prefix}-${name}-staging`,
    });
  }
  cf.scripts.set(
    `${prefix}-app-staging`,
    script(`${prefix}-app-staging`, [
      ownClass("AgentJob"),
      ownClass("ParkingLedger"),
      ...bindings.app,
    ]),
  );
  cf.scripts.set(
    `${prefix}-runner-staging`,
    script(`${prefix}-runner-staging`, [ownClass("ParkingLedger"), ...bindings.runner]),
  );
  cf.scripts.set(
    "crm-app",
    script("crm-app", [{ type: "queue", name: "EVENTS", queue_name: "crm-events" }]),
  );
  await api.putQueueConsumer(ACCOUNT, await queue("crm-events"), "crm-app", {});
  const before = (await inventory(api, ACCOUNT, prefix)).items;
  assert.equal(before.filter((i) => i.kind === "queue").length, 12);
  assert.equal(before.filter((i) => i.kind === "worker").length, 2);
  let report = "";
  const code = await teardownCommand(prefix, {
    api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      report += t;
    },
  });
  assert.equal(code, 0, report);
  assert.match(report, /Nothing with the prefix cosstg-45966813610 is left in the account\./);
  assert.deepEqual((await inventory(api, ACCOUNT, prefix)).items, []);
  // Another product's Worker, queue and consumer are as they were.
  assert.ok(cf.scripts.has("crm-app"));
  assert.equal([...cf.queues.values()].find((q) => q.name === "crm-events").consumers.length, 1);
});

test("a delete answered 404 is gone only if the listing after agrees", async () => {
  for (const reallyGone of [true, false]) {
    const { cf, api } = world();
    await seed(cf, api);
    const domain = cf.domains.find((d) => d.hostname.startsWith(`alpha-admin.${PREFIX}.`));
    cf.failOn = (method, path) => {
      if (method !== "DELETE" || !path.endsWith(`/workers/domains/${domain.id}`)) return undefined;
      // As the first real run's callback domain: "Origin … not found".
      if (reallyGone) cf.domains.splice(cf.domains.indexOf(domain), 1);
      return refuse(100114, `Origin '${domain.id}' not found.`, 404);
    };
    let report = "";
    const code = await teardownCommand(PREFIX, {
      api,
      accountId: ACCOUNT,
      dir: null,
      secrets: [TOKEN, ACCOUNT],
      log: () => {},
      writeSummary: (t) => {
        report += t;
      },
    });
    if (reallyGone) {
      assert.equal(code, 0, report);
      assert.match(
        report,
        /Gone before its delete \(not found, and not listed after\): domain `alpha-admin\.cosstg-123\.fleet\.example`/,
      );
    } else {
      assert.equal(code, 1, report);
      // Not found, yet still listed: left, never counted as gone.
      assert.ok(!/Gone before its delete/.test(report), report);
      assert.match(
        report,
        /Still there with the prefix \(1\):\*\* domain `alpha-admin\.cosstg-123\.fleet\.example`/,
      );
    }
  }
});

test("a delete that failed, then answered not found, names its first answer too", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const domain = cf.domains.find((d) => d.hostname.startsWith(`alpha-admin.${PREFIX}.`));
  let calls = 0;
  cf.failOn = (method, path) => {
    if (method !== "DELETE" || !path.endsWith(`/workers/domains/${domain.id}`)) return undefined;
    calls += 1;
    // The first delete is done and answered with an error; the second finds nothing.
    if (calls === 1) {
      cf.domains.splice(cf.domains.indexOf(domain), 1);
      return refuse(10013, "An unknown error has occurred", 500);
    }
    return refuse(100114, `Origin '${domain.id}' not found.`, 404);
  };
  let report = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      report += t;
    },
  });
  assert.equal(code, 0, report);
  assert.match(report, /domain `alpha-admin[^`]*` \(first: .*An unknown error has occurred\)/);
});

test("a namespace that outlives its Worker's deletion is what is left, and the command fails", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  cf.failOn = (method, path) =>
    method === "DELETE" && path.endsWith(`/scripts/${PREFIX}-client-db-staging`)
      ? refuse(10000, "internal error", 500)
      : undefined;
  let written = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      written += t;
    },
  });
  assert.equal(code, 1);
  assert.match(written, /durable_object `cosstg-123-client-db-staging_ClientDb`/);
});

test("teardown names what it could not delete and what is left, the account cut out, and the command fails (review of #541, F8)", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const registry = [...cf.d1].find(([, d]) => d.name === `${PREFIX}-registry-staging`)[0];
  cf.failOn = (method, path) =>
    method === "DELETE" && path.endsWith(`/d1/database/${registry}`)
      ? refuse(7500, "internal error", 500)
      : undefined;
  let written = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      written += t;
    },
  });
  assert.equal(code, 1);
  assert.match(written, /Could not delete \(1\):/);
  assert.match(written, /d1 `cosstg-123-registry-staging`: .*internal error/);
  assert.match(written, /Still there with the prefix \(1\):\*\* d1 `cosstg-123-registry-staging`/);
  // Cloudflare's error names the call's path, which names the account: never written.
  assert.match(written, /\/accounts\/\*\*\*\/d1/);
  assert.ok(!written.includes(ACCOUNT));
  assert.equal((await inventory(api, ACCOUNT, PREFIX)).items.length, 1);
});

test("a kind that cannot be listed fails the teardown, said first, never 'nothing left' (review of #541, F6)", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  cf.failOn = (method, path) =>
    method === "GET" && path.endsWith("/workflows")
      ? refuse(10000, "Authentication error")
      : undefined;
  let written = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      written += t;
    },
  });
  assert.equal(code, 1);
  const lines = written.split("\n").filter((l) => l.trim());
  assert.match(lines[1], /^\*\*Not checked: 1 kind could not be listed/);
  assert.match(written, /workflow: /);
  assert.ok(!/is left in the account/.test(written));
  assert.match(written, /left among the kinds that could be listed/);
  // The kinds it could list are deleted all the same.
  assert.ok(!cf.scripts.has(`${PREFIX}-app-staging`));
});

test("where a kind cannot be listed, teardown deletes the run's recorded names of a kind deleted by name, never another's, and never by a recorded id (review of #541, F7)", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  // The token cannot list Workers, Custom Domains or D1 (but could delete them).
  cf.failOn = (method, path) =>
    method === "GET" &&
    (path.endsWith("/workers/scripts") ||
      path.endsWith("/workers/domains") ||
      path.endsWith("/d1/database"))
      ? refuse(10000, "Authentication error")
      : undefined;
  const crm = [...cf.d1].find(([, d]) => d.name === "crm")[0];
  const runs = cf.domains.find((d) => d.hostname.startsWith(`alpha-admin.${PREFIX}.`));
  const recorded = [
    { kind: "worker", name: "crm-app", id: "crm-app" },
    { kind: "worker", name: `${PREFIX}-app-staging`, id: `${PREFIX}-app-staging` },
    // A run's name with another's id (a damaged ledger): deleting by that id would delete crm.
    { kind: "d1", name: `${PREFIX}-staging`, id: crm },
    { kind: "domain", name: runs.hostname, id: runs.id },
    { kind: "domain", name: `callback.${PREFIX}.fleet.example` },
  ];
  const result = await teardown(api, ACCOUNT, PREFIX, recorded);
  assert.ok(!cf.scripts.has(`${PREFIX}-app-staging`));
  assert.ok(cf.scripts.has("crm-app"));
  assert.ok([...cf.d1.values()].some((d) => d.name === "crm"));
  // Those deleted by id are not deleted from the ledger: named, and the teardown is not clean.
  assert.deepEqual(result.failed.map((f) => `${f.kind} ${f.name}`).sort(), [
    `d1 ${PREFIX}-staging`,
    `domain alpha-admin.${PREFIX}.fleet.example`,
    `domain callback.${PREFIX}.fleet.example`,
  ]);
  assert.match(result.failed[0].error, /cannot be checked against its name/);
  assert.ok(cf.domains.some((d) => d.hostname === "crm.fleet.example"));
  assert.equal(result.unlisted.length, 3);
});

test("on the zones the run used, teardown deletes the routes, DNS records and custom hostnames cos made, and nothing else (stage 66 step 8)", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const target = `clients.${PREFIX}.fleet.example`;
  cf.addScript(`${PREFIX}-front-staging`);
  await api.ensureProxiedPlaceholder(ZONE, target);
  // The run's install made its target the zone's fallback origin: reset at the teardown (S1).
  await api.putFallbackOrigin(ZONE, target);
  await api.putRoute(ZONE, `${target}/*`, `${PREFIX}-front-staging`);
  await api.createCustomHostnameForCname(ZONE, `www.${PREFIX}.client.example`);
  // Another site's on the same zone, and a near miss of the label.
  await api.ensureProxiedPlaceholder(ZONE, "www.fleet.example");
  await api.putRoute(ZONE, "www.fleet.example/*", "crm-app");
  await api.putRoute(ZONE, `x.${PREFIX}4.fleet.example/*`, "crm-app");
  await api.createCustomHostnameForCname(ZONE, "shop.someone.example");
  // A zone the run never recorded is not looked at.
  const recorded = [{ kind: "dns", name: `${target}#AAAA`, id: "x", zone: ZONE }];
  const result = await teardown(api, ACCOUNT, PREFIX, recorded);
  assert.equal(result.remaining.length, 0, JSON.stringify(result.remaining));
  assert.deepEqual(
    cf.routes.map((r) => r.pattern).sort(),
    [`x.${PREFIX}4.fleet.example/*`, "www.fleet.example/*"].sort(),
  );
  assert.deepEqual(
    cf.dnsRecords.filter((r) => !r.readOnly).map((r) => r.name),
    ["www.fleet.example"],
  );
  assert.deepEqual(
    cf.customHostnames.map((h) => h.hostname),
    ["shop.someone.example"],
  );
  assert.equal(cf.fallbackOrigins.has(ZONE), false);
  assert.ok(result.deleted.some((d) => d.kind === "fallback_origin" && d.name === target));
  // Another's fallback origin is left as it is.
  cf.fallbackOrigins.set(ZONE, "www.fleet.example");
  await teardown(api, ACCOUNT, PREFIX, recorded);
  assert.equal(cf.fallbackOrigins.get(ZONE), "www.fleet.example");
  // Without the zone recorded or named, its routes are never listed.
  cf.addScript(`${PREFIX}-front-staging`);
  await api.ensureProxiedPlaceholder(ZONE, target);
  await api.putRoute(ZONE, `${target}/*`, `${PREFIX}-front-staging`);
  await teardown(api, ACCOUNT, PREFIX, []);
  assert.ok(cf.routes.some((r) => r.pattern === `${target}/*`));
});

test("a Custom Domain goes before DNS records, so its own read-only record goes with it (F5); a zone without Cloudflare for SaaS lists none of its custom hostnames", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  cf.saasOff.add(ZONE);
  const recorded = [{ kind: "domain", name: `alpha-admin.${PREFIX}.fleet.example`, zone: ZONE }];
  const result = await teardown(api, ACCOUNT, PREFIX, recorded);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unlisted, []);
  assert.equal(result.remaining.length, 0, JSON.stringify(result.remaining));
  assert.ok(!cf.dnsRecords.some((r) => r.name === `alpha-admin.${PREFIX}.fleet.example`));
  // Not deleted out of order first and found gone later: no delete was refused on the way.
  assert.deepEqual(
    result.gone.filter((g) => g.before),
    [],
  );
});

test("domains: only a hostname with a label exactly the prefix, or a run's Worker's", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  await teardown(api, ACCOUNT, PREFIX);
  assert.deepEqual(cf.domains.map((d) => d.hostname).sort(), [
    "alpha-admin.cosstg-1234.fleet.example",
    "cosstg-123x.fleet.example",
    "crm.fleet.example",
  ]);
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
      cf.scripts.set(
        `${PREFIX}-app-staging`,
        script(`${PREFIX}-app-staging`, [
          ownClass("ParkingLedger"),
          { type: "plain_text", name: "COS_RELEASE_VERSION", text: VERSIONS.from },
        ]),
      );
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
    // No zone: the install ran, and the host's health was not checked.
    install: "partial",
    add: "fail",
    requests: "skipped",
    front: "skipped",
    sender: "skipped",
    // The install's gatekeeper is checked on the account, apart from the failed add.
    gatekeeper: "pass",
    send: "not checked",
    upgrade: "skipped",
    export: "skipped",
    concurrent: "skipped",
    remove: "skipped",
  });
  const add = results.find((r) => r.id === "add");
  assert.match(add.note, /Queues are not available on this account's plan/);
  assert.ok(!add.note.includes(ACCOUNT));
  assert.ok(!summary.includes(ACCOUNT));
  assert.ok(!summary.includes("secret-subdomain"));
  // The verdict and the zone's absence open the summary.
  assert.match(summary, /^## .*\n\n\*\*Not proved\.\*\* 1 partial, 2 fail, 3 skipped/);
  assert.match(summary, /\*\*No zone:\*\*/);
  assert.match(summary, /\| 2\. cos client add, two clients \| \*\*fail\*\* \|/);
  assert.match(summary, /\| 3\. Requests.* \| skipped \| {2}\| needs add \|/);
  const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
  assert.ok(ledger.some((i) => i.kind === "d1" && i.name === `${PREFIX}-registry-staging`));
  assert.ok(!ledger.some((i) => i.name === "crm"));
  const before = others(cf);
  let report = "";
  const code = await teardownCommand(PREFIX, {
    api,
    accountId: ACCOUNT,
    dir,
    secrets: [TOKEN, ACCOUNT],
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

test("a run that finds the prefix already in the account, or cannot list it, stops before installing", async () => {
  for (const setUp of [
    async (cf, api) => seed(cf, api),
    async (cf) => {
      cf.failOn = (method, path) =>
        method === "GET" && path.endsWith("/workflows")
          ? refuse(10000, "Authentication error")
          : undefined;
    },
  ]) {
    const { cf, api } = world();
    await setUp(cf, api);
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
    assert.match(results[0].note, /mode remove first|cannot be fully listed/);
    assert.deepEqual(ran, []);
  }
});

test("runSteps and the verdict: a partial step lets what needs it run, and fails the run (review of #541, F5)", async () => {
  const results = await runSteps(
    [
      { id: "a", name: "1. A", run: async () => ({ note: "ok" }) },
      {
        id: "b",
        name: "2. B",
        needs: ["a"],
        run: async () => {
          throw new Error("broke");
        },
      },
      { id: "c", name: "3. C", needs: ["b"], run: async () => ({}) },
      {
        id: "d",
        name: "4. D",
        needs: ["a"],
        run: async () => ({ status: "partial", note: "half" }),
      },
      { id: "e", name: "5. E", needs: ["d"], run: async () => ({}) },
      { id: "f", name: "6. F", run: async () => ({ status: "not checked", note: "cannot" }) },
    ],
    {},
  );
  assert.deepEqual(
    results.map((r) => `${r.id}:${r.status}`),
    ["a:pass", "b:fail", "c:skipped", "d:partial", "e:pass", "f:not checked"],
  );
  assert.equal(results[1].note, "broke");
  assert.equal(typeof results[1].ms, "number");
  assert.equal(results[2].ms, null);
  assert.match(summaryTable(results), /\| 2\. B \| \*\*fail\*\* \| 0\.0 s \| broke \|/);
  const v = verdict(results);
  assert.equal(v.proved, false);
  assert.match(v.line, /2 fail, 3 skipped, 4 partial/);
  assert.match(v.line, /Not checked here at all: 6\. F/);
  // Only a partial step short: still not proved.
  assert.equal(
    verdict([
      { name: "1. A", status: "pass" },
      { name: "2. B", status: "partial" },
    ]).proved,
    false,
  );
  assert.equal(
    verdict([
      { name: "1. A", status: "pass" },
      { name: "6. F", status: "not checked" },
    ]).proved,
    true,
  );
});

// --- the steps' own demands, with cos and the hostnames scripted ---------------------------------

const step = (id) => checkSteps().find((s) => s.id === id);
const listing = (rows) =>
  `${Object.keys(rows).length} clients (staging):\n${Object.entries(rows)
    .map(([id, [status, schema]]) => `  ${id}  ${status}  standard  schema ${schema}`)
    .join("\n")}`;

/** The fleet's email-send gatekeeper and runner as deployed, each changeable by a test. */
function gatekeeperBindings({ deployed = true, flag = "true", bound = true } = {}) {
  const gatekeeper = `${PREFIX}-gatekeeper-email-send-staging`;
  const scripts = {
    [`${PREFIX}-runner-staging`]: bound
      ? [{ type: "service", name: "GATEKEEPER_EMAIL_SEND", service: gatekeeper }]
      : [],
  };
  if (deployed) {
    scripts[gatekeeper] = [{ type: "plain_text", name: "SENDER_DOMAINS_PER_CLIENT", text: flag }];
  }
  return { scripts };
}

/** A context for one step: cos answering from `answer(args, env)`, the app Worker at `version`. */
function stepCtx({
  answer,
  version = () => VERSIONS.from,
  fetch,
  zone = true,
  gatekeeper = gatekeeperBindings(),
  saas = true,
}) {
  const hosts = hostnamesOf(PREFIX, zone ? "fleet.example" : "");
  return {
    zone: zone ? "fleet.example" : "",
    prefix: PREFIX,
    run: "123",
    zoneId: zone ? ZONE : null,
    hosts,
    keysFile: "/nonexistent/keys.json",
    accountId: ACCOUNT,
    api: {
      listScripts: async () => Object.keys(gatekeeper.scripts).map((id) => ({ id })),
      saasEnabled: async () => saas,
      scriptBindings: async (_account, name) =>
        gatekeeper.scripts[name] ?? [
          { type: "plain_text", name: "COS_RELEASE_VERSION", text: version() },
        ],
    },
    cos: async (args, options = {}) => answer(args, options.env ?? {}),
    fetch: fetch ?? (async () => new Response("{}", { status: 200 })),
    waitMs: 0,
    sleep: async () => {},
    staff: {},
    secrets: () => [],
    addSecret: () => {},
    record: () => {},
  };
}

/** The upgrade's three runs as cos answers them, with what `cos client list` says between. */
function upgradeCos({ restoreLeavesAlpha = false, uploadsAnyway = false } = {}) {
  const { a, b } = CLIENTS;
  const state = { schema: { [a]: "1450", [b]: "1450" }, version: VERSIONS.from };
  const answer = (args, env) => {
    if (args[1] === "list") {
      return {
        code: 0,
        out: listing({ [a]: ["active", state.schema[a]], [b]: ["active", state.schema[b]] }),
        ms: 1,
      };
    }
    if (env.COS_FLEET_FORCE_FAILURE?.startsWith("migration:")) {
      if (restoreLeavesAlpha) state.schema[a] = String(STAGING_MIGRATION.schema);
      if (uploadsAnyway) state.version = VERSIONS.to;
      return {
        code: 1,
        out: `The update stopped before any upload: ${a}, ${b} restored to their bookmarks; every client is as it was.`,
        ms: 9,
      };
    }
    if (env.COS_FLEET_FORCE_FAILURE === "smoke") {
      return {
        code: 1,
        out: "  smoke check failed: COS_FLEET_FORCE_FAILURE=smoke: made to fail (the staging check)\nRolled back: 0.1.0's Workers again, 2 clients restored.",
        ms: 9,
      };
    }
    state.schema[a] = state.schema[b] = String(STAGING_MIGRATION.schema);
    state.version = VERSIONS.to;
    return { code: 0, out: "Updated 0.1.0 → 0.1.1", ms: 9 };
  };
  return { answer, state };
}
const healthFetch = (state) => async (url) =>
  new Response(
    url.endsWith("/api/health") ? JSON.stringify({ host: true, version: state.version }) : "ok",
    { status: 200 },
  );

test("the upgrade step: its three runs pass only as they should (review of #541, F5)", async () => {
  const good = upgradeCos();
  const ctx = stepCtx({
    answer: good.answer,
    version: () => good.state.version,
    fetch: healthFetch(good.state),
  });
  const ok = await step("upgrade").run(ctx);
  assert.equal(ok.status, undefined, ok.note);
  assert.match(ok.note, /schema 9000/);
  // A restore that left alpha migrated fails.
  const left = upgradeCos({ restoreLeavesAlpha: true });
  await assert.rejects(
    step("upgrade").run(
      stepCtx({
        answer: left.answer,
        version: () => left.state.version,
        fetch: healthFetch(left.state),
      }),
    ),
    /alpha is .* after the failed migration/,
  );
  // An upload in spite of the failed migration fails, seen on the Worker, not in cos's words.
  const uploaded = upgradeCos({ uploadsAnyway: true });
  await assert.rejects(
    step("upgrade").run(
      stepCtx({
        answer: uploaded.answer,
        version: () => uploaded.state.version,
        fetch: healthFetch(uploaded.state),
      }),
    ),
    /something was uploaded/,
  );
  // With no zone, the success is not run: partial.
  const noZone = upgradeCos();
  const partial = await step("upgrade").run(
    stepCtx({ answer: noZone.answer, version: () => noZone.state.version, zone: false }),
  );
  assert.equal(partial.status, "partial");
});

test("a new hostname is waited for until it answers steadily, the wait reported; one that never does fails its step naming it (the third real run)", async () => {
  // Answers once, then nothing (status 0, as bravo did), then steadily.
  const seq = [200, 0, 200, 200, 200];
  const flapping = await settled(
    {
      fetch: async () => {
        const status = seq.shift() ?? 200;
        if (status === 0) throw new TypeError("fetch failed");
        return new Response("ok", { status });
      },
      waitMs: 600000,
      sleep: async () => {},
    },
    "bravo-admin.cosstg-123.fleet.example",
  );
  assert.equal(flapping.ok, true);
  assert.equal(seq.length, 0);
  // The add step: cos told not to wait (the check measures), each hostname's wait in the note.
  const commands = [];
  const answer = (args) => {
    commands.push(args.join(" "));
    if (args[1] === "list") {
      return {
        code: 0,
        out: `2 clients (staging):\n  alpha  active  standard  schema 1450\n  bravo  active  standard  schema 1450`,
        ms: 1,
      };
    }
    return { code: 0, out: "Added x in 1.0 s", ms: 1 };
  };
  const ctx = stepCtx({ answer, fetch: async () => new Response("ok") });
  ctx.api.listDomains = async () =>
    [CLIENTS.a, CLIENTS.b].map((id) => ({
      id: `d-${id}`,
      hostname: ctx.hosts.staff[id],
      service: `${PREFIX}-app-staging`,
    }));
  const added = await step("add").run(ctx);
  assert.match(added.note, /each staff hostname answering steadily after: alpha 0 s, bravo 0 s/);
  assert.ok(
    commands.filter((c) => c.startsWith("client add")).every((c) => c.includes("--no-wait")),
  );
  // One that never answers: the step fails, naming it, not a status 0 on a later assertion.
  const dead = stepCtx({
    answer,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  dead.api.listDomains = ctx.api.listDomains;
  await assert.rejects(
    step("add").run(dead),
    /alpha-admin\.cosstg-123\.fleet\.example did not answer steadily within 0 s \(last: 0/,
  );
});

test("the cos-front step: an unknown hostname's 404, a sibling's change refused, and a client's own domain proved and served (stage 66 step 8)", async () => {
  const front = step("front");
  const ownPolicy = "default-src 'none'; frame-ancestors 'none'";
  const fetchFor =
    (over = {}) =>
    async (url, init = {}) => {
      if (url.startsWith("https://clients.")) {
        return new Response("Not found", {
          status: over.target ?? 404,
          headers: { "content-security-policy": ownPolicy },
        });
      }
      if (init.method === "POST") return new Response("{}", { status: over.sibling ?? 403 });
      return new Response("<h1>Coming soon</h1>", { status: 200 });
    };
  // No client zone: what it can check passes, and the step is partial.
  const partial = await front.run(
    stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), fetch: fetchFor() }),
  );
  assert.equal(partial.status, "partial");
  assert.match(partial.note, /refused \(403\)/);
  // A zone without Cloudflare for SaaS: rule (b) still checked, cos-front partial, never failed.
  const noSaas = await front.run(
    stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), fetch: fetchFor(), saas: false }),
  );
  assert.equal(noSaas.status, "partial");
  assert.match(
    noSaas.note,
    /refused \(403\).*Cloudflare for SaaS is not enabled on fleet\.example/,
  );
  // A sibling's change let through, or the target answering, fails it.
  await assert.rejects(
    front.run(
      stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), fetch: fetchFor({ sibling: 200 }) }),
    ),
    /not 403/,
  );
  await assert.rejects(
    front.run(
      stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), fetch: fetchFor({ target: 200 }) }),
    ),
    /did not answer 404/,
  );
  // With a client zone: the printed records written there, verified once proved, served, removed.
  const written = [];
  const commands = [];
  let verifies = 0;
  const own = `www.${PREFIX}.client.example`;
  const ctx = stepCtx({
    fetch: fetchFor(),
    answer: (args) => {
      commands.push(args.slice(0, 3).join(" "));
      if (args[2] === "add") {
        return {
          code: 0,
          // As cos prints it (clients.ts `dnsInstructions`).
          out: `Added ${own} to alpha:\n  ${own}: unverified, served nowhere yet. The client adds, at its DNS provider:\n    CNAME ${own}  clients.${PREFIX}.fleet.example    (sends its visitors to the host; DNS only (grey cloud), not proxied)\n    TXT   _cos-client.${own}  cos-client=staging:alpha    (says which client of the host, and which environment, the domain is for)\n  then: cos client hostname verify alpha ${own}\n`,
          ms: 1,
        };
      }
      if (args[2] === "verify")
        return { code: ++verifies >= 2 ? 0 : 1, out: "not proved yet", ms: 1 };
      return { code: 0, out: "", ms: 1 };
    },
  });
  ctx.clientZone = "client.example";
  ctx.clientZoneId = "zone-client";
  ctx.api.createDnsRecord = async (zone, record) => {
    written.push({ zone, ...record });
    return { id: `r${written.length}` };
  };
  const full = await front.run(ctx);
  assert.equal(full.status ?? "pass", "pass");
  assert.deepEqual(
    written.map((r) => [r.zone, r.type, r.name, r.content]),
    [
      ["zone-client", "CNAME", own, `clients.${PREFIX}.fleet.example`],
      ["zone-client", "TXT", `_cos-client.${own}`, "cos-client=staging:alpha"],
    ],
  );
  // The CNAME DNS only, never proxied (no Orange-to-Orange).
  assert.equal(written.find((r) => r.type === "CNAME")?.proxied, false);
  assert.equal(verifies, 2);
  assert.deepEqual(commands, [
    "client hostname add",
    "client hostname verify",
    "client hostname verify",
    "client hostname remove",
  ]);
});

test("the gatekeeper step: the fleet's email-send Worker deployed, sending per client and bound to the runner (ADR 0618)", async () => {
  const ctx = (over) => stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), ...over });
  const ok = await step("gatekeeper").run(ctx({}));
  assert.equal(ok.status, undefined, ok.note);
  assert.match(
    ok.note,
    /gatekeeper-email-send-staging is deployed with SENDER_DOMAINS_PER_CLIENT=true/,
  );
  await assert.rejects(
    step("gatekeeper").run(ctx({ gatekeeper: gatekeeperBindings({ deployed: false }) })),
    /no cosstg-123-gatekeeper-email-send-staging Worker is deployed/,
  );
  await assert.rejects(
    step("gatekeeper").run(ctx({ gatekeeper: gatekeeperBindings({ flag: "" }) })),
    /SENDER_DOMAINS_PER_CLIENT="", not "true"/,
  );
  await assert.rejects(
    step("gatekeeper").run(ctx({ gatekeeper: gatekeeperBindings({ bound: false }) })),
    /does not bind GATEKEEPER_EMAIL_SEND/,
  );
  // The upgrade fails too when the gatekeeper is not bound after it.
  const good = upgradeCos();
  await assert.rejects(
    step("upgrade").run(
      stepCtx({
        answer: good.answer,
        version: () => good.state.version,
        fetch: healthFetch(good.state),
        gatekeeper: gatekeeperBindings({ bound: false }),
      }),
    ),
    /after the upgrade: .*does not bind GATEKEEPER_EMAIL_SEND/,
  );
});

test("teardown removes the email-send gatekeeper's Worker with its namespace, and fails if the namespace outlives it", async () => {
  const { cf, api } = world();
  await seed(cf, api);
  const result = await teardown(api, ACCOUNT, PREFIX);
  assert.ok(
    result.deleted.some(
      (d) => d.kind === "worker" && d.name === `${PREFIX}-gatekeeper-email-send-staging`,
    ),
  );
  assert.deepEqual(result.remaining, []);
  // Its Worker refuses deletion: the Worker and its namespace are left, and the command fails.
  const left = world();
  await seed(left.cf, left.api);
  left.cf.failOn = (method, path) =>
    method === "DELETE" && path.endsWith(`/scripts/${PREFIX}-gatekeeper-email-send-staging`)
      ? refuse(10000, "internal error", 500)
      : undefined;
  let written = "";
  const code = await teardownCommand(PREFIX, {
    api: left.api,
    accountId: ACCOUNT,
    dir: null,
    secrets: [TOKEN, ACCOUNT],
    log: () => {},
    writeSummary: (t) => {
      written += t;
    },
  });
  assert.equal(code, 1);
  assert.match(
    written,
    /durable_object `cosstg-123-gatekeeper-email-send-staging_EmailSendGatekeeper`/,
  );
});

test("the requests step: B's password at A must be the wrong-password answer, not any refusal (review of #541, F5)", async () => {
  // Each client's session cookie names its client; it is a session only at that client's address.
  const host = (url) => new URL(url).hostname.split("-admin.")[0];
  const answerWith =
    (crossed) =>
    async (url, init = {}) => {
      if (url.endsWith("/api/auth/sign-up/email")) {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": `__Host-cos.session_token=${host(url)}; Path=/` },
        });
      }
      if (url.endsWith("/api/auth/sign-in/email")) return new Response("{}", { status: crossed });
      if (url.includes("/api/v1/op/")) {
        return init.headers?.cookie === `__Host-cos.session_token=${host(url)}`
          ? new Response("{}", { status: 200 })
          : new Response(
              JSON.stringify({ error: { code: "unauthenticated", id: crypto.randomUUID() } }),
              { status: 401 },
            );
      }
      if (url.endsWith("/api/health"))
        return new Response(JSON.stringify({ host: true, version: VERSIONS.from }));
      if (url.includes("/api/media")) return new Response("{}", { status: 201 });
      return new Response("ok", { status: url.includes("workers.dev") ? 404 : 200 });
    };
  const run = (crossed) =>
    step("requests").run({
      ...stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }) }),
      subdomain: "x",
      fetch: answerWith(crossed),
    });
  // The op answers differ only in a request id: still the same refusal.
  await assert.doesNotReject(run(401));
  await assert.rejects(run(429), /answered 429, not 401/);
  await assert.rejects(run(500), /answered 500, not 401/);

  // Staging run 45994923824: the staff session's operation got no answer at all (status 0). The
  // result says what the fetch threw, and what a repeat 5 s later answered (and how long it
  // took); both clients' first operations are tried before the step fails, each answered one is
  // followed by one more, and each sign-up and operation says its time (review of #557).
  for (const [repeat, says, bravoFails] of [
    [200, /a repeat 5 s later answered 200 in \d+\.\d s/, false],
    [
      0,
      /a repeat 5 s later answered 0 \(no answer: TypeError: fetch failed \(cause ECONNRESET: socket hang up\)/,
      false,
    ],
    [200, /a repeat 5 s later answered 200 in \d+\.\d s/, true],
  ]) {
    const ops = { alpha: 0, bravo: 0 };
    const slept = [];
    let cancelled = 0;
    const base = answerWith(401);
    const throwing = async (url, init = {}) => {
      const id = new URL(url).hostname.split("-admin.")[0];
      if (url.includes("/api/v1/op/") && id in ops) {
        ops[id] += 1;
        if (id === "alpha" ? ops.alpha === 1 || repeat === 0 : bravoFails && ops.bravo === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          });
        }
        if (id === "alpha" && ops.alpha === 2) {
          const answer = await base(url, init);
          const cancel = answer.body.cancel.bind(answer.body);
          answer.body.cancel = (reason) => {
            cancelled += 1;
            return cancel(reason);
          };
          return answer;
        }
      }
      return base(url, init);
    };
    await assert.rejects(
      step("requests").run({
        ...stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }) }),
        subdomain: "x",
        fetch: throwing,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
      (error) => {
        assert.match(
          error.message,
          /alpha's staff session at alpha answered 0 \(no answer: TypeError: fetch failed \(cause ECONNRESET: socket hang up\), after \d+\.\d s\)/,
        );
        assert.match(error.message, says);
        assert.match(error.message, /alpha's staff sign-up answered 200 in \d+\.\d s/);
        assert.match(error.message, /bravo's staff sign-up answered 200 in \d+\.\d s/);
        if (repeat === 200) {
          assert.match(
            error.message,
            /alpha's first person\.list .*; the next answered 200 in \d+\.\d s/,
          );
        } else {
          assert.doesNotMatch(error.message, /alpha's first person\.list [^;]*;[^;]*; the next/);
        }
        if (bravoFails) {
          assert.match(error.message, /bravo's staff session at bravo answered 0 \(no answer: /);
        } else {
          assert.match(
            error.message,
            /bravo's first person\.list answered 200 in \d+\.\d s; the next answered 200 in \d+\.\d s/,
          );
          assert.doesNotMatch(error.message, /bravo's staff session at bravo answered/);
        }
        return true;
      },
    );
    assert.equal(ops.alpha, repeat === 200 ? 3 : 2);
    assert.equal(ops.bravo, bravoFails ? 3 : 2);
    assert.equal(cancelled, repeat === 200 ? 1 : 0);
    assert.ok(slept.includes(5000));
  }
});

test("a client's first operation must answer within FIRST_OP_BOUND_MS: a fresh client's (step 3) and the first after an upgrade (step 5), issue #558", async () => {
  assert.equal(FIRST_OP_BOUND_MS, 5000);
  const host = (url) => new URL(url).hostname.split("-admin.")[0];
  /** Every call answers as it should; `slow`'s first person.list takes `ms` (a clock moved on). */
  const fetchWith =
    ({ slow, ms, version = () => VERSIONS.from }) =>
    async (url, init = {}) => {
      if (url.endsWith("/api/auth/sign-up/email")) {
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": `__Host-cos.session_token=${host(url)}; Path=/` },
        });
      }
      if (url.endsWith("/api/auth/sign-in/email")) return new Response("{}", { status: 401 });
      if (url.includes("/api/v1/op/")) {
        if (init.headers?.cookie !== `__Host-cos.session_token=${host(url)}`)
          return new Response(JSON.stringify({ error: { code: "unauthenticated" } }), {
            status: 401,
          });
        if (host(url) === slow.id && !slow.done) {
          slow.done = true;
          mock.timers.tick(ms);
        }
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/api/health"))
        return new Response(JSON.stringify({ host: true, version: version() }));
      if (url.includes("/api/media")) return new Response("{}", { status: 201 });
      return new Response("ok", { status: url.includes("workers.dev") ? 404 : 200 });
    };
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const requests = (ms) =>
      step("requests").run({
        ...stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }) }),
        subdomain: "x",
        fetch: fetchWith({ slow: { id: CLIENTS.b }, ms }),
      });
    // Staging run 46007691132: a fresh client's first person.list answered in 18.3 s.
    await assert.rejects(
      requests(18_300),
      /bravo's first person\.list took 200 in 18\.3 s: more than 5 s for a first operation/,
    );
    await assert.doesNotReject(requests(FIRST_OP_BOUND_MS - 1000));

    const upgrade = (ms) => {
      const good = upgradeCos();
      const ctx = stepCtx({
        answer: good.answer,
        version: () => good.state.version,
        fetch: fetchWith({
          slow: { id: CLIENTS.a },
          ms,
          version: () => good.state.version,
        }),
      });
      for (const id of [CLIENTS.a, CLIENTS.b])
        ctx.staff[id] = { cookie: `__Host-cos.session_token=${id}` };
      return step("upgrade").run(ctx);
    };
    await assert.rejects(
      upgrade(19_300),
      /after the upgrade alpha's first person\.list took 200 in 19\.3 s: more than 5 s/,
    );
    const ok = await upgrade(1000);
    assert.match(ok.note, /alpha's first person\.list after the upgrade answered 200 in 1\.0 s/);
    assert.match(ok.note, /bravo's first person\.list after the upgrade answered 200 in 0\.0 s/);
  } finally {
    mock.timers.reset();
  }
});

test("a fetch that threw is described by its name, message, cause and time, never its headers", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(
    describeFetchError(timeout, 20000),
    "TimeoutError: The operation was aborted due to timeout, after 20.0 s",
  );
  const dns = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND x.example"), { code: "ENOTFOUND" }),
  });
  assert.equal(
    describeFetchError(dns, 1234),
    "TypeError: fetch failed (cause ENOTFOUND: getaddrinfo ENOTFOUND x.example), after 1.2 s",
  );
});

/** An export folder as cos writes one, with one file. */
function exportDir(counts, file = new Uint8Array([9, 9]), packs = "deals,leads") {
  const dir = mkdtempSync(join(tmpdir(), "s66s7-exp-"));
  mkdirSync(join(dir, "database"));
  mkdirSync(join(dir, "files", "media"), { recursive: true });
  const part = '{"statements":[]}';
  writeFileSync(join(dir, "database", "000000.json"), part);
  writeFileSync(join(dir, "files", "media", "probe.png"), file);
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      database: { parts: [{ path: "database/000000.json", sha256: sha(part) }], counts },
      files: [{ key: "media/probe.png", sha256: sha(new Uint8Array([9, 9])) }],
      ...(packs === null ? {} : { packs }),
    }),
  );
  return dir;
}

test("an export's hashes are recomputed from its bytes, and an empty one is no proof (review of #541, F5)", async () => {
  const good = exportDir({ core_settings: 3 });
  assert.deepEqual(exportFacts(good).problems, []);
  const damaged = exportDir({ core_settings: 3 }, new Uint8Array([1]));
  assert.deepEqual(exportFacts(damaged).problems, ["file media/probe.png differs"]);
  // The step: an export that counts no rows fails, however alike the two are.
  const ctx = (first, again) => ({
    ...stepCtx({ answer: () => ({ code: 0, out: "", ms: 1 }), zone: false }),
    exportDir: first,
    reexportDir: again,
  });
  await assert.rejects(step("export").run(ctx(exportDir({}), exportDir({}))), /counts no rows/);
  await assert.rejects(step("export").run(ctx(good, damaged)), /differs/);
  // The packs: the ones the client was given, and the same after the import (re-review of #553).
  const none = exportDir({ core_settings: 3 }, undefined, "");
  await assert.rejects(step("export").run(ctx(good, none)), /packs: COS_PACKS=deals,leads, then/);
  const older = exportDir({ core_settings: 3 }, undefined, null);
  await assert.rejects(step("export").run(ctx(older, older)), /carries COS_PACKS=undefined/);
  const partial = await step("export").run(ctx(good, exportDir({ core_settings: 3 })));
  assert.equal(partial.status, "partial");
});

test("two commands at once: no overlap is partial, never a pass or a false failure (review of #541, F5)", async () => {
  const quick = stepCtx({
    answer: (args) => ({
      code: 0,
      out: args[1] === "add" ? "registry: delta added" : "Exported bravo",
      ms: 1,
    }),
  });
  const result = await step("concurrent").run(quick);
  assert.equal(result.status, "partial");
  const refused = stepCtx({
    answer: (args) =>
      args[1] === "add"
        ? new Promise((done) =>
            setTimeout(() => done({ code: 0, out: "registry: delta added", ms: 1 }), 20),
          )
        : {
            code: 1,
            out: "Error: Another operator's command (client add) holds the operator's Worker",
            ms: 1,
          },
  });
  assert.equal((await step("concurrent").run(refused)).status, undefined);
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
  // The second real run: queues made and plans named in ordinary lines, then a missing service
  // binding. It is not explained as Queues missing from the plan.
  const install = [
    "  Queue cosstg-1-app-fanout-staging: created",
    "  note: an upgrade of the plan is not needed",
    "    Error: PUT /accounts/***/workers/scripts/cosstg-1-runner-staging failed (HTTP 400): 10143: Service binding 'GATEKEEPER_EMAIL_SEND' references Worker 'cosstg-1-gatekeeper-email-send-staging' which was not found.",
  ].join("\n");
  assert.equal(explainFailure(install), null);
  assert.match(
    explainFailure(
      "Error: POST /accounts/x/queues failed (HTTP 403): 11001: Queues are not entitled on this plan",
    ),
    /Queues are not available/,
  );
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
  // The packs go with an export and must come in with the import (re-review of #553).
  const given = { ...a, packs: "deals,leads" };
  assert.deepEqual(compareExports(given, given), []);
  assert.deepEqual(compareExports(given, { ...a, packs: "" }), [
    "packs: COS_PACKS=deals,leads, then ",
  ]);
});
