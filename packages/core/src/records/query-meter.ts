// What a path costs against D1's limit of 1,000 queries a Worker invocation (ADR 0841): every
// statement executed on its own counts one, and a batch counts one however many statements it
// holds (Cloudflare's D1 limits). The minute cron meters its timed moves with it, and tests
// measure what a cascade's followers cost.
import type { CrmDb } from "@composable-os/db";
import type { KyselyPlugin } from "kysely";

export interface QueryMeter {
  /** The handle to run the path on: every query through it is counted. */
  readonly db: CrmDb;
  /** Queries since the meter was made or last reset. */
  readonly queries: number;
  /** Statements sent in batches since then (not D1's count: for the batch's own size). */
  readonly batchStatements: number;
  reset(): void;
}

export function meterQueries(db: CrmDb): QueryMeter {
  let queries = 0;
  let batchStatements = 0;
  const counter: KyselyPlugin = {
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      queries += 1;
      return args.result;
    },
  };
  const metered: CrmDb = {
    ...db,
    query: db.query.withPlugin(counter),
    async batch(statements) {
      if (statements.length) {
        queries += 1;
        batchStatements += statements.length;
      }
      return db.batch(statements);
    },
  };
  return {
    db: metered,
    get queries() {
      return queries;
    },
    get batchStatements() {
      return batchStatements;
    },
    reset() {
      queries = 0;
      batchStatements = 0;
    },
  };
}
