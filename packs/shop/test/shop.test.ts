// Stage 37 step 5: the Shop pack against @composable-os/sdk/testing's in-memory host. Its
// manifest passes the contract checks with the goods, stock and delivery declarations the host
// enforces; what is opened to the public and to buyers is exactly the spec's; the tools only read
// and move shipments from a current read. apps/runner/test/shop.test.ts runs the same pack in the
// real host, with orders paid through the fake provider.
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import { shopDashboards } from "../dashboards.ts";
import extension from "../index.ts";

const SHIPMENT = "shop.shipment";

type Rows = Record<string, ({ id: string } & Record<string, unknown>)[]>;

function hostWith(
  records: Rows = {},
  sql: (input: Record<string, unknown>) => unknown = () => ({ rows: [] }),
) {
  const calls: Record<string, unknown>[] = [];
  const host = createTestHost(extension, {
    records,
    operations: {
      "query.sql": (input) => {
        calls.push(input);
        return sql(input);
      },
      "person.get": (input) => ({ id: input.id, displayName: "Alice Buyer" }),
    },
  });
  return { host, calls };
}

describe("the Shop pack (test host)", () => {
  it("passes the contract checks, with goods, stock and delivery declared for the host", () => {
    const { host } = hostWith();
    expect(host.issues).toEqual([]);
    const { item, variant, delivery, shipment } = host.manifest.objects;
    // Sold where its item says, counted on a shelf, low stock told to shop:stock's holders.
    expect(variant?.sellable).toMatchObject({
      price: "price",
      goods: { soldIn: "item.whereSold" },
    });
    expect(variant?.stock).toEqual({
      reorderAt: "reorderAt",
      reorderQty: "reorderQty",
      notify: "shop:stock",
    });
    expect(item?.fields.whereSold).toMatchObject({ required: true, default: "both" });
    expect(delivery?.sellable?.delivery).toEqual({
      kind: "kind",
      freeOver: "freeOver",
      countries: "countries",
      active: "active",
    });
    expect(delivery?.sellable?.grants?.object).toBe("shipment");
    // Prices, postage and where an option posts are a person's to change.
    for (const [object, field] of [
      [variant, "price"],
      [delivery, "price"],
      [delivery, "freeOver"],
      [delivery, "countries"],
      [delivery, "active"],
    ] as const) {
      expect(object?.fields[field]?.personApproves, field).toBe(true);
    }
    // The buyer's field is not required: erasing them clears it and the shipment stays.
    expect(shipment?.fields.buyer?.required).toBeFalsy();
    expect(shipment?.states?.moves.filter((m) => m.to === "void")).toEqual([
      { from: ["to_pack", "packed", "ready"], to: "void", by: ["host"], final: true },
    ]);
  });

  it("opens to outsiders only what a shop page shows, and a buyer's own shipments", () => {
    const { host } = hostWith();
    const { item, variant, delivery, shipment } = host.manifest.objects;
    expect(item?.public?.read).toEqual([
      "name",
      "slug",
      "description",
      "image",
      "image2",
      "image3",
      "category",
      "whereSold",
      "option1Name",
      "option2Name",
      "option3Name",
      "publishedAt",
    ]);
    // An active variant of a published item; never its cost, supplier, codes or reorder level.
    expect(variant?.public).toEqual({
      read: ["item", "name", "option1", "option2", "option3", "price", "maxPerOrder"],
      when: [{ field: "state", in: ["active"] }, { via: "item" }],
    });
    for (const hidden of ["costPrice", "supplier", "sku", "barcode", "reorderAt", "reorderQty"]) {
      expect(variant?.public?.read).not.toContain(hidden);
    }
    expect(delivery?.public?.read).toEqual([
      "name",
      "kind",
      "price",
      "freeOver",
      "countries",
      "collectAt",
      "active",
    ]);
    expect(shipment?.customer).toMatchObject({ field: "buyer", write: [] });
    // Every tool is the staff's in this step.
    for (const [name, tool] of Object.entries(host.manifest.tools)) {
      expect(tool.audiences ?? ["staff"], name).toEqual(["staff"]);
    }
  });

  it("seeds collect and take it now at no charge, and two post options off until priced", () => {
    const { host } = hostWith();
    const seed = host.manifest.objects.delivery?.seed ?? {};
    expect(seed.collect).toMatchObject({ kind: "collect", price: 0, active: true });
    expect(seed.here).toMatchObject({ kind: "here", price: 0, active: true });
    expect(seed.post).toMatchObject({ kind: "post", active: false });
    expect(seed.post?.price).toBeUndefined();
    expect(seed.international).toMatchObject({ kind: "post", countries: "*", active: false });
    // New post options take the business's country from the setting.
    expect(host.manifest.objects.delivery?.fields.countries?.defaultSetting).toBe("country");
    expect(host.manifest.settings.country?.type).toBe("text");
  });

  it("gives the stockroom role stock and the catalogue, and lets a desk be granted the rest", () => {
    const { host } = hostWith();
    expect(host.manifest.roles).toEqual({
      stockroom: {
        label: "Stockroom",
        description: expect.any(String),
        permissions: ["shop:stock"],
        read: ["shop.item", "shop.variant"],
      },
    });
    expect(host.manifest.grantable).toEqual(["shop:read", "shop:fulfil"]);
  });

  it("stockLevels reads the host's numbers, lowest first, and narrows by low, category and supplier", async () => {
    const { host, calls } = hostWith({}, () => ({
      rows: [
        {
          variant_id: "v1",
          variant: "Club hoodie, L",
          item_id: "i1",
          item: "Club hoodie",
          category: "Clothing",
          on_hand: 2,
          held: 1,
          available: 1,
          reorder_at: 3,
          reorder_qty: 12,
          supplier_id: "org_1",
          supplier: "Hoodies Co",
        },
        {
          variant_id: "v2",
          variant: "Water",
          item_id: "i2",
          item: "Water",
          category: "Drinks",
          on_hand: 30,
          held: 0,
          available: 30,
          reorder_at: null,
          reorder_qty: null,
          supplier_id: null,
          supplier: null,
        },
      ],
    }));
    const out = await host.runTool("stockLevels", {});
    expect(out.truncated).toBe(false);
    expect(
      out.variants.map((v: { variantId: string; low: boolean }) => [v.variantId, v.low]),
    ).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    await host.runTool("stockLevels", { lowOnly: true, category: "Clothing", supplierId: "org_1" });
    const last = calls.at(-1) as { sql: string; params: unknown[] };
    expect(last.sql).toContain("v._stk_on_hand <= v.reorder_at");
    expect(last.params).toEqual(["Clothing", "org_1"]);
    // Only the rec_* views: no table, no write.
    expect(last.sql).not.toMatch(/\bcore_/);
  });

  it("shipmentsToSend lists what is left to do, with the buyer's name", async () => {
    const { host } = hostWith({
      [SHIPMENT]: [
        { id: "s1", name: "Standard post", state: "to_pack", kind: "post", buyer: "p1" },
        { id: "s2", name: "Collect", state: "ready", kind: "collect", collectAt: "Desk" },
        { id: "s3", name: "Gone", state: "sent", kind: "post" },
      ],
    });
    const out = await host.runTool("shipmentsToSend", {});
    expect(out.shipments.map((s: { id: string }) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(out.shipments.find((s: { id: string }) => s.id === "s1")?.buyer).toBe("Alice Buyer");
    const ready = await host.runTool("shipmentsToSend", { state: "ready" });
    expect(ready.shipments.map((s: { id: string }) => s.id)).toEqual(["s2"]);
  });

  it("markPacked and markSent move a shipment from where it is, with the tracking reference", async () => {
    const { host } = hostWith({
      [SHIPMENT]: [{ id: "s1", name: "Standard post", state: "to_pack", kind: "post" }],
    });
    const packed = await host.runTool("markPacked", { shipmentId: "s1" });
    expect(packed).toMatchObject({ moved: true, shipment: { state: "packed" } });
    const again = await host.runTool("markPacked", { shipmentId: "s1" });
    expect(again).toMatchObject({ moved: false, message: "Already packed." });
    const sent = await host.runTool("markSent", { shipmentId: "s1", tracking: "AB123" });
    expect(sent).toMatchObject({ moved: true, shipment: { state: "sent", tracking: "AB123" } });
    const update = host.calls.filter((c) => c.operation === "record.update").at(-1);
    expect(update?.input).toMatchObject({ object: SHIPMENT, id: "s1", from: "packed" });
  });

  it("markReady and markCollected hand a collect order over", async () => {
    const { host } = hostWith({
      [SHIPMENT]: [{ id: "s2", name: "Collect", state: "to_pack", kind: "collect" }],
    });
    expect(await host.runTool("markReady", { shipmentId: "s2" })).toMatchObject({
      moved: true,
      shipment: { state: "ready" },
    });
    expect(await host.runTool("markCollected", { shipmentId: "s2" })).toMatchObject({
      moved: true,
      shipment: { state: "collected" },
    });
  });

  it("declares a dashboard over the rec_* views only", () => {
    for (const widget of shopDashboards.shopOverview.widgets) {
      const sql = (widget as { sql?: string }).sql ?? "";
      expect(sql, widget.id).not.toMatch(/\bcore_\w+/);
    }
  });
});
