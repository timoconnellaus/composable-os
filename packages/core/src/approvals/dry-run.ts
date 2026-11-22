// The dry run (ADR 0022, amended 2026-11-22): what a handler is run with when its call is
// simulated, for the approval queue, an agent's grant or an automation's test mode. A dry run
// must never cause a real effect, so the guarantee is made here, for every handler, rather than by
// each handler remembering to check `ctx.simulation`:
//
// - `write`, `recordChange` and `postActivity` are collected or discarded (as before);
// - the database handle is read-only: a statement that writes is refused when it runs (a handler
//   that writes directly would otherwise write for real), and `pipeline.crm.batch` refuses;
// - an operation the handler runs through `pipeline.invoke` is itself simulated (the pipeline's
//   test-mode path: gate evaluated, handler dry-run, nothing queued, written or sent);
// - an extension tool is not run at all (see `runsInDryRun`): its sandboxed code reaches the host
//   through its own invocations, its storage and gatekeepers, which a dry run cannot hold back.
import { type CrmDb, ReadOnlyDatabaseError } from "@composable-os/db";
import { type AnyOperation, isHostTool } from "../operation.ts";

/**
 * `crm` for a dry run: reads only. A handle built by `createCrmDb` refuses writes as they run;
 * any other (a test's wrapper) at least refuses its batch.
 */
export function readOnlyCrm(crm: CrmDb): CrmDb {
  return (
    crm.readOnly?.() ?? {
      ...crm,
      batch: async () => {
        throw new ReadOnlyDatabaseError("commit a batch");
      },
    }
  );
}

/**
 * Whether the handler of `op` may be dry-run. An extension tool's may not: it would run the
 * tool's code in its sandbox, and the tool's own operation calls, storage writes and gatekeeper
 * calls are real (they are made by the extension, outside this call's batch). Its pending action
 * then has no diff preview; the approval screen shows the tool and its inputs instead.
 */
export function runsInDryRun(op: AnyOperation): boolean {
  return !isHostTool(op);
}
