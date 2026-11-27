// The fleet-operate workflow's script (fleet-operate.mjs): its inputs refused unless strictly
// valid, the dry run by default, the confirm rule, the keys file never left on disk (on an error
// and a signal too), and no secret in anything written. cos is a stand-in that records what it was
// given; the account's subdomain comes from the fake Cloudflare API the CLI's tests use.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CLIENT_SETTINGS, clientIdProblem } from "../packages/db/src/registry.ts";
import { isGivenSecretName } from "../packages/db/src/registry-sealing.ts";
import { CloudflareClient } from "../packages/release/src/cloudflare.ts";
import { FakeCloudflare } from "../packages/release/src/testing/fake-cloudflare.ts";
import { nodeSqliteEngine } from "../packages/release/src/testing/node-sqlite.ts";
import { products } from "../products/index.ts";
import {
  ALWAYS,
  COMMANDS,
  childEnv,
  chooseProduct,
  operate,
  plan,
  readInputs,
  takeSecrets,
  withSecretFiles,
} from "./fleet-operate.mjs";

const TOKEN = "cf-token-for-the-fleet-0123456789";
const ACCOUNT = "acc00000000000000000000000fleet1";
const SUBDOMAIN = "owners-subdomain";
const rules = {
  knownSettings: Object.keys(CLIENT_SETTINGS),
  isSecretName: isGivenSecretName,
  clientIdProblem,
};
const KEYS = {
  environment: "staging",
  rootKey: "root-key-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  secretsPrivateKey: "sealing-private-BBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  secretsPublicKey: "sealing-public-CCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  bindingKey: "binding-key-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  propsKey: "props-key-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
};
const keys64 = (k = KEYS) => Buffer.from(JSON.stringify(k)).toString("base64");

/** A run of the script: cos recorded, the summary and log kept, the fake API for the subdomain. */
function harness({
  cosAnswer,
  help = "cos client hostname add|verify --zone",
  proc,
  recorded = async () => null,
  tagOnMain = async () => ({ ok: true, why: "on main" }),
} = {}) {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: nodeSqliteEngine,
    subdomain: SUBDOMAIN,
  });
  const api = new CloudflareClient({
    token: TOKEN,
    apiBase: "https://api.fake/client/v4",
    fetch: (input, init) => cf.fetch(input, init),
  });
  const calls = [];
  const written = { summary: "", log: [] };
  const tmp = mkdtempSync(join(tmpdir(), "s66-operate-"));
  const deps = {
    rules,
    product: products.crm,
    cos: async (argv, env) => {
      const seen = { argv, env, files: {} };
      for (const a of argv) {
        if (a.startsWith(tmp)) {
          seen.files[a] = {
            text: readFileSync(a, "utf8"),
            mode: statSync(a).mode & 0o777,
            dirMode: statSync(dirname(a)).mode & 0o777,
          };
        }
      }
      calls.push(seen);
      return cosAnswer ? cosAnswer(seen) : { code: 0, out: "done" };
    },
    help: async () => help,
    subdomain: () => api.workersSubdomain(ACCOUNT),
    recorded: async (environment) => {
      calls.recorded = (calls.recorded ?? 0) + 1;
      return recorded(environment);
    },
    tagOnMain,
    tmp,
    log: (l) => written.log.push(l),
    mask: () => {},
    writeSummary: (t) => {
      written.summary += t;
    },
    process: proc ?? new EventEmitter(),
  };
  const run = (inputs, secrets = {}) =>
    operate(
      {
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        GITHUB_ACTOR: "owner",
        // The environment's marker: the run is in that fleet's own environment.
        FLEET_ENVIRONMENT: inputs.ENV,
        ...secrets,
        ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`OP_${k}`, v])),
      },
      deps,
    );
  return { run, calls, written, tmp };
}

test("every input is checked before anything runs; a refusal never reaches cos", async () => {
  const refused = [
    { ENV: "prod", COMMAND: "client-list" },
    { ENV: "staging", COMMAND: "client-shell" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "Ghetto" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "ghetto; rm -rf /" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "cos-app" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "gym-admin" },
    { ENV: "staging", COMMAND: "client-add" },
    { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "latest" },
    { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "1.2.3 --skip-staging" },
    { ENV: "staging", COMMAND: "fleet-install", VERSION: "1.0.0", DOMAIN: "a.example" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "ghetto", SETTINGS: "SECRET_THING=1" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "ghetto", SETTINGS: "COS_PACKS=$(id)" },
    { ENV: "staging", COMMAND: "client-add", CLIENT: "ghetto", HOSTNAME: "www.ghetto.example" },
    { ENV: "staging", COMMAND: "sender-add", CLIENT: "ghetto", SENDER_DOMAIN: "x.example;id" },
    {
      ENV: "staging",
      COMMAND: "client-secret-set",
      CLIENT: "ghetto",
      SECRET_NAME: "BETTER_AUTH_SECRET",
    },
    {
      ENV: "staging",
      COMMAND: "client-secret-set",
      CLIENT: "gym-a",
      SECRET_NAME: "STRIPE_SECRET_KEY",
    },
    { ENV: "staging", COMMAND: "client-list", DRY_RUN: "maybe" },
    { ENV: "staging", COMMAND: "client-remove", CLIENT: "ghetto", CONFIRM: "ghetto && id" },
    // The staging check's throwaway names, anywhere.
    { ENV: "staging", COMMAND: "client-add", CLIENT: "cosstg-1" },
    {
      ENV: "staging",
      COMMAND: "fleet-install",
      VERSION: "1.0.0",
      DOMAIN: "cosstg-9.example.com",
      CALLBACK_HOSTNAME: "c.example.com",
    },
  ];
  for (const inputs of refused) {
    const h = harness();
    const code = await h.run(inputs);
    assert.equal(code, 2, JSON.stringify(inputs));
    assert.equal(h.calls.length, 0, JSON.stringify(inputs));
    assert.match(h.written.summary, /refused before cos/, JSON.stringify(inputs));
  }
  // The valid shapes pass.
  assert.equal(
    readInputs(
      {
        OP_ENV: "staging",
        OP_COMMAND: "client-add",
        OP_CLIENT: "ghetto",
        OP_SETTINGS: "COS_PACKS=ticketing",
      },
      rules,
    ).settings[0],
    "COS_PACKS=ticketing",
  );
});

test("a product of the staging check's throwaway kind is refused", async () => {
  const h = harness();
  const throwaway = {
    ...products.crm,
    id: "cosstg-1",
    names: { ...products.crm.names, app: "cosstg-1-app" },
  };
  const code = await operate(
    {
      OP_ENV: "staging",
      OP_COMMAND: "client-list",
      FLEET_ENVIRONMENT: "staging",
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    },
    { ...harnessDeps(h), product: throwaway },
  );
  assert.equal(code, 2);
  assert.equal(h.calls.length, 0);
});
function harnessDeps(h) {
  return {
    rules,
    product: products.crm,
    cos: async () => {
      h.calls.push({});
      return { code: 0, out: "" };
    },
    help: async () => "",
    subdomain: async () => null,
    tmp: h.tmp,
    log: () => {},
    mask: () => {},
    writeSummary: () => {},
    process: new EventEmitter(),
  };
}

test("dry run is the default: cos gets --dry-run and no --yes, and a command with none is only planned", async () => {
  const h = harness();
  assert.equal(await h.run({ ENV: "live", COMMAND: "client-remove", CLIENT: "ghetto" }), 0);
  assert.ok(h.calls[0].argv.includes("--dry-run"));
  assert.ok(!h.calls[0].argv.includes("--yes"));
  // fleet install has no dry run: planned and printed, cos not run, no keys written.
  const install = harness();
  const code = await install.run(
    {
      ENV: "staging",
      COMMAND: "fleet-install",
      VERSION: "0.1.0-beta.16",
      DOMAIN: "staging.composableos.app",
      CALLBACK_HOSTNAME: "callback.staging.composableos.app",
    },
    { FLEET_KEYS: keys64() },
  );
  assert.equal(code, 0);
  assert.equal(install.calls.length, 0);
  assert.match(install.written.summary, /planned only/);
  assert.deepEqual(readdirSync(install.tmp), []);
});

test("the confirm rule: a destructive command gets --yes only when confirm is the client's id, a live upgrade only for the version", async () => {
  const destructive = [
    ["client-remove", { CLIENT: "ghetto" }, "ghetto"],
    ["client-secret-remove", { CLIENT: "ghetto", SECRET_NAME: "STRIPE_SECRET_KEY" }, "ghetto"],
    ["sender-verify", { CLIENT: "ghetto", SENDER_DOMAIN: "ghetto.example" }, "ghetto"],
    ["sender-unverify", { CLIENT: "ghetto", SENDER_DOMAIN: "ghetto.example" }, "ghetto"],
    ["sender-remove", { CLIENT: "ghetto", SENDER_DOMAIN: "ghetto.example" }, "ghetto"],
    ["hostname-remove", { CLIENT: "ghetto", HOSTNAME: "www.ghetto.example" }, "ghetto"],
    // Review of #547, S3: an export takes the client offline; a hostname-verify vouches.
    ["client-export", { CLIENT: "ghetto" }, "ghetto"],
    ["hostname-verify", { CLIENT: "ghetto", HOSTNAME: "www.ghetto.example" }, "ghetto"],
  ];
  for (const [command, extra, wanted] of destructive) {
    for (const confirm of [undefined, "someone-else"]) {
      const h = harness();
      const code = await h.run({
        ENV: "staging",
        COMMAND: command,
        DRY_RUN: "false",
        ...extra,
        ...(confirm ? { CONFIRM: confirm } : {}),
      });
      assert.equal(code, 2, `${command} ${confirm}`);
      assert.equal(h.calls.length, 0, `${command} ${confirm}`);
    }
    const h = harness();
    assert.equal(
      await h.run({
        ENV: "staging",
        COMMAND: command,
        DRY_RUN: "false",
        CONFIRM: wanted,
        ...extra,
      }),
      0,
    );
    assert.equal(h.calls[0].argv.at(-1), "--yes", command);
  }
  // Live upgrade: the version; staging: runs with --yes, needing none.
  const keys = { FLEET_KEYS: keys64({ ...KEYS, environment: "live" }) };
  const live = harness();
  assert.equal(
    await live.run(
      {
        ENV: "live",
        COMMAND: "fleet-upgrade",
        VERSION: "0.1.0-beta.16",
        DRY_RUN: "false",
        CONFIRM: "ghetto",
      },
      keys,
    ),
    2,
  );
  assert.equal(
    await live.run(
      {
        ENV: "live",
        COMMAND: "fleet-upgrade",
        VERSION: "0.1.0-beta.16",
        DRY_RUN: "false",
        CONFIRM: "0.1.0-beta.16",
      },
      keys,
    ),
    0,
  );
  assert.ok(live.calls[0].argv.includes("--yes"));
  const staging = harness();
  assert.equal(
    await staging.run(
      { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "0.1.0-beta.16", DRY_RUN: "false" },
      { FLEET_KEYS: keys64() },
    ),
    0,
  );
  assert.ok(staging.calls[0].argv.includes("--yes"));
  // Pausing a live client needs its id; a staging one does not.
  const pause = harness();
  assert.equal(
    await pause.run({ ENV: "live", COMMAND: "client-pause", CLIENT: "ghetto", DRY_RUN: "false" }),
    2,
  );
  assert.equal(
    await pause.run({
      ENV: "staging",
      COMMAND: "client-pause",
      CLIENT: "ghetto",
      DRY_RUN: "false",
    }),
    0,
  );
  assert.ok(!pause.calls[0].argv.includes("--yes"));
  // A secret set without confirm runs without --yes: a stored value is not replaced.
  const set = harness();
  const value = { SECRET_VALUE: "sk_test_never_printed_0123456789" };
  assert.equal(
    await set.run(
      {
        ENV: "staging",
        COMMAND: "client-secret-set",
        CLIENT: "ghetto",
        SECRET_NAME: "STRIPE_SECRET_KEY",
        DRY_RUN: "false",
      },
      value,
    ),
    0,
  );
  assert.ok(!set.calls[0].argv.includes("--yes"));
});

test("the keys file: written 0600 in a 0700 folder for install and upgrade only, and gone after, after an error, and on a signal", async () => {
  const keys = { FLEET_KEYS: keys64() };
  const upgrade = { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "0.1.0-beta.16" };
  const h = harness();
  assert.equal(await h.run(upgrade, keys), 0);
  const [path] = Object.keys(h.calls[0].files);
  assert.ok(path, "cos was given the keys file");
  assert.deepEqual(JSON.parse(h.calls[0].files[path].text), KEYS);
  assert.equal(h.calls[0].files[path].mode, 0o600);
  assert.equal(h.calls[0].files[path].dirMode, 0o700);
  assert.ok(!existsSync(path));
  assert.deepEqual(readdirSync(h.tmp), []);
  // cos throws: still gone.
  const broken = harness({
    cosAnswer: () => {
      throw new Error("cos crashed");
    },
  });
  await assert.rejects(broken.run(upgrade, keys), /cos crashed/);
  assert.deepEqual(readdirSync(broken.tmp), []);
  // A signal while cos runs: gone, and the process asked to exit.
  const proc = new EventEmitter();
  let exited = null;
  proc.exit = (code) => {
    exited = code;
  };
  const signalled = harness({
    proc,
    cosAnswer: (seen) => {
      proc.emit("SIGTERM", "SIGTERM");
      assert.ok(!existsSync(Object.keys(seen.files)[0]));
      return { code: 143, out: "" };
    },
  });
  await signalled.run(upgrade, keys);
  assert.equal(exited, 143);
  assert.deepEqual(readdirSync(signalled.tmp), []);
  // Not written for a client command, and another environment's keys are refused.
  const client = harness();
  await client.run({ ENV: "staging", COMMAND: "client-list" }, keys);
  assert.deepEqual(client.calls[0].files, {});
  const wrong = harness();
  assert.equal(await wrong.run({ ...upgrade, ENV: "live", DRY_RUN: "true" }, keys), 2);
  assert.equal(wrong.calls.length, 0);
  // Every temporary file, by the helper itself on a throw.
  const base = mkdtempSync(join(tmpdir(), "s66-files-"));
  await assert.rejects(
    withSecretFiles(
      base,
      { keys: "x" },
      async () => {
        throw new Error("boom");
      },
      new EventEmitter(),
    ),
    /boom/,
  );
  assert.deepEqual(readdirSync(base), []);
});

test("no secret in anything written: the token, the account, its subdomain, the keys, a secret's value", async () => {
  const value = "sk_live_never_printed_0123456789";
  // cos prints everything it holds: what the run must cut out of it is what it was given.
  const leaky = ({ files }) => ({
    code: 1,
    out: [
      `GET /accounts/${ACCOUNT}/workers failed`,
      `operator at https://crm-operator-staging.${SUBDOMAIN}.workers.dev`,
      `token ${TOKEN}`,
      ...Object.values(files).map((f) => f.text),
    ].join("\n"),
  });
  const always = [TOKEN, ACCOUNT, SUBDOMAIN];
  for (const [inputs, secrets, given] of [
    [
      { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "0.1.0-beta.16" },
      { FLEET_KEYS: keys64() },
      [KEYS.propsKey, KEYS.rootKey, KEYS.bindingKey, KEYS.secretsPrivateKey, JSON.stringify(KEYS)],
    ],
    [
      {
        ENV: "staging",
        COMMAND: "client-secret-set",
        CLIENT: "ghetto",
        SECRET_NAME: "STRIPE_SECRET_KEY",
        DRY_RUN: "false",
      },
      { SECRET_VALUE: value },
      [value],
    ],
  ]) {
    const h = harness({ cosAnswer: leaky });
    await h.run(inputs, secrets);
    const everything = `${h.written.summary}\n${h.written.log.join("\n")}`;
    for (const secret of [...always, ...given]) {
      assert.ok(everything.length > 0);
      assert.ok(!everything.includes(secret), `${secret} was written`);
    }
    // And cos got neither in its environment: they go by file.
    assert.equal(h.calls[0].env.FLEET_KEYS, undefined);
    assert.equal(h.calls[0].env.SECRET_VALUE, undefined);
  }
});

test("cos gets a fixed command line and a clean environment: no test switch, no other product, no unverified release, no --out", () => {
  const env = childEnv({
    PATH: "/bin",
    CLOUDFLARE_API_TOKEN: TOKEN,
    COS_FLEET_FORCE_FAILURE: "smoke",
    COS_OPERATOR_ORIGIN: "http://evil",
    OP_CLIENT: "ghetto",
    FLEET_KEYS: "x",
    SECRET_VALUE: "y",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CLOUDFLARE_API_TOKEN", "PATH"]);
  assert.deepEqual([...ALWAYS], ["--require-gh"]);
  for (const command of Object.keys(COMMANDS)) {
    const i = {
      env: "live",
      command,
      client: "ghetto",
      version: "1.0.0",
      domain: "fleet.example",
      callback: "callback.fleet.example",
      zone: "",
      location: "",
      ai: "off",
      settings: [],
      hostname: "www.ghetto.example",
      senderDomain: "ghetto.example",
      secretName: "STRIPE_SECRET_KEY",
      confirm: "",
      dryRun: true,
      takeOver: false,
    };
    const { argv } = plan(i);
    for (const banned of [
      "--product-file",
      "--product",
      "--bundle-dir",
      "--unverified",
      "--out",
      "--leaving",
      "--skip-staging",
    ]) {
      assert.ok(!argv.includes(banned), `${command}: ${banned}`);
    }
    assert.ok(argv.includes("--env"), command);
  }
});

test("a command that arrives with a later PR is refused, saying so, until cos has it", async () => {
  const h = harness({ help: "cos client add|list" });
  const code = await h.run({ ENV: "staging", COMMAND: "hostname-list", CLIENT: "ghetto" });
  assert.equal(code, 2);
  assert.match(h.written.summary, /arrives with PR #543/);
  assert.equal(h.calls.length, 0);
});

// --- the review of #547 ---------------------------------------------------------------------------

test("a run outside its fleet's own environment is refused before anything (M2)", async () => {
  for (const marker of [undefined, "", "live", "check", "staging "]) {
    const h = harness();
    const code = await h.run(
      { ENV: "staging", COMMAND: "client-list" },
      { FLEET_ENVIRONMENT: marker },
    );
    assert.equal(code, 2, String(marker));
    assert.equal(h.calls.length, 0, String(marker));
    assert.equal(h.calls.recorded, undefined);
    assert.match(h.written.summary, /FLEET_ENVIRONMENT does not name this fleet/);
  }
  // live needs live's marker.
  const live = harness();
  assert.equal(
    await live.run({ ENV: "live", COMMAND: "client-list" }, { FLEET_ENVIRONMENT: "staging" }),
    2,
  );
  assert.equal(live.calls.length, 0);
});

test("fleet-install: its dry run says what is installed; for real it needs confirm = the domain (M1)", async () => {
  const install = {
    ENV: "live",
    COMMAND: "fleet-install",
    VERSION: "0.1.0-beta.16",
    DOMAIN: "fleet.composableos.app",
    CALLBACK_HOSTNAME: "callback.fleet.composableos.app",
  };
  const keys = { FLEET_KEYS: keys64({ ...KEYS, environment: "live" }) };
  // Nothing there: a first install, said.
  const none = harness();
  assert.equal(await none.run(install, keys), 0);
  assert.match(none.written.summary, /No live fleet exists yet: this is its first install/);
  assert.equal(none.calls.length, 0);
  // A fleet there, at another version: said, and that cos refuses.
  const there = harness({
    recorded: async () => ({
      fleet: true,
      version: "0.1.0-beta.15",
      domain: "fleet.composableos.app",
      callback: "callback.fleet.composableos.app",
    }),
  });
  assert.equal(await there.run(install, keys), 0);
  assert.match(there.written.summary, /The live fleet exists: version 0\.1\.0-beta\.15/);
  assert.match(there.written.summary, /cos refuses \(an upgrade is fleet-upgrade\)/);
  // For real: the domain, and nothing else, confirms it.
  for (const confirm of [undefined, "0.1.0-beta.16", "live"]) {
    const h = harness();
    const code = await h.run(
      { ...install, DRY_RUN: "false", ...(confirm ? { CONFIRM: confirm } : {}) },
      keys,
    );
    assert.equal(code, 2, String(confirm));
    assert.equal(h.calls.length, 0);
  }
  const ok = harness();
  assert.equal(
    await ok.run({ ...install, DRY_RUN: "false", CONFIRM: "fleet.composableos.app" }, keys),
    0,
  );
  assert.equal(ok.calls.length, 1);
  assert.ok(!ok.calls[0].argv.includes("--yes"));
  // A lookup that fails never lets an install run blind.
  const blind = harness({
    recorded: async () => {
      throw new Error("D1 read refused");
    },
  });
  assert.equal(
    await blind.run({ ...install, DRY_RUN: "false", CONFIRM: "fleet.composableos.app" }, keys),
    2,
  );
  assert.equal(blind.calls.length, 0);
});

test("a release not tagged on main is refused for install and upgrade (S2)", async () => {
  const h = harness({
    tagOnMain: async () => ({ ok: false, why: "its commit abc is not on origin/main" }),
  });
  const code = await h.run(
    { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "0.1.0-beta.16" },
    { FLEET_KEYS: keys64() },
  );
  assert.equal(code, 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.written.summary, /not a tag of a commit on main/);
});

test("a live resume, and take_over on any command, need confirm too (S3)", async () => {
  const resume = harness();
  assert.equal(
    await resume.run({ ENV: "live", COMMAND: "client-resume", CLIENT: "ghetto", DRY_RUN: "false" }),
    2,
  );
  assert.equal(
    await resume.run({
      ENV: "live",
      COMMAND: "client-resume",
      CLIENT: "ghetto",
      DRY_RUN: "false",
      CONFIRM: "ghetto",
    }),
    0,
  );
  assert.equal(resume.calls.length, 1);
  const take = harness();
  assert.equal(
    await take.run({
      ENV: "staging",
      COMMAND: "client-add",
      CLIENT: "ghetto",
      DRY_RUN: "false",
      TAKE_OVER: "true",
    }),
    2,
  );
  assert.equal(
    await take.run({
      ENV: "staging",
      COMMAND: "client-add",
      CLIENT: "ghetto",
      DRY_RUN: "false",
      TAKE_OVER: "true",
      CONFIRM: "ghetto",
    }),
    0,
  );
  assert.ok(take.calls[0].argv.includes("--take-over"));
  // On a command with no client: the environment's name.
  const list = harness();
  assert.equal(await list.run({ ENV: "staging", COMMAND: "client-list", TAKE_OVER: "true" }), 0);
});

test("identity and approval settings are never set by this workflow (S4)", async () => {
  for (const setting of [
    "APPROVAL_FLOOR=autonomous",
    "APPROVAL_EXPIRY_DAYS=30",
    "IDENTITY_PROVIDER=cloudflare-access",
    "AUTH_ALLOW_SIGNUP=true",
    "NATIVE_REDIRECT_URIS=gym://x",
  ]) {
    const h = harness();
    const code = await h.run({
      ENV: "live",
      COMMAND: "client-add",
      CLIENT: "ghetto",
      SETTINGS: setting,
    });
    assert.equal(code, 2, setting);
    assert.equal(h.calls.length, 0, setting);
    assert.match(h.written.summary, /identity or approval policy/, setting);
  }
  const packs = harness();
  assert.equal(
    await packs.run({
      ENV: "staging",
      COMMAND: "client-add",
      CLIENT: "ghetto",
      SETTINGS: "COS_PACKS=ticketing",
    }),
    0,
  );
});

test("the keys and a secret value leave the environment before any import, and no later import or child sees them (S7)", async () => {
  const env = { FLEET_KEYS: "k", SECRET_VALUE: "v", PATH: "/bin" };
  const taken = takeSecrets(env);
  assert.deepEqual(taken, { FLEET_KEYS: "k", SECRET_VALUE: "v" });
  assert.deepEqual(Object.keys(env), ["PATH"]);
  // In the process itself: a module imported after sees neither.
  process.env.FLEET_KEYS = "keys-in-the-environment";
  process.env.SECRET_VALUE = "value-in-the-environment";
  takeSecrets(process.env);
  const dir = mkdtempSync(join(tmpdir(), "s66-import-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, "export const seen = [process.env.FLEET_KEYS, process.env.SECRET_VALUE];\n");
  const { seen } = await import(pathToFileURL(probe).href);
  assert.deepEqual(seen, [undefined, undefined]);
  // And main takes them before its first import that is not Node's own.
  const source = readFileSync(new URL("./fleet-operate.mjs", import.meta.url), "utf8");
  const mainAt = source.indexOf("async function main(");
  const takeAt = source.indexOf("takeSecrets(ENV)", mainAt);
  const importAt = source.indexOf("await import(", mainAt);
  assert.ok(takeAt > mainAt && takeAt < importAt);
  // Its own static imports are Node's only.
  for (const m of source.matchAll(/^import .* from "([^"]+)";$/gm)) {
    assert.ok(m[1].startsWith("node:"), m[1]);
  }
});

test("the product is chosen in one place, today cos's default with no flag", () => {
  const chosen = chooseProduct({ products, defaultProduct: "crm" });
  assert.equal(chosen.product.id, "crm");
  assert.deepEqual(chosen.extraArgs, []);
  const source = readFileSync(new URL("./fleet-operate.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/THE PRODUCT IS CHOSEN HERE/g)?.length, 1);
});
