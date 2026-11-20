// Stage 25, acceptance criterion 1, in the sandbox: an extension written on the public contract
// declares a state machine, `extension.check` reports a bad declaration, and the extension's own
// code, calling through codemode:ops, is held to the moves like any other caller. It cannot make
// a `host` move on its own object.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { auditFor, call, createAdmin, install, source, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
const id = unique("shop").slice(0, 20);

const object = (moves: string) => `objects: {
    order: {
      label: "Order", plural: "Orders", titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        state: { type: "select", label: "State", track: "timeline", options: [
          { value: "pending", label: "Pending" },
          { value: "paid", label: "Paid" },
          { value: "cancelled", label: "Cancelled" },
        ] },
        reference: { type: "text", label: "Reference", readOnly: true },
      },
      states: { field: "state", initial: "pending", moves: ${moves} },
    },
  },`;

const MOVES = `[
        { from: "pending", to: "paid", by: ["host"], requires: ["reference"] },
        { from: "pending", to: "cancelled", by: ["staff", "customer"], final: true },
      ]`;

beforeAll(async () => {
  admin = await createAdmin();
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["ops"] },
  ${object(MOVES)}
  tools: {
    move: defineTool({
      description: "Moves an order of this extension to a state, as the extension's own code.",
      input: z.object({ id: z.string(), state: z.string() }),
      output: z.unknown(),
      handler: async ({ id, state }, ctx) => {
        try {
          const out = await ctx.ops.call<{ values: { state: string } }>("record.update", {
            object: "${id}.order", id,
            values: { state, ...(state === "paid" ? { reference: "pay_self" } : {}) },
          });
          return { state: out.values.state };
        } catch (error) {
          const e = error as { code?: string; details?: unknown };
          return { refused: e.code, details: e.details };
        }
      },
    }),
  },`,
    ),
  );
});

describe("states for a sandboxed extension", () => {
  it("extension.check reports a bad states declaration", async () => {
    const bad = unique("badst").slice(0, 20);
    await call(admin, "extension.write", {
      id: bad,
      files: source(
        bad,
        object(`[
        { from: "pending", to: "shipped", by: ["staff"] },
        { from: "cancelled", to: "pending", by: ["staff"] },
        { from: "pending", to: "cancelled", by: ["staff"], final: true },
      ]`),
      ),
    });
    const check = await call<{
      ok: boolean;
      issues: { stage: string; path: string; message: string }[];
    }>(admin, "extension.check", { id: bad });
    expect(check.ok).toBe(false);
    expect(
      check.issues.filter((i) => i.stage === "contract").map((i) => `${i.path}: ${i.message}`),
    ).toEqual([
      'objects.order.states.moves.0.to: "shipped" is not an option of state',
      'objects.order.states.moves.1.from: "cancelled" is final: nothing moves out of it',
    ]);
  });

  it("shows the declaration in schema.objects", async () => {
    const { objects } = await call<{
      objects: { name: string; states: { initial: string; moves: unknown[] } | null }[];
    }>(admin, "schema.objects", {});
    expect(objects.find((o) => o.name === `${id}.order`)?.states).toMatchObject({
      field: "state",
      initial: "pending",
      moves: [{ to: "paid", by: ["host"] }, { to: "cancelled" }],
    });
  });

  it("refuses the extension's own code a host move, and lets it make a staff move", async () => {
    const order = await call<{ id: string }>(admin, "record.create", {
      object: `${id}.order`,
      values: { name: "First" },
    });
    expect(await call(admin, `x.${id}.move`, { id: order.id, state: "paid" })).toEqual({
      refused: "invalid_input",
      details: {
        rule: "state_move_not_permitted",
        object: `${id}.order`,
        field: "state",
        fields: ["state"],
        labels: ["State"],
        state: { id: "paid", title: "Paid", final: false },
        from: { id: "pending", title: "Pending", final: false },
        by: ["host"],
      },
    });
    const refused = await auditFor("record.update", `extension:${id}`);
    expect(refused.at(-1)).toMatchObject({ actor: "extension", outcome: "error" });
    const history = () =>
      env.DB.prepare(
        "SELECT state, is_final, is_current, entered_as FROM rec_state_history WHERE record_id = ? ORDER BY entered_at, is_current",
      )
        .bind(order.id)
        .all()
        .then((r) => r.results);
    expect(await history()).toEqual([
      { state: "pending", is_final: 0, is_current: 1, entered_as: "staff" },
    ]);

    expect(await call(admin, `x.${id}.move`, { id: order.id, state: "cancelled" })).toEqual({
      state: "cancelled",
    });
    expect(await history()).toEqual([
      { state: "pending", is_final: 0, is_current: 0, entered_as: "staff" },
      { state: "cancelled", is_final: 1, is_current: 1, entered_as: "staff" },
    ]);
  });
});
