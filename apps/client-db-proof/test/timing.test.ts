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

  it("refuses parameters it cannot use", async () => {
    for (const path of [
      "/time?db=d1&scenario=checkout&runs=abc",
      "/time?db=d1&scenario=checkout&runs=0",
      "/time?db=d1&scenario=checkout&runs=51",
      "/time?db=nope&scenario=checkout",
      "/cold/time?run=BAD!&i=0",
      "/subrequests?db=d1&max=99999",
    ]) {
      expect((await call(path)).status, path).toBe(400);
    }
  });

  it("finds no difference between the probes' answers but the allowed ones", async () => {
    const report = (await (await call("/conformance")).json()) as {
      differ: unknown[];
      allowed: { name: string }[];
      all: { name: string; same: boolean }[];
    };
    expect(report.differ).toEqual([]);
    // Since stage 66 step 2 (ADR 0614) a result over 32 MiB is answered as on D1: nothing differs.
    expect(report.allowed.map((p) => p.name)).toEqual([]);
    expect(report.all.find((p) => p.name === "read-over-32mib")?.same).toBe(true);
    expect(report.all.find((p) => p.name === "batch-in-parts")?.same).toBe(true);
  });

  it("times a fresh client's first page, and says whether its object was cold", async () => {
    const setup = await call("/cold/setup?run=t1&i=0", { method: "POST" });
    expect(setup.status).toBe(200);
    const { instance } = (await setup.json()) as { instance: string };
    const path = `/cold/time?run=t1&i=0&order=client-first&instance=${instance}`;
    type Parts = { firstQueryMs: number; pageMs: number; totalMs: number };
    const sample = (await (await call(path)).json()) as {
      d1: Parts;
      clientDb: Parts;
      clientWasCold: boolean;
    };
    for (const parts of [sample.d1, sample.clientDb]) {
      // The Workers clock moves only across I/O: a local first query may read 0 ms.
      expect(parts.firstQueryMs).toBeGreaterThanOrEqual(0);
      expect(parts.pageMs).toBeGreaterThan(0);
      expect(parts.totalMs).toBeCloseTo(parts.firstQueryMs + parts.pageMs, 5);
    }
    // Locally nothing is evicted between setup and the sample: the object is warm.
    expect(sample.clientWasCold).toBe(false);
  });

  it("counts the calls one request makes, up to a limit", async () => {
    // The service (the host's shape) and the namespace, and D1.
    for (const db of ["d1", "client-db", "client-db-direct"]) {
      const result = (await (await call(`/subrequests?db=${db}&max=200&fetches=0`)).json()) as {
        queries: number;
        error: string | null;
      };
      expect(result).toMatchObject({ queries: 200, error: null });
    }
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
