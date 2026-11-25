// Idempotency keys on the HTTP surface (stage 23, ADR 0403, ADR 0416). A phone that retries a
// purchase on a bad connection buys once.
//
// - Every write carries an `Idempotency-Key`; a write without one is refused. A read ignores it.
// - A key belongs to its caller: its scope is the principal. The public share one scope, so a key
//   must be long enough to be unguessable (16 characters or more), and the same key with another
//   input is refused rather than answered.
// - The key, the operation, a hash of the input and the response are inserted in the write's own
//   batch (`InBatch`, pipeline.ts): the key and the write commit together or not at all, and a
//   second batch for a key that committed fails on the primary key and applies nothing.
// - The same key and input returns the stored response without running the handler. A second
//   call while the first is still running waits for it (a claim row says it is running), so the
//   handler runs once even for two calls sent at once.
// - A call that fails before it commits stores nothing: a retry runs again.
// - Rows are purged by the daily maintenance cron after 24 hours.
import type { CrmDb } from "@composable-os/db";
import { type Compilable, sql } from "kysely";
import { sha256Hex } from "../digest.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import { canonicalJson } from "../judge/calibration.ts";
import type { BatchOutcome, InBatch } from "../pipeline.ts";
import type { HttpReply } from "./envelope.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
/** How long a key is kept. */
export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
/** A claim older than this was left by a call that died: another call may take it over. */
export const CLAIM_STALE_MS = 60_000;
/** How long a second call waits for the first's response before it says to retry. */
const WAIT_MS = 10_000;
const POLL_MS = 50;

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

/** The key sent with a write, or a refusal saying what is wrong. */
export function parseIdempotencyKey(value: string | null): string {
  if (value === null || value === "") {
    throw new ValidationError("A write needs an Idempotency-Key header", {
      reason: "idempotency_key_required",
    });
  }
  if (!KEY.test(value)) {
    throw new ValidationError(
      "An Idempotency-Key is 16 to 128 letters, digits and . _ : - (a UUID will do)",
      { reason: "idempotency_key_invalid" },
    );
  }
  return value;
}

export async function inputHash(operation: string, input: unknown): Promise<string> {
  return sha256Hex(`${operation}\n${canonicalJson(input)}`);
}

export interface IdempotentCall {
  db: CrmDb;
  /** `staff:<user id>`, `customer:<account id>` or `public`. */
  scope: string;
  key: string;
  operation: string;
  hash: string;
  now: () => Date;
  /**
   * Whether a reply holds what the host never keeps (stage 45 step 5, ADR 0628): an operation's
   * `redactResult` keys, such as a calendar feed's address shown once or a one-time upload
   * address. Such a reply is sent to this call only; its row keeps no response, so a replay is
   * told the call was applied but its response not kept (`idempotency_response_lost`).
   */
  secret?: (reply: HttpReply) => boolean;
  /** The reply a committed outcome would send, built the way the surface builds it. */
  replyFor: (outcome: BatchOutcome) => HttpReply | null;
  /** How long a second call waits for the first. Default 10 seconds. */
  waitMs?: number;
}

/** What `runIdempotent` hands back: the reply, and whether it was a stored one. */
export interface IdempotentReply extends HttpReply {
  replayed: boolean;
}

const reused = () =>
  new ValidationError("This Idempotency-Key was already used with a different input", {
    reason: "idempotency_key_reused",
    httpStatus: 422,
  });

const lost = () =>
  new ConflictError(
    "A call with this Idempotency-Key was applied, but its response was not kept: read the " +
      "records it changed to see the result",
    { reason: "idempotency_response_lost" },
  );

const inFlight = () =>
  new ConflictError("A call with this Idempotency-Key is still running; retry shortly", {
    reason: "idempotency_key_in_flight",
    retryAfterSeconds: 1,
  });

async function committedRow(call: IdempotentCall) {
  return call.db.query
    .selectFrom("core_idempotency_key")
    .select(["operation", "input_hash", "claim", "status", "response"])
    .where("scope", "=", call.scope)
    .where("idempotency_key", "=", call.key)
    .executeTakeFirst();
}

type Committed = NonNullable<Awaited<ReturnType<typeof committedRow>>>;

function sameCall(call: IdempotentCall, row: { operation: string; input_hash: string }): boolean {
  return row.operation === call.operation && row.input_hash === call.hash;
}

/** The stored reply of a committed key, or null while its response is still being filled in. */
function stored(call: IdempotentCall, row: Committed): IdempotentReply | null {
  if (!sameCall(call, row)) throw reused();
  if (row.status === null || row.response === null) return null;
  return { status: row.status, body: row.response, replayed: true };
}

/**
 * Takes the key for this call in one statement, unless it already committed: an insert guarded
 * by the key's absence, which takes over a stale claim and leaves a live one alone.
 */
async function claim(call: IdempotentCall, claimId: string): Promise<boolean> {
  const now = call.now();
  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const { rows } = await sql<{ claim: string }>`
    INSERT INTO core_idempotency_claim
      (scope, idempotency_key, operation, input_hash, claim, claimed_at)
    SELECT ${call.scope}, ${call.key}, ${call.operation}, ${call.hash}, ${claimId}, ${now.toISOString()}
    WHERE NOT EXISTS (
      SELECT 1 FROM core_idempotency_key WHERE scope = ${call.scope} AND idempotency_key = ${call.key}
    )
    ON CONFLICT (scope, idempotency_key) DO UPDATE SET
      operation = excluded.operation, input_hash = excluded.input_hash,
      claim = excluded.claim, claimed_at = excluded.claimed_at
    WHERE core_idempotency_claim.claimed_at < ${stale}
    RETURNING claim`.execute(call.db.query);
  return rows[0]?.claim === claimId;
}

async function holderOf(call: IdempotentCall) {
  return call.db.query
    .selectFrom("core_idempotency_claim")
    .select(["operation", "input_hash", "claim"])
    .where("scope", "=", call.scope)
    .where("idempotency_key", "=", call.key)
    .executeTakeFirst();
}

function releaseStatement(call: IdempotentCall, claimId: string): Compilable {
  return call.db.query
    .deleteFrom("core_idempotency_claim")
    .where("scope", "=", call.scope)
    .where("idempotency_key", "=", call.key)
    .where("claim", "=", claimId);
}

async function release(call: IdempotentCall, claimId: string): Promise<void> {
  try {
    await call.db.batch([releaseStatement(call, claimId)]);
  } catch (error) {
    // A claim left behind is taken over once it is stale.
    console.error("idempotency claim not released", error instanceof Error ? error.message : error);
  }
}

/** Fills in the response of a key this call committed, when it was not known in the batch. */
async function fillIn(call: IdempotentCall, claimId: string, reply: HttpReply): Promise<void> {
  // A secret is never stored: the row stays without a response (a replay: response lost).
  if (call.secret?.(reply)) return;
  await call.db.batch([
    call.db.query
      .updateTable("core_idempotency_key")
      .set({ status: reply.status, response: reply.body })
      .where("scope", "=", call.scope)
      .where("idempotency_key", "=", call.key)
      .where("claim", "=", claimId)
      .where("response", "is", null),
  ]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one write under its key. `run` receives the statements to commit in the write's batch
 * and returns the reply the caller is sent; it is not called when the key already committed.
 *
 * What it costs a write that commits with its reply (ADR 0416): one more round trip (the claim)
 * and three more statements (the claim, and the key row and the claim's release in the write's
 * own batch). A reply computed after the commit adds the fill-in and the release.
 */
export async function runIdempotent(
  call: IdempotentCall,
  run: (inBatch: InBatch) => Promise<HttpReply>,
): Promise<IdempotentReply> {
  const claimId = crypto.randomUUID();
  const deadline = call.now().getTime() + (call.waitMs ?? WAIT_MS);
  for (;;) {
    if (await claim(call, claimId)) return runClaimed(call, claimId, run);
    const committed = await committedRow(call);
    if (committed) {
      const reply = stored(call, committed);
      if (reply) return reply;
      // Its response is being filled in, unless the call that committed it has gone.
      const holder = await holderOf(call);
      if (holder?.claim !== committed.claim) throw lost();
    } else {
      const holder = await holderOf(call);
      if (holder && !sameCall(call, holder)) throw reused();
    }
    // Another call has this key: wait for its response.
    if (call.now().getTime() >= deadline) throw inFlight();
    await sleep(POLL_MS);
  }
}

async function runClaimed(
  call: IdempotentCall,
  claimId: string,
  run: (inBatch: InBatch) => Promise<HttpReply>,
): Promise<IdempotentReply> {
  let committed: HttpReply | null | undefined;
  const inBatch: InBatch = (outcome) => {
    committed = call.replyFor(outcome);
    // A reply known now is complete: the claim goes with the commit. One computed after the
    // commit keeps the claim until it is filled in, so a waiting call keeps waiting.
    return [
      keyInsert(call, claimId, committed),
      ...(committed !== null ? [releaseStatement(call, claimId)] : []),
    ];
  };
  let reply: HttpReply;
  try {
    reply = await run(inBatch);
  } catch (error) {
    await release(call, claimId);
    throw error;
  }
  const succeeded = reply.status < 300;
  if (succeeded && committed !== undefined) {
    // The write committed, and its key with it.
    if (committed === null) {
      await fillIn(call, claimId, reply);
      await release(call, claimId);
    }
    return { ...reply, replayed: false };
  }
  if (succeeded) {
    // A write that reported success without committing its key: never expected. Say so loudly
    // and keep the reply, so a retry does not apply it again.
    console.error("idempotency key not committed with its write", call.operation);
    await call.db.batch([keyInsert(call, claimId, reply)]).catch(() => {});
    await release(call, claimId);
    return { ...reply, replayed: false };
  }
  // A failure. Did anything commit under this key?
  const row = committed === undefined ? undefined : await committedRow(call);
  await release(call, claimId);
  if (row && row.claim === claimId) {
    // This call committed, then failed (computing its reply): what it sent is what a retry gets.
    if (row.response === null) await fillIn(call, claimId, reply);
    return { ...reply, replayed: false };
  }
  if (row) {
    // Another call committed this key first (it took over a claim it thought was stale): this
    // call's batch failed on the key and applied nothing. Its reply is the answer.
    const theirs = stored(call, row);
    if (theirs) return theirs;
    throw inFlight();
  }
  return { ...reply, replayed: false };
}

function keyInsert(call: IdempotentCall, claimId: string, given: HttpReply | null): Compilable {
  // A secret is never stored: the key is kept, its response is not (a replay: response lost).
  const reply = given && call.secret?.(given) ? null : given;
  return call.db.query.insertInto("core_idempotency_key").values({
    scope: call.scope,
    idempotency_key: call.key,
    operation: call.operation,
    input_hash: call.hash,
    claim: claimId,
    status: reply?.status ?? null,
    response: reply?.body ?? null,
    created_at: call.now().toISOString(),
  });
}

/** The daily purge: keys and claims older than 24 hours, in chunks. */
export async function purgeIdempotencyKeys(
  db: CrmDb,
  now: Date,
  { chunk = 500, maxChunks = 20 }: { chunk?: number; maxChunks?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS).toISOString();
  let deleted = 0;
  // Written out per table: these are not record tables, and no name is built at run time.
  const statements = [
    () => sql`
      DELETE FROM core_idempotency_key WHERE (scope, idempotency_key) IN (
        SELECT scope, idempotency_key FROM core_idempotency_key
        WHERE created_at < ${cutoff} ORDER BY created_at LIMIT ${chunk}
      )`,
    () => sql`
      DELETE FROM core_idempotency_claim WHERE (scope, idempotency_key) IN (
        SELECT scope, idempotency_key FROM core_idempotency_claim
        WHERE claimed_at < ${cutoff} ORDER BY claimed_at LIMIT ${chunk}
      )`,
  ];
  for (const statement of statements) {
    for (let i = 0; ; i += 1) {
      if (i >= maxChunks) return { deleted, more: true };
      const result = await statement().execute(db.query);
      const n = Number(result.numAffectedRows ?? 0);
      deleted += n;
      if (n < chunk) break;
    }
  }
  return { deleted, more: false };
}
