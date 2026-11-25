// Stage 35 steps 3 to 5 (ADRs 0731, 0733 and 0735): an invoice issued as an order, payments
// recorded on it and reversed, credit notes and void. Against the real host, the box office
// fixture (ticket types with places, granting tickets), a shop and a discount pack (a deal and tax
// at checkout), and the payments gatekeeper's test double.
//
// The proofs the build was asked for, each checked by removing its rule and watching it fail:
//   (a) twenty invoices issued at once take twenty consecutive numbers, and a failed issue none;
//   (b) an issued invoice cannot be changed by any write path, nor its order's price;
//   (c) credit notes and refunds never give back more than was paid, with a deal live and tax at
//       checkout on, and a credit note and a provider refund never both give the money back;
//   (d) the assistant cannot record a payment, reverse one, credit or void.
import { env } from "cloudflare:workers";
import { defineExtension, type ExtensionManifest, toManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  type InvocationContext,
  loadOrderRow,
  memoryEventSink,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";
import { boxOfficeManifest } from "./sellable-fixtures.ts";

const BOX = extId("invbox");
const EVENT = `${BOX}.event`;
const TICKET_TYPE = `${BOX}.tickettype`;
const SHOP = extId("invshop");
const CLASS = `${SHOP}.class`;
const TEE = `${SHOP}.tee`;
const OFFERS = extId("invoffers");
const DISCOUNT = `${OFFERS}.discount`;
const RETURN = "https://shop.example.com/thanks";
const TAX = "txcd_20060158";
const TODAY = new Date().toISOString().slice(0, 10);
const GST = { key: "gst", label: "GST", rate: 1000, retired: false };

const select = (...values: string[]) => ({
  type: "select" as const,
  label: "Select",
  options: values.map((value) => ({ value, label: value })),
});

/** A shop: a class pass with a tax code, and goods. */
const shop = () =>
  manifest(SHOP, {
    objects: {
      class: {
        label: "Class pass",
        plural: "Class passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price", tax: { code: TAX } },
        public: { read: ["name", "price"] },
      },
      tee: {
        label: "Tee",
        plural: "Tees",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price", goods: {} },
        public: { read: ["name", "price"] },
      },
    },
  } as never);

/** A discount pack with automatic discounts (stage 34, ADR 0693): a deal for anyone. */
function offers(id: string): ExtensionManifest {
  return toManifest(
    defineExtension({
      id,
      version: "1.0.0",
      contractVersion: 1,
      objects: {
        discount: {
          label: "Discount",
          plural: "Discounts",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            kind: select("percent", "amount", "price"),
            percent: { type: "number", label: "Percent" },
            amount: { type: "currency", label: "Amount", currency: CURRENCY },
            automatic: { type: "boolean", label: "Automatic" },
            items: { type: "relation", label: "Items", to: `${SHOP}.class`, many: true },
            state: select("active", "ended"),
          },
          states: {
            field: "state",
            initial: "active",
            moves: [{ from: "active", to: "ended", by: ["staff"], final: true }],
          },
          discount: {
            kind: "kind",
            percent: "percent",
            amount: "amount",
            live: ["active"],
            automatic: "automatic",
            records: ["items"],
          },
        },
      },
    }),
  );
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays, providerRefunds } = payments;

let admin: ActingUser;
/** A member granted invoices:send, invoices:credit, invoices:payments and orders:refund. */
let desk: ActingUser;
/** A member with records:write and nothing of invoices. */
let member: ActingUser;
let personId: string;
let orgId: string;
/** $45.00 a class pass, with a tax code; a live automatic 10% deal on it. */
let pass: string;
let tee: string;

interface Line {
  id: string;
  position: number;
  total: number;
  tax: number;
  net: number;
  source: string;
}
interface Invoice {
  id: string;
  number: string | null;
  state: string;
  total: number;
  taxTotal: number;
  orderId: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  version: number;
  lines: Line[];
}
interface CreditNote {
  id: string;
  number: string | null;
  state: string;
  total: number;
  taxTotal: number;
  lines: { id: string; total: number; tax: number; creditsLineId: string | null }[];
  refunds: { method: string; amount: number; refundId: string | null; paidBackAt: string | null }[];
  invoice?: Invoice;
  pending?: string[];
}

const staff = (user: ActingUser = admin, extra: Partial<InvocationContext> = {}) =>
  context(user, { integrations: runtime, events, ...extra });

const NOT_A_PERSON: { actor: Actor; origin: InvocationContext["origin"] }[] = [
  { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_inv" } },
  { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_i" } },
  { actor: "automation", origin: { surface: "automation", automationId: "x.y" } },
  { actor: "extension", origin: { surface: "extension", extensionId: "bookings" } },
];

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

/** A ticket type of a new event with `places` places: $50.00 by default. */
async function ticketType(values: Record<string, unknown> = {}, places = 20) {
  const event = await create(EVENT, { name: unique("Camp"), places: 100 });
  return create(TICKET_TYPE, { name: unique("Ticket"), price: 50, places, event, ...values });
}

/** A draft invoice to the fixture Person: `quantity` tickets and a typed line of 1.5 hours. */
async function draft(
  ticket: string,
  options: { quantity?: number; extra?: Record<string, unknown>; lines?: unknown[] } = {},
) {
  return run<Invoice>(
    "invoice.create",
    {
      billTo: { personId },
      lines: options.lines ?? [
        { item: { object: TICKET_TYPE, id: ticket }, quantity: options.quantity ?? 2 },
        { description: "Room hire", quantity: 1.5, unit: "hours", unitPrice: 4000 },
      ],
      ...options.extra,
    },
    staff(),
  );
}

const issue = (id: string, ctx = staff()) => run<Invoice>("invoice.issue", { id }, ctx);

async function issued(ticket?: string, options: Parameters<typeof draft>[1] = {}) {
  return issue((await draft(ticket ?? (await ticketType()), options)).id);
}

const orderOf = (invoice: Invoice) => loadOrderRow(db.query, invoice.orderId as string);

async function eventsOf(invoiceId: string) {
  const { results } = await env.DB.prepare(
    "SELECT seq, document_kind, event, amount, method FROM core_invoice_event WHERE invoice_id = ? ORDER BY seq",
  )
    .bind(invoiceId)
    .all<{ seq: number; document_kind: string; event: string; amount: number; method: string }>();
  return results;
}

async function held(ticketTypeId: string) {
  return env.DB.prepare(
    "SELECT held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(TICKET_TYPE, ticketTypeId)
    .first<{ held: number; taken: number }>();
}

async function counter() {
  return (await env.DB.prepare(
    "SELECT next_number, version FROM core_document_counter WHERE series = 'invoice'",
  ).first()) as { next_number: number; version: number };
}

const recordPayment = (invoiceId: string, amount: number, ctx = staff(desk)) =>
  run<{ paymentId: string; invoice: Invoice }>(
    "invoice.recordPayment",
    { invoiceId, amount, kind: "transfer", receivedOn: TODAY, reference: "Fixture ref" },
    ctx,
  );

const credit = (input: Record<string, unknown>, ctx = staff()) =>
  run<CreditNote>("creditNote.create", { reason: "Fixture credit", ...input }, ctx);

const issueCredit = (id: string, ctx = staff(desk)) =>
  run<CreditNote>("creditNote.issue", { id }, ctx);

beforeAll(async () => {
  admin = await createUser("admin");
  desk = await createUser("member");
  member = await createUser("member");
  await reconcile(boxOfficeManifest(BOX));
  await reconcile(shop());
  const m = offers(OFFERS);
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(OFFERS, JSON.stringify(m), admin.id, now, now)
    .run();
  await run(
    "order.settings.update",
    {
      currency: CURRENCY,
      returnOrigins: ["https://shop.example.com"],
      minPartPayment: 1000,
      discountLimit: { percent: 20, amount: 10_000 },
    },
    context(admin),
  );
  await run(
    "invoice.settings.update",
    {
      taxRates: [GST],
      defaultTaxRate: "gst",
      business: {
        legalName: "Fixture Studio Pty",
        addressLines: ["1 Example Street"],
        taxNumber: "00 000 000 000",
        taxNumberLabel: "Tax number",
      },
      bank: [{ label: "Account", value: "000-000 00000000" }],
    },
    context(admin),
  );
  await run(
    "user.setPermissions",
    {
      id: desk.id,
      permissions: ["invoices:send", "invoices:credit", "invoices:payments", "orders:refund"],
    },
    context(admin),
  );
  personId = (
    await run<{ id: string }>(
      "person.create",
      { givenName: unique("Bill"), emails: [{ email: `${unique("bill")}@example.com` }] },
      context(admin),
    )
  ).id;
  orgId = (
    await run<{ id: string }>("organisation.create", { name: unique("Fixture Co") }, context(admin))
  ).id;
  await run("affiliation.create", { personId, organisationId: orgId }, context(admin));
  pass = await create(CLASS, { name: "Class pass", price: 45 });
  tee = await create(TEE, { name: "Club tee", price: 30 });
  // A deal for anyone buying the pass at checkout: an invoice's order takes none (ADR 0731).
  await create(DISCOUNT, {
    name: "Ten off",
    kind: "percent",
    percent: 10,
    automatic: true,
    items: [pass],
    state: "active",
  });
  await payments.connect(admin.id);
}, 120_000);

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
  await run("order.settings.update", { tax: false }, context(admin));
});

// --- Step 3: issue as an order ---------------------------------------------------------------

describe("issuing an invoice starts its order (criterion 4)", () => {
  it("in the same batch: the number, a due order of the invoice's total, its tax and its places", async () => {
    const ticket = await ticketType();
    const draftInvoice = await draft(ticket);
    const before = await counter();
    const invoice = await issue(draftInvoice.id);
    expect(invoice).toMatchObject({
      state: "issued",
      number: `INV-${String(before.next_number).padStart(4, "0")}`,
      issuedOn: TODAY,
      total: draftInvoice.total,
    });
    // Due in the settings' 14 days.
    const due = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 14 * 86_400_000).toISOString();
    expect(invoice.dueOn).toBe(due.slice(0, 10));
    const order = await orderOf(invoice);
    expect(order).toMatchObject({
      invoice_id: invoice.id,
      state: "pending",
      total: invoice.total,
      paid: 0,
      credited: 0,
      expires_at: null,
      placed_as: "staff",
      person_id: personId,
      pay: "full",
      tax_amount: invoice.taxTotal,
    });
    expect(order.balance_due_at?.slice(0, 10)).toBe(invoice.dueOn);
    // One order line per invoice line: the record's (its quantity, its places held), and the
    // typed one, a line of the invoice itself; each with the line's tax.
    const { results: lines } = await env.DB.prepare(
      "SELECT object_type, record_id, quantity, unit_price, line_total, line_discount, tax_amount FROM core_order_line WHERE order_id = ? ORDER BY position",
    )
      .bind(order.id)
      .all();
    expect(lines).toEqual([
      {
        object_type: TICKET_TYPE,
        record_id: ticket,
        quantity: 2,
        unit_price: 5000,
        line_total: 10_000,
        line_discount: 0,
        tax_amount: invoice.lines[0]?.tax,
      },
      {
        object_type: "invoice",
        record_id: invoice.id,
        quantity: 1,
        unit_price: 6000,
        line_total: 6000,
        line_discount: 0,
        tax_amount: invoice.lines[1]?.tax,
      },
    ]);
    expect(await held(ticket)).toEqual({ held: 2, taken: 0 });
    expect((await eventsOf(invoice.id)).map((e) => [e.event, e.amount])).toEqual([
      ["issued", invoice.total],
    ]);
  });

  it("does not expire, and is overdue after its due date", async () => {
    const invoice = await issued();
    const later = new Date(Date.now() + 30 * 86_400_000);
    await run(
      "order.expireDue",
      {},
      staff(admin, {
        actor: "automation",
        origin: { surface: "automation", automationId: "system.orders" },
        clock: () => later,
      }),
    );
    expect((await orderOf(invoice)).state).toBe("pending");
    const now = await run<{ items: { id: string }[] }>("order.overdue", { limit: 200 }, staff());
    expect(now.items.map((o) => o.id)).not.toContain(invoice.orderId);
    const after = await run<{ items: { id: string }[] }>(
      "order.overdue",
      { limit: 200 },
      staff(admin, { clock: () => later }),
    );
    expect(after.items.map((o) => o.id)).toContain(invoice.orderId);
  });

  it("is moved only through the invoice: order.recordPayment, order.cancel and order.adjust refuse it", async () => {
    const invoice = await issued();
    await run(
      "user.setPermissions",
      { id: member.id, permissions: ["orders:payments", "orders:discount"] },
      context(admin),
    );
    try {
      const id = invoice.orderId as string;
      for (const [name, input] of [
        ["order.recordPayment", { id, amount: 100, kind: "cash", receivedOn: TODAY }],
        ["order.cancel", { id }],
        ["order.adjust", { id, amount: 100, reason: "x" }],
        [
          "order.extendBalanceDue",
          { id, balanceDueAt: new Date(Date.now() + 86_400_000).toISOString() },
        ],
      ] as const) {
        const refused = await refusal(run(name, input, staff(member)));
        expect(refused.details.rule, name).toBe("invoice_order");
      }
      // A customer cannot open its checkout: an invoice is paid from its page (step 8).
      const buyer = await createBuyer(admin, "invcust");
      const asBuyer = await refusal(
        run(
          "order.checkout",
          { id, returnUrl: RETURN },
          outside(buyer.principal, { integrations: runtime, events }),
        ),
      );
      expect(asBuyer.code).toBe("not_found");
      expect(await orderOf(invoice)).toMatchObject({ state: "pending", total: invoice.total });
    } finally {
      await run("user.setPermissions", { id: member.id, permissions: [] }, context(admin));
    }
  });

  it("typed without tax: lines priced with their tax, a discount a staff adjustment, the rounding taken back", async () => {
    const ticket = await ticketType();
    const invoice = await issue(
      (
        await draft(ticket, {
          extra: { taxMode: "exclusive" },
          lines: [
            // 50.00 with tax is 45.45 without: two are 90.90 and 9.09 tax, 99.99.
            { item: { object: TICKET_TYPE, id: ticket }, quantity: 2 },
            {
              description: "Workshop",
              quantity: 1,
              unitPrice: 10_000,
              discount: { kind: "percent", value: 1000, reason: "Regular" },
            },
          ],
        })
      ).id,
    );
    expect(invoice.lines.map((l) => l.total)).toEqual([9999, 9900]);
    const order = await orderOf(invoice);
    expect(order).toMatchObject({ total: 9999 + 9900, discount: 1 + 1100, tax_amount: 909 + 900 });
    const { results: adjustments } = await env.DB.prepare(
      "SELECT kind, amount, percent, reason, given_by, source_object, source_id FROM core_order_adjustment WHERE order_id = ? ORDER BY amount",
    )
      .bind(order.id)
      .all();
    expect(adjustments).toEqual([
      {
        kind: "rounding",
        amount: 1,
        percent: null,
        reason: null,
        given_by: null,
        source_object: "invoice",
        source_id: invoice.id,
      },
      {
        kind: "staff",
        amount: 1100,
        percent: 10,
        reason: "Regular",
        given_by: admin.id,
        source_object: "invoice",
        source_id: invoice.id,
      },
    ]);
  });

  it("a line discount needs orders:discount, and over the limit waits for approval", async () => {
    const withDiscount = (value: number) =>
      draft("", {
        lines: [
          {
            description: "Workshop",
            unitPrice: 20_000,
            discount: { kind: "amount", value, reason: "Regular" },
          },
        ],
      });
    const small = await withDiscount(1_000);
    const refused = await refusal(issue(small.id, staff(desk)));
    expect(refused).toMatchObject({ code: "forbidden", details: { rule: "discount_permission" } });
    // Over 20% (or 100.00): it waits for an admin.
    const large = await withDiscount(5_000);
    await expect(issue(large.id)).rejects.toBeInstanceOf(PendingApprovalError);
    expect(
      await env.DB.prepare("SELECT state FROM core_invoice WHERE id = ?").bind(large.id).first(),
    ).toEqual({ state: "draft" });
    expect((await issue(small.id)).state).toBe("issued");
  });

  it("an AI asks to issue and a person approves", async () => {
    await setPreset("autonomous");
    const invoice = await draft(await ticketType());
    await expect(
      issue(
        invoice.id,
        staff(admin, { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_x" } }),
      ),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect(
      await env.DB.prepare("SELECT state FROM core_invoice WHERE id = ?").bind(invoice.id).first(),
    ).toEqual({ state: "draft" });
  });

  it("goods are refused (they need a delivery), and so is a record whose price changed since", async () => {
    const goods = await refusal(
      run(
        "invoice.create",
        { billTo: { personId }, lines: [{ item: { object: TEE, id: tee } }] },
        staff(),
      ),
    );
    expect(goods.details.rule).toBe("goods_need_delivery");
    const ticket = await ticketType();
    const invoice = await draft(ticket);
    await run(
      "record.update",
      { object: TICKET_TYPE, id: ticket, values: { price: 55 } },
      context(admin),
    );
    const changed = await refusal(issue(invoice.id));
    expect(changed.details.rule).toBe("price_changed");
  });

  it("no deal, and with tax at checkout on its checkout asks the provider for no tax (criterion 5)", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    // At checkout the pass is 40.50 (the deal); on an invoice it is what the invoice says.
    const sold = await run<{ total: number; discount: number }>(
      "order.start",
      { lines: [{ object: CLASS, id: pass, quantity: 1 }], email: `${unique("g")}@buyers.example` },
      outside({ kind: "public" }, { integrations: runtime, events }),
    );
    expect(sold).toMatchObject({ total: 4050, discount: 450 });
    const invoice = await issue(
      (await draft("", { lines: [{ item: { object: CLASS, id: pass }, quantity: 2 }] })).id,
    );
    const order = await orderOf(invoice);
    expect(order).toMatchObject({ total: 9000, discount: 0, tax_amount: 818 });
    const opened = await run<{ amount: number; kind: string }>(
      "order.checkout",
      { id: order.id, returnUrl: RETURN },
      staff(),
    );
    expect(opened).toMatchObject({ amount: 9000, kind: "full" });
    expect(gw.checkouts.at(-1)).not.toHaveProperty("tax");
    const kept = await env.DB.prepare(
      "SELECT tax_lines FROM core_order_checkout WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(kept).toEqual({ tax_lines: null });
    await providerPays(order.id);
    expect(await orderOf(invoice)).toMatchObject({ state: "paid", tax_amount: 818 });
  });
});

describe("paying an invoice online (criteria 6 and 7)", () => {
  it("the verified payment makes it paid, writes payment_applied and grants the tickets", async () => {
    const ticket = await ticketType();
    const invoice = await issued(ticket);
    await run("order.checkout", { id: invoice.orderId, returnUrl: RETURN }, staff());
    await providerPays(invoice.orderId as string);
    const read = await run<Invoice>("invoice.get", { id: invoice.id }, staff());
    expect(read.state).toBe("paid");
    expect((await eventsOf(invoice.id)).map((e) => [e.event, e.method])).toEqual([
      ["issued", null],
      ["payment_applied", "provider"],
    ]);
    const granted = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_order_grant WHERE order_id = ?",
    )
      .bind(invoice.orderId)
      .first<{ n: number }>();
    expect(granted?.n).toBe(2);
    expect(await held(ticket)).toEqual({ held: 0, taken: 2 });
  });

  it("part payments: refused online unless allowed on the invoice, then at least the minimum", async () => {
    const invoice = await issued();
    const id = invoice.orderId as string;
    const part = await refusal(
      run("order.checkout", { id, returnUrl: RETURN, amount: 5_000 }, staff()),
    );
    expect(part.details.rule).toBe("charge_amount");
    const allowed = await run<Invoice & { allowPartPayments: boolean }>(
      "invoice.allowPartPayments",
      { id: invoice.id, allow: true },
      staff(desk),
    );
    expect(allowed.allowPartPayments).toBe(true);
    expect(
      (await refusal(run("order.checkout", { id, returnUrl: RETURN, amount: 500 }, staff())))
        .details.rule,
    ).toBe("charge_amount");
    const opened = await run<{ amount: number; kind: string }>(
      "order.checkout",
      { id, returnUrl: RETURN, amount: 5_000 },
      staff(),
    );
    expect(opened).toMatchObject({ amount: 5_000, kind: "part" });
    await providerPays(id);
    expect((await run<Invoice>("invoice.get", { id: invoice.id }, staff())).state).toBe(
      "part_paid",
    );
    expect(await orderOf(invoice)).toMatchObject({ state: "part_paid", paid: 5_000 });
  });
});

// --- Proof (a): numbering ---------------------------------------------------------------------

describe("numbering under concurrency (criterion 2, proof a)", () => {
  it("twenty invoices issued at once take twenty consecutive numbers, each its own order", async () => {
    const ticket = await ticketType({}, 100);
    const drafts: string[] = [];
    for (let n = 0; n < 20; n += 1) drafts.push((await draft(ticket, { quantity: 1 })).id);
    const before = await counter();
    const out = await Promise.all(drafts.map((id) => issue(id)));
    const seqs = out.map((i) => Number(i.number?.slice(4))).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before.next_number + i));
    expect(new Set(out.map((i) => i.orderId)).size).toBe(20);
    expect((await counter()).next_number).toBe(before.next_number + 20);
  });

  it("a failed issue takes no number and makes no order", async () => {
    // Two places, three asked for: the claim fails the issuing batch after its number was given.
    const ticket = await ticketType({}, 2);
    const invoice = await draft(ticket, { quantity: 3 });
    const before = await counter();
    const refused = await refusal(issue(invoice.id));
    expect(refused.code).not.toBe("internal");
    expect(await counter()).toEqual(before);
    const row = await env.DB.prepare(
      "SELECT state, number, order_id FROM core_invoice WHERE id = ?",
    )
      .bind(invoice.id)
      .first();
    expect(row).toEqual({ state: "draft", number: null, order_id: null });
    const orders = await env.DB.prepare("SELECT count(*) AS n FROM core_order WHERE invoice_id = ?")
      .bind(invoice.id)
      .first<{ n: number }>();
    expect(orders?.n).toBe(0);
    // Issued twice, the second is refused and takes nothing.
    const ok = await issued();
    const again = await counter();
    expect((await refusal(issue(ok.id))).details.rule).toBe("document_immutable");
    expect(await counter()).toEqual(again);
    // No order can be made for an invoice outside its issuing batch.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_order (id, person_id, email, currency, total, state, placed_as, created_at, updated_at, invoice_id) VALUES ('ord_fake', NULL, NULL, 'AUD', ?, 'pending', 'staff', ?, ?, ?)",
      )
        .bind(ok.total, TODAY, TODAY, ok.id)
        .run(),
    ).rejects.toThrow(/core_order_invoice|UNIQUE/);
  });
});

// --- Proof (b): an issued invoice is never changed --------------------------------------------

describe("an issued invoice cannot be changed by any write path (criterion 3, proof b)", () => {
  it("every operation, record.*, and raw writes to the invoice, its order, its lines and adjustments", async () => {
    const invoice = await issued();
    const line = invoice.lines[0] as Line;
    for (const [name, input] of [
      ["invoice.update", { id: invoice.id, title: "Changed" }],
      ["invoice.addLine", { id: invoice.id, line: { description: "More", unitPrice: 100 } }],
      ["invoice.updateLine", { lineId: line.id, change: { quantity: 1 } }],
      ["invoice.removeLine", { lineId: line.id }],
      ["invoice.delete", { id: invoice.id }],
      ["record.update", { object: "invoice", id: invoice.id, values: { total: 1 } }],
      ["record.update", { object: "order", id: invoice.orderId, values: { state: "paid" } }],
      ["record.update", { object: "order", id: invoice.orderId, values: { total: 1 } }],
    ] as const) {
      const refused = await refusal(run(name, input, staff()));
      expect(["conflict", "forbidden", "invalid_input", "not_found"], name).toContain(refused.code);
    }
    const raw = [
      "UPDATE core_invoice SET total = 1, net_total = 1, tax_total = 0, version = version + 1 WHERE id = ?1",
      "UPDATE core_invoice SET bill_to_name = 'Someone else', version = version + 1 WHERE id = ?1",
      "UPDATE core_invoice SET number = 'INV-9999', version = version + 1 WHERE id = ?1",
      "UPDATE core_invoice SET state = 'paid', version = version WHERE id = ?1",
      "UPDATE core_invoice_line SET line_total = 1 WHERE invoice_id = ?1",
      "DELETE FROM core_invoice WHERE id = ?1",
      "UPDATE core_order SET total = 1, version = version + 1 WHERE invoice_id = ?1",
      "UPDATE core_order SET credited = total + 1, version = version + 1 WHERE invoice_id = ?1",
      "UPDATE core_order SET expires_at = '2000-01-01T00:00:00.000Z' WHERE invoice_id = ?1",
      "UPDATE core_order SET invoice_id = NULL WHERE invoice_id = ?1",
      "UPDATE core_order_line SET unit_price = 1, line_total = quantity WHERE order_id = (SELECT order_id FROM core_invoice WHERE id = ?1)",
      "UPDATE core_order_line SET line_discount = 1 WHERE order_id = (SELECT order_id FROM core_invoice WHERE id = ?1)",
    ];
    for (const sql of raw) {
      await expect(env.DB.prepare(sql).bind(invoice.id).run(), sql).rejects.toThrow();
    }
    const after = await run<Invoice>("invoice.get", { id: invoice.id }, staff());
    expect(after).toMatchObject({ total: invoice.total, number: invoice.number, state: "issued" });
    expect(await orderOf(invoice)).toMatchObject({ total: invoice.total, credited: 0 });
  });

  it("an invoice's adjustments are never taken off, and the host's kinds are on no other order", async () => {
    const invoice = await issued(undefined, {
      lines: [
        {
          description: "Workshop",
          unitPrice: 10_000,
          discount: { kind: "amount", value: 500, reason: "Regular" },
        },
      ],
    });
    await expect(
      env.DB.prepare(
        "UPDATE core_order_adjustment SET removed_at = ?, removed_by = 'x' WHERE order_id = ?",
      )
        .bind(TODAY, invoice.orderId)
        .run(),
    ).rejects.toThrow(/core_order_adjustment_fixed/);
    const other = await run<{ id: string; lines: { id: string }[] }>(
      "order.start",
      {
        lines: [{ object: TICKET_TYPE, id: await ticketType(), quantity: 1 }],
        email: `${unique("g")}@buyers.example`,
      },
      outside({ kind: "public" }, { integrations: runtime, events }),
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO core_order_adjustment (id, order_id, line_id, kind, source_object, source_id, amount, created_at) VALUES ('oad_fake', ?, NULL, 'prepaid', 'invoice', ?, 100, ?)",
      )
        .bind(other.id, invoice.id, TODAY)
        .run(),
    ).rejects.toThrow(/core_order_adjustment_pending/);
  });
});

// --- Step 4: payments recorded on an invoice --------------------------------------------------

describe("a payment recorded on an invoice (criteria 7 and 8)", () => {
  it("any amount up to the balance, naming the person, moving the invoice, in the log; never more", async () => {
    const ticket = await ticketType();
    const invoice = await issued(ticket);
    const over = await refusal(recordPayment(invoice.id, invoice.total + 1));
    expect(over).toMatchObject({ details: { rule: "overpaid", owed: invoice.total } });
    const first = await recordPayment(invoice.id, 4_000);
    expect(first.invoice.state).toBe("part_paid");
    expect(await orderOf(invoice)).toMatchObject({ state: "part_paid", paid: 4_000 });
    const row = await env.DB.prepare(
      "SELECT method, recorded_kind, recorded_by, amount FROM core_order_payment WHERE event_id = ?",
    )
      .bind(first.paymentId)
      .first();
    expect(row).toEqual({
      method: "recorded",
      recorded_kind: "transfer",
      recorded_by: desk.id,
      amount: 4_000,
    });
    // What it bought is given at the first payment.
    expect(await held(ticket)).toEqual({ held: 0, taken: 2 });
    const rest = await recordPayment(invoice.id, invoice.total - 4_000);
    expect(rest.invoice.state).toBe("paid");
    expect((await refusal(recordPayment(invoice.id, 1))).details.rule).toBe("invoice_state");
    const log = await eventsOf(invoice.id);
    expect(log.map((e) => [e.event, e.amount, e.method])).toEqual([
      ["issued", invoice.total, null],
      ["payment_applied", 4_000, "recorded"],
      ["payment_applied", invoice.total - 4_000, "recorded"],
    ]);
    // On the Person's timeline, and audited.
    const post = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id WHERE l.record_id = ? AND a.subject LIKE 'Payment recorded%'",
    )
      .bind(personId)
      .first<{ n: number }>();
    expect(post?.n).toBeGreaterThan(0);
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'invoice.recordPayment' AND user_id = ?",
    )
      .bind(desk.id)
      .first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(2);
  });

  it("is refused for an AI, an MCP client, an automation, an extension, and anyone without invoices:payments (proof d)", async () => {
    const invoice = await issued();
    for (const extra of NOT_A_PERSON) {
      const refused = await refusal(recordPayment(invoice.id, 1_000, staff(admin, extra)));
      expect(refused.code, extra.actor).toBe("forbidden");
    }
    await setPreset("autonomous");
    const byAssistant = await refusal(
      recordPayment(invoice.id, 1_000, staff(admin, NOT_A_PERSON[0] as never)),
    );
    expect(byAssistant.code).toBe("forbidden");
    expect((await refusal(recordPayment(invoice.id, 1_000, staff(member)))).code).toBe("forbidden");
    expect(await orderOf(invoice)).toMatchObject({ state: "pending", paid: 0 });
  });

  it("a reversal adds a row and moves the invoice back; a provider's payment is not reversed", async () => {
    const invoice = await issued();
    const paid = await recordPayment(invoice.id, invoice.total);
    for (const extra of NOT_A_PERSON.slice(0, 2)) {
      const refused = await refusal(
        run(
          "invoice.reversePayment",
          { paymentId: paid.paymentId, reason: "x" },
          staff(admin, extra),
        ),
      );
      expect(refused.code).toBe("forbidden");
    }
    const byOrder = await refusal(
      run("order.reversePayment", { paymentId: paid.paymentId, reason: "x" }, staff()),
    );
    expect(byOrder.details.rule).toBe("invoice_order");
    const reversed = await run<{ paymentId: string; invoice: Invoice }>(
      "invoice.reversePayment",
      { paymentId: paid.paymentId, reason: "Entered on the wrong invoice" },
      staff(desk),
    );
    expect(reversed.invoice.state).toBe("part_paid");
    expect(await orderOf(invoice)).toMatchObject({ state: "part_paid", paid: 0 });
    expect((await eventsOf(invoice.id)).map((e) => e.event)).toEqual([
      "issued",
      "payment_applied",
      "payment_reversed",
    ]);
    // A provider's payment is refunded through a credit note, not reversed.
    const online = await issued();
    await run("order.checkout", { id: online.orderId, returnUrl: RETURN }, staff());
    const { event } = await providerPays(online.orderId as string);
    const refused = await refusal(
      run(
        "invoice.reversePayment",
        { paymentId: (event as { eventId: string }).eventId, reason: "x" },
        staff(desk),
      ),
    );
    expect(refused.details.rule).toBe("reverse_method");
  });
});

// --- Step 5: credit notes and void ------------------------------------------------------------

describe("credit notes (criterion 9)", () => {
  it("a part of an unpaid invoice reduces what is owed; the checkout and a payment follow", async () => {
    const invoice = await issued();
    const typed = invoice.lines[1] as Line;
    const note = await credit({
      invoiceId: invoice.id,
      lines: [{ lineId: typed.id, quantity: 0.5 }],
      settle: "reduce",
    });
    expect(note).toMatchObject({ state: "draft", number: null, total: 2000 });
    const out = await issueCredit(note.id);
    expect(out.number).toMatch(/^CN-\d{4}$/);
    expect(await orderOf(invoice)).toMatchObject({
      state: "pending",
      credited: 2000,
      total: invoice.total,
    });
    const order = await run<{ balance: number }>("order.get", { id: invoice.orderId }, staff());
    expect(order.balance).toBe(invoice.total - 2000);
    expect(
      (await run<{ money: unknown }>("invoice.get", { id: invoice.id }, staff())).money,
    ).toEqual({
      paid: 0,
      credited: 2000,
      refunded: 0,
      balance: invoice.total - 2000,
      orderState: "pending",
    });
    const opened = await run<{ amount: number; kind: string }>(
      "order.checkout",
      { id: invoice.orderId, returnUrl: RETURN },
      staff(),
    );
    expect(opened).toMatchObject({ amount: invoice.total - 2000, kind: "balance" });
    expect((await refusal(recordPayment(invoice.id, invoice.total - 1999))).details.rule).toBe(
      "overpaid",
    );
    expect((await recordPayment(invoice.id, invoice.total - 2000)).invoice.state).toBe("paid");
    expect((await eventsOf(invoice.id)).map((e) => [e.document_kind, e.event])).toEqual([
      ["invoice", "issued"],
      ["credit_note", "issued"],
      ["credit_note", "credited"],
      ["invoice", "payment_applied"],
    ]);
  });

  it("beyond the unpaid part: a provider payment's refund waits for approval, a recorded one for a person's paid back", async () => {
    const invoice = await issued();
    // Half online, half by transfer.
    await run("invoice.allowPartPayments", { id: invoice.id, allow: true }, staff(desk));
    await run("order.checkout", { id: invoice.orderId, returnUrl: RETURN, amount: 8_000 }, staff());
    await providerPays(invoice.orderId as string);
    const byHand = await recordPayment(invoice.id, invoice.total - 8_000);
    const all = invoice.lines.map((l) => ({ lineId: l.id }));
    const reduceOnly = await issueCredit(
      (await credit({ invoiceId: invoice.id, lines: all, settle: "reduce" })).id,
    ).catch((e) => e);
    expect(reduceOnly.details?.rule).toBe("credit_beyond_owed");
    const note = await issueCredit(
      (await credit({ invoiceId: invoice.id, lines: all, settle: "both" })).id,
    );
    // Newest first: the transfer, then the provider's.
    expect(note.refunds.map((r) => [r.method, r.amount, Boolean(r.refundId)])).toEqual([
      ["recorded", invoice.total - 8_000, false],
      ["provider", 8_000, true],
    ]);
    expect(note.pending).toHaveLength(1);
    expect(note.invoice?.state).toBe("paid");
    // A person approves the provider's; the provider confirms it.
    await run("approval.approve", { actionIds: note.pending }, staff());
    await providerRefunds(gw.action);
    // The person who paid it back records it, for what the credit note owes, no other amount.
    const wrong = await refusal(
      run(
        "order.recordRefund",
        {
          id: invoice.orderId,
          paymentId: byHand.paymentId,
          amount: 1,
          kind: "transfer",
          reason: "Credit",
        },
        staff(desk),
      ),
    );
    expect(wrong.details.rule).toBe("refund_amount");
    await run(
      "order.recordRefund",
      { id: invoice.orderId, paymentId: byHand.paymentId, kind: "transfer", reason: "Credit" },
      staff(desk),
    );
    expect(await orderOf(invoice)).toMatchObject({ state: "refunded", refunded: invoice.total });
    const after = await run<CreditNote>("creditNote.get", { id: note.id }, staff());
    expect(after.refunds.every((r) => r.refundId !== null)).toBe(true);
    expect((await eventsOf(invoice.id)).map((e) => e.event)).toEqual([
      "issued",
      "payment_applied",
      "payment_applied",
      "issued",
      "credited",
      "refund_confirmed",
      "paid_back",
    ]);
  });

  it("void credits an unpaid invoice in full, cancels its order and gives its places back", async () => {
    const ticket = await ticketType();
    const invoice = await issued(ticket);
    expect(await held(ticket)).toEqual({ held: 2, taken: 0 });
    for (const extra of NOT_A_PERSON.slice(0, 2)) {
      expect(
        (await refusal(run("invoice.void", { id: invoice.id, reason: "x" }, staff(admin, extra))))
          .code,
      ).toBe("forbidden");
    }
    const voided = await run<CreditNote>(
      "invoice.void",
      { id: invoice.id, reason: "Booked twice" },
      staff(desk),
    );
    expect(voided).toMatchObject({ state: "issued", total: invoice.total });
    expect(voided.invoice?.state).toBe("void");
    expect(await orderOf(invoice)).toMatchObject({ state: "cancelled", credited: invoice.total });
    expect(await held(ticket)).toEqual({ held: 0, taken: 0 });
    expect((await eventsOf(invoice.id)).map((e) => e.event)).toEqual([
      "issued",
      "issued",
      "credited",
      "voided",
    ]);
    expect(
      (await refusal(run("invoice.void", { id: invoice.id, reason: "x" }, staff(desk)))).code,
    ).toBe("conflict");
    // Something paid: credited instead.
    const paid = await issued();
    await recordPayment(paid.id, 1_000);
    expect(
      (await refusal(run("invoice.void", { id: paid.id, reason: "x" }, staff(desk)))).details.rule,
    ).toBe("void_paid");
  });

  it("credited in full with nothing paid: credited, its order cancelled", async () => {
    const invoice = await issued();
    const note = await issueCredit(
      (
        await credit({
          invoiceId: invoice.id,
          lines: invoice.lines.map((l) => ({ lineId: l.id })),
          settle: "reduce",
        })
      ).id,
    );
    expect(note.invoice?.state).toBe("credited");
    expect((await orderOf(invoice)).state).toBe("cancelled");
  });

  it("issuing a credit note or voiding is a person's with invoices:credit (proof d)", async () => {
    const invoice = await issued();
    const note = await credit({
      invoiceId: invoice.id,
      amount: { value: 1_000, taxRate: "gst" },
      settle: "reduce",
    });
    await setPreset("autonomous");
    for (const extra of NOT_A_PERSON) {
      expect((await refusal(issueCredit(note.id, staff(admin, extra)))).code, extra.actor).toBe(
        "forbidden",
      );
    }
    expect((await refusal(issueCredit(note.id, staff(member)))).code).toBe("forbidden");
    // The assistant may draft one for a person.
    const drafted = await credit(
      { invoiceId: invoice.id, amount: { value: 500, taxRate: "gst" } },
      staff(admin, NOT_A_PERSON[0] as never),
    );
    expect(drafted.state).toBe("draft");
    expect(await orderOf(invoice)).toMatchObject({ credited: 0 });
  });
});

// --- Proof (c): never more back than was paid ---------------------------------------------------

describe("credit notes and refunds never give back more than was paid (proof c)", () => {
  it("with a deal live and tax at checkout on: per line, per rate, in total, and never by order.refund too", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    const invoice = await issue(
      (
        await draft("", {
          lines: [
            { item: { object: CLASS, id: pass }, quantity: 2 },
            { description: "Coaching", quantity: 1, unitPrice: 3_000 },
          ],
        })
      ).id,
    );
    expect(invoice.total).toBe(12_000);
    await run("order.checkout", { id: invoice.orderId, returnUrl: RETURN }, staff());
    await providerPays(invoice.orderId as string);
    const [passLine, coaching] = invoice.lines as [Line, Line];
    // A line beyond its quantity, an amount beyond its rate, and beyond the invoice: refused.
    expect(
      (
        await refusal(
          credit({ invoiceId: invoice.id, lines: [{ lineId: passLine.id, quantity: 3 }] }),
        )
      ).details.rule,
    ).toBe("credit_quantity");
    expect(
      (await refusal(credit({ invoiceId: invoice.id, amount: { value: 12_001, taxRate: "gst" } })))
        .details.rule,
    ).toBe("credit_beyond_invoice");
    // An order.refund of what the invoice was paid is refused: it goes back by a credit note.
    expect(
      (await refusal(run("order.refund", { id: invoice.orderId, reason: "x" }, staff()))).details
        .rule,
    ).toBe("invoice_order");
    // Two drafts for the whole pass line: the first issued, the second refused at issue.
    const first = await credit({
      invoiceId: invoice.id,
      lines: [{ lineId: passLine.id }],
      settle: "refund",
    });
    const second = await credit({
      invoiceId: invoice.id,
      lines: [{ lineId: passLine.id }],
      settle: "refund",
    });
    const issuedFirst = await issueCredit(first.id);
    expect(issuedFirst.refunds.map((r) => r.amount)).toEqual([passLine.total]);
    expect((await refusal(issueCredit(second.id))).details.rule).toBe("credit_beyond_invoice");
    // Part of the coaching, then all that is left, then nothing more.
    const part = await issueCredit(
      (
        await credit({
          invoiceId: invoice.id,
          lines: [{ lineId: coaching.id, quantity: 0.5 }],
          settle: "refund",
        })
      ).id,
    );
    expect(part.total).toBe(1_500);
    const rest = await issueCredit(
      (await credit({ invoiceId: invoice.id, lines: [{ lineId: coaching.id }], settle: "refund" }))
        .id,
    );
    expect(rest.total).toBe(1_500);
    expect(
      (await refusal(credit({ invoiceId: invoice.id, amount: { value: 1, taxRate: "gst" } })))
        .details.rule,
    ).toBe("credit_beyond_invoice");
    const asked = await env.DB.prepare(
      "SELECT sum(amount) AS n FROM core_order_refund WHERE order_id = ?",
    )
      .bind(invoice.orderId)
      .first<{ n: number }>();
    const paid = (await orderOf(invoice)).paid;
    expect(asked?.n).toBe(paid);
    const credited = await env.DB.prepare(
      "SELECT sum(total) AS n, sum(tax_total) AS tax FROM core_credit_note WHERE invoice_id = ? AND state = 'issued'",
    )
      .bind(invoice.id)
      .first<{ n: number; tax: number }>();
    expect(credited).toEqual({ n: invoice.total, tax: invoice.taxTotal });
  });

  it("a refund beyond what was paid is refused, and a recorded payment owed back cannot be reversed", async () => {
    const invoice = await issued();
    const byHand = await recordPayment(invoice.id, 3_000);
    // 3,000 paid, the rest owed: crediting everything takes off what is owed and gives back 3,000.
    const refundOnly = await refusal(
      issueCredit(
        (
          await credit({
            invoiceId: invoice.id,
            amount: { value: 1_000, taxRate: "gst" },
            settle: "refund",
          })
        ).id,
      ),
    );
    expect(refundOnly.details.rule).toBe("credit_owed_first");
    const note = await issueCredit(
      (
        await credit({
          invoiceId: invoice.id,
          lines: invoice.lines.map((l) => ({ lineId: l.id })),
          settle: "both",
        })
      ).id,
    );
    expect(note.refunds.map((r) => [r.method, r.amount])).toEqual([["recorded", 3_000]]);
    expect(await orderOf(invoice)).toMatchObject({
      state: "paid",
      paid: 3_000,
      credited: invoice.total - 3_000,
    });
    const reverse = await refusal(
      run("invoice.reversePayment", { paymentId: byHand.paymentId, reason: "x" }, staff(desk)),
    );
    expect(reverse.details.rule).toBe("reverse_refunded");
    // Paid back once, for what was owed back; nothing more.
    await run(
      "order.recordRefund",
      { id: invoice.orderId, paymentId: byHand.paymentId, kind: "cash", reason: "Credit" },
      staff(desk),
    );
    expect(
      (
        await refusal(
          run(
            "order.recordRefund",
            { id: invoice.orderId, paymentId: byHand.paymentId, kind: "cash", reason: "Again" },
            staff(desk),
          ),
        )
      ).details.rule,
    ).toBe("invoice_order");
    expect(await orderOf(invoice)).toMatchObject({ state: "refunded", refunded: 3_000 });
  });
});

describe("the event log for a document's life (criterion 18)", () => {
  it("one row per event, in order, in the event's own batch", async () => {
    const invoice = await issued();
    const paid = await recordPayment(invoice.id, 2_000);
    await run(
      "invoice.reversePayment",
      { paymentId: paid.paymentId, reason: "Wrong invoice" },
      staff(desk),
    );
    const log = await eventsOf(invoice.id);
    expect(log.map((e) => e.event)).toEqual(["issued", "payment_applied", "payment_reversed"]);
    expect(log.map((e) => e.seq)).toEqual([...log.map((e) => e.seq)].sort((a, b) => a - b));
  });
});
