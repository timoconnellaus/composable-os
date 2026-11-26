// Setup file of a suite run on a client's database (`COS_TEST_DB=client-db`, testing/vitest.ts):
// `env.DB` becomes one client's `ClientDb`, migrated inside the object, before any test file is
// loaded. The suite's own setup (applying migrations to `env.DB`) then finds nothing to do, and
// its tests run unchanged. After each file the D1 binding must still hold no table: a test that
// reached D1 some other way would pass without having run on the client's database.
import { env } from "cloudflare:workers";
import { afterAll } from "vitest";
import { type ClientDb, clientDatabase } from "../src/client-db.ts";
import type { Migration } from "../src/migrate.ts";

/** The one client every suite's tests run as. */
export const TEST_CLIENT = "test-client";

const bindings = env as unknown as {
  DB: D1Database;
  CLIENT_DB?: DurableObjectNamespace<ClientDb>;
  TEST_MIGRATIONS: Migration[];
};
const namespace = bindings.CLIENT_DB;
if (!namespace) throw new Error("COS_TEST_DB=client-db, but the Worker has no CLIENT_DB binding");
const d1 = bindings.DB;
bindings.DB = clientDatabase(namespace, TEST_CLIENT);
if (bindings.DB === d1) throw new Error("COS_TEST_DB=client-db: env.DB could not be replaced");

await namespace.get(namespace.idFromName(TEST_CLIENT)).migrate(bindings.TEST_MIGRATIONS);

afterAll(async () => {
  const row = await d1
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .first<{ n: number }>();
  if (row?.n) {
    throw new Error(
      `COS_TEST_DB=client-db: the D1 binding holds ${row.n} tables; something reached D1 directly`,
    );
  }
});
