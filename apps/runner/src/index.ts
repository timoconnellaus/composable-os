// cos-runner entrypoint. cos-app calls it over the RUNNER service binding using RPC: liveness, the
// stage 0 Workflow, and the extension host. Since ADR 0043 the host is split: code runs here, in
// the stateless entrypoint (the executor: tools, manifest evaluation, type checks, Code Mode), so
// runs proceed in parallel; git, working copies and the build cache stay in the workspace DO.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AutomationQueueMessage,
  type AutomationTestInput,
  type AutomationTestReport,
  CATALOGUE,
  type CodeResult,
  type EvaluateResult,
  type ExtensionHost,
  type ExtensionVersion,
  errorForLog,
  type IntegrationRuntime,
  installShippedExtensions,
  loadAutomationSettings,
  type ProducerResult,
  type ProducerRun,
  parseFloor,
  queueEventSink,
  type RunToolInput,
  type RunToolResult,
  releaseWaitingRoutineMessages,
  retryOutbox,
  runAckDue,
  runAgreementsDue,
  runChecklistDue,
  runDuplicateCron,
  runPayoutsDue,
  runPublishDue,
  runRecurringDue,
  runReindexDue,
  runStaffingDue,
  runTimedMovesDue,
  runWaitlistDue,
  type ShippedExtension,
  type ShippedInstallResult,
  type StartRunInput,
  sendAgreementCopies,
  sendReadyTexts,
  vendorBinding,
  type WorkingCopy,
  type WorkingCopyOptions,
  type WorkspaceEntry,
  type WorkspaceWrite,
  watchSubscriberSignup,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { RUNNER_METHODS } from "@composable-os/db/client-bindings";
import {
  clientEnvironment,
  consumeByClient,
  consumeDeadLetters,
  consumeFanOut,
  consumeParked,
  fanOutCron,
  isDeadLetterQueue,
  isFanOutQueue,
  isParkingQueue,
  isRunnerCaller,
  NoClientError,
  servesManyClients,
} from "@composable-os/db/client-entries";
import { envNameUse, refuseFakeGatekeeper } from "@composable-os/db/client-environment";
import { PRODUCT_LABEL_VAR, setProductLabel } from "@composable-os/product";
import { dispatchAutomationMessages, runDeferredDue } from "./automations/dispatch.ts";
import { automationHost } from "./automations/host.ts";
import { pollIntegrationEvents } from "./automations/integration-events.ts";
import { runAutomationCron } from "./automations/schedule.ts";
import { inClientScope, provideRunnerClientScope } from "./client-scope.ts";
import { deploymentEnv as workerEnv } from "./deployment-env.ts";
import { Executor, type ExecutorOptions } from "./executor/executor.ts";
import { embedFromEvents } from "./extensions/embeddings.ts";
import { packsProblem } from "./extensions/shipped-list.ts";
import type { HelloOutput } from "./hello-workflow.ts";
import { fakeProviderFetch, seedInboxMessage } from "./integrations/fake.ts";
import { runOrdersTick } from "./integrations/payments.ts";
import { availableVendors, integrationRuntime } from "./integrations/runtime.ts";
import { runNotificationCron } from "./notifications/deliver.ts";
import type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

// What core keeps at module level, kept per client on a many-client host (stage 66 step 5).
provideRunnerClientScope(workerEnv);

// A client product's label (issue #155), for the notifications and pages the runner sends.
setProductLabel((workerEnv as unknown as Record<string, string | undefined>)[PRODUCT_LABEL_VAR]);

// A pack the deploy named and this release does not carry is said at boot, in the logs, and by
// ping (so /api/health is degraded), never dropped in silence (shipped-list.ts).
const bootPacksProblem = packsProblem(
  (workerEnv as unknown as Record<string, string | undefined>).COS_PACKS,
);
if (bootPacksProblem) console.error(`cos-runner: ${bootPacksProblem}`);

export { ParkingLedger } from "@composable-os/db/client-parking";
export {
  type AutomationRunParams,
  type CandidateOrigin,
  chainKey,
  dispatchAutomationMessages,
  type StartResult,
  startRuns,
} from "./automations/dispatch.ts";
export { AutomationWorkflow } from "./automations/workflow.ts";
export { CodeModeGate } from "./executor/code-gate.ts";
export { ExtensionWorkspace } from "./extensions/workspace.ts";
export { HelloWorkflow } from "./hello-workflow.ts";
export { ConnectCallback, HostHookInitiator } from "./integrations/entrypoints.ts";
export {
  FakeAccount,
  FakeGatekeeper,
  FakeGatekeeperVendor,
  FakeHookController,
  FakeProvider,
  FakeUser,
  FakeVerifier,
} from "./integrations/fake.ts";
export { IntegrationHost, PaymentSink } from "./integrations/host.ts";
export type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

/** The deployment's one extension workspace: git, working copies, the build cache. */
export function extensionWorkspace(
  env: Env,
): DurableObjectStub<import("./extensions/workspace.ts").ExtensionWorkspace> {
  return env.EXTENSION_WORKSPACE.getByName("workspace");
}

/**
 * The extension host: execution in this isolate (the executor), storage in the workspace DO.
 * `options` is for tests (a counting loader, short timeouts).
 */
export function extensionHost(env: Env, options: ExecutorOptions = {}): ExtensionHost {
  const ws = () => extensionWorkspace(env);
  const executor = new Executor(env, options);
  return {
    commit: (input) => ws().commit(input),
    shipped: () => ws().shipped(),
    commitShipped: (id) => ws().commitShipped(id),
    evaluate: (input) => executor.evaluate(input),
    runTool: (input) => executor.runTool(input),
    versions: (id) => ws().versions(id),
    files: (id, commit) => ws().files(id, commit),
    listWorkspace: () => ws().listWorkspace(),
    workingCopy: (id, opts) => ws().workingCopy(id, opts),
    writeFiles: (input) => ws().writeFiles(input),
    commitWorkingCopy: (input) => ws().commitWorkingCopy(input),
    eject: (id) => ws().eject(id),
    runCode: (input) => executor.runCode(input),
    runProducer: (input) => executor.runProducer(input),
    describeChange: (input) => executor.describeChange(input),
  };
}

/**
 * The runner's RPC methods, on one environment: the real `env` of a single-client deployment, or
 * one client's on a many-client host (stage 66, ADR 0615). `Runner` serves them as itself on a
 * single client, and through `callAs(<client>, …)` on many.
 */
export class ClientRunner implements RunnerRpc {
  readonly #env: Env;
  /** The runner's own `env`: only for the fake gatekeeper, which is a gatekeeper, not a client. */
  readonly #host: Env;

  constructor(env: Env, host: Env) {
    this.#env = env;
    this.#host = host;
  }

  async ping(): Promise<PingResult> {
    const problem = packsProblem(this.#env.COS_PACKS);
    if (problem) {
      console.error(`cos-runner: ${problem}`);
      throw new Error(problem);
    }
    return { ok: true, worker: "cos-runner", time: new Date().toISOString() };
  }

  async startHelloWorkflow(name: string): Promise<{ id: string }> {
    const instance = await this.#env.HELLO_WORKFLOW.create({ params: { name } });
    return { id: instance.id };
  }

  async helloWorkflowStatus(id: string): Promise<WorkflowRunStatus> {
    const instance = await this.#env.HELLO_WORKFLOW.get(id);
    const status = await instance.status();
    return {
      id,
      status: status.status,
      output: (status.output as HelloOutput | undefined) ?? null,
      error: status.error ? `${status.error.name}: ${status.error.message}` : null,
    };
  }

  // ExtensionHost (ADR 0025, ADR 0043).
  commit(input: Parameters<ExtensionHost["commit"]>[0]) {
    return extensionHost(this.#env).commit(input);
  }
  shipped(): Promise<ShippedExtension[]> {
    return extensionHost(this.#env).shipped();
  }
  commitShipped(id: string) {
    return extensionHost(this.#env).commitShipped(id);
  }
  evaluate(input: Parameters<ExtensionHost["evaluate"]>[0]): Promise<EvaluateResult> {
    return extensionHost(this.#env).evaluate(input);
  }
  runTool(input: RunToolInput): Promise<RunToolResult> {
    return extensionHost(this.#env).runTool(input);
  }
  versions(id: string): Promise<ExtensionVersion[]> {
    return extensionHost(this.#env).versions(id);
  }
  files(id: string, commit: string): Promise<Record<string, string>> {
    return extensionHost(this.#env).files(id, commit);
  }
  listWorkspace(): Promise<WorkspaceEntry[]> {
    return extensionHost(this.#env).listWorkspace();
  }
  workingCopy(id: string, options?: WorkingCopyOptions): Promise<WorkingCopy> {
    return extensionHost(this.#env).workingCopy(id, options);
  }
  writeFiles(input: Parameters<ExtensionHost["writeFiles"]>[0]): Promise<WorkspaceWrite> {
    return extensionHost(this.#env).writeFiles(input);
  }
  commitWorkingCopy(input: Parameters<ExtensionHost["commitWorkingCopy"]>[0]) {
    return extensionHost(this.#env).commitWorkingCopy(input);
  }
  eject(id: string): Promise<WorkspaceWrite> {
    return extensionHost(this.#env).eject(id);
  }
  runCode(input: Parameters<ExtensionHost["runCode"]>[0]): Promise<CodeResult> {
    return extensionHost(this.#env).runCode(input);
  }
  runProducer(input: ProducerRun): Promise<ProducerResult> {
    return extensionHost(this.#env).runProducer(input);
  }
  describeChange(input: Parameters<ExtensionHost["describeChange"]>[0]) {
    return extensionHost(this.#env).describeChange(input);
  }

  /** Installs or upgrades the shipped extensions bundled with this release (boot / deploy). */
  async installShipped(): Promise<ShippedInstallResult[]> {
    return installShippedExtensions({
      db: createCrmDb(this.#env.DB),
      host: extensionHost(this.#env),
      floor: parseFloor(this.#env.APPROVAL_FLOOR),
    });
  }

  // Integrations (ADR 0050, ADR 0110): the IntegrationRuntime port for cos-app, one method.
  integration<K extends keyof IntegrationRuntime>(
    method: K,
    input: Parameters<NonNullable<IntegrationRuntime[K]>>[0],
  ): ReturnType<NonNullable<IntegrationRuntime[K]>> {
    const runtime = integrationRuntime(this.#env);
    if (!Object.hasOwn(runtime, method)) throw new Error(`No integration method ${String(method)}`);
    return (runtime[method] as (i: typeof input) => ReturnType<NonNullable<IntegrationRuntime[K]>>)(
      input,
    );
  }

  /** cos-app proxies /gatekeeper/<vendor>/* here: OAuth redirects, connect pages, pushes. */
  async gatekeeperFetch(vendor: string, request: Request): Promise<Response> {
    if (vendor === "fake") {
      if (this.#env.INTEGRATIONS_FAKE_PROVIDER !== "true")
        return new Response("Not found", { status: 404 });
      // Development and e2e only, like the rest of the fake provider: run the minute cron now
      // (local dev has no cron ticks), so a test can turn stored webhook events into runs.
      if (new URL(request.url).pathname === "/gatekeeper/fake/cron" && request.method === "POST") {
        return Response.json(await minuteTick(this.#env, new Date()));
      }
      // A message to the shared inbox (stage 36), as the inbound email hook (step 2) will write
      // one, so a test can open the inbox's screens on a real conversation.
      if (new URL(request.url).pathname === "/gatekeeper/fake/inbox" && request.method === "POST") {
        return seedInboxMessage(this.#env, request);
      }
      // The fake provider's own pages are a gatekeeper's, on the runner's own environment.
      return fakeProviderFetch(this.#host, request);
    }
    if (!availableVendors(this.#env).includes(vendor)) {
      return new Response("Not found", { status: 404 });
    }
    const binding = (this.#env as unknown as Record<string, Fetcher>)[vendorBinding(vendor)];
    return binding ? binding.fetch(request) : new Response("Not found", { status: 404 });
  }

  // AutomationHost (ADR 0130): automation.test, run, retry, replay and cancel from cos-app.
  testAutomation(input: AutomationTestInput): Promise<AutomationTestReport> {
    return automationHost(this.#env).testAutomation(input);
  }
  startManualRun(input: StartRunInput): Promise<{ runIds: string[]; skipped: number }> {
    return automationHost(this.#env).startManualRun(input);
  }
  retryRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.#env).retryRun(runId);
  }
  replayRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.#env).replayRun(runId);
  }
  cancelRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.#env).cancelRun(runId);
  }
}

/** The queue of automation events (wrangler.jsonc's consumer). */
const AUTOMATION_EVENTS_QUEUE = "cos-automation-events";

/**
 * The automation events consumer (ADR 0130) on one environment: a batch at a time. A failed
 * batch is retried (and dead-lettered after max_retries); run creation is idempotent, so a retry
 * never doubles.
 */
async function consumeAutomationEvents(
  env: Env,
  batch: MessageBatch<AutomationQueueMessage>,
): Promise<void> {
  try {
    const messages = batch.messages.map((m) => m.body);
    await dispatchAutomationMessages(env, messages);
    // Semantic search: embed the records this batch changed (ADR 0154). Never throws.
    await embedFromEvents(env, messages);
    batch.ackAll();
  } catch (error) {
    console.error("automation events: batch failed, retrying", errorForLog(error));
    batch.retryAll({ delaySeconds: 10 });
  }
}

/**
 * cos-runner's entry. Only the host's own Workers reach it: it has no public route (`workers_dev`
 * off, no routes), and cos-app is bound to it. On a single-client deployment its methods run on
 * its own `env`, as always. On a many-client host (stage 66, ADR 0615) every call names the
 * client, `callAs(<client>, <method>, args)` (cos-app's RUNNER wrapper does it), and the methods
 * on the runner itself refuse: there is no client to run them as. Its crons fan out, one message
 * per client, and its queues and Workflows act as the client stamped on each message and instance.
 */
export default class Runner extends WorkerEntrypoint<Env> implements RunnerRpc {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    // Every entry of the runner on a many-client host refuses the fake gatekeeper, whether or not
    // the call reaches the directory (which refuses it too): `gatekeeperCallback` and the fake's
    // own routes do not (ADR 0616, step 6's second review).
    if (servesManyClients(env)) refuseFakeGatekeeper(env);
  }

  /**
   * One of the runner's methods (`RUNNER_METHODS`, and no other) as `client`, in that client's
   * environment: a many-client host's only. The client is its own argument, never read from the
   * method's arguments.
   */
  async callAs(client: string, method: string, args: unknown[]): Promise<unknown> {
    if (!servesManyClients(this.env)) {
      throw new NoClientError("A client was named on a single-client deployment");
    }
    // Only cos-app's own binding, whose props the deploy fixes (review of #512, S4): a Worker
    // that binds cos-runner itself, a namespace Worker among them, has no such props, and a
    // binding's caller cannot set them.
    if (!isRunnerCaller((this.ctx as { props?: unknown }).props, this.env)) {
      throw new NoClientError("callAs is offered only to the host's own app");
    }
    if (!(RUNNER_METHODS as readonly string[]).includes(method)) {
      throw new NoClientError(`${method} is not one of the runner's methods`);
    }
    const clientEnv = await clientEnvironment(this.env, client);
    const target = new ClientRunner(clientEnv, this.env);
    const run = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof run !== "function") throw new NoClientError(`${method} is not offered`);
    return inClientScope(clientEnv, () => run.apply(target, Array.isArray(args) ? args : []));
  }

  /**
   * A gatekeeper's request at the deployment's callback address (a many-client host's only, from
   * the app's binding): its own `fetch`, whose state says whose connection it is for. Never one of
   * the gatekeepers that hold one account for every client (`ENV_NAMES`), which are offered to no
   * client; the fake one only when it is on.
   */
  async gatekeeperCallback(vendor: string, request: Request): Promise<Response> {
    if (
      !servesManyClients(this.env) ||
      !isRunnerCaller((this.ctx as { props?: unknown }).props, this.env)
    ) {
      throw new NoClientError("gatekeeperCallback is offered only to the host's own app");
    }
    const notFound = () => new Response("Not found", { status: 404 });
    if (!CATALOGUE.some((entry) => entry.vendor === vendor)) return notFound();
    const binding = vendorBinding(vendor);
    const use = envNameUse(binding);
    if (use?.use !== "shared") return notFound();
    if (vendor === "fake") {
      return this.env.INTEGRATIONS_FAKE_PROVIDER === "true"
        ? fakeProviderFetch(this.env, request)
        : notFound();
    }
    const gatekeeper = (this.env as unknown as Record<string, Fetcher | undefined>)[binding];
    return gatekeeper ? gatekeeper.fetch(request) : notFound();
  }

  /** The methods on the runner's own `env`: a single-client deployment's only. */
  #self(): ClientRunner {
    if (servesManyClients(this.env)) {
      throw new NoClientError("A many-client host's runner is called as a client: callAs(<id>, …)");
    }
    return new ClientRunner(this.env, this.env);
  }
  ping() {
    return this.#self().ping();
  }
  startHelloWorkflow(name: string) {
    return this.#self().startHelloWorkflow(name);
  }
  helloWorkflowStatus(id: string) {
    return this.#self().helloWorkflowStatus(id);
  }
  commit(input: Parameters<ExtensionHost["commit"]>[0]) {
    return this.#self().commit(input);
  }
  shipped() {
    return this.#self().shipped();
  }
  commitShipped(id: string) {
    return this.#self().commitShipped(id);
  }
  evaluate(input: Parameters<ExtensionHost["evaluate"]>[0]) {
    return this.#self().evaluate(input);
  }
  runTool(input: RunToolInput) {
    return this.#self().runTool(input);
  }
  versions(id: string) {
    return this.#self().versions(id);
  }
  files(id: string, commit: string) {
    return this.#self().files(id, commit);
  }
  listWorkspace() {
    return this.#self().listWorkspace();
  }
  workingCopy(id: string, options?: WorkingCopyOptions) {
    return this.#self().workingCopy(id, options);
  }
  writeFiles(input: Parameters<ExtensionHost["writeFiles"]>[0]) {
    return this.#self().writeFiles(input);
  }
  commitWorkingCopy(input: Parameters<ExtensionHost["commitWorkingCopy"]>[0]) {
    return this.#self().commitWorkingCopy(input);
  }
  eject(id: string) {
    return this.#self().eject(id);
  }
  runCode(input: Parameters<ExtensionHost["runCode"]>[0]) {
    return this.#self().runCode(input);
  }
  runProducer(input: ProducerRun) {
    return this.#self().runProducer(input);
  }
  describeChange(input: Parameters<ExtensionHost["describeChange"]>[0]) {
    return this.#self().describeChange(input);
  }
  installShipped() {
    return this.#self().installShipped();
  }
  integration<K extends keyof IntegrationRuntime>(
    method: K,
    input: Parameters<NonNullable<IntegrationRuntime[K]>>[0],
  ): ReturnType<NonNullable<IntegrationRuntime[K]>> {
    return this.#self().integration(method, input);
  }
  gatekeeperFetch(vendor: string, request: Request) {
    return this.#self().gatekeeperFetch(vendor, request);
  }
  testAutomation(input: AutomationTestInput) {
    return this.#self().testAutomation(input);
  }
  startManualRun(input: StartRunInput) {
    return this.#self().startManualRun(input);
  }
  retryRun(runId: string) {
    return this.#self().retryRun(runId);
  }
  replayRun(runId: string) {
    return this.#self().replayRun(runId);
  }
  cancelRun(runId: string) {
    return this.#self().cancelRun(runId);
  }

  /**
   * The runner's queues: automation events (ADR 0130) and, on a many-client host, its crons'
   * fan-out. Each automation event acts as the client its sender's wrapper stamped on it; one
   * client's failing batch is retried and nobody else's.
   */
  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    if (!servesManyClients(this.env)) {
      await consumeAutomationEvents(this.env, batch as MessageBatch<AutomationQueueMessage>);
      return;
    }
    // By the queue the batch came from, never by what a message looks like (review of #512, M1).
    if (isFanOutQueue(batch.queue)) {
      await consumeFanOut(this.env, batch, async (clientEnv, tick) => {
        await inClientScope(clientEnv, () => minuteTick(clientEnv, new Date(tick.scheduledTime)));
      });
      return;
    }
    if (isParkingQueue(batch.queue)) {
      await consumeParked(this.env, batch, {
        // cos-automation-events' consumer: 5 retries, 10 s apart (wrangler.jsonc).
        [AUTOMATION_EVENTS_QUEUE]: {
          consume: (clientEnv, share) =>
            inClientScope(clientEnv, () =>
              consumeAutomationEvents(clientEnv, share as MessageBatch<AutomationQueueMessage>),
            ),
          maxRetries: 5,
          retryDelaySeconds: 10,
        },
      });
      return;
    }
    if (isDeadLetterQueue(batch.queue)) {
      consumeDeadLetters(batch);
      return;
    }
    await consumeByClient<Env, AutomationQueueMessage>(this.env, batch, (clientEnv, share) =>
      inClientScope(clientEnv, () => consumeAutomationEvents(clientEnv, share)),
    );
  }

  /**
   * `* * * * *`: schedules and the daily date-relative scan (ADR 0130), the automation events
   * outbox retry (ADR 0171), integration events (webhooks, sync) as triggers (ADR 0173) and
   * notification delivery (ADR 0172) and the duplicate scan (ADR 0247). Each
   * step is independent: one failing is logged and does not stop the others. On a many-client
   * host the tick fans out, one message per client served, and each runs as it is consumed.
   */
  override async scheduled(controller: ScheduledController): Promise<void> {
    if (servesManyClients(this.env)) {
      await fanOutCron(this.env, controller);
      return;
    }
    await minuteTick(this.env, new Date(controller.scheduledTime));
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("cos-runner is reached over RPC", { status: 404 });
  }
}

/**
 * One minute cron tick: each step's result, or null when it failed (logged).
 *
 * While the kill switch is engaged (by an admin, or by the self-updater for the length of an
 * update, ADR 0164) the tick only reads it: no outbox retry, no integration events, no
 * notification delivery. Their work stays queued (outbox rows, unconsumed events, notices past
 * the delivery cursor) for the first tick after release, so nothing fires mid-migration and
 * nothing is lost. Unreadable settings count as engaged.
 */
export async function minuteTick(env: Env, at: Date) {
  const settings = await minuteStep("kill switch", () =>
    loadAutomationSettings(createCrmDb(env.DB).query),
  );
  if (!settings || settings.killSwitch) {
    return {
      paused: true,
      schedules: null,
      outbox: null,
      integrationEvents: null,
      notifications: null,
      duplicates: null,
      orders: null,
      payouts: null,
      publishing: null,
      reindex: null,
      recurring: null,
      waitlist: null,
      timedMoves: null,
      acknowledgements: null,
      agreements: null,
      agreementCopies: null,
      customerSignup: null,
      deferredRuns: null,
      routineMessages: null,
    };
  }
  const schedules = await minuteStep("schedules", () => runAutomationCron(env, at));
  // Runs held back by the runs-per-minute rail start as it allows (ADR 0573): shaped, not lost.
  const deferredRuns = await minuteStep("deferred runs", () => runDeferredDue(env, at));
  const outbox = await minuteStep("outbox", () =>
    retryOutbox(
      createCrmDb(env.DB),
      async (messages) => {
        await dispatchAutomationMessages(env, messages, { now: at });
        // As the queue consumer does: retried record events also re-embed (ADR 0154).
        await embedFromEvents(env, messages);
      },
      { now: at },
    ),
  );
  const integrationEvents = await minuteStep("integration events", () =>
    pollIntegrationEvents(env, { now: at }),
  );
  // Notification delivery (ADR 0172): email / Slack per preferences, escalation, the digest.
  const notifications = await minuteStep("notifications", () => runNotificationCron(env, at));
  // Duplicates (ADR 0247): the name-key backfill, a full scan in progress, the nightly scan.
  const duplicates = await minuteStep("duplicates", () =>
    runDuplicateCron(createCrmDb(env.DB), at),
  );
  // Orders (stage 25, ADR 0429): expire unpaid orders, apply verified payments left over.
  const orders = await minuteStep("orders", () => runOrdersTick(env, at));
  // Payouts (stage 52 step 4, ADR 0793): once a business day, the payouts the provider sent to
  // the bank are read through the payments gatekeeper, a bounded number of calls a minute until a
  // backlog is read. A quiet minute is one read by key (or, before the first read, whether a
  // payment account is bound); a failing provider is retried later and holds nothing else up.
  const payouts = await minuteStep("payouts", () =>
    runPayoutsDue(createCrmDb(env.DB), {
      integrations: integrationRuntime(env),
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
    }),
  );
  // Content (stage 28, ADR 0441): scheduled publishes whose time has come go live.
  const publishing = await minuteStep("publishing", () =>
    runPublishDue(createCrmDb(env.DB), {
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    }),
  );
  // The published-text index (stage 38, ADR 0700): caught up with what the objects declare.
  const reindex = await minuteStep("published text", () =>
    runReindexDue(createCrmDb(env.DB), {
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
    }),
  );
  // Recurring schedules (stage 31, ADR 0500): series written since the last tick, and each once a
  // day after its local midnight, make their records up to the horizon.
  const recurring = await minuteStep("recurring", () =>
    runRecurringDue(createCrmDb(env.DB), {
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    }),
  );
  // Waitlists (stage 31a, ADR 0520): places handed to a waitlist go to its first waiters, as the
  // host, one batch each; holds nobody can take, and from the cut-off on, go back to everyone.
  // The real clock, not the tick's: a tick that runs late must not promote after the cut-off.
  const waitlist = await minuteStep("waitlist", () =>
    runWaitlistDue(createCrmDb(env.DB), {
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    }),
  );
  // Timed moves (stage 31a step 7, ADR 0550): records a declared moment has passed move as the
  // host (a booking still booked after its class, on a class whose list was taken, a no-show).
  const timedMoves = await minuteStep("timed moves", () =>
    runTimedMovesDue(createCrmDb(env.DB), {
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    }),
  );
  // The roster (stage 45, ADRs 0623 and 0624): offers past their cut-off lapse; once a day the
  // rosterers hear of shifts with nobody on them. A quiet minute is a few reads and no write.
  const staffing = await minuteStep("staffing", () =>
    runStaffingDue(createCrmDb(env.DB), { clock: () => at, floor: parseFloor(env.APPROVAL_FLOOR) }),
  );
  // Checklists (stage 45 step 4b, ADR 0650): runs made a day ahead, kept with their shift, and
  // closed as missed (the rosterers told) or cancelled after their grace. A quiet minute is a few
  // reads and no write.
  const checklists = await minuteStep("checklists", () =>
    runChecklistDue(createCrmDb(env.DB), {
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
    }),
  );
  // Read and understood (stage 38, ADR 0706): once a local day, the reminders of what is still to
  // read, the owners' weekly notice and the welcome of new accounts. A quiet minute is two reads.
  const acknowledgements = await minuteStep("acknowledgements", () =>
    runAckDue(createCrmDb(env.DB), { clock: () => at, floor: parseFloor(env.APPROVAL_FLOOR) }),
  );
  // Agreements (stage 44, ADR 0640): scheduled versions whose time has come take effect.
  const agreements = await minuteStep("agreements", () =>
    runAgreementsDue(createCrmDb(env.DB), {
      clock: () => at,
      floor: parseFloor(env.APPROVAL_FLOOR),
    }),
  );
  // Agreements' copies (stage 44 step 4, ADR 0645): those not sent when they were recorded (a
  // guest's, once its purchase settled; one whose send failed and may be tried again).
  const agreementCopies = await minuteStep("agreement copies", () =>
    sendAgreementCopies({
      db: createCrmDb(env.DB).query,
      integrations: integrationRuntime(env),
      clock: () => at,
    }),
  );
  // Customer sign-in (ADR 0459): admins hear within a minute when a plan going on sale opened
  // sign-up to anyone ("anyone starting a subscription" on). Nothing while the switch is off.
  const customerSignup = await minuteStep("customer sign-up", async () => {
    const { opened } = await watchSubscriberSignup(createCrmDb(env.DB), at);
    return { opened };
  });
  // Quiet hours (stage 30, ADR 0676): texts and pushes that waited for them to end are ready to
  // go, or expired when their moment passed. Then every text ready to go (released now, back
  // after a full pending pool, or held and not yet put to a person) is handed to the text
  // connection (ADR 0672); pushes are their gatekeeper's (a later step). A quiet minute is two
  // indexed reads.
  const routineMessages = await minuteStep("routine messages", async () => {
    const db = createCrmDb(env.DB).query;
    const released = await releaseWaitingRoutineMessages(db, at.toISOString());
    const texts = await sendReadyTexts(
      { db, integrations: integrationRuntime(env) },
      { now: at.toISOString() },
    );
    return { ready: released.ready.length, expired: released.expired, texts };
  });
  return {
    paused: false,
    schedules,
    outbox,
    integrationEvents,
    notifications,
    duplicates,
    orders,
    payouts,
    publishing,
    reindex,
    recurring,
    waitlist,
    timedMoves,
    staffing,
    checklists,
    acknowledgements,
    agreements,
    agreementCopies,
    customerSignup,

    deferredRuns,
    routineMessages,
  };
}

async function minuteStep<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(`minute cron: ${name} failed`, errorForLog(error));
    return null;
  }
}
