// Stage 37 step 1: the `stock` behaviour (ADR 0682), against a fixture shop and the payments
// gatekeeper's test double. The acceptance criteria this step covers: 1 (opening stock per
// variant, stock.get, the ledger's opening movements at the default place), 3 (paying holds the
// stock; the last unit is refused by the database to a second buyer, whatever the path), 4
// (cancelled or expired gives the units back, paid writes `sold`, a refund alone changes
// nothing), 10's host half (sold out shows as sold out and order.start refuses), 16 (no movement
// can be changed or deleted, by any statement shape), 17's stock half (an AI's adjustment waits
// for a person), 19's stock half (a runtime extension declaring stock is refused) and 20's (a
// paid order's confirm is a bounded number of statements, whatever the number of lines).
import { env } from "cloudflare:workers";
import type { CrmDb } from "@composable-os/db";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  checkManifest,
  loadOrderRow,
  MOVEMENT_STATEMENTS,
  memoryEventSink,
  movementStatements,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SHOP = extId("stk");
const VARIANT = `${SHOP}.variant`;
const DRINK = `${SHOP}.drink`;
const KIT = `${SHOP}.kit`;
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;
const RETURN = "https://shop.example.com/thanks";

let events: ReturnType<typeof memoryEventSink>;
/** The size of every batch the host applies a payment with. */
const batches: number[] = [];
const counting: CrmDb = {
  query: db.query,
  async batch(statements) {
    batches.push(statements.length);
    return db.batch(statements);
  },
};
const payments = paymentsDouble(
  () => events,
  () => counting,
);
const { gw, runtime, providerPays, providerRefunds } = payments;

let admin: ActingUser;
const staff = (user?: ActingUser, extra: Record<string, unknown> = {}) =>
  context(user ?? admin, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });
const asMcp = () =>
  staff(admin, {
    actor: "mcp",
    origin: {
      surface: "mcp",
      clientId: "client-1",
      clientName: "Test client",
      sessionId: `stk_${unique()}`,
    },
  });

interface OrderOut {
  id: string;
  state: string;
  token?: string | null;
}

interface StockOut {
  status: string;
  onHand?: number;
  held?: number;
  available?: number;
  low?: boolean;
  reorderAt?: number | null;
  movements?: { kind: string; quantity: number; place: string; source: unknown }[];
}

function shop(id: string): ExtensionManifest {
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
          reorderQuantity: { type: "number", label: "Reorder quantity" },
        },
        sellable: { price: "price" },
        stock: { reorderAt: "reorderLevel", reorderQty: "reorderQuantity" },
        public: { read: ["name", "price"] },
      },
      kit: {
        label: "Kit",
        plural: "Kits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
          balanceDue: { type: "date", label: "Balance due" },
        },
        sellable: {
          price: "price",
          deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
        },
        stock: {},
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
    },
  });
}

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, staff())).id;
}

/** A variant with `opening` units of opening stock (none when 0). */
async function variant(opening: number, values: Record<string, unknown> = {}, object = VARIANT) {
  const id = await create(object, { name: unique("Hoodie"), price: 40, ...values });
  if (opening > 0) await run("stock.opening", { object, id, quantity: opening }, staff());
  return id;
}

async function stock(id: string, object = VARIANT, ctx: Parameters<typeof run>[2] = staff()) {
  return run<StockOut>("stock.get", { object, id }, ctx);
}

async function counter(id: string, object = VARIANT) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, id)
    .first<{ places: number; held: number; taken: number }>();
}

async function movements(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, quantity, place_id, source_type, source_id, made_by, made_as FROM core_stock_movement WHERE record_id = ? ORDER BY created_at, id",
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return results;
}

async function startAsGuest(lines: { object?: string; id: string; quantity?: number }[]) {
  return run<OrderOut>(
    "order.start",
    {
      lines: lines.map((l) => ({ object: VARIANT, ...l })),
      email: `${unique("guest")}@buyers.example`,
    },
    guest(),
  );
}

async function pay(order: OrderOut) {
  await run(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN },
    outside(PUBLIC, { integrations: runtime, events }),
  );
  return providerPays(order.id);
}

const state = async (id: string) => (await loadOrderRow(db.query, id)).state;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(shop(SHOP));
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    staff(),
  );
  await payments.connect(admin.id);
});

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
});

// --- The declaration -----------------------------------------------------------------------------

describe("declaring stock", () => {
  const object = (extra: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
    manifest(extId("dcl"), {
      objects: {
        thing: {
          label: "Thing",
          plural: "Things",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            places: { type: "number", label: "Places" },
            level: { type: "text", label: "Level" },
            ...fields,
          },
          ...extra,
        },
      },
    });
  const messages = (m: ExtensionManifest) => {
    return validateManifest(m).issues.map((i) => `${i.path}: ${i.message}`);
  };

  it("is refused where it cannot be what an order holds and sells", () => {
    expect(messages(object({ stock: {} }))).toContainEqual(
      expect.stringMatching(/^objects\.thing\.stock: thing must be sellable/),
    );
    expect(
      messages(
        object({
          sellable: { price: "price" },
          capacity: { places: "places" },
          stock: {},
        }),
      ),
    ).toContainEqual(expect.stringMatching(/places or stock, not both/));
    expect(
      messages(object({ sellable: { price: "price" }, stock: { reorderAt: "level" } })),
    ).toContainEqual('objects.thing.stock.reorderAt: "level" must be a number field of thing');
    expect(
      messages(
        object(
          { sellable: { price: "price" }, stock: {} },
          { onHand: { type: "number", label: "On hand" } },
        ),
      ),
    ).toContainEqual(expect.stringMatching(/^objects\.thing\.fields\.onHand: "onHand" is a value/));
    expect(
      messages(object({ sellable: { price: "price" }, stock: { show: "low" } })),
    ).toContainEqual(expect.stringMatching(/show: "low" needs lowAt/));
    expect(messages(object({ sellable: { price: "price" }, stock: { lowAt: 2 } }))).toContainEqual(
      expect.stringMatching(/lowAt is the threshold/),
    );
    expect(messages(object({ sellable: { price: "price" }, stock: {} }))).toEqual([]);
  });

  it("a runtime extension cannot declare it: selling goods is a reviewed change", async () => {
    const id = extId("rt");
    const now = new Date().toISOString();
    const runtimeCheck = await checkManifest(db.query, id, shop(id), now, { source: "runtime" });
    expect(runtimeCheck.issues).toContainEqual({
      stage: "contract",
      code: "outside_audience",
      path: "objects.variant.stock",
      message: expect.stringMatching(
        /^A runtime extension cannot declare variant goods the host counts and sells\./,
      ),
    });
    const shipped = await checkManifest(db.query, id, shop(id), now, { source: "shipped" });
    expect(shipped.issues).toEqual([]);
  });
});

// --- Criterion 1 ---------------------------------------------------------------------------------

describe("opening stock and stock.get (criterion 1)", () => {
  it("three variants with opening stock: on hand per variant, an opening movement each, at the default place", async () => {
    const counts = [5, 12, 1];
    const ids: string[] = [];
    for (const n of counts) ids.push(await variant(n, { reorderLevel: 4 }));
    for (const [i, id] of ids.entries()) {
      const read = await stock(id);
      expect(read).toMatchObject({
        onHand: counts[i],
        held: 0,
        available: counts[i],
        status: "in_stock",
        reorderAt: 4,
        low: (counts[i] as number) <= 4,
      });
      expect(read.movements).toEqual([
        expect.objectContaining({ kind: "opening", quantity: counts[i], place: "default" }),
      ]);
      // The record carries the same numbers, read-only.
      const record = await run<{ values: Record<string, unknown> }>(
        "record.get",
        { object: VARIANT, id },
        staff(),
      );
      expect(record.values).toMatchObject({ onHand: counts[i], held: 0, available: counts[i] });
    }
    const ledger = await movements(ids[0] as string);
    expect(ledger).toEqual([
      expect.objectContaining({ kind: "opening", place_id: "default", made_by: admin.id }),
    ]);
  });

  it("a second opening is refused; a correction is an adjustment, with its reason", async () => {
    const id = await variant(10);
    const again = await refusal(
      run("stock.opening", { object: VARIANT, id, quantity: 3 }, staff()),
    );
    expect(again.details).toMatchObject({ rule: "stock", reason: "opening_given" });
    await run(
      "stock.adjust",
      { object: VARIANT, id, quantity: -2, reason: "Two damaged" },
      staff(),
    );
    await run("stock.adjust", { object: VARIANT, id, quantity: 1, reason: "Found one" }, staff());
    expect(await stock(id)).toMatchObject({ onHand: 9, available: 9 });
    const listed = await run<{ items: { kind: string; quantity: number; note: string }[] }>(
      "stock.movements",
      { object: VARIANT, id },
      staff(),
    );
    expect(listed.items.map((m) => [m.kind, m.quantity])).toEqual([
      ["adjusted", 1],
      ["adjusted", -2],
      ["opening", 10],
    ]);
  });

  it("nobody types on hand: the stock values are the host's", async () => {
    const id = await variant(3);
    const refused = await refusal(
      run("record.update", { object: VARIANT, id, values: { onHand: 100 } }, staff()),
    );
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toMatch(/stock\.opening .* stock\.adjust/);
    expect(refused.details).toMatchObject({ field: "onHand", rule: "stock" });
    expect(await stock(id)).toMatchObject({ onHand: 3 });
  });

  it("stock.movements pages newest first", async () => {
    const id = await variant(1);
    for (let i = 0; i < 4; i++) {
      await run("stock.adjust", { object: VARIANT, id, quantity: 1, reason: `+${i}` }, staff());
    }
    const first = await run<{ items: { note: string }[]; nextCursor: string | null }>(
      "stock.movements",
      { object: VARIANT, id, limit: 3 },
      staff(),
    );
    expect(first.items).toHaveLength(3);
    const second = await run<{ items: { kind: string }[]; nextCursor: string | null }>(
      "stock.movements",
      { object: VARIANT, id, limit: 3, cursor: first.nextCursor },
      staff(),
    );
    expect(second.items.map((m) => m.kind)).toEqual(["adjusted", "opening"]);
    expect(second.nextCursor).toBeNull();
  });
});

// --- Criteria 3, 4 and 10 ------------------------------------------------------------------------

describe("orders hold, sell and never restock on a refund (criteria 3, 4 and 10)", () => {
  it("paying holds the units; paid writes one `sold` movement per line, naming the order line", async () => {
    const id = await variant(5);
    const order = await startAsGuest([{ id, quantity: 2 }]);
    expect(await stock(id)).toMatchObject({ onHand: 5, held: 2, available: 3 });
    await pay(order);
    expect(await state(order.id)).toBe("paid");
    expect(await stock(id)).toMatchObject({ onHand: 3, held: 0, available: 3 });
    const sold = (await movements(id)).filter((m) => m.kind === "sold");
    const [line] = (
      await env.DB.prepare("SELECT id FROM core_order_line WHERE order_id = ?")
        .bind(order.id)
        .all<{ id: string }>()
    ).results;
    expect(sold).toEqual([
      expect.objectContaining({
        quantity: -2,
        place_id: "default",
        source_type: "order_line",
        source_id: line?.id,
        made_by: null,
        made_as: "host",
      }),
    ]);
    // The ledger sums to on hand.
    const sum = (await movements(id)).reduce((n, m) => n + Number(m.quantity), 0);
    expect(sum).toBe(3);
  });

  it("the last unit goes to one buyer; the other is refused by the database, on every path", async () => {
    const id = await variant(1);
    const buyer = await createBuyer(admin);
    const tries = await Promise.allSettled([
      startAsGuest([{ id }]),
      run<OrderOut>(
        "order.start",
        { lines: [{ object: VARIANT, id }], email: `${unique("desk")}@buyers.example` },
        staff(),
      ),
      run<OrderOut>(
        "order.start",
        { lines: [{ object: VARIANT, id }], email: `${unique("desk")}@buyers.example` },
        asMcp(),
      ),
      // The app's path: a signed-in customer.
      run<OrderOut>(
        "order.start",
        { lines: [{ object: VARIANT, id }] },
        outside(buyer.principal, { integrations: runtime, events }),
      ),
    ]);
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    for (const refused of tries.filter((t) => t.status === "rejected")) {
      const error = (refused as PromiseRejectedResult).reason as {
        code: string;
        details: Record<string, unknown>;
      };
      expect(error.code).toBe("invalid_input");
      // Staff are told the numbers; a buyer only that it is sold out.
      expect(error.details).toMatchObject({ rule: "stock", record: id });
    }
    expect(await counter(id)).toMatchObject({ places: 1, held: 1, taken: 0 });
  });

  it("sold out shows as sold out, and order.start refuses it (criterion 10)", async () => {
    const id = await variant(1);
    await pay(await startAsGuest([{ id }]));
    expect(await stock(id, VARIANT, guest())).toEqual({ object: VARIANT, id, status: "sold_out" });
    const refused = await refusal(startAsGuest([{ id }]));
    expect(refused.message).toBe("Sold out");
    expect(refused.details).toEqual({ rule: "stock", record: id, status: "sold_out" });
    // Staff are told the numbers.
    const desk = await refusal(
      run(
        "order.start",
        { lines: [{ object: VARIANT, id }], email: `${unique("desk")}@buyers.example` },
        staff(),
      ),
    );
    expect(desk.message).toBe("Sold out: asked for 1, none available");
    expect(desk.details).toEqual({
      rule: "stock",
      object: VARIANT,
      record: id,
      asked: 1,
      available: 0,
    });
    // A variant with nothing in stock yet is sold out too.
    const none = await variant(0);
    expect((await refusal(startAsGuest([{ id: none }]))).details).toMatchObject({ rule: "stock" });
  });

  it("a cancelled or expired order gives its units back, and writes nothing", async () => {
    const id = await variant(4);
    const cancelled = await startAsGuest([{ id, quantity: 2 }]);
    await run("order.cancel", { id: cancelled.id }, staff());
    expect(await stock(id)).toMatchObject({ onHand: 4, held: 0, available: 4 });

    const expiring = await startAsGuest([{ id, quantity: 3 }]);
    expect(await stock(id)).toMatchObject({ held: 3, available: 1 });
    const later = new Date(Date.now() + 16 * 60_000);
    const swept = await run<{ expired: string[] }>(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => later }),
    );
    expect(swept.expired).toContain(expiring.id);
    expect(await stock(id)).toMatchObject({ onHand: 4, held: 0, available: 4 });
    expect((await movements(id)).map((m) => m.kind)).toEqual(["opening"]);
  });

  it("an expired order paid late and honoured takes its units again, and sells them", async () => {
    const id = await variant(2);
    const order = await startAsGuest([{ id }]);
    await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
    const later = new Date(Date.now() + 16 * 60_000);
    await run("order.expireDue", {}, staff(admin, { actor: "automation", clock: () => later }));
    await providerPays(order.id);
    expect(await state(order.id)).toBe("expired");
    await run("order.honourLate", { id: order.id }, staff());
    expect(await state(order.id)).toBe("paid");
    expect(await stock(id)).toMatchObject({ onHand: 1, held: 0, available: 1 });
    expect((await movements(id)).map((m) => [m.kind, m.quantity])).toEqual([
      ["opening", 2],
      ["sold", -1],
    ]);
  });

  it("a deposit holds the goods; only the balance sells them", async () => {
    const id = await variant(5, { depositAmount: 10, balanceDue: NEXT_YEAR }, KIT);
    const order = await run<OrderOut>(
      "order.start",
      {
        lines: [{ object: KIT, id, quantity: 2 }],
        email: `${unique("guest")}@buyers.example`,
        pay: "deposit",
      },
      guest(),
    );
    await pay(order);
    expect(await state(order.id)).toBe("part_paid");
    expect(await stock(id, KIT)).toMatchObject({ onHand: 5, held: 2, available: 3 });
    expect((await movements(id)).map((m) => m.kind)).toEqual(["opening"]);
    await pay(order);
    expect(await state(order.id)).toBe("paid");
    expect(await stock(id, KIT)).toMatchObject({ onHand: 3, held: 0, available: 3 });
    expect((await movements(id)).map((m) => [m.kind, m.quantity])).toEqual([
      ["opening", 5],
      ["sold", -2],
    ]);
  });

  it("cancelling a part-paid order gives its goods back, with no movement", async () => {
    const id = await variant(5, { depositAmount: 10, balanceDue: NEXT_YEAR }, KIT);
    const order = await run<OrderOut>(
      "order.start",
      {
        lines: [{ object: KIT, id, quantity: 2 }],
        email: `${unique("guest")}@buyers.example`,
        pay: "deposit",
      },
      guest(),
    );
    await pay(order);
    expect(await state(order.id)).toBe("part_paid");
    await run("order.cancel", { id: order.id }, staff());
    expect(await state(order.id)).toBe("cancelled");
    expect(await stock(id, KIT)).toMatchObject({ onHand: 5, held: 0, available: 5 });
    expect(await counter(id, KIT)).toMatchObject({ places: 5, held: 0, taken: 0 });
    expect((await movements(id)).map((m) => m.kind)).toEqual(["opening"]);
  });

  it("a refund alone leaves stock as it is: no movement, nothing back on sale", async () => {
    const id = await variant(3);
    const order = await startAsGuest([{ id }]);
    await pay(order);
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "Changed their mind" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    expect(await state(order.id)).toBe("refunded");
    expect(await stock(id)).toMatchObject({ onHand: 2, held: 0, available: 2 });
    expect(await counter(id)).toMatchObject({ places: 3, taken: 1 });
    expect((await movements(id)).map((m) => m.kind)).toEqual(["opening", "sold"]);
  });
});

// --- Adjustments and what the database refuses ---------------------------------------------------

describe("adjustments", () => {
  it("a removal below what unpaid orders hold is refused with the numbers", async () => {
    const id = await variant(5);
    await startAsGuest([{ id, quantity: 4 }]);
    const refused = await refusal(
      run("stock.adjust", { object: VARIANT, id, quantity: -2, reason: "Miscount" }, staff()),
    );
    expect(refused.message).toMatch(/fewer on hand than unpaid orders hold/);
    expect(refused.details).toEqual({
      rule: "stock",
      object: VARIANT,
      record: id,
      onHand: 5,
      held: 4,
      removing: 2,
    });
    await run("stock.adjust", { object: VARIANT, id, quantity: -1, reason: "Miscount" }, staff());
    expect(await stock(id)).toMatchObject({ onHand: 4, held: 4, available: 0 });
  });

  it("an AI's adjustment or opening waits for a person, and is judged again when approved (criterion 17)", async () => {
    const id = await variant(0);
    const opening = await run("stock.opening", { object: VARIANT, id, quantity: 6 }, asMcp()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(opening).toBeInstanceOf(PendingApprovalError);
    const adjust = await run(
      "stock.adjust",
      { object: VARIANT, id, quantity: 2, reason: "A guess" },
      asMcp(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(adjust).toBeInstanceOf(PendingApprovalError);
    expect(await stock(id)).toMatchObject({ onHand: 0 });
    // The dry run says now what the database would refuse: nothing is queued.
    const below = await refusal(
      run("stock.adjust", { object: VARIANT, id, quantity: -1, reason: "A guess" }, asMcp()),
    );
    expect(below.details).toMatchObject({ rule: "stock", onHand: 0, held: 0, removing: 1 });
    await run(
      "approval.approve",
      { actionIds: [(opening as PendingApprovalError).pending.actionId] },
      staff(),
    );
    expect(await stock(id)).toMatchObject({ onHand: 6 });
  });

  it("a removal is a whole number of units; zero is refused", async () => {
    const id = await variant(2);
    const zero = await refusal(
      run("stock.adjust", { object: VARIANT, id, quantity: 0, reason: "x" }, staff()),
    );
    expect(zero.code).toBe("invalid_input");
  });

  it("stock.get and stock.movements on an object without stock, or a record not there, are refused", async () => {
    expect((await refusal(stock("rec_missing"))).code).toBe("not_found");
    expect(
      (await refusal(run("stock.movements", { object: VARIANT, id: "rec_missing" }, staff()))).code,
    ).toBe("not_found");
    expect((await refusal(stock("x", "person"))).code).toBe("invalid_input");
  });
});

// --- What outsiders are told ---------------------------------------------------------------------

describe("what customers and the public see", () => {
  it("availability by default: in stock or sold out, never a number", async () => {
    const id = await variant(7);
    const buyer = await createBuyer(admin);
    for (const ctx of [guest(), outside(buyer.principal)]) {
      expect(await stock(id, VARIANT, ctx)).toEqual({ object: VARIANT, id, status: "in_stock" });
    }
  });

  it("low: 'only N left' at or below lowAt, nothing above it", async () => {
    const id = await variant(5, {}, DRINK);
    expect(await stock(id, DRINK, guest())).toEqual({ object: DRINK, id, status: "in_stock" });
    await run("stock.adjust", { object: DRINK, id, quantity: -2, reason: "Drunk" }, staff());
    expect(await stock(id, DRINK, guest())).toEqual({
      object: DRINK,
      id,
      status: "low",
      available: 3,
    });
  });

  it("outsiders cannot list the ledger", async () => {
    const id = await variant(1);
    const refused = await refusal(run("stock.movements", { object: VARIANT, id }, guest()));
    expect(refused.code).toBe("unknown_operation");
  });
});

// --- Criterion 16 --------------------------------------------------------------------------------

describe("the ledger is append-only (criterion 16)", () => {
  it("no statement shape changes or deletes a movement", async () => {
    const id = await variant(2);
    const [row] = await movements(id);
    const movement = row?.id as string;
    const now = new Date().toISOString();
    const shapes: [string, unknown[]][] = [
      ["UPDATE core_stock_movement SET quantity = 99 WHERE id = ?", [movement]],
      ["UPDATE OR REPLACE core_stock_movement SET quantity = 99 WHERE id = ?", [movement]],
      ["DELETE FROM core_stock_movement WHERE id = ?", [movement]],
      [
        "INSERT OR REPLACE INTO core_stock_movement (id, object_type, record_id, quantity, kind, made_as, created_at) VALUES (?, ?, ?, 99, 'adjusted', 'host', ?)",
        [movement, VARIANT, id, now],
      ],
      [
        "REPLACE INTO core_stock_movement (id, object_type, record_id, quantity, kind, made_as, created_at) VALUES (?, ?, ?, 99, 'adjusted', 'host', ?)",
        [movement, VARIANT, id, now],
      ],
      [
        "INSERT INTO core_stock_movement (id, object_type, record_id, quantity, kind, made_as, created_at) VALUES (?, ?, ?, 99, 'adjusted', 'host', ?) ON CONFLICT (id) DO UPDATE SET quantity = 99",
        [movement, VARIANT, id, now],
      ],
    ];
    for (const [statement, binds] of shapes) {
      await expect(
        env.DB.prepare(statement)
          .bind(...binds)
          .run(),
      ).rejects.toThrow(/core_stock_movement_immutable/);
    }
    // A second opening under a new id: refused, never a REPLACE that deletes the first.
    for (const verb of ["INSERT OR REPLACE INTO", "REPLACE INTO", "INSERT INTO"]) {
      await expect(
        env.DB.prepare(
          `${verb} core_stock_movement (id, object_type, record_id, quantity, kind, made_as, created_at) VALUES (?, ?, ?, 999, 'opening', 'host', ?)`,
        )
          .bind(`smv_${unique("new")}`, VARIANT, id, now)
          .run(),
      ).rejects.toThrow(/core_stock_opening_given/);
    }
    expect(await movements(id)).toEqual([expect.objectContaining({ id: movement, quantity: 2 })]);
  });
});

// --- Criterion 20 --------------------------------------------------------------------------------

describe("bounded statements (criterion 20)", () => {
  it("a movement is two statements, none a read", () => {
    const { statements } = movementStatements(
      db.query,
      {
        object: VARIANT,
        record: "rec_x",
        quantity: 1,
        kind: "adjusted",
        by: { account: "usr_x" },
      },
      new Date().toISOString(),
    );
    expect(statements).toHaveLength(MOVEMENT_STATEMENTS);
    expect(statements.every((s) => !/^\s*SELECT/i.test(s.sql))).toBe(true);
  });

  it("a paid order's batch does not grow with its stock lines", { timeout: 120_000 }, async () => {
    async function paidBatch(lines: number) {
      const ids: string[] = [];
      for (let i = 0; i < lines; i++) ids.push(await variant(3));
      const order = await startAsGuest(ids.map((id) => ({ id })));
      await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
      batches.length = 0;
      await providerPays(order.id);
      expect(await state(order.id)).toBe("paid");
      for (const id of ids) expect(await stock(id)).toMatchObject({ onHand: 2 });
      return Math.max(...batches);
    }
    const one = await paidBatch(1);
    const many = await paidBatch(20);
    expect(many).toBe(one);
  });
});

// --- Switching an object's counter -----------------------------------------------------------------

describe("an object cannot switch between capacity and stock over its records", () => {
  const thing = (id: string, version: string, behaviour: Record<string, unknown>) =>
    manifest(id, {
      version,
      objects: {
        thing: {
          label: "Thing",
          plural: "Things",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            places: { type: "number", label: "Places" },
          },
          sellable: { price: "price" },
          ...behaviour,
        },
      },
    });
  const conflicts = async (m: ExtensionManifest) =>
    (await plan(m)).issues.filter((i) => i.code === "stock_conflict").map((i) => i.path);

  it("capacity to stock, at once or by way of neither, is refused while records have places", async () => {
    const id = extId("swc");
    await reconcile(thing(id, "1.0.0", { capacity: { places: "places" } }));
    await create(`${id}.thing`, { name: "Seven", price: 1, places: 7 });
    expect(await conflicts(thing(id, "1.1.0", { stock: {} }))).toEqual(["objects.thing.stock"]);
    // Dropping the capacity first leaves its counters: adding stock later is refused the same.
    await reconcile(thing(id, "1.1.0", {}));
    expect(await conflicts(thing(id, "1.2.0", { stock: {} }))).toEqual(["objects.thing.stock"]);
  });

  it("stock to capacity is refused once the records have a ledger", async () => {
    const id = extId("sws");
    await reconcile(thing(id, "1.0.0", { stock: {} }));
    const record = await create(`${id}.thing`, { name: "Box", price: 1 });
    // No movement yet: nothing to lose.
    expect(await conflicts(thing(id, "1.1.0", { capacity: { places: "places" } }))).toEqual([]);
    await run("stock.opening", { object: `${id}.thing`, id: record, quantity: 4 }, staff());
    expect(await conflicts(thing(id, "1.1.0", { capacity: { places: "places" } }))).toEqual([
      "objects.thing.capacity",
    ]);
    // Taking stock away and back again keeps the ledger's counters: allowed.
    await reconcile(thing(id, "1.1.0", {}));
    expect(await conflicts(thing(id, "1.2.0", { stock: {} }))).toEqual([]);
  });
});
