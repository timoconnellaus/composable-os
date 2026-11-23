// Who stands behind what a tool or an automation writes (ADR 0590, the third and fourth reviews),
// as the marks the host keeps: a runtime extension's tool (authored in the app) writes as an AI
// even when a person clicks it, the values the person typed included (a shipped pack's tool writes
// as the host, the person's own values theirs: Bookings' bookFor, in routine-mail-reads.test.ts);
// a run that used a model, or read
// outside text through a gatekeeper, writes as an AI from then on, not even the person's values
// kept; what a run reads back from its storage is never a person's; an automation authored in the
// app writes as an AI, so mail it causes is held. A field default taken from an extension setting
// is the host's unless the setting is one a person approves.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type ActingUser, invokeByName } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { runRow } from "./automation-fixture.ts";
import { context, createAdmin, install, unique } from "./helpers.ts";

const EXT = unique("stand").slice(0, 20).toLowerCase();
const ITEM = `${EXT}.item`;

const FILES: Record<string, string> = {
  "index.ts": `import { defineAutomation, defineExtension, defineTool, z } from "@composable-os/sdk";

export default defineExtension({
  id: "${EXT}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Standing tests",
  permissions: { modules: ["ops", "ai", "storage", "fake"] },
  settings: {
    defaultKind: { type: "text", label: "Default kind" },
    defaultRoom: { type: "text", label: "Default room", personApproves: true },
  },
  objects: {
    item: {
      label: "Item",
      plural: "Items",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        note: { type: "text", label: "Note" },
        kind: { type: "text", label: "Kind", defaultSetting: "defaultKind" },
        room: { type: "text", label: "Room", defaultSetting: "defaultRoom" },
      },
    },
  },
  tools: {
    remember: defineTool({
      description: "Keeps a name for later.",
      risk: "write",
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
      async handler({ name }, ctx) {
        await ctx.storage.set("name", name);
        return { ok: true };
      },
    }),
    recall: defineTool({
      description: "Makes an item named as kept earlier.",
      risk: "write",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      async handler(_input, ctx) {
        const name = String((await ctx.storage.get("name")) ?? "Nothing kept");
        const out = await ctx.ops.call<{ id: string }>("record.create", {
          object: "${ITEM}",
          values: { name },
        });
        return { id: out.id };
      },
    }),
    fetched: defineTool({
      description: "Reads through a gatekeeper, then makes an item named as given.",
      risk: "write",
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      async handler({ name }, ctx) {
        try {
          await ctx.gatekeeper("fake").call("none", "OUTBOX", "list", {});
        } catch {}
        const out = await ctx.ops.call<{ id: string }>("record.create", {
          object: "${ITEM}",
          values: { name },
        });
        return { id: out.id };
      },
    }),
    copyTo: defineTool({
      description: "Writes what the person typed into another item.",
      risk: "write",
      input: z.object({ id: z.string(), note: z.string() }),
      output: z.object({ ok: z.boolean() }),
      async handler({ id, note }, ctx) {
        await ctx.ops.call("record.update", { object: "${ITEM}", id, values: { note } });
        return { ok: true };
      },
    }),
    make: defineTool({
      description: "Makes an item named as given, with a note of its own.",
      risk: "write",
      input: z.object({ name: z.string(), useModel: z.boolean().optional() }),
      output: z.object({ id: z.string() }),
      async handler({ name, useModel }, ctx) {
        if (useModel) {
          try {
            await ctx.ai.summarise("Something to summarise");
          } catch {}
        }
        const out = await ctx.ops.call<{ id: string }>("record.create", {
          object: "${ITEM}",
          values: { name, note: "Written by the tool" },
        });
        return { id: out.id };
      },
    }),
  },
  automations: {
    stamp: defineAutomation({
      label: "Stamp",
      description: "Makes an item when run by hand.",
      trigger: { type: "manual", object: "${ITEM}", label: "Stamp" },
      steps: [{ name: "make", writes: [{ object: "${ITEM}" }] }],
      async run(_event, step, ctx) {
        return step.do("make", () =>
          ctx.ops.call("record.create", { object: "${ITEM}", values: { name: "Stamped" } }),
        );
      },
    }),
  },
});
`,
};

let admin: ActingUser;
const op = <T>(name: string, input: unknown) =>
  invokeByName(name, input, context(admin)) as Promise<T>;
const markOf = async (id: string, field: string) =>
  (
    await env.DB.prepare(
      "SELECT standing FROM core_value_mark WHERE object_type = ? AND record_id = ? AND field = ?",
    )
      .bind(ITEM, id, field)
      .first<{ standing: string }>()
  )?.standing ?? null;

beforeAll(async () => {
  admin = await createAdmin();
  await install(admin, EXT, FILES);
  await op("extensionSettings.update", {
    extension: EXT,
    values: { defaultKind: "Big", defaultRoom: "Hall" },
  });
}, 120_000);

describe("a runtime extension's tool a person runs (the fourth review, M1)", {
  timeout: 60_000,
}, () => {
  it("writes as an AI, the values the person typed too (the fifth review)", async () => {
    const name = unique("Given");
    const { id } = await op<{ id: string }>(`x.${EXT}.make`, { name });
    expect(await markOf(id, "name")).toBe("ai");
    expect(await markOf(id, "note")).toBe("ai");
    expect(await markOf(id, "$created")).toBe("ai");
  });

  it("the person's typed value written into another record is an AI's too", async () => {
    const other = await op<{ id: string }>("record.create", {
      object: ITEM,
      values: { name: unique("Other") },
    });
    const typed = unique("Typed");
    await op(`x.${EXT}.copyTo`, { id: other.id, note: typed });
    expect(await markOf(other.id, "note")).toBe("ai");
  });

  it("writes as an AI after reading through a gatekeeper, the person's values too (L2)", async () => {
    const { id } = await op<{ id: string }>(`x.${EXT}.fetched`, { name: unique("Fetched") });
    expect(await markOf(id, "name")).toBe("ai");
  });

  it("a value read back from its storage is never a person's (L2)", async () => {
    await op(`x.${EXT}.remember`, { name: unique("Kept") });
    const { id } = await op<{ id: string }>(`x.${EXT}.recall`, {});
    expect(await markOf(id, "name")).toBe("ai");
  });

  it("writes as an AI once the run used a model", async () => {
    const { id } = await op<{ id: string }>(`x.${EXT}.make`, {
      name: unique("Modelled"),
      useModel: true,
    });
    expect(await markOf(id, "name")).toBe("ai");
    expect(await markOf(id, "note")).toBe("ai");
    expect(await markOf(id, "$created")).toBe("ai");
  });
});

describe("a field default from a setting (the third review, 6a)", { timeout: 60_000 }, () => {
  it("is the host's, unless the setting is one a person approves", async () => {
    const { id } = await op<{ id: string }>("record.create", {
      object: ITEM,
      values: { name: unique("Defaulted") },
    });
    expect(await markOf(id, "name")).toBe("person");
    expect(await markOf(id, "kind")).toBe("host");
    expect(await markOf(id, "room")).toBe("default");
  });
});

describe("an automation authored in the app (the third review, 5)", { timeout: 90_000 }, () => {
  it("writes as an AI: what it makes is never routine", async () => {
    await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    try {
      await op("automation.enable", { id: `${EXT}.stamp` });
    } catch {}
    const item = await op<{ id: string }>("record.create", {
      object: ITEM,
      values: { name: unique("Seed") },
    });
    const { runIds } = await op<{ runIds: string[] }>("automation.run", {
      id: `${EXT}.stamp`,
      object: ITEM,
      recordIds: [item.id],
    });
    const [instance] = await introspector.get();
    await instance?.waitForStatus("complete");
    expect((await runRow(runIds[0] as string)).status).toBe("completed");
    const made = await env.DB.prepare(
      "SELECT record_id FROM core_value_mark WHERE object_type = ? AND field = 'name' AND record_id <> ? ORDER BY at DESC LIMIT 1",
    )
      .bind(ITEM, item.id)
      .first<{ record_id: string }>();
    expect(made).toBeTruthy();
    expect(await markOf(made?.record_id as string, "$created")).toBe("ai");
    expect(await markOf(made?.record_id as string, "name")).toBe("ai");
  });
});
