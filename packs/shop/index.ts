// Shop (stage 37, step 5): one list of the things a business sells (drinks, clothing,
// supplements, spare parts), each with its versions, prices and pictures, marked for where it is
// sold; how many of each there are; the ways an online order reaches its buyer; and the shipments
// staff pack and send or hand over. The till (drafted separately) and, later, Jobs sell and use
// the same variants: one catalogue and one count.
//
// Vocabulary (the spec): an **item** is a thing in the shop ("Club hoodie"); a **variant** is one
// version of it that is bought and counted ("Club hoodie, large, black"). An item with one
// version still has one variant.
//
// Everything that is a rule is the host's, declared here as behaviours (ADR 0404):
//   - a variant is `sellable` goods (ADRs 0435, 0682): its price is read by the host, it is sold
//     where its item says (`goods.soldIn: "item.whereSold"`), and a line not sold in the order's
//     channel (online for post and collect, in person for "take it now") is refused on every path;
//   - a variant has `stock` (ADR 0680): on hand is kept by the host from a ledger nobody edits,
//     held while an order is paid for, sold in the paid batch, never sold past what is there; a
//     refund does not restock. Staff record opening stock and corrections with the host's
//     `stock.opening` and `stock.adjust`; receipts, counts and write-offs (step 6) move it through
//     `stockMoves`. Falling to the reorder level tells the holders of `shop:stock` once (ADR 0681);
//   - a delivery option is `sellable.delivery` (ADRs 0682, 0685): post (an address in its
//     countries), collect, or take it now; the host prices it, free over an amount, and a paid post
//     or collect line grants a shipment; take it now grants nothing;
//   - the public reads published items, and the active variants of published items, and the
//     delivery options (`public`, ADRs 0438, 0442, 0689); a buyer reads their own shipments
//     (`customer`, ADR 0402). Cost price, supplier, SKU, barcode, reorder levels and the counts
//     stay staff-only: outsiders are told stock only as `stock.get` and `order.quote` allow;
//   - prices, postage, the countries an option posts to and whether it is on are a person's to
//     change: an AI's or an automation's write of them waits for a person (`personApproves`).
// The tools in tools.ts compose the host's operations and hold no rule of their own.
import { defineExtension } from "@composable-os/sdk";
import { shopDashboards } from "./dashboards.ts";
import {
  markCollected,
  markPacked,
  markReady,
  markSent,
  shipmentsToSend,
  stockLevels,
} from "./tools.ts";

const WHERE_SOLD = [
  { value: "both", label: "Online and in person" },
  { value: "online", label: "Online only" },
  { value: "in_person", label: "In person only" },
];

const DELIVERY_KINDS = [
  { value: "post", label: "Post" },
  { value: "collect", label: "Collect" },
  { value: "here", label: "Take it now" },
];

/**
 * Tax at checkout (ADR 0479), only once a human admin turns it on: the provider's general code
 * for physical goods, and its code for shipping. Whether goods and postage are taxed alike is
 * the business's accountant's call (decision 8); an admin may change either in Settings → Orders.
 */
const GOODS_TAX = { code: "txcd_99999999" };
const POSTAGE_TAX = { code: "txcd_92010001" };

export default defineExtension({
  id: "shop",
  version: "0.1.0",
  contractVersion: 1,
  label: "Shop",
  description:
    "One list of the things the business sells, in their versions, sold online, in person or " +
    "both, with stock the host keeps, ways to get an order to its buyer, and the shipments staff " +
    "pack and send or hand over.",
  permissions: {
    // person.get (read person): the buyer's name on a shipment, for the staff list of what to
    // send. query.sql: the stock levels and the dashboard's lists over the rec_* views.
    read: ["person"],
    operations: ["query.sql"],
    modules: ["ops"],
  },
  // A supplier is an Organisation with the Shop's fields (no second address book). Purchase
  // orders to them are step 6's.
  fields: {
    organisation: {
      supplier: {
        type: "boolean",
        label: "Supplier",
        description: "We buy stock from this organisation.",
      },
      supplierAccount: { type: "text", label: "Our account number with them" },
      supplierEmail: {
        type: "email",
        label: "Email for orders",
        description: "Where purchase orders to this supplier are sent.",
      },
      supplierLeadDays: {
        type: "number",
        label: "Lead time (days)",
        description: "How many days an order from this supplier usually takes to arrive.",
        min: 0,
        step: 1,
      },
      supplierNotes: { type: "longText", label: "Supplier notes" },
    },
  },
  objects: {
    item: {
      label: "Item",
      plural: "Items",
      icon: "shopping-bag",
      titleField: "name",
      description:
        "A thing in the shop (a club hoodie, a protein bar), with its pictures and where it is " +
        "sold. What is bought and counted is its variants: an item with one version has one.",
      navigation: "main",
      navigationOrder: 10,
      fields: {
        name: { type: "text", label: "Name", required: true },
        slug: { type: "slug", label: "Address" },
        description: { type: "richText", label: "Description" },
        image: { type: "image", label: "Picture" },
        image2: { type: "image", label: "Second picture" },
        image3: { type: "image", label: "Third picture" },
        category: {
          type: "text",
          label: "Category",
          description: "Drinks, clothing, supplements: how the shop and the stock list group it.",
        },
        // Where it is sold (decision 3): the host refuses a line not sold in the order's channel.
        // Not content: a change takes effect at once, published or not.
        whereSold: {
          type: "select",
          label: "Where sold",
          required: true,
          default: "both",
          options: WHERE_SOLD,
          track: "timeline",
          description:
            "Online (posted or collected), in person (bought at the gym with Take it now), or " +
            "both. A fridge drink is in person only.",
        },
        option1Name: {
          type: "text",
          label: "First option",
          description: "What the variants' first option is called, e.g. Size.",
        },
        option2Name: { type: "text", label: "Second option", description: "e.g. Colour." },
        option3Name: { type: "text", label: "Third option", description: "e.g. Flavour." },
        weight: {
          type: "number",
          label: "Weight (grams)",
          description: "Each variant's weight unless it has its own. Not used for postage yet.",
          min: 0,
          step: 1,
        },
      },
      // Drafts and published versions (ADRs 0442, 0446): only a published item is public, and
      // publishing is a person's (an AI's request waits for one, ADR 0480).
      publishable: {
        content: [
          "name",
          "description",
          "image",
          "image2",
          "image3",
          "category",
          "option1Name",
          "option2Name",
          "option3Name",
        ],
        slug: "slug",
      },
      public: {
        read: [
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
        ],
      },
      indexes: [["category"], ["whereSold"]],
    },
    variant: {
      label: "Variant",
      plural: "Variants",
      icon: "tag",
      titleField: "name",
      description:
        "One version of an item that is bought and counted (large, black), with its price, " +
        "stock, reorder level and usual supplier.",
      navigation: "main",
      navigationOrder: 11,
      fields: {
        item: { type: "relation", label: "Item", to: "shop.item", required: true },
        // The order line's title is the record's: the whole name, so a receipt reads well.
        name: {
          type: "text",
          label: "Name",
          required: true,
          description: "As the buyer's order shows it, e.g. Club hoodie, Large / Black.",
        },
        option1: { type: "text", label: "First option value", description: "e.g. Large." },
        option2: { type: "text", label: "Second option value", description: "e.g. Black." },
        option3: { type: "text", label: "Third option value" },
        sku: { type: "text", label: "SKU" },
        barcode: { type: "text", label: "Barcode" },
        price: {
          type: "currency",
          label: "Price",
          required: true,
          personApproves: true,
          description: "Including tax. An AI's change of it waits for a person.",
        },
        costPrice: {
          type: "currency",
          label: "Cost price",
          readOnly: true,
          description: "What one cost when it was last received from a supplier.",
        },
        maxPerOrder: {
          type: "number",
          label: "Most per order",
          description: "The most one order may hold. Empty: 10.",
          min: 1,
          step: 1,
        },
        weight: {
          type: "number",
          label: "Weight (grams)",
          description: "Overrides the item's weight.",
          min: 0,
          step: 1,
        },
        reorderAt: {
          type: "number",
          label: "Reorder level",
          description: "At or below this many on hand, the stock is low and staff are told once.",
          min: 0,
          step: 1,
        },
        reorderQty: {
          type: "number",
          label: "Reorder quantity",
          description: "How many to order when it is low.",
          min: 1,
          step: 1,
        },
        supplier: {
          type: "relation",
          label: "Usual supplier",
          to: "organisation",
        },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "active", label: "Active" },
            { value: "retired", label: "Retired" },
          ],
        },
      },
      states: {
        field: "state",
        initial: "active",
        moves: [
          { from: "active", to: "retired", by: ["staff"] },
          { from: "retired", to: "active", by: ["staff"] },
        ],
      },
      sellable: {
        price: "price",
        maxPerOrder: "maxPerOrder",
        // Sold where its item is (decision 3): the host reads the item's mark on every order.
        goods: { soldIn: "item.whereSold" },
        tax: GOODS_TAX,
        finance: { category: { key: "shop", label: "Shop" }, earned: "at_sale" },
      },
      // Outsiders are told "In stock" or "Sold out" (the default, `availability`), never a count.
      stock: { reorderAt: "reorderAt", reorderQty: "reorderQty", notify: "shop:stock" },
      // Where agreement may be needed (stage 44, ADR 0641): nothing is attached by default.
      agreements: { point: "buy", label: "Buying from the shop", inlineStep: true },
      // An active variant of a published item (ADR 0689): what a shop page shows and a buyer may
      // put on an order. A retired one, or one of a draft item, is not found.
      public: {
        read: ["item", "name", "option1", "option2", "option3", "price", "maxPerOrder"],
        when: [{ field: "state", in: ["active"] }, { via: "item" }],
      },
      indexes: [["item"], ["sku"], ["barcode"], ["supplier"], ["state"]],
    },
    delivery: {
      label: "Delivery option",
      plural: "Delivery options",
      icon: "truck",
      titleField: "name",
      description:
        "A way an order's goods reach the buyer: posted, collected, or taken now at the gym. Its " +
        "price is the host's postage; a paid post or collect order gets a shipment to pack.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        kind: {
          type: "select",
          label: "Kind",
          required: true,
          options: DELIVERY_KINDS,
          description:
            "Post (an address in its countries), collect (no address), or take it now (bought " +
            "in person: nothing to pack).",
        },
        price: {
          type: "currency",
          label: "Price",
          personApproves: true,
          description:
            "Postage, including tax. 0 is free. A post option without one cannot be chosen.",
        },
        freeOver: {
          type: "currency",
          label: "Free over",
          personApproves: true,
          description:
            "No postage when the order's goods come to at least this. Empty: never free.",
        },
        countries: {
          type: "text",
          label: "Countries",
          personApproves: true,
          defaultSetting: "country",
          description:
            "Post only: two-letter codes separated by spaces (AU NZ), or * for everywhere no " +
            "other post option names. Empty: it posts nowhere.",
        },
        collectAt: {
          type: "text",
          label: "Where to collect",
          description: "Collect only: where the buyer picks it up, e.g. the front desk.",
        },
        active: {
          type: "boolean",
          label: "Active",
          default: true,
          personApproves: true,
          description: "Off: buyers cannot choose it.",
        },
      },
      sellable: {
        price: "price",
        delivery: { kind: "kind", freeOver: "freeOver", countries: "countries", active: "active" },
        tax: POSTAGE_TAX,
        // A paid post or collect line gives staff a shipment to pack; take it now gives nothing.
        grants: {
          object: "shipment",
          set: {
            name: "line.title",
            order: "order",
            buyer: "order.person",
            option: "item",
            kind: "item.kind",
            collectAt: "item.collectAt",
          },
          void: "void",
        },
        finance: { category: { key: "postage", label: "Postage" }, earned: "at_sale" },
      },
      // The checkout's choice (ADR 0682): every option, take it now included, since a member buys
      // at the gym on their own phone through the website, signed in or as a guest (decision 13,
      // follow-up 2). An option that is off is refused by the host.
      public: {
        read: ["name", "kind", "price", "freeOver", "countries", "collectAt", "active"],
      },
      // A new shop (follow-up 1): collect and take it now at no charge; posting at home and to
      // everywhere else, each off until the business sets its price (and the home option its
      // country, which no seed can know: new options take it from the `country` setting).
      seed: {
        collect: {
          name: "Collect at the gym",
          kind: "collect",
          price: 0,
          collectAt: "The front desk",
          active: true,
        },
        here: { name: "Take it now", kind: "here", price: 0, active: true },
        post: { name: "Standard post", kind: "post", active: false },
        international: { name: "International post", kind: "post", countries: "*", active: false },
      },
    },
    shipment: {
      label: "Shipment",
      plural: "Shipments",
      icon: "package",
      titleField: "name",
      description:
        "What a paid order to post or collect gives staff to do: pack it, then send it or have it " +
        "ready to collect. Made by the host when the order is paid; the buyer sees their own.",
      navigation: "main",
      navigationOrder: 12,
      fields: {
        name: { type: "text", label: "Name", required: true },
        order: {
          type: "text",
          label: "Order",
          readOnly: true,
          description: "The order that granted it, set by the host.",
        },
        // Not required: erasing the buyer clears it, and the shipment stays (spec, Privacy).
        buyer: { type: "relation", label: "Buyer", to: "person", readOnly: true },
        option: {
          type: "relation",
          label: "Delivery option",
          to: "shop.delivery",
          readOnly: true,
        },
        kind: {
          type: "select",
          label: "Kind",
          readOnly: true,
          options: [
            { value: "post", label: "Post" },
            { value: "collect", label: "Collect" },
          ],
        },
        collectAt: { type: "text", label: "Where to collect", readOnly: true },
        tracking: { type: "text", label: "Tracking reference" },
        state: {
          type: "select",
          label: "State",
          track: "timeline",
          options: [
            { value: "to_pack", label: "To pack" },
            { value: "packed", label: "Packed" },
            { value: "sent", label: "Sent" },
            { value: "ready", label: "Ready to collect" },
            { value: "collected", label: "Collected" },
            { value: "void", label: "Void" },
          ],
        },
        packedAt: { type: "datetime", label: "Packed at", readOnly: true },
        sentAt: { type: "datetime", label: "Sent at", readOnly: true },
        readyAt: { type: "datetime", label: "Ready at", readOnly: true },
        collectedAt: { type: "datetime", label: "Collected at", readOnly: true },
      },
      states: {
        field: "state",
        initial: "to_pack",
        moves: [
          { from: "to_pack", to: "packed", by: ["staff"] },
          { from: "packed", to: "to_pack", by: ["staff"] },
          { from: ["to_pack", "packed"], to: "sent", by: ["staff"], final: true },
          { from: ["to_pack", "packed"], to: "ready", by: ["staff"] },
          { from: "ready", to: "collected", by: ["staff"], final: true },
          // The order refunded in full (ADR 0435): the host's, before it went.
          { from: ["to_pack", "packed", "ready"], to: "void", by: ["host"], final: true },
        ],
      },
      // The buyer reads their own (My account's Deliveries, step 8) and changes nothing.
      customer: {
        field: "buyer",
        read: [
          "name",
          "order",
          "option",
          "kind",
          "collectAt",
          "tracking",
          "state",
          "sentAt",
          "readyAt",
          "collectedAt",
        ],
        write: [],
      },
      timelineLinks: ["buyer"],
      indexes: [["state"], ["order"], ["buyer"]],
    },
  },
  views: {
    onlineShop: {
      label: "Sold online",
      object: "shop.item",
      filter: { field: "whereSold", op: "in", value: ["online", "both"] },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "category", "whereSold", "publishState"],
    },
    atTheGym: {
      label: "Sold in person",
      object: "shop.item",
      filter: { field: "whereSold", op: "in", value: ["in_person", "both"] },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "category", "whereSold", "publishState"],
    },
    stock: {
      label: "Stock",
      object: "shop.variant",
      filter: { field: "state", op: "eq", value: "active" },
      sort: { field: "available", direction: "asc" },
      columns: ["name", "item", "onHand", "held", "available", "reorderAt", "supplier"],
    },
    toPack: {
      label: "To pack and send",
      object: "shop.shipment",
      filter: { field: "state", op: "in", value: ["to_pack", "packed"] },
      sort: { field: "createdAt", direction: "asc" },
      columns: ["name", "kind", "buyer", "state", "createdAt"],
    },
    readyToCollect: {
      label: "Ready to collect",
      object: "shop.shipment",
      filter: { field: "state", op: "eq", value: "ready" },
      sort: { field: "readyAt", direction: "asc" },
      columns: ["name", "buyer", "collectAt", "readyAt"],
    },
  },
  dashboards: shopDashboards,
  recordTabs: {
    itemVariants: {
      label: "Variants",
      on: "shop.item",
      view: {
        type: "table",
        object: "shop.variant",
        relation: "item",
        columns: ["name", "price", "onHand", "available", "reorderAt", "state"],
        sort: { field: "name", direction: "asc" },
      },
      order: 10,
    },
    personShipments: {
      label: "Shipments",
      on: "person",
      view: {
        type: "table",
        object: "shop.shipment",
        relation: "buyer",
        columns: ["name", "kind", "state", "tracking", "createdAt"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 40,
    },
    supplierVariants: {
      label: "Supplies",
      on: "organisation",
      view: {
        type: "table",
        object: "shop.variant",
        relation: "supplier",
        columns: ["name", "item", "onHand", "reorderAt", "reorderQty"],
        sort: { field: "name", direction: "asc" },
      },
      order: 40,
    },
  },
  settings: {
    // The host keeps no home country (ADR 0682): a new post option posts to this one.
    country: {
      type: "text",
      label: "Your country",
      description:
        "Two letters, e.g. AU. New post options post here unless you list other countries. Set " +
        "it, then give the seeded Standard post option this country and a price, and turn it on.",
    },
  },
  roles: {
    stockroom: {
      label: "Stockroom",
      description:
        "Sees the items, the variants and their stock levels, for someone who only receives " +
        "and counts stock. Nothing else: no people, orders, prices to change or settings.",
      permissions: ["shop:stock"],
      read: ["shop.item", "shop.variant"],
    },
  },
  // For a coach or desk account (ADR 0600): reading the stock levels, and handing over or
  // sending what was bought. The stockroom role's permission is its own and not granted one by one.
  grantable: ["shop:read", "shop:fulfil"],
  grantableLabels: {
    "shop:read":
      "Shop stock: see every variant's stock, what is held by orders being paid and what is low.",
    "shop:fulfil":
      "Shop orders: see what is to pack, send or hand over, and mark it packed, sent, ready or " +
      "collected.",
  },
  tools: { stockLevels, shipmentsToSend, markPacked, markSent, markReady, markCollected },
});
