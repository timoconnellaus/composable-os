// The Memberships dashboard (stage 32b, build step 7): members now (active, on trial, paused,
// failing), trials that ended in the period and how many became paid, cancellations by month and
// the provider's reason, recurring revenue by month net of tax, and classes taken per week.
// Read-only SQL over the rec_* views. Revenue is the paid orders of membership subscriptions, one
// per paid period (ADR 0486), less what was refunded and the tax inside them (rec_order's `net`).
import type { DashboardDeclaration } from "@composable-os/sdk";

const PLAN = "'memberships.plan'";
const IN = (column: string) => `${column} >= :dates_from AND ${column} < :dates_to`;
const WEEK = (column: string) =>
  `date(${column}, '-' || ((strftime('%w', ${column}) + 6) % 7) || ' days')`;
const MEMBERS = (states: string) =>
  `SELECT count(*) AS value FROM rec_x_memberships_membership m WHERE m.status IN (${states})`;
const statusIs = (values: string[]) => ({
  object: "memberships.membership",
  filter: { field: "status", op: "in" as const, value: values },
});

export const memberships: DashboardDeclaration = {
  title: "Memberships",
  description:
    "Members now (active, on trial, paused, failing), trials that became paid, cancellations by " +
    "month and reason, recurring revenue by month net of tax, and classes taken per week.",
  filters: [{ type: "dateRange", id: "dates", label: "Dates", default: "this_quarter" }],
  widgets: [
    {
      id: "active",
      type: "kpi",
      title: "Active members",
      description: "Memberships active now (paid up), whatever the dates.",
      sql: MEMBERS("'active'"),
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: statusIs(["active"]),
      layout: { w: 3, h: 1 },
    },
    {
      id: "trialing",
      type: "kpi",
      title: "On trial",
      description: "Memberships on their free trial now.",
      sql: MEMBERS("'trialing'"),
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: statusIs(["trialing"]),
      layout: { w: 3, h: 1 },
    },
    {
      id: "paused",
      type: "kpi",
      title: "Paused",
      description: "Memberships paused by staff now: nothing charged, no classes.",
      sql: MEMBERS("'paused'"),
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: statusIs(["paused"]),
      layout: { w: 3, h: 1 },
    },
    {
      id: "failing",
      type: "kpi",
      title: "Payments failing",
      description:
        "Memberships whose renewal failed: past due while the provider retries, or unpaid.",
      sql: MEMBERS("'past_due', 'unpaid'"),
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: statusIs(["past_due", "unpaid"]),
      layout: { w: 3, h: 1 },
    },
    {
      id: "trials-ended",
      type: "kpi",
      title: "Trials ended",
      description: "Membership trials that ended in the period.",
      sql: `SELECT count(*) AS value FROM rec_subscription s
WHERE s.plan_object = ${PLAN} AND s.trial_end IS NOT NULL AND s.trial_end <= :now
AND ${IN("s.trial_end")}`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 3, h: 1 },
    },
    {
      id: "trials-paid",
      type: "kpi",
      title: "Trials that became paid",
      description:
        "Of the trials that ended in the period, those with a paid period after the trial.",
      sql: `SELECT count(*) AS value FROM rec_subscription s
WHERE s.plan_object = ${PLAN} AND s.trial_end IS NOT NULL AND s.trial_end <= :now
AND ${IN("s.trial_end")} AND EXISTS (
  SELECT 1 FROM rec_order o WHERE o.subscription_id = s.id
  AND o.state IN ('paid', 'part_paid', 'refunded') AND o.period_start >= s.trial_end)`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 3, h: 1 },
    },
    {
      id: "revenue",
      type: "kpi",
      title: "Recurring revenue, net of tax",
      description:
        "What membership periods paid in the period brought in, less refunds and the tax inside it.",
      sql: `SELECT coalesce(sum(o.net), 0) / 100.0 AS value FROM rec_order o
JOIN rec_subscription s ON s.id = o.subscription_id
WHERE s.plan_object = ${PLAN} AND o.state IN ('paid', 'part_paid', 'refunded') AND ${IN("o.paid_at")}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "uses",
      type: "kpi",
      title: "Classes taken",
      description: "Uses of memberships and passes for classes in the period, not given back.",
      sql: `SELECT count(*) AS value FROM rec_allowance_use u
WHERE u.object_type IN ('memberships.membership', 'memberships.pass') AND u.returned_at IS NULL
AND ${IN("u.at")}`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 3, h: 1 },
    },
    {
      id: "revenue-by-month",
      type: "bar",
      title: "Recurring revenue by month, net of tax",
      description: "Membership periods paid per month, less refunds and tax.",
      sql: `SELECT substr(o.paid_at, 1, 7) AS month, sum(o.net) / 100.0 AS revenue FROM rec_order o
JOIN rec_subscription s ON s.id = o.subscription_id
WHERE s.plan_object = ${PLAN} AND o.state IN ('paid', 'part_paid', 'refunded') AND ${IN("o.paid_at")}
GROUP BY month ORDER BY month`,
      mapping: { x: "month", y: ["revenue"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "cancellations-by-month",
      type: "bar",
      title: "Cancellations by month",
      description:
        "Memberships cancelled per month, by the provider's reason: asked for (by the member or " +
        "staff) or payments failed.",
      sql: `SELECT substr(s.canceled_at, 1, 7) AS month,
  CASE coalesce(s.end_reason, '') WHEN 'payment_failed' THEN 'Payments failed'
    WHEN 'cancellation_requested' THEN 'Asked for' ELSE 'Other' END AS reason,
  count(*) AS cancelled
FROM rec_subscription s WHERE s.plan_object = ${PLAN} AND s.canceled_at IS NOT NULL
AND ${IN("s.canceled_at")} GROUP BY month, reason ORDER BY month, reason`,
      mapping: { x: "month", y: ["cancelled"], series: "reason" },
      layout: { w: 6, h: 2 },
    },
    {
      id: "uses-by-week",
      type: "line",
      title: "Classes taken by week",
      description: "Uses of memberships and passes per week of the classes, not given back.",
      sql: `SELECT ${WEEK("u.at")} AS week, count(*) AS uses FROM rec_allowance_use u
WHERE u.object_type IN ('memberships.membership', 'memberships.pass') AND u.returned_at IS NULL
AND ${IN("u.at")} GROUP BY week ORDER BY week`,
      mapping: { x: "week", y: ["uses"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "failing-members",
      type: "table",
      title: "Failing payments",
      description: "Memberships past due or unpaid, the longest failing first.",
      sql: `SELECT m.id AS id, p.display_name AS member, m.title AS plan, m.status AS status,
  m.until AS until
FROM rec_x_memberships_membership m JOIN rec_person p ON p.id = m.person
WHERE m.status IN ('past_due', 'unpaid') ORDER BY m.until, member LIMIT 50`,
      mapping: { columns: ["member", "plan", "status", "until"] },
      clickThrough: {
        object: "memberships.membership",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 6, h: 2 },
    },
  ],
};

export const membershipsDashboards = { memberships };
