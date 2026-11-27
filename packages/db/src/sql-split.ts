// A migration file's SQL as its statements (stage 66 step 7, ADR 0618): what `cos` sends the
// operator's Worker to migrate a client's database, from the release bundle's migration files, in
// the shape `applyMigrations` takes (`Migration.queries`). Split at each `;` outside a string, an
// identifier, a comment and a trigger's body. A statement keeps its own comments (SQLite keeps
// them in the schema's text, as D1 does when a whole file is sent), and a run of only comments
// and space is no statement. packages/db/test/sql-split.test.ts checks every migration of the
// repository against `readD1Migrations` (the schema each makes is the same).
import type { Migration } from "./migrate.ts";

/** `sql` without its comments. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "");
}

/** The statements of `sql`, each without its `;` and trimmed. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let words: string[] = [];
  let i = 0;
  const flush = () => {
    const text = current.trim();
    if (text && withoutComments(text).trim()) out.push(text);
    current = "";
    depth = 0;
    words = [];
  };
  const isTrigger = () => {
    const head = words.slice(0, 3).map((w) => w.toUpperCase());
    return (
      head[0] === "CREATE" &&
      (head[1] === "TRIGGER" || (/^TEMP(ORARY)?$/.test(head[1] ?? "") && head[2] === "TRIGGER"))
    );
  };
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j += 1;
      const word = sql.slice(i, j);
      words.push(word);
      if (isTrigger()) {
        const upper = word.toUpperCase();
        if (upper === "BEGIN" || upper === "CASE") depth += 1;
        else if (upper === "END" && depth > 0) depth -= 1;
      }
      current += word;
      i = j;
      continue;
    }
    if (ch === ";" && depth === 0) {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return out;
}

/** A migration file as `applyMigrations` takes it. */
export function migrationOf(name: string, sql: string): Migration {
  return { name, queries: splitSqlStatements(sql) };
}
