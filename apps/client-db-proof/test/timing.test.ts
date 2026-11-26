// The proof Worker, locally (stage 66 step 1): set up both databases through its own routes, run
// every scenario on each, and compare the probes. With COS_TIMING_RUNS=N (`pnpm time:local`) it
// times each scenario N times on each database and prints the medians and p95s. Locally both
// D1 and a client's database are SQLite in a Durable Object in one process, so these numbers say
// what the binding and the object's call cost here, not what Cloudflare will show.
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SCENARIOS } from "../src/scenarios.ts";

const KEY = { "x-proof-key": "test-proof-key" };
const worker = (exports as unknown as { default: Fetcher }).default;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(`https://proof.test${path}`, { ...init, headers: { ...KEY, ...init.headers } });
const runs = Number((env as unknown as { COS_TIMING_RUNS?: string }).COS_TIMING_RUNS || 0);

beforeAll(async () => {
  for (const db of ["d1", "client-db"]) {
    for (;;) {
      const response = await call(`/setup?db=${db}`, { method: "POST" });
      expect(response.status).toBe(200);
      const { remaining } = (await response.json()) as { remaining: number };
      if (remaining === 0) break;
    }
  }
}, 600_000);

describe("the proof Worker", () => {
  it("refuses a request without its key", async () => {
    expect((await worker.fetch("https://proof.test/time?db=d1&scenario=checkout")).status).toBe(
      404,
    );
    expect(await (await worker.fetch("https://proof.test/health")).json()).toEqual({
      ok: true,
      keySet: true,
    });
  });

  it("finds no difference between the probes' answers", async () => {
    const report = (await (await call("/conformance")).json()) as { differ: unknown[] };
    expect(report.differ).toEqual([]);
  });

  it("runs every scenario on both databases", { timeout: 600_000 }, async () => {
    const table: Record<string, unknown>[] = [];
    for (const from of ["near", "edge"]) {
      for (const scenario of SCENARIOS) {
        for (const db of ["d1", "client-db"]) {
          const response = await call(
            `/time?db=${db}&scenario=${scenario}&runs=${runs || 2}&from=${from}`,
          );
          expect(response.status).toBe(200);
          const result = (await response.json()) as {
            median: number;
            p95: number;
            runs: number;
            statementsPerRun: number;
          };
          expect(result.statementsPerRun).toBeGreaterThan(0);
          table.push({
            from,
            scenario,
            db,
            runs: result.runs,
            median: result.median,
            p95: result.p95,
            statements: result.statementsPerRun,
          });
        }
      }
    }
    if (runs)
      console.log(
        `LOCAL timing (ms, inside the Worker, workerd on this machine)\n${JSON.stringify(table)}`,
      );
  });
});
