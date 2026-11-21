// The Training dashboard (stage 41, step 4): sessions planned against done, sets logged by week,
// the most used exercises, and clients with nothing logged in two weeks. Read-only SQL over the
// rec_* views. A session counts by its date; a set by the date of its session. Each widget opens
// the records it counted.
import type { DashboardDeclaration } from "@composable-os/sdk";

const IN = (column: string) => `${column} >= :date_from AND ${column} < :date_to`;
/** A week: the Monday it starts on. */
const WEEK = (column: string) =>
  `date(${column}, '-' || ((strftime('%w', ${column}) + 6) % 7) || ' days')`;

export const training: DashboardDeclaration = {
  title: "Training",
  description:
    "Sessions planned against done, sets logged by week, the most used exercises, and clients " +
    "with nothing logged in two weeks.",
  filters: [{ type: "dateRange", id: "date", label: "Dates", default: "this_quarter" }],
  widgets: [
    {
      id: "planned",
      type: "kpi",
      title: "Sessions planned",
      description: "Clients' own sessions dated in the period (classes not counted).",
      sql: `SELECT count(*) AS value FROM rec_x_programs_session s
WHERE s.kind = 'personal' AND ${IN("s.date")}`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: {
        object: "programs.session",
        filter: {
          and: [
            { field: "kind", op: "eq", value: "personal" },
            { field: "date", op: "gte", value: { $param: "date_from" } },
            { field: "date", op: "lt", value: { $param: "date_to" } },
          ],
        },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "done",
      type: "kpi",
      title: "Sessions done",
      description: "Of those, the ones marked done.",
      sql: `SELECT count(*) AS value FROM rec_x_programs_session s
WHERE s.kind = 'personal' AND s.state = 'done' AND ${IN("s.date")}`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: {
        object: "programs.session",
        filter: {
          and: [
            { field: "kind", op: "eq", value: "personal" },
            { field: "state", op: "eq", value: "done" },
            { field: "date", op: "gte", value: { $param: "date_from" } },
            { field: "date", op: "lt", value: { $param: "date_to" } },
          ],
        },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "sets",
      type: "kpi",
      title: "Sets logged",
      description: "Sets logged on sessions dated in the period, by clients and in classes.",
      sql: `SELECT count(*) AS value FROM rec_x_programs_log l WHERE ${IN("l.date")}`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: {
        object: "programs.log",
        filter: {
          and: [
            { field: "date", op: "gte", value: { $param: "date_from" } },
            { field: "date", op: "lt", value: { $param: "date_to" } },
          ],
        },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "quiet-count",
      type: "kpi",
      title: "Clients quiet for two weeks",
      description: "Clients with an active program and no set logged in the last 14 days.",
      sql: `SELECT count(DISTINCT a.person) AS value FROM rec_x_programs_assignment a
WHERE a.kind = 'personal' AND a.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM rec_x_programs_log l WHERE l.person = a.person AND l.date >= date(:today, '-14 days'))`,
      mapping: { value: "value" },
      options: { compare: false },
      layout: { w: 3, h: 1 },
    },
    {
      id: "planned-done",
      type: "bar",
      title: "Planned and done, by week",
      description: "Clients' own sessions per week of the period: planned, done and skipped.",
      sql: `SELECT ${WEEK("s.date")} AS week, count(*) AS planned,
  sum(CASE WHEN s.state = 'done' THEN 1 ELSE 0 END) AS done,
  sum(CASE WHEN s.state = 'skipped' THEN 1 ELSE 0 END) AS skipped
FROM rec_x_programs_session s WHERE s.kind = 'personal' AND ${IN("s.date")}
GROUP BY week ORDER BY week`,
      mapping: { x: "week", y: ["planned", "done", "skipped"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "sets-by-week",
      type: "line",
      title: "Sets logged by week",
      description: "Sets logged per week of the period, by their session's date.",
      sql: `SELECT ${WEEK("l.date")} AS week, count(*) AS sets
FROM rec_x_programs_log l WHERE ${IN("l.date")} GROUP BY week ORDER BY week`,
      mapping: { x: "week", y: ["sets"] },
      layout: { w: 6, h: 2 },
    },
    {
      id: "exercises",
      type: "leaderboard",
      title: "Most used exercises",
      description: "Exercises by sets logged in the period.",
      sql: `SELECT e.id AS exercise_id, e.name AS label, count(*) AS value
FROM rec_x_programs_log l JOIN rec_x_programs_exercise e ON e.id = l.exercise
WHERE ${IN("l.date")} GROUP BY e.id, e.name ORDER BY value DESC, label LIMIT 10`,
      mapping: { label: "label", value: "value" },
      clickThrough: {
        object: "programs.log",
        filter: {
          and: [
            { field: "exercise", op: "eq", value: { $row: "exercise_id" } },
            { field: "date", op: "gte", value: { $param: "date_from" } },
            { field: "date", op: "lt", value: { $param: "date_to" } },
          ],
        },
      },
      layout: { w: 6, h: 2 },
    },
    {
      id: "quiet",
      type: "table",
      title: "Nothing logged in two weeks",
      description:
        "Clients with an active program and no set logged in the last 14 days, with their last set.",
      sql: `SELECT p.id AS id, p.display_name AS client, a.title AS program,
  (SELECT max(l.date) FROM rec_x_programs_log l WHERE l.person = a.person) AS last_logged
FROM rec_x_programs_assignment a JOIN rec_person p ON p.id = a.person
WHERE a.kind = 'personal' AND a.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM rec_x_programs_log l WHERE l.person = a.person AND l.date >= date(:today, '-14 days'))
ORDER BY last_logged, client LIMIT 50`,
      mapping: { columns: ["client", "program", "last_logged"] },
      clickThrough: { object: "person", filter: { field: "id", op: "eq", value: { $row: "id" } } },
      layout: { w: 6, h: 2 },
    },
  ],
};

export const programsDashboards = { training };
