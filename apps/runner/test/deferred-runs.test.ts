// Runs over the runs-per-minute rail (ADR 0573), the review of PR #256's second round: the drain
// applies an automation's own stricter rail as the start does; one automation's backlog never
// holds another's back; a retry or a manual run over the rail is reported as waiting its turn
// (with its id), keeps its journal and the run its chain began with, and is not asked twice.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationDefinition,
  loadEnabledAutomations,
  memoryRateLimit,
  type RunCandidate,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFERRED_REASON, runDeferredDue, startRuns } from "../src/automations/dispatch.ts";
import { automationHost } from "../src/automations/host.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, install } from "./helpers.ts";

const EXT = "drained";
const FILES = {
  "index.ts": `import { defineAutomation, defineExtension } from "@composable-os/sdk";
const noop = (label: string, rails?: { maxRunsPerMinute: number }) =>
  defineAutomation({
    label,
    description: "Does nothing: a run to count.",
    trigger: { type: "manual", object: "${EXT}.thing", label },
    ...(rails ? { rails } : {}),
    steps: [{ name: "first" }, { name: "second" }],
    async run(event, step) {
      await step.do("first", () => 1);
      return step.do("second", () => 2);
    },
  });
export default defineExtension({
  id: "${EXT}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Drained (fixture)",
  objects: { thing: { label: "Thing", plural: "Things", titleField: "name", fields: { name: { type: "text", label: "Name" } } } },
  permissions: { read: [], write: [], operations: [], modules: ["ops"] },
  automations: { railed: noop("Railed", { maxRunsPerMinute: 6 }), busy: noop("Busy"), quiet: noop("Quiet") },
});
`,
};

let admin: ActingUser;
let automations: Map<string, AutomationDefinition>;
const MINUTE = 60_000;
const refuseAll = { ...env, AUTOMATION_RATE_LIMIT: memoryRateLimit(0) };
const allowAll = { ...env, AUTOMATION_RATE_LIMIT: memoryRateLimit(100_000) };

/** `count` runs of an automation, all held back by a rail that refuses everything. */
async function backlog(name: string, count: number, tag: string) {
  const automation = automations.get(`${EXT}.${name}`) as AutomationDefinition;
  const candidates: RunCandidate[] = Array.from({ length: count }, (_, i) => ({
    automation,
    idempotencyKey: `${tag}:${i}`,
  }));
  const result = await startRuns(refuseAll, candidates, {
    depth: 0,
    chain: [],
    rootEventId: tag,
    eventId: tag,
    at: new Date().toISOString(),
  });
  expect(result.deferred).toBe(count);
  return result.deferredRunIds;
}

async function waitingOf(name: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_automation_runs WHERE automation_id = ? AND status_reason = ?",
  )
    .bind(`${EXT}.${name}`, DEFERRED_REASON)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await install(admin, EXT, FILES);
  automations = new Map(
    (await loadEnabledAutomations(db.query, ["manual"])).map((a) => [a.id, a] as const),
  );
}, 120_000);

describe("the drain (ADR 0573)", () => {
  it("applies an automation's own stricter rail, not only the binding's", async () => {
    await backlog("railed", 10, "rail");
    const drained = await runDeferredDue(allowAll, new Date(Date.now() + 2 * MINUTE));
    expect(drained.started).toBe(6);
    expect(await waitingOf("railed")).toBe(4);
  });

  it("gives every automation its share: one's backlog never holds another's back", async () => {
    await backlog("busy", 12, "busy");
    await backlog("quiet", 2, "quiet");
    const at = new Date(Date.now() + 2 * MINUTE);
    // A tick of ten: the busy one's twelve are older, and still the quiet one's two start.
    await runDeferredDue(allowAll, at, { perTick: 10 });
    expect(await waitingOf("quiet")).toBe(0);
    expect(await waitingOf("busy")).toBeLessThan(12);
  });
});

describe("a retry over the rail (ADR 0573, 0574)", () => {
  it("is reported waiting its turn, with its id, keeps its journal, and is not asked twice", async () => {
    // A failed run of "quiet" whose first step completed.
    const failed = `arn_failed${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, status, steps, depth, started_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, 1, ?, ?)",
    )
      .bind(
        failed,
        `${EXT}.quiet`,
        EXT,
        JSON.stringify({ type: "manual", eventId: "manual:x", key: "manual:x", chain: [] }),
        JSON.stringify([{ name: "first", kind: "do", status: "completed", value: 1 }]),
        now,
        now,
      )
      .run();
    const host = automationHost(refuseAll);
    const first = await host.retryRun(failed);
    expect(first.deferred).toBe(true);
    const row = await env.DB.prepare(
      "SELECT trigger, status_reason, retry_of FROM core_automation_runs WHERE id = ?",
    )
      .bind(first.runId)
      .first<{ trigger: string; status_reason: string; retry_of: string }>();
    expect(row?.status_reason).toBe(DEFERRED_REASON);
    expect(row?.retry_of).toBe(failed);
    const trigger = JSON.parse(row?.trigger ?? "{}");
    // The completed step replays rather than runs again; the chain began with the failed run.
    expect(trigger.journal).toEqual([{ name: "first", kind: "do", value: 1 }]);
    expect(trigger.originalRunId).toBe(failed);
    // Asked again while it waits: the same run.
    expect(await host.retryRun(failed)).toEqual({ runId: first.runId, deferred: true });
  });

  it("a manual run over the rail answers with the runs waiting their turn", async () => {
    const out = await automationHost(refuseAll).startManualRun({
      automationId: `${EXT}.quiet`,
      trigger: "manual",
      userId: admin.id,
      object: `${EXT}.thing`,
      recordIds: ["rec_a", "rec_b"],
    });
    expect(out.runIds).toEqual([]);
    expect(out.skipped).toBe(0);
    expect(out.deferredRunIds).toHaveLength(2);
  });
});
