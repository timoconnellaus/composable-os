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
import {
  clientIdProblem,
  firstAdminEmail,
  labelProblem,
  OPERATOR_SETTINGS,
} from "../packages/db/src/registry.ts";
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
  redactEmail,
  TAKEN,
  takeSecrets,
  withSecretFiles,
} from "./fleet-operate.mjs";

const TOKEN = "cf-token-for-the-fleet-0123456789";
const ACCOUNT = "acc00000000000000000000000fleet1";
const SUBDOMAIN = "owners-subdomain";
const rules = {
  knownSettings: Object.keys(OPERATOR_SETTINGS),
  isSecretName: isGivenSecretName,
  clientIdProblem,
  isEmail: (v) => firstAdminEmail(v) !== null,
  labelProblem,
};
/** A stand-in for the hosted product (PR #553's `composable`). */
const HOSTED = {
  ...products.crm,
  id: "composable",
  names: {
    app: "composable-app",
    runner: "composable-runner",
    gatekeeperPrefix: "composable-gatekeeper-",
    database: "composable",
    resourcePrefix: "composable-",
  },
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
  help = "cos client hostname add|verify --zone cos client setting list",
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
  const written = { summary: "", log: [], masked: [], events: [] };
  const tmp = mkdtempSync(join(tmpdir(), "s66-operate-"));
  const deps = {
    rules,
    product: HOSTED,
    productReady: true,
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
    log: (l) => {
      written.log.push(l);
      written.events.push(["log", l]);
    },
    mask: (v) => {
      written.masked.push(v);
      written.events.push(["mask", v]);
    },
    writeSummary: (t) => {
      written.summary += t;
      written.events.push(["summary", t]);
    },
    process: proc ?? new EventEmitter(),
  };
  const h = { calls, written, tmp, deps };
  h.run = (inputs, secrets = {}) =>
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
      h.deps,
    );
  return h;
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
  for (const given of refused) {
    // client-add's packs given, so each is refused for its own reason.
    const inputs =
      given.COMMAND === "client-add" && !given.SETTINGS
        ? { ...given, SETTINGS: "COS_PACKS=" }
        : given;
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
    product: HOSTED,
    productReady: true,
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
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CLOUDFLARE_API_TOKEN", "PATH"]);
  // cos sees CI, so its own refusal of a printed setup link holds here (review of #552, S-W1).
  assert.equal(env.CI, "true");
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
      settingName: "COS_PACKS",
      settingValue: "ticketing",
      adminEmail: "owner@gym.example",
      tokenSha256: "a".repeat(64),
      label: "Gym A",
      stream: { accountId: "a".repeat(32), customerCode: "abcd1234", keyId: "b".repeat(32) },
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
      // Nothing that prints a setup link or an address, adopts a hostname, or skips the wait.
      "--print-link",
      "first-admin-token",
      "--show-email",
      "--adopt",
      "--no-wait",
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
      SETTINGS: "COS_PACKS=ticketing",
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
      SETTINGS: "COS_PACKS=ticketing",
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

test("identity and approval settings are never set at client-add (S4)", async () => {
  for (const setting of [
    "APPROVAL_FLOOR=autonomous",
    "APPROVAL_EXPIRY_DAYS=30",
    "IDENTITY_PROVIDER=cloudflare-access",
    "AUTH_ALLOW_SIGNUP=true",
    "NATIVE_REDIRECT_URIS=gym://x",
    // The re-review of #547: which browser origins may call the API with a session.
    "API_ALLOWED_ORIGINS=https://evil.example",
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
  const env = {
    FLEET_KEYS: "k",
    SECRET_VALUE: "v",
    FLEET_STREAM_API_TOKEN: "t",
    FLEET_STREAM_SIGNING_JWK: "j",
    PATH: "/bin",
  };
  const taken = takeSecrets(env);
  assert.deepEqual(taken, {
    FLEET_KEYS: "k",
    SECRET_VALUE: "v",
    FLEET_STREAM_API_TOKEN: "t",
    FLEET_STREAM_SIGNING_JWK: "j",
  });
  assert.deepEqual(Object.keys(env), ["PATH"]);
  assert.deepEqual([...TAKEN].sort(), Object.keys(taken).sort());
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

test("the product is chosen in one place: the hosted one, passed as --product, never the CRM", () => {
  const source = readFileSync(new URL("./fleet-operate.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/THE PRODUCT IS CHOSEN HERE/g)?.length, 1);
  const withHosted = {
    HOSTED_PRODUCT: "composable",
    products: { composable: HOSTED, crm: products.crm },
  };
  const ready = chooseProduct({
    productsModule: withHosted,
    cosHelp: "  --product <id>  the product",
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.product.id, "composable");
  assert.deepEqual(ready.extraArgs, ["--product", "composable"]);
  // This checkout without it (PR #553 not merged): no product, never the CRM.
  const before = chooseProduct({
    productsModule: { DEFAULT_PRODUCT: "crm", products },
    cosHelp: "--product <id>",
  });
  assert.equal(before.ready, false);
  assert.equal(before.product, null);
  assert.match(before.why, /HOSTED_PRODUCT/);
  // A cos that takes no --product: not ready either.
  assert.equal(chooseProduct({ productsModule: withHosted, cosHelp: "cos install" }).ready, false);
});

test("without the hosted product a dry run is planned only and a real run refused, nothing reaching cos", async () => {
  const notReady = (h) => ({
    ...h.deps,
    product: null,
    productReady: false,
    productWhy:
      "the hosted product (HOSTED_PRODUCT in products/index.ts, PR #553) is not in this checkout yet",
  });
  for (const [inputs, code] of [
    [{ ENV: "staging", COMMAND: "client-add", CLIENT: "ghetto", SETTINGS: "COS_PACKS=" }, 0],
    [
      {
        ENV: "staging",
        COMMAND: "client-add",
        CLIENT: "ghetto",
        SETTINGS: "COS_PACKS=",
        DRY_RUN: "false",
      },
      2,
    ],
    [{ ENV: "staging", COMMAND: "client-list" }, 2],
  ]) {
    const h = harness();
    h.deps = notReady(h);
    assert.equal(await h.run(inputs), code, JSON.stringify(inputs));
    assert.equal(h.calls.length, 0, JSON.stringify(inputs));
    assert.match(h.written.summary, /HOSTED_PRODUCT/);
  }
});

// --- the re-review of #547 -----------------------------------------------------------------------

test("client-setting: an identity or approval setting runs only with confirm <client id>:<NAME>, its value shown in full first", async () => {
  const redirect = {
    ENV: "live",
    COMMAND: "client-setting-set",
    CLIENT: "ghetto",
    SETTING_NAME: "NATIVE_REDIRECT_URIS",
    SETTING_VALUE: "ghetto://staff-sign-in",
  };
  // The dry run: cos gets --dry-run, and the summary has the exact value and the confirm needed.
  const dry = harness();
  assert.equal(await dry.run(redirect), 0);
  assert.ok(dry.calls[0].argv.includes("--dry-run"));
  assert.deepEqual(dry.calls[0].argv.slice(0, 6), [
    "client",
    "setting",
    "set",
    "ghetto",
    "NATIVE_REDIRECT_URIS",
    "ghetto://staff-sign-in",
  ]);
  assert.match(
    dry.written.summary,
    /set NATIVE_REDIRECT_URIS for ghetto to "ghetto:\/\/staff-sign-in"/,
  );
  assert.match(dry.written.summary, /confirm ghetto:NATIVE_REDIRECT_URIS/);
  // For real: the client's id alone is not enough, nor another setting's name.
  for (const confirm of [undefined, "ghetto", "ghetto:API_ALLOWED_ORIGINS"]) {
    const h = harness();
    const code = await h.run({
      ...redirect,
      DRY_RUN: "false",
      ...(confirm ? { CONFIRM: confirm } : {}),
    });
    assert.equal(code, 2, String(confirm));
    assert.equal(h.calls.length, 0, String(confirm));
  }
  const ok = harness();
  assert.equal(
    await ok.run({ ...redirect, DRY_RUN: "false", CONFIRM: "ghetto:NATIVE_REDIRECT_URIS" }),
    0,
  );
  assert.equal(ok.calls[0].argv.at(-1), "--yes");
  // Unsetting one is confirmed the same way.
  const unset = harness();
  const unsetInputs = {
    ENV: "live",
    COMMAND: "client-setting-unset",
    CLIENT: "ghetto",
    SETTING_NAME: "API_ALLOWED_ORIGINS",
    DRY_RUN: "false",
  };
  assert.equal(await unset.run({ ...unsetInputs, CONFIRM: "ghetto" }), 2);
  assert.equal(await unset.run({ ...unsetInputs, CONFIRM: "ghetto:API_ALLOWED_ORIGINS" }), 0);
  // Any other setting: the ordinary confirm, the client's id.
  const packs = harness();
  const packsInputs = {
    ENV: "staging",
    COMMAND: "client-setting-set",
    CLIENT: "ghetto",
    SETTING_NAME: "COS_PACKS",
    SETTING_VALUE: "ticketing,courses",
    DRY_RUN: "false",
  };
  assert.equal(await packs.run(packsInputs), 2);
  assert.equal(await packs.run({ ...packsInputs, CONFIRM: "ghetto" }), 0);
});

test("client-setting: a value is one argument and never a flag; the name is a client setting's; cos must have the command", async () => {
  for (const extra of [
    { SETTING_NAME: "COS_PACKS", SETTING_VALUE: "--take-over" },
    { SETTING_NAME: "COS_PACKS", SETTING_VALUE: "" },
    { SETTING_NAME: "COS_PACKS", SETTING_VALUE: "a\nb" },
    { SETTING_NAME: "SOMETHING_ELSE", SETTING_VALUE: "x" },
  ]) {
    const h = harness();
    const code = await h.run({
      ENV: "staging",
      COMMAND: "client-setting-set",
      CLIENT: "ghetto",
      ...extra,
    });
    assert.equal(code, 2, JSON.stringify(extra));
    assert.equal(h.calls.length, 0);
  }
  const old = harness({ help: "cos client add|list" });
  assert.equal(
    await old.run({ ENV: "staging", COMMAND: "client-setting-list", CLIENT: "ghetto" }),
    2,
  );
  assert.match(old.written.summary, /no "cos client setting" yet/);
});

test("confirm takes a domain as long as a hostname can be", async () => {
  const label = "a".repeat(60);
  const domain = `${label}.${label}.${label}.composableos.app`;
  assert.ok(domain.length > 64);
  const h = harness();
  const code = await h.run(
    {
      ENV: "staging",
      COMMAND: "fleet-install",
      VERSION: "0.1.0-beta.16",
      DOMAIN: domain,
      CALLBACK_HOSTNAME: `callback.${label}.composableos.app`,
      DRY_RUN: "false",
      CONFIRM: domain,
    },
    { FLEET_KEYS: keys64() },
  );
  assert.equal(code, 0, h.written.summary);
  assert.equal(h.calls.length, 1);
});

test("the workflows: actions pinned by commit, no install script or preloaded code beside the fleet's secrets, the teardown only behind the marker", () => {
  const read = (name) =>
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
  for (const name of ["fleet-operate.yml", "fleet-staging-check.yml", "client-db-proof.yml"]) {
    for (const m of read(name).matchAll(/uses:\s*(\S+)/g)) {
      assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]}`);
    }
  }
  const operateJob = read("fleet-operate.yml").split(/^ {2}operate:$/m)[1];
  assert.ok(operateJob, "the operate job");
  assert.match(operateJob, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(operateJob, /pnpm install --frozen-lockfile\s*$/m);
  assert.match(operateJob, /node packages\/db\/scripts\/schema-version\.mjs/);
  // The Run step's own NODE_OPTIONS, which wins over anything put in GITHUB_ENV before it.
  const runStep = operateJob.split("- name: Run\n")[1];
  assert.match(runStep, /^\s+NODE_OPTIONS: ""$/m);
  const teardown = read("fleet-staging-check.yml").split("- name: Teardown\n")[1].split("\n")[1];
  assert.match(teardown, /if: always\(\) && steps\.marker\.outcome == 'success'/);
});

// --- a client's first day (the follow-up to #547: reviews of #552 and #553) ----------------------

const EMAIL_IN = "Owner.Name@Gym-A.example";
const HASH = "0f".repeat(32);
const firstAdd = {
  ENV: "staging",
  COMMAND: "client-add",
  CLIENT: "gym-a",
  LOCATION: "oc",
  SETTINGS: "COS_PACKS=bookings,content,courses,programs,ticketing",
  LABEL: "Gym A",
  ADMIN_EMAIL: EMAIL_IN,
  ADMIN_TOKEN_SHA256: HASH,
};
/** Everything a run wrote where anyone could read it: the log and the summary. */
const everythingOf = (h) => `${h.written.summary}\n${h.written.log.join("\n")}`;

test("client-add: its packs, its label and its first admin reach cos; the address never the log or summary", async () => {
  // cos echoes its whole command line, as a careless one might.
  const h = harness({ cosAnswer: ({ argv }) => ({ code: 0, out: argv.join(" ") }) });
  assert.equal(await h.run(firstAdd), 0, h.written.summary);
  const { argv } = h.calls[0];
  assert.deepEqual(argv, [
    "client",
    "add",
    "gym-a",
    "--location",
    "oc",
    "--setting",
    "COS_PACKS=bookings,content,courses,programs,ticketing",
    "--label",
    "Gym A",
    "--admin",
    EMAIL_IN,
    "--admin-token-sha256",
    HASH,
    "--env",
    "staging",
    "--dry-run",
  ]);
  const everything = everythingOf(h);
  for (const form of [EMAIL_IN, EMAIL_IN.toLowerCase()]) {
    assert.ok(!everything.includes(form), "the address was written");
  }
  assert.match(everything, /<first admin's email>/);
  assert.match(h.written.summary, /- first admin: O\*\*\*@G\*\*\* \(redacted\)/);
  assert.match(h.written.summary, /- label: Gym A/);
  // Masked, in both forms, before anything was logged or summarised.
  const firstMask = h.written.events.findIndex(([k, v]) => k === "mask" && v === EMAIL_IN);
  const firstWrite = h.written.events.findIndex(([k]) => k !== "mask");
  assert.ok(firstMask >= 0 && firstMask < firstWrite, "masked before anything was written");
  assert.ok(h.written.masked.includes(EMAIL_IN.toLowerCase()));
  // A refusal is no different: the address is still masked and never written.
  const refused = harness();
  assert.equal(await refused.run({ ...firstAdd, ADMIN_TOKEN_SHA256: "" }), 2);
  assert.ok(refused.written.masked.includes(EMAIL_IN));
  assert.ok(!everythingOf(refused).includes(EMAIL_IN));
  assert.equal(redactEmail("owner@gym.example"), "o***@g***");
});

test("client-add: refused before cos without its packs, with *, with half a first admin, or a bad address, hash or label", async () => {
  const refusals = [
    [{ SETTINGS: "" }, /client-add needs the client's packs/],
    [{ SETTINGS: "COS_PRODUCT_LABEL=GymA" }, /client-add needs the client's packs/],
    [{ SETTINGS: "COS_PACKS=*" }, /COS_PACKS is never \*/],
    [{ SETTINGS: "COS_PACKS=ticketing,*" }, /COS_PACKS is never \*/],
    [{ ADMIN_TOKEN_SHA256: "" }, /admin_email and admin_token_sha256 go together/],
    [{ ADMIN_EMAIL: "" }, /admin_email and admin_token_sha256 go together/],
    [{ ADMIN_TOKEN_SHA256: HASH.toUpperCase() }, /admin_token_sha256 .* is not valid/],
    [{ ADMIN_TOKEN_SHA256: HASH.slice(1) }, /admin_token_sha256 .* is not valid/],
    [{ ADMIN_EMAIL: "-x@gym.example" }, /admin_email .* is not valid/],
    [{ ADMIN_EMAIL: "a b@gym.example" }, /admin_email .* is not valid/],
    [{ ADMIN_EMAIL: "owner@localhost" }, /admin_email .* is not valid/],
    [{ LABEL: " Gym A" }, /label .* is not valid/],
    [{ LABEL: "x".repeat(61) }, /label .* is not valid/],
    [{ LABEL: "<b>Gym</b>" }, /label .* is not valid/],
    [{ LABEL: "--take-over" }, /label .* is not valid/],
    [
      { SETTINGS: "COS_PACKS=ticketing COS_PRODUCT_LABEL=GymA" },
      /label and a COS_PRODUCT_LABEL setting are the same/,
    ],
    // The first admin goes through its own flags, never a setting.
    [{ SETTINGS: "COS_PACKS=ticketing COS_FIRST_ADMIN=x" }, /setting COS_FIRST_ADMIN is not/],
  ];
  for (const [change, why] of refusals) {
    const h = harness();
    const code = await h.run({ ...firstAdd, ...change });
    assert.equal(code, 2, JSON.stringify(change));
    assert.equal(h.calls.length, 0, JSON.stringify(change));
    assert.match(h.written.summary, why, JSON.stringify(change));
    assert.ok(!everythingOf(h).includes(EMAIL_IN), JSON.stringify(change));
  }
  // The first admin's inputs are client-add's and client-first-admin's only.
  for (const extra of [{ ADMIN_EMAIL: EMAIL_IN }, { ADMIN_TOKEN_SHA256: HASH }, { LABEL: "A" }]) {
    const h = harness();
    assert.equal(await h.run({ ENV: "staging", COMMAND: "client-list", ...extra }), 2);
    assert.match(h.written.summary, /is not taken by client-list/);
  }
});

test("client-first-admin: a dry run first, then confirmed by the client's id; the address never written", async () => {
  const inputs = {
    ENV: "staging",
    COMMAND: "client-first-admin",
    CLIENT: "gym-a",
    ADMIN_EMAIL: EMAIL_IN,
    ADMIN_TOKEN_SHA256: HASH,
  };
  const dry = harness({ cosAnswer: ({ argv }) => ({ code: 0, out: argv.join(" ") }) });
  assert.equal(await dry.run(inputs), 0);
  assert.deepEqual(dry.calls[0].argv, [
    "client",
    "first-admin",
    "gym-a",
    "--email",
    EMAIL_IN,
    "--token-sha256",
    HASH,
    "--env",
    "staging",
    "--dry-run",
  ]);
  assert.ok(!everythingOf(dry).includes(EMAIL_IN));
  // The command line shown names the address by a placeholder, not by ***.
  assert.match(everythingOf(dry), /--email <first admin's email>/);
  for (const confirm of [undefined, "gym-b", "gym-a:COS_FIRST_ADMIN"]) {
    const h = harness();
    const code = await h.run({
      ...inputs,
      DRY_RUN: "false",
      ...(confirm ? { CONFIRM: confirm } : {}),
    });
    assert.equal(code, 2, String(confirm));
    assert.equal(h.calls.length, 0, String(confirm));
  }
  const ok = harness();
  assert.equal(await ok.run({ ...inputs, DRY_RUN: "false", CONFIRM: "gym-a" }), 0);
  assert.equal(ok.calls[0].argv.at(-1), "--yes");
  assert.ok(!everythingOf(ok).includes(EMAIL_IN));
  // Both are needed: never a printed link instead.
  for (const missing of ["ADMIN_EMAIL", "ADMIN_TOKEN_SHA256"]) {
    const h = harness();
    assert.equal(await h.run({ ...inputs, [missing]: "" }), 2, missing);
    assert.equal(h.calls.length, 0);
  }
});

test("client-setting: COS_PACKS is never unset nor *, refused before cos", async () => {
  for (const [extra, why] of [
    [{ COMMAND: "client-setting-unset", SETTING_NAME: "COS_PACKS" }, /COS_PACKS is never unset/],
    [
      { COMMAND: "client-setting-set", SETTING_NAME: "COS_PACKS", SETTING_VALUE: "*" },
      /COS_PACKS is never \*/,
    ],
    [
      { COMMAND: "client-setting-set", SETTING_NAME: "COS_PACKS", SETTING_VALUE: "ticketing, *" },
      /COS_PACKS is never \*/,
    ],
  ]) {
    const h = harness();
    const code = await h.run({ ENV: "staging", CLIENT: "gym-a", CONFIRM: "gym-a", ...extra });
    assert.equal(code, 2, JSON.stringify(extra));
    assert.equal(h.calls.length, 0);
    assert.match(h.written.summary, why);
  }
  // A list widens as before; the list command never shows the address.
  const set = harness();
  assert.equal(
    await set.run({
      ENV: "staging",
      COMMAND: "client-setting-set",
      CLIENT: "gym-a",
      SETTING_NAME: "COS_PACKS",
      SETTING_VALUE: "ticketing,content",
    }),
    0,
  );
  const list = harness();
  assert.equal(
    await list.run({ ENV: "staging", COMMAND: "client-setting-list", CLIENT: "gym-a" }),
    0,
  );
  assert.ok(!list.calls[0].argv.includes("--show-email"));
});

const STREAM_TOKEN_VALUE = "stream_api_token_never_printed_0123456789";
const JWK = JSON.stringify({
  kty: "RSA",
  kid: "b".repeat(32),
  n: "modulus-never-printed-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  e: "AQAB",
  d: "private-exponent-never-printed-BBBBBBBBBBBBBBBBBBBB",
  p: "prime-p-never-printed-CCCCCCCCCCCCCCCCCCCCCCCC",
  q: "prime-q-never-printed-DDDDDDDDDDDDDDDDDDDDDDDD",
});
const STREAM_ACCOUNT_ID = "5".repeat(32);
const STREAM_IDS = {
  FLEET_STREAM_ACCOUNT_ID: STREAM_ACCOUNT_ID,
  FLEET_STREAM_CUSTOMER_CODE: "cust0mercode",
  FLEET_STREAM_SIGNING_KEY_ID: "b".repeat(32),
};
const STREAM_SECRETS = {
  FLEET_STREAM_API_TOKEN: STREAM_TOKEN_VALUE,
  FLEET_STREAM_SIGNING_JWK: JWK,
};
const realInstall = {
  ENV: "staging",
  COMMAND: "fleet-install",
  VERSION: "0.1.0-beta.16",
  DOMAIN: "staging.composableos.app",
  CALLBACK_HOSTNAME: "callback.staging.composableos.app",
  ZONE: "composableos.app",
  LOCATION: "oc",
  AI: "off",
  DRY_RUN: "false",
  CONFIRM: "staging.composableos.app",
};

test("fleet-install with Stream: five flags, the token and key by 0600 file removed after, nothing of them written", async () => {
  // cos prints everything it holds: its arguments and its files.
  const leaky = ({ argv, files }) => ({
    code: 0,
    out: [argv.join(" "), ...Object.values(files).map((f) => f.text)].join("\n"),
  });
  const h = harness({ cosAnswer: leaky });
  assert.equal(
    await h.run(realInstall, { FLEET_KEYS: keys64(), ...STREAM_IDS, ...STREAM_SECRETS }),
    0,
    h.written.summary,
  );
  const { argv, files } = h.calls[0];
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(at("--stream-account-id"), STREAM_ACCOUNT_ID);
  assert.equal(at("--stream-customer-code"), "cust0mercode");
  assert.equal(at("--stream-signing-key-id"), "b".repeat(32));
  for (const [flag, text] of [
    ["--stream-token-file", STREAM_TOKEN_VALUE],
    ["--stream-jwk-file", JWK],
  ]) {
    const path = at(flag);
    assert.equal(files[path]?.text, text, flag);
    assert.equal(files[path].mode, 0o600);
    assert.equal(files[path].dirMode, 0o700);
    assert.ok(!existsSync(path), `${flag} removed after`);
  }
  assert.deepEqual(readdirSync(h.tmp), []);
  const everything = everythingOf(h);
  for (const secret of [
    STREAM_TOKEN_VALUE,
    JWK,
    STREAM_ACCOUNT_ID,
    "modulus-never-printed-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "private-exponent-never-printed-BBBBBBBBBBBBBBBBBBBB",
    "prime-p-never-printed-CCCCCCCCCCCCCCCCCCCCCCCC",
  ]) {
    assert.ok(!everything.includes(secret), `${secret.slice(0, 20)}… was written`);
    assert.ok(h.written.masked.includes(secret), `${secret.slice(0, 20)}… was not masked`);
  }
  assert.match(h.written.summary, /- Stream: the operator's account/);
  // cos's environment holds none of them: they go by file and argument.
  for (const name of Object.keys({ ...STREAM_IDS, ...STREAM_SECRETS })) {
    assert.equal(h.calls[0].env[name], undefined, name);
  }
  // A base64 key is cut out by its parts too.
  const b64 = harness({ cosAnswer: leaky });
  await b64.run(realInstall, {
    FLEET_KEYS: keys64(),
    ...STREAM_IDS,
    ...STREAM_SECRETS,
    FLEET_STREAM_SIGNING_JWK: Buffer.from(JWK).toString("base64"),
  });
  assert.ok(!everythingOf(b64).includes("private-exponent-never-printed"));
});

test("fleet-install: Stream's five or none; without Stream an install still runs", async () => {
  const partial = [
    STREAM_IDS,
    STREAM_SECRETS,
    { ...STREAM_IDS, FLEET_STREAM_API_TOKEN: STREAM_TOKEN_VALUE },
    { ...STREAM_SECRETS, FLEET_STREAM_ACCOUNT_ID: STREAM_ACCOUNT_ID },
  ];
  for (const given of partial) {
    for (const dry of ["true", "false"]) {
      const h = harness();
      const code = await h.run(
        { ...realInstall, DRY_RUN: dry },
        { FLEET_KEYS: keys64(), ...given },
      );
      assert.equal(code, 2, `${Object.keys(given)} ${dry}`);
      assert.equal(h.calls.length, 0);
      assert.match(h.written.summary, /go together/);
    }
  }
  for (const bad of [
    { FLEET_STREAM_ACCOUNT_ID: "not-hex" },
    { FLEET_STREAM_SIGNING_KEY_ID: "B".repeat(32) },
    { FLEET_STREAM_CUSTOMER_CODE: "customer-x.cloudflarestream.com" },
  ]) {
    const h = harness();
    const inputs = { FLEET_KEYS: keys64(), ...STREAM_IDS, ...STREAM_SECRETS, ...bad };
    assert.equal(await h.run(realInstall, inputs), 2, JSON.stringify(bad));
    assert.equal(h.calls.length, 0);
  }
  const without = harness();
  assert.equal(await without.run(realInstall, { FLEET_KEYS: keys64() }), 0);
  assert.ok(!without.calls[0].argv.some((a) => a.startsWith("--stream-")));
  assert.match(without.written.summary, /- Stream: none/);
  // The ids are fleet-install's alone: another command ignores them, and takes no file.
  const upgrade = harness();
  assert.equal(
    await upgrade.run(
      { ENV: "staging", COMMAND: "fleet-upgrade", VERSION: "0.1.0-beta.16" },
      { FLEET_KEYS: keys64(), ...STREAM_IDS, ...STREAM_SECRETS },
    ),
    0,
  );
  assert.ok(!upgrade.calls[0].argv.some((a) => a.startsWith("--stream-")));
  assert.equal(Object.keys(upgrade.calls[0].files).length, 1);
});

test("cos runs with CI=true, so it refuses a printed setup link here", async () => {
  const h = harness();
  assert.equal(await h.run({ ENV: "staging", COMMAND: "client-list" }), 0);
  assert.equal(h.calls[0].env.CI, "true");
});

test("the workflow: the first admin's address masked by each job's first step, from the event, never from an expression in a script", () => {
  const text = readFileSync(
    new URL("../.github/workflows/fleet-operate.yml", import.meta.url),
    "utf8",
  );
  for (const job of ["inputs", "operate"]) {
    const body = text.split(new RegExp(`^ {2}${job}:$`, "m"))[1].split(/^ {2}\w+:$/m)[0];
    const first = body.split(/^\s+steps:\n/m)[1].split(/^\s+- /m)[1];
    assert.match(first, /^name: Mask the first admin's address/, job);
    assert.match(first, /jq -r '\.inputs\.admin_email/, job);
    assert.match(first, /::add-mask::/, job);
  }
  // The address reaches a step only as OP_ADMIN_EMAIL, never inside a run: script.
  for (const line of text.split("\n").filter((l) => l.includes("${{ inputs.admin_email"))) {
    assert.match(line, /^\s+OP_ADMIN_EMAIL: \$\{\{ inputs\.admin_email \}\}$/);
  }
  // Stream's token and key reach only fleet install.
  for (const name of ["FLEET_STREAM_API_TOKEN", "FLEET_STREAM_SIGNING_JWK"]) {
    const line = text.split("\n").find((l) => l.includes(`secrets.${name}`));
    assert.match(line, /inputs\.command == 'fleet-install' && secrets\./, name);
  }
});
