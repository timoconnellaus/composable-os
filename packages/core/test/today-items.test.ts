// Stage 60 (ADR 0870): the host's half of the check on a shipped pack's Today items, against a
// real D1 (criterion 12). An item's SQL follows the widget rules (one SELECT or WITH over rec_*
// views, writing nothing, only Today's parameters) and returns exactly the columns it says: `value`,
// or the rows' display column and record id. The views the pack's own objects make count as
// present before the first install creates them. A runtime extension declaring items is refused
// by its check and at install.
import { defineExtension, defineTool, toManifest, z } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { checkManifest } from "../src/extensions/install.ts";
import { resultColumns } from "../src/today/declaration.ts";
import { db } from "./helpers.ts";

const NOW = new Date().toISOString();

function pack(id: string, todayItems: Record<string, unknown>) {
  return toManifest(
    defineExtension({
      id,
      version: "1.0.0",
      contractVersion: 1,
      objects: {
        visit: {
          label: "Visit",
          plural: "Visits",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            person: { type: "relation", label: "Person", to: "person" },
          },
        },
      },
      tools: {
        day: defineTool({
          description: "Fixture: the day's visits.",
          input: z.object({}),
          output: z.object({}),
          risk: "read",
          handler: () => ({}),
        }),
      },
      todayItems: todayItems as never,
    }),
  );
}

const item = (sql: string, rows?: Record<string, unknown>) => ({
  label: "Visits today",
  format: "count",
  sql,
  opens: ["day"],
  ...(rows ? { rows } : {}),
});

async function issues(todayItems: Record<string, unknown>, source?: "shipped" | "runtime") {
  const m = pack("todaypk", todayItems);
  const result = await checkManifest(db.query, m.id, m, NOW, source ? { source } : {});
  return result.issues.map((i) => `${i.path}: ${i.message}`);
}

const COUNT =
  "SELECT count(*) AS value FROM rec_x_todaypk_visit v WHERE v.created_at >= :today_from AND v.created_at < :today_to";
const ROWS = {
  sql: "SELECT v.name AS visit, p.name AS who, v.person AS person_id FROM rec_x_todaypk_visit v JOIN rec_person p ON p.id = v.person WHERE v.created_at < :now LIMIT 50",
  label: "visit",
  detail: "who",
  record: { object: "person", id: "person_id" },
};

describe("a Today item's SQL (criterion 12)", () => {
  it("passes over its own views (not yet created) and the base ones, with Today's parameters", async () => {
    expect(await issues({ visits: item(COUNT, ROWS) }, "shipped")).toEqual([]);
    expect(
      await issues({
        visits: item("WITH t AS (SELECT * FROM rec_x_todaypk_visit) SELECT count(*) value FROM t"),
      }),
    ).toEqual([]);
  });

  it("refuses SQL that reads a table that is not a rec_* view", async () => {
    for (const table of ["core_user", "x_todaypk_visit", "sqlite_master"]) {
      const [issue] = await issues({ visits: item(`SELECT count(*) AS value FROM ${table}`) });
      expect(issue).toBe(`todayItems.visits.sql: ${table} is not readable; query the rec_* views`);
    }
    expect(
      await issues({ visits: item("SELECT count(*) AS value FROM rec_x_nopack_thing") }),
    ).toEqual(["todayItems.visits.sql: there is no view named rec_x_nopack_thing"]);
  });

  it("refuses SQL that writes, or is two statements", async () => {
    expect(await issues({ visits: item("DELETE FROM rec_x_todaypk_visit") })).toEqual([
      "todayItems.visits.sql: only SELECT or WITH queries are allowed",
    ]);
    expect(
      await issues({
        visits: item("SELECT 1 AS value; DELETE FROM rec_x_todaypk_visit"),
      }),
    ).toEqual(["todayItems.visits.sql: A Today item's query has no semicolon, even at its end"]);
    // Not even last (ADR 0874): Today reads an item as one column of a statement of many.
    expect(
      await issues({ visits: item("SELECT count(*) AS value FROM rec_x_todaypk_visit;") }),
    ).toEqual(["todayItems.visits.sql: A Today item's query has no semicolon, even at its end"]);
    expect(
      await issues({
        visits: item("SELECT count(*) AS value FROM rec_x_todaypk_visit -- a note; not a second"),
      }),
    ).toEqual([]);
    expect(
      await issues({
        visits: item("WITH t AS (SELECT 1) INSERT INTO rec_x_todaypk_visit SELECT * FROM t"),
      }),
    ).toEqual(["todayItems.visits.sql: INSERT is not allowed"]);
  });

  it("refuses a parameter Today does not bind", async () => {
    expect(
      await issues({
        visits: item("SELECT count(*) AS value FROM rec_x_todaypk_visit WHERE name = :who"),
      }),
    ).toEqual(["todayItems.visits.sql: unknown parameter :who"]);
  });

  it("refuses SQL that returns no value, or more than it", async () => {
    expect(await issues({ visits: item("SELECT count(*) FROM rec_x_todaypk_visit") })).toEqual([
      "todayItems.visits.sql: The query returns no column named value",
    ]);
    expect(
      await issues({
        visits: item("SELECT count(*) AS value, max(name) AS n FROM rec_x_todaypk_visit"),
      }),
    ).toEqual(["todayItems.visits.sql: The query returns only value"]);
    expect(await issues({ visits: item("SELECT * FROM rec_x_todaypk_visit") })).toEqual([
      "todayItems.visits.sql: The query returns no column named value",
    ]);
  });

  it("refuses rows that return a column they do not declare, or miss one", async () => {
    expect(
      await issues({
        visits: item(COUNT, {
          ...ROWS,
          sql: "SELECT v.name AS visit, p.name AS who, v.person AS person_id, p.email FROM rec_x_todaypk_visit v JOIN rec_person p ON p.id = v.person",
        }),
      }),
    ).toEqual(["todayItems.visits.rows.sql: The query returns only visit, who, person_id"]);
    expect(
      await issues({
        visits: item(COUNT, {
          ...ROWS,
          sql: "SELECT v.name AS visit, p.name AS who FROM rec_x_todaypk_visit v JOIN rec_person p ON p.id = v.person",
        }),
      }),
    ).toEqual(["todayItems.visits.rows.sql: The query returns no column named person_id"]);
  });
});

describe("only a shipped pack declares Today items (criterion 12)", () => {
  it("check and install refuse a runtime extension's items; a shipped one passes", async () => {
    const runtime = await issues({ visits: item(COUNT) }, "runtime");
    expect(runtime).toContainEqual(
      expect.stringMatching(/^todayItems: A runtime extension cannot declare Today items/),
    );
    expect(await issues({ visits: item(COUNT) }, "shipped")).toEqual([]);
    // Without items, a runtime extension is not refused for them.
    expect((await issues({}, "runtime")).filter((i) => i.startsWith("todayItems"))).toEqual([]);
  });
});

describe("resultColumns", () => {
  it("names the outermost SELECT's columns as SQLite does", () => {
    expect(resultColumns('SELECT a, t.b, count(*) AS n, 1 + 2, max(x) m, "Q" FROM t')).toEqual([
      "a",
      "b",
      "n",
      null,
      "m",
      "q",
    ]);
    expect(
      resultColumns("WITH c AS (SELECT x AS y FROM t) SELECT DISTINCT y AS value FROM c"),
    ).toEqual(["value"]);
    expect(resultColumns("SELECT (SELECT count(*) FROM t) AS value")).toEqual(["value"]);
    expect(resultColumns("SELECT * FROM t")).toEqual([null]);
  });
});
