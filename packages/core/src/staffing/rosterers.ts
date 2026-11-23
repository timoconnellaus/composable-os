// Who may roster, and the roster's notices (stage 45, ADRs 0622 to 0624).
//
// **Who may roster** is decided here and nowhere else: until stage 45 step 4 adds the Rostering
// pack's `rostering:manage` permission (held by admins and by grant), it is the admins. Step 4
// changes these two functions; every rule that asks "may this caller roster?" or "who are the
// rosterers?" reads them.
//
// **The notices** are the host's own (in-app, delivered by email as each person's preferences
// say), written in the batch of the write that causes them, so a take or a reassignment made by
// any path tells the same people. Nothing here writes to a member.
import type { Kysely } from "kysely";
import type { CoreDatabase } from "@composable-os/db";
import { notifyStatements } from "../notifications/send.ts";
import type { NotificationLink } from "../notifications/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { ActingUser } from "../principals.ts";
import { jsonList } from "../records/common.ts";

/** Whether `user` may roster other people (step 4: `rostering:manage`). */
export function mayRoster(user: Pick<ActingUser, "role">): boolean {
  return user.role === "admin";
}

/** Every active rosterer's account (step 4: everyone holding `rostering:manage`). */
export async function rosterers(db: Kysely<CoreDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom("core_user")
    .select("id")
    .where("role", "=", "admin")
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .orderBy("id")
    .execute();
  return rows.map((r) => r.id);
}

/** A staff account's name as notices and answers show it. */
export async function staffName(db: Kysely<CoreDatabase>, account: string): Promise<string> {
  const row = await db
    .selectFrom("core_user")
    .select(["name", "email"])
    .where("id", "=", account)
    .executeTakeFirst();
  return row?.name || row?.email || "Someone";
}

/** One notice the host sends. */
export interface StaffNotice {
  to: readonly string[];
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
  /** The person only: no AI acting for them lists it (it says something about availability). */
  humanOnly?: boolean;
  dedupeKey?: string;
}

/**
 * Queues one notice to each of `to` (people only; duplicates dropped) in the caller's batch. The
 * caller itself is never told what it just did.
 */
export async function queueNotice(ctx: HandlerContext, notice: StaffNotice): Promise<void> {
  const to = [...new Set(notice.to)].filter((id) => id && id !== ctx.user.id);
  if (!to.length) return;
  const people = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "in", jsonList(to))
    .where("kind", "=", "human")
    .execute();
  if (!people.length) return;
  const plan = await notifyStatements(
    ctx.db,
    {
      to: people.map((p) => ({ userId: p.id })),
      type: "system.message",
      title: notice.title.slice(0, 200),
      body: notice.body ?? null,
      link: notice.link ?? null,
      ...(notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : {}),
      ...(notice.humanOnly ? { humanOnly: true } : {}),
      source: { actor: ctx.actor, userId: ctx.user.id },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/** A notice's link to a shift. */
export const shiftLink = (object: string, id: string): NotificationLink => ({
  kind: "record",
  object,
  id,
});
