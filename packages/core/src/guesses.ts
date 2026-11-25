// Wrong guesses per client address (ADR 0940): an operation that checks a code someone could guess
// (a promo code) refuses every check, right or wrong, once this address gave 20 wrong codes in the
// current hour, in the operation's group (`publicLimit.guesses`). The pipeline hands such an
// operation's handler `ctx.guesses` on a call from outside the org; staff are not counted.
//
// Why D1 and not the rate limiting binding: the binding counts on every look, and a limit that
// counts only wrong codes has to be read before the code is checked, so that the right code is
// refused too once the limit is reached (else the refusals would tell the guesser which one was
// right). The cost is one indexed read per code check, and one upsert per wrong code.
//
// A row's key is a SHA-256 of the address's key (already a keyed hash: no address reaches here),
// the group and the hour; the daily maintenance run deletes it once its hour has ended.
import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { sha256Hex } from "./digest.ts";
import { RateLimitedError } from "./errors.ts";
import { type ClientAddress, UNKNOWN_ADDRESS } from "./public-limits.ts";

/** Wrong codes one client address may give in an hour, per group. */
export const WRONG_GUESSES_PER_HOUR = 20;
/** For a client app's shared bucket (its Worker passed no visitor address). */
export const SHARED_WRONG_GUESSES_PER_HOUR = 200;

const HOUR_MS = 60 * 60 * 1000;

/** What a code-checking handler is given: check before looking at the code, count a wrong one. */
export interface Guesses {
  /** Refuses (`rate_limited`) once this address's wrong codes this hour reach the limit. */
  check(): Promise<void>;
  /** Counts one wrong code, at once and outside the call's batch, so a refusal keeps it. */
  wrong(): Promise<void>;
}

function windowOf(now: string): { start: string; endsAt: number } {
  const at = Date.parse(now);
  const start = Math.floor(at / HOUR_MS) * HOUR_MS;
  return { start: new Date(start).toISOString(), endsAt: start + HOUR_MS };
}

async function guessKey(address: ClientAddress, group: string, windowStart: string) {
  return sha256Hex(`${address.shared ? "app" : "addr"}\n${address.key}\n${group}\n${windowStart}`);
}

/** The counter for one call: this address (or shared bucket), this group, this hour. */
export function guessCounter(
  db: CrmDb,
  address: ClientAddress | undefined,
  group: string,
  now: string,
): Guesses {
  const who = address ?? UNKNOWN_ADDRESS;
  const window = windowOf(now);
  const limit = who.shared ? SHARED_WRONG_GUESSES_PER_HOUR : WRONG_GUESSES_PER_HOUR;
  const key = guessKey(who, group, window.start);
  return {
    async check() {
      const row = await db.query
        .selectFrom("core_wrong_guess")
        .select("wrong")
        .where("guess_key", "=", await key)
        .executeTakeFirst();
      if ((row?.wrong ?? 0) >= limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((window.endsAt - Date.parse(now)) / 1000));
        // The same refusal as the per-address limit's, whatever the code was.
        throw new RateLimitedError(`Too many calls; retry in ${retryAfterSeconds}s`, {
          retryAfterSeconds,
          rule: "client_address",
        });
      }
    },
    async wrong() {
      await sql`
        INSERT INTO core_wrong_guess (guess_key, window_start, wrong)
        VALUES (${await key}, ${window.start}, 1)
        ON CONFLICT (guess_key) DO UPDATE SET wrong = wrong + 1`.execute(db.query);
    },
  };
}

/** The daily purge: rows whose hour has ended, in chunks. */
export async function purgeWrongGuesses(
  db: CrmDb,
  now: Date,
  { chunk = 500, maxChunks = 20 }: { chunk?: number; maxChunks?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const cutoff = new Date(now.getTime() - HOUR_MS).toISOString();
  let deleted = 0;
  for (let i = 0; ; i += 1) {
    if (i >= maxChunks) return { deleted, more: true };
    const result = await sql`
      DELETE FROM core_wrong_guess WHERE guess_key IN (
        SELECT guess_key FROM core_wrong_guess
        WHERE window_start < ${cutoff} ORDER BY window_start LIMIT ${chunk}
      )`.execute(db.query);
    const n = Number(result.numAffectedRows ?? 0);
    deleted += n;
    if (n < chunk) return { deleted, more: false };
  }
}
