// An empty local database with the core schema applied, for the dry-run reconcile of
// `cos ext check`: Node's built-in SQLite behind the two D1 methods the Kysely dialect in
// @composable-os/db uses, so the reconciler runs the same queries it runs on D1.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type CoreDatabase, createDb } from "@composable-os/db";
import type { CompiledQuery, Kysely } from "kysely";

function param(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value as SQLInputValue;
}

export interface LocalDb {
  db: Kysely<CoreDatabase>;
  /** Runs statements as one transaction, as a D1 batch does. */
  batch(statements: readonly CompiledQuery[]): void;
  close(): void;
}

/** node:sqlite, loaded without its "experimental feature" warning on every run of the command. */
async function openMemoryDatabase(): Promise<DatabaseSync> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(":memory:");
  } finally {
    process.emitWarning = emitWarning;
  }
}

export async function createLocalDb(migrationsDir: string): Promise<LocalDb> {
  const sqlite = await openMemoryDatabase();
  for (const file of readdirSync(migrationsDir).sort()) {
    if (file.endsWith(".sql")) sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  const d1 = {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values.map(param);
          return statement;
        },
        async all() {
          const prepared = sqlite.prepare(sql);
          if (prepared.columns().length) {
            return { results: prepared.all(...params), meta: { changes: 0 } };
          }
          const { changes, lastInsertRowid } = prepared.run(...params);
          return {
            results: [],
            meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) },
          };
        },
      };
      return statement;
    },
  };
  return {
    // The dialect calls only prepare().bind().all(); the rest of D1Database is not needed here.
    db: createDb(d1 as unknown as D1Database),
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) {
          sqlite.prepare(statement.sql).run(...statement.parameters.map(param));
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => sqlite.close(),
  };
}
