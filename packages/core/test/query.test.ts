// query.sql: the ADR 0010 / ADR 0020 guards (stage 1 criterion 8), against real D1.
import { env } from "cloudflare:workers";
import { seedDatabase } from "@composable-os/db/seed";
import { OLD_VIEW_PREFIX } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  invoke,
  type OperationError,
  QueryTimeoutError,
  SqlRejectedError,
  tokenize,
  ValidationError,
  validateReadOnlySql,
} from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

let viewer: ActingUser;
let schema: Set<string>;

beforeAll(async () => {
  viewer = await createUser("viewer");
  await seedDatabase(env.DB, { people: 300, organisations: 50, activities: 50, tasks: 50 });
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master").all<{
    name: string;
  }>();
  schema = new Set(results.map((r) => r.name));
}, 60_000);

const run = (
  sql: string,
  extra: {
    params?: (string | number | boolean | null)[];
    maxRows?: number;
    timeoutMs?: number;
  } = {},
) => invoke("query.sql", { sql, ...extra }, context(viewer));

async function expectRejected(sql: string, reason?: RegExp) {
  const error = await run(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, sql).toBeInstanceOf(SqlRejectedError);
  if (reason) expect((error as Error).message, sql).toMatch(reason);
}

describe("query.sql: allowed queries", () => {
  it("runs SELECTs over rec_* views with joins, grouping, CTEs, json_each and windows", async () => {
    const people = await run(
      "SELECT id, display_name FROM rec_person ORDER BY display_name LIMIT 5",
    );
    expect(people.rowCount).toBe(5);
    expect(people.columns).toEqual(["id", "display_name"]);
    expect(people.views).toEqual(["rec_person"]);

    const grouped = await run(`
      SELECT o.name, COUNT(*) AS n
      FROM rec_person p
      JOIN rec_affiliation a ON a.person_id = p.id AND a.is_primary = 1
      JOIN rec_organisation o ON o.id = a.organisation_id
      GROUP BY o.id ORDER BY n DESC, o.name LIMIT 3`);
    expect(grouped.rowCount).toBe(3);
    expect(grouped.views).toEqual(["rec_affiliation", "rec_organisation", "rec_person"]);

    const cte = await run(`
      WITH recent AS (SELECT id, type FROM rec_activity ORDER BY occurred_at DESC LIMIT 10),
           counts AS (SELECT type, COUNT(*) AS n FROM recent GROUP BY type)
      SELECT * FROM counts ORDER BY n DESC NULLS LAST`);
    expect(cte.rowCount).toBeGreaterThan(0);

    const emails = await run(
      "SELECT p.id, e.value AS email FROM rec_person p, json_each(p.emails) e WHERE e.value LIKE ? LIMIT 3",
      { params: ["%@%"] },
    );
    expect(emails.rows[0]?.email).toMatch(/@/);

    const window = await run(
      "SELECT id, row_number() OVER (PARTITION BY type ORDER BY occurred_at DESC) AS rn, COUNT(*) FILTER (WHERE type = 'note') OVER () AS notes FROM rec_activity LIMIT 5",
    );
    expect(window.rowCount).toBe(5);

    const numbered = await run("SELECT ?2 AS b, ?1 AS a", { params: ["x", 2] });
    expect(numbered.rows).toEqual([{ b: 2, a: "x" }]);

    const trailing = await run("SELECT 1 AS one; ;  -- done");
    expect(trailing.rows).toEqual([{ one: 1 }]);

    const quoted = await run('SELECT "id" FROM "rec_person" LIMIT 1');
    expect(quoted.rowCount).toBe(1);

    // Strings and comments containing forbidden words are fine: they are not keywords.
    const words = await run(
      "SELECT 'DELETE FROM core_person; PRAGMA x' AS s /* DROP TABLE core_audit */",
    );
    expect(words.rows).toEqual([{ s: "DELETE FROM core_person; PRAGMA x" }]);
  });

  it("enforces the row limit", async () => {
    const result = await run("SELECT id FROM rec_person", { maxRows: 7 });
    expect(result.rowCount).toBe(7);
    expect(result.truncated).toBe(true);
    const all = await run("SELECT COUNT(*) AS n FROM rec_person");
    expect(all.truncated).toBe(false);
    // An inner LIMIT larger than maxRows is still capped.
    expect((await run("SELECT id FROM rec_person LIMIT 100", { maxRows: 3 })).rowCount).toBe(3);
    await expect(run("SELECT 1", { maxRows: 5000 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("binds params rather than splicing them", async () => {
    const payload = "x' OR 1=1; DROP TABLE core_person; --";
    const result = await run("SELECT COUNT(*) AS n FROM rec_person WHERE display_name = ?", {
      params: [payload],
    });
    expect(result.rows).toEqual([{ n: 0 }]);
    const echo = await run("SELECT ? AS v", { params: [payload] });
    expect(echo.rows).toEqual([{ v: payload }]);
    const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_person").first<{
      n: number;
    }>();
    expect(still?.n).toBeGreaterThan(0);
    await expect(run("SELECT ? AS a", { params: [] })).rejects.toThrow(/1 parameter/);
    await expect(run("SELECT 1", { params: [1] })).rejects.toThrow(/0 parameter/);
  });
});

describe("query.sql: rejections", () => {
  it.each([
    ["INSERT INTO core_person (id) VALUES ('x')", /only SELECT or WITH/],
    ["UPDATE core_person SET display_name = 'x'", /only SELECT or WITH/],
    ["DELETE FROM core_audit", /only SELECT or WITH/],
    ["REPLACE INTO core_tags (id, name) VALUES ('a', 'b')", /only SELECT or WITH/],
    ["CREATE TABLE rec_evil (x)", /only SELECT or WITH/],
    ["DROP VIEW rec_person", /only SELECT or WITH/],
    ["ALTER TABLE core_person ADD COLUMN x", /only SELECT or WITH/],
    ["VACUUM", /only SELECT or WITH/],
    ["BEGIN; SELECT 1", /only one statement|only SELECT/],
    ["VALUES (1)", /only SELECT or WITH/],
    ["EXPLAIN SELECT * FROM rec_person", /only SELECT or WITH/],
  ])("rejects non-SELECT statements: %s", async (sql, reason) => {
    await expectRejected(sql, reason);
  });

  it.each([
    ["PRAGMA table_info(core_person)"],
    ["SELECT * FROM pragma_table_info('core_person')"],
    ["SELECT * FROM rec_person, pragma_table_list"],
    ["SELECT (SELECT name FROM pragma_database_list) AS x"],
  ])("rejects PRAGMA in any form: %s", async (sql) => {
    await expectRejected(sql);
  });

  it.each([["ATTACH DATABASE 'x.db' AS x"], ["DETACH DATABASE x"], ["SELECT 1; ATTACH 'x' AS y"]])(
    "rejects ATTACH and DETACH: %s",
    async (sql) => {
      await expectRejected(sql);
    },
  );

  it.each([
    ["SELECT 1; SELECT 2"],
    ["SELECT 1; DELETE FROM core_person"],
    ["SELECT * FROM rec_person WHERE id = ''; DROP TABLE core_person; --'"],
    ["SELECT 1 /* x */ ; /* y */ SELECT 2"],
  ])("rejects multiple statements: %s", async (sql) => {
    await expectRejected(sql, /only one statement|not allowed|not readable/);
  });

  it.each([
    ["SELECT * FROM core_person"],
    ["SELECT * FROM CORE_PERSON"],
    ['SELECT * FROM "core_person"'],
    ["SELECT * FROM [core_person]"],
    ["SELECT * FROM `core_user`"],
    ["SELECT * FROM main.core_person"],
    ["SELECT * FROM main.rec_person"],
    ["SELECT * FROM sqlite_master"],
    ["SELECT * FROM sqlite_schema"],
    ["SELECT * FROM sqlite_temp_master"],
    ["SELECT sqlite_version()"],
    ["SELECT * FROM sqlite_dbpage"],
    ["SELECT * FROM dbstat"],
    ["SELECT * FROM _cf_KV"],
    ["SELECT * FROM core_search WHERE core_search MATCH 'a'"],
    ["SELECT * FROM core_search_data"],
    ["SELECT * FROM core_migrations"],
    ["SELECT * FROM x_deals_deal"],
    ["SELECT * FROM rec_person WHERE id IN (SELECT person_id FROM core_person_emails)"],
    ["SELECT (SELECT password FROM core_account LIMIT 1) AS p"],
    ["WITH s AS (SELECT * FROM core_session) SELECT * FROM s"],
    ["SELECT * FROM rec_person p JOIN core_affiliation a ON a.person_id = p.id"],
    ["SELECT * FROM rec_person a JOIN rec_person b ON a.id = b.id, core_user"],
    ["SELECT * FROM rec_nonexistent"],
    ["SELECT * FROM somewhere_else"],
    ["SELECT core_person.id FROM rec_person"],
  ])("rejects anything but rec_* views: %s", async (sql) => {
    await expectRejected(sql, /not readable|no view|schema-qualified/);
  });

  // Stage 20: the views were renamed. A query naming an old one is told the new name.
  it.each([
    [`SELECT * FROM ${OLD_VIEW_PREFIX}people`, "rec_person"],
    [`SELECT * FROM ${OLD_VIEW_PREFIX}organisations o`, "rec_organisation"],
    [
      `SELECT * FROM rec_person p JOIN ${OLD_VIEW_PREFIX}activity_links l ON 1`,
      "rec_activity_link",
    ],
    [`SELECT * FROM ${OLD_VIEW_PREFIX}x_deals_deal`, "rec_x_deals_deal"],
    [`SELECT ${OLD_VIEW_PREFIX}tasks.id FROM rec_task`, "rec_task"],
    [`SELECT * FROM ${OLD_VIEW_PREFIX.toUpperCase()}USERS`, "rec_user"],
  ])(
    "refuses a view named under the old contract, naming the new one: %s",
    async (sql, renamed) => {
      const error = await run(sql).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, sql).toBeInstanceOf(SqlRejectedError);
      expect((error as Error).message).toContain(`was renamed ${renamed}`);
      expect((error as SqlRejectedError).details).toMatchObject({ renamedTo: renamed });
    },
  );

  it.each([
    ["WITH a AS (SELECT 1) DELETE FROM core_person", /DELETE is not allowed/],
    ["WITH a AS (SELECT 1) INSERT INTO rec_person SELECT * FROM a", /INSERT is not allowed/],
    ["SELECT * FROM rec_person WHERE id = (UPDATE core_person SET x = 1 RETURNING id)", /UPDATE/],
    [
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT * FROM c",
      /RECURSIVE/,
    ],
    ["WITH c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c", /recursive/],
    ["SELECT load_extension('evil')", /load_extension/],
    ["SELECT readfile('/etc/passwd')", /readfile/],
    ["SELECT * FROM rec_person WHERE id = :id", /named/],
    ["SELECT * FROM rec_person WHERE id = @id", /named/],
    ["SELECT * FROM rec_person WHERE id = $id", /named/],
    ["SELECT ? , ?1", /mix/],
    ["SELECT 1 /* unterminated", /unterminated comment/],
    ["SELECT 'unterminated", /unterminated quote/],
    ["SELECT 1 # mysql comment", /unexpected character/],
    ["SELECT 1)) UNION SELECT * FROM core_person --", /unbalanced|not readable/],
    ["SELECT * FROM (SELECT 1", /unbalanced/],
    ["", /empty|Invalid/],
    ["  ;  ", /empty/],
    ["-- only a comment", /empty/],
    ["SELECT * INTO backup FROM rec_person", /INTO is not allowed/],
  ])("rejects %s", async (sql, reason) => {
    const error = await run(sql).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, sql).toBeInstanceOf(ValidationError);
    expect((error as Error).message, sql).toMatch(reason);
  });

  it("lexes like SQLite: backslashes do not escape quotes", () => {
    // A MySQL-style parser reads one string here; SQLite reads 'x\' then a subquery on core_person.
    const sql = "SELECT 'x\\' , (SELECT display_name FROM core_person LIMIT 1) AS leak, 'y'";
    expect(
      tokenize(sql)
        .filter((t) => t.kind === "string")
        .map((t) => t.text),
    ).toEqual(["'x\\'", "'y'"]);
    expect(() => validateReadOnlySql(sql, schema)).toThrow(SqlRejectedError);
  });

  it("refuses names of every non-crm schema object, wherever they appear", () => {
    for (const name of schema) {
      if (name.startsWith("rec_")) continue;
      expect(() => validateReadOnlySql(`SELECT 1 AS "${name}"`, schema), name).toThrow(
        SqlRejectedError,
      );
    }
  });

  it("does not audit human reads", async () => {
    const none = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_audit WHERE operation = 'query.sql' AND user_id = ?",
    )
      .bind(viewer.id)
      .first<{ n: number }>();
    expect(none?.n).toBe(0);
  });
});

describe("query.sql: time limit", () => {
  it("fails with a timeout error when the query runs too long", async () => {
    // 300 x 300 x 50 = 4.5M rows: far longer than 20 ms.
    const error = await run(
      "SELECT COUNT(*) AS n FROM rec_person a, rec_person b, rec_activity c WHERE a.id <> b.id",
      { timeoutMs: 20 },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect((error as OperationError).code).toBe("timeout");
  }, 60_000);
});
