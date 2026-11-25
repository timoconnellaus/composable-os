// The Shop dashboard (stage 37, step 5): what is low, what is waiting to be packed or collected,
// and what sold. Read-only SQL over the rec_* views: stock is the host's counter on each
// variant's view (on hand, held, available), sales are the order lines the host priced, of paid
// orders. Each widget opens the records it counted.
import type { DashboardDeclaration } from "@composable-os/sdk";

const LOW = "v.state = 'active' AND v.reorder_at IS NOT NULL AND v._stk_on_hand <= v.reorder_at";
const SOLD = `FROM rec_order_line l JOIN rec_order o ON o.id = l.order_id
  JOIN rec_x_shop_variant v ON v.id = l.record_id
  LEFT JOIN rec_x_shop_item i ON i.id = v.item
  WHERE l.object_type = 'shop.variant' AND o.state = 'paid'
    AND o.paid_at >= :paid_from AND o.paid_at < :paid_to`;

export const shopOverview: DashboardDeclaration = {
  title: "Shop",
  description:
    "What is low and who supplies it, what is waiting to be packed or collected, and what sold.",
  filters: [{ type: "dateRange", id: "paid", label: "Paid", default: "this_month" }],
  widgets: [
    {
      id: "low",
      type: "kpi",
      title: "Low on stock",
      description: "Active variants with on hand at or below their reorder level.",
      sql: `SELECT count(*) AS value FROM rec_x_shop_variant v WHERE ${LOW}`,
      mapping: { value: "value" },
      options: { compare: false },
      layout: { w: 3, h: 1 },
    },
    {
      id: "to-pack",
      type: "kpi",
      title: "To pack",
      description: "Shipments of paid orders not yet packed.",
      sql: "SELECT count(*) AS value FROM rec_x_shop_shipment s WHERE s.state = 'to_pack'",
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "shop.shipment",
        filter: { field: "state", op: "eq", value: "to_pack" },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "ready",
      type: "kpi",
      title: "Ready to collect",
      description: "Shipments waiting for their buyer to collect them.",
      sql: "SELECT count(*) AS value FROM rec_x_shop_shipment s WHERE s.state = 'ready'",
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "shop.shipment",
        filter: { field: "state", op: "eq", value: "ready" },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "sales",
      type: "kpi",
      title: "Shop sales",
      description: "Line totals of shop goods on orders paid in the period (postage left out).",
      sql: `SELECT coalesce(sum(l.line_total), 0) / 100.0 AS value ${SOLD}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "low-by-supplier",
      type: "table",
      title: "Low stock by supplier",
      description:
        "Each active variant at or below its reorder level, its usual supplier and how many to " +
        "order: ready to become a purchase order.",
      sql: `SELECT v.id AS id, coalesce(o.name, 'No supplier') AS supplier, v.name AS variant,
  v._stk_on_hand AS on_hand, v._stk_held AS held, v.reorder_at AS reorder_at,
  v.reorder_qty AS reorder_qty
FROM rec_x_shop_variant v LEFT JOIN rec_organisation o ON o.id = v.supplier
WHERE ${LOW}
ORDER BY supplier, v._stk_on_hand LIMIT 100`,
      mapping: {
        columns: ["supplier", "variant", "on_hand", "held", "reorder_at", "reorder_qty"],
      },
      clickThrough: {
        object: "shop.variant",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 12, h: 2 },
    },
    {
      id: "best-sellers",
      type: "bar",
      title: "Sold by item",
      description: "Units of each item sold on orders paid in the period.",
      sql: `SELECT i.id AS item_id, coalesce(i.name, v.name) AS item, sum(l.quantity) AS units ${SOLD}
GROUP BY i.id, item ORDER BY units DESC LIMIT 20`,
      mapping: { x: "item", y: ["units"] },
      clickThrough: {
        object: "shop.variant",
        filter: { field: "item", op: "eq", value: { $row: "item_id" } },
      },
      layout: { w: 12, h: 2 },
    },
  ],
};

export const shopDashboards = { shopOverview };
