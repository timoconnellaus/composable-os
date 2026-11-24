// The dry run (ADR 0022, amended 2026-11-22): what a handler is run with when its call is
// simulated, for the approval queue, an agent's grant, an automation's test mode, and the
// operations those handlers run in turn. A dry run must never cause a real effect. The pipeline
// gives the handler a context in which effects cannot be made, rather than trusting each handler
// to check `ctx.simulation`:
//
// - `write`, `recordChange`, `recordHostChange` and `postActivity` are collected or discarded
//   (pipeline.ts);
// - the database handle is read-only (`CrmDb.readOnly()`): a statement that is not a read is
//   refused when it runs, and `pipeline.crm.batch` refuses;
// - every other runtime on the context (`dryRunHosts` below; `CONTEXT_KEYS` classifies every key
//   of the context type, so a new runtime cannot be added unguarded) answers only its read
//   methods. Anything else is refused with RunsOnApprovalError before it reaches the runtime, and
//   the queued call is marked "runs on approval" instead of carrying a preview;
// - an operation the handler runs through `pipeline.invoke` is itself simulated (pipeline.ts);
// - an extension tool that may write is not run at all (`runsInDryRun`): its sandboxed code
//   reaches the host through its own invocations, storage and gatekeepers. A read tool runs with
//   a read-only sandbox whose calls are simulated too (apps/runner executor/host.ts).
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

/**
 * Every key of the handler context, classified. The type checker holds this to `HandlerContext`:
 * adding a key without classifying it here fails to compile, and every key classified `runtime`
 * must have an entry in `RUNTIMES`.
 * - `database`: replaced in a dry run by a read-only handle or a collector (pipeline.ts);
 * - `runtime`: guarded in a dry run (`dryRunHosts`);
 * - `data`: values and read-only lookups that cannot act.
 */
const CONTEXT_KEYS = {
  operation: "data",
  actor: "data",
  user: "data",
  principal: "data",
  onBehalfOf: "data",
  origin: "data",
  now: "data",
  auditId: "data",
  db: "database",
  floor: "data",
  grantedPermissions: "data",
  permissionGrants: "data",
  roleToday: "data",
  roleLooksAfter: "data",
  markStanding: "data",
  markGiven: "data",
  reason: "data",
  approval: "data",
  records: "database",
  // Reads the caller's own sign-in address: a lookup, not an effect.
  signIn: "data",
  write: "database",
  // Queues writes at the end of the call (stage 45): a simulated call has none (readOnlyContext).
  beforeCommit: "database",
  recordChange: "database",
  recordHostChange: "database",
  postActivity: "database",
  afterCommit: "data",
  simulation: "data",
  pipeline: "database",
  extensionHost: "runtime",
  extension: "data",
  integrations: "runtime",
  blobs: "runtime",
  media: "runtime",
  // The bytes a person uploaded with the request: data the handler is given, not a store.
  upload: "data",
  models: "runtime",
  judge: "runtime",
  personsWords: "data",
  assistantTurn: "data",
  widgetCache: "runtime",
  updater: "runtime",
  vectors: "runtime",
  aiAdmin: "runtime",
  // The raw AI binding (refused whole) beside settings and secrets (strings, which cannot act).
  aiEnv: "runtime",
  events: "runtime",
  automationHost: "runtime",
  assistantThreads: "runtime",
  voice: "runtime",
  agentJobs: "runtime",
  hostMail: "runtime",
  // The desk's secret and origin (ADR 0649): configuration the handler is given, not a store.
  desk: "data",
  // Key arithmetic only (an HMAC, sealing and opening a secret): it cannot act (ADR 0783).
  personCodes: "data",
} as const satisfies Record<keyof HandlerContext, "database" | "runtime" | "data">;

type RuntimeKey = {
  [K in keyof typeof CONTEXT_KEYS]: (typeof CONTEXT_KEYS)[K] extends "runtime" ? K : never;
}[keyof typeof CONTEXT_KEYS];

/**
 * Per runtime: what it is called in a note, and the methods a dry run may call (reads). Nothing
 * that runs a model answers (spend is not a read): a read that needs a model is not run in a dry
 * run or in test mode. A gatekeeper call is never run either (`integrations.call`).
 */
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
  models: { label: "an AI model", reads: ["roles"] },
  judge: { label: "the judge (an AI model)", reads: ["isOn"] },
  updater: { label: "the updater", reads: ["listReleases", "manifest", "secretsSet"] },
  vectors: { label: "the search index", reads: ["query", "getVector"] },
  aiAdmin: { label: "the AI settings", reads: ["status", "usage"] },
  aiEnv: { label: "the AI binding", reads: [] },
  events: { label: "the automation events queue", reads: [] },
  automationHost: { label: "automation runs", reads: [] },
  assistantThreads: { label: "assistant conversations", reads: ["search"] },
  voice: { label: "voice", reads: [] },
  agentJobs: { label: "agents", reads: [] },
  hostMail: { label: "the host's mail", reads: ["signInMailProblem"] },
  widgetCache: { label: "the dashboard cache", reads: ["get"] },
} as const satisfies Record<RuntimeKey, { label: string; reads: readonly string[] }>;

export type DryRunRuntime = keyof typeof RUNTIMES;

/** Every runtime a handler context can carry (CONTEXT_KEYS checks it against the type). */
export const DRY_RUN_RUNTIMES = Object.keys(RUNTIMES) as DryRunRuntime[];

/** Writes to the dashboard cache are dropped, not refused: a read that fills it still answers. */
const SILENT: Partial<Record<DryRunRuntime, readonly string[]>> = { widgetCache: ["put"] };

/** Refuses `uses`: tells `refused`, and throws. */
function refuse(uses: string, refused: (uses: string) => void): never {
  refused(uses);
  throw new RunsOnApprovalError(uses);
}

/**
 * A runtime for a dry run: its read methods answer, its plain values (flags, names) read through,
 * and any other method is refused before the runtime sees it. `refused` hears what was refused,
 * also when the handler catches the error. It never answers `then`, so awaiting it (or an RPC
 * stub behind it, which answers every name) calls nothing.
 */
function guard(runtime: DryRunRuntime, host: Host, refused: (uses: string) => void): Host {
  const { label, reads } = RUNTIMES[runtime];
  const silent = SILENT[runtime] ?? [];
  return new Proxy(host, {
    get(target, property) {
      if (property === "then") return undefined;
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if ((reads as readonly string[]).includes(property)) return value.bind(target);
      // A read tool runs in a read-only sandbox, as a dry run (its calls are simulated, and the
      // run is not recorded): it may run.
      if (runtime === "extensionHost" && property === "runTool") {
        return (input: { readOnly?: boolean }) =>
          input?.readOnly
            ? value.call(target, { ...input, dryRun: true })
            : refuse(`${label} (runTool)`, refused);
      }
      if (silent.includes(property)) return async () => undefined;
      return () => refuse(`${label} (${property})`, refused);
    },
  });
}

/** A value that refuses everything: what a binding inside `aiEnv` becomes in a dry run. */
function refusing(label: string, refused: (uses: string) => void): Host {
  return new Proxy({} as Host, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") return undefined;
      return () => refuse(`${label} (${property})`, refused);
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
    if (!host) {
      out[runtime] = undefined;
    } else if (runtime === "aiEnv") {
      // Settings and secrets are strings (they read through); a binding is refused whole.
      out[runtime] = Object.fromEntries(
        Object.entries(host as Host).map(([key, value]) => [
          key,
          value !== null && (typeof value === "object" || typeof value === "function")
            ? refusing(`${RUNTIMES.aiEnv.label} ${key}`, refused)
            : value,
        ]),
      );
    } else {
      out[runtime] = guard(runtime, host as Host, refused);
    }
  }
  return out as Partial<HandlerContext>;
}

/** Whether `error` is a dry run's refusal: nothing was done, and the call runs on approval. */
export function isDryRunRefusal(error: unknown): boolean {
  return error instanceof RunsOnApprovalError || error instanceof ReadOnlyDatabaseError;
}

/** What a simulated call answers when it could not be run (test mode, or nested in a dry run). */
export function notRunPlaceholder(operation: string, note: string) {
  return { $notRunInTestMode: true as const, operation, note };
}
