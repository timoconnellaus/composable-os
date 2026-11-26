// The Offers dashboard (stage 34, step 5): what each discount gave and brought in, from the
// host's own records of it. Read-only SQL over the rec_* views: `rec_discount_use` (each order a
// discount was used on: held, used once paid, released, and what it took off), `rec_order` (the
// order's total after its deal) and the discounts' own view. Money is in the currency's major
// unit (minor units / 100). Gift vouchers, gift cards and referrals join it in their own steps.
import type { DashboardDeclaration } from "@composable-os/sdk";

const USED = `FROM rec_discount_use u
  JOIN rec_x_offers_discount d ON d.id = u.discount_id
  WHERE u.state = 'used' AND u.created_at >= :used_from AND u.created_at < :used_to`;

export const offersOverview: DashboardDeclaration = {
  title: "Offers",
  description:
    "Which discounts are live, the money they took off paid orders, and the orders and revenue " +
    "each brought in.",
  filters: [{ type: "dateRange", id: "used", label: "Ordered", default: "this_month" }],
  widgets: [
    {
      id: "live",
      type: "kpi",
      title: "Live discounts",
      description: "Discounts the host applies now (their own dates aside).",
      sql: "SELECT count(*) AS value FROM rec_x_offers_discount d WHERE d.state = 'active'",
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "offers.discount",
        filter: { field: "state", op: "eq", value: "active" },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "given",
      type: "kpi",
      title: "Discount given",
      description: "Money discounts took off orders paid, started in the period.",
      sql: `SELECT coalesce(sum(u.amount), 0) / 100.0 AS value ${USED}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "orders",
      type: "kpi",
      title: "Orders with a discount",
      description: "Paid orders, started in the period, that a discount applied to.",
      sql: `SELECT count(*) AS value ${USED}`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 3, h: 1 },
    },
    {
      id: "revenue",
      type: "kpi",
      title: "Revenue with a discount",
      description: "What those orders cost their buyers, after the discount.",
      sql: `SELECT coalesce(sum(u.order_total), 0) / 100.0 AS value ${USED}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "per-discount",
      type: "table",
      title: "By discount",
      description:
        "Each discount used on paid orders started in the period: how many orders, the money it " +
        "took off and what the orders came to after it.",
      sql: `SELECT d.id AS id, d.name AS discount, d.state AS state, count(*) AS orders,
  coalesce(sum(u.amount), 0) / 100.0 AS given, coalesce(sum(u.order_total), 0) / 100.0 AS revenue
${USED}
GROUP BY d.id, d.name, d.state ORDER BY given DESC LIMIT 100`,
      mapping: { columns: ["discount", "state", "orders", "given", "revenue"] },
      clickThrough: {
        object: "offers.discount",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 12, h: 2 },
    },
    {
      id: "by-kind",
      type: "donut",
      title: "By code or by itself",
      description: "Money off paid orders in the period, by a code or a price that applies itself.",
      sql: `SELECT CASE u.kind WHEN 'code' THEN 'By a code' ELSE 'By itself' END AS label,
  coalesce(sum(u.amount), 0) / 100.0 AS value
${USED}
GROUP BY label`,
      mapping: { label: "label", value: "value" },
      layout: { w: 6, h: 2 },
    },
  ],
};

export const offersDashboards = { offersOverview };
