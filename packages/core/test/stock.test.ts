// Stage 37 step 1: the `stock` behaviour (ADR 0680). The declaration and its checks, a counter
// for every record, opening stock and corrections written in the ledger at the default place,
// stock.get for staff, customers and the public, an order's lines holding stock while unpaid and
// selling it when paid (refused by the database past what is available, on every path), a refund
// changing nothing in stock, a ledger nobody changes, an AI's change waiting for a person, and
// the statements a paid order's confirm costs. Acceptance criteria 1, 3, 4 (as far as orders go),
// 10 (order.start refuses), 16, 17 (stock.adjust), 19 (the runtime refusal) and 20 (the confirm).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  createInvoker,
  MOVEMENT_STATEMENTS,
  movementStatements,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  orderRegistry,
  outside,
  PUBLIC,
  refusal,
  run,
} from "./order-fixtures.ts";

const ext = extId("stk");
const VARIANT = `${ext}.variant`;
const DRINK = `${ext}.drink`;
const PASS = `${ext}.pass`;

interface OrderOut {
  id: string;
  state: string;
  total: number;
}

interface Movement {
  quantity: number;
  kind: string;
  place: string;
  sourceType: string;
  sourceId: string;
  by: string | null;
  note: string | null;
}

let admin: ActingUser;
let member: ActingUser;
let alice: Buyer;

function shopManifest(id: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      variant: {
        label: "Variant",
        plural: "Variants",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          reorderLevel: { type: "number", label: "Reorder level" },
          reorderQty: { type: "number", label: "Reorder quantity" },
        },
        sellable: { price: "price" },
        stock: { reorderAt: "reorderLevel", reorderQty: "reorderQty" },
        public: { read: ["name", "price"] },
      },
      drink: {
        label: "Drink",
        plural: "Drinks",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price" },
        stock: { show: "low", lowAt: 3 },
        public: { read: ["name", "price"] },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price" },
        public: { read: ["name", "price"] },
      },
    },
  });
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(shopManifest(ext));
  await run("order.settings.update", { currency: CURRENCY }, context(admin));
  alice = await createBuyer(admin, "alice");
});

beforeEach(async () => {
  await setPreset("balanced");
});

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

const opening = (object: string, id: string, quantity: number, user = admin) =>
  run("stock.opening", { object, id, quantity }, context(user));

const stockOf = (object: string, id: string, ctx: Parameters<typeof run>[2] = context(member)) =>
  run<Record<string, unknown>>("stock.get", { object, id }, ctx);

async function movements(object: string, id: string): Promise<Movement[]> {
  return (await run<{ items: Movement[] }>("stock.movements", { object, id }, context(member)))
    .items;
}

const startAsGuest = (lines: { object: string; id: string; quantity?: number }[]) =>
  run<OrderOut>(
    "order.start",
    { lines, email: `${unique("guest")}@buyers.example` },
    outside(PUBLIC),
  );

const pay = (order: OrderOut) =>
  run(
    "fixture.verifiedPayment",
    { orderId: order.id, amount: order.total, eventId: unique("evt") },
    context(admin, { actor: "automation" }),
  );

const moveOrder = (id: string, to: string) =>
  run("fixture.moveOrderAs", { id, to, by: "host" }, context(admin));

async function variantWith(quantity: number, values: Record<string, unknown> = {}) {
  const id = await create(VARIANT, { name: unique("Hoodie"), price: 60, ...values });
  if (quantity > 0) await opening(VARIANT, id, quantity);
  return id;
}

// --- The declaration --------------------------------------------------------------------------

describe("the stock declaration", () => {
  const issuesOf = (objects: Record<string, unknown>) =>
    validateManifest({ id: "decl", version: "1.0.0", contractVersion: 1, objects }).issues.map(
      (i) => `${i.path}: ${i.message}`,
    );
  const base = {
    label: "Thing",
    plural: "Things",
    titleField: "name",
    fields: {
      name: { type: "text", label: "Name" },
      price: { type: "number", label: "Price" },
      level: { type: "text", label: "Level" },
      places: { type: "number", label: "Places" },
      due: { type: "date", label: "Due" },
    },
  };

  it("is valid on a sellable object, with number fields for its levels", () => {
    expect(
      issuesOf({
        thing: { ...base, sellable: { price: "price" }, stock: { show: "availability" } },
      }),
    ).toEqual([]);
  });

  it("refuses a level that is not a number field, a capacity beside it and a field named as its values", () => {
    const issues = issuesOf({
      thing: {
        ...base,
        fields: { ...base.fields, onHand: { type: "number", label: "On hand" } },
        capacity: { places: "places" },
        stock: { reorderAt: "level", reorderQty: "missing" },
      },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'objects.thing.stock.reorderAt: "level" must be a number field of thing',
        'objects.thing.stock.reorderQty: "missing" must be a number field of thing',
        'objects.thing.fields.onHand: "onHand" is a value the host adds to an object with stock; rename the field',
        "objects.thing.stock: An object has stock or a capacity, not both: stock keeps its own counter",
      ]),
    );
  });

  it("refuses a deposit, and lowAt without show: low", () => {
    const issues = issuesOf({
      thing: {
        ...base,
        sellable: { price: "price", deposit: { amount: "price", balanceDue: "due" } },
        stock: { lowAt: 2 },
      },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        "objects.thing.sellable.deposit: A thing in stock is sold whole, on an order: it has no sellable.deposit",
        'objects.thing.stock.lowAt: lowAt is the threshold of show: "low"',
      ]),
    );
  });

  it("a runtime extension cannot declare it; a shipped one can", async () => {
    const id = extId("rt");
    const m = shopManifest(id);
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, m, now, { source: "runtime" });
    expect(runtime.plan).toBeNull();
    expect(runtime.issues).toContainEqual(
      expect.objectContaining({
        code: "outside_audience",
        path: "objects.variant.stock",
        message: expect.stringMatching(/^A runtime extension cannot give variant stock/),
      }),
    );
    const shipped = await checkManifest(db.query, id, m, now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });
});

// --- Opening stock and the ledger -----------------------------------------------------------------

describe("opening stock and corrections", () => {
  it("an item's three variants each start at nothing, take their opening stock, and show it", async () => {
    const variants = [];
    for (const [name, quantity] of [
      ["Small", 5],
      ["Medium", 12],
      ["Large", 7],
    ] as const) {
      const id = await create(VARIANT, { name: `Hoodie ${name}`, price: 60, reorderLevel: 3 });
      expect(await stockOf(VARIANT, id)).toMatchObject({ onHand: 0, available: 0 });
      await opening(VARIANT, id, quantity);
      variants.push({ id, quantity });
    }
    for (const { id, quantity } of variants) {
      expect(await stockOf(VARIANT, id)).toEqual({
        object: VARIANT,
        id,
        status: "in_stock",
        onHand: quantity,
        held: 0,
        available: quantity,
        reorderAt: 3,
        reorderQty: null,
        atReorderLevel: false,
        show: "availability",
        lowAt: null,
      });
      expect(await movements(VARIANT, id)).toEqual([
        expect.objectContaining({
          quantity,
          kind: "opening",
          place: "default",
          sourceType: "user",
          sourceId: admin.id,
          by: admin.id,
        }),
      ]);
      // The record carries its numbers as read-only values.
      const record = await run<{ values: Record<string, unknown> }>(
        "record.get",
        { object: VARIANT, id },
        context(member),
      );
      expect(record.values).toMatchObject({ onHand: quantity, held: 0, available: quantity });
    }
  });

  it("opening stock is once per record, whichever way it is written", async () => {
    const id = await variantWith(4);
    expect(await refusal(opening(VARIANT, id, 2))).toMatchObject({
      code: "conflict",
      details: { rule: "stock", reason: "opening_exists" },
    });
    // Past the operation's own read, the database refuses it too.
    const second = movementStatements(
      {
        object: VARIANT,
        record: id,
        quantity: 2,
        kind: "opening",
        source: { type: "user", id: admin.id },
        by: admin.id,
      },
      new Date().toISOString(),
    );
    expect(second.statements).toHaveLength(MOVEMENT_STATEMENTS);
    await expect(db.batch(second.statements)).rejects.toThrow(/core_stock_opening_exists/);
    expect((await stockOf(VARIANT, id)).onHand).toBe(4);
  });

  it("a correction moves on hand by its quantity, with its reason in the ledger", async () => {
    const id = await variantWith(10, { reorderLevel: 8 });
    await run(
      "stock.adjust",
      { object: VARIANT, id, quantity: -3, reason: "Damaged in the stockroom" },
      context(admin),
    );
    expect(await stockOf(VARIANT, id)).toMatchObject({
      onHand: 7,
      available: 7,
      atReorderLevel: true,
    });
    expect((await movements(VARIANT, id))[0]).toMatchObject({
      quantity: -3,
      kind: "adjusted",
      note: "Damaged in the stockroom",
    });
  });

  it("refuses a correction below what unpaid orders hold, with the numbers", async () => {
    const id = await variantWith(5);
    await startAsGuest([{ object: VARIANT, id, quantity: 4 }]);
    expect(
      await refusal(
        run("stock.adjust", { object: VARIANT, id, quantity: -2, reason: "Count" }, context(admin)),
      ),
    ).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock", onHand: 5, held: 4 },
    });
    // Past the operation's own read, the counter refuses it at commit.
    const below = movementStatements(
      {
        object: VARIANT,
        record: id,
        quantity: -2,
        kind: "adjusted",
        source: { type: "user", id: admin.id },
        by: admin.id,
      },
      new Date().toISOString(),
    );
    await expect(db.batch(below.statements)).rejects.toThrow(/core_capacity_refused/);
    expect(await stockOf(VARIANT, id)).toMatchObject({ onHand: 5, held: 4, available: 1 });
    expect(await movements(VARIANT, id)).toHaveLength(1);
  });

  it("needs stock:adjust: a member is refused, a grant opens it", async () => {
    const id = await variantWith(3);
    const clerk = await createUser("member");
    const adjust = () =>
      run("stock.adjust", { object: VARIANT, id, quantity: 1, reason: "Found" }, context(clerk));
    expect((await refusal(adjust())).code).toBe("forbidden");
    await run(
      "user.setPermissions",
      { id: clerk.id, permissions: ["stock:adjust"] },
      context(admin),
    );
    await adjust();
    expect((await stockOf(VARIANT, id)).onHand).toBe(4);
  });

  it("an AI's correction waits for a person who holds stock:adjust", async () => {
    const id = await variantWith(3);
    const asMcp = context(admin, {
      actor: "mcp",
      origin: {
        surface: "mcp",
        clientId: "client-1",
        clientName: "Test client",
        sessionId: unique("mcp"),
      },
    });
    const queued = await run(
      "stock.adjust",
      { object: VARIANT, id, quantity: 5, reason: "Found" },
      asMcp,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(queued).toBeInstanceOf(PendingApprovalError);
    const actionId = (queued as PendingApprovalError).pending.actionId;
    expect((await stockOf(VARIANT, id)).onHand).toBe(3);
    // A member without the permission cannot approve it.
    expect(
      (await refusal(run("approval.approve", { actionIds: [actionId] }, context(member)))).code,
    ).toBe("forbidden");
    await run("approval.approve", { actionIds: [actionId] }, context(admin));
    expect((await stockOf(VARIANT, id)).onHand).toBe(8);
  });
});

// --- What outsiders see ---------------------------------------------------------------------------

describe("stock.get for customers and the public", () => {
  it("tells them in stock or sold out, never the numbers, by default", async () => {
    const id = await variantWith(2);
    expect(await stockOf(VARIANT, id, outside(PUBLIC))).toEqual({
      object: VARIANT,
      id,
      status: "in_stock",
    });
    const empty = await variantWith(0);
    expect(await stockOf(VARIANT, empty, outside(alice.principal))).toEqual({
      object: VARIANT,
      id: empty,
      status: "sold_out",
    });
  });

  it("says only N left at or below lowAt when the object shows low", async () => {
    const drink = await create(DRINK, { name: unique("Water"), price: 3 });
    await opening(DRINK, drink, 5);
    expect(await stockOf(DRINK, drink, outside(PUBLIC))).toEqual({
      object: DRINK,
      id: drink,
      status: "in_stock",
    });
    await run(
      "stock.adjust",
      { object: DRINK, id: drink, quantity: -2, reason: "Drunk" },
      context(admin),
    );
    expect(await stockOf(DRINK, drink, outside(PUBLIC))).toEqual({
      object: DRINK,
      id: drink,
      status: "low",
      available: 3,
    });
  });

  it("a customer cannot read the ledger or change stock", async () => {
    const id = await variantWith(2);
    for (const name of ["stock.movements", "stock.adjust", "stock.opening"]) {
      const answer = await refusal(
        run(name, { object: VARIANT, id, quantity: 1, reason: "x" }, outside(alice.principal)),
      );
      expect(answer.code, name).toBe("unknown_operation");
    }
  });
});

// --- Orders ----------------------------------------------------------------------------------

describe("an order's stock", () => {
  it("holds while unpaid, sells when paid (one sold movement per line), and a refund changes nothing", async () => {
    const small = await variantWith(5);
    const large = await variantWith(3);
    const pass = await create(PASS, { name: unique("Ten classes"), price: 150 });
    const order = await startAsGuest([
      { object: VARIANT, id: small, quantity: 2 },
      { object: VARIANT, id: large },
      { object: PASS, id: pass },
    ]);
    expect(await stockOf(VARIANT, small)).toMatchObject({ onHand: 5, held: 2, available: 3 });
    expect(await movements(VARIANT, small)).toHaveLength(1);

    await pay(order);
    expect(await stockOf(VARIANT, small)).toMatchObject({ onHand: 3, held: 0, available: 3 });
    expect(await stockOf(VARIANT, large)).toMatchObject({ onHand: 2, held: 0, available: 2 });
    const { results: lines } = await env.DB.prepare(
      "SELECT id, record_id FROM core_order_line WHERE order_id = ?",
    )
      .bind(order.id)
      .all<{ id: string; record_id: string }>();
    const lineOf = (record: string) => lines.find((l) => l.record_id === record)?.id;
    expect((await movements(VARIANT, small))[0]).toMatchObject({
      quantity: -2,
      kind: "sold",
      place: "default",
      sourceType: "order_line",
      sourceId: lineOf(small),
      by: null,
    });
    expect((await movements(VARIANT, large))[0]).toMatchObject({
      quantity: -1,
      kind: "sold",
      sourceId: lineOf(large),
    });

    // The ledger's sum is on hand.
    const sum = await env.DB.prepare(
      "SELECT sum(quantity) AS n FROM core_stock_movement WHERE object_type = ? AND record_id = ?",
    )
      .bind(VARIANT, small)
      .first<{ n: number }>();
    expect(sum?.n).toBe(3);

    await moveOrder(order.id, "refunded");
    expect(await stockOf(VARIANT, small)).toMatchObject({ onHand: 3, held: 0, available: 3 });
    expect(await movements(VARIANT, small)).toHaveLength(2);
  });

  it("an expired or cancelled order gives its units back, with no movement", async () => {
    const id = await variantWith(4);
    const expiring = await startAsGuest([{ object: VARIANT, id, quantity: 3 }]);
    expect((await stockOf(VARIANT, id)).available).toBe(1);
    await moveOrder(expiring.id, "expired");
    expect(await stockOf(VARIANT, id)).toMatchObject({ onHand: 4, held: 0, available: 4 });

    const cancelled = await startAsGuest([{ object: VARIANT, id, quantity: 4 }]);
    expect((await stockOf(VARIANT, id)).available).toBe(0);
    await moveOrder(cancelled.id, "cancelled");
    expect((await stockOf(VARIANT, id)).available).toBe(4);
    expect(await movements(VARIANT, id)).toHaveLength(1);

    // Paid late, staff honouring it: taken again and sold.
    await pay(expiring);
    await run("order.honourLate", { id: expiring.id }, context(admin));
    expect(await stockOf(VARIANT, id)).toMatchObject({ onHand: 1, held: 0, available: 1 });
    expect((await movements(VARIANT, id))[0]).toMatchObject({ kind: "sold", quantity: -3 });
  });

  it("refuses more than is available on every path, and two buyers of the last unit get one", async () => {
    const id = await variantWith(1);
    const tooMany = [{ object: VARIANT, id, quantity: 2 }];
    expect(await refusal(startAsGuest(tooMany))).toMatchObject({
      code: "invalid_input",
      message: "There are not enough in stock",
      details: { rule: "stock" },
    });
    expect(
      await refusal(
        run("order.start", { lines: tooMany, email: "desk@buyers.example" }, context(member)),
      ),
    ).toMatchObject({
      code: "invalid_input",
      details: { rule: "stock", asked: 2, available: 1 },
    });
    expect(
      await refusal(run("order.start", { lines: tooMany }, outside(alice.principal))),
    ).toMatchObject({ code: "invalid_input", details: { rule: "stock" } });

    const last = [{ object: VARIANT, id }];
    const settled = await Promise.allSettled([
      startAsGuest(last),
      run<OrderOut>("order.start", { lines: last }, outside(alice.principal)),
      run<OrderOut>("order.start", { lines: last, email: "desk@buyers.example" }, context(member)),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(VARIANT, id)).toMatchObject({ onHand: 1, held: 1, available: 0 });
    // Sold out is said as sold out.
    expect(await stockOf(VARIANT, id, outside(PUBLIC))).toMatchObject({ status: "sold_out" });
  });
});

// --- The ledger is append-only --------------------------------------------------------------------

describe("the ledger", () => {
  it("no movement can be changed or deleted, by any statement shape", async () => {
    const id = await variantWith(6);
    const [row] = (
      await env.DB.prepare("SELECT * FROM core_stock_movement WHERE record_id = ?")
        .bind(id)
        .all<Record<string, unknown>>()
    ).results;
    const movement = row as Record<string, unknown>;
    const shapes = [
      env.DB.prepare("UPDATE core_stock_movement SET quantity = 60 WHERE id = ?").bind(movement.id),
      env.DB.prepare("UPDATE OR REPLACE core_stock_movement SET note = 'x' WHERE id = ?").bind(
        movement.id,
      ),
      env.DB.prepare("DELETE FROM core_stock_movement WHERE id = ?").bind(movement.id),
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_stock_movement (id, object_type, record_id, quantity, kind, source_type, source_id, at) VALUES (?, ?, ?, 60, 'adjusted', 'user', 'x', ?)",
      ).bind(movement.id, VARIANT, id, movement.at),
      env.DB.prepare(
        "REPLACE INTO core_stock_movement (id, object_type, record_id, quantity, kind, source_type, source_id, at) VALUES (?, ?, ?, 60, 'adjusted', 'user', 'x', ?)",
      ).bind(movement.id, VARIANT, id, movement.at),
      env.DB.prepare(
        "INSERT INTO core_stock_movement (id, object_type, record_id, quantity, kind, source_type, source_id, at) VALUES (?, ?, ?, 60, 'adjusted', 'user', 'x', ?) ON CONFLICT (id) DO UPDATE SET quantity = 60",
      ).bind(movement.id, VARIANT, id, movement.at),
    ];
    for (const shape of shapes) {
      await expect(shape.run()).rejects.toThrow(/core_stock_movement_immutable/);
    }
    const after = await env.DB.prepare("SELECT * FROM core_stock_movement WHERE id = ?")
      .bind(movement.id)
      .first();
    expect(after).toEqual(movement);
  });
});

// --- Cost -------------------------------------------------------------------------------------------

describe("what a paid order's confirm costs", () => {
  let queries = 0;
  const metered = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (p === "all" || p === "run" || p === "first" || p === "raw") {
                  return async (...args: unknown[]) => {
                    queries += 1;
                    return (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                  };
                }
                const value = Reflect.get(s, p);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          return wrap(target.prepare(query));
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          queries += statements.length;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const meteredDb = createCrmDb(metered);
  const { invokeByName } = createInvoker(orderRegistry);

  async function paidCost(lines: number): Promise<number> {
    const ids: string[] = [];
    for (let i = 0; i < lines; i++) ids.push(await variantWith(3));
    const order = await startAsGuest(ids.map((id) => ({ object: VARIANT, id })));
    queries = 0;
    await invokeByName(
      "fixture.verifiedPayment",
      { orderId: order.id, amount: order.total, eventId: unique("evt") },
      context(admin, { actor: "automation", db: meteredDb }),
    );
    for (const id of ids) expect((await stockOf(VARIANT, id)).onHand).toBe(2);
    return queries;
  }

  it("is the same number of statements for 2 lines as for 50, well under D1's limit", async () => {
    const two = await paidCost(2);
    const fifty = await paidCost(50);
    expect(fifty).toBe(two);
    expect(fifty).toBeLessThan(100);
  });
});
