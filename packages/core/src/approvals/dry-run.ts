// The dry run (ADR 0022, amended 2026-11-22): what a handler is run with when its call is
// simulated, for the approval queue, an agent's grant, an automation's test mode, and the
// operations those handlers run in turn. A dry run must never cause a real effect. The pipeline
// gives the handler a context in which effects cannot be made, rather than trusting each handler
// to check `ctx.simulation`:
//
// - `write`, `recordChange` and `postActivity` are collected or discarded (pipeline.ts);
// - the database handle is read-only (`CrmDb.readOnly()`): a statement that is not a read is
//   refused when it runs, and `pipeline.crm.batch` refuses;
// - every other runtime on the context (`dryRunHosts` below: the extension host, the integration
//   host, stores, models, the judge, the updater, mail, queues, the automation host, threads,
//   agents, voice, AI settings, the search index, the dashboard cache) answers only its read
//   methods. Anything else is refused with RunsOnApprovalError before it reaches the runtime, and
//   the queued call is marked "runs on approval" instead of carrying a preview;
// - an operation the handler runs through `pipeline.invoke` is itself simulated (pipeline.ts);
// - an extension tool that may write is not run at all (`runsInDryRun`): its sandboxed code
//   reaches the host through its own invocations, storage and gatekeepers. A read tool runs with
//   a read-only sandbox (apps/runner executor/host.ts).
//
// The guarantee is these wrappers. The `ctx.simulation` checks some handlers still make (media,
// erasure, extension installs, the tool handler) are what make their preview useful, not what
// keeps them safe.
import { type CrmDb, ReadOnlyDatabaseError } from "@composable-os/db";
import { RunsOnApprovalError } from "../errors.ts";
import { type AnyOperation, type HandlerContext, isHostTool } from "../operation.ts";

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
 * Whether the handler of `op` may be dry-run. An extension tool that may write may not: it would
 * run the tool's code in its sandbox, and the tool's own operation calls, storage writes and
 * gatekeeper calls are real (made by the extension, outside this call's batch). Its pending action
 * has no diff preview; the approval screen shows the tool and its inputs instead.
 */
export function runsInDryRun(op: AnyOperation): boolean {
  return !isHostTool(op) || op.risk === "read";
}

type Host = Record<string, unknown>;

/** Per runtime: what it is called in a note, and the methods a dry run may call (reads). */
const RUNTIMES = {
  extensionHost: {
    label: "the extension host",
    reads: ["shipped", "versions", "files", "listWorkspace", "workingCopy"],
  },
  integrations: {
    label: "a connected app",
    reads: ["availableVendors", "supportedResources", "types"],
  },
  blobs: { label: "stored email bodies", reads: ["get", "list"] },
  media: { label: "media storage", reads: ["get"] },
  models: { label: "an AI model", reads: ["roles", "embed"] },
  judge: { label: "the judge (an AI model)", reads: ["isOn"] },
  updater: { label: "the updater", reads: ["listReleases", "manifest", "secretsSet"] },
  vectors: { label: "the search index", reads: ["query", "getVector"] },
  aiAdmin: { label: "the AI settings", reads: ["status", "usage"] },
  events: { label: "the automation events queue", reads: [] },
  automationHost: { label: "automation runs", reads: [] },
  assistantThreads: { label: "assistant conversations", reads: ["search"] },
  voice: { label: "voice", reads: [] },
  agentJobs: { label: "agents", reads: [] },
  hostMail: { label: "the host's mail", reads: ["signInMailProblem"] },
  widgetCache: { label: "the dashboard cache", reads: ["get"] },
} as const satisfies Record<string, { label: string; reads: readonly string[] }>;

export type DryRunRuntime = keyof typeof RUNTIMES;

/** Every runtime a handler context can carry, so a test can check none is left unguarded. */
export const DRY_RUN_RUNTIMES = Object.keys(RUNTIMES) as DryRunRuntime[];

/** Writes to the dashboard cache are dropped, not refused: a read that fills it still answers. */
const SILENT: Partial<Record<DryRunRuntime, readonly string[]>> = { widgetCache: ["put"] };

/**
 * A runtime for a dry run: its read methods answer, its other properties (flags, names) read
 * through, and any other method is refused before the runtime sees it. `refused` hears what was
 * refused, also when the handler catches the error.
 */
function guard(runtime: DryRunRuntime, host: Host, refused: (uses: string) => void): Host {
  const { label, reads } = RUNTIMES[runtime];
  const silent = SILENT[runtime] ?? [];
  return new Proxy(host, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || typeof property !== "string") return value;
      if ((reads as readonly string[]).includes(property)) return value.bind(target);
      // A read tool runs in a read-only sandbox (its writes are refused there): it may run.
      if (runtime === "extensionHost" && property === "runTool") {
        return (input: { readOnly?: boolean }) => {
          if (input?.readOnly) return value.call(target, { ...input, dryRun: true });
          refused(`${label} (runTool)`);
          throw new RunsOnApprovalError(`${label} (runTool)`);
        };
      }
      if (silent.includes(property)) return async () => undefined;
      return () => {
        const uses = `${label} (${property})`;
        refused(uses);
        throw new RunsOnApprovalError(uses);
      };
    },
  });
}

/** The runtimes of `ctx`, each guarded for a dry run. Absent ones stay absent. */
export function dryRunHosts(
  ctx: HandlerContext,
  refused: (uses: string) => void,
): Partial<HandlerContext> {
  const out: Record<string, unknown> = {};
  for (const runtime of DRY_RUN_RUNTIMES) {
    const host = (ctx as unknown as Record<string, unknown>)[runtime];
    out[runtime] = host ? guard(runtime, host as Host, refused) : undefined;
  }
  return out as Partial<HandlerContext>;
}

/** Whether `error` is a dry run's refusal: nothing was done, and the call runs on approval. */
export function isDryRunRefusal(error: unknown): boolean {
  return error instanceof RunsOnApprovalError || error instanceof ReadOnlyDatabaseError;
}
