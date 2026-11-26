// The Worker that holds clients' databases exports ClientDb, answers no request, and is in no
// single-client release (ADR 0614).
import { env, exports } from "cloudflare:workers";
import { clientDatabase } from "@composable-os/db/client-db";
import { describe, expect, it } from "vitest";

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
