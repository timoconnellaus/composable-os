// Stage 34 step 1 (ADRs 0690 and 0691): adjustments on orders and the pricing seam, and staff
// discounts at the desk. Against the real host and the payments gatekeeper's test double:
// each line's net and the order's total after a discount, the amount the checkout asks for and
// its tax shares (criterion 2), a deposit kept and its balance lowered (criterion 9), what a
// refund gives back (the net paid: criterion 23's rule, which a drop-in's refund owed shares),
// and who may give a discount: within the limit at once, over it waiting for a human admin, an
// AI's always waiting, a member without the permission refused (criterion 8).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  applyAdjustments,
  chargeFor,
  loadOrderRow,
  memoryEventSink,
  PendingApprovalError,
  percentOff,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { CURRENCY, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SHOP = extId("adjshop");
/** Declares a product tax code, with a deposit. */
const CLASS = `${SHOP}.class`;
const RETURN = "https://shop.example.com/thanks";
const CODE = "txcd_20060158";
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

interface Line {
  id: string;
  total: number;
  discount: number;
}
interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  discount: number;
  deposit: number | null;
  pay: string;
  token?: string | null;
  lines: Line[];
  adjustments?: {
    id: string;
    kind: string;
    amount: number;
    percent: number | null;
    reason: string | null;
    givenBy: string | null;
    approval: string | null;
  }[];
}
type SentTax = { ref: string; amount: number; taxCode: string };

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays } = payments;
let admin: ActingUser;
/** A member granted `orders:discount`: the desk. */
let desk: ActingUser;
/** A member without it. */
let member: ActingUser;
/** $120.00, deposit $40.00. */
let yoga: string;
/** $45.50. */
let mat: string;

const staff = (user: ActingUser = admin, extra: Record<string, unknown> = {}) =>
  context(user, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

function buy(lines: { id: string; quantity?: number }[], pay = "full") {
  return run<OrderOut>(
    "order.start",
    {
      lines: lines.map((l) => ({ object: CLASS, ...l })),
      email: `${unique("guest")}@buyers.example`,
      pay,
    },
    guest(),
  );
}

const adjust = (input: Record<string, unknown>, ctx = staff(desk)) =>
  run<OrderOut>("order.adjust", input, ctx);
const get = (id: string) => run<OrderOut>("order.get", { id }, staff());

async function checkout(order: OrderOut) {
  return run<{ amount: number; kind: string }>(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN },
    guest(),
  );
}

async function pending(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof PendingApprovalError) return error.pending;
    throw error;
  }
  throw new Error("expected the call to wait for approval");
}

beforeAll(async () => {
  admin = await createUser("admin");
  desk = await createUser("member");
  member = await createUser("member");
  await reconcile(
    manifest(SHOP, {
      objects: {
        class: {
          label: "Class pass",
          plural: "Class passes",
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
            tax: { code: CODE },
          },
          public: { read: ["name", "price", "depositAmount", "balanceDue"] },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    {
      currency: CURRENCY,
      returnOrigins: ["https://shop.example.com"],
      discountLimit: { percent: 20, amount: 10_000 },
    },
    context(admin),
  );
  await run(
    "user.setPermissions",
    { id: desk.id, permissions: ["orders:discount"] },
    context(admin),
  );
  yoga = await create(CLASS, {
    name: "Yoga pass",
    price: 120,
    depositAmount: 40,
    balanceDue: NEXT_YEAR,
  });
  mat = await create(CLASS, {
    name: "Mat hire",
    price: 45.5,
    depositAmount: 10,
    balanceDue: NEXT_YEAR,
  });
  await payments.connect(admin.id);
}, 60_000);

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
  await run("order.settings.update", { tax: false }, context(admin));
});

describe("the adjustment stage of the pricing seam", () => {
  it("spreads an order's amount over its lines in whole units that sum, never below nothing", () => {
    const lines = [
      { id: "a", total: 24_000 },
      { id: "b", total: 4_550 },
      { id: "c", total: 1 },
    ];
    for (const amount of [1, 2, 3, 999, 12_345, 28_550]) {
      const adjusted = applyAdjustments(lines, [{ lineId: null, amount }]);
      expect(adjusted.discount).toBe(amount);
      expect(adjusted.discounts.reduce((s, d) => s + d, 0)).toBe(amount);
      expect(adjusted.total).toBe(28_551 - amount);
      adjusted.discounts.forEach((d, i) => {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(lines[i]?.total ?? 0);
      });
    }
    // A line's own, then the order's over what is left; more than is left is not taken.
    const both = applyAdjustments(lines, [
      { lineId: "b", amount: 4_550 },
      { lineId: null, amount: 100 },
      { lineId: "c", amount: 50 },
    ]);
    expect(both.discounts[1]).toBe(4_550);
    expect(both.discounts[2]).toBeLessThanOrEqual(1);
    expect(both.discount).toBe(both.discounts.reduce((s, d) => s + d, 0));
    // A percentage is rounded down on each line.
    expect(percentOff([999, 1_001], 10)).toBe(99 + 100);
    expect(percentOff([999], 12.5)).toBe(124);
  });
});

describe("a staff discount within the limit (criterion 8)", () => {
  it("applies at once: each line's net, the total, and an adjustment naming who and why", async () => {
    const order = await buy([{ id: yoga, quantity: 2 }, { id: mat }]);
    expect(order).toMatchObject({ total: 28_550, discount: 0 });
    const adjusted = await adjust({ id: order.id, percent: 10, reason: "Regular at the desk" });
    // 10% of 240.00 and of 45.50, rounded down per line.
    expect(adjusted.lines.map((l) => l.discount)).toEqual([2_400, 455]);
    expect(adjusted).toMatchObject({ total: 28_550 - 2_855, discount: 2_855, state: "pending" });
    const read = await get(order.id);
    expect(read.total).toBe(25_695);
    expect(read.adjustments).toEqual([
      expect.objectContaining({
        kind: "staff",
        amount: 2_855,
        percent: 10,
        reason: "Regular at the desk",
        givenBy: desk.id,
        approval: null,
      }),
    ]);
    // The views report it.
    const view = (await env.DB.prepare(
      "SELECT o.discount, sum(l.line_net) AS net FROM rec_order o JOIN rec_order_line l ON l.order_id = o.id WHERE o.id = ?",
    )
      .bind(order.id)
      .first()) as { discount: number; net: number };
    expect(view).toEqual({ discount: 2_855, net: 25_695 });
  });

  it("the checkout asks for the net, and the verified payment of the net makes it paid", async () => {
    const order = await buy([{ id: yoga }]);
    await adjust({ id: order.id, amount: 1_500, reason: "Damaged mat last week" });
    const opened = await checkout(order);
    expect(opened).toMatchObject({ amount: 10_500, kind: "full" });
    await providerPays(order.id);
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({ state: "paid", paid: 10_500 });
  });

  it("the provider's tax shares are the net lines and sum to the charge (criterion 2)", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    const order = await buy([{ id: yoga, quantity: 2 }, { id: mat }]);
    const adjusted = await adjust({ id: order.id, amount: 3_001, reason: "Two-for-one week" });
    await checkout(order);
    const sent = gw.checkouts.filter((c) => c.orderId === order.id).at(-1) as {
      amount: number;
      tax?: { lines: SentTax[] };
    };
    expect(sent.amount).toBe(28_550 - 3_001);
    const lines = sent.tax?.lines ?? [];
    expect(lines.map((l) => l.amount)).toEqual(adjusted.lines.map((l) => l.total - l.discount));
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(sent.amount);
  });

  it("a deposit stays what the record says and the discount comes off the balance (criterion 9)", async () => {
    const order = await buy([{ id: yoga }], "deposit");
    expect(order).toMatchObject({ total: 12_000, deposit: 4_000, pay: "deposit" });
    const adjusted = await adjust({ id: order.id, amount: 2_000, reason: "Staff family" });
    expect(adjusted).toMatchObject({ total: 10_000, deposit: 4_000, pay: "deposit" });
    expect(await checkout(order)).toMatchObject({ amount: 4_000, kind: "deposit" });
    // A deposit a discount leaves at or above the total is not taken: the buyer pays in full.
    const row = await loadOrderRow(db.query, order.id);
    expect(chargeFor({ ...row, total: 4_000 }, 1000)).toMatchObject({
      amount: 4_000,
      kind: "full",
    });
  });

  it("a refund gives back what was paid: the net (criterion 23's rule)", async () => {
    const order = await buy([{ id: yoga }]);
    await adjust({ id: order.id, percent: 15, reason: "Loyal member" });
    await checkout(order);
    await providerPays(order.id);
    const asked = await run<{ refunds: { amount: number }[] }>(
      "order.refund",
      { id: order.id, reason: "Cannot come" },
      staff(),
    );
    expect(asked.refunds.map((r) => r.amount)).toEqual([10_200]);
  });

  it("is taken off again with order.unadjust, and the total goes back up", async () => {
    const order = await buy([{ id: yoga }, { id: mat }]);
    const first = await adjust({ id: order.id, amount: 500, reason: "One" });
    const line = first.lines[1] as Line;
    await adjust({ id: order.id, lineId: line.id, amount: 300, reason: "Two" });
    const read = await get(order.id);
    expect(read.total).toBe(16_550 - 800);
    const one = read.adjustments?.find((a) => a.reason === "One");
    const back = await run<OrderOut>(
      "order.unadjust",
      { id: order.id, adjustmentId: one?.id },
      staff(desk),
    );
    expect(back).toMatchObject({ total: 16_550 - 300, discount: 300 });
    expect(back.lines.map((l) => l.discount)).toEqual([0, 300]);
    expect((await get(order.id)).adjustments?.map((a) => a.reason)).toEqual(["Two"]);
    // The row is kept, marked removed.
    const kept = await env.DB.prepare("SELECT removed_by FROM core_order_adjustment WHERE id = ?")
      .bind(one?.id)
      .first<{ removed_by: string }>();
    expect(kept?.removed_by).toBe(desk.id);
  });
});

describe("what a staff discount cannot do", () => {
  it("is refused without a reason, with nothing to take off, or taking the order to nothing", async () => {
    const order = await buy([{ id: mat }]);
    expect((await refusal(adjust({ id: order.id, amount: 100 }))).code).toBe("invalid_input");
    expect(
      (await refusal(adjust({ id: order.id, amount: 100, percent: 5, reason: "x" }))).code,
    ).toBe("invalid_input");
    expect(
      (await refusal(adjust({ id: order.id, percent: 0.01, reason: "Nothing", lineId: "orl_x" })))
        .code,
    ).toBe("invalid_input");
    const free = await refusal(adjust({ id: order.id, amount: 4_550, reason: "Free" }, staff()));
    expect(free.details.rule).toBe("total");
    expect((await loadOrderRow(db.query, order.id)).total).toBe(4_550);
  });

  it("changes nothing once the payment page is open, or once the order is no longer pending", async () => {
    const order = await buy([{ id: yoga }]);
    await checkout(order);
    const open = await refusal(adjust({ id: order.id, amount: 100, reason: "Late" }));
    expect(open.details.rule).toBe("checkout_open");
    await providerPays(order.id);
    const paid = await refusal(adjust({ id: order.id, amount: 100, reason: "Late" }));
    expect(paid.code).toBe("conflict");
  });

  it("a member without the permission is refused, and so is a viewer", async () => {
    const order = await buy([{ id: yoga }]);
    const viewer = await createUser("viewer");
    for (const user of [member, viewer]) {
      const refused = await refusal(
        adjust({ id: order.id, percent: 5, reason: "Mine" }, staff(user)),
      );
      expect(refused.code).toBe("forbidden");
    }
    expect((await loadOrderRow(db.query, order.id)).total).toBe(12_000);
  });

  it("no caller can give one through order.start or a customer's call", async () => {
    const order = await buy([{ id: yoga }]);
    const refused = await refusal(
      run(
        "order.adjust",
        { id: order.id, percent: 50, reason: "Me" },
        outside(PUBLIC, { integrations: runtime, events }),
      ),
    );
    expect(["unknown_operation", "not_found", "forbidden"]).toContain(refused.code);
  });
});

describe("over the limit, or from an AI, a human admin decides (criterion 8)", () => {
  it("50% waits in Approvals; the order cannot be paid meanwhile; only an admin approves", async () => {
    const order = await buy([{ id: yoga }]);
    const queued = await pending(adjust({ id: order.id, percent: 50, reason: "Owner's friend" }));
    expect((await loadOrderRow(db.query, order.id)).total).toBe(12_000);
    const blocked = await refusal(checkout(order));
    expect(blocked.details.rule).toBe("discount_waiting");
    // The desk cannot approve its own, nor can a member.
    for (const user of [desk, member]) {
      const refused = await refusal(
        run("approval.approve", { actionIds: [queued.actionId] }, staff(user)),
      );
      expect(refused.code).toBe("forbidden");
    }
    await run("approval.approve", { actionIds: [queued.actionId] }, staff());
    const read = await get(order.id);
    expect(read).toMatchObject({ total: 6_000, discount: 6_000 });
    expect(read.adjustments?.[0]).toMatchObject({
      givenBy: desk.id,
      approval: queued.actionId,
      percent: 50,
    });
    expect(await checkout(order)).toMatchObject({ amount: 6_000 });
  });

  it("the limit counts every staff discount on the order, by amount and by percentage", async () => {
    const order = await buy([{ id: yoga }]);
    await adjust({ id: order.id, percent: 15, reason: "First" });
    // 15% then 10% of what is left: 1,800 + 1,020 = 2,820 of 12,000 is over 20%.
    await pending(adjust({ id: order.id, percent: 10, reason: "Second" }));
    // The amount limit, 100.00, binds on a bigger order.
    const big = await buy([{ id: yoga, quantity: 10 }]);
    await pending(adjust({ id: big.id, amount: 10_001, reason: "Group" }));
    expect((await adjust({ id: big.id, amount: 10_000, reason: "Group" })).total).toBe(110_000);
  });

  it("an assistant's request always waits, under every preset, whatever the amount", async () => {
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      await setPreset(preset);
      const order = await buy([{ id: yoga }]);
      for (const actor of ["assistant", "mcp"] as const) {
        const ctx = staff(admin, {
          actor,
          ...(actor === "mcp"
            ? { origin: { surface: "mcp", clientId: "c", clientName: "c", sessionId: unique("s") } }
            : {}),
        });
        await pending(adjust({ id: order.id, amount: 100, reason: "Small" }, ctx));
      }
      expect((await loadOrderRow(db.query, order.id)).total).toBe(12_000);
    }
  });

  it("only a human admin sets the limit", async () => {
    for (const ctx of [staff(desk), staff(admin, { actor: "assistant" })]) {
      const refused = await refusal(
        run("order.settings.update", { discountLimit: { percent: 100, amount: 1e8 } }, ctx),
      );
      expect(refused.code).toBe("forbidden");
    }
    const settings = await run<{ discountLimit: unknown }>("order.settings.get", {}, staff());
    expect(settings.discountLimit).toEqual({ percent: 20, amount: 10_000 });
  });
});

describe("erase", () => {
  it("keeps an adjustment's amount and blanks its reason", async () => {
    const email = `${unique("erase")}@buyers.example`;
    const order = await run<OrderOut>(
      "order.start",
      { lines: [{ object: CLASS, id: mat }], email },
      guest(),
    );
    await adjust({ id: order.id, amount: 550, reason: "Said they were short this week" });
    const row = await loadOrderRow(db.query, order.id);
    await run("person.erase", { id: row.person_id }, context(admin));
    const kept = await env.DB.prepare(
      "SELECT amount, reason, kind FROM core_order_adjustment WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(kept).toEqual({ amount: 550, reason: null, kind: "staff" });
  });
});

describe("the database keeps adjustments as they were given", () => {
  it("refuses changing an amount, deleting one, and adding one to an order that is not pending", async () => {
    const order = await buy([{ id: mat }]);
    const adjusted = await adjust({ id: order.id, amount: 100, reason: "Kept" });
    const id = adjusted.lines.length ? (await get(order.id)).adjustments?.[0]?.id : undefined;
    await expect(
      env.DB.prepare("UPDATE core_order_adjustment SET amount = 1 WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/core_order_adjustment_fixed/);
    await expect(
      env.DB.prepare("DELETE FROM core_order_adjustment WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/core_order_adjustment_kept/);
    await run("order.cancel", { id: order.id }, staff());
    await expect(
      env.DB.prepare(
        "INSERT INTO core_order_adjustment (id, order_id, kind, given_by, amount, created_at) VALUES ('oad_x', ?, 'staff', ?, 1, '2026-01-01')",
      )
        .bind(order.id, admin.id)
        .run(),
    ).rejects.toThrow(/core_order_adjustment_pending/);
  });
});

describe("statements", () => {
  it("a discount on an order of 50 lines stays far inside D1's limits", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(await create(CLASS, { name: `Line ${i}`, price: 3 }));
    const order = await buy(ids.map((id) => ({ id })));
    // The local runtime enforces neither 1,000 statements per invocation nor 100 bound
    // variables per statement: count what the call's batch runs.
    const batches: number[] = [];
    let mostBound = 0;
    const counted = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(inner, name) {
                if (name === "bind") {
                  return (...values: unknown[]) => {
                    mostBound = Math.max(mostBound, values.length);
                    return inner.bind(...values);
                  };
                }
                const value = Reflect.get(inner, name);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        if (key === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batches.push(statements.length);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const adjusted = await adjust(
      { id: order.id, amount: 1_234, reason: "Big class" },
      staff(desk, { db: createCrmDb(counted) }),
    );
    expect(adjusted.lines).toHaveLength(50);
    expect(adjusted.lines.reduce((s, l) => s + l.discount, 0)).toBe(1_234);
    // One statement per line, the adjustment, the order, its audit and history.
    expect(Math.max(...batches)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...batches)).toBeLessThan(100);
    expect(mostBound).toBeLessThan(100);
  });
});

describe("the review of PR #380", () => {
  it("a discount given while the buyer's page is opening: the page is refused, and the next is for the new price", async () => {
    const order = await buy([{ id: yoga }]);
    const host = runtime.callAsHost;
    if (!host) throw new Error("the payments double calls as the host");
    const original = host.bind(runtime);
    let fired = false;
    runtime.callAsHost = async (input) => {
      if (input.method === "createCheckout" && !fired) {
        fired = true;
        // The desk gives 10% while the buyer's checkout is at the provider.
        await adjust({ id: order.id, percent: 10, reason: "Desk" });
      }
      return original(input);
    };
    let refused: Awaited<ReturnType<typeof refusal>>;
    try {
      refused = await refusal(checkout(order));
    } finally {
      runtime.callAsHost = original;
    }
    expect(fired).toBe(true);
    expect(refused.details.rule).toBe("price_changed");
    expect(await checkout(order)).toMatchObject({ amount: 10_800 });
    await providerPays(order.id);
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({ state: "paid", paid: 10_800 });
  });

  it("the database refuses a new total once a payment page is recorded", async () => {
    const order = await buy([{ id: yoga }]);
    await checkout(order);
    await expect(
      env.DB.prepare(
        "UPDATE core_order SET total = 100, discount = 11900, version = version + 1 WHERE id = ?",
      )
        .bind(order.id)
        .run(),
    ).rejects.toThrow(/core_order_checkout_open/);
  });

  it("a discount that lands between the limit check and the write is judged again", async () => {
    const order = await buy([{ id: yoga }]);
    let armed = false;
    let fired = false;
    // Another desk's 15% commits after this call's limit was read and before its handler reads.
    const hook = () => adjust({ id: order.id, percent: 15, reason: "Other desk" }, staff(admin));
    const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(inner, name) {
          if (name === "bind") {
            return (...values: unknown[]) => {
              if (values.includes("order_discount_limit")) armed = true;
              return wrap(inner.bind(...values), query);
            };
          }
          if (name === "all" || name === "first" || name === "raw" || name === "run") {
            return async (...args: unknown[]) => {
              if (armed && !fired && /from "core_order" /.test(query)) {
                fired = true;
                await hook();
              }
              // biome-ignore lint/suspicious/noExplicitAny: forwarding a D1 statement's own method.
              return (inner as any)[name](...args);
            };
          }
          const value = Reflect.get(inner, name);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    const hooked = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (query: string) => wrap(target.prepare(query), query);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const refused = await refusal(
      adjust(
        { id: order.id, percent: 15, reason: "This desk" },
        staff(desk, { db: createCrmDb(hooked) }),
      ),
    );
    expect(fired).toBe(true);
    expect(refused.details.rule).toBe("discount_limit");
    expect(await loadOrderRow(db.query, order.id)).toMatchObject({ total: 10_200 });
    // Asked again, it waits for an admin.
    await pending(adjust({ id: order.id, percent: 15, reason: "This desk" }));
  });

  it("an AI's request to take a discount off waits for an admin, under every preset", async () => {
    const order = await buy([{ id: yoga }]);
    await adjust({ id: order.id, percent: 10, reason: "Desk" });
    const id = (await get(order.id)).adjustments?.[0]?.id;
    let last = "";
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      await setPreset(preset);
      const queued = await pending(
        run(
          "order.unadjust",
          { id: order.id, adjustmentId: id },
          staff(admin, { actor: "assistant" }),
        ),
      );
      last = queued.actionId;
      expect((await loadOrderRow(db.query, order.id)).total).toBe(10_800);
    }
    await setPreset("balanced");
    expect((await refusal(run("approval.approve", { actionIds: [last] }, staff(desk)))).code).toBe(
      "forbidden",
    );
    await run("approval.approve", { actionIds: [last] }, staff());
    expect((await loadOrderRow(db.query, order.id)).total).toBe(12_000);
  });

  it("an AI's waiting request does not stop the buyer paying; a person's over the limit does", async () => {
    const order = await buy([{ id: yoga }]);
    await pending(
      adjust({ id: order.id, amount: 100, reason: "Asked" }, staff(admin, { actor: "assistant" })),
    );
    expect(await checkout(order)).toMatchObject({ amount: 12_000 });
  });

  it("erase redacts the audit log's copy of a discount's reason", async () => {
    const email = `${unique("erase")}@buyers.example`;
    const order = await run<OrderOut>(
      "order.start",
      { lines: [{ object: CLASS, id: mat }], email },
      guest(),
    );
    await adjust({ id: order.id, amount: 100, reason: "Says money is short this month" });
    const id = (await get(order.id)).adjustments?.[0]?.id;
    await run("order.unadjust", { id: order.id, adjustmentId: id }, staff(desk));
    const row = await loadOrderRow(db.query, order.id);
    const audits = await env.DB.prepare(
      "SELECT id FROM core_audit WHERE operation IN ('order.adjust', 'order.unadjust') AND json_extract(input, '$.id') = ?",
    )
      .bind(order.id)
      .all<{ id: string }>();
    expect(audits.results).toHaveLength(2);
    await run("person.erase", { id: row.person_id }, context(admin));
    for (const { id: auditId } of audits.results) {
      const after = await env.DB.prepare(
        "SELECT a.input, (SELECT count(*) FROM core_audit_redactions r WHERE r.audit_id = a.id) AS redacted FROM core_audit a WHERE a.id = ?",
      )
        .bind(auditId)
        .first<{ input: string; redacted: number }>();
      expect(after?.redacted).toBe(1);
      expect(after?.input).not.toContain("money is short");
    }
  });

  it("a percentage of the whole order is each line's rounded down, not a share of the sum", async () => {
    for (let a = 1; a < 40; a += 1) {
      for (let b = 1; b < 40; b += 1) {
        for (const percent of [10, 12.5, 33, 50, 99]) {
          const amount = percentOff([a, b], percent);
          if (amount <= 0) continue;
          const { discounts } = applyAdjustments(
            [
              { id: "a", total: a },
              { id: "b", total: b },
            ],
            [{ lineId: null, amount, percent }],
          );
          expect(discounts).toEqual([percentOff([a], percent), percentOff([b], percent)]);
        }
      }
    }
    const cent = await create(CLASS, { name: "One cent", price: 0.01 });
    const three = await create(CLASS, { name: "Three cents", price: 0.03 });
    const order = await buy([{ id: cent }, { id: three }]);
    // Over the limit: an admin approves it.
    const queued = await pending(adjust({ id: order.id, percent: 99, reason: "Nearly free" }));
    await run("approval.approve", { actionIds: [queued.actionId] }, staff());
    const lines = await env.DB.prepare(
      "SELECT line_discount FROM core_order_line WHERE order_id = ? ORDER BY position",
    )
      .bind(order.id)
      .all<{ line_discount: number }>();
    expect(lines.results.map((l) => l.line_discount)).toEqual([0, 2]);
  });
});
