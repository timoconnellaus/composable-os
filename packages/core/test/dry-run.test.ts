// The dry run (ADR 0022, amended 2026-11-22): a call queued for a person changes nothing until it
// is approved, whatever its handler does. A nested `pipeline.invoke` is simulated over its own
// overlay (not committed, not queued, no dependency on an action that does not exist) and joins
// the preview; another runtime or a direct write is refused and the call runs on approval; a
// nested call that needs its own approval leaves the outer one waiting on it; approving runs it
// all once.
import { env } from "cloudflare:workers";
import { isReadOnlySql } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  actionTitle,
  coreRegistry,
  createInvoker,
  createRegistry,
  DRY_RUN_RUNTIMES,
  defineOperation,
  type GrantGuard,
  type InvocationContext,
  type RecordChange,
  toolInputs,
  toolOf,
} from "../src/index.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

const nested = (ctx: { actor: never; user: never; origin: never }) => ({
  actor: ctx.actor,
  user: ctx.user,
  origin: ctx.origin,
});

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
    return ctx.pipeline.invoke("task.create", input, nested(ctx as never));
  },
});

/** The same at risk write, for an agent's grant (which dry-runs writes it lets through). */
const nestedCreateWrite = defineOperation({
  ...nestedCreate,
  name: "dryRunTest.nestedCreateWrite",
  risk: "write",
});

/** A destructive operation that changes a record its input names, through task.update. */
const nestedUpdate = defineOperation({
  name: "dryRunTest.nestedUpdate",
  description: "Test: renames a task through task.update.",
  input: z.object({ id: z.string(), title: z.string() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    return ctx.pipeline.invoke("task.update", input, nested(ctx as never));
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
    return ctx.pipeline.invoke("task.delete", input, nested(ctx as never));
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

/** A handler that calls every runtime on its context (each a fake with an `act` method). */
const everyRuntime = defineOperation({
  name: "dryRunTest.everyRuntime",
  description: "Test: acts on every runtime it is given.",
  input: z.object({ swallow: z.boolean() }),
  output: z.unknown(),
  permission: "records:write",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    for (const runtime of DRY_RUN_RUNTIMES) {
      const host = (ctx as unknown as Record<string, { act?: () => Promise<void> }>)[runtime];
      try {
        await host?.act?.();
      } catch (error) {
        if (!input.swallow) throw error;
      }
    }
    return { done: true };
  },
});

const { invoke, invokeByName } = createInvoker(
  createRegistry([
    ...coreRegistry.list(),
    nestedCreate,
    nestedCreateWrite,
    nestedUpdate,
    nestedReviewed,
    directWrite,
    directBatch,
    everyRuntime,
  ]),
);

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
  await setPreset("balanced");
});

const session = () => `cap_${unique("s")}`;
const mcp = (sessionId = session(), extra: Partial<InvocationContext> = {}) =>
  context(admin, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "t", clientName: "T", sessionId },
    reason: "Testing the dry run",
    ...extra,
  });

async function taskTitled(title: string) {
  return env.DB.prepare("SELECT id, title, deleted_at FROM core_task WHERE title = ?")
    .bind(title)
    .first<{ id: string; title: string; deleted_at: string | null }>();
}

async function setting(key: string) {
  return env.DB.prepare("SELECT value FROM core_settings WHERE key = ?").bind(key).first();
}

async function pendingRow(actionId: string) {
  return env.DB.prepare(
    "SELECT operation, status, status_reason, depends_on, preview, error FROM core_pending_action WHERE id = ?",
  )
    .bind(actionId)
    .first<{
      operation: string;
      status: string;
      status_reason: string | null;
      depends_on: string;
      preview: string;
      error: string | null;
    }>();
}

async function actionsIn(changeSetId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, operation, status FROM core_pending_action WHERE change_set_id = ? ORDER BY created_at, id",
  )
    .bind(changeSetId)
    .all<{ id: string; operation: string; status: string }>();
  return results;
}

async function notesOf(actionId: string): Promise<string[]> {
  const view = (await invokeByName("approval.status", { actionId }, context(admin))) as {
    changeSets: { actions: { id: string; notes: string[] }[] }[];
  };
  return view.changeSets.flatMap((s) => s.actions).find((a) => a.id === actionId)?.notes ?? [];
}

const details = (e: unknown) =>
  (e as { details: { actionId: string; changeSetId: string } }).details;

/** Approves, giving the second step when the action asks for one. */
async function approve(actionId: string, extra: Partial<InvocationContext> = {}) {
  const run = (confirm?: string) =>
    invokeByName(
      "approval.approve",
      { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
      context(admin, extra),
    );
  const first = await run().catch((e: unknown) => e);
  const label = (first as { details?: { confirmLabel?: string } }).details?.confirmLabel;
  return (label ? await run(label) : first) as {
    results: { actionId: string; status: string; statusReason: string | null; error: unknown }[];
  };
}

describe("a dry run", () => {
  it("simulates an operation the handler runs, shows it in the preview, and approval applies it once", async () => {
    const title = unique("Nested task");
    const queued = await invokeByName("dryRunTest.nestedCreate", { title }, mcp()).catch(
      (e: unknown) => e,
    );
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await taskTitled(title)).toBeNull();
    // Only the one action the person sees: none for the nested call.
    const actions = await actionsIn(details(queued).changeSetId);
    expect(actions.map((a) => a.operation)).toEqual(["dryRunTest.nestedCreate"]);
    // The nested create is in the preview a reviewer approves.
    const row = await pendingRow(details(queued).actionId);
    expect(JSON.parse(row?.preview ?? "[]")).toEqual([
      expect.objectContaining({ object: "task", action: "create" }),
    ]);
    expect(JSON.parse(row?.depends_on ?? "[]")).toEqual([]);
    const result = await approve(details(queued).actionId);
    expect(result.results.map((r) => r.status)).toEqual(["applied"]);
    expect(await taskTitled(title)).toMatchObject({ deleted_at: null });
  });

  it("a nested change to a record the input names leaves no dependency on a missing action", async () => {
    const before = unique("Rename me");
    const after = unique("Renamed");
    const task = await invoke("task.create", { title: before }, context(admin));
    const queued = await invokeByName(
      "dryRunTest.nestedUpdate",
      { id: task.id, title: after },
      mcp(),
    ).catch((e: unknown) => e);
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await taskTitled(before)).toMatchObject({ id: task.id });
    const row = await pendingRow(details(queued).actionId);
    expect(JSON.parse(row?.depends_on ?? "[]")).toEqual([]);
    expect(JSON.parse(row?.preview ?? "[]")).toEqual([
      expect.objectContaining({ object: "task", id: task.id, action: "update" }),
    ]);
    const result = await approve(details(queued).actionId);
    expect(result.results.map((r) => r.status)).toEqual(["applied"]);
    expect(await taskTitled(after)).toMatchObject({ id: task.id });
  });

  it("a nested call that needs its own approval: only the outer is queued, and approving it leaves it waiting on the nested one", async () => {
    const title = unique("Doomed task");
    const task = await invoke("task.create", { title }, context(admin));
    const sessionId = session();
    const queued = await invokeByName(
      "dryRunTest.nestedReviewed",
      { id: task.id },
      mcp(sessionId),
    ).catch((e: unknown) => e);
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await taskTitled(title)).toMatchObject({ deleted_at: null });
    const { actionId, changeSetId } = details(queued);
    expect((await actionsIn(changeSetId)).map((a) => a.operation)).toEqual([
      "dryRunTest.nestedReviewed",
    ]);
    expect(JSON.parse((await pendingRow(actionId))?.depends_on ?? "[]")).toEqual([]);
    expect((await notesOf(actionId)).join(" ")).toContain(
      "it calls task.delete, which needs its own approval",
    );

    // Approved: task.delete is queued now, and the outer says it waits on it.
    const result = await approve(actionId);
    const [outer] = result.results;
    expect(outer?.status).toBe("failed");
    expect(outer?.statusReason).toMatch(/^Waiting: it calls task\.delete, which needs its own/);
    const waitingOn = ((outer?.error ?? {}) as { details?: { waitingOn?: string } }).details
      ?.waitingOn;
    expect(waitingOn).toMatch(/^pac_/);
    expect(await taskTitled(title)).toMatchObject({ deleted_at: null });
    const nestedRow = await pendingRow(waitingOn as string);
    expect(nestedRow).toMatchObject({ operation: "task.delete", status: "pending" });
    // Approving that one finishes the job.
    const done = await approve(waitingOn as string);
    expect(done.results.map((r) => r.status)).toEqual(["applied"]);
    expect((await taskTitled(title))?.deleted_at).not.toBeNull();
  });

  it("a direct database write is refused, the call is queued to run on approval, and approval writes it", async () => {
    const key = unique("dryRunTest.direct");
    const queued = await invokeByName("dryRunTest.directWrite", { key }, mcp()).catch(
      (e: unknown) => e,
    );
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await setting(key)).toBeNull();
    expect((await notesOf(details(queued).actionId)).join(" ")).toContain("Runs on approval");
    await approve(details(queued).actionId);
    expect(await setting(key)).toMatchObject({ value: "1" });
  });

  it("a batch committed through pipeline.crm is refused the same way", async () => {
    const key = unique("dryRunTest.batch");
    const queued = await invokeByName("dryRunTest.directBatch", { key }, mcp()).catch(
      (e: unknown) => e,
    );
    expect(queued).toMatchObject({ code: "pending_approval" });
    expect(await setting(key)).toBeNull();
    await approve(details(queued).actionId);
    expect(await setting(key)).toMatchObject({ value: "1" });
  });

  it("refuses every other runtime, even when the handler catches the refusal", async () => {
    const acted: string[] = [];
    const hosts = Object.fromEntries(
      DRY_RUN_RUNTIMES.map((runtime) => [
        runtime,
        {
          async act() {
            acted.push(runtime);
          },
        },
      ]),
    ) as Partial<InvocationContext>;
    for (const swallow of [false, true]) {
      const queued = await invokeByName(
        "dryRunTest.everyRuntime",
        { swallow },
        mcp(session(), hosts),
      ).catch((e: unknown) => e);
      expect(queued).toMatchObject({ code: "pending_approval" });
      expect(acted).toEqual([]);
      expect((await notesOf(details(queued).actionId)).join(" ")).toContain("Runs on approval");
    }
    // Run for real (by a person), every runtime is reached.
    await invokeByName("dryRunTest.everyRuntime", { swallow: false }, context(admin, hosts));
    expect(acted.sort()).toEqual([...DRY_RUN_RUNTIMES].sort());
  });

  it("an agent's grant dry run creates nothing, and sees the nested change", async () => {
    const title = unique("Granted task");
    let planned: readonly RecordChange[] = [];
    const guard: GrantGuard = {
      jobId: "agj_test",
      allowsRead: () => true,
      needsChanges: () => true,
      route: async (_op, changes) => {
        planned = changes;
        // Nothing was created while the guard decided.
        expect(await taskTitled(title)).toBeNull();
        return "auto";
      },
      applied: () => {},
    };
    await invokeByName(
      "dryRunTest.nestedCreateWrite",
      { title },
      context(admin, {
        actor: "assistant",
        origin: { surface: "assistant", sessionId: session() },
        grantGuard: guard,
      }),
    );
    expect(planned).toEqual([expect.objectContaining({ object: "task", action: "create" })]);
    const { results } = await env.DB.prepare("SELECT id FROM core_task WHERE title = ?")
      .bind(title)
      .all();
    expect(results).toHaveLength(1);
  });
});

describe("migration 0600", () => {
  it("marks the tool actions pending at upgrade as having run, and rejects nothing", async () => {
    const queue = async () => {
      const queued = await invokeByName(
        "dryRunTest.nestedCreate",
        { title: unique("Old tool") },
        mcp(),
      ).catch((e: unknown) => e);
      return details(queued).actionId;
    };
    const [tool, other] = [await queue(), await queue()];
    // A tool action queued before the fix (the operation name is all the migration reads).
    await env.DB.prepare("UPDATE core_pending_action SET operation = 'x.demo.wipe' WHERE id = ?")
      .bind(tool)
      .run();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0600_"));
    expect(migration).toBeTruthy();
    for (const query of migration?.queries ?? []) await env.DB.prepare(query).run();
    const view = async (actionId: string) =>
      (
        (await invokeByName("approval.status", { actionId }, context(admin))) as {
          changeSets: { actions: { id: string; status: string; toolRanAtQueue: boolean }[] }[];
        }
      ).changeSets
        .flatMap((s) => s.actions)
        .find((a) => a.id === actionId);
    expect(await view(tool)).toMatchObject({ status: "pending", toolRanAtQueue: true });
    expect(await view(other)).toMatchObject({ status: "pending", toolRanAtQueue: false });
  });
});

describe("the read-only handle", () => {
  it("lets one read through and nothing else", () => {
    for (const sql of [
      "select * from core_task",
      'SELECT "id" FROM "core_task" WHERE "title" = ?',
      "  -- a comment\n  SELECT 1",
      "/* a comment */ SELECT 1;",
      "WITH t AS (SELECT 1 AS n) SELECT n FROM t",
      "VALUES (1), (2)",
      "SELECT 'insert into x; delete' AS s",
      "SELECT replace(title, 'a', 'b') FROM core_task",
    ]) {
      expect([sql, isReadOnlySql(sql)]).toEqual([sql, true]);
    }
    for (const sql of [
      "INSERT INTO core_task (id) VALUES ('x')",
      "/* x */ INSERT INTO core_task (id) VALUES ('x')",
      "-- x\nINSERT INTO core_task (id) VALUES ('x')",
      "SELECT 1; INSERT INTO core_task (id) VALUES ('x')",
      "SELECT 1; SELECT 2",
      "WITH t AS (SELECT 1) INSERT INTO core_task (id) SELECT 'x'",
      "WITH t AS (SELECT 1) DELETE FROM core_task",
      "REPLACE INTO core_task (id) VALUES ('x')",
      "UPDATE core_task SET title = 'x'",
      "DELETE FROM core_task",
      "ATTACH DATABASE 'x' AS y",
      "DETACH DATABASE y",
      "PRAGMA journal_mode = OFF",
      "PRAGMA table_info(core_task)",
      "SAVEPOINT a",
      "ANALYZE",
      "VACUUM",
      "CREATE TABLE x (a)",
      "DROP TABLE core_task",
      "SELECT 1 /* unterminated",
      "SELECT 'unterminated",
    ]) {
      expect([sql, isReadOnlySql(sql)]).toEqual([sql, false]);
    }
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
