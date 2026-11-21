// Erase requests (stage 22, ADR 0402). A customer who deletes their account (me.deleteAccount) is
// disabled and signed out at once, and an erase request names their Person for staff to action by
// a due date (a product setting, default 30 days): erase the person with person.erase, which
// deletes the request with everything else about them, or decline with a reason
// (eraseRequest.decline), which is emailed to the person. Admins are told when a request is made,
// and once a day about each request past its due date until it is closed.
//
// Requests are account bookkeeping, not records: nothing here reads a Person.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a request made at `requestedAt` is due, `days` later. */
export function eraseRequestDueAt(requestedAt: string, days: number): string {
  return new Date(Date.parse(requestedAt) + days * DAY_MS).toISOString();
}

export interface OpenEraseRequest {
  id: string;
  personId: string;
  customerId: string | null;
  requestedAt: string;
  dueAt: string;
}

/** The open request for a Person, if there is one (at most one: a unique index holds it). */
export async function openEraseRequest(
  db: Kysely<CoreDatabase>,
  personId: string,
): Promise<OpenEraseRequest | null> {
  const row = await db
    .selectFrom("core_erase_request")
    .select(["id", "person_id", "customer_id", "requested_at", "due_at"])
    .where("person_id", "=", personId)
    .where("status", "=", "open")
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        personId: row.person_id,
        customerId: row.customer_id,
        requestedAt: row.requested_at,
        dueAt: row.due_at,
      }
    : null;
}

/**
 * The statements that create an erase request for `personId` and tell every admin, for the
 * caller's batch. A second open request for the same Person is ignored by the unique index, so
 * two calls racing still leave one.
 */
export async function createEraseRequestStatements(
  db: Kysely<CoreDatabase>,
  input: { personId: string; customerId: string; requestedAt: string; dueAt: string },
): Promise<{ request: OpenEraseRequest; statements: Compilable[] }> {
  const request: OpenEraseRequest = { id: newId("eraseRequest"), ...input };
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: "A customer asked to be erased",
      body:
        "A customer deleted their account and asked for their personal data to be erased. " +
        `Erase them, or decline with a reason, by ${input.dueAt.slice(0, 10)} ` +
        "(Settings → Storage → Erase requests).",
      link: { kind: "record", object: "person", id: input.personId },
      dedupeKey: `erase_request:${request.id}`,
      source: { actor: "system" },
    },
    input.requestedAt,
  );
  return {
    request,
    statements: [
      db.insertInto("core_erase_request").orIgnore().values({
        id: request.id,
        person_id: request.personId,
        customer_id: request.customerId,
        requested_at: request.requestedAt,
        due_at: request.dueAt,
        status: "open",
      }),
      ...plan.statements,
    ],
  };
}

/** How long after one overdue notice the next one may go: a day, less a little for cron drift. */
const RENOTIFY_MS = DAY_MS - 10 * 60 * 1000;
const OVERDUE_BATCH = 50;

/**
 * Tells every admin about each open erase request past its due date, at most once a day per
 * request (`last_notified_at`), until staff close it. Run by the daily maintenance cron. Each
 * request's notices and its `last_notified_at` commit together. Returns how many were notified.
 */
export async function notifyOverdueEraseRequests(
  db: CrmDb,
  now: Date = new Date(),
): Promise<{ notified: number }> {
  const at = now.toISOString();
  const notBefore = new Date(now.getTime() - RENOTIFY_MS).toISOString();
  const due = await db.query
    .selectFrom("core_erase_request")
    .select(["id", "person_id", "due_at"])
    .where("status", "=", "open")
    .where("due_at", "<=", at)
    .where((eb) =>
      eb.or([eb("last_notified_at", "is", null), eb("last_notified_at", "<=", notBefore)]),
    )
    .orderBy("due_at")
    .limit(OVERDUE_BATCH)
    .execute();
  let notified = 0;
  for (const request of due) {
    const days = Math.max(1, Math.floor((now.getTime() - Date.parse(request.due_at)) / DAY_MS));
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "An erase request is overdue",
        body:
          `A customer's erase request was due on ${request.due_at.slice(0, 10)} ` +
          `(${days} day${days === 1 ? "" : "s"} ago). Erase the person, or decline with a ` +
          "reason (Settings → Storage → Erase requests).",
        link: { kind: "record", object: "person", id: request.person_id },
        dedupeKey: `erase_request.overdue:${request.id}:${at.slice(0, 10)}`,
        source: { actor: "system" },
      },
      at,
    );
    await db.batch([
      db.query
        .updateTable("core_erase_request")
        .set({ last_notified_at: at })
        .where("id", "=", request.id)
        .where("status", "=", "open"),
      ...plan.statements,
    ]);
    notified += 1;
  }
  return { notified };
}
