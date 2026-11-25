// Stage 37 step 3: goods and delivery on orders, and order.quote (ADRs 0682, 0683 and 0685).
// The declarations and their checks; where an item is sold, enforced from the order's channel the
// host works out (on the public, customer and staff paths); one delivery per goods order, post
// with an address in the option's countries (or "everywhere else"), collect and take it now with
// none; postage priced by the host, fixed or free over an amount, the quote and the order
// agreeing; a client's price or postage ignored; order.quote holding nothing and saying what is
// sold out; a paid post order granting one shipment and a take-it-now order none; the address
// kept out of every view and the audit log, read one order at a time, passed to the provider as
// where the goods go for tax, and blanked by the buyer's erase. Acceptance criteria 2, 5, 6 (the
// host's part), 7 (as far as orders go), 8 (the grant), 9, 10 (order.quote), 18 (addresses), 19
// (the runtime refusal) and 20 (the quote's statements).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ActingUser, checkManifest, createInvoker, memoryEventSink } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditRows, context, createUser, db, unique } from "./helpers.ts";
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
import { paymentsDouble } from "./payments-double.ts";

const ext = extId("gds");
const ITEM = `${ext}.item`;
const VARIANT = `${ext}.variant`;
const PASS = `${ext}.pass`;
const DELIVERY = `${ext}.delivery`;
const SHIPMENT = `${ext}.shipment`;
const GOODS_CODE = "txcd_99999999";
const POSTAGE_CODE = "txcd_92010001";
const RETURN = "https://shop.example.com/thanks";

interface OrderOut {
  id: string;
  state: string;
  total: number;
  token?: string | null;
  lines: { object: string; recordId: string; unitPrice: number; total: number }[];
}

interface Quote {
  currency: string;
  channel: string | null;
  lines: {
    position: number;
    object: string;
    unitPrice: number;
    total: number;
    goods: boolean;
    availability: Record<string, unknown> | null;
  }[];
  delivery: { kind: string; price: number; free: boolean; charged: number } | null;
  goodsTotal: number;
  total: number;
  ready: boolean;
  problems: { rule: string; line?: number }[];
}

const select = (label: string, ...values: string[]) => ({
  type: "select" as const,
  label,
  options: values.map((value) => ({ value, label: value })),
});

function shopManifest(id: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      item: {
        label: "Item",
        plural: "Items",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          whereSold: select("Where sold", "online", "in_person", "both"),
        },
        public: { read: ["name", "whereSold"] },
      },
      variant: {
        label: "Variant",
        plural: "Variants",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          item: { type: "relation", label: "Item", to: `${id}.item` },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        // Sold where its item is sold (decision 3).
        sellable: {
          price: "price",
          goods: { soldIn: "item.whereSold" },
          tax: { code: GOODS_CODE },
        },
        stock: { show: "exact" },
        public: { read: ["name", "item", "price"] },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
        },
        sellable: { price: "price", tax: { code: GOODS_CODE } },
        public: { read: ["name", "price"] },
      },
      delivery: {
        label: "Delivery option",
        plural: "Delivery options",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          kind: select("Kind", "post", "collect", "here"),
          freeOver: { type: "currency", label: "Free over", currency: CURRENCY },
          countries: { type: "text", label: "Countries" },
          active: { type: "boolean", label: "Active" },
        },
        sellable: {
          price: "price",
          delivery: {
            kind: "kind",
            freeOver: "freeOver",
            countries: "countries",
            active: "active",
          },
          tax: { code: POSTAGE_CODE },
          grants: {
            object: "shipment",
            set: { name: "line.title", order: "order", buyer: "order.person", option: "item" },
            void: "void",
          },
        },
        public: { read: ["name", "price", "kind", "freeOver", "countries", "active"] },
      },
      shipment: {
        label: "Shipment",
        plural: "Shipments",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          order: { type: "text", label: "Order" },
          buyer: { type: "relation", label: "Buyer", to: "person" },
          option: { type: "relation", label: "Delivery option", to: `${id}.delivery` },
          state: select("State", "to_pack", "sent", "void"),
        },
        states: {
          field: "state",
          initial: "to_pack",
          moves: [
            { from: "to_pack", to: "sent", by: ["staff"] },
            { from: ["to_pack", "sent"], to: "void", by: ["staff", "host"], final: true },
          ],
        },
      },
    },
  });
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;

let admin: ActingUser;
let member: ActingUser;
let alice: Buyer;
let bob: Buyer;
/** Sold online only, sold in person only, sold both ways. */
let hoodie: string;
let drink: string;
let cap: string;
let pass: string;
type OptionKey = "post" | "world" | "collect" | "here" | "off" | "unpriced";
const option = {} as Record<OptionKey, { object: string; id: string }>;

const guest = () => outside(PUBLIC, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

async function variant(soldIn: string | null, stock = 10, price = 60): Promise<string> {
  const item = await create(ITEM, {
    name: unique("Item"),
    ...(soldIn ? { whereSold: soldIn } : {}),
  });
  const id = await create(VARIANT, { name: unique("Variant"), item, price });
  if (stock > 0)
    await run("stock.opening", { object: VARIANT, id, quantity: stock }, context(admin));
  return id;
}

const AU = {
  name: "Alice Buyer",
  line1: "1 Shop Street",
  city: "Melbourne",
  region: "VIC",
  postcode: "3000",
  country: "au",
};
const NZ = { ...AU, city: "Dunedin", region: "Otago", postcode: "9016", country: "NZ" };

type Line = { object: string; id: string; quantity?: number };
const start = (
  lines: Line[],
  delivery?: Record<string, unknown>,
  ctx: Parameters<typeof run>[2] = guest(),
  extra: Record<string, unknown> = {},
) =>
  run<OrderOut>(
    "order.start",
    {
      lines,
      ...(ctx.principal?.kind === "customer" ? {} : { email: `${unique("b")}@buyers.example` }),
      ...(delivery ? { delivery } : {}),
      ...extra,
    },
    ctx,
  );

const quote = (
  lines: Line[],
  delivery?: Record<string, unknown>,
  ctx: Parameters<typeof run>[2] = guest(),
) => run<Quote>("order.quote", { lines, ...(delivery ? { delivery } : {}) }, ctx);

const pay = (order: OrderOut) =>
  run(
    "fixture.verifiedPayment",
    { orderId: order.id, amount: order.total, eventId: unique("evt") },
    context(admin, { actor: "automation" }),
  );

const stockOf = (id: string) =>
  run<{ onHand: number; held: number }>("stock.get", { object: VARIANT, id }, context(member));

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(shopManifest(ext));
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    context(admin),
  );
  alice = await createBuyer(admin, "alice");
  bob = await createBuyer(admin, "bob");
  hoodie = await variant("online");
  drink = await variant("in_person", 10, 4);
  cap = await variant(null, 10, 30);
  pass = await create(PASS, { name: "Ten classes", price: 150 });
  const add = async (key: OptionKey, values: Record<string, unknown>) => {
    option[key] = { object: DELIVERY, id: await create(DELIVERY, values) };
  };
  await add("post", {
    name: "Standard post",
    price: 10,
    kind: "post",
    freeOver: 100,
    countries: "AU",
  });
  await add("world", { name: "International", price: 30, kind: "post", countries: "*" });
  await add("collect", { name: "Collect at the gym", price: 0, kind: "collect" });
  await add("here", { name: "Take it now", price: 0, kind: "here" });
  await add("off", { name: "Express", price: 20, kind: "post", countries: "AU", active: false });
  await add("unpriced", { name: "Courier", kind: "post", countries: "AU" });
  await payments.connect(admin.id);
});

beforeEach(async () => {
  events = memoryEventSink();
  await run("order.settings.update", { tax: false }, context(admin));
});

const post = (address: Record<string, unknown> = AU) => ({ ...option.post, address });

// --- The declarations ---------------------------------------------------------------------------

describe("the goods and delivery declarations", () => {
  const issuesOf = (objects: Record<string, unknown>) =>
    validateManifest({ id: "decl", version: "1.0.0", contractVersion: 1, objects }).issues.map(
      (i) => `${i.path}: ${i.message}`,
    );
  const fields = {
    name: { type: "text", label: "Name" },
    price: { type: "number", label: "Price" },
    words: { type: "text", label: "Words" },
    kind: select("Kind", "post", "collect", "here"),
    sold: select("Sold", "online", "both"),
    odd: select("Odd", "online", "fridge"),
  };
  const thing = (sellable: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    thing: { label: "Thing", plural: "Things", titleField: "name", fields, sellable, ...more },
  });

  it("takes goods sold where a select says, and a delivery option with a kind", () => {
    expect(issuesOf(thing({ price: "price", goods: { soldIn: "sold" } }))).toEqual([]);
    expect(issuesOf(thing({ price: "price", goods: {} }))).toEqual([]);
    expect(
      issuesOf(thing({ price: "price", delivery: { kind: "kind", countries: "words" } })),
    ).toEqual([]);
  });

  it("refuses a soldIn that is not a select of the three, a kind outside post, collect and here, and both at once", () => {
    expect(issuesOf(thing({ price: "price", goods: { soldIn: "words" } }))).toEqual([
      'objects.thing.sellable.goods.soldIn: "words" must be a select field (of thing, or through its relations) whose values are among online, in_person, both',
    ]);
    expect(issuesOf(thing({ price: "price", goods: { soldIn: "odd" } }))).toHaveLength(1);
    expect(
      issuesOf(thing({ price: "price", delivery: { kind: "sold", freeOver: "words" } })),
    ).toEqual(
      expect.arrayContaining([
        'objects.thing.sellable.delivery.kind: "sold" must be a select field of thing whose values are among post, collect, here',
        'objects.thing.sellable.delivery.freeOver: "words" must be a currency or number field of thing',
      ]),
    );
    expect(
      issuesOf(
        thing({ price: "price", goods: {}, delivery: { kind: "kind" }, maxPerOrder: "price" }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "objects.thing.sellable.delivery: A record is goods or a delivery option, not both",
        "objects.thing.sellable.maxPerOrder: A delivery option is one per order: it has no maxPerOrder",
      ]),
    );
  });

  it("makes a sold thing in stock declare goods", () => {
    expect(issuesOf(thing({ price: "price" }, { stock: {} }))).toEqual([
      "objects.thing.sellable.goods: thing has stock and is sold: declare sellable.goods (where it is sold)",
    ]);
  });

  it("a runtime extension cannot declare goods or a delivery option, as it cannot sell", async () => {
    const id = extId("rtg");
    const now = new Date().toISOString();
    const runtime = await checkManifest(db.query, id, shopManifest(id), now, {
      source: "runtime",
    });
    expect(runtime.plan).toBeNull();
    const paths = runtime.issues.filter((i) => i.code === "outside_audience").map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(["objects.variant.sellable", "objects.delivery.sellable"]),
    );
  });
});

// --- Where sold, and the order's channel ------------------------------------------------------

describe("where an item is sold", () => {
  // The host rule this step adds (criterion 6): remove the channel check in orders/goods.ts and
  // the first expectation here fails, because the drink is then posted.
  it("refuses an in-person-only drink posted or collected, on every path", async () => {
    for (const ctx of [guest(), outside(alice.principal), context(member)]) {
      for (const delivery of [post(), option.collect]) {
        expect(await refusal(start([{ object: VARIANT, id: drink }], delivery, ctx))).toMatchObject(
          { code: "invalid_input", details: { rule: "not_sold_here", channel: "online" } },
        );
      }
    }
    const order = await start([{ object: VARIANT, id: drink }], option.here);
    expect(order.state).toBe("pending");
  });

  it("refuses an online-only hoodie taken now, and sells something sold both ways either way", async () => {
    for (const ctx of [guest(), outside(alice.principal), context(member)]) {
      expect(
        await refusal(start([{ object: VARIANT, id: hoodie }], option.here, ctx)),
      ).toMatchObject({ details: { rule: "not_sold_here", channel: "in_person" } });
    }
    await start([{ object: VARIANT, id: hoodie }], post());
    await start([{ object: VARIANT, id: cap }], option.here);
    await start([{ object: VARIANT, id: cap }], option.collect);
  });

  it("works the channel out from the delivery and keeps it on the order", async () => {
    const online = await start(
      [
        { object: VARIANT, id: cap },
        { object: PASS, id: pass },
      ],
      post(),
    );
    const now = await start([{ object: VARIANT, id: cap }], option.here);
    const passOnly = await start([{ object: PASS, id: pass }]);
    const channels = await env.DB.prepare(
      "SELECT id, channel FROM core_order WHERE id IN (?, ?, ?)",
    )
      .bind(online.id, now.id, passOnly.id)
      .all<{ id: string; channel: string | null }>();
    expect(Object.fromEntries(channels.results.map((r) => [r.id, r.channel]))).toEqual({
      [online.id]: "online",
      [now.id]: "in_person",
      [passOnly.id]: null,
    });
    // The channel is written once.
    await expect(
      env.DB.prepare("UPDATE core_order SET channel = 'in_person' WHERE id = ?")
        .bind(online.id)
        .run(),
    ).rejects.toThrow(/core_order_channel_fixed/);
  });
});

// --- The delivery ----------------------------------------------------------------------------------

describe("a goods order's delivery", () => {
  it("needs exactly one delivery, chosen in delivery, and only with goods", async () => {
    expect(await refusal(start([{ object: VARIANT, id: cap }]))).toMatchObject({
      details: { rule: "delivery_needed" },
    });
    expect(
      await refusal(
        start([
          { object: VARIANT, id: cap },
          { ...option.here, quantity: 1 },
        ]),
      ),
    ).toMatchObject({ details: { rule: "delivery_line" } });
    expect(await refusal(start([{ object: PASS, id: pass }], option.here))).toMatchObject({
      details: { rule: "delivery_without_goods" },
    });
    expect(
      await refusal(start([{ object: VARIANT, id: cap }], { object: PASS, id: pass })),
    ).toMatchObject({ details: { rule: "not_delivery" } });
  });

  it("posts to an address in the option's countries; collect and take it now need none", async () => {
    expect(await refusal(start([{ object: VARIANT, id: cap }], { ...option.post }))).toMatchObject({
      details: { rule: "address_needed" },
    });
    expect(await refusal(start([{ object: VARIANT, id: cap }], post(NZ)))).toMatchObject({
      details: { rule: "address_country", country: "NZ" },
    });
    // "Everywhere else" posts where no other post option does: New Zealand, not Australia.
    await start([{ object: VARIANT, id: cap }], { ...option.world, address: NZ });
    expect(
      await refusal(start([{ object: VARIANT, id: cap }], { ...option.world, address: AU })),
    ).toMatchObject({ details: { rule: "address_country", country: "AU" } });
    expect(
      await refusal(start([{ object: VARIANT, id: cap }], { ...option.collect, address: AU })),
    ).toMatchObject({ details: { rule: "address_not_taken" } });
    await start([{ object: VARIANT, id: cap }], option.collect);
    await start([{ object: VARIANT, id: cap }], option.here);
  });

  it("refuses an option that is off or has no price yet", async () => {
    expect(
      await refusal(start([{ object: VARIANT, id: cap }], { ...option.off, address: AU })),
    ).toMatchObject({ details: { rule: "not_for_sale" } });
    expect(
      await refusal(start([{ object: VARIANT, id: cap }], { ...option.unpriced, address: AU })),
    ).toMatchObject({ details: { rule: "no_price" } });
  });

  it("keeps the address one order at a time: for staff (on record), the buyer, and the guest's token", async () => {
    const order = await start([{ object: VARIANT, id: cap }], post(), outside(alice.principal));
    const read = await run<Record<string, unknown>>(
      "order.delivery.get",
      { id: order.id },
      context(member),
    );
    expect(read).toMatchObject({
      channel: "online",
      kind: "post",
      option: { object: DELIVERY, recordId: option.post.id, title: "Standard post" },
      address: { name: "Alice Buyer", line1: "1 Shop Street", country: "AU", line2: null },
      erased: false,
    });
    const audited = (await auditRows("order.delivery.get", member.id)).at(-1);
    expect(JSON.parse(String(audited?.result ?? "{}"))).not.toHaveProperty("address.line1");
    expect(
      await run("order.delivery.get", { id: order.id }, outside(alice.principal)),
    ).toMatchObject({ address: { line1: "1 Shop Street" } });
    expect(
      await refusal(run("order.delivery.get", { id: order.id }, outside(bob.principal))),
    ).toMatchObject({ code: "not_found" });
    expect(await refusal(run("order.delivery.get", { id: order.id }, guest()))).toMatchObject({
      code: "not_found",
    });
    const guestOrder = await start([{ object: VARIANT, id: cap }], option.collect);
    expect(
      await run("order.delivery.get", { id: guestOrder.id, token: guestOrder.token }, guest()),
    ).toMatchObject({ kind: "collect", address: null });

    // The address is in no view, and order.start's audit row does not hold it.
    const views = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND sql LIKE '%core_order_delivery%'",
    ).all();
    expect(views.results).toEqual([]);
    const started = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'order.start' AND input LIKE ?",
    )
      .bind("%1 Shop Street%")
      .all();
    expect(started.results).toEqual([]);
    // A delivery is never changed or removed, by any statement shape.
    for (const sql of [
      "UPDATE core_order_delivery SET line1 = 'x' WHERE order_id = ?",
      "DELETE FROM core_order_delivery WHERE order_id = ?",
    ]) {
      await expect(env.DB.prepare(sql).bind(order.id).run()).rejects.toThrow(
        /core_order_delivery_(fixed|kept)/,
      );
    }
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_order_delivery (order_id, line_id, kind, created_at) SELECT order_id, line_id, 'here', created_at FROM core_order_delivery WHERE order_id = ?",
      )
        .bind(order.id)
        .run(),
    ).rejects.toThrow(/core_order_delivery_fixed/);
  });

  it("erasing the buyer blanks their addresses and keeps the order, detached", async () => {
    const carol = await createBuyer(admin, "carol");
    const order = await start([{ object: VARIANT, id: cap }], post(), outside(carol.principal));
    await run("person.erase", { id: carol.principal.personId }, context(admin));
    const row = await env.DB.prepare("SELECT * FROM core_order_delivery WHERE order_id = ?")
      .bind(order.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      kind: "post",
      name: null,
      line1: null,
      city: null,
      postcode: null,
      country: null,
    });
    expect(row?.erased_at).toEqual(expect.any(String));
    expect(await run("order.delivery.get", { id: order.id }, context(admin))).toMatchObject({
      address: null,
      erased: true,
    });
    const kept = await env.DB.prepare("SELECT person_id FROM core_order WHERE id = ?")
      .bind(order.id)
      .first();
    expect(kept).toEqual({ person_id: null });
  });
});

// --- Postage ----------------------------------------------------------------------------------------

describe("postage, priced by the host", () => {
  it("charges the option's price, nothing once the goods reach its free over, and the quote agrees", async () => {
    const below = [{ object: VARIANT, id: hoodie }]; // 60: under the 100 free over
    const above = [{ object: VARIANT, id: hoodie, quantity: 2 }]; // 120
    const fixed = await start(below, post());
    expect(fixed.total).toBe(7000);
    expect(fixed.lines.at(-1)).toMatchObject({ object: DELIVERY, unitPrice: 1000, total: 1000 });
    const free = await start(above, post());
    expect(free.total).toBe(12000);
    expect(free.lines.at(-1)).toMatchObject({ object: DELIVERY, unitPrice: 0, total: 0 });
    for (const [lines, order] of [
      [below, fixed],
      [above, free],
    ] as const) {
      const quoted = await quote([...lines], post());
      expect(quoted.total).toBe(order.total);
      expect(quoted.delivery).toMatchObject({
        kind: "post",
        price: 1000,
        free: order === free,
        charged: order === free ? 0 : 1000,
      });
      expect(quoted.goodsTotal).toBe(order === free ? 12000 : 6000);
    }
  });

  it("ignores a price, a total or a postage a client sends", async () => {
    const order = await start(
      [{ object: VARIANT, id: hoodie, unitPrice: 1, total: 1 } as Line],
      post(),
      guest(),
      { total: 1, postage: 0, price: 0 },
    );
    expect(order.total).toBe(7000);
    // The delivery takes no price at all: one sent is refused, never used.
    expect(
      await refusal(start([{ object: VARIANT, id: hoodie }], { ...post(), price: 0 })),
    ).toMatchObject({ code: "invalid_input" });
  });
});

// --- order.quote ------------------------------------------------------------------------------------

describe("order.quote", () => {
  it("prices a basket of goods and a pass with the delivery, and says what is available", async () => {
    const shirt = await variant("both", 3, 25);
    const quoted = await quote(
      [
        { object: VARIANT, id: shirt, quantity: 2 },
        { object: VARIANT, id: hoodie },
        { object: PASS, id: pass },
      ],
      post(),
    );
    expect(quoted).toMatchObject({
      currency: CURRENCY,
      channel: "online",
      goodsTotal: 11000,
      // 50 + 60 + 150, posted free (the goods reach 100).
      total: 26000,
      ready: true,
      problems: [],
      delivery: { kind: "post", free: true, charged: 0 },
    });
    expect(quoted.lines.map((l) => [l.unitPrice, l.total, l.goods])).toEqual([
      [2500, 5000, true],
      [6000, 6000, true],
      [15000, 15000, false],
    ]);
    // The public sees what `show` allows (exact here); staff see the numbers.
    expect(quoted.lines[0]?.availability).toEqual({ status: "in_stock", available: 3 });
    expect(quoted.lines[2]?.availability).toBeNull();
    const asStaff = await quote([{ object: VARIANT, id: shirt }], option.here, context(member));
    expect(asStaff.lines[0]?.availability).toMatchObject({ onHand: 3, held: 0, available: 3 });
  });

  it("holds nothing, and reports what the buyer still has to do and what is sold out", async () => {
    const last = await variant("both", 1, 25);
    const gone = await variant("both", 0, 25);
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_order").first();
    const quoted = await quote([
      { object: VARIANT, id: last, quantity: 2 },
      { object: VARIANT, id: gone },
    ]);
    expect(quoted.ready).toBe(false);
    expect(quoted.problems.map((p) => [p.rule, p.line ?? null])).toEqual([
      ["delivery_needed", null],
      ["not_enough", 0],
      ["sold_out", 1],
    ]);
    expect((await quote([{ object: VARIANT, id: last }], { ...option.post })).problems).toEqual([
      expect.objectContaining({ rule: "address_needed" }),
    ]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM core_order").first()).toEqual(before);
    expect(await stockOf(last)).toMatchObject({ onHand: 1, held: 0 });
    // What it refuses, it refuses as order.start does.
    expect(await refusal(quote([{ object: VARIANT, id: drink }], post()))).toMatchObject({
      details: { rule: "not_sold_here" },
    });
    // Sold out: order.start refuses it.
    expect(await refusal(start([{ object: VARIANT, id: gone }], option.here))).toMatchObject({
      details: { rule: "stock" },
    });
  });

  it("runs a bounded number of statements and writes none, whatever the number of lines", async () => {
    let queries = 0;
    let writes = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            // Every statement, a batch's included, is prepared here first. The pipeline's own
            // count of staff and outside reads (core_audit_read_counts) is not the quote's.
            const write = !/^\s*(select|with)\b/i.test(query);
            if (write && !query.includes("core_audit_read_counts")) writes += 1;
            queries += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { invokeByName } = createInvoker(orderRegistry);
    const cost = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(await variant("both", 2, 5));
      queries = 0;
      writes = 0;
      await invokeByName(
        "order.quote",
        { lines: ids.map((id) => ({ object: VARIANT, id })), delivery: post() },
        outside(PUBLIC, { db: createCrmDb(metered) }),
      );
      return { queries, writes };
    };
    const two = await cost(2);
    const fifty = await cost(50);
    expect(two.writes).toBe(0);
    expect(fifty.writes).toBe(0);
    // Each line is read (its record, whether the buyer may read it, where its item is sold);
    // the stock of every line is one read; nothing else grows with the lines.
    expect(fifty.queries - two.queries).toBeLessThanOrEqual(48 * 3);
    expect(fifty.queries).toBeLessThan(250);
  });
});

// --- What a paid delivery grants ---------------------------------------------------------------------

describe("what a paid delivery grants", () => {
  const grantsOf = async (order: string) =>
    (
      await env.DB.prepare("SELECT object_type FROM core_order_grant WHERE order_id = ?")
        .bind(order)
        .all<{ object_type: string }>()
    ).results.map((r) => r.object_type);

  it("a paid post order grants one shipment; take it now grants none and sells the stock", async () => {
    const posted = await start([{ object: VARIANT, id: hoodie, quantity: 2 }], post());
    await pay(posted);
    expect(await grantsOf(posted.id)).toEqual([SHIPMENT]);

    const fridge = await variant("in_person", 5, 4);
    const now = await start(
      [{ object: VARIANT, id: fridge }],
      option.here,
      outside(alice.principal),
    );
    await pay(now);
    expect(await grantsOf(now.id)).toEqual([]);
    expect(await stockOf(fridge)).toMatchObject({ onHand: 4, held: 0 });
    const mine = await env.DB.prepare("SELECT person_id, state FROM core_order WHERE id = ?")
      .bind(now.id)
      .first();
    expect(mine).toEqual({ person_id: alice.principal.personId, state: "paid" });
  });
});

// --- Tax: where posted goods go ----------------------------------------------------------------------

describe("tax at checkout for posted goods", () => {
  type SentLine = { ref: string; taxCode: string; place?: Record<string, string> };
  it("tells the provider the delivery address as the goods' and the postage's place, and keeps no copy of it", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    const order = await start(
      [
        { object: VARIANT, id: cap },
        { object: PASS, id: pass },
      ],
      { ...option.world, address: NZ },
    );
    await run("order.checkout", { id: order.id, token: order.token, returnUrl: RETURN }, guest());
    const sent = gw.checkouts.filter((c) => c.orderId === order.id).at(-1) as {
      tax?: { lines: SentLine[] };
    };
    const where = {
      country: "NZ",
      region: "Otago",
      postcode: "9016",
      city: "Dunedin",
      line1: "1 Shop Street",
    };
    expect(sent.tax?.lines.map((l) => [l.taxCode, l.place ?? null])).toEqual([
      [GOODS_CODE, where],
      [GOODS_CODE, null],
      [POSTAGE_CODE, where],
    ]);
    const stored = await env.DB.prepare(
      "SELECT tax_lines FROM core_order_checkout WHERE order_id = ?",
    )
      .bind(order.id)
      .first<{ tax_lines: string }>();
    expect(stored?.tax_lines).not.toContain("Shop Street");
    expect((JSON.parse(stored?.tax_lines ?? "[]") as SentLine[]).every((l) => !l.place)).toBe(true);
  });
});
