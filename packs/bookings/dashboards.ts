// The Bookings dashboard (stage 31a step 9, the spec's "Reports"): attendance by class type, hour
// and coach; how full classes are; late cancels and no-shows by month and by member; waiting-list
// joins and how many got in; first visits and whether they came back. Read-only SQL over the
// rec_* views, every number over the classes that start in the chosen dates (a class the gym
// cancelled counts for none of them). A class's places are the host's counters (rec_capacity).
// Uses spent by plan are the Memberships dashboard's ("Classes taken per week"): Bookings does not
// require Memberships, so its SQL names none of its views.
import type { DashboardDeclaration } from "@composable-os/sdk";

/** Classes starting in the period, not cancelled by the gym. */
const IN_PERIOD =
  "c.starts_at >= :dates_from AND c.starts_at < :dates_to AND c.state != 'cancelled'";
/** A class's bookings, with the class, in the period. */
const BOOKINGS = `FROM rec_x_bookings_booking b JOIN rec_x_bookings_class c ON c.id = b.class
WHERE ${IN_PERIOD}`;
/** A booking that held a place on its class: booked, came, or did not come. */
const HELD = "b.state IN ('booked', 'attended', 'no_show')";
/** A booking that ever waited: waiting now, left, moved in or passed over. */
const WAITED =
  "(b.state IN ('waiting', 'left') OR b.promoted_at IS NOT NULL OR b.passed_over_at IS NOT NULL)";
const state = (value: string) => ({
  object: "bookings.booking",
  filter: { field: "state", op: "eq" as const, value },
});

export const bookingsOverview: DashboardDeclaration = {
  title: "Bookings",
  description:
    "Attendance by class type, hour and coach; how full classes are; late cancels and no-shows " +
    "by month and member; waiting-list joins and how many got in; first visits and whether " +
    "they came back.",
  filters: [{ type: "dateRange", id: "dates", label: "Classes from", default: "this_month" }],
  widgets: [
    {
      id: "attended",
      type: "kpi",
      title: "Came",
      description: "Bookings ticked as come, on classes in the dates.",
      sql: `SELECT count(*) AS value ${BOOKINGS} AND b.state = 'attended'`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: state("attended"),
      layout: { w: 3, h: 1 },
    },
    {
      id: "no-shows",
      type: "kpi",
      title: "No-shows",
      description: "Bookings marked as not come (by a coach, or after the class by the host).",
      sql: `SELECT count(*) AS value ${BOOKINGS} AND b.state = 'no_show'`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: state("no_show"),
      layout: { w: 3, h: 1 },
    },
    {
      id: "late-cancels",
      type: "kpi",
      title: "Late cancels",
      description: "Bookings cancelled after the late-cancel time: each kept its use.",
      sql: `SELECT count(*) AS value ${BOOKINGS} AND b.state = 'late_cancelled'`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: state("late_cancelled"),
      layout: { w: 3, h: 1 },
    },
    {
      id: "full",
      type: "kpi",
      title: "How full",
      description:
        "Places taken over places, across the classes in the dates (booked, came or not come).",
      sql: `SELECT coalesce(round(100.0 * sum(coalesce(k.taken, 0)) / nullif(sum(coalesce(k.places, 0)), 0)), 0) AS value
FROM rec_x_bookings_class c
LEFT JOIN rec_capacity k ON k.object_type = 'bookings.class' AND k.record_id = c.id
WHERE ${IN_PERIOD}`,
      mapping: { value: "value" },
      options: { compare: true, format: "percent" },
      layout: { w: 3, h: 1 },
    },
    {
      id: "by-type",
      type: "bar",
      title: "Attendance by class type",
      description: "Who came, and who held a place, per class type.",
      sql: `SELECT t.id AS type_id, coalesce(t.name, 'No class type') AS type,
  sum(CASE WHEN b.state = 'attended' THEN 1 ELSE 0 END) AS came,
  sum(CASE WHEN ${HELD} THEN 1 ELSE 0 END) AS booked
${BOOKINGS.replace("WHERE", "LEFT JOIN rec_x_programs_classtype t ON t.id = c.class_type WHERE")}
GROUP BY t.id, t.name ORDER BY came DESC, type LIMIT 20`,
      mapping: { x: "type", y: ["came", "booked"] },
      clickThrough: {
        object: "bookings.booking",
        filter: { field: "classType", op: "eq", value: { $row: "type_id" } },
      },
      layout: { w: 6, h: 2 },
    },
    {
      id: "by-hour",
      type: "bar",
      title: "Attendance by time of day",
      description: "Who came, by the hour the class starts in its own time zone.",
      sql: `SELECT printf('%02d:00', b.minute / 60) AS hour, count(*) AS came
${BOOKINGS} AND b.state = 'attended' AND b.minute IS NOT NULL
GROUP BY hour ORDER BY hour`,
      mapping: { x: "hour", y: ["came"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "by-coach",
      type: "bar",
      title: "Attendance by coach",
      description: "Who came, per coach of the class.",
      sql: `SELECT coalesce(co.name, 'No coach') AS coach, count(*) AS came
${BOOKINGS.replace("WHERE", "LEFT JOIN rec_x_bookings_coach co ON co.id = c.coach WHERE")} AND b.state = 'attended'
GROUP BY co.id, co.name ORDER BY came DESC, coach LIMIT 20`,
      mapping: { x: "coach", y: ["came"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "misses-by-month",
      type: "line",
      title: "Late cancels and no-shows by month",
      description: "Per month of the class.",
      sql: `SELECT substr(c.starts_at, 1, 7) AS month,
  sum(CASE WHEN b.state = 'late_cancelled' THEN 1 ELSE 0 END) AS late_cancels,
  sum(CASE WHEN b.state = 'no_show' THEN 1 ELSE 0 END) AS no_shows
${BOOKINGS} GROUP BY month ORDER BY month`,
      mapping: { x: "month", y: ["late_cancels", "no_shows"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "waitlist",
      type: "table",
      title: "Waiting lists",
      description:
        "Bookings that joined a waiting list, and how many were moved in from it, per class type.",
      sql: `SELECT coalesce(t.name, 'No class type') AS type, count(*) AS joined,
  sum(CASE WHEN b.promoted_at IS NOT NULL THEN 1 ELSE 0 END) AS got_in
${BOOKINGS.replace("WHERE", "LEFT JOIN rec_x_programs_classtype t ON t.id = c.class_type WHERE")} AND ${WAITED}
GROUP BY t.id, t.name ORDER BY joined DESC, type LIMIT 20`,
      mapping: { columns: ["type", "joined", "got_in"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "first-visits",
      type: "table",
      title: "First visits",
      description:
        "Members whose first class they came to is in the dates, and how many classes they came " +
        "to after it (0: they have not come back).",
      sql: `WITH came AS (
  SELECT b.person AS person, c.starts_at AS at
  FROM rec_x_bookings_booking b JOIN rec_x_bookings_class c ON c.id = b.class
  WHERE b.state = 'attended' AND b.person IS NOT NULL
), firsts AS (SELECT person, min(at) AS first FROM came GROUP BY person)
SELECT p.id AS id, p.display_name AS member, f.first AS first_class,
  (SELECT count(*) FROM came l WHERE l.person = f.person AND l.at > f.first) AS came_back
FROM firsts f JOIN rec_person p ON p.id = f.person
WHERE f.first >= :dates_from AND f.first < :dates_to
ORDER BY f.first, p.display_name LIMIT 100`,
      mapping: { columns: ["member", "first_class", "came_back"] },
      clickThrough: {
        object: "person",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 6, h: 2 },
    },
    {
      id: "misses-by-member",
      type: "table",
      title: "Late cancels and no-shows by member",
      description: "Members with a late cancel or a no-show on a class in the dates, most first.",
      sql: `SELECT p.id AS id, p.display_name AS member,
  sum(CASE WHEN b.state = 'late_cancelled' THEN 1 ELSE 0 END) AS late_cancels,
  sum(CASE WHEN b.state = 'no_show' THEN 1 ELSE 0 END) AS no_shows
${BOOKINGS.replace("WHERE", "JOIN rec_person p ON p.id = b.person WHERE")} AND b.state IN ('late_cancelled', 'no_show')
GROUP BY p.id, p.display_name ORDER BY late_cancels + no_shows DESC, member LIMIT 50`,
      mapping: { columns: ["member", "late_cancels", "no_shows"] },
      clickThrough: {
        object: "bookings.booking",
        filter: { field: "person", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 12, h: 2 },
    },
  ],
};

export const bookingsDashboards = { bookings: bookingsOverview };
