// A migration file's statements as `cos` sends them to the operator's Worker (stage 66 step 7):
// every migration of the repository, split here, makes the same schema as `readD1Migrations`'s.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ClientDb, clientDatabase } from "../src/client-db.ts";
import { applyMigrations, type Migration } from "../src/migrate.ts";
import { schemaRows } from "../src/sql-export.ts";
import { migrationOf, splitSqlStatements } from "../src/sql-split.ts";

const files = import.meta.glob<string>("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const real = env as unknown as {
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  TEST_MIGRATIONS: Migration[];
};

describe("splitting a migration file", () => {
  it("splits at ; outside strings, identifiers, comments and a trigger's body", () => {
    expect(
      splitSqlStatements(`-- a comment; not a statement
CREATE TABLE "a;b" (v TEXT DEFAULT 'x;y''z'); /* c; */
CREATE TRIGGER t AFTER INSERT ON "a;b" BEGIN
  UPDATE "a;b" SET v = CASE WHEN v = 'e' THEN 'f' ELSE v END;
  SELECT 1;
END;
-- only a comment;
INSERT INTO [a;b] VALUES ('1')`),
    ).toEqual([
      `-- a comment; not a statement\nCREATE TABLE "a;b" (v TEXT DEFAULT 'x;y''z')`,
      `/* c; */\nCREATE TRIGGER t AFTER INSERT ON "a;b" BEGIN\n  UPDATE "a;b" SET v = CASE WHEN v = 'e' THEN 'f' ELSE v END;\n  SELECT 1;\nEND`,
      `-- only a comment;\nINSERT INTO [a;b] VALUES ('1')`,
    ]);
  });

  it("makes, for every migration of the repository, the schema readD1Migrations makes", async () => {
    const ours = Object.entries(files)
      .map(([path, sql]) => migrationOf(path.split("/").at(-1) as string, sql))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(ours.map((m) => m.name)).toEqual(
      [...real.TEST_MIGRATIONS].map((m) => m.name).sort((a, b) => a.localeCompare(b)),
    );
    const a = clientDatabase(real.CLIENT_DB, `split-ours-${crypto.randomUUID()}`);
    const b = clientDatabase(real.CLIENT_DB, `split-theirs-${crypto.randomUUID()}`);
    await applyMigrations(a, ours);
    await applyMigrations(b, real.TEST_MIGRATIONS);
    expect(await schemaRows(a)).toEqual(await schemaRows(b));
  });
});
