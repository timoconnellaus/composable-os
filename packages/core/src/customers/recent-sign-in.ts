// A recent sign-in (stage 48, ADR 0712): the acts that could hand an account to someone else
// (changing its sign-in address, deleting it) need a sign-in made within the last 15 minutes, so
// a session left open on a shared computer, or a stolen one, cannot do them.
//
// "Signed in at" is the session's own row, never anything the client sends: a browser session's
// `core_customer_session.created_at` (Better Auth writes it once, at the code sign-in) or a
// native app's `core_device_session.created_at` (a refresh rotates the tokens, never the row's
// start; a session exchanged from a browser sign-in starts at that sign-in, `issueDeviceSession`).
// The session is the one the adapter says the call came with (`origin.sessionId`), and only while
// it is the caller's own account's.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { OperationError, SignInAgainError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";

/** How recent a sign-in a sensitive act needs. */
export const RECENT_SIGN_IN_MINUTES = 15;

/** A stored moment as milliseconds: an ISO string, or a number of milliseconds. NaN otherwise. */
function millis(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    return /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  }
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

/**
 * When the session `sessionId` of account `customerId` was signed in, or null when there is no
 * such session of that account (another account's session answers as none).
 */
export async function sessionSignedInAt(
  db: Kysely<CoreDatabase>,
  customerId: string,
  sessionId: string,
): Promise<number | null> {
  const row = sessionId.startsWith("dvs_")
    ? await db
        .selectFrom("core_device_session")
        .select("created_at")
        .where("id", "=", sessionId)
        .where("customer_id", "=", customerId)
        .where("audience", "=", "customer")
        .executeTakeFirst()
    : await db
        .selectFrom("core_customer_session")
        .select("created_at")
        .where("id", "=", sessionId)
        .where("customer_id", "=", customerId)
        .executeTakeFirst();
  if (!row) return null;
  const at = millis(row.created_at);
  return Number.isNaN(at) ? null : at;
}

/**
 * Refuses (`sign_in_again`) unless the customer's call came with a session of their own account
 * signed in within RECENT_SIGN_IN_MINUTES of `ctx.now`. A call with no session (one the adapter
 * did not name) is refused too. For `hostInternal` customer operations, which keep `ctx.db`.
 */
export async function requireRecentSignIn(ctx: HandlerContext): Promise<void> {
  const principal = ctx.principal;
  if (principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} checks a customer's sign-in`);
  }
  const sessionId = ctx.origin.sessionId;
  const signedInAt = sessionId
    ? await sessionSignedInAt(ctx.db, principal.customerId, sessionId)
    : null;
  const now = Date.parse(ctx.now);
  // A sign-in dated after now (a clock that moved back) is not trusted as recent either.
  if (
    signedInAt === null ||
    signedInAt > now + 60_000 ||
    now - signedInAt > RECENT_SIGN_IN_MINUTES * 60_000
  ) {
    throw new SignInAgainError(RECENT_SIGN_IN_MINUTES);
  }
}
