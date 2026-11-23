// Stage 45 step 4b (ADR 0650, the review of PR #298): the minute cron's new runs are bound in
// statements of at most RUN_CHUNK_BYTES each, so 200 runs of the largest checklist never pass D1's
// limit on one bound value.
import { describe, expect, it } from "vitest";
import {
  makeRunsStatements,
  newRunValues,
  type RecordFacts,
  RUN_CHUNK_BYTES,
} from "../src/checklists/index.ts";

describe("making many runs", () => {
  it("binds 200 runs of a 50-step checklist of the longest steps in chunks under the limit", () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      text: `${i} ${"é".repeat(297)}`.slice(0, 300),
      required: true,
      note: false,
    }));
    const template = { id: "ckl_x", name: "N".repeat(120), version: 1, active: true, steps };
    const runs = Array.from({ length: 200 }, (_, i) => {
      const facts: RecordFacts = {
        object: "rostering.shift",
        id: `rec_${i}`,
        title: "t",
        zone: null,
        account: `usr_${i}`,
        opens: 1,
        closes: 2,
        live: true,
        template: "ckl_x",
      };
      return newRunValues(`ckr_${i}`, facts, template, "2026-01-01T00:00:00.000Z");
    });
    const statements = makeRunsStatements(runs);
    expect(statements.length).toBeGreaterThan(1);
    let total = 0;
    for (const s of statements) {
      const bound = String(s.parameters[0]);
      expect(new TextEncoder().encode(bound).length).toBeLessThanOrEqual(RUN_CHUNK_BYTES);
      total += (JSON.parse(bound) as unknown[]).length;
    }
    expect(total).toBe(200);
  });
});
