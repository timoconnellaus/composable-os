// The test host holds what the host holds of the Trash and a hold (ADRs 0863 and 0865, the review
// of PR #502), so a pack's own tests refuse where the host would: a record in a state only tools
// leave goes in the Trash only from inside a leaving tool; a record an open one holds likewise;
// and the relation a guarded record holds by is never re-pointed, the pack's own code included.
import { describe, expect, it } from "vitest";
import { defineExtension, defineTool, toManifest, validateManifest, z } from "../src/index.ts";
import { createTestHost } from "../src/testing.ts";

const ids = z.object({ id: z.string() });
const done = z.object({ ok: z.boolean() });

const extension = defineExtension({
  id: "kit",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { modules: ["ops"] },
  objects: {
    thing: {
      label: "Thing",
      plural: "Things",
      titleField: "name",
      fields: { name: { type: "text", label: "Name", required: true } },
    },
    note: {
      label: "Note",
      plural: "Notes",
      titleField: "text",
      fields: {
        text: { type: "text", label: "Text" },
        thing: { type: "relation", label: "Thing", to: "kit.thing", readOnly: true },
        state: {
          type: "select",
          label: "State",
          default: "open",
          options: [
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "open",
        holds: "thing",
        moves: [{ from: "open", to: "closed", by: ["host"], tools: ["close"], final: true }],
      },
    },
  },
  tools: {
    dropThing: defineTool({
      description: "Puts a thing in the Trash.",
      input: ids,
      output: done,
      async handler(input, ctx) {
        await ctx.ops.call("record.delete", { object: "kit.thing", id: input.id });
        return { ok: true };
      },
    }),
    dropNote: defineTool({
      description: "Puts a note in the Trash.",
      input: ids,
      output: done,
      async handler(input, ctx) {
        await ctx.ops.call("record.delete", { object: "kit.note", id: input.id });
        return { ok: true };
      },
    }),
    repoint: defineTool({
      description: "Points a note at another thing.",
      input: ids.extend({ to: z.string() }),
      output: done,
      async handler(input, ctx) {
        await ctx.ops.call("record.update", {
          object: "kit.note",
          id: input.id,
          values: { thing: input.to },
        });
        return { ok: true };
      },
    }),
    close: defineTool({
      description: "Closes a note and puts its thing in the Trash.",
      input: ids,
      output: done,
      permission: "kit:manage",
      humanOnly: true,
      async handler(input, ctx) {
        await ctx.ops.call("record.delete", { object: "kit.note", id: input.id });
        return { ok: true };
      },
    }),
  },
});

const host = () =>
  createTestHost(extension, {
    records: {
      "kit.thing": [
        { id: "t1", name: "One" },
        { id: "t2", name: "Two" },
      ],
      "kit.note": [{ id: "n1", text: "Broken", thing: "t1", state: "open" }],
    },
  });

describe("the test host's Trash and holds", () => {
  it("declares the hold the contract accepts", () => {
    expect(host().issues).toEqual([]);
  });

  it("refuses a held record's Trash, and a guarded one's, but from inside a leaving tool", async () => {
    const h = host();
    await expect(h.runTool("dropThing", { id: "t1" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.runTool("dropNote", { id: "n1" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await h.runTool("dropThing", { id: "t2" })).toEqual({ ok: true });
    expect(await h.runTool("close", { id: "n1" })).toEqual({ ok: true });
    expect(await h.runTool("dropThing", { id: "t1" })).toEqual({ ok: true });
  });

  it("never re-points the hold while it is guarded, the pack's own code included", async () => {
    await expect(host().runTool("repoint", { id: "n1", to: "t2" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("the contract refuses a hold by a relation anyone may write", () => {
    const manifest = toManifest(extension) as unknown as {
      objects: { note: { fields: { thing: { readOnly?: boolean } } } };
    };
    expect(validateManifest(manifest).issues.filter((i) => i.path.includes("holds"))).toEqual([]);
    manifest.objects.note.fields.thing.readOnly = false;
    expect(
      validateManifest(manifest)
        .issues.filter((i) => i.path.includes("holds"))
        .map((i) => i.path),
    ).toEqual(["objects.note.states.holds"]);
  });
});
