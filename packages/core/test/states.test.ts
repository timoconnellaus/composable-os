// Stage 25, acceptance criterion 1: the `states` behaviour on the transition engine (ADR 0425),
// against a fixture object with an order-like state machine. An undeclared move, a move missing a
// required field and a `host` move by a person, an MCP client, an extension and an import are
// each refused with the specified details; allowed moves write history in the same batch; the
// approval queue's dry run reports a refusal without writing. (The sandboxed extension's attempt
// is in apps/runner/test/states.test.ts.)
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  applyTransition,
  defineOperation,
  getObject,
  type InvocationContext,
  invokeByName,
  invokeOperation,
  PendingApprovalError,
  updateRecordAsHost,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, setPreset, timeline, unique } from "./helpers.ts";

const ext = extId("st");
const ORDER = `${ext}.order`;

const STATES = {
  field: "state",
  initial: "pending",
  moves: [
    { from: "pending", to: "paid", by: ["host"], requires: ["reference"] },
    { from: "pending", to: "review", by: ["staff"] },
    { from: "review", to: "pending", by: ["staff"] },
    {
      from: ["pending", "review"],
      to: "cancelled",
      by: ["staff", "customer"],
      requires: ["cancelReason"],
      final: true,
    },
    { from: "pending", to: "expired", by: ["host"], final: true },
    { from: "paid", to: "disputed", by: ["customer"] },
    { from: ["paid", "disputed"], to: "refunded", by: ["host"], final: true },
  ],
} as const;

const OBJECTS = {
  order: {
    label: "Order",
    plural: "Orders",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      state: {
        type: "select",
        label: "State",
        track: "timeline",
        options: [
          { value: "pending", label: "Pending" },
          { value: "review", label: "In review" },
          { value: "paid", label: "Paid" },
          { value: "disputed", label: "Disputed" },
          { value: "cancelled", label: "Cancelled" },
          { value: "expired", label: "Expired" },
          { value: "refunded", label: "Refunded" },
        ],
      },
      reference: { type: "text", label: "Payment reference", readOnly: true },
      cancelReason: { type: "text", label: "Cancel reason" },
      note: { type: "text", label: "Note" },
    },
    states: STATES,
  },
} as const;

/** A stage-driven object beside it (ADR 0100), to show both forms on the one engine. */
const STAGED = {
  step: {
    label: "Step",
    plural: "Steps",
    titleField: "name",
    navigation: "settings",
    fields: {
      name: { type: "text", label: "Name", required: true },
      type: {
        type: "select",
        label: "Type",
        options: [
          { value: "open", label: "Open" },
          { value: "won", label: "Won" },
          { value: "lost", label: "Lost" },
        ],
      },
      position: { type: "number", label: "Position" },
      needs: {
        type: "multiSelect",
        label: "Needs",
        options: [{ value: "summary", label: "Summary" }],
      },
    },
  },
  job: {
    label: "Job",
    plural: "Jobs",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name", required: true },
      step: { type: "relation", label: "Step", to: `${ext}.step`, track: "timeline" },
      summary: { type: "text", label: "Summary" },
    },
    stages: { field: "step", stage: { type: "type", order: "position", requiredFields: "needs" } },
  },
} as const;

/** The fixture manifest, with the order object changed by `patch`. */
function fixture(patch: (order: Record<string, unknown>) => Record<string, unknown> = (o) => o) {
  return manifest(ext, {
    objects: {
      order: patch(structuredClone(OBJECTS.order) as Record<string, unknown>),
      ...structuredClone(STAGED),
    },
  } as never);
}

interface Order {
  id: string;
  values: Record<string, unknown>;
}

let admin: ActingUser;
let member: ActingUser;

const human = (overrides: Partial<InvocationContext> = {}) => context(member, overrides);
const mcp = (sessionId = `cap_${unique()}`) =>
  context(member, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "client-1", clientName: "Test client", sessionId },
    reason: "Test reason",
  });

function create(values: Record<string, unknown> = {}, ctx = human()) {
  return invokeByName(
    "record.create",
    { object: ORDER, values: { name: unique("Order"), ...values } },
    ctx,
  ) as Promise<Order>;
}

function update(id: string, values: Record<string, unknown>, ctx = human()) {
  return invokeByName("record.update", { object: ORDER, id, values }, ctx) as Promise<Order>;
}

async function history(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT form, stage_id, group_id, stage_type, entered_at, left_at, entered_by, entered_as FROM core_stage_history WHERE object_type = ? AND record_id = ? ORDER BY entered_at, left_at IS NULL",
  )
    .bind(ORDER, id)
    .all<Record<string, unknown>>();
  return results;
}

const states = async (id: string) => (await history(id)).map((row) => row.stage_id);

async function stored(id: string) {
  return ((await invokeByName("record.get", { object: ORDER, id }, human())) as Order).values.state;
}

async function refusal(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string; details?: Record<string, unknown> } | null;
  expect(error, "the write should be refused").not.toBeNull();
  return { code: error?.code, message: error?.message, details: error?.details };
}

/**
 * Platform code: an operation of the host's own that has established a payment and makes the
 * `host` move. It is not in the registry, so no caller can reach it; the second half of stage 25
 * registers the real ones (a verified webhook's handler).
 */
const confirmPayment = defineOperation({
  name: "fixture.confirmPayment",
  description: "Test fixture: marks an order paid as the host, as a verified webhook would.",
  input: z.object({ id: z.string(), reference: z.string().nullable(), state: z.string() }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, ORDER, input.id, {
      state: input.state,
      ...(input.reference ? { reference: input.reference } : {}),
    });
    return { id: input.id };
  },
});

function asHost(id: string, state: string, reference: string | null = null, at?: string) {
  return invokeOperation(
    confirmPayment,
    { id, state, reference },
    context(admin, {
      actor: "automation",
      origin: { surface: "system", automationId: "payments.webhook" },
      ...(at ? { clock: () => new Date(at) } : {}),
    }),
  );
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(fixture());
});

beforeEach(async () => {
  await setPreset("autonomous");
});

describe("a states declaration in the contract checks", () => {
  const issues = (patch: Parameters<typeof fixture>[0]) =>
    validateManifest(fixture(patch)).issues.map((issue) => `${issue.path}: ${issue.message}`);
  const withStates = (change: Record<string, unknown>) => (order: Record<string, unknown>) => ({
    ...order,
    states: { ...STATES, ...change },
  });

  it("accepts the fixture", () => {
    expect(validateManifest(fixture()).issues).toEqual([]);
  });

  it("reports a state field that is not a writable, fixed select", () => {
    expect(issues(withStates({ field: "note" }))).toEqual([
      'objects.order.states.field: "note" must be a select field of order',
    ]);
    expect(
      issues((order) => {
        const fields = order.fields as Record<string, Record<string, unknown>>;
        fields.state = { ...fields.state, readOnly: true, editableOptions: true };
        return order;
      }),
    ).toEqual([
      "objects.order.states.field: The state field cannot be read-only: the moves say who may change it",
      "objects.order.states.field: The state field cannot have editableOptions: states are fixed in the declaration",
    ]);
  });

  it("reports states that are not options, and a default that is not the initial state", () => {
    expect(
      issues(
        withStates({
          initial: "new",
          moves: [{ from: ["pending", "lost"], to: "shipped", by: ["staff"] }],
        }),
      ),
    ).toEqual([
      'objects.order.states.initial: "new" is not an option of state',
      'objects.order.states.moves.0.to: "shipped" is not an option of state',
      'objects.order.states.moves.0.from: "lost" is not an option of state',
    ]);
    expect(
      issues((order) => {
        const fields = order.fields as Record<string, Record<string, unknown>>;
        fields.state = { ...fields.state, default: "paid" };
        return order;
      }),
    ).toEqual([
      'objects.order.states.initial: state\'s default must be the initial state "pending", or be left out',
    ]);
  });

  it("reports moves that contradict each other", () => {
    expect(
      issues(
        withStates({
          moves: [
            { from: "pending", to: "paid", by: ["host"] },
            { from: "pending", to: "paid", by: ["staff"] },
            { from: "paid", to: "paid", by: ["staff"] },
            { from: "pending", to: "cancelled", by: ["staff"], final: true },
            { from: "paid", to: "cancelled", by: ["staff"] },
            { from: "cancelled", to: "review", by: ["staff"] },
            { from: "review", to: "pending", by: ["staff", "staff"] },
          ],
        }),
      ),
    ).toEqual([
      'objects.order.states.moves.1: The move from "pending" to "paid" is declared twice',
      'objects.order.states.moves.2.from: A move cannot go from "paid" to itself',
      'objects.order.states.moves.4.final: Another move into "cancelled" is final; every move into a state must agree',
      'objects.order.states.moves.5.from: "cancelled" is final: nothing moves out of it',
      "objects.order.states.moves.6.by: List each mover once",
    ]);
    expect(
      issues(
        withStates({ moves: [{ from: "review", to: "pending", by: ["staff"], final: true }] }),
      ),
    ).toEqual(["objects.order.states.moves.0.final: The initial state cannot be final"]);
  });

  it("reports required fields a move cannot have, and an unknown mover", () => {
    expect(
      issues(
        withStates({
          moves: [
            { from: "pending", to: "paid", by: ["host"], requires: ["reference", "state", "gone"] },
            { from: "pending", to: "review", by: ["staff", "host"], requires: ["reference"] },
          ],
        }),
      ),
    ).toEqual([
      'objects.order.states.moves.0.requires: "state" must be a field of order other than a formula or the state field',
      'objects.order.states.moves.0.requires: "gone" must be a field of order other than a formula or the state field',
      'objects.order.states.moves.1.requires: "reference" is read-only, so only a move made by the host alone can require it',
    ]);
    const unknown = validateManifest({
      ...fixture(),
      objects: {
        order: {
          ...fixture().objects.order,
          states: { ...STATES, moves: [{ from: "pending", to: "paid", by: ["extension"] }] },
        },
      },
    } as never).issues;
    expect(unknown.map((issue) => issue.path)).toEqual(["objects.order.states.moves.0.by.0"]);
  });

  it("refuses an object that declares both stages and states", () => {
    expect(
      issues((order) => ({
        ...order,
        stages: { field: "state", stage: { type: "type", order: "position" } },
      })),
    ).toContain(
      "objects.order.states: An object has one lifecycle: declare stages or states, not both",
    );
  });
});

describe("states on the transition engine", () => {
  it("starts a record in the initial state and writes its history in the create's batch", async () => {
    const at = "2026-03-01T09:00:00.000Z";
    const order = await create({}, human({ clock: () => new Date(at) }));
    expect(order.values.state).toBe("pending");
    expect(await history(order.id)).toEqual([
      {
        form: "states",
        stage_id: "pending",
        group_id: null,
        stage_type: "open",
        entered_at: at,
        left_at: null,
        entered_by: member.id,
        entered_as: "staff",
      },
    ]);
    const { results } = await env.DB.prepare(
      "SELECT state, is_final, is_current, entered_as FROM rec_state_history WHERE record_id = ?",
    )
      .bind(order.id)
      .all();
    expect(results).toEqual([
      { state: "pending", is_final: 0, is_current: 1, entered_as: "staff" },
    ]);
    // Not in the stage view.
    const stage = await env.DB.prepare(
      "SELECT count(*) AS n FROM rec_stage_history WHERE record_id = ?",
    )
      .bind(order.id)
      .first<{ n: number }>();
    expect(stage?.n).toBe(0);
  });

  it("makes an allowed move: history closes and opens in the write's batch, and the timeline says so", async () => {
    const order = await create({}, human({ clock: () => new Date("2026-03-01T09:00:00.000Z") }));
    const at = "2026-03-03T09:00:00.000Z";
    const moved = await update(order.id, { state: "review" }, human({ clock: () => new Date(at) }));
    expect(moved.values.state).toBe("review");
    expect(
      (await history(order.id)).map((r) => [r.stage_id, r.entered_at, r.left_at, r.entered_as]),
    ).toEqual([
      ["pending", "2026-03-01T09:00:00.000Z", at, "staff"],
      ["review", at, null, "staff"],
    ]);
    const posts = await timeline(ORDER, order.id);
    expect(posts.map((p) => p.subject)).toEqual(["Moved to In review"]);
    expect(posts[0]?.payload).toMatchObject({
      kind: "field_change",
      changes: [
        {
          field: "state",
          before: "pending",
          after: "review",
          beforeLabel: "Pending",
          afterLabel: "In review",
        },
      ],
    });
    // The move, its history and its post are one audited batch.
    const audit = await env.DB.prepare(
      "SELECT a.outcome, a.at FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id WHERE c.record_id = ? ORDER BY a.at DESC LIMIT 1",
    )
      .bind(order.id)
      .first<{ outcome: string; at: string }>();
    expect(audit).toEqual({ outcome: "ok", at });
  });

  it("refuses a move that is not declared, naming the rule, the state and the field", async () => {
    const order = await create();
    expect(await refusal(update(order.id, { state: "refunded" }))).toEqual({
      code: "invalid_input",
      message: "Order cannot move from Pending to Refunded",
      details: {
        rule: "state_move_not_declared",
        object: ORDER,
        field: "state",
        fields: ["state"],
        labels: ["State"],
        state: { id: "refunded", title: "Refunded", final: true },
        from: { id: "pending", title: "Pending", final: false },
        allowed: ["paid", "review", "cancelled", "expired"],
      },
    });
    expect(await stored(order.id)).toBe("pending");
    expect(await states(order.id)).toEqual(["pending"]);
  });

  it("refuses a move missing a required field, naming the first missing field", async () => {
    const order = await create();
    expect(await refusal(update(order.id, { state: "cancelled" }))).toEqual({
      code: "invalid_input",
      message: "Cancelled needs Cancel reason",
      details: {
        rule: "state_required_fields",
        object: ORDER,
        field: "cancelReason",
        fields: ["cancelReason"],
        labels: ["Cancel reason"],
        state: { id: "cancelled", title: "Cancelled", final: true },
        from: { id: "pending", title: "Pending", final: false },
      },
    });
    expect(await states(order.id)).toEqual(["pending"]);

    const cancelled = await update(order.id, { state: "cancelled", cancelReason: "Changed mind" });
    expect(cancelled.values.state).toBe("cancelled");
    expect((await history(order.id)).map((r) => [r.stage_id, r.stage_type])).toEqual([
      ["pending", "open"],
      ["cancelled", "final"],
    ]);
    // While it is cancelled the reason cannot be emptied, and other fields can change.
    expect((await refusal(update(order.id, { cancelReason: null }))).details).toMatchObject({
      rule: "state_required_fields",
      field: "cancelReason",
      state: { id: "cancelled" },
    });
    await update(order.id, { note: "Called the customer" });
    expect(await states(order.id)).toEqual(["pending", "cancelled"]);
  });

  it("refuses any move out of a final state, and leaving a record without a state", async () => {
    const order = await create();
    await update(order.id, { state: "cancelled", cancelReason: "Duplicate" });
    expect(await refusal(update(order.id, { state: "pending" }))).toMatchObject({
      code: "invalid_input",
      message: "Order is Cancelled, which is final: it cannot move to Pending",
      details: {
        rule: "state_final",
        field: "state",
        state: { id: "pending", title: "Pending", final: false },
        from: { id: "cancelled", title: "Cancelled", final: true },
        allowed: [],
      },
    });
    expect((await refusal(update(order.id, { state: null }))).details).toMatchObject({
      rule: "no_state",
      field: "state",
      state: null,
      from: { id: "cancelled" },
    });
    expect(await states(order.id)).toEqual(["pending", "cancelled"]);
  });

  it("judges a create in another state as the move from the initial state", async () => {
    const direct = await create({ state: "cancelled", cancelReason: "Entered late" });
    expect(await history(direct.id)).toMatchObject([
      { stage_id: "cancelled", stage_type: "final", left_at: null },
    ]);
    expect((await refusal(create({ state: "cancelled" }))).details).toMatchObject({
      rule: "state_required_fields",
      field: "cancelReason",
    });
    expect((await refusal(create({ state: "refunded" }))).details).toMatchObject({
      rule: "state_move_not_declared",
      from: { id: "pending" },
    });
  });

  it("does not let staff make a move declared for customers only", async () => {
    // Nothing can act as a customer until stage 22 lands, so a customer-only move has no caller
    // yet: every caller of an operation is staff, and staff are not on its list.
    const order = await create();
    await asHost(order.id, "paid", "pay_1");
    expect(await refusal(update(order.id, { state: "disputed" }))).toEqual({
      code: "invalid_input",
      message: "Only customer can move order to Disputed",
      details: {
        rule: "state_move_not_permitted",
        object: ORDER,
        field: "state",
        fields: ["state"],
        labels: ["State"],
        state: { id: "disputed", title: "Disputed", final: false },
        from: { id: "paid", title: "Paid", final: false },
        by: ["customer"],
      },
    });
    expect(await states(order.id)).toEqual(["pending", "paid"]);
  });
});

describe("a host move", () => {
  const HOST_ONLY = {
    rule: "state_move_not_permitted",
    field: "state",
    fields: ["state"],
    labels: ["State"],
    state: { id: "paid", title: "Paid", final: false },
    from: { id: "pending", title: "Pending", final: false },
    by: ["host"],
  };

  it("is refused to a person", async () => {
    const order = await create();
    for (const ctx of [human(), context(admin)]) {
      expect(await refusal(update(order.id, { state: "paid" }, ctx))).toEqual({
        code: "invalid_input",
        message: "Order becomes Paid when the platform confirms it; it cannot be set",
        details: { ...HOST_ONLY, object: ORDER },
      });
    }
    // Nor can a person set the read-only field the move requires.
    expect(
      (await refusal(update(order.id, { state: "paid", reference: "pay_forged" }))).message,
    ).toMatch(/is set automatically and cannot be written/);
    expect(await refusal(create({ state: "paid" }))).toMatchObject({ details: HOST_ONLY });
    expect(await states(order.id)).toEqual(["pending"]);
  });

  it("is refused to an MCP client, applied directly or through the approval queue", async () => {
    const order = await create();
    expect(await refusal(update(order.id, { state: "paid" }, mcp()))).toMatchObject({
      code: "invalid_input",
      details: HOST_ONLY,
    });
    expect(await refusal(update(order.id, { state: "expired" }, mcp()))).toMatchObject({
      details: { rule: "state_move_not_permitted", state: { id: "expired" }, by: ["host"] },
    });
    expect(await states(order.id)).toEqual(["pending"]);
  });

  it("is refused to an extension", async () => {
    // The declaring extension's own code may write its read-only fields (ADR 0246), and is
    // still staff to the engine.
    const order = await create();
    const principal = { ...member, id: `extension:${ext}` };
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at, kind, role) VALUES (?, ?, ?, 0, ?, ?, 'extension', 'member')",
    )
      .bind(principal.id, ext, `${ext}@extensions.crm.invalid`, now, now)
      .run();
    const asExtension = context(principal, {
      actor: "extension",
      origin: { surface: "extension", extensionId: ext },
      extension: {
        id: ext,
        permissions: { read: [], write: [], operations: [], modules: ["ops"] },
      },
    });
    expect(
      await refusal(update(order.id, { state: "paid", reference: "pay_own" }, asExtension)),
    ).toMatchObject({ code: "invalid_input", details: HOST_ONLY });
    expect(await states(order.id)).toEqual(["pending"]);
    // It can make a staff move.
    await update(order.id, { state: "review" }, asExtension);
    expect(await states(order.id)).toEqual(["pending", "review"]);
  });

  it("is refused to an import", async () => {
    const name = unique("Imported");
    const csv = `Name,State\n${name} A,pending\n${name} B,Paid\n`;
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_stage_history WHERE object_type = ?",
    )
      .bind(ORDER)
      .first<{ n: number }>();
    expect(
      await refusal(invokeByName("import.records.commit", { object: ORDER, csv }, context(admin))),
    ).toEqual({
      code: "invalid_input",
      message: "Row 2: Order becomes Paid when the platform confirms it; it cannot be set",
      details: { row: 2, ...HOST_ONLY, object: ORDER },
    });
    // One transaction: the good row was not written either.
    const after = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_stage_history WHERE object_type = ?",
    )
      .bind(ORDER)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    const out = (await invokeByName(
      "import.records.commit",
      { object: ORDER, csv, skipInvalid: true },
      context(admin),
    )) as { created: string[]; skipped: { row: number; errors: string[] }[] };
    expect(out.created).toHaveLength(1);
    expect(out.skipped).toEqual([
      { row: 2, errors: ["Order becomes Paid when the platform confirms it; it cannot be set"] },
    ]);
    expect(await history(out.created[0] as string)).toMatchObject([
      { stage_id: "pending", entered_as: "staff" },
    ]);
  });

  it("is made by platform code, with its required field, and recorded as the host's", async () => {
    const order = await create({}, human({ clock: () => new Date("2026-03-01T09:00:00.000Z") }));
    // The host is held to the declaration too.
    expect((await refusal(asHost(order.id, "paid"))).details).toMatchObject({
      rule: "state_required_fields",
      field: "reference",
    });
    expect((await refusal(asHost(order.id, "refunded", "pay_1"))).details).toMatchObject({
      rule: "state_move_not_declared",
    });
    expect((await refusal(asHost(order.id, "review"))).details).toMatchObject({
      rule: "state_move_not_permitted",
      by: ["staff"],
    });
    const at = "2026-03-01T09:10:00.000Z";
    await asHost(order.id, "paid", "pay_123", at);
    const paid = (await invokeByName(
      "record.get",
      { object: ORDER, id: order.id },
      human(),
    )) as Order;
    expect(paid.values).toMatchObject({ state: "paid", reference: "pay_123" });
    expect(
      (await history(order.id)).map((r) => [r.stage_id, r.entered_at, r.left_at, r.entered_as]),
    ).toEqual([
      ["pending", "2026-03-01T09:00:00.000Z", at, "staff"],
      ["paid", at, null, "host"],
    ]);
    expect((await timeline(ORDER, order.id)).map((p) => p.subject)).toEqual(["Moved to Paid"]);
    // Staff cannot empty what the move required, and cannot refund it by hand.
    await update(order.id, { note: "Thanks sent" });
    expect((await refusal(update(order.id, { state: "refunded" }))).details).toMatchObject({
      rule: "state_move_not_permitted",
      by: ["host"],
    });
    await asHost(order.id, "refunded");
    expect(await states(order.id)).toEqual(["pending", "paid", "refunded"]);
  });
});

describe("the approval queue's dry run", () => {
  async function counts(id: string) {
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action WHERE operation = 'record.update' AND input LIKE ?",
    )
      .bind(`%${id}%`)
      .first<{ n: number }>();
    return { pending: pending?.n, history: (await history(id)).length, state: await stored(id) };
  }

  it("reports a refusal without queueing or writing anything", async () => {
    const order = await create();
    await setPreset("cautious");
    for (const [values, rule] of [
      [{ state: "paid" }, "state_move_not_permitted"],
      [{ state: "refunded" }, "state_move_not_declared"],
      [{ state: "cancelled" }, "state_required_fields"],
    ] as const) {
      expect(await refusal(update(order.id, values, mcp()))).toMatchObject({
        code: "invalid_input",
        details: { rule, object: ORDER },
      });
    }
    expect(await counts(order.id)).toEqual({ pending: 0, history: 1, state: "pending" });
  });

  it("queues an allowed move without writing history, and writes it when a person approves", async () => {
    const order = await create();
    await setPreset("cautious");
    const error = await update(order.id, { state: "review" }, mcp()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PendingApprovalError);
    expect(await counts(order.id)).toEqual({ pending: 1, history: 1, state: "pending" });

    const { pending } = error as PendingApprovalError;
    await invokeByName("approval.approve", { changeSetId: pending.changeSetId }, context(admin));
    expect(await stored(order.id)).toBe("review");
    expect((await history(order.id)).map((r) => [r.stage_id, r.entered_as])).toEqual([
      ["pending", "staff"],
      ["review", "staff"],
    ]);
  });
});

describe("stages and states on the one engine", () => {
  it("keeps one history, a view for each form, and the same shape of refusal", async () => {
    const step = async (name: string, position: number, type: string, needs: string[] = []) =>
      (
        (await invokeByName(
          "record.create",
          { object: `${ext}.step`, values: { name, position, type, needs } },
          context(admin),
        )) as Order
      ).id;
    const todo = await step("To do", 1, "open");
    const done = await step("Done", 2, "won", ["summary"]);
    const job = (await invokeByName(
      "record.create",
      { object: `${ext}.job`, values: { name: unique("Job") } },
      human(),
    )) as Order;
    expect(job.values.step).toBe(todo);
    const order = await create();

    // A stage's refusal and a state's refusal: the same keys, `stage` or `state` for the position.
    const stageRefusal = await refusal(
      invokeByName(
        "record.update",
        { object: `${ext}.job`, id: job.id, values: { step: done } },
        human(),
      ),
    );
    expect(stageRefusal).toEqual({
      code: "invalid_input",
      message: "Done needs Summary",
      details: {
        rule: "stage_required_fields",
        object: `${ext}.job`,
        field: "summary",
        fields: ["summary"],
        labels: ["Summary"],
        stage: { id: done, title: "Done", type: "won" },
      },
    });
    const stateRefusal = await refusal(update(order.id, { state: "cancelled" }));
    expect(Object.keys(stateRefusal.details ?? {}).slice(0, 5)).toEqual(
      Object.keys(stageRefusal.details ?? {}).slice(0, 5),
    );

    await invokeByName(
      "record.update",
      { object: `${ext}.job`, id: job.id, values: { step: done, summary: "Shipped" } },
      human(),
    );
    await update(order.id, { state: "review" });
    const { results } = await env.DB.prepare(
      "SELECT object_type, form, stage_id, stage_type, left_at IS NULL AS current, entered_as FROM core_stage_history WHERE record_id IN (?, ?) ORDER BY object_type, entered_at, left_at IS NULL",
    )
      .bind(job.id, order.id)
      .all();
    expect(results).toEqual([
      {
        object_type: `${ext}.job`,
        form: "stages",
        stage_id: todo,
        stage_type: "open",
        current: 0,
        entered_as: "staff",
      },
      {
        object_type: `${ext}.job`,
        form: "stages",
        stage_id: done,
        stage_type: "won",
        current: 1,
        entered_as: "staff",
      },
      {
        object_type: ORDER,
        form: "states",
        stage_id: "pending",
        stage_type: "open",
        current: 0,
        entered_as: "staff",
      },
      {
        object_type: ORDER,
        form: "states",
        stage_id: "review",
        stage_type: "open",
        current: 1,
        entered_as: "staff",
      },
    ]);
    const inView = async (view: string) =>
      (
        await env.DB.prepare(`SELECT DISTINCT object_type FROM ${view} WHERE record_id IN (?, ?)`)
          .bind(job.id, order.id)
          .all<{ object_type: string }>()
      ).results.map((row) => row.object_type);
    expect(await inView("rec_stage_history")).toEqual([`${ext}.job`]);
    expect(await inView("rec_state_history")).toEqual([ORDER]);
    expect((await timeline(`${ext}.job`, job.id)).map((p) => p.subject)).toEqual(["Moved to Done"]);
    expect((await timeline(ORDER, order.id)).map((p) => p.subject)).toEqual(["Moved to In review"]);
  });
});

describe("who may move a stage", () => {
  /**
   * Nothing can call as a customer until stage 22, so the customer's write is put to the engine
   * directly, as the record operations will once a customer principal exists.
   */
  const moveAs = (by: "customer" | "host") =>
    defineOperation({
      name: `fixture.moveStageAs${by === "host" ? "Host" : "Customer"}`,
      description: "Test fixture: puts a stage move to the transition engine as the given mover.",
      input: z.object({ id: z.string(), from: z.string(), to: z.string() }),
      output: z.object({ moved: z.string().nullable() }),
      permission: "records:write",
      risk: "write",
      async handler(input, ctx) {
        const object = getObject(`${ext}.job`);
        if (!object) throw new Error("no job object");
        const outcome = await applyTransition(
          ctx,
          object,
          input.id,
          { step: input.from },
          { step: input.to },
          { by },
        );
        return { moved: outcome.moved?.title ?? null };
      },
    });

  it("refuses a customer on a stage-driven object, and lets staff and the host move it", async () => {
    const step = async (name: string, position: number) =>
      (
        (await invokeByName(
          "record.create",
          { object: `${ext}.step`, values: { name, position, type: "open" } },
          context(admin),
        )) as Order
      ).id;
    const first = await step(unique("First"), 101);
    const second = await step(unique("Second"), 102);
    const job = (await invokeByName(
      "record.create",
      { object: `${ext}.job`, values: { name: unique("Job"), step: first } },
      human(),
    )) as Order;
    const input = { id: job.id, from: first, to: second };

    expect(await refusal(invokeOperation(moveAs("customer"), input, context(admin)))).toEqual({
      code: "invalid_input",
      message: expect.stringMatching(/^Only staff or the platform can move job to Second/),
      details: {
        rule: "stage_move_not_permitted",
        object: `${ext}.job`,
        field: "step",
        fields: ["step"],
        labels: ["Step"],
        stage: { id: second, title: expect.stringMatching(/^Second/), type: "open" },
        by: ["staff", "host"],
      },
    });
    expect(await invokeOperation(moveAs("host"), input, context(admin))).toEqual({
      moved: expect.stringMatching(/^Second/),
    });
    const moved = (await invokeByName(
      "record.update",
      { object: `${ext}.job`, id: job.id, values: { step: second } },
      human(),
    )) as Order;
    expect(moved.values.step).toBe(second);
  });
});

describe("a state field's column", () => {
  it("defaults to the initial state, so a column added to existing records is never empty", async () => {
    const id = extId("sd");
    const fields = { name: { type: "text", label: "Name" } };
    const thing = { label: "Thing", plural: "Things", titleField: "name" };
    await reconcile(manifest(id, { objects: { thing: { ...thing, fields } } } as never));
    const old = (await invokeByName(
      "record.create",
      { object: `${id}.thing`, values: { name: "Before states" } },
      human(),
    )) as Order;

    await reconcile(
      manifest(id, {
        version: "1.1.0",
        objects: {
          thing: {
            ...thing,
            fields: {
              ...fields,
              state: {
                type: "select",
                label: "State",
                options: [
                  { value: "it's new", label: "New" },
                  { value: "done", label: "Done" },
                ],
              },
            },
            states: {
              field: "state",
              initial: "it's new",
              moves: [{ from: "it's new", to: "done", by: ["staff"], final: true }],
            },
          },
        },
      } as never),
    );
    const get = async () =>
      ((await invokeByName("record.get", { object: `${id}.thing`, id: old.id }, human())) as Order)
        .values.state;
    expect(await get()).toBe("it's new");
    // Its first move opens its history; there was no row to close.
    await invokeByName(
      "record.update",
      { object: `${id}.thing`, id: old.id, values: { state: "done" } },
      human(),
    );
    expect(await get()).toBe("done");
    const { results } = await env.DB.prepare(
      "SELECT state, is_final, is_current FROM rec_state_history WHERE record_id = ?",
    )
      .bind(old.id)
      .all();
    expect(results).toEqual([{ state: "done", is_final: 1, is_current: 1 }]);
  });
});
