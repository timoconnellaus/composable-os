// The UI adapter for the operations registry (ADR 0003): turns a signed-in Principal plus an
// operation name and input into a pipeline invocation. Framework-free so it is tested directly in
// workerd; `call-operation.ts` wraps it in a TanStack Start server function, and `#/lib/operations`
// is the typed client. The MCP (stage 2) and host-module (stage 3) adapters follow the same shape
// with a different actor and origin.

// The screens this build holds, for screens.mine (stage 47).
import "./built-screens.ts";
import { waitUntil } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import {
  type AgentJobHost,
  type AssistantThreadStore,
  type AutomationHost,
  type EventSink,
  type ExtensionHost,
  errorForLog,
  type InvocationContext,
  invokeByName,
  OperationError,
  type Origin,
  parseFloor,
  queueEventSink,
  type RateLimitBinding,
  resolveActingUser,
  type SerializedOperationError,
  toOperationError,
  withCodeModeRateLimit,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { type AiAppEnv, aiContextFor } from "./ai.ts";
import { approvalExpiryDays } from "./approval-expiry.ts";
import type { AssistantAgent } from "./assistant/agent.ts";
import { threadStub } from "./assistant/http.ts";
import { type AgentJob, jobName } from "./assistant/job.ts";
import { clientKeyOf } from "./client-key.ts";
import { type DeskEnv, deskHostFor } from "./desk.ts";
import { hostMailFor } from "./host-mail.ts";
import { blobStoreFor, integrationRuntimeFor } from "./integrations.ts";
import { deleteGrantTokens } from "./mcp/handler.ts";
import { mediaStoreFor } from "./media.ts";
import { personCodeKeysEntry } from "./person-codes.ts";
import { runner } from "./runner.ts";
import { updaterRuntimeFor } from "./updater.ts";

export interface OperationsEnv extends AiAppEnv, DeskEnv {
  DB: D1Database;
  /** Deploy-time approval floor (ADR 0011), JSON. Empty means none. */
  APPROVAL_FLOOR?: string;
  /** Days before a pending action expires (ADR 0022). Default 7. */
  APPROVAL_EXPIRY_DAYS?: string;
  /** The packs the deployment (or the client) has: the runner installs them (ADR 0420). */
  COS_PACKS?: string;
  /** The OAuth provider's store, so revoking a connected app also deletes its tokens. */
  OAUTH_KV?: KVNamespace;
  /** cos-runner: the extension host (ADR 0025). */
  RUNNER?: Fetcher;
  /** The automation events queue (ADR 0130): committed changes start automations in cos-runner. */
  AUTOMATION_EVENTS?: Queue;
  /** Code Mode runs per user (Workers Rate Limiting, ADR 0043). */
  CODE_MODE_RATE_LIMIT?: RateLimitBinding;
  /** Synced email bodies (R2, ADR 0112). */
  BLOBS?: R2Bucket;
  /** Release (stage 8): the installed version, release repository and account (ADR 0164). */
  COS_RELEASE_VERSION?: string;
  COS_RELEASE_REPO?: string;
  COS_ACCOUNT_ID?: string;
  /** Optional scoped token for in-app updates (a secret). */
  COS_UPDATE_TOKEN?: string;
  /** Each person's assistant thread (ADR 0340): thread.* operations and erase reach it. */
  ASSISTANT?: DurableObjectNamespace<AssistantAgent>;
  /** One object per agent (ADR 0344). */
  AGENT_JOB?: DurableObjectNamespace<AgentJob>;
  /** The host's auth secret: the keys of check-in codes and PINs are derived from it (ADR 0783). */
  BETTER_AUTH_SECRET?: string;
}

/** The agents' objects as operations see them (ADR 0344). */
export function agentJobsFor(env: OperationsEnv): AgentJobHost | undefined {
  const namespace = env.AGENT_JOB;
  if (!namespace) return undefined;
  const stub = (jobId: string) => namespace.get(namespace.idFromName(jobName(jobId)));
  return {
    async begin(jobId) {
      await stub(jobId).begin(jobId);
    },
    async stop(jobId) {
      await stub(jobId).stop(jobId);
    },
    async wait(jobId, ms) {
      try {
        return await stub(jobId).wait(jobId, ms);
      } catch {
        // It restarted: it carries on by its alarm, and the card takes over.
        return false;
      }
    },
    async scrub(jobId, scrub) {
      await stub(jobId).scrub(jobId, scrub);
    },
  };
}

/**
 * The assistant threads as operations see them (ADR 0340): each person's AssistantAgent object,
 * for `thread.*` and for an erase to redact (ADR 0019 amendment).
 */
export function assistantThreadsFor(env: OperationsEnv): AssistantThreadStore | undefined {
  const namespace = env.ASSISTANT;
  if (!namespace) return undefined;
  const stub = (userId: string) => threadStub(namespace, userId);
  return {
    async search(userId, query, limit) {
      return (await stub(userId)).search(userId, query, limit);
    },
    async deleteMessage(userId, seq) {
      return (await stub(userId)).deleteMessage(userId, seq);
    },
    async markSeen(userId, seq) {
      return (await stub(userId)).markSeen(userId, seq);
    },
    async postCard(userId, part, via) {
      return (await stub(userId)).postCard(userId, part, via);
    },
    async deliverRoutine(userId, delivery) {
      return (await stub(userId)).deliverRoutine(userId, delivery);
    },
    async scrub(userId, scrub) {
      await (await stub(userId)).scrub(scrub);
    },
  };
}

/**
 * The extension runtime as seen from cos-app: cos-runner's RPC over the RUNNER service binding
 * (code runs in cos-runner's stateless entrypoint; git and builds in its workspace DO), with Code
 * Mode's per-user rate limit applied here, where the binding lives.
 */
export function extensionHostFor(env: OperationsEnv): ExtensionHost | undefined {
  if (!env.RUNNER) return undefined;
  const host = runner({ RUNNER: env.RUNNER }) as unknown as ExtensionHost;
  return withCodeModeRateLimit(rpcHost(host), env.CODE_MODE_RATE_LIMIT);
}

/**
 * The automation wiring for an invocation (ADR 0130): committed record changes go to the
 * AUTOMATION_EVENTS queue, and automation.test / run / retry / replay / cancel reach cos-runner.
 */
export function automationWiring(env: OperationsEnv): {
  events?: EventSink;
  automationHost?: AutomationHost;
} {
  const out: { events?: EventSink; automationHost?: AutomationHost } = {};
  if (env.AUTOMATION_EVENTS) out.events = queueEventSink(env.AUTOMATION_EVENTS);
  if (env.RUNNER) {
    const stub = runner({ RUNNER: env.RUNNER });
    out.automationHost = {
      testAutomation: (input) => stub.testAutomation(input),
      startManualRun: (input) => stub.startManualRun(input),
      retryRun: (runId) => stub.retryRun(runId),
      replayRun: (runId) => stub.replayRun(runId),
      cancelRun: (runId) => stub.cancelRun(runId),
    };
  }
  return out;
}

/** The RPC stub's methods as a plain object (an RPC stub cannot be spread). */
function rpcHost(stub: ExtensionHost): ExtensionHost {
  return {
    commit: (input) => stub.commit(input),
    shipped: () => stub.shipped(),
    commitShipped: (id) => stub.commitShipped(id),
    evaluate: (input) => stub.evaluate(input),
    runTool: (input) => stub.runTool(input),
    versions: (id) => stub.versions(id),
    files: (id, commit) => stub.files(id, commit),
    listWorkspace: () => stub.listWorkspace(),
    workingCopy: (id, options) => stub.workingCopy(id, options),
    writeFiles: (input) => stub.writeFiles(input),
    commitWorkingCopy: (input) => stub.commitWorkingCopy(input),
    eject: (id) => stub.eject(id),
    runCode: (input) => stub.runCode(input),
    runProducer: (input) => stub.runProducer(input),
    describeChange: (input) => stub.describeChange(input),
  };
}

/**
 * The packs an explicit `COS_PACKS` list names that an install's results do not mention: the
 * runner installed from another list. None for "*" or no list (the release's own packs).
 */
export function packsNotInstalled(
  packs: string | undefined,
  results: readonly { id: string }[],
): string[] {
  const value = packs?.trim();
  if (!value || value === "*") return [];
  const seen = new Set(results.map((r) => r.id));
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id && !seen.has(id));
}

/**
 * How long a call waits for its client's shipped extensions to be checked or installed before it
 * goes on without them (issue #558). When they are already installed the check is one read in
 * cos-runner and ends well inside it; a first install (seconds per pack) carries on after.
 */
export const SHIPPED_WAIT_MS = 2_000;

/**
 * An install still running after this long is not waited on again: the next call starts another.
 * Longer than the work can live: cos-app's `waitUntil` keeps its request 30 s after the response,
 * and cos-runner's own is expected (not documented) to keep the install about 30 s after that. So
 * only an install that was cut off gets here; the next one carries on from the packs
 * it finished, each committed on its own.
 */
export const SHIPPED_STALE_MS = 65_000;

interface ShippedInstall {
  done: Promise<void>;
  settled: boolean;
  startedAt: number;
}

// Once per environment (stage 66 step 5, ADR 0617): on a many-client host each client's
// environment is its own object, and each client's database needs its own install.
const shippedInstalls = new WeakMap<object, ShippedInstall>();

/** waitUntil inside a request, so the work outlives it; outside one (tests) the promise runs. */
function outlive(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    // Outside a request: the promise still runs.
  }
}

function startShippedInstall(
  binding: Fetcher,
  key: object,
  packs: string | undefined,
  keepAlive: (work: Promise<unknown>) => void,
): ShippedInstall {
  const held: ShippedInstall = { settled: false, startedAt: Date.now(), done: Promise.resolve() };
  held.done = runner({ RUNNER: binding })
    .installShipped()
    .then((results) => {
      const failed = results.filter((r) => r.outcome === "failed");
      // Not tried again in this isolate: cos-runner told the admins, and the next isolate tries.
      if (failed.length) console.error("shipped extensions failed to install", failed);
      // The runner read an older registry than this environment (each refreshes on its own, within
      // 10 seconds): a pack just added to the client's COS_PACKS was not in its list. Not held, so
      // the next request installs it (stage 66 step 9).
      if (packsNotInstalled(packs, results).length) {
        if (shippedInstalls.get(key) === held) shippedInstalls.delete(key);
        return;
      }
      held.settled = true;
    })
    .catch((error: unknown) => {
      console.error("could not install shipped extensions", error);
      // Only its own entry: a later call may have started another after this one went stale.
      if (shippedInstalls.get(key) === held) shippedInstalls.delete(key);
    });
  shippedInstalls.set(key, held);
  keepAlive(held.done);
  return held;
}

/**
 * Checks the shipped extensions bundled with this release once per isolate (and client), and
 * installs them through `extension.install` in cos-runner when they are not (ADR 0025, issue
 * #558). Calls wait for that at most `waitMs` after it started, and then go on: core operations
 * run as usual, and one that needs a pack not installed yet answers `stillInstalling`
 * (retryable). The install runs under the request that started it (`waitUntil`), so a request
 * that ends or is cancelled does not stop it; one that fails, or has run longer than `staleMs`
 * (its request was ended under it), is started again by the next call.
 */
export async function ensureShippedExtensions(
  env: OperationsEnv,
  {
    waitMs = SHIPPED_WAIT_MS,
    staleMs = SHIPPED_STALE_MS,
    keepAlive = outlive,
  }: {
    waitMs?: number;
    staleMs?: number;
    /** What keeps the install alive past the request: `waitUntil` (tests watch it). */
    keepAlive?: (work: Promise<unknown>) => void;
  } = {},
): Promise<void> {
  if (!env.RUNNER) return;
  const key = clientKeyOf(env);
  let held = shippedInstalls.get(key);
  if (held?.settled) return;
  if (!held || Date.now() - held.startedAt >= staleMs) {
    held = startShippedInstall(env.RUNNER, key, env.COS_PACKS, keepAlive);
  }
  // Waited on only in the bound's first moments after it started: once it has run longer, calls
  // go on at once, rather than each adding the bound while a first install runs.
  const remaining = held.startedAt + waitMs - Date.now();
  if (remaining <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    held.done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    }),
  ]);
  clearTimeout(timer);
}

/** Tests only: forgets this isolate's check or install for `env`'s client. */
export function forgetShippedInstall(env: OperationsEnv): void {
  shippedInstalls.delete(clientKeyOf(env));
}

/** Whether this client's shipped extensions are still being checked or installed here. */
export function shippedInstallPending(env: OperationsEnv): boolean {
  if (!env.RUNNER) return false;
  const held = shippedInstalls.get(clientKeyOf(env));
  return Boolean(held && !held.settled);
}

/** What a call answers while its client's packs are still being installed (issue #558). */
export function stillInstalling(): OperationError {
  return new OperationError(
    "timeout",
    "This host is still installing its packs: try again in a few seconds",
    { installing: true, retryAfterSeconds: 5, httpStatus: 503 },
  );
}

/**
 * Whether a call names something a pack owns: an extension tool (`x.<extension>.<tool>`) or an
 * extension's object (`<extension>.<object>`; core's objects have no dot: person, organisation,
 * activity, task), as a record operation's `object`.
 */
export function namesPack(name: string, input: unknown): boolean {
  if (name.startsWith("x.")) return true;
  const object = (input as { object?: unknown } | null | undefined)?.object;
  return typeof object === "string" && object.includes(".");
}

/**
 * While this client's packs are still being installed, a call that names a pack's tool or object
 * and is refused as not there (`unknown_operation`, `invalid_input`, `not_found`) answers
 * `stillInstalling` instead: tried again once the install has finished, it gets its real answer.
 * Every other call's errors, core operations' included, and every error once the install has
 * finished, are the operation's own.
 */
export function duringShippedInstall(
  env: OperationsEnv,
  error: unknown,
  name: string,
  input?: unknown,
): unknown {
  if (!shippedInstallPending(env) || !namesPack(name, input)) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "unknown_operation" || code === "invalid_input" || code === "not_found") {
    return stillInstalling();
  }
  return error;
}

/** Plain JSON: what operation outputs are once serialised. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What crosses the wire: never a thrown error, so codes and details survive serialisation. */
export type OperationResult =
  | { ok: true; data: Json }
  | {
      ok: false;
      error: Omit<SerializedOperationError, "details"> & { details?: Json };
    };

/** Normalises a result to plain JSON (drops undefined, stringifies dates). */
export function toWire(
  result: { ok: true; data: unknown } | { ok: false; error: SerializedOperationError },
): OperationResult {
  return JSON.parse(JSON.stringify(result)) as OperationResult;
}

export interface OperationCall {
  name: string;
  input: unknown;
}

/** Validates the untyped payload a server function receives. */
export function parseOperationCall(payload: unknown): OperationCall {
  if (!payload || typeof payload !== "object") throw new Error("Expected { name, input }");
  const { name, input } = payload as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 100) throw new Error("Expected an operation name");
  return { name, input: input ?? {} };
}

/**
 * The context of a signed-in person's call (actor `human`): the UI's server functions (origin
 * `ui`) and the HTTP surface (origin `client`, src/server/http/api.ts) build it the same way, so
 * a call takes the same pipeline with the same capabilities from either.
 */
export async function staffContext(
  env: OperationsEnv,
  principal: Principal,
  origin: Origin,
  /** The request's origin: where integration connect popups are handed back. */
  appOrigin?: string,
): Promise<InvocationContext> {
  await ensureShippedExtensions(env);
  const db = createCrmDb(env.DB);
  const extensionHost = extensionHostFor(env);
  const integrations = integrationRuntimeFor(env, appOrigin);
  const blobs = blobStoreFor(env);
  const media = mediaStoreFor(env);
  const assistantThreads = assistantThreadsFor(env);
  const agentJobs = agentJobsFor(env);
  return {
    ...(integrations ? { integrations } : {}),
    ...(blobs ? { blobs } : {}),
    ...(media ? { media } : {}),
    actor: "human",
    user: await resolveActingUser(db, principal),
    origin,
    db,
    floor: parseFloor(env.APPROVAL_FLOOR),
    ...(extensionHost ? { extensionHost } : {}),
    ...automationWiring(env),
    ...(assistantThreads ? { assistantThreads } : {}),
    ...(agentJobs ? { agentJobs } : {}),
    updater: updaterRuntimeFor(env),
    // The host's own mail for staff (ADR 0455): the invite notice.
    hostMail: hostMailFor(env, appOrigin),
    // Desk signing and enrolled devices (ADRs 0649 and 0780): the secret and where the desk is.
    ...(deskHostFor(env, appOrigin) ? { desk: deskHostFor(env, appOrigin) } : {}),
    // Check-in codes, cards and PINs (stage 51, ADR 0783).
    ...personCodeKeysEntry(env),
    ...aiContextFor(env, db),
    approvalExpiryDays: approvalExpiryDays(env.APPROVAL_EXPIRY_DAYS),
  };
}

/** Runs one operation for a UI caller (actor `human`, origin `ui`). */
export async function runOperation(
  env: OperationsEnv,
  principal: Principal | null,
  call: OperationCall,
  /** The request's origin: where integration connect popups are handed back. */
  appOrigin?: string,
): Promise<OperationResult> {
  if (!principal) {
    return { ok: false, error: { code: "forbidden", message: "Sign in to continue" } };
  }
  try {
    const ctx = await staffContext(env, principal, { surface: "ui" }, appOrigin);
    const data = await invokeByName(call.name, call.input, ctx);
    if (call.name === "connectedApp.revoke" && env.OAUTH_KV) {
      // Core marks the connection revoked, which already stops it; also delete its tokens.
      const revoked = data as { grantId: string | null; userId: string };
      await deleteGrantTokens({ ...env, OAUTH_KV: env.OAUTH_KV }, revoked.grantId, revoked.userId);
    }
    return toWire({ ok: true, data });
  } catch (error) {
    const typed = toOperationError(duringShippedInstall(env, error, call.name, call.input));
    if (typed.code === "internal" || typed.code === "config") {
      // Log-safe: the error can quote record content (ADR 0320).
      console.error(`operation ${call.name} failed`, errorForLog(error));
      // Internal details stay in the logs.
      return { ok: false, error: { code: typed.code, message: typed.message } };
    }
    return toWire({ ok: false, error: typed.toJSON() });
  }
}
