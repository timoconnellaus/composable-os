// Stage 26: the capacity behaviour on extension objects (ADRs 0430 to 0433). The declaration and
// its checks, the counter kept by the record operations for every actor, holds confirmed and
// released, the approval queue's dry run, the statement counts, and what capacity.get shows to
// staff, customers and the public.
//
// Orders do not exist yet (stage 25's second half wires them): a fixture claimant stands in for
// them, holding, paying for, cancelling and refunding places through the host functions.
import { env } from "cloudflare:workers";
import {
  type CapacityManifest,
  type ExtensionManifest,
  validateManifest,
} from "@composable-os/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  CLAIM_STATEMENTS,
  CONFIRM_STATEMENTS,
  claimStatements,
  confirmStatements,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  type InvocationContext,
  newId,
  PendingApprovalError,
  queueClaim,
  RELEASE_STATEMENTS,
  releaseStatements,
  ValidationError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const ext = extId("cap");
const EVENT = `${ext}.event`;
const TICKET = `${ext}.tickettype`;
const KLASS = `${ext}.klass`;

const line = z.object({ object: z.string(), record: z.string(), quantity: z.number() });
const forOrder = (id: string) => ({ type: "fixture_order", id });

// The fixture claimant: what an order will do in stage 25.
const holdOp = defineOperation({
  name: "fixture.hold",
  description: "Test fixture: starts an order, holding places for each of its lines.",
  input: z.object({ order: z.string(), lines: z.array(line) }),
  output: z.object({ claims: z.array(z.string()) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const claims: string[] = [];
    for (const l of input.lines) {
      claims.push(await queueClaim(ctx, { ...l, for: forOrder(input.order) }));
    }
    return { claims };
  },
});
const settle = (
  name: string,
  description: string,
  statements: (order: string, now: string) => ReturnType<typeof confirmStatements>,
) =>
  defineOperation({
    name,
    description,
    input: z.object({ order: z.string() }),
    output: z.object({ ok: z.boolean() }),
    permission: "records:write",
    risk: "write",
    async handler(input, ctx) {
      ctx.write(...statements(input.order, ctx.now));
      return { ok: true };
    },
  });
const payOp = settle(
  "fixture.pay",
  "Test fixture: an order is paid and its holds confirmed.",
  (order, now) => confirmStatements({ for: forOrder(order) }, now),
);
const cancelOp = settle(
  "fixture.cancel",
  "Test fixture: an order is cancelled or expires; its holds are released.",
  (order, now) => releaseStatements({ for: forOrder(order) }, now),
);
const refundOp = settle(
  "fixture.refund",
  "Test fixture: a paid order is refunded and its places released.",
  (order, now) => releaseStatements({ for: forOrder(order) }, now, { confirmed: true }),
);

const { invoke, invokeByName } = createInvoker(
  createRegistry([...coreRegistry.list(), holdOp, payOp, cancelOp, refundOp]),
);

let admin: ActingUser;
let member: ActingUser;
const staff = (overrides: Partial<InvocationContext> = {}) => context(member, overrides);
const asMcp = (sessionId = `cap_${unique()}`) =>
  staff({
    actor: "mcp",
    origin: { surface: "mcp", clientId: "client-1", clientName: "Test client", sessionId },
  });

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(ext, {
      objects: {
        event: {
          label: "Event",
          plural: "Events",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            places: { type: "number", label: "Places" },
          },
          capacity: { places: "places" },
        },
        tickettype: {
          label: "Ticket type",
          plural: "Ticket types",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            places: { type: "number", label: "Places" },
            event: { type: "relation", label: "Event", to: `${ext}.event` },
          },
          capacity: { places: "places", pool: "event", show: "exact", releaseOnRefund: false },
        },
        klass: {
          label: "Class",
          plural: "Classes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            seats: { type: "number", label: "Seats" },
          },
          capacity: { places: "seats", show: "low", lowAt: 3 },
        },
      },
    }),
  );
});

afterEach(async () => {
  await setPreset("balanced");
});

async function create(object: string, values: Record<string, unknown>) {
  return (await invoke("record.create", { object, values }, context(admin))).id;
}

async function counter(object: string, record: string) {
  return env.DB.prepare(
    "SELECT places, held, taken, pool_object_type, pool_record_id FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, record)
    .first<Record<string, unknown>>();
}

async function numbers(object: string, record: string) {
  const row = await counter(object, record);
  return row ? { places: row.places, held: row.held, taken: row.taken } : null;
}

async function claimStates(order: string) {
  const { results } = await env.DB.prepare(
    "SELECT state FROM core_capacity_claim WHERE for_type = 'fixture_order' AND for_id = ? ORDER BY id",
  )
    .bind(order)
    .all<{ state: string }>();
  return results.map((r) => r.state);
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).details as Record<string, unknown>;
}

const hold = (order: string, lines: z.infer<typeof line>[], ctx = staff()) =>
  invoke("fixture.hold", { order, lines }, ctx);

describe("the declaration", () => {
  const base = (capacity: unknown, extra: Record<string, unknown> = {}) =>
    validateManifest(
      manifest("capcheck", {
        objects: {
          parent: {
            label: "Parent",
            plural: "Parents",
            titleField: "name",
            fields: { name: { type: "text", label: "Name" }, n: { type: "number", label: "N" } },
            capacity: { places: "n" },
          },
          grand: {
            label: "Grand",
            plural: "Grands",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              n: { type: "number", label: "N" },
              parent: { type: "relation", label: "Parent", to: "capcheck.parent" },
            },
            capacity: { places: "n", pool: "parent" },
          },
          plain: {
            label: "Plain",
            plural: "Plains",
            titleField: "name",
            fields: { name: { type: "text", label: "Name" } },
          },
          child: {
            label: "Child",
            plural: "Children",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              n: { type: "number", label: "N" },
              label: { type: "text", label: "Label" },
              parent: { type: "relation", label: "Parent", to: "capcheck.parent" },
              grand: { type: "relation", label: "Grand", to: "capcheck.grand" },
              plain: { type: "relation", label: "Plain", to: "capcheck.plain" },
              ...extra,
            },
            capacity: capacity as CapacityManifest,
          },
        },
      }),
    ).issues.map((i) => `${i.path}: ${i.message}`);

  it("accepts places, a pool one level up and each show", () => {
    expect(base({ places: "n", pool: "parent", show: "exact" })).toEqual([]);
    expect(base({ places: "n", show: "low", lowAt: 5 })).toEqual([]);
    expect(base({ places: "n" })).toEqual([]);
  });

  it("refuses a bad places field, a pool that is not one level, and show without its threshold", () => {
    expect(base({ places: "label" }).join("\n")).toMatch(/places: "label" must be a number field/);
    expect(base({ places: "n", pool: "plain" }).join("\n")).toMatch(/must declare a capacity/);
    expect(base({ places: "n", pool: "grand" }).join("\n")).toMatch(/one level of pool/);
    expect(base({ places: "n", pool: "name" }).join("\n")).toMatch(/must be a relation field/);
    expect(base({ places: "n", show: "low" }).join("\n")).toMatch(/needs lowAt/);
    expect(base({ places: "n", lowAt: 2 }).join("\n")).toMatch(/lowAt is the threshold/);
    expect(base({ places: "n" }, { held: { type: "number", label: "Held" } }).join("\n")).toMatch(
      /"held" is a value the host adds/,
    );
  });
});

describe("the counter follows the record", () => {
  it("is created with the record, with its pool, and its values are on the record", async () => {
    const event = await create(EVENT, { name: unique("Gig"), places: 200 });
    const ticket = await create(TICKET, { name: "GA", places: 50, event });
    expect(await counter(TICKET, ticket)).toMatchObject({
      places: 50,
      held: 0,
      pool_object_type: EVENT,
      pool_record_id: event,
    });
    await hold(unique("o"), [{ object: TICKET, record: ticket, quantity: 4 }]);
    const record = await invoke("record.get", { object: TICKET, id: ticket }, context(admin));
    expect(record.values).toMatchObject({ places: 50, held: 4, taken: 0, available: 46 });
    const parent = await invoke("record.get", { object: EVENT, id: event }, context(admin));
    expect(parent.values).toMatchObject({ held: 4, taken: 0, available: 196 });
    // available is the fewer of the record's and its pool's places left.
    await invoke("record.update", { object: EVENT, id: event, values: { places: 10 } }, staff());
    const again = await invoke("record.get", { object: TICKET, id: ticket }, context(admin));
    expect(again.values).toMatchObject({ available: 6 });
    // The values are read-only and filterable.
    await expect(
      invoke("record.update", { object: TICKET, id: ticket, values: { held: 0 } }, staff()),
    ).rejects.toBeInstanceOf(ValidationError);
    const listed = await invoke(
      "record.list",
      { object: TICKET, filter: { field: "available", op: "eq", value: 6 }, limit: 50 },
      context(admin),
    );
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(ticket);
  });

  it("refuses places that are not a whole number from 0", async () => {
    for (const places of [-1, 2.5]) {
      await expect(
        invoke("record.create", { object: EVENT, values: { name: "x", places } }, staff()),
      ).rejects.toMatchObject({ code: "invalid_input", details: { rule: "capacity" } });
    }
  });

  it("an import creates each record's counter", async () => {
    const name = unique("Imported");
    const csv = `Name,Places\n${name} one,5\n${name} two,\n`;
    const done = (await invokeByName(
      "import.records.commit",
      { object: EVENT, csv },
      context(admin),
    )) as { created: string[] };
    expect(done.created).toHaveLength(2);
    expect(await numbers(EVENT, done.created[0] as string)).toEqual({
      places: 5,
      held: 0,
      taken: 0,
    });
    expect(await numbers(EVENT, done.created[1] as string)).toEqual({
      places: null,
      held: 0,
      taken: 0,
    });
  });

  it("a reconcile gives counters to records made before the object declared a capacity", async () => {
    const id = extId("capl");
    const objects = (capacity?: CapacityManifest): ExtensionManifest["objects"] => ({
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: {
          name: { type: "text" as const, label: "Name", required: true },
          seats: { type: "number" as const, label: "Seats" },
        },
        ...(capacity ? { capacity } : {}),
      },
    });
    await reconcile(manifest(id, { objects: objects() }));
    const room = (
      await invoke(
        "record.create",
        { object: `${id}.room`, values: { name: "A", seats: 8 } },
        staff(),
      )
    ).id;
    expect(await counter(`${id}.room`, room)).toBeNull();
    await reconcile(manifest(id, { version: "1.0.1", objects: objects({ places: "seats" }) }));
    expect(await numbers(`${id}.room`, room)).toEqual({ places: 8, held: 0, taken: 0 });
  });
});

describe("criterion 3: release and confirm", () => {
  it("a hold counts until released, then its places can be claimed again", async () => {
    const klass = await create(KLASS, { name: unique("Yoga"), seats: 2 });
    const order = unique("o");
    await hold(order, [{ object: KLASS, record: klass, quantity: 2 }]);
    expect(await numbers(KLASS, klass)).toEqual({ places: 2, held: 2, taken: 0 });
    await refusal(hold(unique("o"), [{ object: KLASS, record: klass, quantity: 1 }]));
    await invoke("fixture.cancel", { order }, staff());
    expect(await numbers(KLASS, klass)).toEqual({ places: 2, held: 0, taken: 0 });
    expect(await claimStates(order)).toEqual(["released"]);
    await hold(unique("o"), [{ object: KLASS, record: klass, quantity: 2 }]);
    expect(await numbers(KLASS, klass)).toEqual({ places: 2, held: 2, taken: 0 });
  });

  it("confirming succeeds however old the hold, and twice changes nothing", async () => {
    const event = await create(EVENT, { name: unique("Fest"), places: 10 });
    const ticket = await create(TICKET, { name: "VIP", places: 5, event });
    const order = unique("o");
    await hold(order, [
      { object: TICKET, record: ticket, quantity: 2 },
      { object: TICKET, record: ticket, quantity: 1 },
      { object: EVENT, record: event, quantity: 1 },
    ]);
    // Weeks old: a deposit paid, the balance due later. Nothing about a hold expires.
    await env.DB.prepare(
      "UPDATE core_capacity_claim SET created_at = '2026-01-01T00:00:00.000Z' WHERE for_id = ?",
    )
      .bind(order)
      .run();
    await invoke("fixture.pay", { order }, staff());
    expect(await numbers(TICKET, ticket)).toEqual({ places: 5, held: 0, taken: 3 });
    expect(await numbers(EVENT, event)).toEqual({ places: 10, held: 0, taken: 4 });
    await invoke("fixture.pay", { order }, staff());
    await invoke("fixture.cancel", { order }, staff());
    expect(await numbers(TICKET, ticket)).toEqual({ places: 5, held: 0, taken: 3 });
    expect(await numbers(EVENT, event)).toEqual({ places: 10, held: 0, taken: 4 });
    expect(await claimStates(order)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("releasing twice changes nothing; a refund releases taken places to the same pool", async () => {
    const event = await create(EVENT, { name: unique("Show"), places: 10 });
    const ticket = await create(TICKET, { name: "GA", places: 10, event });
    const order = unique("o");
    await hold(order, [{ object: TICKET, record: ticket, quantity: 3 }]);
    await invoke("fixture.cancel", { order }, staff());
    await invoke("fixture.cancel", { order }, staff());
    expect(await numbers(TICKET, ticket)).toEqual({ places: 10, held: 0, taken: 0 });
    expect(await numbers(EVENT, event)).toEqual({ places: 10, held: 0, taken: 0 });

    const paid = unique("o");
    await hold(paid, [{ object: TICKET, record: ticket, quantity: 2 }]);
    await invoke("fixture.pay", { order: paid }, staff());
    // The ticket type moves to another event; the claim's places still go back to the first.
    const other = await create(EVENT, { name: unique("Other"), places: 10 });
    await invoke(
      "record.update",
      { object: TICKET, id: ticket, values: { event: other } },
      staff(),
    );
    await invoke("fixture.refund", { order: paid }, staff());
    await invoke("fixture.refund", { order: paid }, staff());
    expect(await numbers(TICKET, ticket)).toEqual({ places: 10, held: 0, taken: 0 });
    expect(await numbers(EVENT, event)).toEqual({ places: 10, held: 0, taken: 0 });
    expect(await numbers(EVENT, other)).toEqual({ places: 10, held: 0, taken: 0 });
  });

  it("the declaration says whether a refund releases places", async () => {
    const definition = (await invoke("schema.objects", {}, context(admin))) as unknown;
    const text = JSON.stringify(definition);
    expect(text).toContain('"releaseOnRefund":false');
  });
});

describe("criterion 4: lowering places", () => {
  async function held(seats: number, quantity: number) {
    const klass = await create(KLASS, { name: unique("Pilates"), seats });
    await hold(unique("o"), [{ object: KLASS, record: klass, quantity }]);
    return klass;
  }

  it("below held + taken is refused with the numbers, for every actor", async () => {
    const actors: [string, InvocationContext][] = [
      ["human", staff()],
      ["mcp", asMcp()],
      [
        "automation",
        staff({ actor: "automation", origin: { surface: "system", automationId: "a1" } }),
      ],
      [
        "extension",
        staff({
          actor: "extension",
          origin: { surface: "system" },
          extension: {
            id: ext,
            permissions: { read: [], write: [], operations: ["fixture.hold"], modules: [] },
          },
        }),
      ],
    ];
    for (const [actor, ctx] of actors) {
      const klass = await held(10, 6);
      const details = await refusal(
        invoke("record.update", { object: KLASS, id: klass, values: { seats: 5 } }, ctx),
      );
      expect(details, actor).toEqual({
        rule: "capacity",
        object: KLASS,
        record: klass,
        places: 5,
        held: 6,
        taken: 0,
      });
      expect(await numbers(KLASS, klass)).toEqual({ places: 10, held: 6, taken: 0 });
      // Raising is always allowed, and is the only way to let one more in.
      await invoke("record.update", { object: KLASS, id: klass, values: { seats: 12 } }, ctx);
      expect(await numbers(KLASS, klass)).toEqual({ places: 12, held: 6, taken: 0 });
    }
  });

  it("emptying places makes it unlimited; setting them again below what is claimed is refused", async () => {
    const klass = await held(4, 4);
    await invoke("record.update", { object: KLASS, id: klass, values: { seats: null } }, staff());
    await hold(unique("o"), [{ object: KLASS, record: klass, quantity: 6 }]);
    expect(await numbers(KLASS, klass)).toEqual({ places: null, held: 10, taken: 0 });
    const details = await refusal(
      invoke("record.update", { object: KLASS, id: klass, values: { seats: 9 } }, staff()),
    );
    expect(details).toMatchObject({ places: 9, held: 10 });
    await invoke("record.update", { object: KLASS, id: klass, values: { seats: 10 } }, staff());
  });

  it("an approved change is refused when it runs, and its dry run reports the refusal", async () => {
    await setPreset("cautious");
    const klass = await held(10, 2);
    // Queued: the dry run sees enough room.
    const queued = await invoke(
      "record.update",
      { object: KLASS, id: klass, values: { seats: 3 } },
      asMcp(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(queued).toBeInstanceOf(PendingApprovalError);
    // Refused at once: the dry run reports what the database would refuse.
    const details = await refusal(
      invoke("record.update", { object: KLASS, id: klass, values: { seats: 1 } }, asMcp()),
    );
    expect(details).toMatchObject({ rule: "capacity", places: 1, held: 2 });
    // Meanwhile two more are held; approving the queued change is refused when it runs.
    await hold(unique("o"), [{ object: KLASS, record: klass, quantity: 2 }]);
    const out = (await invokeByName(
      "approval.approve",
      { actionIds: [(queued as PendingApprovalError).pending.actionId] },
      context(admin),
    )) as { results: { status: string; error: unknown }[] };
    expect(out.results[0]?.status).toBe("failed");
    expect(JSON.stringify(out.results[0]?.error)).toContain('"rule":"capacity"');
    expect(await numbers(KLASS, klass)).toEqual({ places: 10, held: 4, taken: 0 });
  });
});

describe("criterion 6: every actor", () => {
  it("people, MCP clients, automations and extensions are all held to the places", async () => {
    const klass = await create(KLASS, { name: unique("Spin"), seats: 4 });
    const actors = [
      staff(),
      asMcp(),
      staff({ actor: "automation", origin: { surface: "system", automationId: "a1" } }),
      staff({
        actor: "extension",
        origin: { surface: "system" },
        extension: {
          id: ext,
          permissions: { read: [], write: [], operations: ["fixture.hold"], modules: [] },
        },
      }),
    ];
    for (const ctx of actors)
      await hold(unique("o"), [{ object: KLASS, record: klass, quantity: 1 }], ctx);
    for (const ctx of actors) {
      expect(
        await refusal(hold(unique("o"), [{ object: KLASS, record: klass, quantity: 1 }], ctx)),
      ).toEqual({ rule: "capacity", object: KLASS, record: klass, asked: 1, available: 0 });
    }
    expect(await numbers(KLASS, klass)).toEqual({ places: 4, held: 4, taken: 0 });
  });

  it("the approval queue's dry run reports a refusal without claiming; the approved action may be refused", async () => {
    await setPreset("cautious");
    const event = await create(EVENT, { name: unique("Late"), places: 3 });
    const ticket = await create(TICKET, { name: "GA", places: 10, event });
    // Past the pool: refused by the dry run, and nothing is claimed or queued.
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
      n: number;
    }>();
    expect(
      await refusal(hold(unique("o"), [{ object: TICKET, record: ticket, quantity: 4 }], asMcp())),
    ).toEqual({ rule: "capacity", object: EVENT, record: event, asked: 4, available: 3 });
    // Two lines on one counter add up in the dry run as in the database.
    expect(
      await refusal(
        hold(
          unique("o"),
          [
            { object: TICKET, record: ticket, quantity: 2 },
            { object: EVENT, record: event, quantity: 2 },
          ],
          asMcp(),
        ),
      ),
    ).toMatchObject({ object: EVENT, asked: 2, available: 1 });
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
    expect(await numbers(TICKET, ticket)).toEqual({ places: 10, held: 0, taken: 0 });

    // Within the places: queued, and the dry run claimed nothing.
    const order = unique("o");
    const pending = await hold(
      order,
      [{ object: TICKET, record: ticket, quantity: 3 }],
      asMcp(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(pending).toBeInstanceOf(PendingApprovalError);
    expect(await numbers(EVENT, event)).toEqual({ places: 3, held: 0, taken: 0 });
    // A person takes one place; the approved hold claims when it runs and is refused.
    await hold(unique("o"), [{ object: EVENT, record: event, quantity: 1 }]);
    const out = (await invokeByName(
      "approval.approve",
      { actionIds: [(pending as PendingApprovalError).pending.actionId] },
      context(admin),
    )) as { results: { status: string; error: unknown }[] };
    expect(out.results[0]?.status).toBe("failed");
    expect(JSON.stringify(out.results[0]?.error)).toContain('"available":2');
    expect(await claimStates(order)).toEqual([]);
  });
});

describe("deleting", () => {
  it("a record with confirmed claims cannot go to Trash; trash releases nothing", async () => {
    const klass = await create(KLASS, { name: unique("Barre"), seats: 5 });
    const paid = unique("o");
    await hold(paid, [{ object: KLASS, record: klass, quantity: 1 }]);
    await invoke("fixture.pay", { order: paid }, staff());
    expect(
      await refusal(invoke("record.delete", { object: KLASS, id: klass }, context(admin))),
    ).toMatchObject({ rule: "capacity", taken: 1 });

    const other = await create(KLASS, { name: unique("Barre"), seats: 5 });
    const order = unique("o");
    await hold(order, [{ object: KLASS, record: other, quantity: 2 }]);
    await invoke("record.delete", { object: KLASS, id: other }, context(admin));
    expect(await numbers(KLASS, other)).toEqual({ places: 5, held: 2, taken: 0 });
    expect(await claimStates(order)).toEqual(["held"]);
  });
});

describe("criterion 7: fixed statement counts", () => {
  it("a claim, a confirm and a release are a fixed number of statements, none a read", () => {
    const now = new Date().toISOString();
    const claim = claimStatements(
      db.query,
      { object: KLASS, record: "r", quantity: 1, for: forOrder("x") },
      now,
    ).statements.map((s) => s.compile().sql);
    const one = [
      ...confirmStatements({ claim: newId("capacityClaim") }, now),
      ...releaseStatements({ claim: newId("capacityClaim") }, now),
    ];
    const order = [
      ...confirmStatements({ for: forOrder("x") }, now),
      ...releaseStatements({ for: forOrder("x") }, now, { confirmed: true }),
    ];
    expect(claim).toHaveLength(CLAIM_STATEMENTS);
    expect(CLAIM_STATEMENTS).toBe(3);
    expect(confirmStatements({ claim: "c" }, now)).toHaveLength(CONFIRM_STATEMENTS);
    expect(releaseStatements({ claim: "c" }, now)).toHaveLength(RELEASE_STATEMENTS);
    expect(CONFIRM_STATEMENTS).toBe(3);
    expect(RELEASE_STATEMENTS).toBe(3);
    for (const sql of [...claim, ...one.map((s) => s.sql), ...order.map((s) => s.sql)]) {
      expect(sql.trim()).toMatch(/^(update|insert)/i);
    }
  });

  it("confirming or releasing an order of many lines is still three statements", async () => {
    const event = await create(EVENT, { name: unique("Many"), places: 100 });
    const tickets = [
      await create(TICKET, { name: "A", places: 10, event }),
      await create(TICKET, { name: "B", places: 10, event }),
      await create(TICKET, { name: "C", places: 10, event }),
    ];
    const order = unique("o");
    await hold(
      order,
      tickets.map((record) => ({ object: TICKET, record, quantity: 2 })),
    );
    const now = new Date().toISOString();
    const statements = confirmStatements({ for: forOrder(order) }, now);
    expect(statements).toHaveLength(3);
    await db.batch(statements);
    for (const t of tickets)
      expect(await numbers(TICKET, t)).toEqual({ places: 10, held: 0, taken: 2 });
    expect(await numbers(EVENT, event)).toEqual({ places: 100, held: 0, taken: 6 });
  });
});

describe("criterion 8: what capacity.get shows", () => {
  const customer = () => ({
    principal: {
      kind: "customer" as const,
      customerId: `cus_${unique()}`,
      personId: newId("person"),
    },
    db,
  });
  const visitor = () => ({ principal: { kind: "public" as const }, db });

  async function sold(object: string, values: Record<string, unknown>, quantity: number) {
    const id = await create(object, values);
    if (quantity) await hold(unique("o"), [{ object, record: id, quantity }]);
    return id;
  }

  it("staff get the real numbers, and the pool's", async () => {
    const event = await create(EVENT, { name: unique("Staff"), places: 20 });
    const ticket = await sold(TICKET, { name: "GA", places: 8, event }, 3);
    expect(await invoke("capacity.get", { object: TICKET, id: ticket }, staff())).toEqual({
      object: TICKET,
      id: ticket,
      status: "available",
      available: 5,
      places: 8,
      held: 3,
      taken: 0,
      show: "exact",
      lowAt: null,
      pool: { object: EVENT, id: event, places: 20, held: 3, taken: 0, available: 17 },
    });
  });

  it("exact: outsiders get the number left and nothing else", async () => {
    const event = await create(EVENT, { name: unique("Exact"), places: 20 });
    const ticket = await sold(TICKET, { name: "GA", places: 8, event }, 3);
    for (const ctx of [customer(), visitor()]) {
      expect(await invokeByName("capacity.get", { object: TICKET, id: ticket }, ctx)).toEqual({
        object: TICKET,
        id: ticket,
        status: "available",
        available: 5,
      });
    }
  });

  it("low: available, or only N left at or below the threshold, or sold out", async () => {
    const plenty = await sold(KLASS, { name: unique("Low"), seats: 10 }, 2);
    const few = await sold(KLASS, { name: unique("Low"), seats: 10 }, 7);
    const none = await sold(KLASS, { name: unique("Low"), seats: 2 }, 2);
    for (const ctx of [customer(), visitor()]) {
      expect(await invokeByName("capacity.get", { object: KLASS, id: plenty }, ctx)).toEqual({
        object: KLASS,
        id: plenty,
        status: "available",
      });
      expect(await invokeByName("capacity.get", { object: KLASS, id: few }, ctx)).toEqual({
        object: KLASS,
        id: few,
        status: "low",
        available: 3,
      });
      expect(await invokeByName("capacity.get", { object: KLASS, id: none }, ctx)).toEqual({
        object: KLASS,
        id: none,
        status: "sold_out",
      });
    }
    expect(
      await invokeByName("capacity.get", { object: KLASS, id: plenty }, staff()),
    ).toMatchObject({
      available: 8,
      held: 2,
    });
  });

  it("availability (the default): available or sold out only", async () => {
    const open = await sold(EVENT, { name: unique("Avail"), places: 5 }, 4);
    const full = await sold(EVENT, { name: unique("Avail"), places: 1 }, 1);
    const unlimited = await sold(EVENT, { name: unique("Avail") }, 50);
    for (const ctx of [customer(), visitor()]) {
      expect(await invokeByName("capacity.get", { object: EVENT, id: open }, ctx)).toEqual({
        object: EVENT,
        id: open,
        status: "available",
      });
      expect(await invokeByName("capacity.get", { object: EVENT, id: full }, ctx)).toEqual({
        object: EVENT,
        id: full,
        status: "sold_out",
      });
      expect(await invokeByName("capacity.get", { object: EVENT, id: unlimited }, ctx)).toEqual({
        object: EVENT,
        id: unlimited,
        status: "available",
      });
    }
  });

  it("an object without a capacity, or a record in Trash, is not there", async () => {
    const trashed = await create(KLASS, { name: unique("Gone"), seats: 3 });
    await invoke("record.delete", { object: KLASS, id: trashed }, context(admin));
    await expect(
      invokeByName("capacity.get", { object: KLASS, id: trashed }, visitor()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      invokeByName("capacity.get", { object: "person", id: "per_x" }, visitor()),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("the views", () => {
  it("rec_capacity and rec_capacity_claim can be queried", async () => {
    const klass = await create(KLASS, { name: unique("View"), seats: 6 });
    const order = unique("o");
    await hold(order, [{ object: KLASS, record: klass, quantity: 2 }]);
    const out = (await invoke(
      "query.sql",
      {
        sql: `SELECT c.places, c.held, c.available, count(k.id) AS claims FROM rec_capacity c JOIN rec_capacity_claim k ON k.object_type = c.object_type AND k.record_id = c.record_id WHERE c.record_id = '${klass}' GROUP BY c.record_id`,
      },
      context(admin),
    )) as { rows: Record<string, unknown>[] };
    expect(out.rows).toEqual([{ places: 6, held: 2, available: 4, claims: 1 }]);
  });
});
