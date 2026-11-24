// The demo seed (`pnpm --filter @composable-os/db seed`, which the 10k People e2e test runs) stays
// safe to run twice against real D1: since migration 0851 a trigger aborts any insert over an
// existing Person, OR IGNORE or not, so a second run used to fail (issue #305).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/index.ts";
import { seedDatabase } from "../src/seed.ts";

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("seedDatabase", () => {
  it("seeds the same records twice without failing or duplicating", async () => {
    await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    const options = { people: 120, organisations: 20, activities: 10, tasks: 10 };
    const counts = await seedDatabase(env.DB, options);
    expect(await count("core_person")).toBe(counts.people);
    await seedDatabase(env.DB, options);
    expect(await count("core_person")).toBe(counts.people);
    expect(await count("core_person_emails")).toBe(counts.people);
  });
});
