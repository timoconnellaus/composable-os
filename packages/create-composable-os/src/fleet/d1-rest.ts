// A `D1Database` over D1's REST API (stage 66 step 7, ADR 0617), so the operator's commands run
// the same registry code (`@composable-os/db/registry-writes`, `registry-sealing`) from `cos` on the
// operator's machine as the tests run on the binding.
//
// - A statement on its own is sent with its parameters, unless one is bytes: D1's REST API takes
//   only text and numbers, so bytes (a sealed secret) are written into the SQL as a hex literal,
//   `X'…'` (ADR 0616, "For step 7").
// - A batch is sent as one query of every statement with its values written in as literals: D1
//   runs a query of several statements as one batch, all or nothing, as the binding's `batch` does.
// Values written in are only ever literals (a quoted string, a number, NULL, X'…'), never SQL.
import type { CloudflareClient } from "@composable-os/release";

const STATEMENT = Symbol("statement");

type Value = string | number | boolean | null | Uint8Array | ArrayBuffer | bigint;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A value as a SQL literal. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof ArrayBuffer) return `X'${hex(new Uint8Array(value))}'`;
  if (ArrayBuffer.isView(value)) {
    return `X'${hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`;
  }
  throw new TypeError(`a value of type ${typeof value} cannot be sent to D1`);
}

/**
 * `sql` with each `?` outside a string, an identifier and a comment replaced by its value as a
 * literal, in order. Numbered (`?1`) and named (`:a`, `@a`, `$a`) parameters are refused.
 */
export function inlineParameters(sql: string, params: readonly unknown[]): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
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
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "?") {
      if (/[0-9]/.test(sql[i + 1] ?? "")) throw new Error("numbered parameters are not supported");
      if (n >= params.length) throw new Error("fewer values than parameters");
      out += sqlLiteral(params[n]);
      n += 1;
      continue;
    }
    if ((ch === ":" || ch === "@" || ch === "$") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      throw new Error("named parameters are not supported");
    }
    out += ch;
  }
  if (n !== params.length) throw new Error("more values than parameters");
  return out;
}

interface RestStatement {
  sql: string;
  params: unknown[];
}

const hasBytes = (params: unknown[]) =>
  params.some((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p));

/** A `D1Database` (the parts the registry's code uses) over D1's REST API. */
export function d1OverRest(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): D1Database {
  const send = async (statement: RestStatement) => {
    const bytes = hasBytes(statement.params);
    const sql = bytes ? inlineParameters(statement.sql, statement.params) : statement.sql;
    const params = bytes ? [] : (statement.params as (string | number | null)[]);
    for (const p of params) {
      if (typeof p === "boolean" || typeof p === "bigint") {
        return api.queryD1(
          accountId,
          databaseId,
          inlineParameters(statement.sql, statement.params),
        );
      }
    }
    return api.queryD1(accountId, databaseId, sql, params);
  };
  const shaped = (rows: Record<string, unknown>[], meta: Record<string, unknown> = {}) => ({
    success: true as const,
    results: rows,
    meta: { changes: 0, duration: 0, ...meta },
  });
  const statementOf = (sql: string, params: unknown[] = []): D1PreparedStatement => {
    const statement: RestStatement = { sql, params };
    const run = async () => {
      const [first] = (await send(statement)) as {
        results: Record<string, unknown>[];
        meta?: Record<string, unknown>;
      }[];
      return shaped(first?.results ?? [], first?.meta ?? {});
    };
    const self = {
      [STATEMENT]: statement,
      bind: (...values: Value[]) => statementOf(sql, values),
      first: async (column?: string) => {
        const row = (await run()).results[0];
        if (!row) return null;
        return column === undefined ? row : (row[column] ?? null);
      },
      all: run,
      run,
      raw: async () => (await run()).results.map((row) => Object.values(row)),
    };
    return self as unknown as D1PreparedStatement;
  };
  const database = {
    prepare: (sql: string) => statementOf(sql),
    async batch(statements: D1PreparedStatement[]) {
      const all = statements.map(
        (s) => (s as unknown as { [STATEMENT]: RestStatement })[STATEMENT],
      );
      if (all.some((s) => !s)) throw new Error("a statement of another database");
      const sql = all
        .map((s) => inlineParameters(s.sql, s.params).trim().replace(/;$/, ""))
        .join(";\n");
      const answers = (await api.queryD1(accountId, databaseId, `${sql};`)) as {
        results: Record<string, unknown>[];
        meta?: Record<string, unknown>;
      }[];
      return all.map((_, i) => shaped(answers[i]?.results ?? [], answers[i]?.meta ?? {}));
    },
    async exec(sql: string) {
      await api.queryD1(accountId, databaseId, sql);
      return { count: 1, duration: 0 };
    },
  };
  return database as unknown as D1Database;
}
