// The dry run (ADR 0022, amended 2026-11-22): a call queued for a person changes nothing until it
// is approved, whatever its handler does. A nested `pipeline.invoke` is simulated (not committed,
// not queued); a direct write or batch is refused; approving runs it all once.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  actionTitle,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  toolInputs,
  toolOf,
} from "../src/index.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

/** A destructive operation that makes its change through another operation. */
const nestedCreate = defineOperation({
  name: "dryRunTest.nestedCreate",
  description: "Test: creates a task through task.create.",
  input: z.object({ title: z.string() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    return ctx.pipeline.invoke("task.create", input, {
      actor: ctx.actor,
      user: ctx.user,
      origin: ctx.origin,
    });
  },
});

/** A destructive operation whose nested call would itself wait for review. */
const nestedReviewed = defineOperation({
  name: "dryRunTest.nestedReviewed",
  description: "Test: deletes a task through task.delete.",
  input: z.object({ id: z.string() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    return ctx.pipeline.invoke("task.delete", input, {
      actor: ctx.actor,
      user: ctx.user,
      origin: ctx.origin,
    });
  },
});

/** A handler that writes without `ctx.write` (a bug a dry run must not turn into a change). */
const directWrite = defineOperation({
  name: "dryRunTest.directWrite",
  description: "Test: writes a setting directly.",
  input: z.object({ key: z.string() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    await ctx.db
      .insertInto("core_settings")
      .values({ key: input.key, value: "1", updated_at: ctx.now })
      .execute();
    return null;
  },
});

/** The same through the pipeline's own batch. */
const directBatch = defineOperation({
  name: "dryRunTest.directBatch",
  description: "Test: commits a setting through pipeline.crm.",
  input: z.object({ key: z.string() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    await ctx.pipeline.crm.batch([
      ctx.pipeline.crm.query
        .insertInto("core_settings")
        .values({ key: input.key, value: "1", updated_at: ctx.now }),
    ]);
    return null;
  },
});

const { invoke, invokeByName } = createInvoker(
  createRegistry([...coreRegistry.list(), nestedCreate, nestedReviewed, directWrite, directBatch]),
);

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
  await setPreset("balanced");
});

const mcp = () =>
  context(admin, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "t", clientName: "T", sessionId: `cap_${unique("s")}` },
    reason: "Testing the dry run",
  });

async function taskTitled(title: string) {
  return env.DB.prepare("SELECT id, deleted_at FROM core_task WHERE title = ?")
    .bind(title)
    .first<{ id: string; deleted_at: string | null }>();
}

async function setting(key: string) {
  return env.DB.prepare("SELECT value FROM core_settings WHERE key = ?").bind(key).first();
}

describe("a dry run", () => {
  it("simulates an operation the handler runs: nothing is created until approval", async () => {
    const title = unique("Nested task");
    const queued = await invokeByName("dryRunTest.nestedCreate", { title }, mcp()).catch(
      (e: unknown) => e,
    );
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await taskTitled(title)).toBeNull();
    // No pending action was queued for the nested call either: only the one the person sees.
    const { results } = await env.DB.prepare(
      "SELECT operation FROM core_pending_action WHERE change_set_id = ?",
    )
      .bind((queued as { details: { changeSetId: string } }).details.changeSetId)
      .all<{ operation: string }>();
    expect(results.map((r) => r.operation)).toEqual(["dryRunTest.nestedCreate"]);
    const actionId = (queued as { details: { actionId: string } }).details.actionId;
    const decision = await invokeByName(
      "approval.approve",
      { actionIds: [actionId] },
      context(admin),
    ).catch((e: unknown) => e);
    const confirm = (decision as { details?: { confirmLabel?: string } }).details?.confirmLabel;
    await invokeByName("approval.approve", { actionIds: [actionId], confirm }, context(admin));
    expect(await taskTitled(title)).toMatchObject({ deleted_at: null });
  });

  it("simulates a nested call that would itself wait for review, and queues only the outer one", async () => {
    const title = unique("Doomed task");
    const task = await invoke("task.create", { title }, context(admin));
    const queued = await invokeByName("dryRunTest.nestedReviewed", { id: task.id }, mcp()).catch(
      (e: unknown) => e,
    );
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await taskTitled(title)).toMatchObject({ deleted_at: null });
    const { results } = await env.DB.prepare(
      "SELECT operation FROM core_pending_action WHERE change_set_id = ?",
    )
      .bind((queued as { details: { changeSetId: string } }).details.changeSetId)
      .all<{ operation: string }>();
    expect(results.map((r) => r.operation)).toEqual(["dryRunTest.nestedReviewed"]);
  });

  it("refuses a direct database write instead of making it", async () => {
    const key = unique("dryRunTest.direct");
    await expect(invokeByName("dryRunTest.directWrite", { key }, mcp())).rejects.toMatchObject({
      code: "internal",
    });
    expect(await setting(key)).toBeNull();
    // Outside a dry run the same handler writes (the guard is the dry run's, not the handle's).
    await invokeByName("dryRunTest.directWrite", { key }, context(admin));
    expect(await setting(key)).toMatchObject({ value: "1" });
  });

  it("refuses a batch committed through pipeline.crm", async () => {
    const key = unique("dryRunTest.batch");
    await expect(invokeByName("dryRunTest.directBatch", { key }, mcp())).rejects.toMatchObject({
      code: "internal",
    });
    expect(await setting(key)).toBeNull();
  });

  it("is not where a queued call's audit and pending rows are written", async () => {
    // The queue's own statements still commit: a reviewed core write queues as before.
    const title = unique("Queued task");
    const queued = await invokeByName(
      "task.create",
      { title },
      context(admin, {
        actor: "mcp",
        origin: { surface: "mcp", sessionId: `cap_${unique("s")}` },
        floor: { "*": { write: "review" } },
      }),
    ).catch((e: unknown) => e);
    expect(queued).toMatchObject({ code: "pending_approval" });
    const row = await env.DB.prepare("SELECT preview FROM core_pending_action WHERE id = ?")
      .bind((queued as { details: { actionId: string } }).details.actionId)
      .first<{ preview: string }>();
    expect(JSON.parse(row?.preview ?? "[]")).toHaveLength(1);
    expect(await taskTitled(title)).toBeNull();
  });
});

describe("a queued extension tool, described", () => {
  it("is titled by its tool and extension, and its inputs are listed", () => {
    expect(toolOf("x.leads.convert")).toEqual({ extension: "leads", tool: "convert" });
    expect(toolOf("task.create")).toBeNull();
    expect(actionTitle("x.programs.sessionComplete", [], {})).toBe(
      "Session complete (programs tool)",
    );
    expect(toolInputs({ leadId: "rec_1", reason: "Gone quiet", ids: ["a", "b"], n: 2 })).toEqual([
      { name: "leadId", value: "rec_1" },
      { name: "reason", value: "Gone quiet" },
      { name: "ids", value: '["a","b"]' },
      { name: "n", value: "2" },
    ]);
    expect(toolInputs(undefined)).toEqual([]);
  });
});
