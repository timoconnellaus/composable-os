// Stage 63 steps 1 to 3: the mobile app's identity from product.ts, `cos app check`, `credentials`,
// `build-info`, `record` and `upload`, and the template's workflow. Against the fake Cloudflare API
// and a fake GitHub serving a fixture release whose client kit is the real one.
//
// - 1: app.config.ts gives staging and live their own name, ids, scheme and host from product.ts;
//   no host address is written in the app's files.
// - 2: cos app check refuses each thing a store build may not have.
// - 3: cos app credentials names every secret and the command to set it, never a value; the check
//   fails with the missing ones.
// - 4: the workflow runs only from main on a person's run or a tag, never on a pull request; the
//   build jobs hold the store keys and no deploy credential; only the cos jobs hold that.
// - 5: cos app record writes core_app_build; cos app build-info gives the next number and the
//   generated client's API version.
// - 10: brand.ts is written from product.ts, and the native base theme reads it.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { repositoryPackIds } from "@composable-os/product/packs";
import { CloudflareClient } from "@composable-os/release";
import {
  buildFixtureRelease,
  FIXTURE_PRODUCT_DEFINITION as DEMO,
} from "@composable-os/release/testing";
import { build } from "esbuild";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectClientKit } from "../../../scripts/release/client-kit.ts";
import { APP_SECRETS, pngInfo } from "../src/app.ts";
import { Redactor } from "../src/io.ts";
import { runCli } from "../src/main.ts";
import { scanPurchases } from "../src/purchase-rules.ts";
import { ACCOUNT, startWorld, TOKEN, type World } from "./world.ts";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
// Inside the package, so module resolution finds the workspace packages; its own folder, as the
// other test files share .scratch while these run.
mkdirSync(join(here, ".scratch"), { recursive: true });
const scratchRoot = mkdtempSync(join(here, ".scratch", "app-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

let world: World;
let dir = "";
beforeEach(async () => {
  world = await startWorld();
});
afterEach(() => world.server.close());

/** The CLI in the repo, with more environment (CI secrets) and a fetch for the Android store. */
async function cos(
  argv: string[],
  options: { env?: Record<string, string>; fetch?: typeof fetch } = {},
) {
  const lines: string[] = [];
  const redactor = new Redactor();
  const code = await runCli([...argv, "--dir", dir], {
    io: {
      interactive: false,
      out: (l) => lines.push(redactor.clean(l)),
      err: (l) => lines.push(redactor.clean(l)),
      ask: async () => {
        throw new Error("no prompts in tests");
      },
    },
    redactor,
    products: { all: { [DEMO.id]: DEMO }, default: DEMO.id },
    env: { ...world.env, ...options.env },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ghVerifier: null,
    smokeDelayMs: 0,
  });
  return { code, output: lines.join("\n") };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

/** A PNG of a size, opaque (RGB) or with an alpha channel (RGBA). */
function png(width: number, height: number, alpha = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  const rows = Buffer.alloc((width * (alpha ? 4 : 3) + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LISTING: Record<string, string> = {
  "name.txt": "Example Gym",
  "subtitle.txt": "Classes, passes and courses",
  "description.txt": "Book classes, see what you have left and follow your courses.",
  "keywords.txt": "gym,classes,timetable",
  "release-notes.txt": "The first version.",
  "support-url.txt": "https://gym.example/support",
  "privacy-url.txt": "https://gym.example/privacy",
};

function productTs(platform: string, staging: { ios: string; android: string }) {
  return `import { defineClientProduct } from "@composable-os/product";

export const product = defineClientProduct({
  id: "gym",
  label: "Gym",
  ${platform}
  packs: [],
  web: { dir: "apps/web", worker: "gym-web" },
  mobile: {
    dir: "apps/mobile",
    app: {
      name: "Example Gym",
      version: "1.2.0",
      ids: { ios: "com.example.gym", android: "com.example.gym" },
      icon: "apps/mobile/assets/icon.png",
      splash: { image: "apps/mobile/assets/splash.png", background: "#101010" },
      colours: { primary: "#e11d48", background: "#ffffff", text: "#18181b" },
      listing: "apps/mobile/store",
      purchases: "none",
    },
  },
  environments: {
    staging: {
      live: false,
      hostname: "admin.staging.gym.example",
      web: { hostname: "staging.gym.example" },
      mobile: {
        scheme: "gym-staging",
        app: { name: "Gym (staging)", ids: ${JSON.stringify(staging)} },
      },
    },
    live: { hostname: "admin.gym.example", web: { hostname: "gym.example" } },
  },
});
`;
}

/** The shared test world carries a Cloudflare token; a run without one. */
const NO_TOKEN = { CLOUDFLARE_API_TOKEN: "" };

const STAGING_IDS = { ios: "com.example.gym.staging", android: "com.example.gym.staging" };

/** A gym's client repo with the app ready for the stores. */
async function gym() {
  const files = Object.fromEntries(
    [...collectClientKit(root, repositoryPackIds(root))].map(([p, b]) => [p, decode(b)]),
  );
  await world.github.publish(await buildFixtureRelease({ version: "1.0.0", client: files }));
  dir = join(mkdtempSync(join(scratchRoot, "app-")), "gym");
  const lines: string[] = [];
  const made = await runCli(["create", dir, "--with-mobile", "--label", "Gym"], {
    io: {
      interactive: false,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      ask: async () => "",
    },
    redactor: new Redactor(),
    products: { all: { [DEMO.id]: DEMO }, default: DEMO.id },
    env: world.env,
    ghVerifier: null,
  });
  expect(made, lines.join("\n")).toBe(0);
  const platform = /platform: \{[^}]*\},/.exec(read("product.ts"))?.[0] as string;
  write("product.ts", productTs(platform, STAGING_IDS));
  write("apps/mobile/assets/icon.png", png(1024, 1024));
  write("apps/mobile/assets/splash.png", png(200, 200, true));
  for (const [file, text] of Object.entries(LISTING))
    write(`apps/mobile/store/en-AU/${file}`, text);
  // The template's Account tab is My account's native shell, which cos create copied with its
  // "Delete my account" section (stage 48): nothing to add.
  const generated = await cos(["client", "generate"]);
  expect(generated.code, generated.output).toBe(0);
  return platform;
}

/** The app's config as the app framework reads it, for one environment. */
async function appConfig(env: Record<string, string>) {
  const out = join(dir, "..", `config-${Object.values(env).join("-")}.mjs`);
  await build({
    entryPoints: [join(dir, "apps/mobile/app.config.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
  });
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const module = (await import(pathToFileURL(out).href)) as {
      default: (c: { config: Record<string, unknown> }) => Record<string, unknown>;
    };
    return module.default({ config: {} });
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** The staging host: its database with the deployment state and core_app_build (step 4's). */
async function stagingHost(withTable = true) {
  const api = new CloudflareClient({
    token: TOKEN,
    apiBase: world.env.COS_CLOUDFLARE_API as string,
  });
  const db = await api.createD1(ACCOUNT, "gym-staging");
  await api.queryD1(
    ACCOUNT,
    db.uuid,
    "CREATE TABLE core_install (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
  );
  await api.queryD1(ACCOUNT, db.uuid, "INSERT INTO core_install VALUES ('deployment', ?, ?)", [
    JSON.stringify({ version: "1.0.0", accountId: ACCOUNT, workerNames: {}, resourceNames: {} }),
    new Date().toISOString(),
  ]);
  if (withTable) {
    await api.queryD1(
      ACCOUNT,
      db.uuid,
      `CREATE TABLE core_app_build (environment TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
        build_number INTEGER NOT NULL, api_version TEXT NOT NULL, app_id TEXT NOT NULL, commit_sha TEXT,
        uploaded_at TEXT NOT NULL, supported INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (environment, platform, build_number))`,
    );
  }
  return async () =>
    (
      await api.queryD1<Record<string, unknown>>(
        ACCOUNT,
        db.uuid,
        "SELECT * FROM core_app_build ORDER BY platform",
      )
    )[0]?.results ?? [];
}

describe("the app's identity from product.ts (criteria 1 and 10)", () => {
  it("app.config.ts gives staging and live their own name, ids, scheme and host", async () => {
    await gym();
    const staging = await appConfig({ COS_ENV: "staging", COS_APP_BUILD: "7" });
    expect(staging).toMatchObject({
      name: "Gym (staging)",
      slug: "gym-staging",
      scheme: "gym-staging",
      version: "1.2.0",
      icon: "./assets/icon.png",
      ios: { bundleIdentifier: "com.example.gym.staging", buildNumber: "7" },
      android: { package: "com.example.gym.staging", versionCode: 7 },
      extra: {
        environment: "staging",
        hostUrl: "https://admin.staging.gym.example",
        websiteUrl: "https://staging.gym.example/account",
      },
    });
    const live = await appConfig({ COS_ENV: "live" });
    expect(live).toMatchObject({
      name: "Example Gym",
      slug: "gym",
      scheme: "gym",
      ios: { bundleIdentifier: "com.example.gym", buildNumber: "1" },
      android: { package: "com.example.gym" },
      extra: { hostUrl: "https://admin.gym.example" },
    });
    await expect(appConfig({ COS_ENV: "" })).rejects.toThrow(/name the app's environment/);
    // No host address is written in the app's own files: only product.ts holds it.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(dir, d), { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.(tsx?|json)$/.test(e.name)) files.push(join(d, e.name));
      }
    };
    walk("apps/mobile");
    for (const file of files) expect(read(file), file).not.toMatch(/gym\.example|hostUrl:\s*"http/);
  });

  it("brand.ts is written from product.ts's colours, and the copied native base theme reads it", async () => {
    await gym();
    expect(read("apps/mobile/src/blocks/brand.ts")).toContain('primary: "#e11d48"');
    expect(read("apps/mobile/src/blocks/brand.ts")).toContain('onPrimary: "#ffffff"');
    write("product.ts", read("product.ts").replace('primary: "#e11d48"', 'primary: "#fde047"'));
    expect((await cos(["client", "generate"])).code).toBe(0);
    // Dark text on a light primary.
    expect(read("apps/mobile/src/blocks/brand.ts")).toContain('onPrimary: "#18181b"');
    const added = await cos(["add", "native-base"]);
    expect(added.code, added.output).toBe(0);
    const theme = join(dir, "apps/mobile/src/blocks/native-base/theme.ts");
    expect(readFileSync(theme, "utf8")).toContain('from "../brand.ts"');
    // A probe the type checker reads the theme with: its primary is product.ts's, by type.
    const probe = join(dir, "apps/mobile/src/blocks/probe.ts");
    writeFileSync(
      probe,
      'import { theme } from "./native-base/theme.ts";\nexport const primary: "#fde047" = theme.color.primary;\n',
    );
    const program = ts.createProgram([probe], {
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  });
});

describe("cos app check (criterion 2)", () => {
  it("passes a repo ready for the stores, and the template's own app buys nothing", async () => {
    await gym();
    const checked = await cos(["app", "check"], { env: NO_TOKEN });
    expect(checked.code, checked.output).toBe(0);
    expect(checked.output).toContain("ready for the stores' testing tracks");
    expect(checked.output).toContain("com.example.gym.staging");
    expect(checked.output).toContain(
      "Store ids not compared with recorded builds: no Cloudflare token",
    );
  });

  it("refuses each thing a store build may not have", async () => {
    await gym();
    const refused = async (change: () => void, message: RegExp, undo: () => void) => {
      change();
      const checked = await cos(["app", "check"], { env: NO_TOKEN });
      undo();
      expect(checked.code, checked.output).toBe(1);
      expect(checked.output).toMatch(message);
    };
    const keep = (path: string) => {
      const before = readFileSync(join(dir, path));
      return () => writeFileSync(join(dir, path), before);
    };
    let undo = keep("apps/mobile/assets/icon.png");
    await refused(
      () => write("apps/mobile/assets/icon.png", png(512, 512)),
      /is 512 by 512: it must be 1024 by 1024/,
      undo,
    );
    await refused(
      () => write("apps/mobile/assets/icon.png", png(1024, 1024, true)),
      /refuses an icon that is not opaque/,
      undo,
    );
    await refused(
      () => rmSync(join(dir, "apps/mobile/assets/icon.png")),
      /icon.png is not in the repo/,
      undo,
    );
    undo = keep("apps/mobile/store/en-AU/name.txt");
    await refused(
      () => write("apps/mobile/store/en-AU/name.txt", "N".repeat(31)),
      /name.txt is 31 characters: the stores take at most 30/,
      undo,
    );
    undo = keep("apps/mobile/store/en-AU/privacy-url.txt");
    await refused(
      () => write("apps/mobile/store/en-AU/privacy-url.txt", "gym.example/privacy"),
      /privacy-url.txt is not an https:\/\/ address/,
      undo,
    );
    const buys = "apps/mobile/src/buy.ts";
    await refused(
      () =>
        write(
          buys,
          'export const buy = (api: { call(n: string, i: object): unknown }) => api.call("x.courses.buy", {});\n',
        ),
      /buy.ts:1 names x.courses.buy: nothing is bought in the app/,
      () => rmSync(join(dir, buys)),
    );
    await refused(
      () =>
        write(
          buys,
          "export function Plan({ courses }: { courses: { useBuy(): unknown } }) {\n  return courses.useBuy();\n}\n",
        ),
      /buy.ts:2 names useBuy/,
      () => rmSync(join(dir, buys)),
    );
    // The Account tab is the native shell, whose delete block calls me.deleteAccount through the
    // account hooks: without that copied block, nothing in the app deletes an account.
    const deleteBlock = "apps/mobile/src/blocks/native-account-delete/delete.tsx";
    undo = keep(deleteBlock);
    await refused(() => rmSync(join(dir, deleteBlock)), /has no "Delete my account"/, undo);
    // The app's own code calling the operation counts too.
    write("apps/mobile/src/delete.ts", 'export const DELETE = "me.deleteAccount";\n');
    rmSync(join(dir, deleteBlock));
    const own = await cos(["app", "check"], { env: NO_TOKEN });
    expect(own.output).not.toMatch(/has no "Delete my account"/);
    undo();
    rmSync(join(dir, "apps/mobile/src/delete.ts"));
    await refused(
      () => write("apps/mobile/AuthKey_ABC123.p8", "key"),
      /AuthKey_ABC123.p8 looks like a signing or store key/,
      () => rmSync(join(dir, "apps/mobile/AuthKey_ABC123.p8")),
    );
    await refused(
      () =>
        write("upload-account.json", JSON.stringify({ type: "service_account", private_key: "x" })),
      /upload-account.json looks like a signing or store key/,
      () => rmSync(join(dir, "upload-account.json")),
    );
    undo = keep("apps/mobile/src/blocks/brand.ts");
    await refused(
      () => write("apps/mobile/src/blocks/brand.ts", "export const brand = {};\n"),
      /brand.ts is not product.ts's colours: run pnpm cos client generate/,
      undo,
    );
    undo = keep("product.ts");
    await refused(
      () => write("product.ts", read("product.ts").replace('hostname: "admin.gym.example", ', "")),
      /environment live: product.ts gives the host no hostname/,
      undo,
    );
    // What product.ts itself may not say is refused as it is loaded, as cos deploy loads it.
    await refused(
      () =>
        write(
          "product.ts",
          read("product.ts").replace(
            JSON.stringify(STAGING_IDS),
            '{"ios":"com.example.gym","android":"com.example.gym.staging"}',
          ),
        ),
      /environment live and environment staging have the same ios id com.example.gym/,
      undo,
    );
    await refused(
      () =>
        write("product.ts", read("product.ts").replace('scheme: "gym-staging",', 'scheme: "gym",')),
      /have the same scheme gym/,
      undo,
    );
    await refused(
      () => write("product.ts", read("product.ts").replace('text: "#18181b"', 'text: "#f4f4f5"')),
      /text is not readable on the background/,
      undo,
    );
    await refused(
      () =>
        write("product.ts", read("product.ts").replace('purchases: "none"', 'purchases: "store"')),
      /purchases must be "none"/,
      undo,
    );
    expect((await cos(["app", "check"], { env: NO_TOKEN })).code).toBe(0);
  });

  it("refuses an id that differs from a recorded build's, with the deploy credential", async () => {
    const platform = await gym();
    await stagingHost();
    const recorded = await cos([
      "app",
      "record",
      "--env",
      "staging",
      "--platform",
      "ios,android",
      "--build",
      "1",
      "--commit",
      "a".repeat(40),
    ]);
    expect(recorded.code, recorded.output).toBe(0);
    write(
      "product.ts",
      productTs(platform, { ios: "com.example.gym.beta", android: STAGING_IDS.android }),
    );
    const checked = await cos(["app", "check"]);
    expect(checked.code, checked.output).toBe(1);
    expect(checked.output).toContain(
      "staging: the ios app was recorded as com.example.gym.staging (build 1); product.ts now says com.example.gym.beta",
    );
    // The live host is not deployed yet: said, not refused.
    expect(checked.output).toContain("There is no live host in this account");
  });
});

describe("cos app credentials (criterion 3)", () => {
  const values = Object.fromEntries(
    APP_SECRETS.map((s) => [s.name, `value-of-${s.name.toLowerCase()}-0123456789`]),
  );

  it("names every secret the workflow reads and how a person sets it, and prints no value", async () => {
    await gym();
    const listed = await cos(["app", "credentials"], { env: values });
    expect(listed.code).toBe(0);
    const workflow = read(".github/workflows/app.yml");
    const used = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(APP_SECRETS.map((s) => s.name).sort());
    for (const secret of APP_SECRETS) {
      expect(listed.output).toContain(secret.name);
      expect(listed.output).toContain(secret.set);
      expect(listed.output).not.toContain(values[secret.name]);
    }
  });

  it("--check fails with the missing ones for a job, and passes when they are set", async () => {
    await gym();
    const { ANDROID_UPLOAD_KEYSTORE_PASSWORD: _, ...some } = values;
    const missing = await cos(["app", "credentials", "--check", "--for", "android"], { env: some });
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(
      "Missing a secret for the android job: ANDROID_UPLOAD_KEYSTORE_PASSWORD",
    );
    expect(missing.output).toContain(
      "gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD --env app-upload",
    );
    expect(missing.output).not.toContain("value-of");
    const set = await cos(["app", "credentials", "--check", "--for", "android"], { env: values });
    expect(set.code, set.output).toBe(0);
    expect(set.output).not.toContain("value-of");
  });
});

describe("the template's workflow (criterion 4)", () => {
  /** Each job's text, by its id under `jobs:`. */
  function jobs(text: string): Record<string, string> {
    const body = text.slice(text.indexOf("\njobs:\n"));
    const out: Record<string, string> = {};
    for (const part of body.split(/\n(?= {2}[a-z]+:\n)/).slice(1)) {
      out[(/^ {2}([a-z]+):/.exec(part) as RegExpExecArray)[1] as string] = part;
    }
    return out;
  }

  it("runs from main on a person's run or a tag; the build jobs hold store keys only; only cos jobs hold the deploy credential", () => {
    const text = readFileSync(join(root, "templates/client/.github/workflows/app.yml"), "utf8");
    const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
    expect(on).toContain("workflow_dispatch:");
    expect(on).toContain('tags: ["app-v*"]');
    expect(on).not.toMatch(/pull_request|branches/);
    const all = jobs(text);
    expect(Object.keys(all)).toEqual(["check", "android", "ios", "record"]);
    const secrets = (job: string) =>
      new Set([...(all[job] as string).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    const holds = (job: string) => APP_SECRETS.filter((s) => secrets(job).has(s.name));
    for (const job of ["check", "record"]) {
      expect(all[job]).toContain("environment: app-record");
      expect(
        holds(job).every((s) => s.job === "record"),
        job,
      ).toBe(true);
      expect(all[job]).toContain("cos app credentials --check --for record");
    }
    for (const job of ["android", "ios"]) {
      expect(all[job]).toContain("environment: app-upload");
      expect(
        holds(job)
          .map((s) => s.name)
          .sort(),
        job,
      ).toEqual(
        APP_SECRETS.filter((s) => s.job === job)
          .map((s) => s.name)
          .sort(),
      );
      expect(all[job]).not.toContain("CLOUDFLARE");
      expect(all[job]).toContain(`cos app credentials --check --for ${job}`);
    }
    expect(all.check).toContain("merge-base --is-ancestor");
    expect(all.check).toContain(
      "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/app-v')",
    );
    expect(all.android).toContain("cos app upload --platform android");
    expect(all.ios).toContain("<key>destination</key><string>upload</string>");
    expect(text).not.toMatch(/--track|production/);
  });
});

describe("cos app build-info and cos app record (criterion 5)", () => {
  it("records each platform's build in the host; the next number is the highest plus one", async () => {
    await gym();
    const rows = await stagingHost();
    const env = { CLOUDFLARE_API_TOKEN: TOKEN };
    const first = await cos(["app", "build-info", "--env", "staging", "--json"], { env });
    expect(first.code, first.output).toBe(0);
    expect(JSON.parse(first.output)).toEqual({
      environment: "staging",
      version: "1.2.0",
      build: 1,
      apiVersion: "v1",
      ids: STAGING_IDS,
    });
    const sha = "b".repeat(40);
    const recorded = await cos(
      [
        "app",
        "record",
        "--env",
        "staging",
        "--platform",
        "ios,android",
        "--build",
        "1",
        "--commit",
        sha,
      ],
      { env },
    );
    expect(recorded.code, recorded.output).toBe(0);
    expect(recorded.output).toContain(
      "Recorded: ios build 1 of Gym (staging) 1.2.0 (com.example.gym.staging, API v1) for staging.",
    );
    expect(await rows()).toEqual([
      expect.objectContaining({
        platform: "android",
        build_number: 1,
        app_id: STAGING_IDS.android,
        app_version: "1.2.0",
        api_version: "v1",
        commit_sha: sha,
        supported: 1,
      }),
      expect.objectContaining({
        platform: "ios",
        build_number: 1,
        app_id: STAGING_IDS.ios,
        environment: "staging",
      }),
    ]);
    // A re-run of the same record is a no-op; a used number from another commit is refused.
    const again = await cos(
      ["app", "record", "--env", "staging", "--platform", "ios", "--build", "1", "--commit", sha],
      { env },
    );
    expect(again.output).toContain("Already recorded: ios build 1");
    const used = await cos(
      [
        "app",
        "record",
        "--env",
        "staging",
        "--platform",
        "ios",
        "--build",
        "1",
        "--commit",
        "c".repeat(40),
      ],
      { env },
    );
    expect(used.code).toBe(1);
    expect(used.output).toContain("Not recorded: ios build 1 is already recorded");
    const next = await cos(["app", "build-info", "--env", "staging"], { env });
    expect(next.output).toContain("Gym (staging) (staging) 1.2.0, build 2, API v1");
    expect((await rows()).length).toBe(2);
  });

  it("needs the deploy credential, and a host without core_app_build records nothing", async () => {
    await gym();
    const plain = await cos(["app", "build-info", "--env", "staging"], { env: NO_TOKEN });
    expect(plain.code).toBe(1);
    expect(plain.output).toContain("give the deploy credential (CLOUDFLARE_API_TOKEN)");
    await stagingHost(false);
    const env = { CLOUDFLARE_API_TOKEN: TOKEN };
    const old = await cos(
      ["app", "record", "--env", "staging", "--platform", "ios", "--build", "1"],
      { env },
    );
    expect(old.code).toBe(1);
    expect(old.output).toContain("the host has no core_app_build yet");
    expect(
      (await cos(["app", "build-info", "--env", "staging", "--json"], { env })).output,
    ).toContain('"build":1');
  });
});

describe("cos app upload (the Android build to the internal testing track)", () => {
  it("sends the bundle, the listing with --listing, and the release notes in one edit; never another track", async () => {
    await gym();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = {
      type: "service_account",
      client_email: "uploader@example.iam",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://store-token.test/token",
    };
    const calls: { method: string; url: string; body: string }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      const body =
        init?.body instanceof Uint8Array ? `<${init.body.length} bytes>` : String(init?.body ?? "");
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url === account.token_uri) {
        const assertion = new URLSearchParams(body).get("assertion") as string;
        const [head, claims, signature] = assertion.split(".") as [string, string, string];
        const verified = createVerify("RSA-SHA256")
          .update(`${head}.${claims}`)
          .verify(publicKey, Buffer.from(signature, "base64url"));
        const claimed = JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<
          string,
          unknown
        >;
        if (
          !verified ||
          claimed.iss !== account.client_email ||
          claimed.aud !== account.token_uri
        ) {
          return new Response("{}", { status: 401 });
        }
        return Response.json({ access_token: "store-access-token" });
      }
      if (url.endsWith("/edits") && init?.method === "POST") return Response.json({ id: "edit-1" });
      if (url.includes("/bundles?uploadType=media")) return Response.json({ versionCode: 3 });
      return Response.json({});
    };
    write("dist/app-release.aab", "bundle-bytes");
    const env = {
      ANDROID_STORE_SERVICE_ACCOUNT: JSON.stringify(account),
      COS_ANDROID_STORE_API: "https://store.test",
    };
    const sent = await cos(
      [
        "app",
        "upload",
        "--platform",
        "android",
        "--env",
        "staging",
        "--file",
        join(dir, "dist/app-release.aab"),
        "--listing",
        "--draft",
      ],
      { env, fetch: fake },
    );
    expect(sent.code, sent.output).toBe(0);
    expect(sent.output).toContain(
      "Sent com.example.gym.staging build 3 to the Android store's internal testing track, with the listing (a draft release)",
    );
    expect(sent.output).not.toContain("PRIVATE KEY");
    const app = "https://store.test/androidpublisher/v3/applications/com.example.gym.staging/edits";
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${account.token_uri}`,
      `POST ${app}`,
      "POST https://store.test/upload/androidpublisher/v3/applications/com.example.gym.staging/edits/edit-1/bundles?uploadType=media",
      `PUT ${app}/edit-1/listings/en-AU`,
      `PUT ${app}/edit-1/tracks/internal`,
      `POST ${app}/edit-1:commit`,
    ]);
    expect(JSON.parse(calls[3]?.body as string)).toEqual({
      language: "en-AU",
      title: LISTING["name.txt"],
      shortDescription: LISTING["subtitle.txt"],
      fullDescription: LISTING["description.txt"],
    });
    expect(JSON.parse(calls[4]?.body as string)).toEqual({
      track: "internal",
      releases: [
        {
          versionCodes: ["3"],
          status: "draft",
          releaseNotes: [{ language: "en-AU", text: LISTING["release-notes.txt"] }],
        },
      ],
    });
    // Without --listing the store's listing is left as it is.
    calls.length = 0;
    expect(
      (
        await cos(
          [
            "app",
            "upload",
            "--platform",
            "android",
            "--env",
            "staging",
            "--file",
            join(dir, "dist/app-release.aab"),
          ],
          { env, fetch: fake },
        )
      ).code,
    ).toBe(0);
    expect(calls.some((c) => c.url.includes("/listings/"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/tracks/internal"))?.body).toContain(
      '"status":"completed"',
    );
    const ios = await cos([
      "app",
      "upload",
      "--platform",
      "ios",
      "--env",
      "staging",
      "--file",
      "x.aab",
    ]);
    expect(ios.code).toBe(1);
    expect(ios.output).toContain("sent by the app workflow with the platform's own upload tool");
  });
});

describe("the purchase scan's rules", () => {
  it("finds buying operations and hooks in code, not reading what a person has, nor words", () => {
    expect(scanPurchases('api.call("order.start", input)').map((p) => p.names)).toEqual([
      "order.start",
    ]);
    expect(scanPurchases("const { start } = memberships.useBuy();").map((p) => p.names)).toEqual([
      "useBuy",
    ]);
    expect(scanPurchases('api.call("x.ticketing.orderStart", {})')[0]?.names).toBe(
      "x.ticketing.orderStart",
    );
    expect(scanPurchases('api.call("subscription.portal", {})')[0]?.line).toBe(1);
    expect(scanPurchases('api.call("order.get", {}); api.call("subscription.list", {});')).toEqual(
      [],
    );
    expect(
      scanPurchases('// useBuy() is on the website\nconst words = "Buy it on the website";'),
    ).toEqual([]);
  });

  it("reads a PNG's size and whether it can be transparent", () => {
    expect(pngInfo(png(1024, 1024))).toEqual({ width: 1024, height: 1024, alpha: false });
    expect(pngInfo(png(10, 20, true))).toEqual({ width: 10, height: 20, alpha: true });
    expect(pngInfo(new TextEncoder().encode("not a png at all, just some text here"))).toBeNull();
  });
});
