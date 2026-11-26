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
import { WORKFLOW_ID_SEPARATOR } from "./client-bindings.ts";
import {
  type ClientAdmission,
  clientOf,
  envNameUse,
  type HostBindings,
  hasBindingWrapper,
  hostDirectory,
  hostMode,
  type Refusal,
} from "./client-environment.ts";
import type { ParkingLedger } from "./client-parking.ts";
import { generationPart, isPropsProof, PROOF, RUNNER_CALLER } from "./client-proofs.ts";
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
 * How a message for a client the host does not serve now (paused, moving, schema behind) waits
 * (review of #512, S3; #515, S3 and S5). It is parked, not retried: sent to the Worker's own
 * parking queue (`CLIENT_PARKING`, apart from the crons' fan-out, so a paused client's backlog
 * never delays another client's ticks) with a delay, so a pause never uses up the queue's
 * `max_retries` (3 for cos-routine-delivery, 5 for cos-automation-events, at 10 s each: about 30 to
 * 50 s, which every update's pause outlasts). The first wait is a minute, each next one twice the
 * last, at most 15 minutes (so a client resumed after a 10-minute pause has its messages within 15
 * minutes of resuming). A message parked for 7 days is given up; so are a client's oldest when it
 * has more than `maxPerClient` parked (the ledger, client-parking.ts). Each one given up is
 * reported as a dead letter and counted.
 */
export const PARKING = Object.freeze({
  firstDelaySeconds: 60,
  maxDelaySeconds: 15 * 60,
  giveUpAfterMs: 7 * 24 * 60 * 60 * 1000,
  maxPerClient: 1000,
});

/** The binding of a Worker's parking queue (producer and consumer), the host's own. */
export const PARKING_BINDING = "CLIENT_PARKING";
/** The binding of a Worker's parking ledgers (`ParkingLedger`, one per client), the host's own. */
export const PARKING_LEDGER_BINDING = "CLIENT_PARKING_LEDGER";

/** The parking queues, one per Worker: a batch of one is recognised by its queue's name. */
export const PARKING_QUEUES = Object.freeze({
  app: "cos-app-parking",
  runner: "cos-runner-parking",
});

export function isParkingQueue(name: string): boolean {
  return (Object.values(PARKING_QUEUES) as string[]).includes(name);
}

/** A stamped message waiting for its client to be served again, on the parking queue. */
export interface ParkedMessage {
  cosParked: 1;
  /** Its id in the client's ledger, the same each time it is parked again. */
  id: string;
  /** The queue it came from: its consumer's code handles it when the client is served. */
  queue: string;
  /** The message as it was sent: the client's stamp and the body. */
  stamped: StampedMessage<unknown>;
  /** The client's secret generation when it was parked: a later client of the id is not it. */
  generation: string;
  parkedAt: number;
  delaySeconds: number;
  /** How many times its consumer failed it once its client was served (its queue's retries). */
  failures: number;
}

export function parkedMessageOf(body: unknown): ParkedMessage | null {
  if (!body || typeof body !== "object") return null;
  const parked = body as Partial<ParkedMessage>;
  if (parked.cosParked !== 1 || typeof parked.queue !== "string") return null;
  if (typeof parked.id !== "string" || parked.id.length === 0) return null;
  if (typeof parked.generation !== "string") return null;
  if (!stampOf(parked.stamped)) return null;
  if (typeof parked.parkedAt !== "number" || typeof parked.delaySeconds !== "number") return null;
  if (typeof parked.failures !== "number") return null;
  return parked as ParkedMessage;
}

/** What parking needs of a Worker's `env`: its queue and its ledgers. */
interface ParkingBindings {
  queue: Queue<ParkedMessage>;
  ledgers: DurableObjectNamespace<ParkingLedger>;
}

function parkingOf(env: HostBindings): ParkingBindings | null {
  const bindings = env as unknown as Record<string, unknown>;
  const queue = bindings[PARKING_BINDING] as Queue<ParkedMessage> | undefined;
  const ledgers = bindings[PARKING_LEDGER_BINDING] as
    | DurableObjectNamespace<ParkingLedger>
    | undefined;
  return queue && ledgers ? { queue, ledgers } : null;
}

function ledgerOf(parking: ParkingBindings, client: ClientId) {
  return parking.ledgers.get(parking.ledgers.idFromName(client));
}

/**
 * Parks one stamped message: recorded in its client's ledger (which may give up the client's
 * oldest, each reported), then sent to the parking queue. False when the Worker has no parking.
 */
async function park(
  env: HostBindings,
  parked: Omit<ParkedMessage, "cosParked">,
  client: ClientId,
): Promise<boolean> {
  const parking = parkingOf(env);
  if (!parking) return false;
  const ledger = ledgerOf(parking, client);
  const givenUp = await ledger.admit(parked.id, parked.parkedAt, PARKING.maxPerClient);
  for (const id of givenUp) {
    reportDeadLetter(
      parked.queue,
      { id, body: null },
      `its client had more than ${PARKING.maxPerClient} messages parked: the oldest are given up`,
      client,
    );
  }
  await parking.queue.send({ cosParked: 1, ...parked }, { delaySeconds: parked.delaySeconds });
  return true;
}

/** A dead letter, said where the operator's logs and alerts read it (stage 66, ADR 0615). */
function reportDeadLetter(
  queue: string,
  message: { id: string; body: unknown },
  why: string,
  client?: ClientId,
) {
  const stamp = stampOf(message.body) ?? stampOf(parkedMessageOf(message.body)?.stamped);
  console.error(
    JSON.stringify({
      event: "cos.queue.dead_letter",
      queue,
      client: client ?? stamp?.client ?? null,
      message: message.id,
      why,
    }),
  );
}

/** Whether `name` is one of the host's dead-letter queues (`<queue>-dlq`). */
export function isDeadLetterQueue(name: string): boolean {
  return name.endsWith("-dlq");
}

/**
 * A batch of a dead-letter queue: each message is reported (`cos.queue.dead_letter`, with its
 * client) and acked. A fleet deployment binds each Worker as the consumer of its queues'
 * dead-letter queues (step 7), so nothing is lost without the operator being told.
 */
export function consumeDeadLetters(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    reportDeadLetter(batch.queue, message, "retried until the queue gave up on it");
    message.ack();
  }
}

/** A client's admission by id, with its record even when it is refused. */
export async function admissionOf<E extends HostBindings>(
  env: E,
  client: ClientId,
): Promise<ClientAdmission<E>> {
  const directory = hostDirectory(env);
  if (!directory) throw new NoClientError("A client was named on a single-client deployment");
  return directory.environmentFor(client);
}

/** Whether an admission refuses a client for a while (it comes back), not for good. */
export function waitsForClient(admission: ClientAdmission<unknown>): boolean {
  return !admission.served && admission.refused !== "unknown" && admission.refused !== "unverified";
}

/**
 * A queue consumer's batch on a many-client host, each client's share in that client's
 * environment: `handle` runs once per client with its share of the batch (the bodies without the
 * stamp, shaped as a batch). A client whose handling throws has its own messages retried and
 * nobody else's. A message with no stamp, or for a client the registry does not have, is retried,
 * never acted on, until the queue's dead-letter queue holds it. A message for a client not served
 * now (paused, moving, schema behind) is parked (`PARKING`) and handled when the client is served
 * again, without using up a retry.
 */
export async function consumeByClient<E extends HostBindings, Body>(
  env: E,
  batch: MessageBatch<unknown>,
  handle: (clientEnv: E, share: MessageBatch<Body>, client: ClientId) => Promise<void>,
  options: { retryDelaySeconds?: number; now?: () => number } = {},
): Promise<{ handled: ClientId[]; failed: ClientId[]; refused: number; parked: number }> {
  const delaySeconds = options.retryDelaySeconds ?? 10;
  const now = options.now ?? Date.now;
  const { byClient, unstamped } = messagesByClient<Body>(batch.messages);
  for (const message of unstamped) {
    console.error(`${batch.queue}: a message with no client's stamp was refused`);
    message.retry({ delaySeconds });
  }
  const handled: ClientId[] = [];
  const failed: ClientId[] = [];
  let refused = unstamped.length;
  let parked = 0;
  await Promise.all(
    [...byClient].map(async ([client, entries]) => {
      const admission = await admissionOf(env, client);
      if (!admission.served) {
        if (waitsForClient(admission) && admission.client) {
          // In the batch's order, one at a time: parked messages come back in about this order,
          // which no consumer here depends on (queues do not keep order; ADR 0615).
          for (const { message } of entries) {
            const sent = await park(
              env,
              {
                id: crypto.randomUUID(),
                queue: batch.queue,
                stamped: message.body as StampedMessage<unknown>,
                generation: generationPart(admission.client.secretGeneration),
                parkedAt: now(),
                delaySeconds: PARKING.firstDelaySeconds,
                failures: 0,
              },
              client,
            );
            if (sent) {
              parked += 1;
              message.ack();
            } else {
              message.retry({ delaySeconds: PARKING.maxDelaySeconds });
            }
          }
          return;
        }
        refused += entries.length;
        console.error(`${batch.queue}: messages refused (${admission.refused})`);
        for (const { message } of entries) message.retry({ delaySeconds });
        return;
      }
      const share = clientBatch<Body>(batch, entries);
      try {
        await handle(admission.env, share, client);
        handled.push(client);
      } catch (error) {
        failed.push(client);
        console.error(`${batch.queue}: one client's messages failed, retrying`, String(error));
        share.retryAll({ delaySeconds });
      }
    }),
  );
  return { handled, failed, refused, parked };
}

/** A parked message's consumer: its queue's code, and that queue's retries (wrangler.jsonc). */
export interface ParkedConsumer<E> {
  consume: (clientEnv: E, share: MessageBatch<unknown>) => Promise<void>;
  /** The queue's `max_retries`: a parked message is failed this many times again at most. */
  maxRetries: number;
  /** The delay of each retry, as the queue's consumer gives it. */
  retryDelaySeconds: number;
}

/**
 * A batch of the parking queue, one message at a time, each acked when it is done with:
 * - handled by its queue's consumer once its client is served again (as a batch of one, acked or
 *   retried by that code as on its own queue); a failure is retried as its own queue would
 *   (`maxRetries` times, `retryDelaySeconds` apart), then given up as its dead letter would be;
 * - parked again (twice the wait, at most `PARKING.maxDelaySeconds`) while its client is not
 *   served;
 * - given up and reported as a dead letter when it has waited `PARKING.giveUpAfterMs`, when its
 *   client is gone (removed, or moved to the other environment), when its client is a later one
 *   under the same id (another generation), or when the ledger gave it up over the cap;
 * - dropped when the ledger has it handled already or held by another delivery (a duplicate).
 */
export async function consumeParked<E extends HostBindings>(
  env: E,
  batch: MessageBatch<unknown>,
  consumers: Readonly<Record<string, ParkedConsumer<E>>>,
  options: { now?: () => number } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const parking = parkingOf(env);
  for (const message of batch.messages) {
    const parked = parkedMessageOf(message.body);
    const stamp = parked ? stampOf(parked.stamped) : null;
    const consumer = parked ? consumers[parked.queue] : undefined;
    if (!parked || !stamp || !consumer || !parking) {
      reportDeadLetter(
        batch.queue,
        message,
        "not a parked message of a queue this Worker consumes",
      );
      message.ack();
      continue;
    }
    const ledger = ledgerOf(parking, stamp.client);
    const claim = await ledger.claim(parked.id, message.id);
    if (claim === "duplicate") {
      console.warn(`${batch.queue}: a parked message delivered again was dropped`);
      message.ack();
      continue;
    }
    if (claim === "given-up") {
      // Reported when the cap gave it up; nothing more to say.
      message.ack();
      continue;
    }
    const giveUp = async (why: string) => {
      reportDeadLetter(parked.queue, message, why, stamp.client);
      await ledger.settle(parked.id, true);
      message.ack();
    };
    const parkAgain = async (next: Partial<ParkedMessage>) => {
      await ledger.release(parked.id);
      const again = { ...parked, ...next };
      await parking.queue.send(again, { delaySeconds: again.delaySeconds });
      message.ack();
    };
    const admission = await admissionOf(env, stamp.client);
    if (!admission.served) {
      if (!waitsForClient(admission)) {
        await giveUp("its client is gone");
      } else if (now() - parked.parkedAt >= PARKING.giveUpAfterMs) {
        await giveUp("its client was not served for 7 days");
      } else {
        await parkAgain({
          delaySeconds: Math.min(parked.delaySeconds * 2, PARKING.maxDelaySeconds),
        });
      }
      continue;
    }
    if (generationPart(admission.client.secretGeneration) !== parked.generation) {
      await giveUp("it was parked for an earlier client of this id");
      continue;
    }
    // The consumer's code answers a batch of one; its ack or retry is recorded here, and the
    // message underneath is acked once the ledger knows what became of it.
    let answer: "ack" | "retry" | null = null;
    const share: MessageBatch<unknown> = {
      queue: parked.queue,
      metadata: batch.metadata,
      messages: [
        {
          id: message.id,
          timestamp: message.timestamp,
          attempts: parked.failures + 1,
          body: stamp.body,
          ack: () => {
            answer ??= "ack";
          },
          retry: () => {
            answer ??= "retry";
          },
        },
      ],
      ackAll: () => {
        answer ??= "ack";
      },
      retryAll: () => {
        answer ??= "retry";
      },
    };
    try {
      await consumer.consume(admission.env, share);
    } catch (error) {
      console.error(`${parked.queue}: a parked message failed`, String(error));
      answer = "retry";
    }
    if (answer === "retry") {
      if (parked.failures + 1 > consumer.maxRetries) {
        await giveUp(`failed ${parked.failures + 1} times, as many as its queue retries`);
      } else {
        await parkAgain({
          failures: parked.failures + 1,
          delaySeconds: consumer.retryDelaySeconds,
        });
      }
      continue;
    }
    await ledger.settle(parked.id);
    message.ack();
  }
}

// --- Crons: fanned out through a queue, one message per client -------------------------------

/**
 * The binding of a Worker's fan-out queue: its own producer and consumer, bound only on a
 * many-client host (the deploy engine adds it for a fleet deployment, never the committed
 * single-client configuration). The host's own: never in a client's environment. It carries the
 * crons' ticks only (parked messages have their own queue, `CLIENT_PARKING`).
 */
export const FANOUT_BINDING = "CLIENT_FANOUT";

/** The fan-out queues, one per Worker: a batch of one is recognised by its queue's name. */
export const FANOUT_QUEUES = Object.freeze({ app: "cos-app-fanout", runner: "cos-runner-fanout" });

/**
 * What the deploy engine sets for each fan-out and parking queue's consumer (step 7): one message
 * an invocation, so one client's minute tick never shares an invocation's CPU, memory or
 * subrequests with another's; a tick that fails is retried alone. `consumeFanOut` and
 * `consumeParked` hold to one at a time whatever batch they are given.
 */
export const FANOUT_CONSUMER = Object.freeze({
  max_batch_size: 1,
  max_batch_timeout: 1,
  max_retries: 3,
});

export function isFanOutQueue(name: string): boolean {
  return (Object.values(FANOUT_QUEUES) as string[]).includes(name);
}

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
 * A batch of the fan-out queue, one tick at a time (`FANOUT_CONSUMER`: a batch of one; a larger
 * one is still handled one by one), each acked or retried on its own: a tick runs in its client's
 * environment; a client no longer served is skipped (the next tick comes); one that fails is
 * retried alone. Anything else on the queue is reported and acked.
 */
export async function consumeFanOut<E extends HostBindings>(
  env: E,
  batch: MessageBatch<unknown>,
  tick: (clientEnv: E, message: FanOutMessage) => Promise<void>,
): Promise<void> {
  for (const message of batch.messages) {
    const fanOut = fanOutMessageOf(message.body);
    if (!fanOut) {
      reportDeadLetter(batch.queue, message, "not a tick");
      message.ack();
      continue;
    }
    let clientEnv: E;
    try {
      clientEnv = await clientEnvironment(env, fanOut.client);
    } catch {
      message.ack();
      continue;
    }
    try {
      await tick(clientEnv, fanOut);
      message.ack();
    } catch (error) {
      console.error("cron fan-out: one client's tick failed, retrying", String(error));
      message.retry({ delaySeconds: 30 });
    }
  }
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

// --- Entrypoints a host mints with props -----------------------------------------------------

/** What an entrypoint minted for one client carries in its props on a many-client host. */
export interface MintedProps {
  client?: string | null;
  /** The host's proof of the client, its generation and `parts` (client-proofs.ts). */
  proof?: string | null;
}

/**
 * The environment an entrypoint minted by the host (`ctx.exports.X({ props })`, or a binding's
 * props set at deploy) runs with: the client in its props, only when their proof is the host's
 * (under the props key, or the one before a rotation) for `purpose`, the client, its current
 * generation and `parts`. Props cannot be changed by whoever holds the entrypoint (a gatekeeper,
 * a client's web app), and without the host's key no code can mint props that name another
 * client, even through `exports` (review of #512, S1). Props minted for a client id before it was
 * removed are no proof for a later client of the id (#515, S3). Many-client: refused without a
 * client or a valid proof.
 */
export async function propsClientEnvironment<E extends HostBindings>(
  env: E,
  props: MintedProps | undefined,
  purpose: string,
  ...parts: string[]
): Promise<E> {
  if (!servesManyClients(env)) return env;
  const client = props?.client ?? null;
  if (!isClientId(client)) throw new NoClientError("No client: this entry refuses to run");
  const admission = await admissionOf(env, client);
  const generation = admission.client?.secretGeneration ?? null;
  if (!isPropsProof(env, props?.proof, purpose, client, generationPart(generation), ...parts)) {
    throw new NoClientError("These props were not minted by the host for this client");
  }
  if (admission.served) return admission.env;
  if (!waitsForClient(admission)) throw new NoClientError("Not a client of this host");
  throw new NoClientError(`This client is not served now (${admission.refused})`, "updating");
}

// --- The runner's caller -------------------------------------------------------------------

/**
 * The props the deploy engine fixes on cos-app's binding to cos-runner on a many-client host
 * (step 7: `{ "binding": "RUNNER", "service": "cos-runner", "props": { "caller": "cos-app",
 * "proof": <runnerCallerProof> } }`). A binding's props are set by whoever uploads the Worker that
 * holds it, never by its code, and the proof needs the host's props key, so `callAs` refuses any
 * other caller: a Worker of the account that binds cos-runner on its own (a namespace Worker a
 * client's upload made, step 8), or code in the runner minting `exports.default` with copied
 * props.
 */
export function isRunnerCaller(props: unknown, env: object): boolean {
  if (!props || typeof props !== "object") return false;
  const { caller, proof } = props as { caller?: unknown; proof?: unknown };
  return caller === RUNNER_CALLER.caller && isPropsProof(env, proof, PROOF.runnerCaller);
}

export { clientAppProps, RUNNER_CALLER, runnerCallerProps } from "./client-proofs.ts";

// --- Gatekeepers ---------------------------------------------------------------------------

/**
 * Whether the gatekeeper bound as `binding` (`GATEKEEPER_<NAME>`) is offered in `env`. On a
 * many-client host a gatekeeper whose credentials or hook state belong to the whole deployment
 * is kept apart in `ENV_NAMES` with no wrapper (the one list, which the environment builder reads
 * too): it is in no client's environment, and here the reason says so. Single-client: whether it
 * is bound, as before.
 */
export function gatekeeperOffered(
  env: object,
  binding: string,
): { offered: true } | { offered: false; why: string } {
  const bound = Boolean((env as Record<string, unknown>)[binding]);
  if (clientOf(env) !== null) {
    const use = envNameUse(binding);
    if (use?.use === "kept-apart" && !hasBindingWrapper(binding)) {
      return {
        offered: false,
        why: `${binding} is not available on this host yet: it holds one account for every client (stage 66, ADR 0615)`,
      };
    }
  }
  return bound ? { offered: true } : { offered: false, why: `${binding} is not deployed here` };
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
  return `${name} is each client's own on a many-client host, and this client has none (its registry rows give none: a secret or an address, ADR 0616)`;
}

/** `perClientMissing` as a refusal: throws its reason, or does nothing. */
export function requirePerClient(env: object, name: string): void {
  const missing = perClientMissing(env, name);
  if (missing) throw new Error(missing);
}
