import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientDbSetupFiles, withClientDb } from "@composable-os/db/testing/vitest";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));

// `pnpm relevance:real` (RELEVANCE_REAL=1) runs the semantic search relevance set against the real
// Workers AI embedding model with the caller's Cloudflare credentials (ADR 0155). Never in CI.
const realRelevance =
  process.env.RELEVANCE_REAL === "1" &&
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.CLOUDFLARE_API_TOKEN
    ? {
        RELEVANCE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        RELEVANCE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      }
    : {};

export default defineWorkersTestConfig({
  workers: async () => ({
    // COS_TEST_DB=client-db: env.DB is a client's database (stage 66, ADR 0612).
    miniflare: await withClientDb({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      // The media library's originals (stage 28, ADR 0444): a real local R2 bucket.
      r2Buckets: ["MEDIA_TEST"],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        // scripts/write-api-contract.mjs sets it to read the contract test prints (ADR 0417).
        PRINT_API_CONTRACT: process.env.PRINT_API_CONTRACT ?? "",
        ...realRelevance,
      },
    }),
  }),
  setupFiles: clientDbSetupFiles(["./test/apply-migrations.ts"]),
});
