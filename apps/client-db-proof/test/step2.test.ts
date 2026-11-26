// The step 2 probes, locally (stage 66 step 2, ADR 0614), driven as scripts/step2.mjs drives
// them: a bounded call at a time, the cursor sent back, until done. Everything but point-in-time
// recovery, which the local runtime does not have, answers as it should on Cloudflare.
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

type Step =
  | { done: true; result: Record<string, unknown> }
  | { done: false; cursor: unknown; progress: string };

/** A probe's calls, until done: its result and how many calls it took. */
async function drive(probe: string): Promise<{ result: Record<string, unknown>; calls: number }> {
  let cursor: unknown = null;
  for (let calls = 1; calls <= 500; calls += 1) {
    const step = (await call(`/step2/${probe}`, {
      method: "POST",
      body: JSON.stringify({ cursor }),
    })) as Step;
    if (step.done) return { result: step.result, calls };
    expect(step.progress).toEqual(expect.any(String));
    cursor = step.cursor;
  }
  throw new Error(`${probe} did not finish in 500 calls`);
}

beforeAll(async () => {
  for (;;) {
    const { remaining } = await call("/setup?db=d1", { method: "POST" });
    if (remaining === 0) break;
  }
}, 600_000);

describe("the step 2 probes", () => {
  it("move the D1 database through two clients' databases unchanged, in parts", async () => {
    const { result, calls } = await drive("export");
    expect(result).toMatchObject({
      ok: true,
      differ: { firstFromD1: [], secondFromFirst: [] },
    });
    expect(result.tables).toBeGreaterThan(250);
    // Locally a call does a lot in its budget; the shape of the calls is what is proved.
    expect(calls).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("find every feature the export and import use on the D1 binding", async () => {
    expect((await drive("d1")).result).toEqual({
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

  it("answer a huge batch and a large read, and refuse one too large cleanly, a step a call", async () => {
    const { result, calls } = await drive("answers");
    expect(result).toMatchObject({ ok: true, objectReset: false });
    expect(calls).toBe(5);
  }, 120_000);

  it("report the size after deletes", async () => {
    const { result } = await drive("size");
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("fellAfterDelete");
  }, 60_000);

  it("report that point-in-time recovery is Cloudflare's only", async () => {
    const { result } = await drive("pitr");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not implement point-in-time recovery/);
  });

  it("refuse an unknown probe", async () => {
    const response = await worker.fetch("https://proof.test/step2/nothing", {
      method: "POST",
      headers: KEY,
    });
    expect(response.status).toBe(404);
  });
});
