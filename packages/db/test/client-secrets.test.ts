// A client's secrets and addresses on a host that serves many clients (stage 66 step 6, ADR
// 0616): derived secrets differ per client, purpose, environment and generation; given secrets
// are sealed to the host's public key (HPKE) and open only with its private key, only where they
// belong; an imported deployment's own secrets override derivation; a client's environment holds
// its own secrets and addresses and nothing of another's or of the host's; and a known secret
// value is found nowhere it must not be (criterion 10).
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatekeeperBaseUrl, isCallbackHostname, isCallbackRequest } from "../src/callbacks.ts";
import type { ClientDb } from "../src/client-db.ts";
import type { ClientDbQueryService } from "../src/client-db-service.ts";
import { ENV_NAMES } from "../src/client-env-names.ts";
import { ClientDirectory, envNameUse } from "../src/client-environment.ts";
import { buildClientEnvironment } from "../src/client-environment-build.ts";
import { type ClientId, type ClientRecord, readRegistry } from "../src/registry.ts";
import { base64url, hex, SEALING_SUITE } from "../src/registry-hpke.ts";
import * as sealingModule from "../src/registry-sealing.ts";
import {
  DERIVED_SECRETS,
  dropImportedSecrets,
  GIVEN_SECRET_NAMES,
  hostKeyBytes,
  isGivenSecretName,
  newHostKeys,
  placeBytes,
  publicKeyOf,
  removeClientSecret,
  type SealingPublicKey,
  sealClientSecret,
  sealingPublicKey,
  writeClientSecret,
  writeImportedSecret,
} from "../src/registry-sealing.ts";
import {
  derivationInfo,
  deriveClientSecret,
  deriveClientSecrets,
  exportClientSecrets,
  openClientSecret,
  openingKeyring,
  readClientSecrets,
  resealClientSecrets,
} from "../src/registry-secrets.ts";
import vector from "./fixtures/hpke-x25519-sha256-aes256gcm.json";
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
  CLIENT_DB_QUERIES: ClientDbQueryService;
  TEST_PROPS_KEY: string;
};

const A = "gym-a" as ClientId;
const B = "gym-b" as ClientId;
const GEN_A = "a".repeat(31) + "1";
const GEN_B = "b".repeat(31) + "2";

// Keys made here for the tests: obviously not anyone's.
let ROOT = "";
let OTHER_ROOT = "";
let PRIVATE = "";
let OLD_PRIVATE = "";
let PUBLIC: SealingPublicKey;
let OLD_PUBLIC: SealingPublicKey;

/** A value no code could produce by chance: what every scan below looks for. */
const known = (label: string) => `s66e-known-${label}-${crypto.randomUUID()}`;

function manyClientEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: real.DB,
    REGISTRY: real.REGISTRY,
    CLIENT_DB: real.CLIENT_DB,
    // The query path a client's DB goes through (stage 66 step 2).
    CLIENT_DB_QUERIES: real.CLIENT_DB_QUERIES,
    // The host's props key: each call on a client's database carries its proof (#515, S1).
    COS_PROPS_KEY: real.TEST_PROPS_KEY,
    COS_HOST_ENVIRONMENT: "live",
    COS_ROOT_KEY: ROOT,
    COS_SECRETS_PRIVATE_KEY: PRIVATE,
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
const live = (client: ClientId, name: string) => ({ environment: "live" as const, client, name });
const of = (client: ClientId, generation: string) => ({
  environment: "live" as const,
  client,
  generation,
});

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

/** A client's record as the registry holds it (its generation included). */
async function recordOf(client: ClientId): Promise<ClientRecord> {
  const record = (await readRegistry(real.REGISTRY)).clients.get(client);
  if (!record) throw new Error(`no ${client}`);
  return record;
}

const fromHex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

beforeAll(async () => {
  await migrateRegistry();
  const keys = await newHostKeys();
  const old = await newHostKeys();
  ROOT = keys.rootKey;
  OTHER_ROOT = old.rootKey;
  PRIVATE = keys.secretsPrivateKey;
  OLD_PRIVATE = old.secretsPrivateKey;
  PUBLIC = await sealingPublicKey(keys.secretsPublicKey);
  OLD_PUBLIC = await sealingPublicKey(old.secretsPublicKey);
});

beforeEach(async () => {
  await emptyRegistry();
});

describe("HPKE (RFC 9180), through @hpke/core", () => {
  // From the CFRG's published test vectors (draft-irtf-cfrg-hpke, test-vectors.json): mode 0,
  // DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001, AES-256-GCM 0x0002.
  it("matches the published vector for DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM", async () => {
    expect([vector.mode, vector.kem_id, vector.kdf_id, vector.aead_id]).toEqual([0, 32, 1, 2]);
    const recipient = await SEALING_SUITE.kem.deriveKeyPair(fromHex(vector.ikmR).buffer);
    const pkR = new Uint8Array(await SEALING_SUITE.kem.serializePublicKey(recipient.publicKey));
    expect(hex(pkR)).toBe(vector.pkRm);
    // The sender with the vector's ephemeral key: the same encapsulation and ciphertexts.
    const sender = await SEALING_SUITE.createSenderContext({
      recipientPublicKey: recipient.publicKey,
      info: fromHex(vector.info).buffer,
      ekm: fromHex(vector.ikmE).buffer,
    });
    expect(hex(new Uint8Array(sender.enc))).toBe(vector.enc);
    const opener = await SEALING_SUITE.createRecipientContext({
      recipientKey: recipient.privateKey,
      enc: fromHex(vector.enc).buffer,
      info: fromHex(vector.info).buffer,
    });
    for (const e of vector.encryptions) {
      const ct = await sender.seal(fromHex(e.pt).buffer, fromHex(e.aad).buffer);
      expect(hex(new Uint8Array(ct))).toBe(e.ct);
      const pt = await opener.open(fromHex(e.ct).buffer, fromHex(e.aad).buffer);
      expect(hex(new Uint8Array(pt))).toBe(e.pt);
    }
  });
});

describe("the host's keys", () => {
  it("refuse an all-zero or weak key and a non-canonical encoding, never echoing it", () => {
    const zero = "A".repeat(43);
    expect(() => hostKeyBytes(zero, "COS_ROOT_KEY")).toThrow(/COS_ROOT_KEY is not 32 random/);
    const pattern = base64url(Uint8Array.from({ length: 32 }, (_, i) => i % 4));
    expect(() => hostKeyBytes(pattern, "COS_ROOT_KEY")).toThrow(/not 32 random/);
    // The last character carries 4 bits of the key and 2 that must be zero: `...B` and `...A`
    // differ only there, so one of the two is not canonical.
    const good = ROOT;
    const last = good.at(-1) as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alias = good.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
    expect(() => hostKeyBytes(alias, "COS_ROOT_KEY")).toThrow(/not 32 random/);
    expect(hostKeyBytes(good, "COS_ROOT_KEY")).toHaveLength(32);
    const error = (() => {
      try {
        hostKeyBytes("short-s66e", "COS_ROOT_KEY");
      } catch (e) {
        return String(e);
      }
    })();
    expect(error).not.toContain("short-s66e");
  });

  it("give the operator a public key that seals, and nothing that opens", async () => {
    expect((await publicKeyOf(PRIVATE)).text).toBe(PUBLIC.text);
    expect(PUBLIC.id).toMatch(/^k2-[0-9a-f]{16}$/);
    // The operator's module (the package's export) holds no way to open or read a value.
    for (const name of Object.keys(sealingModule)) {
      expect(name, name).not.toMatch(/open|read|export|decrypt|reseal/i);
    }
  });
});

describe("derived secrets", () => {
  it("differ per client, purpose, environment, generation and root", async () => {
    const seen = new Set<string>();
    for (const environment of ["live", "staging"] as const) {
      for (const [client, generation] of [
        [A, GEN_A],
        [B, GEN_B],
        [A, GEN_B],
      ] as const) {
        const all = await deriveClientSecrets(ROOT, { environment, client, generation });
        expect(Object.keys(all).sort()).toEqual(Object.keys(DERIVED_SECRETS).sort());
        for (const value of Object.values(all)) {
          expect(value).toMatch(/^[0-9a-f]{64}$/);
          seen.add(value);
        }
      }
    }
    expect(seen.size).toBe(2 * 3 * Object.keys(DERIVED_SECRETS).length);
    const other = await deriveClientSecret(OTHER_ROOT, of(A, GEN_A), "BETTER_AUTH_SECRET");
    expect(seen.has(other)).toBe(false);
  });

  it("give the support cookie and the client-address key their own purposes", async () => {
    const all = await deriveClientSecrets(ROOT, of(A, GEN_A));
    const values = [
      all.BETTER_AUTH_SECRET,
      all.SUPPORT_COOKIE_SECRET,
      all.CLIENT_ADDRESS_SECRET,
      all.CUSTOMER_AUTH_SECRET,
      all.DESK_SECRET,
    ];
    expect(new Set(values).size).toBe(values.length);
    expect(DERIVED_SECRETS.SUPPORT_COOKIE_SECRET?.purpose).toBe("support-cookie");
    expect(DERIVED_SECRETS.CLIENT_ADDRESS_SECRET?.purpose).toBe("client-address");
  });

  it("bind the version, environment, purpose, client and generation into an unambiguous info", () => {
    expect(derivationInfo("live", "staff-auth", 1, A, GEN_A)).toBe(
      `cos/client-secret/v1/live/staff-auth/gym-a/${GEN_A}`,
    );
    expect(() => derivationInfo("live", "staff/auth", 1, A, GEN_A)).toThrow(RangeError);
    expect(() => derivationInfo("live", "staff-auth", 0, A, GEN_A)).toThrow(RangeError);
    expect(() => derivationInfo("live", "staff-auth", 1, A, "x/y")).toThrow(RangeError);
  });

  it("are never the same for a client id removed and added again (a new generation)", async () => {
    await real.REGISTRY.batch([insertClient(real.REGISTRY, { id: A })]);
    const first = await recordOf(A);
    expect(first.secretGeneration).toMatch(/^[0-9a-f]{32}$/);
    const before = await deriveClientSecret(
      ROOT,
      of(A, first.secretGeneration as string),
      "DESK_SECRET",
    );
    await emptyRegistry();
    await real.REGISTRY.batch([insertClient(real.REGISTRY, { id: A })]);
    const again = await recordOf(A);
    expect(again.secretGeneration).not.toBe(first.secretGeneration);
    expect(
      await deriveClientSecret(ROOT, of(A, again.secretGeneration as string), "DESK_SECRET"),
    ).not.toBe(before);
    // A generation never changes once written.
    await expect(
      real.REGISTRY.prepare("UPDATE registry_clients SET secret_generation = ? WHERE id = ?")
        .bind("c".repeat(32), A)
        .run(),
    ).rejects.toThrow(/never changes/);
  });

  it("refuse a name that is not derived and a bad client id", async () => {
    await expect(deriveClientSecret(ROOT, of(A, GEN_A), "GOOGLE_CLIENT_SECRET")).rejects.toThrow(
      /not a derived secret/,
    );
    await expect(
      deriveClientSecret(ROOT, of("Admin" as ClientId, GEN_A), "DESK_SECRET"),
    ).rejects.toThrow(RangeError);
  });

  it("are every per-client derived name of ENV_NAMES, and given names are the given ones", () => {
    const named = (from: string) =>
      Object.entries(ENV_NAMES)
        .filter(([, use]) => use.use === "per-client" && use.what === "secret" && use.from === from)
        .map(([name]) => name)
        .sort();
    expect(named("derived")).toEqual(Object.keys(DERIVED_SECRETS).sort());
    expect(named("given")).toEqual([...GIVEN_SECRET_NAMES].sort());
    expect(envNameUse("AI_KEY_ANTHROPIC")).toMatchObject({ what: "secret", from: "given" });
    expect(isGivenSecretName("AI_KEY_ANTHROPIC")).toBe(true);
    for (const name of Object.keys(DERIVED_SECRETS)) expect(isGivenSecretName(name)).toBe(false);
  });
});

describe("given secrets, sealed to the host", () => {
  const given = (client: ClientId, name: string) => ({
    ...live(client, name),
    kind: "given" as const,
  });

  it("seal with a fresh encapsulation each time and open with the host's private key", async () => {
    const keyring = await openingKeyring(PRIVATE);
    const place = given(A, "GOOGLE_CLIENT_SECRET");
    const value = known("google");
    const one = await sealClientSecret(PUBLIC, place, value);
    const two = await sealClientSecret(PUBLIC, place, value);
    expect(one.enc).toHaveLength(32);
    expect(one.enc).not.toEqual(two.enc);
    expect(one.ciphertext).not.toEqual(two.ciphertext);
    expect(one.keyId).toBe(PUBLIC.id);
    expect(await openClientSecret(keyring, place, one)).toBe(value);
    expect(new TextDecoder().decode(one.ciphertext)).not.toContain(value);
  });

  it("never open for another client, name, environment or kind, under another key, or tampered with", async () => {
    const keyring = await openingKeyring(PRIVATE);
    const value = known("moved");
    const place = given(A, "TYPESAFE_API_KEY");
    const sealed = await sealClientSecret(PUBLIC, place, value);
    const errors: unknown[] = [];
    const attempt = async (p: Record<string, unknown>, s = sealed, k = keyring) => {
      const error = await openClientSecret(k, p as typeof place, s).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      errors.push(error);
    };
    await attempt({ ...place, client: B });
    await attempt({ ...place, name: "AI_KEY_OPENAI" });
    await attempt({ ...place, environment: "staging" });
    await attempt({ ...place, name: "BETTER_AUTH_SECRET", kind: "imported" });
    await attempt(place, sealed, await openingKeyring((await newHostKeys()).secretsPrivateKey));
    const flipped = new Uint8Array(sealed.ciphertext);
    flipped[0] = (flipped[0] as number) ^ 1;
    await attempt(place, { ...sealed, ciphertext: flipped });
    const flippedEnc = new Uint8Array(sealed.enc);
    flippedEnc[5] = (flippedEnc[5] as number) ^ 1;
    await attempt(place, { ...sealed, enc: flippedEnc });
    // A row that claims another key's id does not change which key opens it.
    await attempt(place, { ...sealed, keyId: OLD_PUBLIC.id });
    for (const error of errors) expect(String((error as Error).message)).not.toContain(value);
  });

  it("open rows sealed to the previous key during a rotation, and a re-seal on the host moves them", async () => {
    await seedTwoClients();
    const value = known("rotated");
    await writeClientSecret(real.REGISTRY, OLD_PUBLIC, live(A, "AI_KEY_OPENAI"), value);
    const rotated = await openingKeyring(PRIVATE, OLD_PRIVATE);
    expect((await readClientSecrets(real.REGISTRY, rotated, "live", A)).given).toEqual({
      AI_KEY_OPENAI: value,
    });
    // Without the previous key the old row does not open.
    const now = await openingKeyring(PRIVATE);
    expect((await readClientSecrets(real.REGISTRY, now, "live", A)).given).toEqual({});
    expect(await resealClientSecrets(real.REGISTRY, rotated, "live", A)).toEqual({
      resealed: 1,
      problems: [],
    });
    expect((await readClientSecrets(real.REGISTRY, now, "live", A)).given).toEqual({
      AI_KEY_OPENAI: value,
    });
    const keyIds = await real.REGISTRY.prepare("SELECT key_id FROM registry_secrets").all();
    expect(keyIds.results).toEqual([{ key_id: PUBLIC.id }]);
  });

  it("refuse a derived or unknown name, an empty, over-long or malformed value and a bad client", async () => {
    const at = (name: string, client: ClientId = A) => given(client, name);
    await expect(sealClientSecret(PUBLIC, at("BETTER_AUTH_SECRET"), "x")).rejects.toThrow(
      /not a given secret/,
    );
    await expect(sealClientSecret(PUBLIC, at("SOMETHING_ELSE"), "x")).rejects.toThrow(
      /not a given secret/,
    );
    await expect(sealClientSecret(PUBLIC, at("AI_KEY_OPENAI"), "")).rejects.toThrow(/empty/);
    await expect(sealClientSecret(PUBLIC, at("AI_KEY_OPENAI"), "s66e-\uD800-lone")).rejects.toThrow(
      /not well-formed/,
    );
    const long = `s66e-${"x".repeat(17_000)}`;
    const error = await sealClientSecret(PUBLIC, at("AI_KEY_OPENAI"), long).catch((e) => e);
    expect(String(error)).toMatch(/over 16384 bytes/);
    expect(String(error)).not.toContain("xxxxxxxx");
    await expect(
      sealClientSecret(PUBLIC, at("AI_KEY_OPENAI", "Admin" as ClientId), "x"),
    ).rejects.toThrow(RangeError);
    await expect(openingKeyring("not-a-key-s66e")).rejects.toThrow(
      /COS_SECRETS_PRIVATE_KEY is not 32/,
    );
    await expect(
      writeClientSecret(real.REGISTRY, PUBLIC, live(A, "BETTER_AUTH_SECRET"), "x"),
    ).rejects.toThrow(/not a given secret/);
  });

  it("copied from client A's row to client B's, fail to open and are left out of B's environment", async () => {
    await seedTwoClients();
    const keyring = await openingKeyring(PRIVATE);
    const value = known("copied");
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "GOOGLE_CLIENT_SECRET"), value);
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, kind, enc, ciphertext, key_id) SELECT ?, name, kind, enc, ciphertext, key_id FROM registry_secrets WHERE client = ?",
    )
      .bind(B, A)
      .run();
    const forB = await readClientSecrets(real.REGISTRY, keyring, "live", B);
    expect(forB.given).toEqual({});
    expect(forB.problems).toEqual([
      expect.stringMatching(/GOOGLE_CLIENT_SECRET of gym-b left out: .*does not open here/),
    ]);
    expect(forB.problems.join()).not.toContain(value);
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).given).toEqual({
      GOOGLE_CLIENT_SECRET: value,
    });
    // Renamed in place, or relabelled as another kind, it does not open either.
    await real.REGISTRY.prepare(
      "UPDATE registry_secrets SET name = 'AI_KEY_OPENAI' WHERE client = ?",
    )
      .bind(A)
      .run();
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).given).toEqual({});
    // Relabelled as an imported auth secret: refused by the registry for a client not imported.
    await expect(
      real.REGISTRY.prepare(
        "UPDATE registry_secrets SET name = 'BETTER_AUTH_SECRET', kind = 'imported' WHERE client = ?",
      )
        .bind(A)
        .run(),
    ).rejects.toThrow(/only for a client added as imported/);
  });

  it("bind the kind into the seal: the same place under the other kind does not open", async () => {
    // Below the name checks (which alone already keep the two kinds apart): the suite itself,
    // with the place string differing only in its kind.
    const keyring = await openingKeyring(PRIVATE);
    const place = (kind: string) =>
      new TextEncoder().encode(`cos/registry-secret/v2/${kind}/live/gym-a/X_NAME/${PUBLIC.id}`);
    const given = place("given");
    const sealed = await SEALING_SUITE.seal(
      { recipientPublicKey: PUBLIC.key, info: given.buffer },
      new TextEncoder().encode("s66e-value").buffer,
      given.buffer,
    );
    const imported = place("imported");
    await expect(
      SEALING_SUITE.open(
        { recipientKey: keyring.current.privateKey, enc: sealed.enc, info: imported.buffer },
        sealed.ct,
        imported.buffer,
      ),
    ).rejects.toThrow();
    // And the place the code seals with names the kind.
    const real = new TextDecoder().decode(
      placeBytes(
        { environment: "live", client: A, name: "AI_KEY_OPENAI", kind: "given" },
        PUBLIC.id,
      ),
    );
    expect(real).toContain("/given/");
  });

  it("are replaced and removed by the operator's functions, moving the registry's stamp", async () => {
    await seedTwoClients();
    const keyring = await openingKeyring(PRIVATE);
    const before = (await readRegistry(real.REGISTRY)).stamp;
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "TURNSTILE_SECRET_KEY"), known("first"));
    const second = known("second");
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "TURNSTILE_SECRET_KEY"), second);
    const afterWrite = (await readRegistry(real.REGISTRY)).stamp;
    expect(afterWrite).not.toBe(before);
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).given).toEqual({
      TURNSTILE_SECRET_KEY: second,
    });
    await removeClientSecret(real.REGISTRY, A, "TURNSTILE_SECRET_KEY");
    expect((await readClientSecrets(real.REGISTRY, keyring, "live", A)).given).toEqual({});
    expect((await readRegistry(real.REGISTRY)).stamp).not.toBe(afterWrite);
  });

  it("are left out, named, when the host has no private key or a row's name does not fit its kind", async () => {
    await seedTwoClients();
    const keyring = await openingKeyring(PRIVATE);
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "CF_ACCESS_AUD"), known("aud"));
    const without = await readClientSecrets(real.REGISTRY, null, "live", A);
    expect(without.given).toEqual({});
    expect(without.problems).toEqual([expect.stringMatching(/COS_SECRETS_PRIVATE_KEY is not set/)]);
    // A derived name stored as `given` by hand (not through the import path).
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, kind, enc, ciphertext, key_id) VALUES (?, 'BETTER_AUTH_SECRET', 'given', zeroblob(32), zeroblob(32), ?)",
    )
      .bind(A, PUBLIC.id)
      .run();
    const opened = await readClientSecrets(real.REGISTRY, keyring, "live", A);
    expect(Object.keys(opened.given)).toEqual(["CF_ACCESS_AUD"]);
    expect(opened.problems).toEqual([expect.stringMatching(/BETTER_AUTH_SECRET .*not a given/)]);
  });
});

describe("a deployment's own secrets, imported as a client's", () => {
  /** Client A added as an imported deployment (migration 0793); B as an ordinary client. */
  async function seedImported() {
    await real.REGISTRY.batch([
      insertClient(real.REGISTRY, { id: A, imported: true }),
      insertClient(real.REGISTRY, { id: B }),
      insertHostname(real.REGISTRY, "gym-a-admin.fleet.example", A, "staff"),
      insertHostname(real.REGISTRY, "gym-b-admin.fleet.example", B, "staff"),
    ]);
  }

  it("are refused for a client not added as imported, so no auth secret can be pinned on it", async () => {
    await seedTwoClients();
    await expect(
      writeImportedSecret(real.REGISTRY, PUBLIC, live(B, "BETTER_AUTH_SECRET"), known("pinned")),
    ).rejects.toThrow(/only for a client added as imported/);
    // Nor can a client become imported after it was added.
    await expect(
      real.REGISTRY.prepare("UPDATE registry_clients SET imported = 1 WHERE id = ?").bind(B).run(),
    ).rejects.toThrow(/set when it is added/);
  });

  it("are honoured only for a client the registry marks as imported, even where a row exists", async () => {
    await seedImported();
    const keyring = await openingKeyring(PRIVATE);
    await writeImportedSecret(real.REGISTRY, PUBLIC, live(A, "DESK_SECRET"), known("desk"));
    // The reading path, asked for a client not marked imported (as if the row had got in by
    // another way), leaves it out.
    const notImported = await readClientSecrets(real.REGISTRY, keyring, "live", A, false);
    expect(notImported.imported).toEqual({});
    expect(notImported.problems).toEqual([
      expect.stringMatching(
        /DESK_SECRET of gym-a left out: an imported secret of a client not added/,
      ),
    ]);
    const asImported = await readClientSecrets(real.REGISTRY, keyring, "live", A, true);
    expect(Object.keys(asImported.imported)).toEqual(["DESK_SECRET"]);
  });

  it("never take a secret generation an INSERT supplies", async () => {
    await expect(
      real.REGISTRY.prepare(
        "INSERT INTO registry_clients (id, environment, tier, secret_generation) VALUES (?, 'live', 'standard', ?)",
      )
        .bind(A, "c".repeat(32))
        .run(),
    ).rejects.toThrow(/written by the registry, never supplied/);
  });

  it("can be dropped: then every secret of the client is derived again", async () => {
    await seedImported();
    const imported = known("imported-to-drop");
    await writeImportedSecret(real.REGISTRY, PUBLIC, live(A, "BETTER_AUTH_SECRET"), imported);
    let now = 0;
    const directory = new ClientDirectory(manyClientEnv(), { refreshMs: 1_000, now: () => now });
    expect(fields(served(await directory.environmentFor(A))).BETTER_AUTH_SECRET).toBe(imported);
    expect(await dropImportedSecrets(real.REGISTRY, A)).toBe(1);
    now = 2_000;
    const derived = await deriveClientSecrets(
      ROOT,
      of(A, (await recordOf(A)).secretGeneration as string),
    );
    expect(fields(served(await directory.environmentFor(A))).BETTER_AUTH_SECRET).toBe(
      derived.BETTER_AUTH_SECRET,
    );
  });

  it("override derivation for that client only, and only from the import path", async () => {
    await seedImported();
    const imported = known("imported-staff-secret");
    await writeImportedSecret(real.REGISTRY, PUBLIC, live(A, "BETTER_AUTH_SECRET"), imported);
    await expect(
      writeImportedSecret(real.REGISTRY, PUBLIC, live(A, "GOOGLE_CLIENT_SECRET"), "x"),
    ).rejects.toThrow(/not a derivable secret/);
    const directory = new ClientDirectory(manyClientEnv());
    const a = fields(served(await directory.environmentFor(A)));
    const b = fields(served(await directory.environmentFor(B)));
    const recordA = await recordOf(A);
    const derivedA = await deriveClientSecrets(ROOT, of(A, recordA.secretGeneration as string));
    expect(a.BETTER_AUTH_SECRET).toBe(imported);
    // The rest of A's are still derived; B's are untouched.
    expect(a.DESK_SECRET).toBe(derivedA.DESK_SECRET);
    expect(b.BETTER_AUTH_SECRET).not.toBe(imported);
  });

  it("go with a client that leaves: the export carries its derived (or imported) and given secrets", async () => {
    await seedImported();
    const imported = known("imported-desk");
    const google = known("export-google");
    await writeImportedSecret(real.REGISTRY, PUBLIC, live(A, "DESK_SECRET"), imported);
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "GOOGLE_CLIENT_SECRET"), google);
    const record = await recordOf(A);
    const out = await exportClientSecrets(manyClientEnv(), record);
    const derived = await deriveClientSecrets(ROOT, of(A, record.secretGeneration as string));
    expect(out.given).toEqual({ GOOGLE_CLIENT_SECRET: google });
    expect(out.derived).toEqual({ ...derived, DESK_SECRET: imported });
    expect(out.problems).toEqual([]);
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
      insertHostname(real.REGISTRY, "desk.gym-a.com", A, "desk", false),
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

  it("allow one marked hostname per client and surface, and never an unverified one", async () => {
    await real.REGISTRY.batch([
      insertClient(real.REGISTRY, { id: A }),
      insertHostname(real.REGISTRY, "one.gym-a.com", A, "staff", true, true),
    ]);
    await expect(
      insertHostname(real.REGISTRY, "two.gym-a.com", A, "staff", true, true).run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      insertHostname(real.REGISTRY, "desk.gym-a.com", A, "desk", false, true).run(),
    ).rejects.toThrow(/CHECK/);
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
    expect(a.COS_CLIENT_ID).toBe("gym-a");
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

  it("refuses a host whose callback hostname is not canonical, once, where the directory is made", () => {
    expect(
      () =>
        new ClientDirectory(manyClientEnv({ COS_CALLBACK_HOSTNAME: "Callbacks.Fleet.Example" })),
    ).toThrow(/COS_CALLBACK_HOSTNAME must be a lowercase hostname/);
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
    const aGoogle = known("a-google");
    const bGoogle = known("b-google");
    const aAi = known("a-ai");
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "GOOGLE_CLIENT_SECRET"), aGoogle);
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "AI_KEY_DEEPSEEK"), aAi);
    await writeClientSecret(real.REGISTRY, PUBLIC, live(B, "GOOGLE_CLIENT_SECRET"), bGoogle);
    const directory = new ClientDirectory(manyClientEnv());
    const a = fields(served(await directory.environmentFor(A)));
    const b = fields(served(await directory.environmentFor(B)));
    const derivedA = await deriveClientSecrets(
      ROOT,
      of(A, (await recordOf(A)).secretGeneration as string),
    );
    const derivedB = await deriveClientSecrets(
      ROOT,
      of(B, (await recordOf(B)).secretGeneration as string),
    );
    expect(a.GOOGLE_CLIENT_SECRET).toBe(aGoogle);
    expect(a.AI_KEY_DEEPSEEK).toBe(aAi);
    expect(b.GOOGLE_CLIENT_SECRET).toBe(bGoogle);
    expect("AI_KEY_DEEPSEEK" in b).toBe(false);
    for (const name of Object.keys(DERIVED_SECRETS)) {
      expect(a[name]).toBe(derivedA[name]);
      expect(b[name]).toBe(derivedB[name]);
      expect(a[name]).not.toBe(b[name]);
    }
    for (const name of [
      "COS_ROOT_KEY",
      "COS_SECRETS_PRIVATE_KEY",
      "COS_SECRETS_PRIVATE_KEY_PREVIOUS",
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
      expect([bGoogle, ...Object.values(derivedB), ROOT, PRIVATE]).not.toContain(value);
    }
    for (const value of values(b)) {
      expect([aGoogle, aAi, ...Object.values(derivedA), ROOT, PRIVATE]).not.toContain(value);
    }
  });

  it("puts a known secret value in no registry table, no client database, no log line, no error and no snapshot", async () => {
    await seedTwoClients();
    const secret = known("sweep");
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "TYPESAFE_API_KEY"), secret);
    // A copy for B, so the reading path's failure is logged too.
    await real.REGISTRY.prepare(
      "INSERT INTO registry_secrets (client, name, kind, enc, ciphertext, key_id) SELECT ?, name, kind, enc, ciphertext, key_id FROM registry_secrets WHERE client = ?",
    )
      .bind(B, A)
      .run();
    const directory = new ClientDirectory(
      manyClientEnv({ COS_SECRETS_PRIVATE_KEY_PREVIOUS: OLD_PRIVATE }),
    );
    const a = served(await directory.environmentFor(A));
    const b = served(await directory.environmentFor(B));
    expect(fields(a).TYPESAFE_API_KEY).toBe(secret);
    expect("TYPESAFE_API_KEY" in fields(b)).toBe(false);
    const derived = Object.values(
      await deriveClientSecrets(ROOT, of(A, (await recordOf(A)).secretGeneration as string)),
    );
    const needles = [secret, ...derived, ROOT, PRIVATE, OLD_PRIVATE];

    const errors: string[] = [];
    const caught = async (p: Promise<unknown>) => {
      const error = await p.then(
        () => null,
        (e: unknown) => e,
      );
      if (error instanceof Error) errors.push(`${error.name} ${error.message} ${error.stack}`);
    };
    const keyring = await openingKeyring(PRIVATE);
    const place = { ...live(A, "TYPESAFE_API_KEY"), kind: "given" as const };
    const sealed = await sealClientSecret(PUBLIC, place, secret);
    await caught(openClientSecret(keyring, { ...place, client: B }, sealed));
    await caught(
      openClientSecret(
        await openingKeyring((await newHostKeys()).secretsPrivateKey),
        place,
        sealed,
      ),
    );
    await caught(sealClientSecret(PUBLIC, { ...place, name: "NOT_GIVEN" }, secret));
    await caught(sealClientSecret(PUBLIC, { ...place, client: "Admin" as ClientId }, secret));
    await caught(deriveClientSecret(secret, of(A, GEN_A), "DESK_SECRET"));
    await caught(openingKeyring(secret));
    await caught(sealingPublicKey(secret));
    await caught(
      Promise.resolve().then(() =>
        buildClientEnvironment(
          { DB: real.DB },
          { client: { id: A } as never, settings: {}, given: { TYPESAFE_API_KEY: secret } },
        ),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(7);

    const registryText = await dumpDatabase(real.REGISTRY);
    const clientText = (await dumpDatabase(a.DB)) + (await dumpDatabase(b.DB));
    const snapshotText = deepText(await directory.snapshot());
    for (const needle of needles) {
      expect(registryText.includes(needle), "registry").toBe(false);
      expect(clientText.includes(needle), "a client's database").toBe(false);
      expect(snapshotText.includes(needle), "the snapshot").toBe(false);
      for (const line of lines) expect(line.includes(needle), `log: ${line}`).toBe(false);
      for (const error of errors) expect(error.includes(needle), `error: ${error}`).toBe(false);
    }
    expect(lines.some((line) => /TYPESAFE_API_KEY of gym-b left out/.test(line))).toBe(true);
  });

  it("holds nothing of a client's secrets in the snapshot, and rebuilds when a secret changes", async () => {
    await seedTwoClients();
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "TURNSTILE_SITE_KEY"), known("site-1"));
    let now = 0;
    const directory = new ClientDirectory(manyClientEnv(), { refreshMs: 1_000, now: () => now });
    const first = served(await directory.environmentFor(A));
    const second = known("site-2");
    await writeClientSecret(real.REGISTRY, PUBLIC, live(A, "TURNSTILE_SITE_KEY"), second);
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
          secretGeneration: GEN_A,
          imported: false,
        },
        settings: {},
        given: { BETTER_AUTH_SECRET: "s66e-given-for-derived", COS_ROOT_KEY: "s66e-x" },
        derived: { GOOGLE_CLIENT_SECRET: "s66e-derived-for-given", APPROVAL_FLOOR: "none" },
        imported: { GOOGLE_CLIENT_SECRET: "s66e-imported-for-given" },
      }),
    );
    expect("BETTER_AUTH_SECRET" in built).toBe(false);
    expect("GOOGLE_CLIENT_SECRET" in built).toBe(false);
    expect("COS_ROOT_KEY" in built).toBe(false);
    expect(built.APPROVAL_FLOOR).toBeUndefined();
  });
});

describe("a many-client host", () => {
  it("refuses to start with one value for its object key and its props key (review of #520)", () => {
    const key = "the-same-key-for-both-0123456789-0123456789";
    expect(
      () => new ClientDirectory(manyClientEnv({ COS_BINDING_KEY: key, COS_PROPS_KEY: key })),
    ).toThrow(/COS_PROPS_KEY must not be COS_BINDING_KEY/);
  });

  it("refuses to start with the fake gatekeeper", () => {
    expect(
      () => new ClientDirectory(manyClientEnv({ INTEGRATIONS_FAKE_PROVIDER: "true" })),
    ).toThrow(/cannot run the fake gatekeeper/);
    expect(() => new ClientDirectory(manyClientEnv({ GATEKEEPER_FAKE: { name: "fake" } }))).toThrow(
      /cannot run the fake gatekeeper/,
    );
  });

  it("leaves out the gatekeepers that hold one deployment's credentials or state for every account", () => {
    for (const name of [
      "GATEKEEPER_PAYMENTS",
      "GATEKEEPER_TEXT",
      "GATEKEEPER_WEBHOOK",
      "GATEKEEPER_EMAIL",
    ]) {
      expect(envNameUse(name), name).toMatchObject({ use: "kept-apart" });
    }
    // Email sending takes each client's own sender domains from the host (registry migration
    // 0796; test/registry-senders.test.ts).
    for (const name of [
      "GATEKEEPER_GOOGLE",
      "GATEKEEPER_MICROSOFT",
      "GATEKEEPER_SLACK",
      "GATEKEEPER_EMAIL_SEND",
    ]) {
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
            secretGeneration: GEN_A,
            imported: false,
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
  const hexText = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${latin} ${hexText}`;
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
