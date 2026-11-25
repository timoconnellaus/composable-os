// Stage 37, build step 5: the Shop pack (packs/shop) in the real host. Its source is installed the
// way a product that lists the pack installs it (a shipped extension, committed to the workspace
// and run in the sandbox), with real D1, the real payments gatekeeper and its fake provider's
// page. Steps 1 and 3's host rules do the work; the pack only declares them.
//
// What is checked: the pack installs with its seeded delivery options and its stockroom role; the
// public reads published items and the active variants of published items only (ADR 0689), so a
// draft's or a retired variant is neither shown nor bought; a visitor buys an online hoodie,
// posted, pays on the provider's page, and the order sells the stock and grants one shipment,
// which a desk account granted `shop:fulfil` packs and sends; a signed-in member buys a fridge
// drink with "take it now", the stock one lower and no shipment; the fridge drink is refused on a
// posted order and the online hoodie on a take-it-now order, by the host, on every path; stock is
// held while the order is unpaid; collect goes ready, then collected; erasing the buyer clears
// the shipment's buyer and keeps the shipment (acceptance criteria 1, 3, 4, 5, 6, 7, 8, 18 and 19
// for the pack).
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  extensionDashboardId,
  getObject,
  getVisible,
  type InvocationContext,
  invokeByName,
  listVisible,
  memoryWidgetCache,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, host, newCustomer, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files = packFiles("shop");

/** The extension host of a deployment whose product lists the Shop. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => s.id !== "shop"),
    { id: "shop", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    id === "shop"
      ? host.commit({
          id,
          files,
          message: "Shipped shop 0.1.0",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/thanks";
const ITEM = "shop.item";
const VARIANT = "shop.variant";
const DELIVERY = "shop.delivery";
const SHIPMENT = "shop.shipment";

let admin: ActingUser;
let desk: ActingUser;
let stockroom: ActingUser;
let member: { principal: CustomerPrincipal; email: string };

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  ...extra,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  integrations,
  extensionHost: shippedHost,
};
/**
 * The public's view of an object, through the visibility seam (what public.list and public.get,
 * tool-only, answer with; the shop's public tools are step 8's).
 */
const publicReader = () => ({ principal: { kind: "public" as const }, db: db.query });
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});

interface Order {
  id: string;
  state: string;
  total: number;
  token: string | null;
}
interface Page {
  items: { id: string; title: string | null; values: Record<string, unknown> }[];
}

const AU = {
  name: "Vic Visitor",
  line1: "1 Shop Street",
  city: "Melbourne",
  region: "VIC",
  postcode: "3000",
  country: "AU",
};

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
}

/** An item sold `whereSold`, published, with one variant of `stock` on hand. */
async function itemWith(
  whereSold: "online" | "in_person" | "both",
  {
    price = 60,
    stock = 5,
    publish = true,
  }: { price?: number; stock?: number; publish?: boolean } = {},
): Promise<{ item: string; variant: string }> {
  const name = unique("Item");
  const item = await create(ITEM, { name, whereSold, category: "Clothing" });
  if (publish) await run("record.publish", { object: ITEM, id: item }, staff(admin));
  const variant = await create(VARIANT, { item, name: `${name}, Large`, price, reorderAt: 1 });
  if (stock > 0) {
    await run("stock.opening", { object: VARIANT, id: variant, quantity: stock }, staff(admin));
  }
  return { item, variant };
}

/** The seeded delivery option of this kind (and name, for the two post options). */
async function seeded(name: string): Promise<string> {
  const page = await run<Page>(
    "record.list",
    { object: DELIVERY, filter: { field: "name", op: "eq", value: name } },
    staff(admin),
  );
  const id = page.items[0]?.id;
  if (!id) throw new Error(`No seeded delivery option ${name}`);
  return id;
}

let post: string;
let collect: string;
let here: string;

const stockOf = (id: string) =>
  run<{ onHand: number; held: number; available: number }>(
    "stock.get",
    { object: VARIANT, id },
    staff(admin),
  );

async function checkoutAndPay(order: Order, ctx: OutsideInvocationContext) {
  const checkout = await run<{ url: string }>(
    "order.checkout",
    { id: order.id, ...(order.token ? { token: order.token } : {}), returnUrl: RETURN },
    ctx,
  );
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(checkout.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
  await vi.waitFor(
    async () =>
      expect(
        (await run<{ state: string }>("order.get", { id: order.id }, staff(admin))).state,
      ).toBe("paid"),
    { timeout: 20_000 },
  );
}

const shipmentsOf = async (orderId: string) =>
  (
    await run<Page>(
      "record.list",
      { object: SHIPMENT, filter: { field: "order", op: "eq", value: orderId } },
      staff(admin),
    )
  ).items;

async function createStaff(name: string): Promise<ActingUser> {
  const id = `usr_${unique("staff")}`;
  const email = `${unique("staff")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, email, now, now)
    .run();
  return { id, email, name, role: "member" };
}

beforeAll(async () => {
  admin = await createAdmin();
  await run("extension.install", { id: "shop", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  expect(getObject(VARIANT)?.sellable?.goods).toEqual({ soldIn: "item.whereSold" });

  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://gym.test"] },
    staff(admin),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );

  // The business sets its own country and a price on the seeded Standard post, and turns it on.
  post = await seeded("Standard post");
  await run(
    "record.update",
    {
      object: DELIVERY,
      id: post,
      values: { countries: "AU", price: 10, freeOver: 100, active: true },
    },
    staff(admin),
  );
  collect = await seeded("Collect at the gym");
  here = await seeded("Take it now");

  member = await newCustomer(staff(admin), "member", { domain: "members.test" });

  // A coach-desk account with the stockroom role, and one granted only handing over.
  stockroom = await createStaff("Sam Stockroom");
  await run("user.setPackRole", { id: stockroom.id, role: "shop.stockroom" }, staff(admin));
  desk = await createStaff("Dee Desk");
  await run("user.setPackRole", { id: desk.id, role: "shop.stockroom" }, staff(admin));
  await run("user.setPermissions", { id: desk.id, permissions: ["shop:fulfil"] }, staff(admin));
}, 120_000);

describe("the pack in a product (criterion 1)", () => {
  it("installs with collect and take it now at no charge, and posting off until priced", async () => {
    const options = await run<Page>("record.list", { object: DELIVERY, limit: 20 }, staff(admin));
    const byName = Object.fromEntries(options.items.map((o) => [o.values.name, o.values]));
    expect(byName["Collect at the gym"]).toMatchObject({ kind: "collect", price: 0, active: true });
    expect(byName["Take it now"]).toMatchObject({ kind: "here", price: 0, active: true });
    expect(byName["International post"]).toMatchObject({
      kind: "post",
      countries: "*",
      active: false,
    });
    expect(byName["International post"]?.price ?? null).toBeNull();
    const roles = await run<{ items: { name: string; permissions: string[] }[] }>(
      "user.packRoles",
      {},
      staff(admin),
    );
    expect(roles.items).toContainEqual(
      expect.objectContaining({ name: "shop.stockroom", permissions: ["shop:stock"] }),
    );
  });

  it("a new post option takes the business's country from the setting", async () => {
    await run(
      "extensionSettings.update",
      { extension: "shop", values: { country: "NZ" } },
      staff(admin),
    );
    const id = await create(DELIVERY, { name: unique("Express"), kind: "post", price: 20 });
    const row = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: DELIVERY, id },
      staff(admin),
    );
    expect(row.values.countries).toBe("NZ");
  });
});

describe("what the public reads (ADR 0689)", () => {
  it("a published item's active variants only: a draft's and a retired one are not found, nor bought", async () => {
    const shown = await itemWith("both");
    const draft = await itemWith("both", { publish: false });
    const retired = await itemWith("both");
    await run(
      "record.update",
      { object: VARIANT, id: retired.variant, values: { state: "retired" } },
      staff(admin),
    );
    const listed = await listVisible(publicReader(), VARIANT, { limit: 100 });
    const ids = listed.items.map((v) => v.id);
    expect(ids).toContain(shown.variant);
    expect(ids).not.toContain(draft.variant);
    expect(ids).not.toContain(retired.variant);
    // Staff-only fields never reach the public.
    const values: Record<string, unknown> =
      listed.items.find((v) => v.id === shown.variant)?.values ?? {};
    for (const hidden of ["costPrice", "supplier", "sku", "barcode", "reorderAt", "reorderQty"]) {
      expect(values, hidden).not.toHaveProperty(hidden);
    }
    expect(await refusal(getVisible(publicReader(), VARIANT, draft.variant))).toMatchObject({
      code: "not_found",
    });
    // What a buyer is told of its stock (stock.get, open to the public) is not found either.
    expect(
      await refusal(run("stock.get", { object: VARIANT, id: draft.variant }, guest)),
    ).toMatchObject({ code: "not_found" });
    for (const { variant } of [draft, retired]) {
      const refused = await refusal(
        run(
          "order.start",
          {
            lines: [{ object: VARIANT, id: variant }],
            email: `${unique("v")}@buyers.test`,
            delivery: { object: DELIVERY, id: collect },
          },
          guest,
        ),
      );
      expect(refused.details).toMatchObject({ rule: "not_for_sale" });
    }
    // Published, the draft's variant is shown and sold.
    await run("record.publish", { object: ITEM, id: draft.item }, staff(admin));
    await getVisible(publicReader(), VARIANT, draft.variant);
  });
});

describe("a visitor's online order, posted (criteria 3, 4, 5, 8)", () => {
  it("holds the stock while unpaid, sells it when paid, and grants one shipment the desk packs and sends", async () => {
    const hoodie = await itemWith("online", { price: 60, stock: 3 });
    const quote = await run<{
      total: number;
      delivery: { charged: number } | null;
      ready: boolean;
    }>(
      "order.quote",
      {
        lines: [{ object: VARIANT, id: hoodie.variant, quantity: 1 }],
        delivery: { object: DELIVERY, id: post, address: AU },
      },
      guest,
    );
    // In the currency's minor unit: 60.00 and 10.00 postage.
    expect(quote).toMatchObject({ total: 7000, ready: true, delivery: { charged: 1000 } });

    // Post needs an address in the option's countries.
    for (const address of [undefined, { ...AU, country: "US" }]) {
      const refused = await refusal(
        run(
          "order.start",
          {
            lines: [{ object: VARIANT, id: hoodie.variant }],
            email: `${unique("v")}@buyers.test`,
            delivery: { object: DELIVERY, id: post, ...(address ? { address } : {}) },
          },
          guest,
        ),
      );
      expect(refused.code).toBe("invalid_input");
    }

    const order = await run<Order>(
      "order.start",
      {
        lines: [{ object: VARIANT, id: hoodie.variant, quantity: 1 }],
        email: `${unique("visitor")}@buyers.test`,
        delivery: { object: DELIVERY, id: post, address: AU },
      },
      guest,
    );
    expect(order.total).toBe(7000);
    expect(await stockOf(hoodie.variant)).toMatchObject({ onHand: 3, held: 1, available: 2 });
    expect(await shipmentsOf(order.id)).toEqual([]);

    await checkoutAndPay(order, guest);
    expect(await stockOf(hoodie.variant)).toMatchObject({ onHand: 2, held: 0, available: 2 });
    const [shipment, ...more] = await shipmentsOf(order.id);
    expect(more).toEqual([]);
    expect(shipment?.values).toMatchObject({ state: "to_pack", kind: "post", option: post });

    // The desk account, granted shop:fulfil beside its stockroom role, packs and sends it.
    const todo = await run<{ shipments: { id: string }[] }>(
      "x.shop.shipmentsToSend",
      {},
      staff(desk),
    );
    expect(todo.shipments.map((s) => s.id)).toContain(shipment?.id);
    await run("x.shop.markPacked", { shipmentId: shipment?.id }, staff(desk));
    const sent = await run<{ moved: boolean; shipment: { state: string; tracking: string } }>(
      "x.shop.markSent",
      { shipmentId: shipment?.id, tracking: "AP123456" },
      staff(desk),
    );
    expect(sent).toMatchObject({ moved: true, shipment: { state: "sent", tracking: "AP123456" } });
    // The stockroom role alone hands nothing over.
    expect(
      await refusal(run("x.shop.markPacked", { shipmentId: shipment?.id }, staff(stockroom))),
    ).toMatchObject({ code: "forbidden" });
  });
});

describe("a member's take-it-now drink at the gym (criteria 6, 7)", () => {
  it("is theirs, one lower in stock, with no shipment", async () => {
    const drink = await itemWith("in_person", { price: 4, stock: 10 });
    const order = await run<Order>(
      "order.start",
      {
        lines: [{ object: VARIANT, id: drink.variant }],
        delivery: { object: DELIVERY, id: here },
      },
      as(member.principal),
    );
    expect(order.total).toBe(400);
    await checkoutAndPay(order, as(member.principal));
    const mine = await run<Page>("my.list", { object: "order", limit: 50 }, as(member.principal));
    expect(mine.items.map((o) => o.id)).toContain(order.id);
    expect(await stockOf(drink.variant)).toMatchObject({ onHand: 9, held: 0 });
    expect(await shipmentsOf(order.id)).toEqual([]);
  });

  it("where an item is sold is the host's: a fridge drink is never posted, an online hoodie never taken now", async () => {
    const drink = await itemWith("in_person", { price: 4 });
    const hoodie = await itemWith("online");
    const paths: [string, InvocationContext | OutsideInvocationContext, boolean][] = [
      ["visitor", guest, true],
      ["member", as(member.principal), false],
      ["staff", staff(admin), true],
      ["assistant", staff(admin, { actor: "assistant", origin: { surface: "assistant" } }), true],
    ];
    for (const [who, ctx, email] of paths) {
      const start = (variant: string, delivery: Record<string, unknown>) =>
        run(
          "order.start",
          {
            lines: [{ object: VARIANT, id: variant }],
            ...(email ? { email: `${unique("b")}@buyers.test` } : {}),
            delivery,
          },
          ctx,
        );
      for (const delivery of [
        { object: DELIVERY, id: post, address: AU },
        { object: DELIVERY, id: collect },
      ]) {
        expect((await refusal(start(drink.variant, delivery))).details, who).toMatchObject({
          rule: "not_sold_here",
          channel: "online",
        });
      }
      expect(
        (await refusal(start(hoodie.variant, { object: DELIVERY, id: here }))).details,
        who,
      ).toMatchObject({ rule: "not_sold_here", channel: "in_person" });
    }
  });
});

describe("collect, and erasing the buyer (criteria 8, 18)", () => {
  it("goes ready, then collected; erasing the buyer clears the shipment's buyer and keeps it", async () => {
    const buyer = await newCustomer(staff(admin), "collector", { domain: "buyers.test" });
    const cap = await itemWith("both", { price: 30 });
    const order = await run<Order>(
      "order.start",
      {
        lines: [{ object: VARIANT, id: cap.variant }],
        delivery: { object: DELIVERY, id: collect },
      },
      as(buyer.principal),
    );
    await checkoutAndPay(order, as(buyer.principal));
    const [shipment] = await shipmentsOf(order.id);
    expect(shipment?.values).toMatchObject({
      kind: "collect",
      collectAt: "The front desk",
      buyer: buyer.principal.personId,
    });
    // The buyer reads their own shipment.
    const theirs = await run<Page>("my.list", { object: SHIPMENT }, as(buyer.principal));
    expect(theirs.items.map((s) => s.id)).toEqual([shipment?.id]);

    await run("x.shop.markReady", { shipmentId: shipment?.id }, staff(admin));
    const done = await run<{ shipment: { state: string } }>(
      "x.shop.markCollected",
      { shipmentId: shipment?.id },
      staff(admin),
    );
    expect(done.shipment.state).toBe("collected");

    await run("person.erase", { id: buyer.principal.personId }, staff(admin));
    const after = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: SHIPMENT, id: shipment?.id },
      staff(admin),
    );
    expect(after.values.buyer ?? null).toBeNull();
    expect(after.values.state).toBe("collected");
  });
});

describe("the stockroom role", () => {
  it("reads the stock levels and the catalogue, and nothing else", async () => {
    const low = await itemWith("both", { stock: 1 });
    const levels = await run<{ variants: { variantId: string; low: boolean }[] }>(
      "x.shop.stockLevels",
      { lowOnly: true },
      staff(stockroom),
    );
    expect(levels.variants.find((v) => v.variantId === low.variant)).toMatchObject({ low: true });
    await run("record.get", { object: VARIANT, id: low.variant }, staff(stockroom));
    expect(await refusal(run("record.list", { object: SHIPMENT }, staff(stockroom)))).toMatchObject(
      { code: "forbidden" },
    );
    expect(await refusal(run("order.list", {}, staff(stockroom)))).toMatchObject({
      code: "forbidden",
    });
  });
});

describe("the Shop dashboard", () => {
  it("runs every widget over the rec_* views, counting what is low and what sold", async () => {
    const dashboardId = extensionDashboardId("shop", "shopOverview");
    const dashboard = await run<{ widgets: { id: string }[] }>(
      "dashboard.get",
      { id: dashboardId },
      staff(admin),
    );
    expect(dashboard.widgets.map((w) => w.id)).toEqual([
      "low",
      "to-pack",
      "ready",
      "sales",
      "low-by-supplier",
      "best-sellers",
    ]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const results: Record<string, Record<string, unknown>[]> = {};
    for (const { id } of dashboard.widgets) {
      const out = await invokeByName(
        "widget.run",
        {
          dashboardId,
          widgetId: id,
          filters: { paid: { from: "2000-01-01", to: tomorrow } },
          refresh: true,
        },
        { ...staff(admin), widgetCache: memoryWidgetCache() },
      );
      results[id] = (out as { rows: Record<string, unknown>[] }).rows;
    }
    expect(Number(results.low?.[0]?.value)).toBeGreaterThan(0);
    expect(results["low-by-supplier"]?.length).toBeGreaterThan(0);
    // The hoodie, the drink and the cap paid for earlier in this file.
    expect(Number(results.sales?.[0]?.value)).toBeGreaterThan(0);
    expect(results["best-sellers"]?.length).toBeGreaterThan(0);
  });
});
