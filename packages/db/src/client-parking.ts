// The ledger of each client's parked messages (stage 66 step 4; hardening, #515, S3 and S5; ADR
// 0615): one Durable Object per client of a host Worker (`CLIENT_PARKING_LEDGER`, named by the
// client id, the host's own binding: never in a client's environment). Queues cannot count or
// remove what they hold, so the ledger does, for the messages of clients the host does not serve
// for a while:
// - a cap per client (`PARKING.maxPerClient`): when a client has more parked, its oldest are given
//   up (each logged as a dead letter and counted), so one long pause cannot fill the queue;
// - each parked message once: a second delivery of one already handled, or one claimed by another
//   delivery, is dropped (queues deliver at least once);
// - how many were given up, ever (`givenUpTotal`), for the operator.
import { DurableObject } from "cloudflare:workers";

/** What a delivery of a parked message may do, by what the ledger holds of it. */
export type ParkedClaim = "parked" | "given-up" | "duplicate";

/** What the ledger answers about one client's parked messages. */
export interface ParkingStats {
  parked: number;
  givenUpTotal: number;
}

export class ParkingLedger extends DurableObject {
  #ready = false;

  #sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(`CREATE TABLE IF NOT EXISTS parked (
        id TEXT PRIMARY KEY NOT NULL,
        parked_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('parked', 'given-up')),
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
   * Records a message parked now (a second admit of the same id changes nothing), and gives up
   * the oldest beyond `cap`: their ids come back, to be reported. Each given up is counted.
   */
  async admit(id: string, parkedAt: number, cap: number): Promise<string[]> {
    const sql = this.#sql();
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
   * A delivery of parked message `id` (the queue's message id `delivery`): `parked` when it may be
   * handled now (it is then claimed by this delivery; a retry of the same delivery may claim it
   * again), `given-up` when the cap gave it up (it is forgotten), `duplicate` when it was
   * handled already or another delivery holds it.
   */
  async claim(id: string, delivery: string): Promise<ParkedClaim> {
    const sql = this.#sql();
    const row = sql
      .exec<{ state: string; claimed_by: string | null }>(
        "SELECT state, claimed_by FROM parked WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return "duplicate";
    if (row.state === "given-up") {
      sql.exec("DELETE FROM parked WHERE id = ?", id);
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

  /** Done with: handled, or given up and reported (`givenUp` counts it). */
  async settle(id: string, givenUp = false): Promise<void> {
    const sql = this.#sql();
    sql.exec("DELETE FROM parked WHERE id = ?", id);
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
