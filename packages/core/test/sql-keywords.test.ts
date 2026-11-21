// Fields named with an SQL keyword (stage 27): `order`, `group` and `select` used to break the
// reconciler's DDL, and `cos ext check` passed them. A field whose column would be a word D1 will
// not take bare gets the column `<word>_` (naming.ts, RESERVED_COLUMN_WORDS). This file probes
// every SQLite keyword against D1, so the list cannot drift from what D1 refuses, and runs the
// record operations on fields with such names.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, columnName, invoke, RESERVED_COLUMN_WORDS } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

/** Every SQLite keyword (sqlite.org/lang_keywords.html), lowercase, and the literals it reads. */
const SQLITE_KEYWORDS =
  "abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without true false".split(
    " ",
  );

/** Whether D1 takes `column` bare in every place the platform writes a column name. */
async function takesBare(column: string, n: number): Promise<boolean> {
  const t = `kw_probe_${n}`;
  const steps = [
    `CREATE TABLE ${t} (id TEXT PRIMARY KEY, ${column} TEXT)`,
    `CREATE TABLE ${t}_b (id TEXT PRIMARY KEY)`,
    `ALTER TABLE ${t}_b ADD COLUMN ${column} TEXT`,
    `INSERT INTO ${t} (id, ${column}) VALUES ('a', 'x')`,
    `UPDATE ${t} SET ${column} = 'y' WHERE id = 'a'`,
    `INSERT INTO ${t} (id, ${column}) VALUES ('a', 'z') ON CONFLICT (id) DO UPDATE SET ${column} = excluded.${column}`,
    `CREATE VIEW ${t}_v AS SELECT b.id, b.${column} AS ${column} FROM ${t} b`,
    `CREATE INDEX ${t}_i ON ${t} (${column})`,
  ];
  try {
    for (const step of steps) await env.DB.prepare(step).run();
    const read = await env.DB.prepare(
      `SELECT ${column} FROM ${t}_v WHERE ${column} = 'z' ORDER BY ${column}`,
    ).all();
    return JSON.stringify(read.results) === JSON.stringify([{ [column]: "z" }]);
  } catch {
    return false;
  }
}

describe("SQL keywords as field names", () => {
  it("the reserved list is exactly the keywords D1 will not take bare, and their columns work", async () => {
    const refused: string[] = [];
    for (const [n, word] of SQLITE_KEYWORDS.entries()) {
      if (!(await takesBare(word, n))) refused.push(word);
    }
    expect(refused.sort()).toEqual([...RESERVED_COLUMN_WORDS].sort());
    for (const [n, word] of [...RESERVED_COLUMN_WORDS].entries()) {
      const field = word.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect(columnName(field)).toBe(`${word}_`);
      expect(await takesBare(columnName(field), 1000 + n)).toBe(true);
    }
  });

  describe("record operations on fields named order, group, select and currentDate", () => {
    const ext = extId("kw");
    const object = `${ext}.thing`;
    let admin: ActingUser;

    beforeAll(async () => {
      admin = await createUser("admin");
      const m = manifest(ext, {
        objects: {
          thing: {
            label: "Thing",
            plural: "Things",
            titleField: "name",
            fields: {
              name: { type: "text", label: "Name", required: true },
              order: { type: "text", label: "Order" },
              group: { type: "number", label: "Group" },
              select: {
                type: "select",
                label: "Select",
                options: [
                  { value: "a", label: "A" },
                  { value: "b", label: "B" },
                ],
              },
              currentDate: { type: "date", label: "Current date" },
            },
            indexes: [["order"], ["group"]],
          },
        },
      });
      expect(validateManifest(m).issues).toEqual([]);
      await reconcile(m);
    });

    it("creates, reads, filters, sorts and updates", async () => {
      const created = await invoke(
        "record.create",
        {
          object,
          values: { name: "One", order: "ord_1", group: 2, select: "a", currentDate: "2026-01-02" },
        },
        context(admin),
      );
      await invoke(
        "record.create",
        { object, values: { name: "Two", order: "ord_2", group: 1, select: "b" } },
        context(admin),
      );
      const got = await invoke("record.get", { object, id: created.id }, context(admin));
      expect(got.values).toMatchObject({
        order: "ord_1",
        group: 2,
        select: "a",
        currentDate: "2026-01-02",
      });
      const filtered = (await invoke(
        "record.list",
        {
          object,
          filter: { and: [{ field: "order", op: "eq", value: "ord_1" }] },
          sort: { field: "group", direction: "desc" },
        },
        context(admin),
      )) as { items: { id: string }[] };
      expect(filtered.items.map((i) => i.id)).toEqual([created.id]);
      const sorted = (await invoke(
        "record.list",
        { object, sort: { field: "group", direction: "asc" } },
        context(admin),
      )) as { items: { values: Record<string, unknown> }[] };
      expect(sorted.items.map((i) => i.values.group)).toEqual([1, 2]);
      await invoke(
        "record.update",
        { object, id: created.id, values: { order: "ord_9", select: "b", group: null } },
        context(admin),
      );
      const updated = await invoke("record.get", { object, id: created.id }, context(admin));
      expect(updated.values).toMatchObject({ order: "ord_9", select: "b", group: null });
    });
  });
});
