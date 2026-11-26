// A client's secrets and addresses on a host that serves many clients (stage 66 step 6, ADR
// 0616): derived secrets differ per client, purpose and environment; given secrets are sealed in
// the registry under the host's key, bound to their client and name; a client's environment
// holds its own secrets and addresses and nothing of another's or of the host's; and a known
// secret value is found nowhere it must not be (criterion 10).
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatekeeperBaseUrl, isCallbackHostname, isCallbackRequest } from "../src/callbacks.ts";
import type { ClientDb } from "../src/client-db.ts";
import { ENV_NAMES } from "../src/client-env-names.ts";
import { ClientDirectory, envNameUse } from "../src/client-environment.ts";
import { buildClientEnvironment } from "../src/client-environment-build.ts";
import { type ClientId, readRegistry } from "../src/registry.ts";
import {
  DERIVED_SECRETS,
  derivationInfo,
  deriveClientSecret,
  deriveClientSecrets,
  GIVEN_SECRET_NAMES,
  isGivenSecretName,
  newHostKey,
  openClientSecret,
  readClientSecrets,
  removeClientSecret,
  SecretUnreadable,
  sealClientSecret,
  secretsKeyring,
  writeClientSecret,
} from "../src/registry-secrets.ts";
import {
  emptyRegistry,
  insertClient,
  insertHostname,
  migrateRegistry,
} from "./registry-fixtures.ts";

const real = env as unknown as {
  DB: D1Database;
  REGISTRY: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
};

const A = "gym-a" as ClientId;
const B = "gym-b" as ClientId;

// Keys made here for the tests: obviously not anyone's.
const ROOT = newHostKey();
const OTHER_ROOT = newHostKey();
const SECRETS_KEY = newHostKey();
const OLD_SECRETS_KEY = newHostKey();

/** A value no code could produce by chance: what every scan below looks for. */
const known = (label: string) => `s66e-known-${label}-${crypto.randomUUID()}`;

function manyClientEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: real.DB,
    REGISTRY: real.REGISTRY,
    CLIENT_DB: real.CLIENT_DB,
    COS_HOST_ENVIRONMENT: "live",
    COS_ROOT_KEY: ROOT,
    COS_SECRETS_KEY: SECRETS_KEY,
    COS_CALLBACK_HOSTNAME: "callbacks.fleet.example",
    // The host's own values of per-client names: never in a client's environment.
    BETTER_AUTH_SECRET: "the-host-wide-auth-secret-never-a-clients",
    CUSTOMER_AUTH_SECRET: "the-host-wide-customer-secret-never-a-clients",
    DESK_SECRET: "the-host-wide-desk-secret-never-a-clients",
    AI_KEY_OPENAI: "the-host-wide-ai-key-never-a-clients",
    TURNSTILE_SECRET_KEY: "the-host-wide-turnstile-never-a-clients",
    BETTER_AUTH_URL: "https://the-host-wide-address.example",
    APP_ORIGIN: "https://the-host-wide-address.example",
    CUSTOMER_AUTH_URL: "https://the-host-wide-address.example",
    MCP_RESOURCE: "https://the-host-wide-address.example/mcp",
    DESK_HOSTNAME: "desk.the-host-wide-address.example",
    NATIVE_REDIRECT_URIS: "hostapp://staff-sign-in",
    ...extra,
  };
}

function served<E>(admission: { served: true; env: E } | { served: false; refused: string }): E {
  if (!admission.served) throw new Error(`refused: ${admission.refused}`);
  return admission.env;
}

const fields = (value: unknown) => value as Record<string, unknown>;

async function seedTwoClients() {
  await real.REGISTRY.batch([
    insertClient(real.REGISTRY, { id: A }),
    insertClient(real.REGISTRY, { id: B }),
    insertHostname(real.REGISTRY, "gym-a-admin.fleet.example", A, "staff"),
    insertHostname(real.REGISTRY, "gym-a.com", A, "web"),
    insertHostname(real.REGISTRY, "gym-a-desk.fleet.example", A, "desk"),
    insertHostname(real.REGISTRY, "gym-b-admin.fleet.example", B, "staff"),
  ]);
}

beforeAll(async () => {
  await migrateRegistry();
});

beforeEach(async () => {
  await emptyRegistry();
});

describe("derived secrets", () => {
  it("differ per client, per purpose and per environment, and with another root", async () => {
    const seen = new Set<string>();
    for (const environment of ["live", "staging"] as const) {
      for (const client of [A, B]) {
        const all = await deriveClientSecrets(ROOT, environment, client);
        expect(Object.keys(all).sort()).toEqual(Object.keys(DERIVED_SECRETS).sort());
        for (const value of Object.values(all)) {
          expect(value).toMatch(/^[0-9a-f]{64}$/);
          seen.add(value);
        }
      }
    }
    // 2 environments x 2 clients x 3 purposes, all different.
    expect(seen.size).toBe(2 * 2 * Object.keys(DERIVED_SECRETS).length);
    const other = await deriveClientSecret(OTHER_ROOT, "live", A, "BETTER_AUTH_SECRET");
    expect(seen.has(other)).toBe(false);
  });

  it("are the same every time for one client and purpose, and never the root", async () => {
    const one = await deriveClientSecret(ROOT, "live", A, "DESK_SECRET");
    expect(await deriveClientSecret(ROOT, "live", A, "DESK_SECRET")).toBe(one);
    expect(one).not.toContain(ROOT);
    // The customer secret must differ from the staff one (packages/auth refuses them equal).
    const all = await deriveClientSecrets(ROOT, "live", A);
    expect(all.CUSTOMER_AUTH_SECRET).not.toBe(all.BETTER_AUTH_SECRET);
  });

  it("bind the scheme's version, environment, purpose and client into an unambiguous info", () => {
    expect(derivationInfo("live", "staff-auth", 1, A)).toBe(
      "cos/client-secret/v1/live/staff-auth/gym-a",
    );
    expect(() => derivationInfo("live", "staff/auth", 1, A)).toThrow(RangeError);
    expect(() => derivationInfo("live", "staff-auth", 0, A)).toThrow(RangeError);
  });

  it("refuse a name that is not derived, a bad client id and a malformed root, without echoing it", async () => {
    await expect(deriveClientSecret(ROOT, "live", A, "GOOGLE_CLIENT_SECRET")).rejects.toThrow(
      /not a derived secret/,
    );
    await expect(
      deriveClientSecret(ROOT, "live", "Admin" as ClientId, "DESK_SECRET"),
    ).rejects.toThrow(RangeError);
    const malformed = "short-root-key-s66e";
    const error = await deriveClientSecret(malformed, "live", A, "DESK_SECRET").catch((e) => e);
    expect(String(error)).toMatch(/COS_ROOT_KEY is not 32 bytes/);
    expect(String(error)).not.toContain(malformed);
  });

  it("are every per-client derived name of ENV_NAMES, and given names are the given ones", () => {
    const derived = Object.entries(ENV_NAMES)
      .filter(
        ([, use]) => use.use === "per-client" && use.what === "secret" && use.from === "derived",
      )
      .map(([name]) => name)
      .sort();
    expect(derived).toEqual(Object.keys(DERIVED_SECRETS).sort());
    const given = Object.entries(ENV_NAMES)
      .filter(
        ([, use]) => use.use === "per-client" && use.what === "secret" && use.from === "given",
      )
      .map(([name]) => name)
      .sort();
    expect(given).toEqual([...GIVEN_SECRET_NAMES].sort());
    expect(envNameUse("AI_KEY_ANTHROPIC")).toMatchObject({ what: "secret", from: "given" });
    expect(isGivenSecretName("AI_KEY_ANTHROPIC")).toBe(true);
    for (const name of Object.keys(DERIVED_SECRETS)) expect(isGivenSecretName(name)).toBe(false);
  });
});

describe("given secrets", () => {
  it("seal with a fresh nonce each time and open where they belong", async () => {
    const keyring = await secretsKeyring(SECRETS_KEY);
    const place = { environment: "live", client: A, name: "GOOGLE_CLIENT_SECRET" } as const;
    const value = known("google");
    const one = await sealClientSecret(keyring, place, value);
    const two = await sealClientSecret(keyring, place, value);
    expect(one.iv.length).toBe(12);
    expect(one.iv).not.toEqual(two.iv);
    expect(one.ciphertext).not.toEqual(two.ciphertext);
    expect(one.keyId).toBe(keyring.current.id);
    expect(one.keyId).toMatch(/^k1-[0-9a-f]{16}$/);
    expect(await openClientSecret(keyring, place, one)).toBe(value);
    // The ciphertext holds nothing readable of the value.
    expect(new TextDecoder().decode(one.ciphertext)).not.toContain(value);
  });

  it("never open for another client, name or environment, under another key, or tampered with", async () => {
    const keyring = await secretsKeyring(SECRETS_KEY);
    const value = known("moved");
    const place = { environment: "live", client: A, name: "TYPESAFE_API_KEY" } as const;
    const sealed = await sealClientSecret(keyring, place, value);
    const errors: unknown[] = [];
    const attempt = async (p: typeof place | Record<string, unknown>, s = sealed, k = keyring) => {
      const error = await openClientSecret(k, p as typeof place, s).catch((e) => e);
      expect(error).toBeInstanceOf(SecretUnreadable);
      errors.push(error);
    };
    await attempt({ ...place, client: B });
    await attempt({ ...place, name: "AI_KEY_OPENAI" });
    await attempt({ ...place, environment: "staging" });
    await attempt(place, sealed, await secretsKeyring(newHostKey()));
    const flipped = new Uint8Array(sealed.ciphertext);
    flipped[0] = (flipped[0] as number) ^ 1;
    await attempt(place, { ...sealed, ciphertext: flipped });
    // A key id claimed by a row does not change which key opens it.
    const other = await secretsKeyring(newHostKey());
    await attempt(place, { ...sealed, keyId: other.current.id });
    for (const error of errors) expect(String((error as Error).message)).not.toContain(value);
  });

  it("open rows sealed under the previous key during a rotation, and seal under the current", async () => {
    const old = await secretsKeyring(OLD_SECRETS_KEY);
    const place = { environment: "live", client: A, name: "AI_KEY_OPENAI" } as const;
    const value = known("rotated");
    const sealed = await sealClientSecret(old, place, value);
    const rotated = await secretsKeyring(SECRETS_KEY, OLD_SECRETS_KEY);
    expect(await openClientSecret(rotated, place, sealed)).toBe(value);
    expect((await sealClientSecret(rotated, place, value)).keyId).toBe(rotated.current.id);
    // Once the previous key is dropped, the old row no longer opens.
    await expect(
      openClientSecret(await secretsKeyring(SECRETS_KEY), place, sealed),
    ).rejects.toThrow(SecretUnreadable);
  });

  it("refuse a derived or unknown name, an empty or over-long value and a bad client, without echoing it", async () => {
    const keyring = await secretsKeyring(SECRETS_KEY);
    const at = (name: string, client: ClientId = A) =>
      ({ environment: "live", client, name }) as const;
    await expect(sealClientSecret(keyring, at("BETTER_AUTH_SECRET"), "x")).rejects.toThrow(
      /not a given secret/,
    );
    await expect(sealClientSecret(keyring, at("SOMETHING_ELSE"), "x")).rejects.toThrow(
      /not a given secret/,
    );
    await expect(sealClientSecret(keyring, at("AI_KEY_OPENAI"), "")).rejects.toThrow(/empty/);
    const long = `s66e-${"x".repeat(17_000)}`;
    const error = await sealClientSecret(keyring, at("AI_KEY_OPENAI"), long).catch((e) => e);
    expect(String(error)).toMatch(/over 16384 bytes/);
    expect(String(error)).not.toContain("xxxxxxxx");
    await expect(
      sealClientSecret(keyring, at("AI_KEY_OPENAI", "Admin" as ClientId), "x"),
    ).rejects.toThrow(RangeError);
    await expect(secretsKeyring("not-a-key-s66e")).rejects.toThrow(/COS_SECRETS_KEY is not 32/);
  });

  it("copied from client A's row to client B's, fail to open and are left out of B's environment", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    const value = known("copied");
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: A, name: "GOOGLE_CLIENT_SECRET" },
      value,
    );
    // Someone with write access to the registry copies the row to B.
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, ciphertext, iv, key_id) SELECT ?, name, ciphertext, iv, key_id FROM registry_secrets WHERE client = ?",
    )
      .bind(B, A)
      .run();
    const forB = await readClientSecrets(real.REGISTRY, keyring, "live", B);
    expect(forB.values).toEqual({});
    expect(forB.problems).toEqual([
      expect.stringMatching(/GOOGLE_CLIENT_SECRET of gym-b left out: .*does not open here/),
    ]);
    expect(forB.problems.join()).not.toContain(value);
    const forA = await readClientSecrets(real.REGISTRY, keyring, "live", A);
    expect(forA.values).toEqual({ GOOGLE_CLIENT_SECRET: value });
    // Renamed in place, it does not open either.
    await real.REGISTRY.prepare(
      "UPDATE registry_secrets SET name = 'AI_KEY_OPENAI' WHERE client = ?",
    )
      .bind(A)
      .run();
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).values).toEqual({});
  });

  it("are replaced and removed by the operator's functions, moving the registry's stamp", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    const place = { environment: "live", client: A, name: "TURNSTILE_SECRET_KEY" } as const;
    const before = (await readRegistry(real.REGISTRY)).stamp;
    await writeClientSecret(real.REGISTRY, keyring, place, known("first"));
    const second = known("second");
    await writeClientSecret(real.REGISTRY, keyring, place, second);
    const afterWrite = (await readRegistry(real.REGISTRY)).stamp;
    expect(afterWrite).not.toBe(before);
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).values).toEqual({
      TURNSTILE_SECRET_KEY: second,
    });
    await removeClientSecret(real.REGISTRY, A, "TURNSTILE_SECRET_KEY");
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).values).toEqual({});
    expect((await readRegistry(real.REGISTRY)).stamp).not.toBe(afterWrite);
  });

  it("are left out, named, when the host has no secrets key or the row's name is not a given one", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: A, name: "CF_ACCESS_AUD" },
      known("aud"),
    );
    const without = await readClientSecrets(real.REGISTRY, null, "live", A);
    expect(without.values).toEqual({});
    expect(without.problems).toEqual([expect.stringMatching(/COS_SECRETS_KEY is not set/)]);
    // A derived name written straight into the table (not through `writeClientSecret`).
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, ciphertext, iv, key_id) VALUES (?, 'BETTER_AUTH_SECRET', x'00', zeroblob(12), 'k1-0000000000000000')",
    )
      .bind(A)
      .run();
    const opened = await readClientSecrets(real.REGISTRY, keyring, "live", A);
    expect(Object.keys(opened.values)).toEqual(["CF_ACCESS_AUD"]);
    expect(opened.problems).toEqual([expect.stringMatching(/BETTER_AUTH_SECRET .*not a given/)]);
  });
});

describe("addresses", () => {
  it("come from the client's verified hostnames: the marked one, or the only one", async () => {
    await real.REGISTRY.batch([
      insertClient(real.REGISTRY, { id: A }),
      insertClient(real.REGISTRY, { id: B }),
      insertHostname(real.REGISTRY, "gym-a-admin.fleet.example", A, "staff"),
      insertHostname(real.REGISTRY, "admin.gym-a.com", A, "staff", true, true),
      insertHostname(real.REGISTRY, "gym-a.com", A, "web"),
      // An unverified hostname is never an address, even marked.
      insertHostname(real.REGISTRY, "desk.gym-a.com", A, "desk", false, true),
      // Two staff hostnames and none marked: no staff address, and the operator is told.
      insertHostname(real.REGISTRY, "one.gym-b.com", B, "staff"),
      insertHostname(real.REGISTRY, "two.gym-b.com", B, "staff"),
    ]);
    const snapshot = await readRegistry(real.REGISTRY);
    expect(snapshot.addresses.get(A)).toEqual({
      staff: "admin.gym-a.com",
      web: "gym-a.com",
      desk: null,
      hostnames: ["admin.gym-a.com", "gym-a-admin.fleet.example", "gym-a.com"],
    });
    expect(snapshot.addresses.get(B)).toMatchObject({ staff: null, web: null, desk: null });
    expect(snapshot.problems).toEqual([
      expect.stringMatching(/gym-b has 2 verified staff hostnames and none marked/),
    ]);
  });

  it("allow one marked hostname per client and surface", async () => {
    await real.REGISTRY.batch([
      insertClient(real.REGISTRY, { id: A }),
      insertHostname(real.REGISTRY, "one.gym-a.com", A, "staff", true, true),
    ]);
    await expect(
      insertHostname(real.REGISTRY, "two.gym-a.com", A, "staff", true, true).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("fill every address name of a client's environment, and none from the host's own", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv());
    const a = fields(served(await directory.environmentFor(A)));
    expect(a.BETTER_AUTH_URL).toBe("https://gym-a-admin.fleet.example");
    expect(a.APP_ORIGIN).toBe("https://gym-a-admin.fleet.example");
    expect(a.MCP_RESOURCE).toBe("https://gym-a-admin.fleet.example/mcp");
    expect(a.CUSTOMER_AUTH_URL).toBe("https://gym-a.com");
    expect(a.DESK_HOSTNAME).toBe("gym-a-desk.fleet.example");
    expect(a.STREAM_ALLOWED_ORIGINS).toBe(
      "https://gym-a-admin.fleet.example,https://gym-a-desk.fleet.example,https://gym-a.com",
    );
    // B has a staff hostname only: customers sign in at its staff address, as on a host today
    // with no web app; it has no desk; its native redirects are its own setting, which it lacks.
    const b = fields(served(await directory.environmentFor(B)));
    expect(b.BETTER_AUTH_URL).toBe("https://gym-b-admin.fleet.example");
    expect(b.CUSTOMER_AUTH_URL).toBe("https://gym-b-admin.fleet.example");
    expect("DESK_HOSTNAME" in b).toBe(false);
    expect("NATIVE_REDIRECT_URIS" in b).toBe(false);
    for (const value of Object.values(a)) {
      if (typeof value === "string") expect(value).not.toContain("the-host-wide");
    }
  });

  it("are never taken from the request: the hostname a client is reached on changes nothing", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv());
    const onWeb = await directory.clientForHostname("gym-a.com");
    const onStaff = await directory.clientForHostname("gym-a-admin.fleet.example");
    expect(onWeb.served && onStaff.served).toBe(true);
    if (!onWeb.served || !onStaff.served) return;
    expect(onWeb.env).toBe(onStaff.env);
    expect(fields(onWeb.env).BETTER_AUTH_URL).toBe("https://gym-a-admin.fleet.example");
  });
});

describe("the one callback address", () => {
  it("is no client's, even one the registry names", async () => {
    await real.REGISTRY.batch([
      insertClient(real.REGISTRY, { id: A }),
      insertHostname(real.REGISTRY, "callbacks.fleet.example", A, "staff"),
    ]);
    const directory = new ClientDirectory(manyClientEnv());
    expect(await directory.clientForHostname("callbacks.fleet.example")).toEqual({
      served: false,
      refused: "unknown",
      client: null,
    });
    expect(await directory.clientForHostname("CALLBACKS.fleet.example.")).toMatchObject({
      served: false,
    });
  });

  it("serves only gatekeepers' paths, on exactly its hostname", () => {
    const host = { COS_CALLBACK_HOSTNAME: "callbacks.fleet.example" };
    expect(
      isCallbackRequest(host, new URL("https://callbacks.fleet.example/gatekeeper/google/oauth")),
    ).toEqual({ vendor: "google" });
    expect(isCallbackRequest(host, new URL("https://callbacks.fleet.example/api/v1/people"))).toBe(
      null,
    );
    expect(isCallbackRequest(host, new URL("https://callbacks.fleet.example/"))).toBeNull();
    expect(
      isCallbackRequest(host, new URL("https://gym-a.callbacks.fleet.example/gatekeeper/google")),
    ).toBeNull();
    expect(
      isCallbackRequest(host, new URL("https://callbacks.fleet.example.evil.test/gatekeeper/x1")),
    ).toBeNull();
    expect(
      isCallbackRequest({}, new URL("https://callbacks.fleet.example/gatekeeper/google")),
    ).toBe(null);
    expect(isCallbackHostname(host, "callbacks.fleet.example")).toBe(true);
    expect(isCallbackHostname(host, "gym-a.com")).toBe(false);
    expect(gatekeeperBaseUrl(host, "payments")).toBe(
      "https://callbacks.fleet.example/gatekeeper/payments",
    );
    expect(() => gatekeeperBaseUrl(host, "../x")).toThrow(RangeError);
    expect(() =>
      isCallbackHostname({ COS_CALLBACK_HOSTNAME: "Callbacks.Example:443" }, "x"),
    ).toThrow(/COS_CALLBACK_HOSTNAME/);
  });
});

describe("a client's environment (criterion 10)", () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
        );
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds only its own secrets and addresses, never another client's or the host's own", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    const aGoogle = known("a-google");
    const bGoogle = known("b-google");
    const aAi = known("a-ai");
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: A, name: "GOOGLE_CLIENT_SECRET" },
      aGoogle,
    );
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: A, name: "AI_KEY_DEEPSEEK" },
      aAi,
    );
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: B, name: "GOOGLE_CLIENT_SECRET" },
      bGoogle,
    );
    const host = manyClientEnv();
    const directory = new ClientDirectory(host);
    const a = fields(served(await directory.environmentFor(A)));
    const b = fields(served(await directory.environmentFor(B)));
    const derivedA = await deriveClientSecrets(ROOT, "live", A);
    const derivedB = await deriveClientSecrets(ROOT, "live", B);
    expect(a.GOOGLE_CLIENT_SECRET).toBe(aGoogle);
    expect(a.AI_KEY_DEEPSEEK).toBe(aAi);
    expect(b.GOOGLE_CLIENT_SECRET).toBe(bGoogle);
    expect("AI_KEY_DEEPSEEK" in b).toBe(false);
    for (const name of Object.keys(DERIVED_SECRETS)) {
      expect(a[name]).toBe(derivedA[name]);
      expect(b[name]).toBe(derivedB[name]);
      expect(a[name]).not.toBe(b[name]);
    }
    // Nothing of the host's own: its keys, and its own values of the per-client names.
    for (const name of [
      "COS_ROOT_KEY",
      "COS_SECRETS_KEY",
      "COS_SECRETS_KEY_PREVIOUS",
      "COS_CALLBACK_HOSTNAME",
      "REGISTRY",
      "CLIENT_DB",
      "AI_KEY_OPENAI",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(name in a, name).toBe(false);
      expect(name in b, name).toBe(false);
    }
    const values = (e: Record<string, unknown>) =>
      Object.values(e).filter((v): v is string => typeof v === "string");
    for (const value of values(a)) {
      expect(value).not.toContain("the-host-wide");
      expect([bGoogle, ...Object.values(derivedB), ROOT, SECRETS_KEY]).not.toContain(value);
    }
    for (const value of values(b)) {
      expect([aGoogle, aAi, ...Object.values(derivedA), ROOT, SECRETS_KEY]).not.toContain(value);
    }
  });

  it("puts a known secret value in no registry table, no client database, no log line, no error and no snapshot", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    const secret = known("sweep");
    await writeClientSecret(
      real.REGISTRY,
      keyring,
      { environment: "live", client: A, name: "TYPESAFE_API_KEY" },
      secret,
    );
    // A tampered copy for B, so the reading path's failure is logged too.
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, ciphertext, iv, key_id) SELECT ?, name, ciphertext, iv, key_id FROM registry_secrets WHERE client = ?",
    )
      .bind(B, A)
      .run();
    const host = manyClientEnv({ COS_SECRETS_KEY_PREVIOUS: OLD_SECRETS_KEY });
    const directory = new ClientDirectory(host);
    const a = served(await directory.environmentFor(A));
    const b = served(await directory.environmentFor(B));
    expect(fields(a).TYPESAFE_API_KEY).toBe(secret);
    expect("TYPESAFE_API_KEY" in fields(b)).toBe(false);
    const derived = Object.values(await deriveClientSecrets(ROOT, "live", A));
    const needles = [secret, ...derived, ROOT, SECRETS_KEY, OLD_SECRETS_KEY];

    // Errors on every failing path.
    const errors: string[] = [];
    const caught = async (p: Promise<unknown>) => {
      const error = await p.then(
        () => null,
        (e: unknown) => e,
      );
      if (error instanceof Error) errors.push(`${error.name} ${error.message} ${error.stack}`);
    };
    const sealed = await sealClientSecret(
      keyring,
      { environment: "live", client: A, name: "TYPESAFE_API_KEY" },
      secret,
    );
    await caught(
      openClientSecret(
        keyring,
        { environment: "live", client: B, name: "TYPESAFE_API_KEY" },
        sealed,
      ),
    );
    await caught(
      openClientSecret(
        await secretsKeyring(newHostKey()),
        { environment: "live", client: A, name: "TYPESAFE_API_KEY" },
        sealed,
      ),
    );
    await caught(
      sealClientSecret(keyring, { environment: "live", client: A, name: "NOT_GIVEN" }, secret),
    );
    await caught(
      sealClientSecret(
        keyring,
        { environment: "live", client: "Admin" as ClientId, name: "TYPESAFE_API_KEY" },
        secret,
      ),
    );
    await caught(deriveClientSecret(`${secret}`, "live", A, "DESK_SECRET"));
    await caught(secretsKeyring(secret));
    await caught(
      Promise.resolve().then(() =>
        buildClientEnvironment(
          { DB: real.DB },
          { client: { id: A } as never, settings: {}, given: { TYPESAFE_API_KEY: secret } },
        ),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(6);

    // Every table of the registry, every column, as text and as the bytes of a BLOB.
    const registryText = await dumpDatabase(real.REGISTRY);
    // Both clients' databases (all they hold).
    const clientText = (await dumpDatabase(a.DB)) + (await dumpDatabase(b.DB));
    // The registry as the directory holds it.
    const snapshotText = deepText(await directory.snapshot());

    for (const needle of needles) {
      expect(registryText.includes(needle), "registry").toBe(false);
      expect(clientText.includes(needle), "a client's database").toBe(false);
      expect(snapshotText.includes(needle), "the snapshot").toBe(false);
      for (const line of lines) expect(line.includes(needle), `log: ${line}`).toBe(false);
      for (const error of errors) expect(error.includes(needle), `error: ${error}`).toBe(false);
    }
    // The failure for B was logged, by name.
    expect(lines.some((line) => /TYPESAFE_API_KEY of gym-b left out/.test(line))).toBe(true);
  });

  it("holds nothing of a client's secrets in the snapshot, and rebuilds when a secret changes", async () => {
    await seedTwoClients();
    const keyring = await secretsKeyring(SECRETS_KEY);
    const place = { environment: "live", client: A, name: "TURNSTILE_SITE_KEY" } as const;
    await writeClientSecret(real.REGISTRY, keyring, place, known("site-1"));
    let now = 0;
    const directory = new ClientDirectory(manyClientEnv(), { refreshMs: 1_000, now: () => now });
    const first = served(await directory.environmentFor(A));
    const second = known("site-2");
    await writeClientSecret(real.REGISTRY, keyring, place, second);
    now = 2_000;
    const next = fields(served(await directory.environmentFor(A)));
    expect(next).not.toBe(first);
    expect(next.TURNSTILE_SITE_KEY).toBe(second);
    expect(Object.keys(await directory.snapshot())).not.toContain("secrets");
  });

  it("has no derived secret when the host has no root key, and says so once", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv({ COS_ROOT_KEY: undefined }));
    const a = fields(served(await directory.environmentFor(A)));
    const b = fields(served(await directory.environmentFor(B)));
    for (const name of Object.keys(DERIVED_SECRETS)) {
      expect(name in a).toBe(false);
      expect(name in b).toBe(false);
    }
    expect(lines.filter((line) => /COS_ROOT_KEY is not set/.test(line))).toHaveLength(1);
  });

  it("takes a client's secrets only into the names of their kind", () => {
    const built = fields(
      buildClientEnvironment(manyClientEnv(), {
        client: {
          id: A,
          environment: "live",
          status: "active",
          tier: "standard",
          repository: null,
          locationHint: null,
          schemaVersion: null,
        },
        settings: {},
        // A given value for a derived name, a derived one for a given name, and a name that is no
        // secret's: none is taken.
        given: { BETTER_AUTH_SECRET: "s66e-given-for-derived", COS_ROOT_KEY: "s66e-x" },
        derived: { GOOGLE_CLIENT_SECRET: "s66e-derived-for-given", APPROVAL_FLOOR: "none" },
      }),
    );
    expect("BETTER_AUTH_SECRET" in built).toBe(false);
    expect("GOOGLE_CLIENT_SECRET" in built).toBe(false);
    expect("COS_ROOT_KEY" in built).toBe(false);
    expect(built.APPROVAL_FLOOR).toBeUndefined();
  });
});

describe("gatekeepers on a many-client host", () => {
  it("leave out the ones that hold one deployment's credentials or state for every account", () => {
    for (const name of [
      "GATEKEEPER_PAYMENTS",
      "GATEKEEPER_TEXT",
      "GATEKEEPER_WEBHOOK",
      "GATEKEEPER_EMAIL",
      "GATEKEEPER_EMAIL_SEND",
    ]) {
      expect(envNameUse(name), name).toMatchObject({ use: "kept-apart" });
    }
    for (const name of ["GATEKEEPER_GOOGLE", "GATEKEEPER_MICROSOFT", "GATEKEEPER_SLACK"]) {
      expect(envNameUse(name), name).toMatchObject({ use: "shared" });
    }
    const built = fields(
      buildClientEnvironment(
        {
          ...manyClientEnv(),
          GATEKEEPER_PAYMENTS: { name: "payments" },
          GATEKEEPER_WEBHOOK: { name: "webhook" },
          GATEKEEPER_GOOGLE: { name: "google" },
        },
        {
          client: {
            id: A,
            environment: "live",
            status: "active",
            tier: "standard",
            repository: null,
            locationHint: null,
            schemaVersion: null,
          },
          settings: {},
        },
      ),
    );
    expect("GATEKEEPER_PAYMENTS" in built).toBe(false);
    expect("GATEKEEPER_WEBHOOK" in built).toBe(false);
    expect(built.GATEKEEPER_GOOGLE).toEqual({ name: "google" });
  });
});

/** Every row of every table of a database, as text, BLOBs as hex and as Latin-1. */
async function dumpDatabase(db: D1Database): Promise<string> {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  let text = "";
  for (const { name } of tables) {
    const { results } = await db.prepare(`SELECT * FROM "${name}"`).all();
    for (const row of results) {
      for (const value of Object.values(row as Record<string, unknown>))
        text += ` ${cellText(value)}`;
    }
  }
  return text;
}

function cellText(value: unknown): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Array.isArray(value)
        ? Uint8Array.from(value as number[])
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
  if (!bytes) return String(value);
  const latin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${latin} ${hex}`;
}

/** Everything reachable in a value (maps, sets, arrays, objects), as text. */
function deepText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return ` ${String(value)}`;
  if (seen.has(value)) return "";
  seen.add(value);
  if (value instanceof Map) return [...value.entries()].map((e) => deepText(e, seen)).join("");
  if (value instanceof Set) return [...value].map((e) => deepText(e, seen)).join("");
  return Object.entries(value as object)
    .map(([k, v]) => ` ${k}${deepText(v, seen)}`)
    .join("");
}
