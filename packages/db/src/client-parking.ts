// The ledger of each client's parked messages (stage 66 step 4; hardening, #515, S3 and S5; review
// of #520, S3 and M5; ADR 0615): one Durable Object per client of a host Worker
// (`CLIENT_PARKING_LEDGER`, the host's own binding: never in a client's environment). Queues
// cannot count or remove what they hold, so the ledger does, for the messages of clients the host
// does not serve for a while:
// - a cap per client (`PARKING.maxPerClient`): when a client has more parked, its oldest are given
//   up (each logged as a dead letter and counted), so one long pause cannot fill the queue;
// - each parked message handled once: a second delivery of one already handled, or one held by
//   another delivery, is dropped and logged. That covers the copies parking itself could make (a
//   redelivery of the parking queue's message); a message its first queue delivered twice is two
//   parked messages, each handled once;
// - how many were given up, ever (`givenUpTotal`), for the operator.
// Rows older than `PARKING_HORIZON_MS` are forgotten on the next admit, so a row whose delivery
// never came (its invocation died and the queue gave up on it) stops counting towards the cap.
//
// A ledger is named as a client's objects are (`<client>:<proof>:parking-ledger`, the proof under
// the host's object key, of the client and its generation) and checks its own name when it is
// built, so code that reaches the raw namespace (`ctx.exports`) cannot open another client's
// ledger: it has no key to name it with (review of #520, S3).
import { DurableObject } from "cloudflare:workers";
import { isObjectName, objectNameParts } from "./client-bindings.ts";
import { PARKING_LEDGER_NAME } from "./client-entries.ts";
import { hostDirectory } from "./client-environment.ts";
import { hostBindingKey } from "./client-proofs.ts";

/** What a delivery of a parked message may do, by what the ledger holds of it. */
export type ParkedClaim =
  /** It may be handled now: claimed by this delivery. */
  | "parked"
  /** The cap gave it up (reported then): not handled. */
  | "given-up"
  /** Handled already, or held by another delivery: not handled again. */
  | "duplicate"
  /** No row (its admit failed after it was sent): claimed by this delivery now, to be handled. */
  | "unrecorded";

/** What the ledger answers about one client's parked messages. */
export interface ParkingStats {
  parked: number;
  givenUpTotal: number;
}

/** How long a row is kept: longer than a parked message can wait before it is given up. */
export const PARKING_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

export class ParkingLedger extends DurableObject {
  #ready = false;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env as never);
    const parts = objectNameParts(ctx.id.name);
    // A throw here resets the object and fails the call that woke it: the refusal.
    ctx
      .blockConcurrencyWhile(async () => {
        const directory = hostDirectory(env as never);
        if (!directory) throw new Error("A parking ledger is only on a host of many clients");
        if (!parts || parts.name !== PARKING_LEDGER_NAME) {
          throw new Error("A parking ledger is named <client>:<proof>:parking-ledger: refused");
        }
        // Its client as the registry has it, served or not (a paused client's ledger is used).
        const record = await directory.client(parts.client);
        if (!record || !isObjectName(parts, record.secretGeneration, hostBindingKey(env))) {
          throw new Error("This parking ledger's name is not the host's for its client: refused");
        }
      })
      .catch(() => {});
  }

  #sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(`CREATE TABLE IF NOT EXISTS parked (
        id TEXT PRIMARY KEY NOT NULL,
        parked_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('parked', 'given-up', 'done')),
        claimed_by TEXT
      )`);
      sql.exec("CREATE INDEX IF NOT EXISTS parked_by_age ON parked (state, parked_at, id)");
      sql.exec(`CREATE TABLE IF NOT EXISTS totals (
        key TEXT PRIMARY KEY NOT NULL,
        value INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return sql;
  }

  #count(sql: SqlStorage): number {
    return sql.exec<{ n: number }>("SELECT count(*) AS n FROM parked WHERE state = 'parked'").one()
      .n;
  }

  #addGivenUp(sql: SqlStorage, n: number): void {
    if (n === 0) return;
    sql.exec(
      "INSERT INTO totals (key, value) VALUES ('given_up', ?) ON CONFLICT (key) DO UPDATE SET value = value + excluded.value",
      n,
    );
  }

  /**
   * Records a message parked (sent to the parking queue) at `parkedAt`; a second admit of the
   * same id changes nothing. Forgets rows older than the horizon at `now`, then gives up the
   * oldest beyond `cap`: their ids come back, to be reported. Each given up is counted.
   */
  async admit(
    id: string,
    parkedAt: number,
    cap: number,
    now: number = Date.now(),
  ): Promise<string[]> {
    const sql = this.#sql();
    sql.exec("DELETE FROM parked WHERE parked_at < ?", now - PARKING_HORIZON_MS);
    sql.exec(
      "INSERT OR IGNORE INTO parked (id, parked_at, state) VALUES (?, ?, 'parked')",
      id,
      parkedAt,
    );
    const over = this.#count(sql) - cap;
    if (over <= 0) return [];
    const oldest = sql
      .exec<{ id: string }>(
        "SELECT id FROM parked WHERE state = 'parked' ORDER BY parked_at, id LIMIT ?",
        over,
      )
      .toArray()
      .map((row) => row.id);
    for (const old of oldest) {
      sql.exec("UPDATE parked SET state = 'given-up', claimed_by = NULL WHERE id = ?", old);
    }
    this.#addGivenUp(sql, oldest.length);
    return oldest;
  }

  /**
   * A delivery of parked message `id` (the queue's message id `delivery`, the same on a retry of
   * that delivery), parked at `parkedAt` (see `ParkedClaim`).
   */
  async claim(id: string, delivery: string, parkedAt: number): Promise<ParkedClaim> {
    const sql = this.#sql();
    const row = sql
      .exec<{ state: string; claimed_by: string | null }>(
        "SELECT state, claimed_by FROM parked WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) {
      sql.exec(
        "INSERT INTO parked (id, parked_at, state, claimed_by) VALUES (?, ?, 'parked', ?)",
        id,
        parkedAt,
        delivery,
      );
      return "unrecorded";
    }
    if (row.state === "done") return "duplicate";
    if (row.state === "given-up") {
      sql.exec("UPDATE parked SET state = 'done' WHERE id = ?", id);
      return "given-up";
    }
    if (row.claimed_by !== null && row.claimed_by !== delivery) return "duplicate";
    sql.exec("UPDATE parked SET claimed_by = ? WHERE id = ?", delivery, id);
    return "parked";
  }

  /** Parked again (its client still not served, or its handling to be retried): unclaimed. */
  async release(id: string): Promise<void> {
    this.#sql().exec("UPDATE parked SET claimed_by = NULL WHERE id = ?", id);
  }

  /**
   * Done with: handled, or given up and reported (`givenUp` counts it). Kept as done until the
   * horizon, so a later delivery of it is a duplicate.
   */
  async settle(id: string, givenUp = false): Promise<void> {
    const sql = this.#sql();
    sql.exec("UPDATE parked SET state = 'done', claimed_by = NULL WHERE id = ?", id);
    if (givenUp) this.#addGivenUp(sql, 1);
  }

  async stats(): Promise<ParkingStats> {
    const sql = this.#sql();
    const total = sql
      .exec<{ value: number }>("SELECT value FROM totals WHERE key = 'given_up'")
      .toArray()[0];
    return { parked: this.#count(sql), givenUpTotal: total?.value ?? 0 };
  }
}
