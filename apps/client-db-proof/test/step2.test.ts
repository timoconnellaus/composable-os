// The step 2 probes, locally (stage 66 step 2, ADR 0614): everything but point-in-time recovery,
// which the local runtime does not have, answers as it should on Cloudflare.
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const KEY = { "x-proof-key": "test-proof-key" };
const worker = (exports as unknown as { default: Fetcher }).default;
const call = async (path: string, init: RequestInit = {}) => {
  const response = await worker.fetch(`https://proof.test${path}`, {
    ...init,
    headers: { ...KEY, ...init.headers },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

beforeAll(async () => {
  for (;;) {
    const { remaining } = await call("/setup?db=d1", { method: "POST" });
    if (remaining === 0) break;
  }
}, 600_000);

describe("the step 2 probes", () => {
  it("move the D1 database through two clients' databases unchanged", async () => {
    const report = await call("/step2/export");
    expect(report).toMatchObject({
      ok: true,
      differ: { firstFromD1: [], secondFromFirst: [] },
    });
    expect(report.rows).toBeGreaterThan(300);
  }, 120_000);

  it("find every feature the export and import use on the D1 binding", async () => {
    expect(await call("/step2/d1")).toEqual({
      ok: true,
      tableXinfo: "ok",
      foreignKeys: "ok",
      tableList: "ok",
      hexAndQuote: "ok",
      masterByRowid: "ok",
      deferForeignKeys: "ok",
      scratchConcat: "ok",
      sqliteSequence: "ok",
      ftsRebuild: "ok",
      checkTable: "ok",
    });
  });

  it("answer a huge batch and a large read, and refuse one too large cleanly", async () => {
    expect(await call("/step2/answers")).toMatchObject({ ok: true, objectReset: false });
  }, 120_000);

  it("report the size after deletes", async () => {
    const report = await call("/step2/size");
    expect(report.ok).toBe(true);
    expect(report).toHaveProperty("fellAfterDelete");
  }, 60_000);

  it("report that point-in-time recovery is Cloudflare's only", async () => {
    const report = await call("/step2/pitr");
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/does not implement point-in-time recovery/);
  });
});
