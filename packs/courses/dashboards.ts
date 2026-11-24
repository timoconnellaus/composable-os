// The Courses dashboard (stage 42, step 7): revenue by month split by course and bundle,
// enrolments by course, completions, lessons done by week, and students with nothing done in two
// weeks. Read-only SQL over the rec_* views. Revenue is the order lines the host priced, of orders
// paid in the period; it is the price the buyer paid (tax inside it). Net of tax waits for the tax
// columns of stage 42's tax step (`feat/tax-at-checkout`), which adds them to rec_order_line.
import type { DashboardDeclaration } from "@composable-os/sdk";

const IN = (column: string) => `${column} >= :paid_from AND ${column} < :paid_to`;
/** The Monday of the week a timestamp column is in, as a date (the stats tool's weeks too). */
export const WEEK = (column: string) =>
  `date(${column}, '-' || ((strftime('%w', ${column}) + 6) % 7) || ' days')`;
/** A course's or a bundle's paid lines in the period, with what they sold. */
const LINES = `FROM rec_order_line l JOIN rec_order o ON o.id = l.order_id
  WHERE l.object_type IN ('courses.course', 'courses.bundle') AND o.state IN ('paid', 'part_paid')
  AND ${IN("o.paid_at")}`;

export const courses: DashboardDeclaration = {
  title: "Courses",
  description:
    "Revenue by month by course and bundle, enrolments by course, completions, lessons done by " +
    "week, and students with nothing done in two weeks.",
  filters: [{ type: "dateRange", id: "paid", label: "Dates", default: "this_quarter" }],
  widgets: [
    {
      id: "revenue",
      type: "kpi",
      title: "Revenue",
      description: "Line totals of course and bundle orders paid in the period (not refunded).",
      sql: `SELECT coalesce(sum(l.line_total), 0) / 100.0 AS value ${LINES}`,
      mapping: { value: "value" },
      options: { compare: true, format: "currency" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "enrolments",
      type: "kpi",
      title: "New enrolments",
      description: "Enrolments made in the period, bought, given or imported.",
      sql: `SELECT count(*) AS value FROM rec_x_courses_enrolment e WHERE ${IN("e.created_at")}`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: {
        object: "courses.enrolment",
        filter: {
          and: [
            { field: "createdAt", op: "gte", value: { $param: "paid_from" } },
            { field: "createdAt", op: "lt", value: { $param: "paid_to" } },
          ],
        },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "lessons-done",
      type: "kpi",
      title: "Lessons done",
      description: "Lessons students marked done in the period.",
      sql: `SELECT count(*) AS value FROM rec_x_courses_progress p
WHERE p.state = 'done' AND ${IN("p.done_at")}`,
      mapping: { value: "value" },
      options: { compare: true },
      layout: { w: 3, h: 1 },
    },
    {
      id: "completed",
      type: "kpi",
      title: "Completed (imported)",
      description: "Enrolments brought from the old platform marked completed.",
      sql: "SELECT count(*) AS value FROM rec_x_courses_enrolment e WHERE e.completed = 1",
      mapping: { value: "value" },
      options: { compare: false },
      layout: { w: 3, h: 1 },
    },
    {
      id: "revenue-by-month",
      type: "bar",
      title: "Revenue by month",
      description: "Paid line totals per month, by course or bundle.",
      sql: `SELECT substr(o.paid_at, 1, 7) AS month, l.title AS item,
  sum(l.line_total) / 100.0 AS revenue ${LINES}
GROUP BY month, l.title ORDER BY month, item`,
      mapping: { x: "month", y: ["revenue"], series: "item" },
      layout: { w: 6, h: 2 },
    },
    {
      id: "enrolments-by-course",
      type: "leaderboard",
      title: "Enrolments by course",
      description: "Active enrolments per course (a bundle's are counted on the bundle).",
      sql: `SELECT c.id AS course_id, c.title AS label, count(e.id) AS value
FROM rec_x_courses_course c JOIN rec_x_courses_enrolment e ON e.course = c.id
WHERE e.status = 'active' GROUP BY c.id, c.title ORDER BY value DESC, label LIMIT 10`,
      mapping: { label: "label", value: "value" },
      clickThrough: {
        object: "courses.enrolment",
        filter: { field: "course", op: "eq", value: { $row: "course_id" } },
      },
      layout: { w: 6, h: 2 },
    },
    {
      id: "done-by-week",
      type: "line",
      title: "Lessons done by week",
      description: "Lessons marked done per week of the period.",
      sql: `SELECT ${WEEK("p.done_at")} AS week, count(*) AS done
FROM rec_x_courses_progress p WHERE p.state = 'done' AND ${IN("p.done_at")}
GROUP BY week ORDER BY week`,
      mapping: { x: "week", y: ["done"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "quiet",
      type: "table",
      title: "Nothing done in two weeks",
      description:
        "Students with an active enrolment and no lesson started or done in the last 14 days.",
      sql: `SELECT p.id AS id, p.display_name AS student,
  (SELECT max(g.updated_at) FROM rec_x_courses_progress g WHERE g.holder = e.holder) AS last_seen
FROM rec_x_courses_enrolment e JOIN rec_person p ON p.id = e.holder
WHERE e.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM rec_x_courses_progress g WHERE g.holder = e.holder
  AND g.updated_at >= date(:today, '-14 days'))
GROUP BY p.id ORDER BY last_seen, student LIMIT 50`,
      mapping: { columns: ["student", "last_seen"] },
      clickThrough: { object: "person", filter: { field: "id", op: "eq", value: { $row: "id" } } },
      layout: { w: 6, h: 2 },
    },
  ],
};

export const coursesDashboards = { courses };
