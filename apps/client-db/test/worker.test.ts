// The Worker that holds clients' databases exports ClientDb and ClientDbQueries, answers no
// request, and is in no single-client release (ADR 0614).
import { env, exports } from "cloudflare:workers";
import { clientDatabase, clientDatabaseService } from "@composable-os/db/client-db";
import type { ClientDbQueryService } from "@composable-os/db/client-db-service";
import { bindingProof, clientDbCallerProps, PROOF } from "@composable-os/db/client-proofs";
import { describe, expect, it } from "vitest";

const keys = env as unknown as { TEST_PROPS_KEY: string; TEST_PROPS_KEY_PREVIOUS: string };
const KEY = keys.TEST_PROPS_KEY;

type Minting = (options: { props: unknown }) => ClientDbQueryService;
const mint = (props: unknown) =>
  (exports as unknown as { ClientDbQueries: Minting }).ClientDbQueries({ props });

/** The query service, as the app binds it (`CLIENT_DB_QUERIES`, the deploy's props, #515 S1). */
const queries = mint(clientDbCallerProps(KEY, "cos-app"));

/** A client's database as the directory opens it: each call with the host's proof of it. */
const proven = (client: string, options: { locationHint?: DurableObjectLocationHint } = {}) =>
  clientDatabaseService(queries, client, {
    ...options,
    proof: bindingProof(KEY, PROOF.clientDb, client),
  });

describe("cos-client-db", () => {
  it("holds a client's database behind its binding", async () => {
    const db = clientDatabase(env.CLIENT_DB, "a-client");
    await db.prepare("CREATE TABLE t (v)").run();
    await db.prepare("INSERT INTO t VALUES (1)").run();
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(1);
  });

  it("answers no request itself", async () => {
    const response = await exports.default.fetch("https://client-db.example/anything");
    expect(response.status).toBe(404);
  });
});

describe("ClientDbQueries, the query path only (S6)", () => {
  it("serves a client's database, the same object the namespace reaches", async () => {
    const db = proven("gym-service", { locationHint: "oc" });
    await db.prepare("CREATE TABLE t (v)").run();
    await db.batch([
      db.prepare("INSERT INTO t VALUES (1)"),
      db.prepare("INSERT INTO t VALUES (2)"),
    ]);
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
    const direct = clientDatabase(env.CLIENT_DB, "gym-service");
    expect(await direct.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  });

  it("refuses a client id the registry's rule refuses, and an unknown hint", async () => {
    for (const client of ["Admin", "cos-host", "", "a b"]) {
      await expect(proven(client).prepare("SELECT 1").all(), client).rejects.toThrow(
        /Not a client id/,
      );
    }
    await expect(
      proven("gym-service", { locationHint: "moon" as DurableObjectLocationHint })
        .prepare("SELECT 1")
        .all(),
    ).rejects.toThrow(/unknown location hint/);
  });

  it("offers none of the operator's methods", async () => {
    const service = queries as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of [
      "restart",
      "restore",
      "setSizeLimits",
      "migrate",
      "migrateAndReport",
      "bookmark",
      "hold",
      "place",
    ]) {
      await expect(
        Promise.resolve().then(() => service[method]?.({ client: "gym-service" })),
        method,
      ).rejects.toThrow();
    }
    // The object was not restarted or held: it still answers.
    const db = proven("gym-service");
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  });
});

describe("ClientDbQueries checks its caller and each call's client (#515, S1)", () => {
  const select = (service: ClientDbQueryService, client: string, proof?: string) =>
    clientDatabaseService(service, client, proof ? { proof } : {})
      .prepare("SELECT 1 AS one")
      .first("one");

  it("answers the host's Workers, by their binding's props, under the key or the one before", async () => {
    for (const caller of ["cos-app", "cos-runner"] as const) {
      for (const key of [KEY, keys.TEST_PROPS_KEY_PREVIOUS]) {
        const service = mint(clientDbCallerProps(key, caller));
        expect(await select(service, "gym-a", bindingProof(KEY, PROOF.clientDb, "gym-a"))).toBe(1);
      }
    }
  });

  it("refuses a binding with no props, another caller, a copied name, or another key's proof", async () => {
    const plain = (exports as unknown as { ClientDbQueries: ClientDbQueryService }).ClientDbQueries;
    const proof = bindingProof(KEY, PROOF.clientDb, "gym-a");
    for (const service of [
      plain,
      mint({}),
      mint({ caller: "cos-front", proof: clientDbCallerProps(KEY, "cos-app").proof }),
      mint({ caller: "cos-app" }),
      mint({ caller: "cos-runner", proof: clientDbCallerProps(KEY, "cos-app").proof }),
      mint(clientDbCallerProps(`${KEY}-other`, "cos-app")),
    ]) {
      await expect(select(service, "gym-a", proof)).rejects.toThrow(
        /not one of the host's Workers/,
      );
    }
  });

  it("refuses a call with no proof of its client, or another client's, or another key's", async () => {
    for (const proof of [
      undefined,
      bindingProof(KEY, PROOF.clientDb, "gym-b"),
      bindingProof(KEY, PROOF.clientApp, "gym-a"),
      bindingProof(`${KEY}-other`, PROOF.clientDb, "gym-a"),
      "0".repeat(32),
    ]) {
      await expect(select(queries, "gym-a", proof), String(proof)).rejects.toThrow(
        /no proof of its client/,
      );
    }
  });
});
