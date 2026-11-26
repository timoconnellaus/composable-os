import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { addClientDb } from "./testing/vitest.ts";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    // A client's database beside D1 (stage 66): test/client-db.test.ts runs both.
    miniflare: await addClientDb({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      // DB2: a second D1 database, the target of an import (test/sql-export.test.ts).
      d1Databases: ["DB", "DB2"],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        PRINT_CONFORMANCE: process.env.PRINT_CONFORMANCE ?? "",
      },
    }),
  }),
});
