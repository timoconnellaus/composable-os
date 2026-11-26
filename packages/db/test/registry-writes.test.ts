// The operator's writes to the registry (stage 66 step 7, ADR 0618), registry migration 0795 (a
// client's environment fixed, issue #523 F4; the operations a re-run carries on), and the given
// secrets held for a gatekeeper made per client later (the owner's payments decision).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isFanOutQueue, isParkingQueue, isQueue } from "../src/client-entries.ts";
import { buildClientEnvironment } from "../src/client-environment-build.ts";
import { type ClientId, readRegistry } from "../src/registry.ts";
import {
  GATEKEEPER_HELD_SECRET_NAMES,
  isGivenSecretName,
  newHostKeys,
  publicKeyOf,
  writeClientSecret,
  writeImportedSecret,
} from "../src/registry-sealing.ts";
import { exportClientSecrets, openingKeyring, readClientSecrets } from "../src/registry-secrets.ts";
import {
  addClientRows,
  beginOperation,
  finishOperation,
  hostnamesTaken,
  type NewClient,
  newClientProblems,
  readClient,
  recordSchemaVersion,
  removeClientRows,
  saveOperation,
  setClientStatus,
  unfinishedOperation,
  wasRemoved,
} from "../src/registry-writes.ts";
import { emptyRegistry, migrateRegistry } from "./registry-fixtures.ts";

const registry = env.REGISTRY;
const gym = (id: string, over: Partial<NewClient> = {}): NewClient => ({
  id,
  environment: "live",
  tier: "standard",
  hostnames: [
    { hostname: `${id}-admin.composableos.app`, surface: "staff" },
    { hostname: `${id}.composableos.app`, surface: "web" },
  ],
  settings: { APPROVAL_FLOOR: "write" },
  ...over,
});

beforeEach(async () => {
  await migrateRegistry();
  await emptyRegistry();
  await registry.prepare("DELETE FROM registry_operations").run();
});

describe("adding a client", () => {
  it("writes its row paused with no schema version, its hostnames verified and marked, and its settings", async () => {
    await addClientRows(registry, gym("gym-one"));
    const row = await readClient(registry, "gym-one" as ClientId);
    expect(row).toMatchObject({ status: "paused", schemaVersion: null, imported: false });
    expect(row?.secretGeneration).toMatch(/^[0-9a-f]{32}$/);
    const snapshot = await readRegistry(registry);
    expect(snapshot.addresses.get("gym-one" as ClientId)).toMatchObject({
      staff: "gym-one-admin.composableos.app",
      web: "gym-one.composableos.app",
    });
    expect(snapshot.settings.get("gym-one" as ClientId)).toEqual({ APPROVAL_FLOOR: "write" });
  });

  it("refuses what the registry would not hold, saying what, before writing", async () => {
    expect(
      newClientProblems(
        gym("admin", {
          hostnames: [{ hostname: "Callback.Fleet.Example", surface: "staff" }],
          settings: { COS_ROOT_KEY: "x" },
        }),
        { callbackHostname: "callback.fleet.example" },
      ),
    ).toEqual([
      'the id: "admin" is reserved',
      "Callback.Fleet.Example is not a canonical hostname",
      "COS_ROOT_KEY is not a client setting",
    ]);
    expect(
      newClientProblems(
        gym("gym-two", { hostnames: [{ hostname: "callback.fleet.example", surface: "staff" }] }),
        { callbackHostname: "callback.fleet.example" },
      ),
    ).toEqual(["callback.fleet.example is the deployment's callback hostname, no client's"]);
    expect(newClientProblems(gym("gym-two", { hostnames: [] }))).toEqual([
      "a client needs a staff hostname",
    ]);
    await expect(addClientRows(registry, gym("Bad Id"))).rejects.toThrow(/Not a client to add/);
    expect((await readRegistry(registry)).clients.size).toBe(0);
  });

  it("is all or nothing: a hostname another client holds leaves no row of the new one", async () => {
    await addClientRows(registry, gym("gym-one"));
    expect(await hostnamesTaken(registry, ["gym-one.composableos.app", "free.example"])).toEqual([
      { hostname: "gym-one.composableos.app", client: "gym-one" },
    ]);
    await expect(
      addClientRows(
        registry,
        gym("gym-two", {
          hostnames: [
            { hostname: "gym-two-admin.composableos.app", surface: "staff" },
            { hostname: "gym-one.composableos.app", surface: "web" },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(await readClient(registry, "gym-two" as ClientId)).toBeNull();
    expect(await hostnamesTaken(registry, ["gym-two-admin.composableos.app"])).toEqual([]);
  });
});

describe("a client's environment never changes (issue #523, F4)", () => {
  it("refuses an UPDATE of environment, and of nothing else", async () => {
    await addClientRows(registry, gym("gym-one"));
    await expect(
      registry
        .prepare("UPDATE registry_clients SET environment = 'staging' WHERE id = 'gym-one'")
        .run(),
    ).rejects.toThrow(/environment never changes/);
    expect((await readClient(registry, "gym-one" as ClientId))?.environment).toBe("live");
    // Other columns still change, and an UPDATE naming the same environment is no change.
    await registry
      .prepare(
        "UPDATE registry_clients SET environment = 'live', tier = 'bespoke' WHERE id = 'gym-one'",
      )
      .run();
    expect((await readClient(registry, "gym-one" as ClientId))?.tier).toBe("bespoke");
  });
});

describe("status and schema version", () => {
  it("changes status only from the statuses named, and records the schema version", async () => {
    await addClientRows(registry, gym("gym-one"));
    const id = "gym-one" as ClientId;
    expect(await setClientStatus(registry, id, "active", ["active"])).toBe(false);
    expect(await setClientStatus(registry, id, "active", ["paused"])).toBe(true);
    expect(await setClientStatus(registry, id, "active")).toBe(false);
    await recordSchemaVersion(registry, id, 857);
    expect(await readClient(registry, id)).toMatchObject({ status: "active", schemaVersion: 857 });
    await expect(recordSchemaVersion(registry, id, 1.5)).rejects.toThrow(/whole number/);
  });
});

describe("removing a client", () => {
  it("deletes its rows and keeps its id for good: adding it again is refused", async () => {
    await addClientRows(registry, gym("gym-one"));
    const before = await readClient(registry, "gym-one" as ClientId);
    await removeClientRows(registry, "gym-one" as ClientId);
    expect(await readClient(registry, "gym-one" as ClientId)).toBeNull();
    expect(await wasRemoved(registry, "gym-one")).toBe(true);
    const kept = await registry
      .prepare("SELECT secret_generation FROM registry_removed_clients WHERE id = 'gym-one'")
      .first<{ secret_generation: string }>();
    expect(kept?.secret_generation).toBe(before?.secretGeneration);
    expect(await hostnamesTaken(registry, ["gym-one.composableos.app"])).toEqual([]);
    await expect(addClientRows(registry, gym("gym-one"))).rejects.toThrow(/never used again/);
  });
});

describe("operations a re-run carries on", () => {
  it("holds one unfinished run of a kind for a client, read back by the next run", async () => {
    const op = await beginOperation(registry, "add", "gym-one", { step: "rows" });
    await expect(beginOperation(registry, "add", "gym-one", { step: "rows" })).rejects.toThrow();
    // Another client's, or another kind, is its own.
    await beginOperation(registry, "add", "gym-two", { step: "rows" });
    await beginOperation(registry, "update", null, { step: "pause" });
    await expect(beginOperation(registry, "update", null, {})).rejects.toThrow();
    await saveOperation(registry, op.id, { step: "migrated" });
    expect((await unfinishedOperation(registry, "add", "gym-one"))?.state).toEqual({
      step: "migrated",
    });
    await finishOperation(registry, op.id, "succeeded", { step: "done" });
    expect(await unfinishedOperation(registry, "add", "gym-one")).toBeNull();
    await beginOperation(registry, "add", "gym-one", { step: "rows" });
  });

  it("moves no version stamp: no host reads operations", async () => {
    const before = (await readRegistry(registry)).stamp;
    const op = await beginOperation(registry, "remove", "gym-one", {});
    await finishOperation(registry, op.id, "undone", {});
    expect((await readRegistry(registry)).stamp).toBe(before);
  });
});

describe("an imported client's own secrets (review of #526, S5)", () => {
  it("are refused when too weak to sign its sessions, the value never in the message", async () => {
    await addClientRows(registry, gym("gym-imp", { imported: true }));
    const keys = await newHostKeys();
    const publicKey = await publicKeyOf(keys.secretsPrivateKey);
    const place = {
      environment: "live" as const,
      client: "gym-imp" as ClientId,
      name: "BETTER_AUTH_SECRET",
    };
    const weak = "abcabcabcabcabcabcabcabcabcabcabcabc";
    const error = await writeImportedSecret(registry, publicKey, place, weak).catch((e) => e);
    expect(String(error)).toMatch(/distinct/);
    expect(String(error)).not.toContain(weak);
    await expect(writeImportedSecret(registry, publicKey, place, "short")).rejects.toThrow(/32/);
    await writeImportedSecret(registry, publicKey, place, "0123456789abcdef".repeat(4));
  });
});

describe("a fleet's queues as deployed (stage 66 step 7)", () => {
  it("are recognised under a product's prefix and staging's suffix, and never a DLQ as its queue", () => {
    expect(isFanOutQueue("cos-app-fanout")).toBe(true);
    expect(isFanOutQueue("crm-app-fanout")).toBe(true);
    expect(isFanOutQueue("crm-runner-fanout-staging")).toBe(true);
    expect(isFanOutQueue("crm-app-fanout-dlq")).toBe(false);
    expect(isParkingQueue("crm-app-parking-staging")).toBe(true);
    expect(isParkingQueue("crm-app-fanout")).toBe(false);
    expect(isQueue("crm-automation-events-staging", "cos-automation-events")).toBe(true);
    expect(isQueue("crm-routine-delivery", "cos-automation-events")).toBe(false);
  });
});

describe("a client's Stripe keys (the owner's payments decision, 2026-11-27)", () => {
  it("are given secrets: sealed and carried by an export, in no client's environment", async () => {
    for (const name of GATEKEEPER_HELD_SECRET_NAMES) expect(isGivenSecretName(name)).toBe(true);
    await addClientRows(registry, gym("gym-one"));
    const keys = await newHostKeys();
    const publicKey = await publicKeyOf(keys.secretsPrivateKey);
    const place = { environment: "live" as const, client: "gym-one" as ClientId };
    await writeClientSecret(
      registry,
      publicKey,
      { ...place, name: "STRIPE_SECRET_KEY" },
      "sk_test_one",
    );
    await writeClientSecret(
      registry,
      publicKey,
      { ...place, name: "STRIPE_WEBHOOK_SECRET" },
      "whsec_one",
    );
    const opened = await readClientSecrets(
      registry,
      await openingKeyring(keys.secretsPrivateKey),
      "live",
      "gym-one" as ClientId,
      false,
    );
    expect(opened.given).toEqual({
      STRIPE_SECRET_KEY: "sk_test_one",
      STRIPE_WEBHOOK_SECRET: "whsec_one",
    });
    const record = await readClient(registry, "gym-one" as ClientId);
    if (!record) throw new Error("added");
    const exported = await exportClientSecrets(
      {
        REGISTRY: registry,
        COS_ROOT_KEY: keys.rootKey,
        COS_SECRETS_PRIVATE_KEY: keys.secretsPrivateKey,
      },
      record,
    );
    expect(exported.given.STRIPE_SECRET_KEY).toBe("sk_test_one");
    // The builder takes a given value only into a name ENV_NAMES says a given secret fills.
    const real = env as unknown as Record<string, unknown>;
    const built = buildClientEnvironment(
      {
        DB: real.DB,
        REGISTRY: registry,
        CLIENT_DB_QUERIES: real.CLIENT_DB_QUERIES,
        COS_PROPS_KEY: real.TEST_PROPS_KEY,
        COS_HOST_ENVIRONMENT: "live",
      } as never,
      { client: record, settings: {}, given: opened.given },
    ) as unknown as Record<string, unknown>;
    // A given name ENV_NAMES lists is taken; the held ones are not.
    expect(
      buildClientEnvironment(
        {
          DB: real.DB,
          REGISTRY: registry,
          CLIENT_DB_QUERIES: real.CLIENT_DB_QUERIES,
          COS_PROPS_KEY: real.TEST_PROPS_KEY,
          COS_HOST_ENVIRONMENT: "live",
        } as never,
        { client: record, settings: {}, given: { TYPESAFE_API_KEY: "ts-key" } },
      ) as unknown as Record<string, unknown>,
    ).toHaveProperty("TYPESAFE_API_KEY", "ts-key");
    expect(built.STRIPE_SECRET_KEY).toBeUndefined();
    expect(built.STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });
});
