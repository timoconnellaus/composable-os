// What a call runs on D1: every statement's bound variables. The local runtime enforces neither
// D1's 1,000 statements per invocation nor, for every statement shape, its 100 bound variables per
// statement, so a test that must stay inside them counts them through this binding.

import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";

export interface StatementMeter {
  /** The database to hand to `context(…, { db })`: every statement through it is counted. */
  db: ReturnType<typeof createCrmDb>;
  /** Bound variables of each statement run since the last reset, in order. */
  readonly bound: readonly number[];
  reset(): void;
}

export function meterStatements(binding: D1Database = env.DB): StatementMeter {
  let bound: number[] = [];
  const counted = new Proxy(binding, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            bound.push(values.length);
            return bind(...values);
          };
          return statement;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: createCrmDb(counted),
    get bound() {
      return bound;
    },
    reset() {
      bound = [];
    },
  };
}
