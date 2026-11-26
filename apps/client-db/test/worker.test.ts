// The Worker that holds clients' databases exports ClientDb and ClientDbQueries, answers no
// request, and is in no single-client release (ADR 0614).
import { env, exports } from "cloudflare:workers";
import { clientDatabase, clientDatabaseService } from "@composable-os/db/client-db";
import type { ClientDbQueryService } from "@composable-os/db/client-db-service";
import { describe, expect, it } from "vitest";

/** The query service, as the app and the runner will bind it (`CLIENT_DB_QUERIES`). */
const queries = (exports as unknown as { ClientDbQueries: ClientDbQueryService }).ClientDbQueries;

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
    const db = clientDatabaseService(queries, "gym-service", { locationHint: "oc" });
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
      await expect(
        clientDatabaseService(queries, client).prepare("SELECT 1").all(),
        client,
      ).rejects.toThrow(/Not a client id/);
    }
    await expect(
      clientDatabaseService(queries, "gym-service", {
        locationHint: "moon" as DurableObjectLocationHint,
      })
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
    const db = clientDatabaseService(queries, "gym-service");
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  });
});
