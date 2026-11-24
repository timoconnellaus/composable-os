// A shipped pack's Today items (stage 60, ADR 0870): what the SDK's contract checks of a
// declaration. At most 8, camelCase keys, a count or a percent and never money, gated by the
// pack's own tools (at least one for staff only), rows that open one of its objects or a base one,
// and a web screen it declares. The SQL (rec_* only, read-only, returns `value`) and that only a
// shipped pack declares items are the host's checks (core's checkManifest).
import { describe, expect, it } from "vitest";
import { defineExtension, defineTool, toManifest, validateManifest, z } from "../src/index.ts";

const tool = (extra: Record<string, unknown> = {}) =>
  defineTool({
    description: "Fixture: a tool a Today item is gated by.",
    input: z.object({}),
    output: z.object({}),
    risk: "read",
    handler: () => ({}),
    ...extra,
  });

function pack(todayItems: Record<string, unknown>) {
  return defineExtension({
    id: "desk",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: { name: { type: "text", label: "Name" } },
      },
    },
    tools: {
      day: tool(),
      timetable: tool({ audiences: ["customer", "public"] }),
      both: tool({ audiences: ["staff", "customer"] }),
    },
    screens: {
      front: { label: "Front desk", block: "desk-front", export: "Front", opens: ["day"] },
    },
    todayItems: todayItems as never,
  });
}

const issues = (todayItems: Record<string, unknown>) =>
  validateManifest(toManifest(pack(todayItems))).issues.map((i) => `${i.path}: ${i.message}`);

const ok = {
  label: "Visits today",
  order: 20,
  format: "count",
  sql: "SELECT count(*) AS value FROM rec_x_desk_visit WHERE created_at >= :today_from AND created_at < :today_to",
  compare: "yesterday",
  attention: { above: 0 },
  rows: {
    sql: "SELECT name AS visit, id FROM rec_x_desk_visit WHERE created_at >= :today_from",
    label: "visit",
    record: { object: "desk.visit", id: "id" },
  },
  opens: ["day"],
  web: { screen: "front" },
};

describe("a pack's Today items (ADR 0870)", () => {
  it("a good declaration passes, and the manifest carries it", () => {
    expect(issues({ visits: ok })).toEqual([]);
    const { rows: _rows, web: _web, attention: _a, compare: _c, order: _o, ...bare } = ok;
    expect(issues({ bare, percent: { ...bare, format: "percent" } })).toEqual([]);
    expect(toManifest(pack({ visits: ok })).todayItems).toEqual({ visits: ok });
    expect(toManifest(pack({ bare })).todayItems).toEqual({ bare });
    // No items, no key: an old manifest is unchanged.
    expect("todayItems" in toManifest(pack({}))).toBe(false);
  });

  it("refuses a money format, and any format but a count or a percent", () => {
    expect(issues({ visits: { ...ok, format: "money" } })).toEqual([
      "todayItems.visits.format: A pack declares no money item: money on Today is the host's, from Finance reports (stage 52)",
    ]);
    expect(issues({ visits: { ...ok, format: "hours" } })).toEqual([
      'todayItems.visits.format: "hours" must be one of count, percent',
    ]);
  });

  it("refuses more than 8 items and a key that is not camelCase", () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`item${i}`, ok]));
    expect(issues(nine)).toEqual(["todayItems: A pack declares at most 8 Today items"]);
    expect(issues({ "came-today": ok })).toEqual([
      'todayItems.came-today: Today item name "came-today" must be camelCase',
    ]);
  });

  it("is gated by the pack's own tools, at least one for staff only", () => {
    expect(issues({ visits: { ...ok, opens: [] } })).toEqual([
      "todayItems.visits.opens: A Today item names at least one of this pack's tools that gates it",
    ]);
    expect(issues({ visits: { ...ok, opens: ["other.day"] } })).toEqual([
      'todayItems.visits.opens.0: "other.day" is not a tool of this pack: a Today item is gated by its own pack\'s tools',
      "todayItems.visits.opens: A Today item's gate names at least one tool for staff only: a tool open to customers or the public is never the only gate",
    ]);
    expect(issues({ visits: { ...ok, opens: ["both"] } })).toEqual([
      "todayItems.visits.opens: A Today item's gate names at least one tool for staff only: a tool open to customers or the public is never the only gate",
    ]);
    expect(issues({ visits: { ...ok, opens: ["day", "timetable"] } })).toEqual([
      'todayItems.visits.opens.1: "timetable" is not for staff, so no member of staff could see this item',
    ]);
    expect(issues({ visits: { ...ok, opens: ["day", "both"] } })).toEqual([]);
  });

  it("opens rows of its own object or a base one, and a screen it declares", () => {
    const rows = (record: { object: string; id: string }) => ({
      ...ok,
      rows: { ...ok.rows, record },
    });
    expect(issues({ visits: rows({ object: "person", id: "person_id" }) })).toEqual([]);
    expect(issues({ visits: rows({ object: "other.visit", id: "id" }) })).toEqual([
      'todayItems.visits.rows.record.object: "other.visit" must be an object of this pack (desk.<object>), person or organisation',
    ]);
    expect(issues({ visits: rows({ object: "desk.visit", id: "the id" }) })).toEqual([
      'todayItems.visits.rows.record.id: "the id" must be the name of a column the rows return',
    ]);
    expect(issues({ visits: { ...ok, web: { screen: "nope" } } })).toEqual([
      'todayItems.visits.web.screen: "nope" is not a screen this pack declares',
    ]);
  });

  it("refuses unknown keys and a bad comparison or attention", () => {
    const parse = (item: Record<string, unknown>) =>
      validateManifest(toManifest(pack({ visits: item }))).issues.map((i) => i.path);
    expect(parse({ ...ok, compare: "lastMonth" })).toEqual(["todayItems.visits.compare"]);
    expect(parse({ ...ok, attention: { above: 1, below: 2 } }).length).toBeGreaterThan(0);
  });
});
