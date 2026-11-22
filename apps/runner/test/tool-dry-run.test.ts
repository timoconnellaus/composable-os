// An extension tool queued for a person (ADR 0022 amendment, 2026-11-22): the approval queue's dry
// run must not run the tool, because a tool's own operation calls (and its storage) are real
// effects the dry run cannot hold back. Each actor whose calls can be queued, each risk class a
// tool may declare, and the floor: nothing changes until a person approves, and approving runs the
// tool once.
import { env } from "cloudflare:workers";
import {
  type Actor,
  createTestSimulation,
  type InvocationContext,
  invokeByName,
  parseFloor,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, context, createAdmin, install, source, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
const id = unique("dry").slice(0, 20);
const ITEM = `${id}.item`;

// One tool per risk class a tool may declare. Each renames an item through ctx.ops (a write the
// extension may make without review) and records that it ran in its own storage.
const tool = (name: string, risk: string) => `${name}: defineTool({
      description: "Rename an item (${risk}).",
      risk: "${risk}",
      input: z.object({ id: z.string(), name: z.string() }),
      output: z.object({ name: z.string() }),
      async handler({ id, name }, ctx) {
        await ctx.storage.set("ran:" + id, "${name}");
        const out = await ctx.ops.call<{ values: { name: string } }>("record.update", {
          object: "${ITEM}", id, values: { name },
        });
        return { name: out.values.name };
      },
    }),`;

beforeAll(async () => {
  admin = await createAdmin();
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["ops", "storage"] },
  objects: { item: { label: "Item", plural: "Items", titleField: "name", fields: { name: { type: "text", label: "Name" } } } },
  tools: {
    ${tool("wipe", "destructive")}
    ${tool("rename", "write")}
    ${tool("renameAll", "bulk-write")}
  },`,
    ),
  );
});

async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}

async function newItem(): Promise<string> {
  const item = await call<{ id: string }>(admin, "record.create", {
    object: ITEM,
    values: { name: "Before" },
  });
  return item.id;
}

async function nameOf(itemId: string): Promise<string> {
  const item = await call<{ values: { name: string } }>(admin, "record.get", {
    object: ITEM,
    id: itemId,
  });
  return item.values.name;
}

async function ran(itemId: string): Promise<unknown> {
  const row = await env.DB.prepare(
    "SELECT value FROM core_extension_kv WHERE extension_id = ? AND key = ?",
  )
    .bind(id, `ran:${itemId}`)
    .first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

/** Writes the tool's extension made: zero until a person approves. */
async function extensionWrites(itemId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.actor = 'extension'",
  )
    .bind(itemId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function as(actor: Actor, extra: Partial<InvocationContext> = {}): InvocationContext {
  const surface = actor === "mcp" ? "mcp" : actor === "assistant" ? "assistant" : "automation";
  return context(admin, {
    actor,
    origin:
      actor === "automation"
        ? { surface: "automation", automationId: "aut_test", runId: unique("run") }
        : actor === "human"
          ? { surface: "ui" }
          : { surface, sessionId: `cap_${unique("s")}` },
    reason: "Testing the dry run",
    ...extra,
  });
}

const cases: {
  actor: Actor;
  tool: "wipe" | "rename" | "renameAll";
  preset: "cautious" | "balanced" | "autonomous";
  floor?: string;
}[] = [
  { actor: "assistant", tool: "wipe", preset: "balanced" },
  { actor: "mcp", tool: "wipe", preset: "balanced" },
  { actor: "automation", tool: "wipe", preset: "balanced" },
  { actor: "assistant", tool: "rename", preset: "cautious" },
  { actor: "mcp", tool: "rename", preset: "cautious" },
  { actor: "mcp", tool: "renameAll", preset: "balanced" },
  { actor: "automation", tool: "renameAll", preset: "cautious" },
  { actor: "mcp", tool: "wipe", preset: "autonomous", floor: '{"*":{"destructive":"review"}}' },
  { actor: "human", tool: "wipe", preset: "balanced", floor: '{"*":{"destructive":"review"}}' },
];

describe("a queued extension tool", () => {
  it.each(cases)(
    "$actor calling $tool under $preset (floor $floor): nothing runs before approval",
    async ({ actor, tool: name, preset, floor }) => {
      await setPreset(preset);
      try {
        const itemId = await newItem();
        const queued = await invokeByName(
          `x.${id}.${name}`,
          { id: itemId, name: "After" },
          as(actor, floor ? { floor: parseFloor(floor) } : {}),
        ).catch((error: unknown) => error);
        expect(queued).toMatchObject({ code: "pending_approval" });
        const actionId = (queued as { details: { actionId: string } }).details.actionId;

        // Nothing changed: not the record, not the tool's storage, no write by the extension.
        expect(await nameOf(itemId)).toBe("Before");
        expect(await ran(itemId)).toBeNull();
        expect(await extensionWrites(itemId)).toBe(0);
        const pending = await env.DB.prepare(
          "SELECT operation, status, input FROM core_pending_action WHERE id = ?",
        )
          .bind(actionId)
          .first<{ operation: string; status: string; input: string }>();
        expect(pending).toMatchObject({ operation: `x.${id}.${name}`, status: "pending" });
        expect(JSON.parse(pending?.input ?? "{}")).toEqual({ id: itemId, name: "After" });

        // The caller is told the tool has not run.
        expect((queued as { message: string }).message).toContain("The tool has not run");

        // Approved: the tool runs once, as the extension.
        await setPreset("balanced");
        const decision = await call<{ results: { status: string }[] }>(admin, "approval.approve", {
          actionIds: [actionId],
        }).catch((error: unknown) => error);
        // A destructive tool needs the second step, which names the tool.
        const step = decision as { code?: string; details?: { confirmLabel?: string } };
        if (name === "wipe") {
          expect(step).toMatchObject({
            code: "second_step_required",
            details: { confirmLabel: `Confirm: wipe (${id} tool)` },
          });
        }
        const result =
          step.code === "second_step_required"
            ? await call<{ results: { status: string }[] }>(admin, "approval.approve", {
                actionIds: [actionId],
                confirm: step.details?.confirmLabel,
              })
            : (decision as { results: { status: string }[] });
        expect(result.results.map((r) => r.status)).toEqual(["applied"]);
        expect(await nameOf(itemId)).toBe("After");
        expect(await ran(itemId)).toBe(name);
        expect(await extensionWrites(itemId)).toBe(1);
      } finally {
        await setPreset("balanced");
      }
    },
  );

  it("is not run in an automation's test mode either", async () => {
    const itemId = await newItem();
    const simulate = createTestSimulation();
    await invokeByName(
      `x.${id}.rename`,
      { id: itemId, name: "After" },
      as("automation", { simulate }),
    );
    expect(simulate.gates.map((g) => g.operation)).toEqual([`x.${id}.rename`]);
    expect(await nameOf(itemId)).toBe("Before");
    expect(await ran(itemId)).toBeNull();
    expect(await extensionWrites(itemId)).toBe(0);
  });

  it("still runs at once where the gate says auto", async () => {
    const itemId = await newItem();
    await expect(
      invokeByName(`x.${id}.rename`, { id: itemId, name: "After" }, as("assistant")),
    ).resolves.toEqual({ name: "After" });
    expect(await nameOf(itemId)).toBe("After");
    expect(await ran(itemId)).toBe("rename");
  });
});
