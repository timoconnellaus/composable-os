// Videos on a host of many clients (stage 66 step 9, G10): `cos fleet install` keeps the operator's
// Stream account with the deployment, against the fake Cloudflare API. Its ids are vars in the
// deployment's state, so an upgrade's upload sets them again; its token and signing key are the
// app Worker's secrets, which an upgrade's upload keeps (`keep_bindings`). Nothing of either is
// printed.
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSigningJwk } from "../src/fleet/stream.ts";

type World = Awaited<ReturnType<typeof import("./world.ts").startWorld>>;

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY_ID = "fedcba9876543210fedcba9876543210";
const TOKEN = randomBytes(30).toString("base64url");
const JWK = Buffer.from(
  JSON.stringify({
    kty: "RSA",
    n: randomBytes(64).toString("base64url"),
    e: "AQAB",
    d: "x".repeat(40),
  }),
).toString("base64");

function file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "s66-stream-")), "value");
  writeFileSync(path, `${text}\n`, { mode: 0o600 });
  return path;
}

const STREAM = [
  ...["--stream-account-id", ACCOUNT, "--stream-customer-code", "abc123xyz"],
  ...["--stream-signing-key-id", KEY_ID],
  ...["--stream-token-file", file(TOKEN), "--stream-jwk-file", file(JWK)],
];

async function install(world: World, ...extra: string[]) {
  const { runIn } = await import("./world.ts");
  const keysPath = join(mkdtempSync(join(tmpdir(), "s66-stream-keys-")), "live.json");
  expect((await runIn(world, "fleet", "keys", "--env", "live", "--out", keysPath)).code).toBe(0);
  const installed = await runIn(
    world,
    ...["fleet", "install", "--env", "live", "--keys-file", keysPath],
    ...["--callback-hostname", "callback.fleet.example", "--domain", "fleet.example"],
    ...["--version", "1.0.0", ...extra],
  );
  return { keysPath, installed };
}

/** The app Worker's Stream settings as Cloudflare holds them now. */
function onTheApp(world: World) {
  const script = world.cf.scripts.get("demo-app") as unknown as { secrets: Map<string, string> };
  const text = (name: string) =>
    (world.cf.liveBinding("demo-app", name) as { text?: string } | undefined)?.text;
  return {
    vars: {
      STREAM_ACCOUNT_ID: text("STREAM_ACCOUNT_ID"),
      STREAM_CUSTOMER_CODE: text("STREAM_CUSTOMER_CODE"),
      STREAM_SIGNING_KEY_ID: text("STREAM_SIGNING_KEY_ID"),
    },
    token: script.secrets.get("STREAM_API_TOKEN"),
    jwk: script.secrets.get("STREAM_SIGNING_JWK"),
  };
}

describe("the operator's Stream account on a fleet (G10)", () => {
  it("is set by install, kept by an upgrade's upload, and never printed", async () => {
    const { buildFixtureRelease } = await import("@composable-os/release/testing");
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      for (const version of ["1.0.0", "1.1.0"]) {
        await world.github.publish(
          await buildFixtureRelease({ version, fleet: true, clientGatekeepers: true }),
        );
      }
      const { keysPath, installed } = await install(world, ...STREAM);
      expect(installed.code, installed.output).toBe(0);
      const expected = {
        vars: {
          STREAM_ACCOUNT_ID: ACCOUNT,
          STREAM_CUSTOMER_CODE: "abc123xyz",
          STREAM_SIGNING_KEY_ID: KEY_ID,
        },
        token: TOKEN,
        jwk: JWK,
      };
      expect(onTheApp(world)).toEqual(expected);
      // The secrets are not in the stored metadata, and not in what cos said.
      expect(JSON.stringify(world.cf.live("demo-app")?.metadata)).not.toContain(TOKEN);
      const upgraded = await runIn(
        world,
        ...["fleet", "upgrade", "--env", "live", "--keys-file", keysPath, "--version", "1.1.0"],
        ...["--yes", "--skip-staging"],
      );
      expect(upgraded.code, upgraded.output).toBe(0);
      // A new upload of the app Worker, with every Stream setting as it was.
      expect(world.cf.liveBinding("demo-app", "COS_RELEASE_VERSION")).toMatchObject({
        text: "1.1.0",
      });
      expect(onTheApp(world)).toEqual(expected);
      for (const output of [installed.output, upgraded.output]) {
        expect(output).not.toContain(TOKEN);
        expect(output).not.toContain(JWK);
      }
    } finally {
      world.server.close();
    }
  });

  it("refuses half a configuration and a value that is not one, before anything is made", async () => {
    const { buildFixtureRelease } = await import("@composable-os/release/testing");
    const { startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      await world.github.publish(
        await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }),
      );
      const swap = (flag: string, value: string) => {
        const args = [...STREAM];
        args[args.indexOf(flag) + 1] = value;
        return args;
      };
      for (const [args, said] of [
        [
          STREAM.slice(0, 4),
          /--stream-signing-key-id, --stream-token-file, --stream-jwk-file are missing/,
        ],
        [swap("--stream-account-id", "not-an-id"), /32 hex/],
        [swap("--stream-jwk-file", file("not a key")), /signing key's JWK/],
        [swap("--stream-token-file", file("a token with spaces")), /API token/],
      ] as const) {
        const { installed } = await install(world, ...args);
        expect(installed.code, args.join(" ")).toBe(1);
        expect(installed.output).toMatch(said);
        expect(installed.output).not.toContain(TOKEN);
        expect(world.cf.scripts.has("demo-app")).toBe(false);
      }
      expect(isSigningJwk(JWK)).toBe(true);
      expect(isSigningJwk(Buffer.from('{"kty":"RSA","n":"x"}').toString("base64"))).toBe(false);
    } finally {
      world.server.close();
    }
  });
});
