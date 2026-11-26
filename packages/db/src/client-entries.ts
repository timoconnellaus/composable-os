// Deciding the client at an entry of a many-client host (stage 66 step 4, ADR 0615): what the
// app's and the runner's entries call before anything else runs. Each entry decides the client
// from what only the host controls (the hostname a request reached, the stamp a wrapper put on a
// message or a Workflow's params, the name a wrapper gave a Durable Object, the props the host
// minted an entrypoint with, the client the app names to the runner), then runs as today on that
// client's environment. An entry that cannot decide refuses: nothing runs with "no client" on a
// many-client host.
//
// On a single-client deployment every function here answers with the real `env` after one
// constant check (`REGISTRY` unbound), and reads nothing.
//
// Exported as `@composable-os/db/client-entries`, never from `@composable-os/db`.
import type { StampedMessage, StampedParams } from "./client-bindings.ts";
import {
  OBJECT_NAME_SEPARATOR,
  objectNameParts,
  WORKFLOW_ID_SEPARATOR,
} from "./client-bindings.ts";
import {
  clientOf,
  type HostBindings,
  hostDirectory,
  hostMode,
  type Refusal,
} from "./client-environment.ts";
import { type ClientId, type ClientRecord, isClientId, isSchemaBehind } from "./registry.ts";

/** Whether `env` is a many-client host's: one constant check, no read. */
export function servesManyClients(env: object): boolean {
  return hostMode(env) === "many";
}

// --- Refusals ------------------------------------------------------------------------------

/** Why a known client is not served right now, or null when it is. */
export type ClientRefusal = "paused" | "moving" | "updating";

/**
 * Whether the host serves `client` now: an active client whose database is at the code's schema.
 * A paused or moving client, and one whose schema is behind (stage 66, "The host refuses
 * requests for a client whose schema is behind"), get the "being updated" answer.
 */
export function clientRefusal(
  client: Pick<ClientRecord, "status" | "schemaVersion">,
): ClientRefusal | null {
  if (client.status === "paused") return "paused";
  if (client.status === "moving") return "moving";
  if (isSchemaBehind(client)) return "updating";
  return null;
}

/**
 * The answer to a hostname the registry does not have: a plain 404 with nothing of the host or any
 * client in it, the same for every unknown name, before any other code runs.
 */
export function unknownHostResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const UPDATING_TEXT = "This service is being updated. Please try again in a few minutes.";

/**
 * The answer to a request for a client the host does not serve right now (paused, moving, or its
 * schema behind the code): 503 with Retry-After, the same words whatever the reason, so nothing
 * of the client's state is told. A browser gets a small page, anything else plain text.
 */
export function beingUpdatedResponse(request?: Request): Response {
  const headers = {
    "cache-control": "no-store",
    "retry-after": "120",
  };
  if (request?.headers.get("accept")?.includes("text/html")) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Being updated</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Being updated</h1><p>${UPDATING_TEXT}</p></body></html>`,
      { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
    );
  }
  return new Response(UPDATING_TEXT, {
    status: 503,
    headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
  });
}

// --- A request, by its hostname --------------------------------------------------------------

/** What a request's entry runs with, or the response that ends it before any other code. */
export type RequestDecision<E> =
  | { env: E; client: ClientRecord | null; surface: string | null }
  | { response: Response };

/**
 * How an entry answers a refusal of the directory (ADR 0613's `Refusal`): a client paused, moving
 * or whose schema is behind the code gets "being updated" (stage 66 step 4, ADR 0615: the brief's
 * "a client that is paused, moving or whose schema is behind gets the 'being updated' answer");
 * an unknown or unverified hostname, or a client of another environment, the plain 404.
 */
export function refusalAnswer(refused: Refusal, request?: Request): Response {
  return refused === "unknown" || refused === "unverified"
    ? unknownHostResponse()
    : beingUpdatedResponse(request);
}

/**
 * The client a request reached, from its URL's hostname (the Host header the edge routed on),
 * and the environment to run it with. Single-client: the real `env`, nothing read. Many-client:
 * only a served client's environment (the directory refuses by default); a hostname of a surface
 * this Worker does not serve is the same 404 as an unknown one.
 */
export async function decideRequest<E extends HostBindings>(
  env: E,
  request: Request,
  surfaces: readonly string[],
): Promise<RequestDecision<E>> {
  const directory = hostDirectory(env);
  if (!directory) return { env, client: null, surface: null };
  const admission = await directory.clientForHostname(new URL(request.url).hostname);
  if (!admission.served) return { response: refusalAnswer(admission.refused, request) };
  if (!surfaces.includes(admission.surface)) return { response: unknownHostResponse() };
  return { env: admission.env, client: admission.client, surface: admission.surface };
}

// --- An entry that is told the client --------------------------------------------------------

/** Why an entry that was told a client cannot run as it. */
export class NoClientError extends Error {
  override name = "NoClientError";
  /** `unknown`: no client, or none the registry has; `updating`: a client not served now. */
  readonly reason: "unknown" | "updating";
  constructor(message: string, reason: "unknown" | "updating" = "unknown") {
    super(message);
    this.reason = reason;
  }
}

/** The answer an entry gives when it cannot run as the client it was told (a NoClientError). */
export function refusalResponse(error: unknown, request?: Request): Response {
  if (error instanceof NoClientError && error.reason === "updating") {
    return beingUpdatedResponse(request);
  }
  return unknownHostResponse();
}

/**
 * The environment for a client an entry was told (the runner by the app, a message's stamp, a
 * Workflow's params, an object's name, an entrypoint's props). Single-client: the real `env`, and
 * `client` must be null. Many-client: only a served client's (the directory's admission); any
 * refusal throws, unknown and unverified as "unknown", the others as "updating".
 */
export async function clientEnvironment<E extends HostBindings>(
  env: E,
  client: string | null | undefined,
): Promise<E> {
  const directory = hostDirectory(env);
  if (!directory) {
    if (client !== null && client !== undefined) {
      throw new NoClientError("A client was named on a single-client deployment");
    }
    return env;
  }
  if (!isClientId(client)) throw new NoClientError("No client: this entry refuses to run");
  const admission = await directory.environmentFor(client);
  if (admission.served) return admission.env;
  if (admission.refused === "unknown" || admission.refused === "unverified") {
    throw new NoClientError("Not a client of this host");
  }
  throw new NoClientError(`This client is not served now (${admission.refused})`, "updating");
}

// --- Queue messages ------------------------------------------------------------------------

/** A stamped message's client and body, or null when the message carries no valid stamp. */
export function stampOf<Body>(body: unknown): { client: ClientId; body: Body } | null {
  if (!body || typeof body !== "object") return null;
  const stamped = body as Partial<StampedMessage<Body>>;
  if (!isClientId(stamped.cosClient) || !("body" in stamped)) return null;
  return { client: stamped.cosClient, body: stamped.body as Body };
}

/** A batch's messages by the client stamped on them; `unstamped` is every message with none. */
export function messagesByClient<Body>(messages: readonly Message<unknown>[]): {
  byClient: Map<ClientId, { message: Message<unknown>; body: Body }[]>;
  unstamped: Message<unknown>[];
} {
  const byClient = new Map<ClientId, { message: Message<unknown>; body: Body }[]>();
  const unstamped: Message<unknown>[] = [];
  for (const message of messages) {
    const stamp = stampOf<Body>(message.body);
    if (!stamp) {
      unstamped.push(message);
      continue;
    }
    const list = byClient.get(stamp.client) ?? [];
    list.push({ message, body: stamp.body });
    byClient.set(stamp.client, list);
  }
  return { byClient, unstamped };
}

/**
 * One client's share of a batch, shaped as the batch itself: its messages carry the bodies
 * without the stamp, and acking or retrying one acks or retries the message underneath (the
 * first answer counts). The consumers' code below runs on it unchanged.
 */
function clientBatch<Body>(
  batch: MessageBatch<unknown>,
  entries: { message: Message<unknown>; body: Body }[],
): MessageBatch<Body> & { answered: () => boolean[] } {
  const done = entries.map(() => false);
  const messages: Message<Body>[] = entries.map(({ message, body }, i) => ({
    id: message.id,
    timestamp: message.timestamp,
    attempts: message.attempts,
    body,
    ack: () => {
      if (done[i]) return;
      done[i] = true;
      message.ack();
    },
    retry: (options?: QueueRetryOptions) => {
      if (done[i]) return;
      done[i] = true;
      message.retry(options);
    },
  }));
  return {
    queue: batch.queue,
    metadata: batch.metadata,
    messages,
    ackAll: () => {
      for (const message of messages) message.ack();
    },
    retryAll: (options?: QueueRetryOptions) => {
      for (const message of messages) message.retry(options);
    },
    answered: () => [...done],
  };
}

/**
 * A queue consumer's batch on a many-client host, one client at a time, each in its own
 * environment: `handle` runs once per client with that client's share of the batch (the bodies
 * without the stamp, shaped as a batch). A client whose handling throws has its own messages
 * retried and nobody else's; a message with no stamp, or for a client the host does not know or
 * does not serve now (being updated), is retried, never acted on, until the queue's dead-letter
 * queue holds it or the client is served again.
 */
export async function consumeByClient<E extends HostBindings, Body>(
  env: E,
  batch: MessageBatch<unknown>,
  handle: (clientEnv: E, share: MessageBatch<Body>, client: ClientId) => Promise<void>,
  options: { retryDelaySeconds?: number } = {},
): Promise<{ handled: ClientId[]; failed: ClientId[]; refused: number }> {
  const delaySeconds = options.retryDelaySeconds ?? 10;
  const { byClient, unstamped } = messagesByClient<Body>(batch.messages);
  for (const message of unstamped) {
    console.error(`${batch.queue}: a message with no client's stamp was refused`);
    message.retry({ delaySeconds });
  }
  const handled: ClientId[] = [];
  const failed: ClientId[] = [];
  let refused = unstamped.length;
  await Promise.all(
    [...byClient].map(async ([client, entries]) => {
      let clientEnv: E;
      try {
        clientEnv = await clientEnvironment(env, client);
      } catch (error) {
        refused += entries.length;
        console.error(`${batch.queue}: messages refused`, String(error));
        for (const { message } of entries) message.retry({ delaySeconds });
        return;
      }
      const share = clientBatch<Body>(batch, entries);
      try {
        await handle(clientEnv, share, client);
        handled.push(client);
      } catch (error) {
        failed.push(client);
        console.error(`${batch.queue}: one client's messages failed, retrying`, String(error));
        share.retryAll({ delaySeconds });
      }
    }),
  );
  return { handled, failed, refused };
}

// --- Crons: fanned out through a queue, one message per client -------------------------------

/**
 * The binding of a Worker's fan-out queue: its own producer and consumer, bound only on a
 * many-client host (the deploy engine adds it for a fleet deployment, never the committed
 * single-client configuration). The host's own: never in a client's environment.
 */
export const FANOUT_BINDING = "CLIENT_FANOUT";

/** One client's share of one cron tick. */
export interface FanOutMessage {
  cosFanOut: 1;
  client: ClientId;
  cron: string;
  scheduledTime: number;
}

/** Queues take at most 100 messages a `sendBatch` (and 256 KB): a fan-out sends them in parts. */
export const FANOUT_BATCH_MAX = 100;

export function fanOutMessageOf(body: unknown): FanOutMessage | null {
  if (!body || typeof body !== "object") return null;
  const message = body as Partial<FanOutMessage>;
  if (message.cosFanOut !== 1 || !isClientId(message.client)) return null;
  if (typeof message.cron !== "string" || typeof message.scheduledTime !== "number") return null;
  return message as FanOutMessage;
}

/**
 * A cron tick on a many-client host: one message per client served now (active, at the code's
 * schema), sent to the Worker's fan-out queue in batches of 100, so the tick itself makes at most
 * one call per hundred clients and does no client's work. Each client's work runs when its
 * message is consumed, in its own environment, so a slow or failing client holds up nobody else.
 */
export async function fanOutCron(
  env: HostBindings,
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
): Promise<number> {
  const directory = hostDirectory(env);
  if (!directory) throw new NoClientError("A single-client deployment runs its crons itself");
  const queue = (env as unknown as Record<string, Queue<FanOutMessage> | undefined>)[
    FANOUT_BINDING
  ];
  if (!queue) {
    throw new NoClientError(
      `${FANOUT_BINDING} is not bound: a many-client host fans its crons out through it`,
    );
  }
  const snapshot = await directory.snapshot();
  const clients: ClientId[] = [];
  for (const id of await directory.activeClients()) {
    const record = snapshot.clients.get(id);
    if (record && !clientRefusal(record)) clients.push(id);
  }
  for (let i = 0; i < clients.length; i += FANOUT_BATCH_MAX) {
    await queue.sendBatch(
      clients.slice(i, i + FANOUT_BATCH_MAX).map((client) => ({
        body: {
          cosFanOut: 1,
          client,
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
        } satisfies FanOutMessage,
      })),
    );
  }
  return clients.length;
}

/**
 * A batch of the fan-out queue: each message is one client's tick, run in that client's
 * environment and acked on its own; one that fails is retried alone. A client no longer served
 * (paused, or being updated since the tick) is skipped: the next tick comes.
 */
export async function consumeFanOut<E extends HostBindings>(
  env: E,
  messages: readonly Message<unknown>[],
  tick: (clientEnv: E, message: FanOutMessage) => Promise<void>,
): Promise<void> {
  await Promise.all(
    messages.map(async (message) => {
      const fanOut = fanOutMessageOf(message.body);
      if (!fanOut) {
        console.error("cron fan-out: a message that is not a client's tick was dropped");
        message.ack();
        return;
      }
      let clientEnv: E;
      try {
        clientEnv = await clientEnvironment(env, fanOut.client);
      } catch {
        message.ack();
        return;
      }
      try {
        await tick(clientEnv, fanOut);
        message.ack();
      } catch (error) {
        console.error("cron fan-out: one client's tick failed, retrying", String(error));
        message.retry({ delaySeconds: 30 });
      }
    }),
  );
}

// --- Workflows -----------------------------------------------------------------------------

/**
 * The client a Workflow instance runs as, and its params: its id must be `<client>_<id>` and its
 * params the wrapper's `{ cosClient, params }` with the same client. Null when either is missing
 * or they disagree: the instance refuses to run.
 */
export function workflowClientOf<Params>(
  instanceId: string,
  payload: unknown,
): { client: ClientId; params: Params } | null {
  const at = instanceId.indexOf(WORKFLOW_ID_SEPARATOR);
  if (at <= 0) return null;
  const client = instanceId.slice(0, at);
  if (!isClientId(client) || !payload || typeof payload !== "object") return null;
  const stamped = payload as Partial<StampedParams<Params>>;
  if (stamped.cosClient !== client || !("params" in stamped)) return null;
  return { client, params: stamped.params as Params };
}

/**
 * A Workflow's run on its environment and params. Single-client: the real `env` and the event's
 * payload as it is. Many-client: the client from its id and its stamped params, which must agree.
 */
export async function workflowRun<E extends HostBindings, Params>(
  env: E,
  event: { instanceId: string; payload: unknown },
): Promise<{ env: E; params: Params }> {
  if (!servesManyClients(env)) return { env, params: event.payload as Params };
  const found = workflowClientOf<Params>(event.instanceId, event.payload);
  if (!found) throw new NoClientError("This Workflow instance names no client: refused");
  return {
    env: await clientEnvironment(env, found.client),
    params: found.params,
  };
}

// --- Durable Objects -------------------------------------------------------------------------

/**
 * A Durable Object on a host that may serve many clients: which client it is for (its name, as a
 * namespace wrapper gave it: `<client>:<name>`), the caller's name without the client, and that
 * client's environment. Made in the object's constructor; on a many-client host it holds every
 * event (`blockConcurrencyWhile`) until the environment is built, and an object whose name
 * carries no client the registry knows refuses every event. Single-client: the real `env` and
 * the object's own name, nothing read.
 */
export class ClientObject<E extends HostBindings> {
  #env: E | null = null;
  readonly #host: E;
  readonly #adopt: ((clientEnv: E) => void) | undefined;
  readonly client: ClientId | null;
  /** The object's name as its caller gave it (without the client), or undefined. */
  readonly name: string | undefined;

  constructor(ctx: DurableObjectState, env: E, adopt?: (clientEnv: E) => void) {
    this.#host = env;
    this.#adopt = adopt;
    const stored = ctx.id.name;
    if (!servesManyClients(env)) {
      this.client = null;
      this.name = stored;
      this.#env = env;
      return;
    }
    const parts = objectNameParts(stored);
    this.client = parts?.client ?? null;
    this.name = parts?.name;
    ctx.blockConcurrencyWhile(async () => {
      if (!parts) {
        throw new NoClientError(
          `A Durable Object on a many-client host is named <client>${OBJECT_NAME_SEPARATOR}<name>: refused`,
        );
      }
      await this.refresh();
    });
  }

  /**
   * Reads the client's environment again (a long-lived object, such as the assistant's thread
   * with its sockets, calls it on each message): the registry's latest, so settings changed and a
   * client removed reach an object that outlives a version stamp. A client the registry no longer
   * serves (removed, paused, moving, behind) is refused: this throws and the message, alarm or
   * call fails. Single-client: the real `env`.
   */
  async refresh(): Promise<E> {
    if (this.client === null) {
      if (this.#env) return this.#env;
      throw new NoClientError("This object's name carries no client: refused");
    }
    const clientEnv = await clientEnvironment(this.#host, this.client);
    this.#env = clientEnv;
    this.#adopt?.(clientEnv);
    return clientEnv;
  }

  /** The environment the object runs with: the client's, or the real one on a single client. */
  get env(): E {
    if (!this.#env) throw new NoClientError("This object's client is not decided: refused");
    return this.#env;
  }
}

// --- Entrypoints a host mints with props -----------------------------------------------------

/**
 * The environment an entrypoint minted by the host (`ctx.exports.X({ props })`) runs with: the
 * client the host put in its props when it minted it. Props are set by the host's own code and
 * cannot be changed by whoever holds the entrypoint (a gatekeeper, a client's web app), so the
 * holder cannot name another client. Many-client: refused without one.
 */
export function propsClientEnvironment<E extends HostBindings>(
  env: E,
  props: { client?: string | null } | undefined,
): Promise<E> {
  if (!servesManyClients(env)) return Promise.resolve(env);
  return clientEnvironment(env, props?.client ?? null);
}

// --- Secrets and addresses: each client's own, step 6 ----------------------------------------

/**
 * Why `name` cannot be read from `env`, when `env` is a client's environment and the name is one
 * of the secrets or addresses stage 66 step 6 fills in per client (`per-client` in ENV_NAMES):
 * until then a client's environment has none, and a place that needs one fails with this rather
 * than fall back to the deployment's single value, which would mix clients. Null otherwise
 * (a single-client deployment's `env`, or a value that is there).
 */
export function perClientMissing(env: object, name: string): string | null {
  if (clientOf(env) === null) return null;
  const value = (env as Record<string, unknown>)[name];
  if (typeof value === "string" && value.length > 0) return null;
  return `${name} is each client's own on a many-client host; stage 66 step 6 (secrets and addresses per client) fills it in and is not built yet`;
}

/** `perClientMissing` as a refusal: throws its reason, or does nothing. */
export function requirePerClient(env: object, name: string): void {
  const missing = perClientMissing(env, name);
  if (missing) throw new Error(missing);
}
