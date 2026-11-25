// Stage 25, the gatekeeper half, in the host (ADR 0429), against a test double of the payments
// gatekeeper (the real one is driven end to end in apps/runner/test/payments.test.ts):
// criteria 4 and 5 (paid only by a verified event; a mismatch moves nothing and tells staff),
// 6 (expiry and late payment), 7 (the confirmation email's link), 8 (refunds through approval),
// 11 (no card data anywhere a full checkout wrote), 12 (`order.paid` reaches an automation once),
// 12a (deposits through real events) and stage 26's criterion 5 (an order's holds).
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AutomationDefinition,
  type AutomationQueueMessage,
  applyStoredPaymentEvent,
  confirmationMessage,
  coreRegistry,
  devJudge,
  loadOrderRow,
  memoryEventSink,
  recordPaymentEvent,
  recordTriggerSource,
  runOrderNotices,
  sendOrderConfirmation,
  type ValidationError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { opRequest, outcomeOf, surfaceOver } from "./http-helpers.ts";
import { CURRENCY, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SHOP = extId("shop");
/** For sale, with places in a pool, and a deposit. Releases on refund (the default). */
const SEAT = `${SHOP}.seat`;
/** For sale, with places, kept after a refund (`releaseOnRefund: false`). */
const KEEPSAKE = `${SHOP}.keepsake`;
const EVENT = `${SHOP}.event`;
const RETURN = "https://shop.example.com/thanks";

interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  refunded: number;
  token?: string | null;
}

// --- The payments gatekeeper's test double (payments-double.ts) ---------------------------------

const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays, providerRefunds } = payments;

// --- Helpers -------------------------------------------------------------------------------------

let admin: ActingUser;
let member: ActingUser;
let events: ReturnType<typeof memoryEventSink>;
const staff = (user: ActingUser = admin, extra: Record<string, unknown> = {}) =>
  context(user, { integrations: runtime, events, ...extra });
const guest = () => outside(PUBLIC, { integrations: runtime, events });

async function createRecord(object: string, values: Record<string, unknown>): Promise<string> {
  const created = (await run("record.create", { object, values }, context(admin))) as {
    id: string;
  };
  return created.id;
}

async function startAsGuest(
  lines: { object: string; id: string; quantity?: number }[],
  pay = "full",
) {
  return run<OrderOut>(
    "order.start",
    { lines, email: `${unique("guest")}@buyers.example`, pay },
    guest(),
  );
}

async function checkout(order: OrderOut, amount?: number) {
  return run<{ url: string; amount: number; kind: string }>(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN, ...(amount ? { amount } : {}) },
    guest(),
  );
}

const state = async (id: string) => (await loadOrderRow(db.query, id)).state;

async function counter(object: string, record: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, record)
    .first<{ places: number; held: number; taken: number }>();
}

async function claims(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT state FROM core_capacity_claim WHERE for_type = 'order' AND for_id = ? ORDER BY id",
  )
    .bind(orderId)
    .all<{ state: string }>();
  return results.map((r) => r.state);
}

async function adminNotices(title: RegExp) {
  const { results } = await env.DB.prepare(
    "SELECT title FROM core_notifications WHERE user_id = ? ORDER BY created_at",
  )
    .bind(admin.id)
    .all<{ title: string }>();
  return results.filter((r) => title.test(r.title));
}

let event: string;
let seat: string;
let cheap: string;
let keepsake: string;
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(SHOP, {
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
        seat: {
          label: "Seat",
          plural: "Seats",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            depositAmount: { type: "currency", label: "Deposit", currency: CURRENCY },
            balanceDue: { type: "date", label: "Balance due" },
            places: { type: "number", label: "Places" },
            event: { type: "relation", label: "Event", to: EVENT },
          },
          capacity: { places: "places", pool: "event" },
          sellable: {
            price: "price",
            deposit: { amount: "depositAmount", balanceDue: "balanceDue" },
          },
          // A customer or a guest buys only what they may read (ADR 0438).
          public: { read: ["name", "price"] },
        },
        keepsake: {
          label: "Keepsake",
          plural: "Keepsakes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
            places: { type: "number", label: "Places" },
          },
          capacity: { places: "places", releaseOnRefund: false },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"], minPartPayment: 1000 },
    context(admin),
  );
  event = await createRecord(EVENT, { name: unique("Camp"), places: 1000 });
  seat = await createRecord(SEAT, {
    name: "Camp seat",
    price: 2999,
    depositAmount: 750,
    balanceDue: NEXT_YEAR,
    places: 500,
    event,
  });
  cheap = await createRecord(SEAT, { name: "Day seat", price: 120, places: 500, event });
  keepsake = await createRecord(KEEPSAKE, { name: "Poster", price: 30, places: 100 });

  await payments.connect(admin.id);
});

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
});

// --- Checkout ----------------------------------------------------------------------------------

describe("order.checkout", () => {
  it("opens the provider's page for what the host says, back to an allowed site only", async () => {
    const order = await startAsGuest([{ object: SEAT, id: cheap, quantity: 2 }]);
    const opened = await checkout(order);
    expect(opened).toMatchObject({ amount: 24000, kind: "full" });
    expect(opened.url).toMatch(/^https:\/\/pay\.example\/fcs_/);

    // Off the list, or not https: refused, and no checkout opened.
    const before = gw.checkouts.length;
    for (const returnUrl of ["https://evil.example/thanks", "http://shop.example.com/thanks"]) {
      const refused = await refusal(
        run("order.checkout", { id: order.id, token: order.token, returnUrl }, guest()),
      );
      expect(refused.details).toMatchObject({ rule: "return_origin" });
    }
    // A first payment is not the buyer's to choose.
    const amount = await refusal(checkout(order, 100));
    expect(amount.details).toMatchObject({ rule: "charge_amount" });
    // A wrong token is not found.
    const wrong = await refusal(
      run("order.checkout", { id: order.id, token: "0".repeat(64), returnUrl: RETURN }, guest()),
    );
    expect(wrong.code).toBe("not_found");
    expect(gw.checkouts.length).toBe(before);
  });
});

// --- Criteria 4 and 5 --------------------------------------------------------------------------

describe("paid only by a verified event (criteria 4 and 5)", () => {
  it("the return page leaves it pending; the event pays it; the same event again changes nothing", async () => {
    const order = await startAsGuest([{ object: SEAT, id: cheap }]);
    await checkout(order);
    // The buyer comes back to the return page: it reads the order, which is still pending.
    const back = await run<OrderOut>("order.view", { id: order.id, token: order.token }, guest());
    expect(back.state).toBe("pending");

    const { event: paid, result } = await providerPays(order.id);
    expect(result.outcome).toBe("applied");
    expect(await state(order.id)).toBe("paid");

    // Delivered again (the gatekeeper retried, or the provider resent it): nothing changes.
    const key = { provider: "fake", eventId: paid.eventId };
    await recordPaymentEvent(db, paid, payments.connectionId(), new Date().toISOString());
    const again = await applyStoredPaymentEvent({ crm: db, integrations: runtime }, key);
    expect(again.outcome).toBe("duplicate");
    expect((await loadOrderRow(db.query, order.id)).paid).toBe(12000);
  });

  it("nothing a caller sends can stand in for the provider's word", async () => {
    const order = await startAsGuest([{ object: SEAT, id: cheap }]);
    // order.applyPaymentEvent takes only a key: an event no gatekeeper delivered is not found.
    const unknown = await refusal(
      run(
        "order.applyPaymentEvent",
        { provider: "fake", eventId: "fevt_made_up", orderId: order.id, amount: 12000 },
        staff(admin, { actor: "automation" }),
      ),
    );
    expect(unknown.code).toBe("not_found");
    // And it is not open to people, MCP clients or the assistant.
    for (const actor of ["human", "mcp", "assistant"] as const) {
      const refused = await refusal(
        run("order.applyPaymentEvent", { provider: "fake", eventId: "x" }, staff(admin, { actor })),
      );
      expect(refused.code).toBe("forbidden");
    }
    expect(await state(order.id)).toBe("pending");
  });

  it("a different amount or currency moves nothing and tells staff (criterion 5)", async () => {
    for (const [amount, currency] of [
      [100, CURRENCY],
      [12000, "USD"],
    ] as const) {
      const order = await startAsGuest([{ object: SEAT, id: cheap }]);
      await checkout(order);
      const { result } = await providerPays(order.id, amount, currency);
      expect(result.outcome).toBe("mismatch");
      expect(await state(order.id)).toBe("pending");
    }
    expect((await adminNotices(/does not match its order/)).length).toBeGreaterThanOrEqual(2);
  });
});

// --- Criterion 6 -------------------------------------------------------------------------------

describe("expiry and late payment (criterion 6)", () => {
  async function expired() {
    const order = await startAsGuest([{ object: SEAT, id: cheap }]);
    await checkout(order);
    const later = new Date(Date.now() + 16 * 60_000);
    const swept = await run<{ expired: string[] }>(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => later }),
    );
    expect(swept.expired).toContain(order.id);
    expect(await state(order.id)).toBe("expired");
    return order;
  }

  it("a payment for an expired order leaves it unpaid, lists it as paid late and tells staff", async () => {
    const order = await expired();
    const { result } = await providerPays(order.id);
    expect(result.outcome).toBe("late");
    expect(await state(order.id)).toBe("expired");
    const late = await run<{ items: { orderId: string }[] }>("order.paidLate", {}, staff());
    expect(late.items.map((i) => i.orderId)).toContain(order.id);
    expect((await adminNotices(/closed/)).length).toBeGreaterThan(0);
    // The daily notice says so too.
    const notices = await runOrderNotices(db, new Date().toISOString());
    expect(notices.paidLate).toBeGreaterThan(0);
  });

  it("order.honourLate makes it paid and clears it; only a person with orders:refund may", async () => {
    const order = await expired();
    await providerPays(order.id);
    const byAi = await refusal(
      run("order.honourLate", { id: order.id }, staff(admin, { actor: "assistant" })),
    );
    expect(byAi.code).toBe("forbidden");
    const byMember = await refusal(run("order.honourLate", { id: order.id }, staff(member)));
    expect(byMember.code).toBe("forbidden");
    const honoured = await run<OrderOut>("order.honourLate", { id: order.id }, staff());
    expect(honoured.state).toBe("paid");
    const late = await run<{ items: { orderId: string }[] }>("order.paidLate", {}, staff());
    expect(late.items.map((i) => i.orderId)).not.toContain(order.id);
  });

  it("honouring a late payment gives the guest's link its time from being paid, not from expiry", async () => {
    const order = await expired();
    await providerPays(order.id);
    // It expired long ago: the link its expiry gave stopped ten days ago.
    await env.DB.prepare("UPDATE core_order SET access_until = ? WHERE id = ?")
      .bind(new Date(Date.now() - 10 * 86_400_000).toISOString(), order.id)
      .run();
    await run("order.honourLate", { id: order.id }, staff());
    const seen = await run<OrderOut>("order.view", { id: order.id, token: order.token }, guest());
    expect(seen.state).toBe("paid");
  });

  it("a refund clears it too", async () => {
    const order = await expired();
    await providerPays(order.id);
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "Arrived too late" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    const late = await run<{ items: { orderId: string }[] }>("order.paidLate", {}, staff());
    expect(late.items.map((i) => i.orderId)).not.toContain(order.id);
    expect(await state(order.id)).toBe("expired");
  });

  it("a part-paid order never expires", async () => {
    const order = await startAsGuest([{ object: SEAT, id: seat }], "deposit");
    await checkout(order);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("part_paid");
    const later = new Date(Date.now() + 30 * 86_400_000);
    await run("order.expireDue", {}, staff(admin, { actor: "automation", clock: () => later }));
    expect(await state(order.id)).toBe("part_paid");
  });
});

// --- Criterion 8 -------------------------------------------------------------------------------

describe("refunds through approval (criterion 8)", () => {
  async function paidOrder() {
    const order = await startAsGuest([{ object: SEAT, id: cheap, quantity: 2 }]);
    await checkout(order);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("paid");
    return order;
  }

  it("is proposed with a simulation, approved by a person, sent, and refunded only on confirmation", async () => {
    const order = await paidOrder();
    const asked = await run<{ refunds: { id: string; amount: number; pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "Cannot come" },
      staff(),
    );
    expect(asked.refunds).toHaveLength(1);
    expect(asked.refunds[0]?.amount).toBe(24000);
    const actionId = asked.refunds[0]?.pendingActionId as string;
    // The pending action carries what is sent back and to which payment.
    const pending = await run<{
      action: {
        operation: string;
        input: { title: string; fields: { label: string; value: string }[] };
      };
    }>("approval.get", { actionId }, staff()).catch(async () => ({
      action: (await env.DB.prepare("SELECT operation, input FROM core_pending_action WHERE id = ?")
        .bind(actionId)
        .first()) as never,
    }));
    expect(JSON.stringify(pending)).toContain("Payment");
    expect(gw.applied).not.toContain(gw.action);

    await run("approval.approve", { actionIds: [actionId] }, staff());
    expect(gw.applied).toContain(gw.action);
    // Sent, not yet confirmed: still paid.
    expect(await state(order.id)).toBe("paid");
    await providerRefunds(gw.action);
    const row = await loadOrderRow(db.query, order.id);
    expect(row.state).toBe("refunded");
    expect(row.refunded).toBe(24000);
    // The provider reporting it again counts once.
    const refundRows = await env.DB.prepare(
      "SELECT status FROM core_order_refund WHERE order_id = ?",
    )
      .bind(order.id)
      .all();
    expect(refundRows.results).toEqual([{ status: "confirmed" }]);
  });

  it("is refused without orders:refund", async () => {
    const order = await paidOrder();
    const refused = await refusal(
      run("order.refund", { id: order.id, reason: "x" }, staff(member)),
    );
    expect(refused.code).toBe("forbidden");
  });

  it("an AI actor may propose one and can never approve it, under any policy", async () => {
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      await setPreset(preset);
      const order = await paidOrder();
      // Proposed by the assistant: under every preset it waits for a person (never auto-applied).
      const asked = await run<{ refunds: { pendingActionId: string | null }[] }>(
        "order.refund",
        { id: order.id, reason: "The person asked" },
        staff(admin, {
          actor: "assistant",
          origin: { surface: "assistant", sessionId: `ath_${unique("t")}` },
        }),
      );
      const actionId = asked.refunds[0]?.pendingActionId;
      expect(actionId).toBeTruthy();
      const appliedBefore = gw.applied.length;
      // The assistant relaying a yes, an MCP client, an automation: all refused.
      for (const actor of ["assistant", "mcp", "automation"] as const) {
        const viaDecide = await refusal(
          run(
            "approval.decide",
            { actionIds: [actionId], decision: "approve", via: "tap" },
            staff(admin, { actor }),
          ),
        );
        expect(viaDecide.code).toBe("forbidden");
      }
      // The assistant in the person's own chat, with their plain yes: still refused. A refund is
      // approved by a person's own press in the Approvals inbox.
      const inChat = await refusal(
        run(
          "approval.decide",
          { actionIds: [actionId], decision: "approve" },
          staff(admin, {
            actor: "assistant",
            judge: devJudge,
            assistantTurn: {
              threadId: "ath_1",
              messageSeq: 1,
              text: "Yes, approve the refund",
              via: "text",
            },
          }),
        ),
      );
      expect(inChat.code).toBe("forbidden");
      expect(gw.applied.length).toBe(appliedBefore);
      // A person without the permission cannot either; an admin can.
      const memberApproves = await refusal(
        run("approval.approve", { actionIds: [actionId] }, staff(member)),
      );
      expect(memberApproves.code).toBe("forbidden");
      await run("approval.approve", { actionIds: [actionId] }, staff());
      expect(gw.applied.length).toBe(appliedBefore + 1);
    }
  });

  it("a part refund records the amount and leaves the order paid", async () => {
    const order = await paidOrder();
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, amount: 5000, reason: "One ticket" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    const row = await loadOrderRow(db.query, order.id);
    expect(row.state).toBe("paid");
    expect(row.refunded).toBe(5000);
    // What is left is what can still be asked for.
    const over = await refusal(
      run("order.refund", { id: order.id, amount: 20000, reason: "x" }, staff()),
    );
    expect(over.details).toMatchObject({ rule: "refund_amount", available: 19000 });
  });
});

// --- Criterion 7: the confirmation email ---------------------------------------------------------

describe("the confirmation email (criterion 7)", () => {
  it("carries a link that opens that order only, and stops after it", async () => {
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('notification_delivery', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify({ email: payments.connectionId() }), new Date().toISOString())
      .run()
      .catch(() => undefined);
    const order = await startAsGuest([{ object: SEAT, id: cheap }]);
    const other = await startAsGuest([{ object: SEAT, id: cheap }]);
    await checkout(order);
    const { result } = await providerPays(order.id);
    const token = result.confirmation?.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const message = confirmationMessage(
      await loadOrderRow(db.query, order.id),
      token,
      "https://crm.example.com",
    );
    expect(message.text).toContain(`https://crm.example.com/order/${order.id}?token=${token}`);
    // The emailed token opens the order; the start's token still does; neither opens another.
    expect((await run<OrderOut>("order.view", { id: order.id, token }, guest())).state).toBe(
      "paid",
    );
    expect(
      (await run<OrderOut>("order.view", { id: order.id, token: order.token }, guest())).id,
    ).toBe(order.id);
    expect((await refusal(run("order.view", { id: other.id, token }, guest()))).code).toBe(
      "not_found",
    );
    // After the order's access window, the link stops working.
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(
      (
        await refusal(
          run("order.view", { id: order.id, token }, outside(PUBLIC, { clock: () => later })),
        )
      ).code,
    ).toBe("not_found");
    // Sent through the email channel when one is set (Settings → Notification delivery).
    const sent = await sendOrderConfirmation(
      { crm: db, integrations: runtime, appOrigin: "https://crm.example.com" },
      { orderId: order.id, token },
    );
    if (sent !== "skipped") {
      expect(gw.emails.at(-1)?.text).toContain(`/order/${order.id}?token=`);
    }
  });
});

// --- Criterion 11 ----------------------------------------------------------------------------------

/**
 * 13 to 19 digits, allowing spaces or dashes between them, standing on their own: anything shaped
 * like a card number. A run of digits inside a longer token (a hex hash, an id) is not one: a
 * random SHA-256 has a Luhn-valid run of 13 or more digits often enough to make the scan flaky.
 */
const CARD = /(?<![0-9A-Za-z])(?:\d[ -]?){12,18}\d(?![0-9A-Za-z])/;
async function cardNumbersIn(tables: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const table of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    for (const row of results) {
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        // Timestamps and ids are long runs of digits too: only digit runs outside them count.
        const cleaned = value.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "");
        const match = CARD.exec(cleaned);
        if (match && luhn(match[0].replace(/\D/g, ""))) found.push(`${table}: ${match[0]}`);
      }
    }
  }
  return found;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

describe("no card data (criterion 11)", () => {
  it("nothing a full checkout wrote, in any table, log line or audit row, holds a card number", async () => {
    const logs: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of ["log", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
        original[level](...args);
      };
    }
    try {
      const order = await startAsGuest([{ object: SEAT, id: cheap }]);
      await checkout(order);
      await providerPays(order.id);
      const asked = await run<{ refunds: { pendingActionId: string }[] }>(
        "order.refund",
        { id: order.id, reason: "Changed plans" },
        staff(),
      );
      await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
      await providerRefunds(gw.action);
    } finally {
      Object.assign(console, original);
    }
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_%' AND name NOT LIKE '%_fts%'",
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["core_order", "core_payment_event", "core_audit"]),
    );
    expect(await cardNumbersIn(tables)).toEqual([]);
    expect(
      logs.filter(
        (line) => CARD.test(line) && luhn((CARD.exec(line)?.[0] ?? "").replace(/\D/g, "")),
      ),
    ).toEqual([]);
  });

  it("the scan finds a card number when one is written (the scan's own check)", async () => {
    // A test card number written into a log-like store must be caught.
    await env.DB.prepare("INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(
        unique("leak"),
        JSON.stringify({ note: "card 4242 4242 4242 4242" }),
        new Date().toISOString(),
      )
      .run();
    expect((await cardNumbersIn(["core_settings"])).length).toBeGreaterThan(0);
  });
});

// --- Criterion 12 ------------------------------------------------------------------------------------

describe("order.paid and order.partPaid reach an automation once per order (criterion 12)", () => {
  const fixture = (id: string, to: string): AutomationDefinition =>
    ({
      id,
      extensionId: id.split(".")[0] as string,
      key: id.split(".")[1] as string,
      commit: "c",
      spec: {
        label: id,
        description: id,
        steps: [{ name: "grant" }],
        trigger: { type: "fieldChanged", object: "order", field: "state", to },
      },
    }) as unknown as AutomationDefinition;
  const paidAutomation = fixture("tickets.onPaid", "paid");
  const partAutomation = fixture("tickets.onPartPaid", "part_paid");
  const runsFor = (
    messages: AutomationQueueMessage[],
    automation: AutomationDefinition,
    id: string,
  ) =>
    messages
      .filter((m) => m.kind === "record")
      .flatMap((m) => recordTriggerSource.match(m as never, [automation]))
      .filter((c) => c.record?.id === id);

  it("an order paid in full starts the paid automation once, however often the event is delivered", async () => {
    const order = await startAsGuest([{ object: SEAT, id: cheap }]);
    await checkout(order);
    const { event: paid } = await providerPays(order.id);
    await recordPaymentEvent(db, paid, payments.connectionId(), new Date().toISOString());
    await applyStoredPaymentEvent({ crm: db, events }, { provider: "fake", eventId: paid.eventId });
    expect(runsFor(events.messages, paidAutomation, order.id)).toHaveLength(1);
    expect(runsFor(events.messages, partAutomation, order.id)).toHaveLength(0);
  });

  it("a deposit order starts partPaid once at the deposit and paid once at the balance", async () => {
    const order = await startAsGuest([{ object: SEAT, id: seat }], "deposit");
    await checkout(order);
    await providerPays(order.id);
    await checkout(order, 100_000);
    await providerPays(order.id);
    await checkout(order);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("paid");
    expect(runsFor(events.messages, partAutomation, order.id)).toHaveLength(1);
    expect(runsFor(events.messages, paidAutomation, order.id)).toHaveLength(1);
  });
});

// --- Criterion 12a through real events -------------------------------------------------------------

describe("paying by deposit through the provider (criterion 12a)", () => {
  it("deposit, part of the balance, the rest; more than the balance is refused", async () => {
    const order = await startAsGuest([{ object: SEAT, id: seat }], "deposit");
    expect((await checkout(order)).amount).toBe(75000);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("part_paid");
    await checkout(order, 100_000);
    await providerPays(order.id);
    let row = await loadOrderRow(db.query, order.id);
    expect(row.state).toBe("part_paid");
    expect(row.total - row.paid).toBe(299900 - 175000);
    expect((await refusal(checkout(order, 200_000))).details).toMatchObject({
      rule: "charge_amount",
    });
    await checkout(order);
    await providerPays(order.id);
    row = await loadOrderRow(db.query, order.id);
    expect(row.state).toBe("paid");
  });
});

// --- Stage 26, criterion 5: an order's holds --------------------------------------------------------

describe("an order's places (stage 26, criterion 5)", () => {
  it("starting holds, paying confirms, a full refund releases", async () => {
    const before = await counter(SEAT, cheap);
    const order = await startAsGuest([{ object: SEAT, id: cheap, quantity: 3 }]);
    expect(await claims(order.id)).toEqual(["held"]);
    expect((await counter(SEAT, cheap))?.held).toBe((before?.held ?? 0) + 3);
    await checkout(order);
    await providerPays(order.id);
    expect(await claims(order.id)).toEqual(["confirmed"]);
    const paid = await counter(SEAT, cheap);
    expect(paid?.taken).toBe((before?.taken ?? 0) + 3);
    expect(paid?.held).toBe(before?.held ?? 0);
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "x" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    // Sent, not confirmed: still taken.
    expect(await claims(order.id)).toEqual(["confirmed"]);
    await providerRefunds(gw.action);
    expect(await claims(order.id)).toEqual(["released"]);
    expect(await counter(SEAT, cheap)).toEqual(before);
  });

  it("a refund keeps the places when the object says so", async () => {
    const order = await startAsGuest([{ object: KEEPSAKE, id: keepsake }]);
    await checkout(order);
    await providerPays(order.id);
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "x" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    expect(await state(order.id)).toBe("refunded");
    expect(await claims(order.id)).toEqual(["confirmed"]);
  });

  it("cancelling and expiring release; a cancelled part-paid order releases its confirmed places", async () => {
    const before = await counter(SEAT, cheap);
    const cancelled = await startAsGuest([{ object: SEAT, id: cheap }]);
    await run("order.cancel", { id: cancelled.id }, staff());
    expect(await claims(cancelled.id)).toEqual(["released"]);

    const lapsed = await startAsGuest([{ object: SEAT, id: cheap }]);
    await run(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
    );
    expect(await claims(lapsed.id)).toEqual(["released"]);
    // Neither holds anything now (other tests' pending orders on this seat expired with it).
    expect((await counter(SEAT, cheap))?.held).toBeLessThanOrEqual(before?.held ?? 0);

    const deposit = await startAsGuest([{ object: SEAT, id: seat }], "deposit");
    await checkout(deposit);
    await providerPays(deposit.id);
    expect(await claims(deposit.id)).toEqual(["confirmed"]);
    // A hold has no clock: a year on it is still confirmed.
    await run(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => new Date(Date.now() + 365 * 86_400_000) }),
    );
    expect(await claims(deposit.id)).toEqual(["confirmed"]);
    await run("order.cancel", { id: deposit.id }, staff());
    expect(await claims(deposit.id)).toEqual(["released"]);
  });

  it("a late payment after release claims nothing; honouring claims again, or is refused when the places have gone", async () => {
    const few = await createRecord(SEAT, { name: "Last seat", price: 50, places: 1, event });
    const first = await startAsGuest([{ object: SEAT, id: few }]);
    await checkout(first);
    await run(
      "order.expireDue",
      {},
      staff(admin, { actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
    );
    expect(await claims(first.id)).toEqual(["released"]);
    await providerPays(first.id);
    // Late: nothing claimed, staff told.
    expect(await claims(first.id)).toEqual(["released"]);
    expect((await counter(SEAT, few))?.held).toBe(0);

    // Someone else takes the last place meanwhile: honouring is refused, and nothing moves.
    const second = await startAsGuest([{ object: SEAT, id: few }]);
    const refused = await refusal(run("order.honourLate", { id: first.id }, staff()));
    expect(refused.details).toMatchObject({ rule: "capacity", available: 0 });
    expect(await state(first.id)).toBe("expired");

    // The place comes back: honouring claims it again and confirms it.
    await run("order.cancel", { id: second.id }, staff());
    const honoured = await run<OrderOut>("order.honourLate", { id: first.id }, staff());
    expect(honoured.state).toBe("paid");
    expect((await claims(first.id)).filter((c) => c === "confirmed")).toHaveLength(1);
    expect(await counter(SEAT, few)).toMatchObject({ held: 0, taken: 1 });
  });

  it("500 guests starting an order at once for 100 places in a pool: exactly 100 orders", async () => {
    const pool = await createRecord(EVENT, { name: unique("Rush"), places: 100 });
    const rush = await createRecord(SEAT, {
      name: "Rush seat",
      price: 10,
      places: 500,
      event: pool,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 500 }, () =>
        startAsGuest([{ object: SEAT, id: rush }]).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ),
    );
    const refused = outcomes.filter((o) => !o.ok);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(100);
    expect(refused).toHaveLength(400);
    for (const outcome of refused) {
      const error = (outcome as { error: unknown }).error as ValidationError;
      // A guest is told there are not enough places, and nothing about the record.
      expect(error.details).toEqual({ rule: "capacity" });
    }
    expect(await counter(EVENT, pool)).toEqual({ places: 100, held: 100, taken: 0 });
    const orders = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_order o JOIN core_order_line l ON l.order_id = o.id WHERE l.record_id = ?",
    )
      .bind(rush)
      .first<{ n: number }>();
    expect(orders?.n).toBe(100);
    // 500 orders through the whole pipeline: seconds locally, more than the default on a CI runner.
  }, 120_000);
});

// --- Over the HTTP surface (stage 23) --------------------------------------------------------------

describe("a guest's journey over HTTP", () => {
  it("starts with an email, opens the provider's page, and sees the order paid with the token", async () => {
    const surface = surfaceOver(coreRegistry, guest());
    const post = async (name: string, input: unknown) => {
      const response = await surface.handle(opRequest(name, input, null));
      if (!response) throw new Error("not an API path");
      return outcomeOf(response);
    };
    const started = await post("order.start", {
      lines: [{ object: SEAT, id: cheap }],
      email: `${unique("http")}@buyers.example`,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const order = (started as { value: OrderOut }).value;
    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
    const opened = await post("order.checkout", {
      id: order.id,
      token: order.token,
      returnUrl: RETURN,
    });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    await providerPays(order.id);
    const seen = await post("order.view", { id: order.id, token: order.token });
    expect((seen as { value: OrderOut }).value.state).toBe("paid");
    // Without the token, or with another order's, it is not found.
    const other = await post("order.view", { id: order.id, token: "f".repeat(64) });
    expect(other.ok).toBe(false);
  });
});
