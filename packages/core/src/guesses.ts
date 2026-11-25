// Wrong promo codes (ADR 0940). An operation that checks a code someone could guess is given
// `ctx.guesses` on a call from outside the org (staff are never counted):
//
// - Per caller: a signed-in customer's account; a guest by the order the call names (20 wrong
//   codes), or, naming none, by their client address (50). Wrong codes are counted in fixed
//   quarter-hour windows; the 21st (or 51st) locks that caller out of codes for 15 minutes from
//   then, right or wrong, so the refusals never tell which code was right. A client app's shared
//   bucket (its Worker named no visitor) is never locked: one attacker would lock every buyer out.
// - Host-wide: past HOST_WRONG_CODES_PER_HOUR wrong codes in an hour (many addresses at once),
//   code checks for everyone pass a short host-wide rate (`codeSurge`, 30 every 10 seconds) until
//   the hour ends, rather than any valid code being refused for long; the admins are told.
//
// A check reserves its guess before the code is looked up, in one statement (`wrong = wrong + 1
// ... RETURNING`), so parallel guesses cannot overshoot; a right code gives the reservation back.
// So every check is one write, and a wrong one a second (the host-wide count). This is D1, so it
// holds when the rate limiting binding is down.
//
// A row's key is a SHA-256 of who (an account id, or an address's key: already a keyed hash, so
// no address reaches here), the order and the group. The daily maintenance run deletes rows whose
// window and lock have passed.
import type { CrmDb } from "@composable-os/db";
import { sql } from "kysely";
import { sha256Hex } from "./digest.ts";
import { RateLimitedError } from "./errors.ts";
import { notifyStatements } from "./notifications/send.ts";
import {
  type ClientAddress,
  countHit,
  type LimitedCaller,
  type LimiterDown,
  UNKNOWN_ADDRESS,
} from "./public-limits.ts";
import type { RateLimitBinding } from "./rate-limit.ts";

/** Wrong codes an account, or a guest's order, may give in a quarter-hour. */
export const WRONG_CODES_PER_CALLER = 20;
/** Wrong codes a guest naming no order may give from one address in a quarter-hour. */
export const WRONG_CODES_PER_ADDRESS = 50;
/** How long a caller is refused codes once over. */
export const CODE_LOCK_MS = 15 * 60 * 1000;
/** Wrong codes host-wide in an hour before code checks are slowed for everyone. */
export const HOST_WRONG_CODES_PER_HOUR = 2000;

const WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** What a code-checking handler is given. */
export interface Guesses {
  /** Before the code is looked up: refuses a locked caller, reserves this guess. */
  check(): Promise<void>;
  /** The code was right: the reservation is given back. */
  right(): Promise<void>;
  /** The code was wrong: the reservation stands, and the host-wide count goes up. */
  wrong(): Promise<void>;
}

/** Who a guess is counted against: an account, a guest's order, a guest's address, or nobody. */
export interface GuessCaller {
  caller: LimitedCaller;
  address: ClientAddress | undefined;
  /** The order a guest's call names, if any. */
  order: string | null;
}

const windowStart = (at: number, size: number) =>
  new Date(Math.floor(at / size) * size).toISOString();

async function identityOf(
  who: GuessCaller,
  group: string,
): Promise<{ key: string; limit: number } | null> {
  const { caller } = who;
  if (caller.kind === "customer") {
    return {
      key: await sha256Hex(`acct\n${caller.customerId}\n${group}`),
      limit: WRONG_CODES_PER_CALLER,
    };
  }
  if (caller.kind === "practitioner") {
    return {
      key: await sha256Hex(`prac\n${caller.practitionerId}\n${group}`),
      limit: WRONG_CODES_PER_CALLER,
    };
  }
  const address = who.address ?? UNKNOWN_ADDRESS;
  // A shared bucket is everyone's: never locked (the host-wide ceiling still holds).
  if (address.shared) return null;
  if (who.order) {
    return {
      key: await sha256Hex(`order\n${address.key}\n${who.order}\n${group}`),
      limit: WRONG_CODES_PER_CALLER,
    };
  }
  return { key: await sha256Hex(`addr\n${address.key}\n${group}`), limit: WRONG_CODES_PER_ADDRESS };
}

function refuse(retryAfterSeconds: number): never {
  throw new RateLimitedError(`Too many calls; retry in ${retryAfterSeconds}s`, {
    retryAfterSeconds,
    rule: "rate_limited",
  });
}

/** The counter for one call. `surge`: the host-wide binding used past the ceiling. */
export function guessCounter(
  db: CrmDb,
  who: GuessCaller,
  group: string,
  now: string,
  options: { surge?: RateLimitBinding | undefined; onDown?: LimiterDown } = {},
): Guesses {
  const at = Date.parse(now);
  const quarter = windowStart(at, WINDOW_MS);
  const hour = windowStart(at, HOUR_MS);
  const hostKey = `host\n${group}\n${hour}`;
  let identity: Promise<{ key: string; limit: number } | null> | null = null;
  let reserved = false;
  const id = () => {
    identity ??= identityOf(who, group);
    return identity;
  };
  return {
    async check() {
      // Many addresses at once: past the ceiling, everyone's checks pass a short host-wide rate.
      const host = await db.query
        .selectFrom("core_wrong_guess")
        .select("wrong")
        .where("guess_key", "=", hostKey)
        .executeTakeFirst();
      if ((host?.wrong ?? 0) >= HOST_WRONG_CODES_PER_HOUR) {
        try {
          await countHit(options.surge, `code-surge:${group}`, "code surge", options.onDown);
        } catch {
          refuse(10);
        }
      }
      const mine = await id();
      if (!mine || reserved) return;
      const row = await sql<{ wrong: number; locked_until: string | null }>`
        INSERT INTO core_wrong_guess (guess_key, window_start, wrong, locked_until)
        VALUES (${mine.key}, ${quarter}, 1, NULL)
        ON CONFLICT (guess_key) DO UPDATE SET
          wrong = CASE WHEN window_start = excluded.window_start THEN wrong + 1 ELSE 1 END,
          window_start = excluded.window_start
        RETURNING wrong, locked_until`.execute(db.query);
      reserved = true;
      const { wrong = 1, locked_until = null } = row.rows[0] ?? {};
      if (locked_until && Date.parse(locked_until) > at) {
        refuse(Math.max(1, Math.ceil((Date.parse(locked_until) - at) / 1000)));
      }
      if (wrong > mine.limit) {
        const until = new Date(at + CODE_LOCK_MS).toISOString();
        await sql`UPDATE core_wrong_guess SET locked_until = ${until} WHERE guess_key = ${mine.key}`.execute(
          db.query,
        );
        refuse(CODE_LOCK_MS / 1000);
      }
    },
    async right() {
      const mine = await id();
      if (!mine || !reserved) return;
      await sql`
        UPDATE core_wrong_guess SET wrong = wrong - 1
        WHERE guess_key = ${mine.key} AND wrong > 0 AND window_start = ${quarter}`.execute(
        db.query,
      );
    },
    async wrong() {
      const row = await sql<{ wrong: number }>`
        INSERT INTO core_wrong_guess (guess_key, window_start, wrong) VALUES (${hostKey}, ${hour}, 1)
        ON CONFLICT (guess_key) DO UPDATE SET wrong = wrong + 1
        RETURNING wrong`.execute(db.query);
      if (row.rows[0]?.wrong === HOST_WRONG_CODES_PER_HOUR) {
        await tellAdmins(
          db,
          "Many wrong promo codes",
          `${HOST_WRONG_CODES_PER_HOUR} wrong promo codes were tried within an hour, from many ` +
            "addresses: someone may be guessing codes. Until the hour ends, code checks are slowed " +
            "for everyone (right codes still work). Consider ending a short shared code word.",
          `public_limit.code_ceiling:${hour}`,
          now,
        );
      }
    },
  };
}

/** Tells the admins once per key, outside the call's batch; never fails the call. */
export async function tellAdmins(
  db: CrmDb,
  title: string,
  body: string,
  dedupeKey: string,
  now: string,
): Promise<void> {
  try {
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title,
        body,
        dedupeKey,
        source: { actor: "system" },
      },
      now,
    );
    for (const statement of plan.statements) await db.query.executeQuery(statement.compile());
  } catch (error) {
    console.error("rate limit notice not written", String((error as Error)?.message ?? error));
  }
}

/** The daily purge: rows whose window and lock have passed, in chunks, until none is left. */
export async function purgeWrongGuesses(
  db: CrmDb,
  now: Date,
  { chunk = 500 }: { chunk?: number } = {},
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - HOUR_MS).toISOString();
  const at = now.toISOString();
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM core_wrong_guess WHERE guess_key IN (
        SELECT guess_key FROM core_wrong_guess
        WHERE window_start < ${cutoff} AND (locked_until IS NULL OR locked_until < ${at})
        ORDER BY window_start LIMIT ${chunk}
      )`.execute(db.query);
    const n = Number(result.numAffectedRows ?? 0);
    deleted += n;
    if (n < chunk) return { deleted };
  }
}
